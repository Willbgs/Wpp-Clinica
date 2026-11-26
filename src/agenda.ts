import { config } from "./config";

/**
 * AGENDA (Google Agenda via Apps Script).
 *
 * O Apps Script (teste/agenda-google.gs) roda dentro da conta Google da clinica e
 * expoe 3 acoes por POST: "ocupado" (eventos num intervalo), "criar" e "apagar".
 * A URL dele vai em AGENDA_URL. Sem AGENDA_URL a Sara volta ao jeito antigo:
 * propoe dia e periodo e a equipe confirma.
 *
 * Os horarios oferecidos saem daqui, nao do modelo: grade fixa (AGENDA_HORARIOS,
 * de AGENDA_DURACAO_MIN em AGENDA_DURACAO_MIN) menos o que ja esta ocupado.
 */

const URL_AGENDA = (process.env.AGENDA_URL ?? "").trim();
const DURACAO_MIN = Number(process.env.AGENDA_DURACAO_MIN ?? 45);
/** Antecedencia minima: nao oferece horario daqui a 20 minutos. */
const ANTECEDENCIA_MIN = Number(process.env.AGENDA_ANTECEDENCIA_MIN ?? 120);
const DIAS_A_FRENTE = Number(process.env.AGENDA_DIAS ?? 21);
/** "seg-sex 08:00-18:00; sab 08:00-12:00" */
const HORARIOS = (process.env.AGENDA_HORARIOS ?? "seg-sex 08:00-18:00; sab 08:00-12:00").trim();

export function agendaAtiva(): boolean {
  // http so para a agenda de teste local; em producao e a URL https do Apps Script.
  return /^https:\/\//.test(URL_AGENDA) || /^http:\/\/127\.0\.0\.1:\d+/.test(URL_AGENDA);
}

export function duracaoAvaliacao(): number {
  return DURACAO_MIN;
}

// ---------------------------------------------------------------------------
// Grade de horarios
// ---------------------------------------------------------------------------

const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];

/** dia da semana (0=dom) -> janelas [inicioMin, fimMin] */
function lerHorarios(): Map<number, [number, number][]> {
  const m = new Map<number, [number, number][]>();
  for (const parte of HORARIOS.split(";")) {
    const r = parte.trim().match(/^([a-z]{3})(?:-([a-z]{3}))?\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/i);
    if (!r) continue;
    const de = DIAS.indexOf(r[1]!.toLowerCase());
    const ate = r[2] ? DIAS.indexOf(r[2].toLowerCase()) : de;
    if (de < 0 || ate < 0) continue;
    const janela: [number, number] = [Number(r[3]) * 60 + Number(r[4]), Number(r[5]) * 60 + Number(r[6])];
    for (let d = de; d <= ate; d++) m.set(d, [...(m.get(d) ?? []), janela]);
  }
  return m;
}

/** Diferenca do fuso para UTC em minutos, naquele instante (ex: Santarem = -180). */
function offsetMin(instante: Date): number {
  const nome =
    new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, timeZoneName: "shortOffset" })
      .formatToParts(instante)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const r = nome.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!r) return 0;
  return (r[1] === "-" ? -1 : 1) * (Number(r[2]) * 60 + Number(r[3] ?? 0));
}

/** Data local (ano, mes, dia) + minutos do dia -> instante UTC. */
function instanteLocal(ano: number, mes: number, dia: number, minutos: number): Date {
  const chute = new Date(Date.UTC(ano, mes - 1, dia, 0, minutos));
  return new Date(chute.getTime() - offsetMin(chute) * 60_000);
}

function partesLocais(d: Date): { ano: number; mes: number; dia: number; semana: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(d);
  const v = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  const semanas = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { ano: Number(v("year")), mes: Number(v("month")), dia: Number(v("day")), semana: semanas.indexOf(v("weekday")) };
}

export interface Horario {
  /** id estavel que o modelo devolve no registro: "2026-11-27T09:30" (hora local) */
  id: string;
  inicio: Date;
  fim: Date;
  /** "sexta-feira 27/11 às 9h30" */
  texto: string;
  periodo: "manha" | "tarde";
}

function textoDoHorario(d: Date): string {
  const dia = new Intl.DateTimeFormat("pt-BR", {
    timeZone: config.timezone,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  }).format(d);
  const [h, m] = new Intl.DateTimeFormat("pt-BR", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(d)
    .split(":");
  return `${dia.replace(",", "")} às ${Number(h)}h${m === "00" ? "" : m}`;
}

function idDoHorario(ano: number, mes: number, dia: number, minutos: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${ano}-${p(mes)}-${p(dia)}T${p(Math.floor(minutos / 60))}:${p(minutos % 60)}`;
}

/** Todos os horarios da grade dentro da janela, sem olhar a agenda. */
function grade(): Horario[] {
  const janelas = lerHorarios();
  const agora = Date.now();
  const lista: Horario[] = [];
  for (let i = 0; i <= DIAS_A_FRENTE; i++) {
    const { ano, mes, dia, semana } = partesLocais(new Date(agora + i * 86_400_000));
    for (const [ini, fim] of janelas.get(semana) ?? []) {
      for (let t = ini; t + DURACAO_MIN <= fim; t += DURACAO_MIN) {
        const inicio = instanteLocal(ano, mes, dia, t);
        if (inicio.getTime() < agora + ANTECEDENCIA_MIN * 60_000) continue;
        lista.push({
          id: idDoHorario(ano, mes, dia, t),
          inicio,
          fim: new Date(inicio.getTime() + DURACAO_MIN * 60_000),
          texto: textoDoHorario(inicio),
          periodo: t < 12 * 60 ? "manha" : "tarde",
        });
      }
    }
  }
  return lista;
}

/** "2026-11-27T09:30" -> Horario da grade (ou undefined se nao existe / ja passou). */
export function horarioPorId(id: string): Horario | undefined {
  return grade().find((h) => h.id === id.trim());
}

// ---------------------------------------------------------------------------
// Conversa com o Apps Script
// ---------------------------------------------------------------------------

async function chamar<T>(corpo: Record<string, unknown>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    // Apps Script responde com redirect 302 para o resultado: o fetch segue sozinho.
    const res = await fetch(URL_AGENDA, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(corpo),
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`agenda HTTP ${res.status}`);
    const j = (await res.json()) as T & { erro?: string };
    if (j.erro) throw new Error(`agenda: ${j.erro}`);
    return j;
  } finally {
    clearTimeout(timer);
  }
}

interface Ocupado {
  inicio: string;
  fim: string;
}

let cache: { ate: number; ocupados: Ocupado[] } | undefined;

async function ocupados(forcar = false): Promise<Ocupado[]> {
  if (!forcar && cache && cache.ate > Date.now()) return cache.ocupados;
  const inicio = new Date();
  const fim = new Date(Date.now() + (DIAS_A_FRENTE + 1) * 86_400_000);
  const r = await chamar<{ ocupados: Ocupado[] }>({ acao: "ocupado", inicio: inicio.toISOString(), fim: fim.toISOString() });
  cache = { ate: Date.now() + 60_000, ocupados: r.ocupados ?? [] };
  return cache.ocupados;
}

function livre(h: Horario, ocup: Ocupado[]): boolean {
  return !ocup.some((o) => new Date(o.inicio) < h.fim && new Date(o.fim) > h.inicio);
}

/**
 * Horarios livres. Com `data` ("27/11") e/ou `periodo`, filtra. Sem filtro, devolve
 * os primeiros livres espalhados por dias diferentes (manha e tarde), para a Sara
 * oferecer duas opcoes que realmente existem.
 */
export async function horariosLivres(filtro: { data?: string; periodo?: string }): Promise<Horario[]> {
  const ocup = await ocupados();
  let lista = grade().filter((h) => livre(h, ocup));
  const data = (filtro.data ?? "").match(/(\d{1,2})\/(\d{1,2})/);
  if (data) {
    const p = (n: string) => n.padStart(2, "0");
    lista = lista.filter((h) => h.id.slice(5, 10) === `${p(data[2]!)}-${p(data[1]!)}`);
  }
  const per = (filtro.periodo ?? "").toLowerCase();
  if (/manh|mañ/.test(per)) lista = lista.filter((h) => h.periodo === "manha");
  else if (/tard/.test(per)) lista = lista.filter((h) => h.periodo === "tarde");
  if (data || per) return lista.slice(0, 4);

  // Sem filtro: o primeiro livre de cada dia+periodo, ate 4 opcoes.
  const vistos = new Set<string>();
  const espalhados: Horario[] = [];
  for (const h of lista) {
    const chave = `${h.id.slice(0, 10)}-${h.periodo}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    espalhados.push(h);
    if (espalhados.length >= 4) break;
  }
  return espalhados;
}

/** Marca na agenda. Confere de novo na hora (outra cliente pode ter pego). */
export async function marcar(
  h: Horario,
  titulo: string,
  descricao: string
): Promise<{ ok: true; eventoId: string } | { ok: false; motivo: "ocupado" }> {
  const ocup = await ocupados(true);
  if (!livre(h, ocup)) return { ok: false, motivo: "ocupado" };
  const r = await chamar<{ id?: string; conflito?: boolean }>({
    acao: "criar",
    inicio: h.inicio.toISOString(),
    fim: h.fim.toISOString(),
    titulo,
    descricao,
  });
  if (r.conflito || !r.id) return { ok: false, motivo: "ocupado" };
  cache = undefined;
  return { ok: true, eventoId: r.id };
}

export async function desmarcar(eventoId: string): Promise<void> {
  await chamar({ acao: "apagar", id: eventoId });
  cache = undefined;
}

// ---------------------------------------------------------------------------
// Para os lembretes
// ---------------------------------------------------------------------------

export interface EventoComWhatsApp {
  id: string;
  titulo: string;
  descricao: string;
  inicio: string;
  fim: string;
  criado: string;
}

/** Eventos com link wa.me na descricao (os da Sara e os que a equipe lancar com o link). */
export async function eventosComWhatsApp(inicio: Date, fim: Date): Promise<EventoComWhatsApp[]> {
  const r = await chamar<{ eventos?: EventoComWhatsApp[] }>({
    acao: "eventos",
    inicio: inicio.toISOString(),
    fim: fim.toISOString(),
  });
  return r.eventos ?? [];
}

/** Acrescenta uma linha na descricao do evento ("[lembrete-24h enviado ...]"). */
export async function anotarNoEvento(eventoId: string, texto: string, confirmar = false): Promise<void> {
  await chamar({ acao: confirmar ? "confirmar" : "anotar", id: eventoId, texto });
}

/** "sexta-feira 27/11 às 10h15" -- mesmo formato dos horarios oferecidos. */
export function textoDoInstante(d: Date): string {
  return textoDoHorario(d);
}
