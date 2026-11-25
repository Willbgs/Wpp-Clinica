/**
 * SO PARA TESTE: deixa passar apenas mensagens da conversa com HUMANO_WHATSAPP.
 *
 * Fica na porta 3000 (onde o endereco publico aponta) e repassa para o servidor
 * da Sara na porta 3002. Mensagem de qualquer outra conversa vira um corpo vazio:
 * o servidor confere a senha e responde normalmente, mas a Sara nao ve nada.
 *
 * Na hora de atender clientes de verdade, desligue o filtro e rode o servidor
 * direto na porta 3000.
 */
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";

// Na hospedagem nao existe .env: vem da variavel de ambiente.
const arquivo = new URL("../.env", import.meta.url);
const env = existsSync(arquivo) ? readFileSync(arquivo, "utf8") : "";
const permitido =
  process.env.HUMANO_WHATSAPP?.trim() || ((env.match(/^HUMANO_WHATSAPP=(\d+)/m) ?? [])[1] ?? "");
if (!/^55\d{10,11}$/.test(permitido)) {
  console.error("[filtro] HUMANO_WHATSAPP ausente ou invalido -- nada passaria. Saindo.");
  process.exit(1);
}

const ENTRADA = Number(process.env.FILTRO_PORTA ?? 3000);
const SAIDA = Number(process.env.FILTRO_DESTINO ?? 3002);

/** DDI + DDD + 8 ultimos digitos: o WhatsApp as vezes guarda o numero sem o 9. */
const chave = (n) => `${n.slice(0, 4)}-${n.slice(-8)}`;

function passa(chatid) {
  const [numero, dominio] = String(chatid ?? "").split("@");
  return (
    dominio === "s.whatsapp.net" &&
    /^55\d{10,11}$/.test(numero) &&
    chave(numero) === chave(permitido)
  );
}

http
  .createServer((req, res) => {
    const partes = [];
    req.on("data", (c) => partes.push(c));
    req.on("end", () => {
      let corpo = Buffer.concat(partes);
      if (req.method === "POST") {
        let ok = false;
        try {
          ok = passa(JSON.parse(corpo.toString("utf8"))?.message?.chatid);
        } catch {
          ok = false;
        }
        console.log(ok ? "[filtro] passou" : "[filtro] bloqueado (outra conversa)");
        if (!ok) corpo = Buffer.from("{}");
      }
      const destino = http.request(
        {
          host: "127.0.0.1",
          port: SAIDA,
          method: req.method,
          path: req.url,
          headers: { "content-type": "application/json", "content-length": corpo.length },
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, { "content-type": r.headers["content-type"] ?? "text/plain" });
          r.pipe(res);
        }
      );
      destino.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      destino.end(corpo);
    });
  })
  .listen(ENTRADA, () => console.log(`[filtro] ligado: so a conversa com final ${permitido.slice(-4)}`));
