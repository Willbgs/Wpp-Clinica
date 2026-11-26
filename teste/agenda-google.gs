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

    return saida({ erro: "acao invalida" });
  } catch (err) {
    return saida({ erro: String(err) });
  }
}

/** Abrir a URL no navegador mostra que esta no ar. */
function doGet() {
  return saida({ ok: true, agenda: CalendarApp.getDefaultCalendar().getName(), versao: 2 });
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
