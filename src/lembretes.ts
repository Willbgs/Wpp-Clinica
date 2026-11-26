import { config } from "./config";
import { agendaAtiva, anotarNoEvento, eventosComWhatsApp, textoDoInstante, type EventoComWhatsApp } from "./agenda";
import { guardarLead, leadAnterior } from "./catalogo";
import { enviarTexto } from "./whatsapp";

/**
 * LEMBRETES DA AVALIACAO.
 *
 * A cada LEMBRETE_INTERVALO_MIN, le no Google Agenda os eventos das proximas horas
 * que tem link wa.me na descricao (os que a Sara marcou, e os que a equipe lancar
 * com o link) e manda:
 *   - vespera (~24 h antes): lembrete pedindo SIM ou REMARCAR;
 *   - ~2 h antes: aviso curto com o endereco.
 *
 * O que ja foi enviado fica ANOTADO NA DESCRICAO DO EVENTO ("[lembrete-24h ...]"):
 * reinicio ou deploy nao manda de novo. Fora de 7h-21h nao manda nada.
 * No modo teste (SO_TESTE != false) so manda para HUMANO_WHATSAPP.
 */

const LIGADO = (process.env.LEMBRETES ?? "true").trim().toLowerCase() !== "false";
const INTERVALO_MIN = Number(process.env.LEMBRETE_INTERVALO_MIN ?? 5);
const SO_TESTE = (process.env.SO_TESTE ?? "").trim().toLowerCase() !== "false";
const HORA_DE = 7;
const HORA_ATE = 21;
const H = 3_600_000;

const TAG_24 = "[lembrete-24h";
const TAG_2 = "[lembrete-2h";
const TAG_OK = "[confirmado";
const TAG_CANCELADO = "[cancelado";

/** DDI + DDD + 8 ultimos digitos: o WhatsApp as vezes guarda o numero sem o 9. */
const chave = (n: string) => `${n.slice(0, 4)}-${n.slice(-8)}`;

export interface AvaliacaoMarcada {
  eventoId: string;
  nome: string;
  procedimento: string;
  /** "sexta-feira 27/11 às 10h15" */
  texto: string;
  inicio: Date;
  telefone: string;
  lembrete: "" | "vespera" | "2h";
  confirmado: boolean;
}

/** Proximas avaliacoes por telefone -- o prompt usa para a Sara entender o "SIM". */
const proximas = new Map<string, AvaliacaoMarcada>();

export function avaliacaoDaCliente(chatid: string): AvaliacaoMarcada | undefined {
  const numero = (chatid.split("@")[0] ?? "").replace(/\D/g, "");
  const a = proximas.get(chave(numero));
  return a && a.inicio.getTime() > Date.now() - H ? a : undefined;
}

export function esquecerAvaliacao(chatid: string): void {
  proximas.delete(chave((chatid.split("@")[0] ?? "").replace(/\D/g, "")));
}

function lerEvento(ev: EventoComWhatsApp): AvaliacaoMarcada | undefined {
  const tel = ev.descricao.match(/wa\.me\/(\d{10,15})/)?.[1];
  if (!tel) return undefined;
  // "Avaliação - Ana (Toxina botulínica (botox))"
  const t = ev.titulo.match(/Avaliação - ([^(]+?)\s*\((.*)\)\s*$/);
  return {
    eventoId: ev.id,
    nome: (t?.[1] ?? "").trim(),
    procedimento: (t?.[2] ?? "").trim(),
    texto: textoDoInstante(new Date(ev.inicio)),
    inicio: new Date(ev.inicio),
    telefone: tel,
    lembrete: ev.descricao.includes(TAG_2) ? "2h" : ev.descricao.includes(TAG_24) ? "vespera" : "",
    confirmado: ev.descricao.includes(TAG_OK),
  };
}

function horaLocal(d: Date): number {
  return Number(
    new Intl.DateTimeFormat("pt-BR", { timeZone: config.timezone, hour: "2-digit", hourCycle: "h23" }).format(d)
  );
}

function ehAmanha(d: Date): boolean {
  const f = (x: Date) => new Intl.DateTimeFormat("pt-BR", { timeZone: config.timezone, dateStyle: "short" }).format(x);
  return f(d) === f(new Date(Date.now() + 24 * H));
}

function ehHoje(d: Date): boolean {
  const f = (x: Date) => new Intl.DateTimeFormat("pt-BR", { timeZone: config.timezone, dateStyle: "short" }).format(x);
  return f(d) === f(new Date());
}

function hora(texto: string): string {
  return texto.split(" às ")[1] ?? "";
}

const prof = () => {
  const p = (process.env.PROFISSIONAL_NOME ?? "").trim();
  return p ? p.split(/\s+/).slice(0, 2).join(" ") : "a profissional";
};

function mensagemVespera(a: AvaliacaoMarcada): string {
  const quando = ehAmanha(a.inicio) ? `amanhã, ${a.texto}` : a.texto;
  return [
    `Oi${a.nome ? `, ${a.nome.split(" ")[0]}` : ""}! Aqui é a ${config.atendenteNome}, da ${config.empresaNome} 😊`,
    `Passando pra lembrar da sua avaliação com a ${prof()} ${quando}${config.empresaEndereco ? `, na ${config.empresaEndereco}` : ""}.`,
    "",
    "Você confirma? Responda *SIM* para confirmar ou *REMARCAR* se precisar mudar o horário.",
  ].join("\n");
}

function mensagem2h(a: AvaliacaoMarcada): string {
  const quando = ehHoje(a.inicio) ? `hoje às ${hora(a.texto)}` : a.texto;
  return [
    `Oi${a.nome ? `, ${a.nome.split(" ")[0]}` : ""}! Sua avaliação com a ${prof()} é ${quando} 😊`,
    config.empresaEndereco ? `Endereço: ${config.empresaEndereco}.` : "",
    "Se tiver algum imprevisto, é só me avisar por aqui.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Nao manda duas vezes no mesmo processo se a anotacao no evento falhar. */
const enviadosAgora = new Set<string>();

function podeEnviarPara(telefone: string): boolean {
  if (!SO_TESTE) return true;
  const teste = (config.humanoWhatsapp ?? "").replace(/\D/g, "");
  return !!teste && chave(teste) === chave(telefone);
}

async function enviarLembrete(ev: EventoComWhatsApp, a: AvaliacaoMarcada, tipo: "vespera" | "2h"): Promise<void> {
  const marca = `${ev.id}:${tipo}`;
  if (enviadosAgora.has(marca)) return;
  if (!podeEnviarPara(a.telefone)) {
    console.log(`[lembrete] modo teste: nao enviado para final ${a.telefone.slice(-4)} (${tipo})`);
    enviadosAgora.add(marca);
    return;
  }
  const texto = tipo === "vespera" ? mensagemVespera(a) : mensagem2h(a);
  await enviarTexto(`${a.telefone}@s.whatsapp.net`, texto);
  enviadosAgora.add(marca);
  const quando = new Intl.DateTimeFormat("pt-BR", {
    timeZone: config.timezone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
  await anotarNoEvento(ev.id, `${tipo === "vespera" ? TAG_24 : TAG_2} enviado ${quando}]`).catch((e) =>
    console.warn("[lembrete] nao consegui anotar no evento:", e instanceof Error ? e.message : e)
  );
  a.lembrete = tipo;
  console.log(`[lembrete] ${tipo} enviado para final ${a.telefone.slice(-4)} (${a.texto})`);
}

export async function verificarLembretes(): Promise<void> {
  if (!agendaAtiva()) return;
  const agora = Date.now();
  const eventos = await eventosComWhatsApp(new Date(agora - H), new Date(agora + 30 * H));
  const horaAgora = horaLocal(new Date(agora));
  const podeAgora = horaAgora >= HORA_DE && horaAgora < HORA_ATE;

  proximas.clear();
  for (const ev of eventos) {
    const a = lerEvento(ev);
    if (!a || ev.descricao.includes(TAG_CANCELADO)) continue;
    // Duas avaliacoes do mesmo numero: vale a mais proxima que ainda nao passou.
    const atual = proximas.get(chave(a.telefone));
    const valeEsta =
      !atual ||
      (a.inicio.getTime() > agora - H && (atual.inicio.getTime() <= agora - H || a.inicio < atual.inicio));
    if (valeEsta) proximas.set(chave(a.telefone), a);

    // Sem memoria depois de um reinicio: deixa o registro pronto para remarcar/cancelar.
    const chatid = `${a.telefone}@s.whatsapp.net`;
    if (!leadAnterior(chatid)) {
      guardarLead(chatid, {
        nome: a.nome || "não informado",
        procedimento: a.procedimento || "não informado",
        cidade: "não informada",
        pediuHumano: false,
        avaliacao: `${a.texto} (MARCADO na agenda)`,
        duvida: "",
        idioma: ev.descricao.includes("Idioma: espanhol") ? "espanhol" : "portugues",
        assunto: "atendimento",
        eventoId: a.eventoId,
      });
    }

    if (!podeAgora) continue;
    const falta = a.inicio.getTime() - agora;
    const antecedencia = a.inicio.getTime() - new Date(ev.criado).getTime();
    try {
      // Vespera: entre 24 h e 3 h antes, e so se foi marcado com mais de 26 h de antecedencia.
      if (!ev.descricao.includes(TAG_24) && !a.confirmado && falta <= 24 * H && falta > 3 * H && antecedencia > 26 * H) {
        await enviarLembrete(ev, a, "vespera");
      }
      // 2 h antes: entre 2 h e 20 min antes, e so se foi marcado com mais de 3 h de antecedencia.
      else if (!ev.descricao.includes(TAG_2) && falta <= 2 * H && falta > 20 * 60_000 && antecedencia > 3 * H) {
        await enviarLembrete(ev, a, "2h");
      }
    } catch (e) {
      console.warn("[lembrete] envio falhou:", e instanceof Error ? e.message : e);
    }
  }
}

export function iniciarLembretes(): void {
  if (!LIGADO || !agendaAtiva()) return;
  const rodar = () =>
    void verificarLembretes().catch((e) =>
      console.warn("[lembrete] verificacao falhou:", e instanceof Error ? e.message : e)
    );
  setTimeout(rodar, 20_000).unref();
  setInterval(rodar, INTERVALO_MIN * 60_000).unref();
  console.log(`[lembrete] ligado: vespera e 2 h antes, de ${HORA_DE}h as ${HORA_ATE}h${SO_TESTE ? " (modo teste: so o numero de teste)" : ""}`);
}

export const TAGS = { TAG_OK, TAG_CANCELADO };
