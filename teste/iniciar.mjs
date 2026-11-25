/**
 * Inicio da hospedagem (npm start).
 *
 * Por padrao sobe COM o filtro de teste: a Sara so responde a HUMANO_WHATSAPP.
 * Para atender todo mundo, defina a variavel SO_TESTE=false. Qualquer outro valor,
 * ou a variavel ausente, mantem o filtro -- errar para o lado de nao responder.
 */
const soTeste = (process.env.SO_TESTE ?? "").trim().toLowerCase() !== "false";

if (soTeste) {
  const publica = process.env.PORT || "3000";
  const interna = process.env.FILTRO_DESTINO || (publica === "3002" ? "3003" : "3002");
  process.env.FILTRO_PORTA = publica;
  process.env.FILTRO_DESTINO = interna;
  process.env.PORT = interna;
  console.log("[inicio] MODO TESTE: so responde a HUMANO_WHATSAPP. Para abrir a todos: SO_TESTE=false");
  await import("./filtro.mjs");
} else {
  console.log("[inicio] MODO ABERTO: responde a todas as conversas");
}

await import("../dist/index.js");
