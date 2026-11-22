/*
 * background.js — orchestration : réception du dossier depuis le popup,
 * lecture des messages (getFull), appels Mistral (clustering puis
 * synthèses en parallèle), mémoire des traitements dans storage.local,
 * rendu HTML stocké puis ouvert dans un onglet Thunderbird.
 *
 * Le popup peut être refermé pendant le traitement : tout vit ici.
 */

/* Monde des messages : si le LLM renvoie un identifiant inconnu (hallucination
 * légère), on l'ignore ; les messages oubliés tombent dans « Divers ». */

var RUN_STATE = { running: false };
var CONCURRENCY = 4;

/* ------------------------- réglages ------------------------- */

var DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'mistral-small-latest',
  limit: 40,
  watch: '',            // thèmes séparés par des virgules
  unreadOnly: false,
  sectionsOpen: false,
  cacheDays: 30,
  title: 'Revue de veille'
};

async function getSettings() {
  var stored = await browser.storage.local.get('settings');
  var s = Object.assign({}, DEFAULT_SETTINGS, stored.settings || {});
  s.watchTopics = String(s.watch || '')
    .split(',')
    .map(function (t) { return t.trim(); })
    .filter(Boolean);
  s.limit = Math.max(1, Math.min(200, parseInt(s.limit, 10) || 40));
  s.cacheDays = Math.max(0, parseInt(s.cacheDays, 10) || 0);
  return s;
}

/* ------------------------- petit utilitaires ------------------------- */

function log() {
  console.log('[digest]', Array.prototype.slice.call(arguments).join(' '));
}

/* Progression : à la fois dans la console (run sans popup) et vers le
 * popup s'il écoute. */
var currentPort = null;
function progress(text) {
  log(text);
  if (currentPort) {
    currentPort.postMessage({ type: 'progress', text: text });
  }
}
function progressDone(ok, text) {
  if (currentPort) {
    currentPort.postMessage({ type: ok ? 'done' : 'error', text: text });
    currentPort = null;
  }
}

/* Empreinte de corpus : la liste d'identifiants + veille + taille d'extrait. */
function clusterFingerprint(messages, settings) {
  var ids = messages.map(function (m) { return m.id; }).sort();
  return shortId(ids.join('-') + '|w=' +
    settings.watchTopics.map(function (t) { return t.toLowerCase(); }).join(';') +
    '|c=' + EXTRACT_CHARS_CLUSTER);
}

/* Empreinte d'un groupe : intitulé + identifiants + modèle + extrait long. */
function groupFingerprint(theme, messages, settings) {
  var ids = messages.map(function (m) { return m.id; }).sort();
  return shortId(theme.toLowerCase() + '|' + ids.join('-') +
    '|m=' + settings.model + '|e=' + EXTRACT_CHARS);
}

/* ------------------------- Mistral ------------------------- */

var TOKEN_USAGE = { calls: 0, prompt: 0, completion: 0 };

async function mistralChat(messages, jsonMode, apiKey, model) {
  var payload = {
    model: model,
    messages: messages,
    temperature: jsonMode ? 0.1 : 0.4
  };
  if (jsonMode) payload.response_format = { type: 'json_object' };

  var maxAttempts = 3;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    var response;
    try {
      response = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      if (attempt < maxAttempts) {
        await sleep(3000 * attempt);
        continue;
      }
      throw new Error('Réseau indisponible vers api.mistral.ai : ' + err);
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt < maxAttempts) {
        await sleep(5000 * attempt);
        continue;
      }
      throw new Error('API Mistral : HTTP ' + response.status);
    }
    if (!response.ok) {
      var body = await response.text();
      throw new Error('API Mistral (HTTP ' + response.status + ') : ' +
        body.slice(0, 300));
    }
    var data = await response.json();
    if (data.usage) {
      TOKEN_USAGE.calls++;
      TOKEN_USAGE.prompt += data.usage.prompt_tokens || 0;
      TOKEN_USAGE.completion += data.usage.completion_tokens || 0;
    }
    if (data.choices && data.choices[0] &&
        data.choices[0].finish_reason === 'length') {
      progress('Avertissement : réponse Mistral tronquée (finish_reason=length).');
    }
    var content = (data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content) || '';
    return content.trim();
  }
  throw new Error('API Mistral : nombre de tentatives épuisé.');
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* ------------------------- étapes ------------------------- */

/* Liste les en-têtes d'un dossier (optionnellement non lus seulement),
 * triés par date décroissante, plafonnés au limite. */
async function listHeaders(folder, limit, unreadOnly) {
  var page = await browser.messages.list(folder);
  var headers = page.messages ? page.messages.slice() : [];
  while (page.id) {
    page = await browser.messages.continueList(page.id);
    if (!page.messages) break;
    headers = headers.concat(page.messages);
  }
  if (unreadOnly) {
    headers = headers.filter(function (h) { return !h.read; });
  }
  headers = headers.filter(function (h) { return !h.junk && !h.junkScore });
  headers.sort(function (a, b) {
    var da = a.dateMs != null ? a.dateMs : a.date;
    var db = b.dateMs != null ? b.dateMs : b.date;
    return db - da;
  });
  return headers.slice(0, limit);
}

/* Corps des messages en parallèle (petit pool pour rester courtois).
 * Renvoie des messages {header, message} ; les échecs sont écartés. */
async function loadMessages(headers, from, to) {
  var slice = headers.slice(from, to);
  var out = [];
  var processed = 0;
  for (var i = 0; i < slice.length; i += CONCURRENCY) {
    var batch = slice.slice(i, i + CONCURRENCY);
    processed += batch.length;
    var loaded = await Promise.all(batch.map(async function (h) {
      try {
        var full = await browser.messages.getFull(h.id);
        return extractMessage(h, full || {});
      } catch (err) {
        log('message illisible', h && h.subject, err && err.message);
        return null;
      }
    }));
    loaded.forEach(function (m) { if (m) out.push(m); });
    progress('Lecture des messages… ' + processed + ' / ' + to);
  }
  return out;
}

/* Regroupement : prompt principal, puis une seule relance de correction
 * si des identifiants manquent. Repli « Divers » si réponse illisible. */
async function clusterMessages(messages, settings) {
  var prompts = clusterPrompt(messages, settings.watchTopics);
  var raw = await mistralChat([
    { role: 'system', content: prompts.system },
    { role: 'user', content: prompts.user }
  ], true, settings.apiKey, settings.model);

  var groups = parseGroups(raw, messages.map(function (m) { return m.id; }));
  var missing = missingIds(groups, messages);

  if (missing.length) {
    progress('Relance du regroupement (identifiants oubliés : ' +
      missing.length + ')…');
    var fix = clusterFixPrompt(missing, messages);
    raw = await mistralChat([
      { role: 'system', content: prompts.system },
      { role: 'user', content: prompts.user },
      { role: 'assistant', content: raw },
      { role: 'user', content: fix }
    ], true, settings.apiKey, settings.model);
    groups = parseGroups(raw, messages.map(function (m) { return m.id; })) || groups;
    missing = missingIds(groups, messages);
    if (missing.length) {
      progress('Avertissement : ' + missing.length +
        ' message(s) non classés, mis dans « Divers ».');
      groups.push({ theme: 'Divers', article_ids: missing });
    }
  }
  return groups;
}

/* Synthèse pour une thématique : 'synthese' + ligne 'à retenir' par message. */
async function summarizeGroup(theme, messages, settings) {
  var prompts = summaryPrompt(theme, messages);
  var raw = await mistralChat([
    { role: 'system', content: prompts.system },
    { role: 'user', content: prompts.user }
  ], true, settings.apiKey, settings.model);
  var result = parseSummary(raw);
  if (!result) {
    /* Synthèse textuelle de repli : la réponse brute comme paragraphe. */
    progress('Avertissement : synthèse illisible pour « ' + theme +
      '», texte brut conservé.');
    result = { synthese: raw, points: {} };
  }
  return result;
}

/* ------------------------- mémoire des traitements ------------------------- */

/* Shape du cache : {cluster: {fingerprint: {ts, value}},
 * summarize: {fingerprint: {ts, value}}} — TTL jours, cap 200/section. */

async function loadCache(days) {
  var stored = await browser.storage.local.get('digestCache');
  var cache = stored.digestCache;
  if (!cache || typeof cache !== 'object') {
    cache = { cluster: {}, summarize: {} };
  }
  return cache;
}

function entryFresh(entry, ttlMs) {
  return ttlMs <= 0 || (Date.now() - (entry.ts || 0)) <= ttlMs;
}

async function saveCache(cache) {
  var settings = await getSettings();
  var ttlMs = settings.cacheDays * 86400000;
  ['cluster', 'summarize'].forEach(function (section) {
    var entries = {};
    var keys = Object.keys(cache[section] || {});
    keys.forEach(function (k) {
      var e = cache[section][k];
      if (e && e.value && entryFresh(e, ttlMs)) entries[k] = e;
    });
    var sorted = Object.keys(entries).sort(function (a, b) {
      return (entries[b].ts || 0) - (entries[a].ts || 0);
    });
    if (sorted.length > 200) {
      var capped = {};
      sorted.slice(0, 200).forEach(function (k) { capped[k] = entries[k]; });
      entries = capped;
    }
    cache[section] = entries;
  });
  await browser.storage.local.set({ digestCache: cache });
}

/* ------------------------- pipeline principal ------------------------- */

async function runDigest(folder) {
  if (RUN_STATE.running) {
    throw new Error('Un digest est déjà en cours d\'exécution.');
  }
  RUN_STATE.running = true;
  TOKEN_USAGE = { calls: 0, prompt: 0, completion: 0 };
  try {
    var settings = await getSettings();
    if (!settings.apiKey) {
      throw new Error('Aucune clé API Mistral configurée (Options de l\'extension).');
    }

    var folderName = folder.name || folder.path || 'dossier';
    progress('Dossier : ' + folderName);

    /* 1. En-têtes */
    var headers = await listHeaders(folder, settings.limit, settings.unreadOnly);
    if (!headers.length) {
      throw new Error('Aucun message' +
        (settings.unreadOnly ? ' non lu' : '') + ' dans ce dossier.');
    }
    progress(headers.length + ' message(s) retenu(s).');

    /* 2. Corps + extraction */
    var messages = await loadMessages(headers, 0, headers.length);
    var withText = messages.filter(function (m) { return m.hasText; }).length;
    progress(messages.length + ' message(s) lu(s) (' + withText +
      ' avec texte exploitable).');
    if (!messages.length) {
      throw new Error('Aucun message n\'a pu être lu dans ce dossier.');
    }

    /* 3. Regroupement (ou mémoire) */
    var cache = await loadCache();
    var cKey = clusterFingerprint(messages, settings);
    var groups;
    var cachedCluster = cache.cluster[cKey];
    if (cachedCluster && entryFresh(cachedCluster, TTLDaysMs(settings))) {
      groups = cachedCluster.value;
      progress('Regroupement repris de la mémoire (' + groups.length +
        ' thématiques, 0 token).');
    } else {
      progress('Regroupement thématique via Mistral…');
      groups = await clusterMessages(messages, settings);
      progress(groups.length + ' thématique(s) détectée(s).');
      cache.cluster[cKey] = { ts: Date.now(), value: groups };
      await saveCache(cache);
    }

    /* 4. Synthèses par thématique : mémoire d'abord, le reste en parallèle */
    var digest = [];
    var reused = 0;
    var toSummarize = [];
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      var groupMessages = group.article_ids.map(function (id) {
        return messages.find(function (m) { return m.id === id; });
      }).filter(Boolean);
      if (!groupMessages.length) continue;

      var gKey = groupFingerprint(group.theme, groupMessages, settings);
      var cachedSummary = cache.summarize[gKey];
      if (cachedSummary && entryFresh(cachedSummary, TTLDaysMs(settings))) {
        digest.push({
          theme: group.theme,
          summary: cachedSummary.value.synthese,
          points: cachedSummary.value.points,
          messages: groupMessages
        });
        reused++;
        progress('[' + (i + 1) + '/' + groups.length + '] « ' + group.theme +
          ' » : repris de la mémoire.');
      } else {
        toSummarize.push({ group: group, messages: groupMessages, key: gKey });
      }
    }
    if (toSummarize.length) {
      progress('Synthèse de ' + toSummarize.length + ' thématique(s)…');
      var index = 0;
      async function worker() {
        while (index < toSummarize.length) {
          var job = toSummarize[index++];
          try {
            var result = await summarizeGroup(job.group.theme, job.messages, settings);
            cache.summarize[job.key] = { ts: Date.now(), value: result };
            digest.push({
              theme: job.group.theme,
              summary: result.synthese,
              points: result.points,
              messages: job.messages
            });
          } catch (err) {
            progress('Échec de synthèse pour « ' + job.group.theme + ' » : ' +
              ((err && err.message) || err));
          }
        }
      }
      var workers = [];
      for (var w = 0; w < Math.min(CONCURRENCY, toSummarize.length); w++) {
        workers.push(worker());
      }
      await Promise.all(workers);
      await saveCache(cache);
    }

    /* 5. Rendu + stockage + ouverture */
    digest = sortDigest(digest, settings.watchTopics);
    var html = renderDigestHtml(digest, {
      title: settings.title,
      model: settings.model,
      total: messages.length
    }, {
      sectionsOpen: settings.sectionsOpen,
      watchTopics: settings.watchTopics
    });
    await browser.storage.local.set({ lastDigest: html });
    await browser.tabs.create({ url: 'digest.html' });

    var tokenMsg = TOKEN_USAGE.calls
      ? 'Consommation Mistral : ' + TOKEN_USAGE.calls + ' appel(s), ' +
        num(TOKEN_USAGE.prompt + TOKEN_USAGE.completion) + ' tokens au total.'
      : 'Aucun token consommé (mémoire).';
    if (reused) {
      tokenMsg = ' ' + reused + ' thématique(s) reprise(s) de la mémoire. ' + tokenMsg;
    }
    progress('Digest prêt. ' + tokenMsg);
    progressDone(true, tokenMsg);
    return tokenMsg;
  } catch (err) {
    var msg = (err && err.message) || String(err);
    progress('Erreur : ' + msg);
    progressDone(false, msg);
  } finally {
    RUN_STATE.running = false;
  }
}

/* TTLDaysMs : indépendant pour rester lisible. */
function TTLDaysMs(settings) {
  return settings.cacheDays * 86400000;
}

/* ------------------------- connexion au popup ------------------------- */

browser.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'digest') return;
  currentPort = port;
  port.onMessage.addListener(async function (msg) {
    if (msg && msg.type === 'run' && msg.folder) {
      await runDigest(msg.folder);
    }
  });
  port.onDisconnect.addListener(function () {
    if (currentPort === port) currentPort = null;
  });
});

/* Commande depuis la page digest : relancer sur le dernier dossier ? Simple
 * garde-fou : le popup reste la porte d'entrée (il connaît les dossiers). */
log('extension chargée, prête à recevoir un dossier.');
