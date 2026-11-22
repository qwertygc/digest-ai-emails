/*
 * digest-lib.js — logique pure du digest (sans aucune API Thunderbird),
 * pour rester testable isolément. Chargé par background.js avant lui.
 * Même raisonnement que le script eml-digest.py : regroupement thématique
 * en un appel (extraits courts), puis synthèse par thématique (extraits
 * longs), lignes « à retenir » par message, mémoire des traitements.
 */

var EXTRACT_CHARS = 900;
var EXTRACT_CHARS_CLUSTER = 400;

/* ------------------------- texte & URLs ------------------------- */

function normalizeText(text) {
  return String(text || '')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(str) {
  return String(str)
    .replace(/&#(\d+);/g, function (m, code) {
      var n = parseInt(code, 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    })
    .replace(/&#x([0-9a-f]+);/gi, function (m, hex) {
      var n = parseInt(hex, 16);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'");
}

/* HTML -> texte : script/style ignorés, balises de bloc = sauts de ligne.
 * Volontairement sans DOMParser : cette logique est aussi testée hors
 * Thunderbird, et le HTML des newsletters se prête bien au nettoyage regex. */
function htmlToText(html) {
  var text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/blockquote|\/h[1-6])(\s[^>]*)?>/gi, '\n')
    .replace(/<(p|div|li|tr|blockquote|h[1-6])(\s[^>]*)?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  return decodeEntities(text);
}

/* Toutes les URL cliquables d'un fragment HTML (l'article d'origine d'une
 * newsletter vit souvent uniquement dans un href). */
function hrefsOf(html) {
  var out = [];
  var re = /<a\s[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  var m = re.exec(html);
  while (m) {
    var url = (m[1] || m[2] || '').trim();
    if (url) out.push(url);
    m = re.exec(html);
  }
  return out;
}

var URL_STOPWORDS = ['unsubscribe', 'unsub', 'preferences', 'mailto:',
  'list-manage', '/u/', 'tracking', 'web.archive.org'];

function isUsefulUrl(url) {
  var low = String(url || '').toLowerCase();
  if (low.indexOf('http://') !== 0 && low.indexOf('https://') !== 0) {
    return false; // liens relatifs : inutilisables hors du message
  }
  for (var i = 0; i < URL_STOPWORDS.length; i++) {
    if (low.indexOf(URL_STOPWORDS[i]) >= 0) return false;
  }
  return true;
}

function extractUrls(text) {
  var out = [];
  var re = /https?:\/\/[^\s<>"')\]]+/gi;
  var m = re.exec(text);
  while (m) {
    var url = m[0].replace(/[.,;]+$/, '');
    if (isUsefulUrl(url) && out.indexOf(url) < 0) out.push(url);
    m = re.exec(text);
  }
  return out;
}

function truncateChars(text, maxChars) {
  if (text.length <= maxChars) return text;
  var cut = text.slice(0, maxChars);
  var pos = cut.lastIndexOf(' ');
  if (pos > maxChars * 0.6) cut = cut.slice(0, pos);
  return cut.replace(/\s+$/, '') + '…';
}

/* Empreinte stable et courte (FNV-1a, deux passes pour 12 hex).
 * Sert d'identifiant de message côté LLM et de clé de mémoire. */
function shortId(str) {
  function fnv1a(seed, suffix) {
    var h = 0x811c9dc5;
    var s = seed + (suffix || '');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  }
  return fnv1a(str, '') + fnv1a(str, '|2').slice(0, 4);
}

/* ------------------------- extraction d'un message ------------------------- */

/* Récursif sur l'arbre de parties renvoyé par browser.messages.getFull :
 * on collecte text/plain et text/html, on ignore les pièces jointes
 * (corps non textuels). */
function walkParts(part, plains, htmls) {
  if (!part || typeof part !== 'object') return;
  var kids = part.parts || [];
  for (var i = 0; i < kids.length; i++) walkParts(kids[i], plains, htmls);
  var contentType = String(part.contentType || '').toLowerCase();
  var body = typeof part.body === 'string' ? part.body : '';
  if (!body) return;
  if (contentType === 'text/plain') plains.push(body);
  else if (contentType === 'text/html') htmls.push(body);
}

/* header : MessageHeader Thunderbird (subject, author, date).
 * full : arbre getFull. Renvoie l'objet de travail du digest, en-tête
 * normalisé + extraits courts/longs + première URL utile. Comme dans la
 * version Python : le texte conservé est le plus long entre le text/plain
 * et le HTML nettoyé (les newsletters ont souvent un plain minimal). */
function extractMessage(header, full) {
  var plains = [];
  var htmls = [];
  walkParts(full, plains, htmls);

  var plain = normalizeText(plains.filter(Boolean).join('\n\n'));
  var htmlText = normalizeText(htmls.filter(Boolean).map(htmlToText).join('\n\n'));
  var text = htmlText.length > plain.length ? htmlText : plain;

  /* URL candidates : celles du texte d'abord, puis les href du HTML */
  var urls = extractUrls(text);
  var allHrefs = [];
  for (var i = 0; i < htmls.length; i++) {
    var partHrefs = hrefsOf(htmls[i]);
    for (var j = 0; j < partHrefs.length; j++) {
      if (allHrefs.indexOf(partHrefs[j]) < 0) allHrefs.push(partHrefs[j]);
    }
  }
  for (var k = 0; k < allHrefs.length; k++) {
    if (isUsefulUrl(allHrefs[k]) && urls.indexOf(allHrefs[k]) < 0) {
      urls.push(allHrefs[k]);
    }
  }

  var author = String(header.author || '').trim();
  var m = author.match(/<([^>]+)>/);
  var addr = m ? m[1].trim() : author.replace(/^"/, '').replace(/"$/, '');
  var domain = addr.indexOf('@') > 0 ? addr.split('@').pop() : '';
  var senderName = author.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '');
  var dateMs = header.dateMs != null ? header.dateMs
    : (header.date != null ? header.date : null);
  var dateStr = dateMs ? new Date(dateMs).toLocaleDateString('fr-FR') : '';

  var words = text.split(/\s+/).filter(Boolean).length;
  var subject = String(header.subject || '(sans objet)').trim();
  subject = subject.replace(/^(re|fwd?|fw|tr)\s*:\s*/i, '');
  subject = subject.replace(/\s+/g, ' ') || '(sans objet)';

  return {
    id: shortId(subject + '|' + author + '|' + dateMs + '|' + text.slice(0, 4000)),
    subject: subject,
    senderName: senderName,
    sender: addr,
    domain: domain,
    dateMs: dateMs,
    dateStr: dateStr,
    readingTime: words ? Math.max(1, Math.round(words / 200)) : 0,
    url: urls.length ? urls[0] : '',
    extract: text ? truncateChars(text, EXTRACT_CHARS) : '',
    extractShort: text ? truncateChars(text, EXTRACT_CHARS_CLUSTER) : '',
    hasText: !!text
  };
}

/* Bloc envoyé au LLM : [id] « objet » — expéditeur, date + extrait. */
function buildBlock(message, short) {
  var source = message.domain || message.sender || 'source inconnue';
  var head = '[' + message.id + '] « ' + message.subject + ' » — ' + source;
  if (message.dateStr) head += ', ' + message.dateStr;
  var extract = short ? message.extractShort : message.extract;
  return head + '\n' +
    (extract || "(texte indisponible, se fier à l'objet et à l'expéditeur)");
}

/* ------------------------- prompts (mêmes que le script Python) ------------------------- */

function clusterPrompt(messages, watchTopics) {
  var listing = messages.map(function (m) { return buildBlock(m, true); }).join('\n\n');
  var watchBlock = '';
  if (watchTopics.length) {
    watchBlock =
      "Thématiques de veille prioritaires : " + watchTopics.join(' ; ') + ".\n" +
      "- crée un groupe avec EXACTEMENT cet intitulé dès qu'au moins un " +
      "message s'y rattache de près ou de loin (même un seul) ;\n" +
      "- n'invente jamais de contenu : un intitulé sans message " +
      "correspondant ne doit PAS apparaître dans la réponse ;\n" +
      "- les messages restants sont regroupés dans des thématiques libres.\n\n";
  }
  return {
    system: "Tu es un assistant de veille médiatique. On te fournit une liste de " +
      "messages de veille identifiés par un identifiant alphanumérique entre " +
      "crochets. Ta seule tâche est le regroupement thématique. Réponds " +
      "uniquement en JSON valide, sans texte autour.",
    user: "Regroupe les messages suivants par thématique. Les messages qui parlent " +
      "du même sujet, événement, dossier ou secteur = même groupe.\n" +
      "Règles :\n" + watchBlock +
      "- vise entre 2 et 8 groupes, selon la diversité réelle des sujets ;\n" +
      "- chaque identifiant doit apparaître exactement une fois dans toute la " +
      "réponse, aucun oubli, aucun doublon ;\n" +
      "- les messages isolés sans vraie thématique commune vont dans un groupe " +
      "\"Divers\" ;\n" +
      "- le nom du groupe (champ \"theme\") est court et informatif, en français " +
      "(3 à 6 mots, ex. \"Guerre commerciale entre les États-Unis et l'UE\").\n\n" +
      "Format de réponse exact :\n" +
      '{"groups": [{"theme": "…", "article_ids": ["ab12cd34ef"]}, ' +
      '{"theme": "Divers", "article_ids": ["99aa88bb77"]}]}\n\n' +
      "Messages :\n" + listing
  };
}

function clusterFixPrompt(missingIds, messages) {
  return "Ta réponse précédente a oublié ces identifiants : " + missingIds.join(', ') +
    ". Reliste la liste de messages, renvoie TOUS les groupes (y compris ceux déjà " +
    "corrects) avec chaque identifiant exactement une fois, au même format JSON. " +
    "Messages :\n" +
    messages.map(function (m) { return buildBlock(m, true); }).join('\n\n');
}

function summaryPrompt(theme, messages) {
  var listing = messages.map(buildBlock).join('\n\n');
  return {
    system: "Tu es un journaliste de presse qui prépare une revue de veille en " +
      "français, précise, factuelle et sans langue de bois. Réponds " +
      "uniquement en JSON valide, sans texte autour.",
    user:
      "Voici " + messages.length + " messages de veille en lien avec la thématique « " +
      theme + " ».\n\n" +
      "1) Rédige (champ \"synthese\") un résumé en UN SEUL paragraphe (5 à 8 " +
      "phrases, pas de listes, pas de titre, pas de mise en forme) qui donne " +
      "les faits clés, signale les angles ou nuances entre sources en les " +
      "citant naturellement (ex. « selon le CNRS… »), et reste fidèle aux " +
      "extraits : n'invente rien.\n" +
      "2) Pour CHAQUE message (champ \"points\"), écris \"ligne\" : une seule " +
      "phrase de 8 à 14 mots, en français, qui résume l'apport propre de ce " +
      "message (pas un doublon de son objet). Reprends l'identifiant exact " +
      "entre crochets.\n\n" +
      "Format de réponse exact :\n" +
      '{"synthese": "…", "points": [{"id": "ab12cd34ef", "ligne": "…"}]}\n\n' +
      "Messages :\n" + listing
  };
}

/* ------------------------- réponses LLM ------------------------- */

/* JSON strict, puis repli : premier objet {...} équilibré si la réponse
 * est entourée de prose ou d'un bloc ```json. */
function parseLlmJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) { /* on passe au repli */ }
  var depth = 0, start = -1;
  for (var i = 0; i < raw.length; i++) {
    var ch = raw[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch (e) {
          start = -1;
        }
      }
    }
  }
  return null;
}

/* Clustering : groupes non vides, identifiants connus, aucun doublon.
 * Repli global : tout dans « Divers ». */
function parseGroups(raw, validIds) {
  var data = parseLlmJson(raw);
  if (!data || !Array.isArray(data.groups) || !data.groups.length) {
    return null; // l'appelant affiche l'avertissement et part sur Divers
  }
  var valid = new Set(validIds);
  var groups = [], seen = new Set();
  for (var i = 0; i < data.groups.length; i++) {
    var g = data.groups[i];
    if (!g || typeof g !== 'object') continue;
    var ids = [];
    var rawIds = Array.isArray(g.article_ids) ? g.article_ids : [];
    for (var j = 0; j < rawIds.length; j++) {
      var id = String(rawIds[j]);
      if (valid.has(id) && !seen.has(id)) {
        ids.push(id);
        seen.add(id);
      }
    }
    var theme = String(g.theme || '').trim() || 'Divers';
    if (ids.length) groups.push({ theme: theme, article_ids: ids });
  }
  return groups.length ? groups
    : [{ theme: 'Divers', article_ids: validIds.slice() }];
}

function missingIds(groups, messages) {
  var classified = new Set();
  groups.forEach(function (g) {
    g.article_ids.forEach(function (id) { classified.add(id); });
  });
  return messages.filter(function (m) { return !classified.has(m.id); })
    .map(function (m) { return m.id; });
}

/* Synthèse : {'synthese': str, 'points': {id: ligne}} ; null si illisible. */
function parseSummary(raw) {
  var data = parseLlmJson(raw);
  if (data && typeof data.synthese === 'string' && data.synthese.trim()) {
    var points = {};
    var list = Array.isArray(data.points) ? data.points : [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p && typeof p === 'object' && p.id && typeof p.ligne === 'string'
        && p.ligne.trim()) {
        points[String(p.id)] = p.ligne.trim();
      }
    }
    return { synthese: data.synthese.trim(), points: points };
  }
  return null;
}

/* ------------------------- tri & rendu ------------------------- */

function watchRank(theme, watchTopics) {
  var t = String(theme).trim().toLowerCase();
  for (var i = 0; i < watchTopics.length; i++) {
    var low = String(watchTopics[i]).trim().toLowerCase();
    if (low && (t === low || t.indexOf(low) >= 0 || low.indexOf(t) >= 0)) {
      return i;
    }
  }
  return watchTopics.length;
}

/* Veille d'abord (ordre des thèmes donnés), puis les groupes les plus fournis. */
function sortDigest(digest, watchTopics) {
  return digest.slice().sort(function (a, b) {
    var ra = watchRank(a.theme, watchTopics);
    var rb = watchRank(b.theme, watchTopics);
    if (ra !== rb) return ra - rb;
    return b.messages.length - a.messages.length;
  });
}

function sumReadingTime(messages) {
  return messages.reduce(function (sum, m) { return sum + (m.readingTime || 0); }, 0);
}

function formatReadingTime(minutes) {
  if (!minutes) return '';
  if (minutes < 60) return minutes + ' min';
  var h = Math.floor(minutes / 60);
  var rest = minutes % 60;
  return h + ' h' + (rest ? ' ' + ('0' + rest).slice(-2) : '');
}

/* Page complète de la revue. CSS intégré (pas de CDN : les pages d'extension
 * sont consultables hors ligne et le CSP est plus serein ainsi).
 * meta : {title, model, total} ; opts : {sectionsOpen, watchTopics}. */
var DIGEST_CSS = [
  'body{margin:0 auto;max-width:760px;padding:0 1rem 2rem;',
  'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
  'color:#202020;line-height:1.55;background:#fdfdfd}',
  'h1{font-size:1.5rem;margin:.3rem 0}header{border-bottom:1px solid #ddd;padding-top:1.5rem}',
  'p.kicker{letter-spacing:.14em;text-transform:uppercase;font-size:.75rem;',
  'color:#777;margin:0 0 .2rem}p.meta{color:#777;font-size:.85rem;margin:.4rem 0 0}',
  'details.theme{margin:1.1rem 0;border:1px solid #ddd;border-radius:8px;padding:0 .9rem;background:#fff}',
  'details.theme summary{cursor:pointer;padding:.7rem 0;font-weight:600}',
  'details.theme summary .num{font-weight:400;color:#999;font-size:.9rem}',
  'details.theme summary .count{font-size:.72rem;font-weight:400;color:#888;',
  'border:1px solid #ddd;border-radius:99px;padding:.1rem .55rem;white-space:nowrap}',
  'p.summary{margin:.2rem 0 .6rem}',
  'details.theme ul{list-style:none;margin:.3rem 0 .9rem;padding:0}',
  'details.theme li{border-top:1px solid #eee;padding:.5rem 0 .55rem}',
  'details.theme a{color:#0b6bcc;text-decoration:none}',
  'details.theme a:hover{text-decoration:underline}',
  '.point{display:block;color:#777;font-style:italic;font-size:.92rem}',
  '.src{color:#999;font-size:.82rem}',
  '.pin{color:#0b6bcc}',
  '.nolink{color:#202020}',
  'footer{border-top:1px solid #ddd;margin-top:2rem;padding:.8rem 0;',
  'color:#999;font-size:.8rem}'
].join('');

function num(n) {
  return new Intl.NumberFormat('fr-FR').format(n);
}

function renderDigestHtml(digest, meta, opts) {
  opts = opts || {};
  var watchKey = opts.watchTopics || [];
  var now = new Date();
  var today = now.toLocaleDateString('fr-FR');
  var clock = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  var allTime = formatReadingTime(digest.reduce(function (s, g) {
    return s + sumReadingTime(g.messages);
  }, 0));
  var title = escHtml(meta.title || 'Revue de veille') + ' — ' + today;
  var metaLine = escHtml(meta.total + ' message' + (meta.total > 1 ? 's' : '') +
    ' · ' + digest.length + ' thématique' + (digest.length > 1 ? 's' : '') +
    (allTime ? ' · ' + allTime + ' de lecture' : '') +
    ' — Mistral (' + meta.model + '), généré le ' + today + ' à ' + clock);

  var sections = digest.map(function (group, n) {
    var isWatch = watchRank(group.theme, watchKey) < watchKey.length;
    var pin = isWatch ? '<span class="pin" title="Thématique de veille">★</span> ' : '';
    var themeTime = formatReadingTime(sumReadingTime(group.messages));
    var count = group.messages.length;
    var badge = escHtml(count + ' message' + (count > 1 ? 's' : '') +
      (themeTime ? ' · ' + themeTime : ''));
    var rows = group.messages.map(function (m) {
      var metas = [m.domain, m.dateStr,
        m.readingTime ? m.readingTime + ' min' : ''].filter(Boolean);
      var item = m.url
        ? '<a href="' + escHtml(m.url) + '" title="Source : ' + escHtml(m.url) + '">' +
          escHtml(m.subject) + '</a>'
        : '<span class="nolink">' + escHtml(m.subject) + '</span>';
      if (metas.length) {
        item += ' <span class="src">' + metas.map(escHtml).join(' · ') + '</span>';
      }
      var point = group.points[m.id];
      if (point) item += '<span class="point">' + escHtml(point) + '</span>';
      return '        <li>' + item + '</li>';
    }).join('\n');
    return '      <details class="theme"' + (opts.sectionsOpen ? ' open' : '') + '>\n' +
      '        <summary><span class="num">' + (n + 1) + '.</span> ' + pin +
      escHtml(group.theme) + ' <span class="count">' + badge + '</span></summary>\n' +
      '        <p class="summary">' + escHtml(group.summary) + '</p>\n' +
      '        <ul>\n' + rows + '\n        </ul>\n' +
      '      </details>';
  }).join('\n');

  return '<!DOCTYPE html>\n<html lang="fr">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<base target="_blank">\n' +
    '<title>' + title + '</title>\n' +
    '<style>' + DIGEST_CSS + '</style>\n' +
    '</head>\n<body>\n<header>\n' +
    '  <p class="kicker">' + title + '</p>\n' +
    '  <h1>' + escHtml(meta.title || 'Revue de veille') + '</h1>\n' +
    '  <p class="meta">' + metaLine + '</p>\n' +
    '</header>\n<main>\n' + sections + '\n</main>\n' +
    '<footer>Digest produit par l\'extension « Digest IA » (Thunderbird + Mistral).' +
    ' Les résumés sont générés par IA : vérifiez les messages sources avant de citer.\n' +
    '</footer>\n</body>\n</html>\n';
}

function escHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
