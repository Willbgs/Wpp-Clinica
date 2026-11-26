/**
 * Ponte entre a Sara e o Google Agenda da clinica (Google Apps Script).
 *
 * Como instalar (na conta Google dona da agenda):
 *   1. script.google.com > Novo projeto > apague o que estiver la e cole este arquivo.
 *   2. Implantar > Nova implantacao > tipo "App da Web".
 *      Executar como: Eu.  Quem pode acessar: Qualquer pessoa.
 *   3. Autorize o acesso a agenda quando o Google pedir.
 *   4. Copie a URL do app da Web (termina em /exec) e coloque em AGENDA_URL.
 * Para atualizar sem trocar a URL: Implantar > Gerenciar implantacoes > lapis > Versao: Nova versao.
 * Planilha de contatos: rode a funcao "autorizar" uma vez no editor (cria a planilha no seu Drive).
 *
 * O que ele faz (e so isso):
 *   - "ocupado":   inicio/fim dos eventos num intervalo (sem titulo nem detalhes).
 *   - "criar":     cria a avaliacao, se o horario ainda estiver livre.
 *   - "apagar":    apaga um evento, mas SO se for uma avaliacao (titulo com "Avaliação - ").
 *   - "eventos":   eventos com link wa.me na descricao (para os lembretes).
 *   - "anotar":    acrescenta uma linha na descricao desses eventos (lembrete enviado etc.).
 *   - "confirmar": pinta de verde e anota que a cliente confirmou.
 */

function doPost(e) {
  try {
    var b = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    var cal = CalendarApp.getDefaultCalendar();

    if (b.acao === "ocupado") {
      return saida({ ocupados: ocupados(cal, new Date(b.inicio), new Date(b.fim)) });
    }

    if (b.acao === "criar") {
      var trava = LockService.getScriptLock();
      trava.waitLock(20000);
      try {
        var ini = new Date(b.inicio);
        var fim = new Date(b.fim);
        if (!(ini < fim) || fim - ini > 4 * 3600 * 1000 || ini < new Date()) {
          return saida({ erro: "horario invalido" });
        }
        if (ocupados(cal, ini, fim).length > 0) return saida({ conflito: true });
        var ev = cal.createEvent(String(b.titulo || "Avaliação").slice(0, 150), ini, fim, {
          description: String(b.descricao || "").slice(0, 1000),
        });
        return saida({ id: ev.getId() });
      } finally {
        trava.releaseLock();
      }
    }

    if (b.acao === "apagar") {
      var alvo = cal.getEventById(String(b.id || ""));
      if (alvo && alvo.getTitle().indexOf("Avaliação - ") >= 0) alvo.deleteEvent();
      return saida({ ok: true });
    }

    if (b.acao === "eventos") {
      var lista = cal.getEvents(new Date(b.inicio), new Date(b.fim)).filter(comWhatsApp).map(function (ev) {
        return {
          id: ev.getId(),
          titulo: ev.getTitle(),
          descricao: ev.getDescription(),
          inicio: ev.getStartTime().toISOString(),
          fim: ev.getEndTime().toISOString(),
          criado: ev.getDateCreated().toISOString(),
        };
      });
      return saida({ eventos: lista });
    }

    if (b.acao === "anotar" || b.acao === "confirmar") {
      var ev2 = cal.getEventById(String(b.id || ""));
      if (ev2 && comWhatsApp(ev2)) {
        ev2.setDescription(ev2.getDescription() + "\n" + String(b.texto || "").slice(0, 200));
        if (b.acao === "confirmar") ev2.setColor(CalendarApp.EventColor.GREEN);
      }
      return saida({ ok: true });
    }

    // Contato da Sara (o mesmo JSON do aviso da equipe): vai para a planilha.
    if (!b.acao && b.telefone) return saida(registrarContato(b));

    return saida({ erro: "acao invalida" });
  } catch (err) {
    return saida({ erro: String(err) });
  }
}

/** Abrir a URL no navegador mostra que esta no ar. */
function doGet() {
  var id = PropertiesService.getScriptProperties().getProperty("PLANILHA_ID");
  return saida({ ok: true, agenda: CalendarApp.getDefaultCalendar().getName(), versao: 3, planilha: !!id });
}

// ---------------------------------------------------------------------------
// Planilha de contatos: uma linha por cliente (pelo WhatsApp), sempre atualizada.
// A coluna "Anotações da equipe" e da equipe: a Sara nunca escreve nela.
// ---------------------------------------------------------------------------

var CABECALHO = ["Primeiro contato", "Última atualização", "Nome", "WhatsApp", "Procedimento", "Situação",
  "Avaliação", "Cidade", "Idioma", "Dúvida", "Anotações da equipe"];

/** Rode esta funcao uma vez no editor para autorizar o acesso a planilha (e criar a planilha). */
function autorizar() {
  Logger.log("Planilha: " + planilha().getParent().getUrl());
}

function planilha() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("PLANILHA_ID");
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create("Contatos da Sara - BeautyCare Estética");
    props.setProperty("PLANILHA_ID", ss.getId());
    var aba = ss.getSheets()[0];
    aba.setName("Contatos");
    aba.appendRow(CABECALHO);
    aba.setFrozenRows(1);
    aba.getRange(1, 1, 1, CABECALHO.length).setFontWeight("bold").setBackground("#f3e8ff");
    aba.setColumnWidths(1, CABECALHO.length, 160);
  }
  return ss.getSheetByName("Contatos") || ss.getSheets()[0];
}

function limpo(v) {
  var s = String(v === undefined || v === null ? "" : v).trim();
  if (s === "não informado" || s === "não informada" || s === "não agendada" || s === "portugues") return "";
  return s.replace(" (MARCADO na agenda)", "");
}

function situacao(b) {
  if (b.evento === "confirmou") return "Confirmou a avaliação";
  if (b.evento === "cancelou") return "Cancelou a avaliação";
  var a = String(b.avaliacao || "");
  if (b.assunto === "queixa apos procedimento") return "URGENTE: queixa depois de procedimento";
  if (b.assunto && b.assunto !== "atendimento") return b.assunto;
  if (b.pediuHumano === true) return "Pediu para falar com uma pessoa";
  if (a.indexOf("MARCADO") >= 0) return "Avaliação marcada";
  if (a.indexOf("cancelada") >= 0) return "Cancelou a avaliação";
  if (a && a !== "não agendada") return "Pediu horário (equipe confirma)";
  if (b.duvida) return "Dúvida";
  return "Sem horário marcado";
}

function registrarContato(b) {
  var trava = LockService.getScriptLock();
  trava.waitLock(20000);
  try {
    var aba = planilha();
    var tel = String(b.telefone).replace(/\D/g, "");
    var link = "https://wa.me/" + tel;
    var dados = aba.getDataRange().getValues();
    var linha = -1;
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][3]).indexOf(tel) >= 0) { linha = i + 1; break; }
    }
    var agora = new Date();
    var sit = situacao(b);
    if (linha < 0) {
      aba.appendRow([agora, agora, limpo(b.nome), link, limpo(b.procedimento), sit, limpo(b.avaliacao),
        limpo(b.cidade), limpo(b.idioma), limpo(b.duvida), ""]);
    } else {
      var r = aba.getRange(linha, 1, 1, 10).getValues()[0];
      var v = function (novo, velho) { var n = limpo(novo); return n ? n : velho; };
      aba.getRange(linha, 2, 1, 9).setValues([[agora, v(b.nome, r[2]), link, v(b.procedimento, r[4]), sit,
        b.evento === "cancelou" ? "" : v(b.avaliacao, r[6]), v(b.cidade, r[7]), v(b.idioma, r[8]), v(b.duvida, r[9])]]);
    }
    return { ok: true };
  } finally {
    trava.releaseLock();
  }
}

/** Qualquer evento bloqueia o horario, inclusive os de dia inteiro (ferias, feriado). */
function ocupados(cal, ini, fim) {
  return cal.getEvents(ini, fim).map(function (ev) {
    return { inicio: ev.getStartTime().toISOString(), fim: ev.getEndTime().toISOString() };
  });
}

function comWhatsApp(ev) {
  return String(ev.getDescription() || "").indexOf("wa.me/") >= 0;
}

function saida(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
