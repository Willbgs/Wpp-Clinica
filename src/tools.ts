import type { FunctionDeclaration } from "@google/genai";
import { config } from "./config";
import { notificarLead } from "./notificar";
import { pausar } from "./pausa";
import {
  booleano,
  guardarLead,
  leadAnterior,
  moeda,
  normalizar,
  preferir,
  ranquear,
  type Campo,
} from "./catalogo";
import type { Handler } from "./tool-runner";
import catalogoRaw from "./data/catalogo.json";

/**
 * A CAMADA DO NEGOCIO -- clinica de estetica.
 *
 * Este arquivo, o prompt.ts e o data/catalogo.json sao os unicos tres que mudam
 * de um nicho para outro. Todo o resto do src/ atravessa sem tocar.
 */

export interface Procedimento {
  procedimento: string;
  /** Outros nomes que a cliente usa: "botox" para toxina botulinica. */
  apelidos: string;
  categoria: "orelhas" | "rosto";
  /** Areas que o procedimento cobre, quando ele e um guarda-chuva (harmonizacao). */
  areas?: string;
  /**
   * Numero cru em reais, na cidade da clinica. Quem formata e moeda().
   * `null` = sem preco fixo: o valor e negociado na avaliacao e o agente nunca fala numero.
   */
  preco: number | null;
  /** Nome em espanhol: sem ele o modelo inventava "otomodulacion". */
  nomeEs?: string;
  /** Preco para atendimento fora da cidade da clinica, quando for diferente. */
  precoForaDaCidade?: number;
  disponivel: boolean;
  destaque: boolean;
}

const TODOS = catalogoRaw as Procedimento[];

/** So o que a clinica oferece hoje chega ao modelo. */
const ATIVOS = TODOS.filter((p) => p.disponivel);

const ORDEM_CATEGORIAS = ["orelhas", "rosto"] as const;

const NOME_CATEGORIA: Record<Procedimento["categoria"], string> = {
  orelhas: "otomodelação de orelhas",
  rosto: "procedimentos no rosto",
};

/** Categorias que existem no catalogo agora, para o prompt nao prometer o que nao tem. */
export function categoriasDisponiveis(): string[] {
  const tem = new Set(ATIVOS.map((p) => p.categoria));
  return ORDEM_CATEGORIAS.filter((c) => tem.has(c));
}

/** As mesmas categorias, escritas como a cliente le. */
export function categoriasPorExtenso(): string[] {
  return categoriasDisponiveis().map((c) => NOME_CATEGORIA[c as Procedimento["categoria"]]);
}

/** Quantos procedimentos ativos existem -- o prompt usa nos exemplos em vez de um numero fixo. */
export function totalProcedimentos(): number {
  return ATIVOS.length;
}

/**
 * A pergunta que o `npm run check` usa para testar function calling.
 * Sai do proprio catalogo: pergunta fixa vira mentira assim que o catalogo muda.
 */
export function exemploDeBusca(): string {
  const p = ATIVOS.find((x) => x.preco !== null) ?? ATIVOS[0];
  return p ? `Quanto custa ${p.procedimento.toLowerCase()}?` : "Quanto custa?";
}

/** "em Santarem" / "na cidade da clinica" -- o nome vem do .env, nunca fixo no codigo. */
function naCidade(): string {
  return config.empresaCidade ? `em ${config.empresaCidade}` : "na cidade da clinica";
}

function foraDaCidade(): string {
  return config.empresaCidade ? `fora de ${config.empresaCidade}` : "fora da cidade da clinica";
}

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------

/**
 * Campos da busca, em ordem de especificidade.
 * Nome do procedimento e apelido pesam igual: "botox" tem que achar a toxina
 * botulinica com a mesma forca que o nome tecnico.
 */
function camposDe(p: Procedimento): Campo[] {
  return [
    { valor: p.procedimento, peso: 6, pesoExato: 10, colado: true },
    // Cada apelido e um campo proprio para valer o pesoExato: "mento" (queixo)
    // tem que ganhar de "preenchiMENTO", que so casa por pedaco.
    ...p.apelidos
      .split(/\s+/)
      .filter(Boolean)
      .map((a): Campo => ({ valor: a, peso: 6, pesoExato: 10 })),
    // pesoExato igual ao peso: "rosto" sozinho tem que empatar todos os do rosto
    // (e virar pergunta), nao eleger um deles.
    { valor: p.categoria, peso: 5, pesoExato: 5 },
  ];
}

// Igual ao menor peso que deve passar sozinho (categoria). Mexeu nos pesos, confira.
const LIMIAR = 5;

/**
 * Palavras de ligacao que a busca ignora.
 *
 * Sem isso "de" casa com "Fios de PDO" e "Bioestimulador de colageno" ao mesmo
 * tempo, e um procedimento que nao existe ("limpeza de pele") passaria do limiar
 * como se existisse.
 */
const PALAVRAS_VAZIAS = new Set([
  "de", "da", "do", "das", "dos", "a", "o", "as", "os", "e", "em", "no", "na",
  "um", "uma", "pra", "para", "com", "que", "quanto", "custa", "valor", "preco",
  "fazer", "quero", "tem", "voces", "vcs", "ta", "fica", "sai",
  // Generica demais: "limpeza facial" caia em "Harmonizacao facial".
  "facial",
  // Espanhol
  "el", "la", "los", "las", "del", "y", "en", "por", "cuanto", "cuesta", "precio",
  "quiero", "tienen", "hacer", "sale",
]);

function limparTermo(termo: string): string {
  return normalizar(termo)
    .split(" ")
    .filter((t) => !PALAVRAS_VAZIAS.has(t))
    .join(" ");
}

/** Preco ja escrito, pronto para o modelo repetir. */
function precoTexto(p: Procedimento): string {
  if (p.preco === null) return "valor combinado na avaliacao";
  // Com dois valores, a listagem precisa dizer a qual cidade este se refere.
  return p.precoForaDaCidade !== undefined ? `${moeda(p.preco)} ${naCidade()}` : moeda(p.preco);
}

/** Ficha completa -- so depois que a cliente escolheu um. */
function ficha(p: Procedimento) {
  const es = p.nomeEs ? { nomeEmEspanhol: p.nomeEs } : {};
  if (p.preco === null) {
    return {
      procedimento: p.procedimento,
      ...es,
      ...(p.areas ? { areas: p.areas } : {}),
      precoFixo: false,
      preco: "valor combinado com a profissional na avaliacao",
    };
  }
  if (p.precoForaDaCidade !== undefined) {
    return {
      procedimento: p.procedimento,
      ...es,
      precoFixo: true,
      preco: `${moeda(p.preco)} ${naCidade()}`,
      // Sem "para atendimento": o modelo copiava a palavra em portugues no meio do espanhol.
      precoForaDaCidade: `${moeda(p.precoForaDaCidade)} ${foraDaCidade()}`,
    };
  }
  return { procedimento: p.procedimento, ...es, precoFixo: true, preco: moeda(p.preco) };
}

/**
 * Preco de tabela para os EXEMPLOS do prompt, tirado do mesmo catalogo da ferramenta.
 *
 * Com o marcador "[PRECO]" nos exemplos, o modelo as vezes mandava "[PRECO]" para
 * a cliente. Com o valor real, o pior caso e ele repetir o valor certo.
 */
export function precoDeExemplo(termo: string, foraDaCidade = false): string {
  const alvo = normalizar(termo);
  const p = ATIVOS.find((x) => normalizar(`${x.procedimento} ${x.apelidos}`).includes(alvo));
  if (!p || p.preco === null) return "o valor da tabela";
  return moeda(foraDaCidade && p.precoForaDaCidade !== undefined ? p.precoForaDaCidade : p.preco);
}

/** Nome + preco, sem detalhe. */
function resumo(p: Procedimento) {
  return { procedimento: p.procedimento, preco: precoTexto(p) };
}

function sugestoes(): string[] {
  return ATIVOS.slice()
    .sort((a, b) => Number(b.destaque) - Number(a.destaque))
    .slice(0, 4)
    .map((p) => p.procedimento);
}

function instrucaoDaFicha(p: Procedimento): string {
  if (p.preco === null) {
    return (
      "Esse procedimento NAO tem preco fixo: o valor e combinado com a profissional na avaliacao. " +
      "NUNCA diga numero, faixa, 'a partir de' nem 'mais ou menos'. Diga isso numa frase e siga " +
      "para a proxima pergunta que falta (nome ou a avaliacao)."
    );
  }
  if (p.precoForaDaCidade !== undefined) {
    return (
      `Ha dois valores: um ${naCidade()} e outro para atendimento ${foraDaCidade()}. ` +
      "O que conta e onde sera o ATENDIMENTO, nao onde ela mora. Se ainda nao sabe, diga os dois " +
      "valores numa frase e pergunte onde seria. Se ja sabe, diga so o valor que vale. Nao prometa resultado."
    );
  }
  return "Informe o preco. Nao prometa resultado. Depois siga para a proxima pergunta que falta.";
}

function buscarProcedimento(args: Record<string, unknown>) {
  const bruto = typeof args.termo === "string" ? args.termo : "";
  const termo = limparTermo(bruto);
  if (!termo.trim()) {
    return {
      encontrado: false,
      instrucao: "A cliente nao disse qual procedimento. Pergunte o que ela tem em mente.",
      sugestoes: sugestoes(),
    };
  }

  const { melhor, empatados } = ranquear(ATIVOS, termo, camposDe, LIMIAR);

  if (!melhor) {
    return {
      encontrado: false,
      instrucao:
        "A clinica nao tem esse procedimento. Diga que esse nao tem e ofereca as sugestoes. " +
        "Nao invente preco nem diga que 'a equipe faz'.",
      sugestoes: sugestoes(),
    };
  }

  if (empatados.length > 1) {
    return {
      encontrado: true,
      ambiguo: true,
      instrucao:
        "Mais de um procedimento bate. Cite no maximo 2 e pergunte qual deles ela quer.",
      opcoes: empatados.slice(0, 3).map(resumo),
      total: empatados.length,
    };
  }

  return { encontrado: true, ...ficha(melhor), instrucao: instrucaoDaFicha(melhor) };
}

function listarProcedimentos(args: Record<string, unknown>) {
  const cats = categoriasDisponiveis();
  const categoria =
    typeof args.categoria === "string" && cats.includes(args.categoria)
      ? (args.categoria as Procedimento["categoria"])
      : undefined;
  const precoMax =
    typeof args.precoMax === "number" && args.precoMax > 0 ? args.precoMax : undefined;

  const filtrados = ATIVOS.filter(
    (p) =>
      (!categoria || p.categoria === categoria) &&
      // Com teto de valor, so entra o que tem preco fixo e cabe nele.
      (!precoMax || (p.preco !== null && p.preco <= precoMax))
  ).sort(
    (a, b) =>
      Number(b.destaque) - Number(a.destaque) ||
      (a.preco ?? Number.MAX_SAFE_INTEGER) - (b.preco ?? Number.MAX_SAFE_INTEGER)
  );

  if (filtrados.length === 0) {
    return {
      total: 0,
      procedimentos: [],
      instrucao: precoMax
        ? "Nada com preco fixo nessa faixa. Diga isso e cite o procedimento mais em conta que existe."
        : "Nada disponivel nessa categoria agora. Ofereca as outras categorias.",
      categorias: categoriasPorExtenso(),
    };
  }

  // Poucos de proposito: o agente cita no maximo 2, e `total` deixa ele dizer
  // "a gente tem 5 procedimentos" sem recitar os 5.
  const amostra = filtrados.slice(0, 3);

  return {
    total: filtrados.length,
    mostrando: amostra.length,
    procedimentos: amostra.map(resumo),
    instrucao:
      filtrados.length > 2
        ? `Ha ${filtrados.length} procedimentos. Cite no maximo 2 e faca UMA pergunta que estreite (orelhas ou rosto, o que ela quer melhorar). Nao liste todos.`
        : "Pode citar os dois.",
  };
}

// ---------------------------------------------------------------------------
// Lead
// ---------------------------------------------------------------------------

/**
 * `type` e nao `interface` de proposito: um type alias de objeto e atribuivel a
 * Record<string, unknown>, o que deixa este Lead entrar direto no store generico
 * e no webhook, sem cast nenhum.
 */
export type Lead = {
  nome: string;
  procedimento: string;
  /** Onde seria o atendimento -- muda o preco da otomodelacao. */
  cidade: string;
  /** A cliente pediu para falar com uma pessoa. */
  pediuHumano: boolean;
  /** Dia + data + periodo que a CLIENTE aceitou para a avaliacao. */
  avaliacao: string;
  /** Pergunta que ela aceitou deixar para a equipe responder. */
  duvida: string;
  /** "espanhol" quando a conversa foi em espanhol; a equipe continua no mesmo idioma. */
  idioma: string;
  /** Por que a conversa foi para a equipe. Nem todo contato e venda. */
  assunto: Assunto;
};

const ASSUNTOS = [
  "atendimento",
  "remarcar ou cancelar",
  "queixa apos procedimento",
  "fornecedor ou parceria",
  "vaga de emprego",
  "outro assunto",
] as const;
type Assunto = (typeof ASSUNTOS)[number];

/** Titulo do aviso por assunto. Queixa apos procedimento pode ser complicacao: vem marcada como urgente. */
const TITULO_ASSUNTO: Record<Exclude<Assunto, "atendimento">, string> = {
  "remarcar ou cancelar": "*Paciente quer remarcar ou cancelar*",
  "queixa apos procedimento": "🚨 *URGENTE: queixa depois de procedimento* -- responda o quanto antes",
  "fornecedor ou parceria": "*Contato de fornecedor/parceria* (não é cliente)",
  "vaga de emprego": "*Contato sobre vaga de emprego* (não é cliente)",
  "outro assunto": "*Contato sobre outro assunto*",
};

/**
 * "pode ser" respondendo a "sexta de manha ou segunda a tarde?" nao diz qual.
 * O modelo escolhia uma das duas sozinho. A frase do aceite tem que citar dia,
 * periodo ou a opcao. Recusa so uma vez por conversa: se so havia uma opcao, o
 * "sim" da segunda tentativa passa.
 */
const ACEITE_JA_COBRADO = new Set<string>();
function aceiteVago(frase: string, chatid: string): boolean {
  const t = normalizar(frase);
  const citaOpcao =
    /(segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje|manha|tarde|noite|lunes|martes|miercoles|jueves|viernes|manana|primeir|primer|segund|ultim|\d)/.test(
      t
    );
  if (citaOpcao || ACEITE_JA_COBRADO.has(chatid)) return false;
  ACEITE_JA_COBRADO.add(chatid);
  return true;
}

/**
 * Ter duvida nao e encerrar. O modelo registrava (e calava por 2 h) quem dizia
 * "nao quero agendar ainda, tenho duvidas" sem nem perguntar qual era a duvida.
 */
function aindaTemDuvida(frase: string): boolean {
  const t = frase.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/(tirei|tirou|sem|nenhuma|era so|so essa|sin|ninguna|ya no tengo|es todo)\b.{0,20}(duvida|duda)/.test(t))
    return false;
  return /duvida|duda|como funciona|como e feito|como se hace|me explica|explicame|queria (saber|entender)|quisiera saber|\?/.test(
    t
  );
}

/** O texto que chega no WhatsApp de quem vai atender. */
function formatarParaHumano(lead: Lead, telefoneCliente: string): string {
  return [
    lead.assunto !== "atendimento"
      ? TITULO_ASSUNTO[lead.assunto]
      : lead.pediuHumano
        ? "*Cliente pediu para falar com uma pessoa*"
        : lead.duvida && lead.avaliacao === "não agendada"
          ? "*Cliente com dúvida*"
          : "*Nova cliente para avaliação*",
    "",
    `Cliente: ${lead.nome}`,
    // Link clicavel: abre a conversa direto no celular de quem recebe o aviso.
    `WhatsApp: https://wa.me/${telefoneCliente}`,
    `Procedimento: ${lead.procedimento}`,
    ...(lead.idioma === "espanhol" ? ["Idioma: espanhol (responda em espanhol)"] : []),
    // So importa na otomodelacao; nos outros seria uma linha vazia a toa.
    ...(lead.cidade === "não informada" ? [] : [`Cidade do atendimento: ${lead.cidade}`]),
    ...(lead.duvida ? [`Dúvida: ${lead.duvida}`] : []),
    `Avaliação: ${lead.avaliacao}`,
    "",
    lead.avaliacao === "não agendada"
      ? "Assuma a conversa."
      : "Confirme o horário e assuma a conversa.",
  ].join("\n");
}

/** Tempo para a mensagem de despedida sair antes de o agente calar. */
const ATRASO_DA_PAUSA_MS = 15_000;

function registrarLead(args: Record<string, unknown>, chatid: string) {
  const anterior = leadAnterior<Lead>(chatid);

  // Horario fantasma: o modelo as vezes registra o periodo que ELE sugeriu sem a
  // cliente ter aceitado. Sem a frase do aceite, recusa antes de gravar e pausar.
  const querMarcar = String(args.avaliacao ?? "").trim() !== "";
  const fraseDoAceite = String(args.fraseDoAceite ?? "").trim();
  if (querMarcar && !fraseDoAceite) {
    return {
      ok: false,
      instrucao:
        "NAO registrado: falta fraseDoAceite. Se a cliente nao escolheu um dia e periodo, " +
        "responda a ultima mensagem dela e continue a conversa sem registrar.",
    };
  }
  if (querMarcar && aceiteVago(fraseDoAceite, chatid)) {
    return {
      ok: false,
      instrucao:
        "NAO registrado: a resposta dela nao diz QUAL dia/periodo. Pergunte qual das opcoes ela prefere, " +
        "citando as duas de novo. Nao diga que marcou.",
    };
  }

  // Encerramento precoce: sem horario e sem pedido de pessoa, so registra se a
  // cliente encerrou mesmo (ou aceitou deixar a duvida anotada).
  const duvida = String(args.duvida ?? "").trim();
  const assunto: Assunto = ASSUNTOS.includes(args.assunto as Assunto)
    ? (args.assunto as Assunto)
    : "atendimento";
  // Remarcar, queixa, fornecedor, vaga: passa na hora, nao e venda para "encerrar".
  if (
    !querMarcar &&
    !anterior &&
    assunto === "atendimento" &&
    // Otomodelacao no Mexico termina quando ela diz a cidade: nao ha horario para marcar.
    !normalizar(String(args.cidade ?? "")).includes("mexico") &&
    args.pediuHumano !== true &&
    args.pediuHumano !== "true"
  ) {
    const frase = String(args.fraseDeEncerramento ?? "").trim();
    if (!frase || aindaTemDuvida(frase)) {
      return {
        ok: false,
        instrucao:
          "NAO registrado: ela nao encerrou a conversa. Nao diga que avisou a equipe. Se ela tem duvida e " +
          "nao disse qual, pergunte qual e. Se disse, responda o que souber ou pergunte se quer deixar a " +
          "duvida anotada para a equipe responder por aqui.",
      };
    }
  }

  const lead: Lead = {
    nome: preferir(String(args.nome ?? ""), anterior?.nome, "não informado"),
    procedimento: preferir(
      String(args.procedimento ?? ""),
      anterior?.procedimento,
      "não informado"
    ),
    pediuHumano: booleano(args.pediuHumano, anterior?.pediuHumano),
    cidade: preferir(String(args.cidade ?? ""), anterior?.cidade, "não informada"),
    avaliacao: preferir(String(args.avaliacao ?? ""), anterior?.avaliacao, "não agendada"),
    duvida: preferir(duvida, anterior?.duvida, ""),
    idioma: preferir(String(args.idioma ?? "").trim().toLowerCase(), anterior?.idioma, "portugues"),
    assunto: assunto !== "atendimento" ? assunto : (anterior?.assunto ?? "atendimento"),
  };

  guardarLead(chatid, lead);

  // Este console.log e o "CRM" da demo -- aparece nos logs do servidor.
  const titulo = anterior ? "LEAD ATUALIZADO" : "LEAD QUALIFICADO";
  console.log(
    `\n===== ${titulo} =====\n` +
      JSON.stringify({ ...lead, registradoEm: new Date().toISOString() }, null, 2) +
      "\n============================\n"
  );

  const telefone = chatid.split("@")[0] ?? chatid;
  notificarLead(lead, formatarParaHumano(lead, telefone), chatid);

  // A equipe assume -- o agente sai da frente.
  if (config.pausarAposLead) {
    // Com atraso de proposito: o index.ts engole a resposta se a conversa ja estiver
    // pausada quando o modelo termina. Pausar na hora calava a despedida deste turno.
    setTimeout(
      () => pausar(chatid, config.pausaAposLeadMin * 60_000, "lead registrado, equipe assumiu"),
      ATRASO_DA_PAUSA_MS
    ).unref();
  }

  if (anterior) {
    return {
      ok: true,
      jaRegistrado: true,
      instrucao:
        "Essa cliente JA estava registrada e foi atualizada. NAO registre de novo. " +
        "So responda normalmente.",
    };
  }

  if (lead.assunto === "queixa apos procedimento") {
    return {
      ok: true,
      instrucao:
        "Registrado como URGENTE. Diga que ja avisou a equipe e que vao falar com ela o quanto antes. " +
        "Diga tambem que, se piorar (dor forte, pele arroxeada ou esbranquicada se espalhando, falta de ar), " +
        "procure um pronto-socorro na hora. Nao de outra orientacao de saude.",
    };
  }

  if (lead.assunto !== "atendimento") {
    return {
      ok: true,
      instrucao: "Registrado. Diga que passou para a equipe e que eles respondem por aqui. Nao pergunte mais nada.",
    };
  }

  if (lead.pediuHumano) {
    return {
      ok: true,
      instrucao: "Registrado. Diga que avisou a equipe e que ela continua a conversa. Nao pergunte mais nada.",
    };
  }

  if (lead.avaliacao === "não agendada" && lead.duvida) {
    return {
      ok: true,
      instrucao: "Registrado com a duvida. Diga que anotou e que a equipe responde por aqui. Nao fale em horario nem pergunte mais nada.",
    };
  }

  if (lead.avaliacao === "não agendada") {
    return {
      ok: true,
      instrucao:
        "Registrado SEM horario. Diga que a equipe fala com ela quando ficar melhor. Nao fale em confirmar horario.",
    };
  }

  return {
    ok: true,
    instrucao:
      "Registrado. Avise que a equipe da clinica confirma o horario com ela em instantes. Nao pergunte mais nada.",
  };
}

// ---------------------------------------------------------------------------
// Declaracoes para o Gemini
// ---------------------------------------------------------------------------

export const declaracoes: FunctionDeclaration[] = [
  {
    name: "buscarProcedimento",
    description:
      "Busca um procedimento da clinica pelo nome ou pelo nome popular (ex: 'botox', 'orelha'). Use sempre que a cliente citar um procedimento. Unica fonte de preco valida.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        termo: {
          type: "string",
          description: "O procedimento como a cliente falou. Ex: 'botox', 'otomodelacao', 'preenchimento', 'fios'.",
        },
      },
      required: ["termo"],
    },
  },
  {
    name: "listarProcedimentos",
    description:
      "Mostra procedimentos da clinica com o total disponivel. Use quando a cliente nao souber o que quer, pedir opcoes, ou depois que ela estreitar (categoria/faixa de valor). Retorna poucos itens de proposito: cite no maximo 2 na sua mensagem.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        categoria: {
          type: "string",
          enum: categoriasDisponiveis(),
          description: "Filtro opcional: orelhas (otomodelacao) ou rosto. Omita para trazer todos.",
        },
        precoMax: {
          type: "number",
          description:
            "Teto de valor em reais, sem pontuacao. Ex: cliente falou 'ate mil' -> 1000.",
        },
      },
    },
  },
  {
    name: "registrarLead",
    description:
      "Registra a cliente e passa a conversa para a equipe da clinica. Chame quando tiver o nome e o procedimento de interesse E ja tiver proposto a avaliacao e ouvido a resposta. NAO chame se ela so disse que tem duvida ou que ainda nao quer agendar: pergunte qual e a duvida. EXCECAO: se a cliente pedir para falar com uma pessoa, chame na hora com pediuHumano = true e o que tiver.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Nome da cliente." },
        procedimento: { type: "string", description: "Procedimento de interesse." },
        pediuHumano: {
          type: "boolean",
          description: "true so se a cliente pediu para falar com uma pessoa.",
        },
        cidade: {
          type: "string",
          description: "Cidade onde a cliente quer ser atendida, se ela disse. Omita se nao souber.",
        },
        assunto: {
          type: "string",
          enum: [...ASSUNTOS],
          description:
            "Por que a conversa vai para a equipe. 'atendimento' = interesse em procedimento (o normal). " +
            "Os outros passam NA HORA, com o que tiver, sem pedir nome antes: 'remarcar ou cancelar' (ja tem horario " +
            "marcado), 'queixa apos procedimento' (ja fez procedimento e esta com problema, dor, inchaco, roxo -- urgente), " +
            "'fornecedor ou parceria', 'vaga de emprego', 'outro assunto' (nada a ver com procedimento).",
        },
        idioma: {
          type: "string",
          enum: ["portugues", "espanhol"],
          description: "Idioma em que a conversa aconteceu. 'espanhol' se a cliente falou em espanhol.",
        },
        duvida: {
          type: "string",
          description:
            "A pergunta que a cliente ACEITOU deixar anotada para a equipe responder. Omita se nao houver.",
        },
        fraseDeEncerramento: {
          type: "string",
          description:
            "Obrigatorio quando NAO ha avaliacao nem pediuHumano. Copie LITERALMENTE a mensagem em que a cliente " +
            "encerrou a conversa, recusou marcar ou aceitou deixar a duvida anotada. Dizer que tem duvida NAO e encerrar.",
        },
        fraseDoAceite: {
          type: "string",
          description:
            "Copie LITERALMENTE a mensagem em que a cliente escolheu ou aceitou o dia e periodo. " +
            "Obrigatorio junto com avaliacao. Pergunta sobre funcionamento ('abrem domingo?') NAO e aceite: " +
            "nesse caso nao chame esta ferramenta.",
        },
        avaliacao: {
          type: "string",
          description:
            "Dia da semana + DATA + periodo que a CLIENTE confirmou para a avaliacao. " +
            "SEMPRE com a data concreta, no formato 'dia-da-semana DD/MM, periodo'. " +
            "Converta 'amanha'/'sexta' usando a lista de proximos dias do seu contexto. " +
            "Se ela pediu hora exata, acrescente no fim: 'segunda-feira 30/11, a tarde (prefere 14h)'. " +
            "Omita se ela recusou, nao respondeu ou respondeu outra coisa. NUNCA preencha com o " +
            "periodo que voce sugeriu sem ela ter aceitado.",
        },
      },
      // Sem obrigatorios: quem pede uma pessoa e registrado mesmo sem nome/procedimento.
    },
  },
];

export const handlers: Record<string, Handler> = {
  buscarProcedimento,
  listarProcedimentos,
  registrarLead,
};
