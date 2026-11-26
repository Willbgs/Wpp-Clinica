import { config } from "./config";
import { enviarTexto } from "./whatsapp";

/**
 * Entrega do lead pronto. Dois destinos, ambos opcionais e independentes.
 *
 * 1. WhatsApp de quem vai atender -- o lead mastigado chega no celular da
 *    pessoa, sem ninguem precisar abrir painel nenhum.
 * 2. Webhook generico -- POST do lead em JSON para n8n, Make, Zapier, Trello ou
 *    o CRM que o negocio ja usa. E o ponto de encaixe: o cliente NAO troca de
 *    ferramenta, so passa a receber o lead qualificado dentro da que ele ja tem.
 *
 * Tudo aqui e best-effort: falhar em notificar nao pode derrubar o atendimento,
 * porque o lead ja esta registrado no log de qualquer forma.
 *
 * Generico de proposito: quem monta o texto da mensagem e tools.ts, que conhece
 * os campos do lead deste nicho. Aqui so entrega.
 */

/**
 * AVISO_GRUPO (ex: "120363...@g.us"): os avisos vao para um grupo da equipe em vez
 * de um celular so. O numero da clinica precisa estar no grupo. Com grupo definido,
 * HUMANO_WHATSAPP deixa de receber os avisos (e continua valendo para o filtro de teste).
 */
const AVISO_GRUPO = (process.env.AVISO_GRUPO ?? "").trim();

async function avisarGrupo(mensagem: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    // JID completo: enviarTexto tira tudo que nao e digito e o "@g.us" se perderia.
    const res = await fetch(`${config.uazapiUrl}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: config.uazapiToken },
      body: JSON.stringify({ number: AVISO_GRUPO, text: mensagem, linkPreview: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`UAZAPI ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    console.log("[notificar] aviso entregue no grupo da equipe");
  } finally {
    clearTimeout(timer);
  }
}

async function avisarHumano(mensagem: string): Promise<void> {
  if (AVISO_GRUPO.endsWith("@g.us")) {
    await avisarGrupo(mensagem);
    return;
  }
  if (!config.humanoWhatsapp) return;
  await enviarTexto(config.humanoWhatsapp, mensagem);
}

async function dispararWebhook(lead: Record<string, unknown>, chatid: string): Promise<void> {
  if (!config.leadWebhookUrl) return;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(config.leadWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...lead,
        telefone: chatid.split("@")[0],
        empresa: config.empresaNome,
        registradoEm: new Date().toISOString(),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) console.warn(`[notificar] webhook ${res.status} (ignorado)`);
    else console.log("[notificar] webhook entregue");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dispara as notificacoes sem bloquear a resposta ao cliente.
 *
 * O cliente nao pode esperar o Trello responder para receber "ja passei pra
 * equipe" -- por isso isto e fire-and-forget, com cada destino isolado do
 * outro: webhook fora do ar nao impede o WhatsApp de tocar.
 */
export function notificarLead(
  lead: Record<string, unknown>,
  mensagem: string,
  chatid: string
): void {
  void avisarHumano(mensagem).catch((e) =>
    console.warn("[notificar] whatsapp falhou (ignorado):", e instanceof Error ? e.message : e)
  );
  void dispararWebhook(lead, chatid).catch((e) =>
    console.warn("[notificar] webhook falhou (ignorado):", e instanceof Error ? e.message : e)
  );
}
