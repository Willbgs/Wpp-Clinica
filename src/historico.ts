import { config } from "./config";

/**
 * A equipe ja esta nesta conversa?
 *
 * O numero da clinica ja atende clientes pelo celular. Quando a Sara entra no ar,
 * ela nao pode se meter numa conversa que alguem da equipe esta tocando -- nem
 * depois de um reinicio, quando a memoria de pausas (em RAM) volta vazia.
 *
 * Por isso, antes de responder, olha as ultimas mensagens do chat na UAZAPI
 * (POST /message/find, mais recentes primeiro): se alguem da clinica escreveu
 * pelo celular (fromMe e NAO wasSentByApi) nas ultimas HUMANO_RECENTE_HORAS, a
 * Sara fica quieta. Mensagens da propria Sara saem pela API e nao contam.
 *
 * Falhou a consulta? Responde normalmente (o comportamento de antes).
 */

const JANELA_MS = Number(process.env.HUMANO_RECENTE_HORAS ?? 72) * 3_600_000;

/** Chats ja conferidos e LIVRES. Resultado "equipe conversou" nao fica em cache: confere de novo depois. */
const livres = new Set<string>();

interface MsgHistorico {
  fromMe?: boolean;
  wasSentByApi?: boolean;
  messageTimestamp?: number;
}

/** DDI + DDD + 8 ultimos digitos: o WhatsApp as vezes guarda o numero sem o 9. */
const chave = (n: string) => `${n.slice(0, 4)}-${n.slice(-8)}`;

export async function equipeConversouRecente(chatid: string): Promise<boolean> {
  if (JANELA_MS <= 0 || livres.has(chatid)) return false;
  // O numero que recebe os avisos (equipe/teste) nunca e bloqueado por esta regra.
  const numero = chatid.split("@")[0] ?? "";
  if (config.humanoWhatsapp && chave(numero) === chave(config.humanoWhatsapp.replace(/\D/g, ""))) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(`${config.uazapiUrl}/message/find`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: config.uazapiToken },
      body: JSON.stringify({ chatid, limit: 40 }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[historico] /message/find ${res.status} (ignorado)`);
      return false;
    }
    const j = (await res.json()) as { messages?: MsgHistorico[] };
    const limite = Date.now() - JANELA_MS;
    const humano = (j.messages ?? []).some((m) => {
      const ts = Number(m.messageTimestamp ?? 0);
      const ms = ts > 1e12 ? ts : ts * 1000; // documentado em ms; aceita segundos por seguranca
      return m.fromMe === true && m.wasSentByApi !== true && ms >= limite;
    });
    if (!humano) livres.add(chatid);
    return humano;
  } catch (e) {
    console.warn("[historico] falhou (ignorado):", e instanceof Error ? e.message : e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** A equipe digitou agora: a conversa deixa de ser "livre" e volta a ser conferida. */
export function marcarComoDaEquipe(chatid: string): void {
  livres.delete(chatid);
}
