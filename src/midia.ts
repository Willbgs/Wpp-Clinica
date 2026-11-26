import { GoogleGenAI } from "@google/genai";
import { config } from "./config";

/**
 * Mensagem que nao e texto: audio, foto, video, documento.
 *
 * Antes eram ignoradas em silencio -- e no Brasil muita cliente manda audio.
 * Audio vira texto (UAZAPI baixa, o proprio Gemini transcreve). Foto, video e
 * documento viram um aviso entre colchetes: a Sara nao ve o conteudo e o prompt
 * ensina o que dizer. Figurinha, reacao, localizacao etc. continuam ignoradas.
 */

export interface MensagemComMidia {
  type?: string;
  messageType?: string;
  mediaType?: string;
  text?: string;
  messageid?: string;
  id?: string;
}

export type TipoMidia = "audio" | "foto" | "video" | "documento" | "ignorar";

/** Os nomes de campo/valor de midia nao estao documentados: olha os tres campos que costumam vir. */
export function tipoDeMidia(m: MensagemComMidia): TipoMidia {
  const k = `${m.type ?? ""} ${m.messageType ?? ""} ${m.mediaType ?? ""}`.toLowerCase();
  if (/sticker|reaction|poll|location|contact|revoke|protocol|edited/.test(k)) return "ignorar";
  if (/audio|ptt|voice/.test(k)) return "audio";
  if (/image/.test(k)) return "foto";
  if (/video/.test(k)) return "video";
  if (/document/.test(k)) return "documento";
  return "ignorar";
}

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
const LIMITE_BYTES = 8 * 1024 * 1024;

async function comPrazo<T>(ms: number, f: (s: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await f(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

/** POST /message/download -> fileURL. Tenta o id curto e, se falhar, o completo. */
async function baixar(m: MensagemComMidia): Promise<{ dados: Buffer; mime: string } | null> {
  for (const id of [m.messageid, m.id].filter((x): x is string => !!x)) {
    const res = await comPrazo(20_000, (signal) =>
      fetch(`${config.uazapiUrl}/message/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json", token: config.uazapiToken },
        body: JSON.stringify({ id, generate_mp3: true, return_link: true }),
        signal,
      })
    ).catch(() => null);
    if (!res?.ok) {
      console.warn(`[midia] download ${res?.status ?? "falhou"} (id ${id.slice(-6)})`);
      continue;
    }
    const j = (await res.json().catch(() => ({}))) as { fileURL?: string; mimetype?: string };
    if (!j.fileURL) continue;
    const arq = await comPrazo(20_000, (signal) => fetch(j.fileURL!, { signal })).catch(() => null);
    if (!arq?.ok) continue;
    const dados = Buffer.from(await arq.arrayBuffer());
    if (dados.length > LIMITE_BYTES) {
      console.warn(`[midia] audio grande demais (${dados.length} bytes)`);
      return null;
    }
    return { dados, mime: (j.mimetype || "audio/mpeg").split(";")[0]! };
  }
  return null;
}

async function transcrever(m: MensagemComMidia): Promise<string | null> {
  try {
    const arquivo = await baixar(m);
    if (!arquivo) return null;
    const r = await ai.models.generateContent({
      model: config.geminiModel,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: arquivo.mime, data: arquivo.dados.toString("base64") } },
            {
              text:
                "Transcreva exatamente o que a pessoa fala neste audio, no idioma em que ela fala, " +
                "sem comentarios nem explicacoes. Se nao houver fala compreensivel, responda so: INAUDIVEL",
            },
          ],
        },
      ],
      config: { temperature: 0, maxOutputTokens: 800 },
    });
    const texto = (r.text ?? "").trim();
    return !texto || /^inaudivel\.?$/i.test(texto) ? null : texto;
  } catch (e) {
    console.warn("[midia] transcricao falhou:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** O texto que entra na conversa no lugar da midia. null = ignorar. */
export async function textoDaMidia(m: MensagemComMidia): Promise<string | null> {
  const tipo = tipoDeMidia(m);
  console.log(`[midia] recebida: ${m.type ?? "-"}/${m.messageType ?? "-"}/${m.mediaType ?? "-"} -> ${tipo}`);
  const legenda = m.text?.trim() ? ` com a legenda: "${m.text.trim()}"` : "";
  switch (tipo) {
    case "audio": {
      const t = await transcrever(m);
      return t ? `[audio transcrito: ${t}]` : "[audio que nao deu para entender]";
    }
    case "foto":
      return `[foto${legenda}]`;
    case "video":
      return `[video${legenda}]`;
    case "documento":
      return `[documento${legenda}]`;
    default:
      return null;
  }
}
