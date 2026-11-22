/*
 * background.js — orchestration : réception du dossier depuis le popup,
 * lecture des messages (getFull), appels au LLM choisi (clustering puis
 * synthèses en parallèle), mémoire des traitements dans storage.local,
 * rendu HTML stocké puis ouvert dans un onglet Thunderbird.
 *
 * Le popup peut être refermé pendant le traitement : tout vit ici.
 */

/* Monde des messages : si le LLM renvoie un identifiant inconnu (hallucination
 * légère), on l'ignore ; les messages oubliés tombent dans « Divers ». */

var RUN_STATE = { running: false };
var CONCURRENCY = 4;

/* ------------------------- fournisseurs LLM ------------------------- */

/* Chaque fournisseur définit un point d'accès et un modèle par défaut.
 * « custom » désigne n'importe quel service compatible OpenAI
 * (OpenRouter, Groq, llama.cpp, LM Studio, vLLM, Ollama, etc.). */
var PROVIDERS = {
  mistral: {
    label: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest'
  },
  openai: {
    label: 'OpenAI (ChatGPT)',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5'
  },
  gemini: {
    label: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash'
  },
  custom: {
    label: 'Autre (compatible OpenAI)',
    baseUrl: '',
    model: ''
  }
};

/* ------------------------- réglages ------------------------- */

var DEFAULT_SETTINGS = {
  provider: 'mistral',
  baseUrl: '',
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
  if (!PROVIDERS[s.provider]) s.provider = 'mistral';
  /* Point d'accès : valeur de l'utilisateur si renseignée, sinon celui
   * du fournisseur. Obligatoire pour « custom ». */
  s.baseUrl = String(s.baseUrl || '').trim() ||
    (PROVIDERS[s.provider].baseUrl || '');
  s.baseUrl = s.baseUrl.replace(/\/+$/, '');
  s.model = String(s.model || '').trim() || PROVIDERS[s.provider].model;
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

/* Empreinte d'un groupe : intitulé + identifiants + fournisseur + modèle +
 * extrait long. Changer de LLM invalide la mémoire, c'est voulu. */
function groupFingerprint(theme, messages, settings) {
  var ids = messages.map(function (m) { return m.id; }).sort();
  return shortId(theme.toLowerCase() + '|' + ids.join('-') +
    '|p=' + settings.provider + '|m=' + settings.model + '|e=' + EXTRACT_CHARS);
}

/* ------------------------- appels LLM (agnostiques) ------------------------- */

var TOKEN_USAGE = { calls: 0, prompt: 0, completion: 0 };

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* Découpe les tours {role, content} en (system, tours sans system). */
function splitTurns(turns) {
  var system = '';
  var rest = [];
  turns.forEach(function (t) {
    if (t.role === 'system') {
      system += t.content + '\n';
    } else {
      rest.push(t);
    }
  });
  return { system: system.trim(), turns: rest };
}

/* Construit la requête et l'analyseur de réponse propres au fournisseur.
 * Renvoie des fonctions pures : testables hors Thunderbird. */
function llmAdapter(provider, settings, turns, jsonMode) {
  var t = splitTurns(turns);
  var temp = jsonMode ? 0.1 : 0.4;
  if (provider === 'anthropic') {
    return {
      url: settings.baseUrl + '/v1/messages',
      headers: {
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      payload: {
        model: settings.model,
        max_tokens: 4096,
        system: t.system,
        messages: t.turns,
        temperature: temp
      },
      parse: function (data) {
        var blocks = data.content || [];
        var text = blocks.map(function (b) { return b.text || ''; }).join('');
        return {
          content: text.trim(),
          truncated: data.stop_reason === 'max_tokens',
          prompt: (data.usage && data.usage.input_tokens) || 0,
          completion: (data.usage && data.usage.output_tokens) || 0
        };
      }
    };
  }
  if (provider === 'gemini') {
    var genConfig = { temperature: temp };
    if (jsonMode) genConfig.responseMimeType = 'application/json';
    return {
      url: settings.baseUrl + '/models/' +
        encodeURIComponent(settings.model) + ':generateContent',
      headers: {
        'x-goog-api-key': settings.apiKey,
        'Content-Type': 'application/json'
      },
      payload: {
        systemInstruction: t.system ? { parts: [{ text: t.system }] } : undefined,
        contents: t.turns.map(function (m) {
          return {
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          };
        }),
        generationConfig: genConfig
      },
      parse: function (data) {
        var cand = (data.candidates || [])[0] || {};
        var parts = (cand.content && cand.content.parts) || [];
        var text = parts.map(function (p) { return p.text || ''; }).join('');
        var u = data.usageMetadata || {};
        return {
          content: text.trim(),
          truncated: cand.finishReason === 'MAX_TOKENS',
          prompt: u.promptTokenCount || 0,
          completion: u.candidatesTokenCount || 0
        };
      }
    };
  }
  /* mistral, openai, custom : API chat/completions. */
  var payload = {
    model: settings.model,
    messages: turns,
    temperature: temp
  };
  if (jsonMode && provider !== 'custom') {
    payload.response_format = { type: 'json_object' };
  }
  var spec = {
    url: settings.baseUrl + '/chat/completions',
    headers: {
      'Authorization': 'Bearer ' + settings.apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    payload: payload,
    parse: function (data) {
      var choice = (data.choices || [])[0] || {};
      var text = (choice.message && choice.message.content) || '';
      var u = data.usage || {};
      return {
        content: String(text).trim(),
        truncated: choice.finish_reason === 'length',
        prompt: u.prompt_tokens || 0,
        completion: u.completion_tokens || 0
      };
    }
  };
  /* Le mode JSON strict n'est pas supporté partout : si le serveur le
   * refuse (HTTP 400), on retente une fois sans response_format ; les
   * prompts exigent de toute façon une réponse JSON. */
  spec.jsonStrict = !!(jsonMode && provider !== 'custom');
  return spec;
}

/* Appel générique : réessais avec temporisation sur 429/5xx/réseau,
 * repli sans response_format si nécessaire. Compte les tokens. */
async function callLlm(turns, jsonMode, settings) {
  var provider = settings.provider;
  var label = PROVIDERS[provider].label;
  if (!settings.apiKey) throw new Error('Clé API absente (Options).');
  if (!settings.baseUrl) {
    throw new Error('Point d\'accès (URL de base) manquant pour « ' + label + ' ».');
  }

  var maxAttempts = 3;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    var spec = llmAdapter(provider, settings, turns, jsonMode);
    var response;
    try {
      response = await fetch(spec.url, {
        method: 'POST',
        headers: spec.headers,
        body: JSON.stringify(spec.payload)
      });
    } catch (err) {
      if (attempt < maxAttempts) { await sleep(3000 * attempt); continue; }
      throw new Error('Réseau indisponible vers ' + settings.baseUrl + ' : ' + err);
    }
    if (response.status === 400 && spec.jsonStrict) {
      /* Ce serveur refuse response_format : une tentative sans, les
       * prompts exigent de toute façon une réponse JSON. */
      try {
        var bare = await fetch(spec.url, {
          method: 'POST',
          headers: spec.headers,
          body: JSON.stringify({
            model: spec.payload.model,
            messages: spec.payload.messages,
            temperature: spec.payload.temperature
          })
        });
        if (bare.ok) {
          var bareData = await bare.json();
          return llmResult(spec, bareData);
        }
        response = bare;
      } catch (err2) { /* on retombe sur la logique ci-dessous */ }
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt < maxAttempts) { await sleep(5000 * attempt); continue; }
      throw new Error(label + ' : HTTP ' + response.status);
    }
    if (!response.ok) {
      var body = await response.text();
      throw new Error(label + ' (HTTP ' + response.status + ') : ' +
        body.slice(0, 300));
    }
    var data2 = await response.json();
    return llmResult(spec, data2);
  }
  throw new Error(label + ' : nombre de tentatives épuisé.');
}

function llmResult(spec, data) {
  var r = spec.parse(data);
  if (data && r.prompt === 0 && r.completion === 0 && data.usage) {
    /* formes exotiques éventuelles */
    r.prompt = data.usage.prompt_tokens || r.prompt;
    r.completion = data.usage.completion_tokens || r.completion;
  }
  if (r.prompt || r.completion) {
    TOKEN_USAGE.calls++;
    TOKEN_USAGE.prompt += r.prompt;
    TOKEN_USAGE.completion += r.completion;
  }
  if (r.truncated) {
    progress('Avertissement : réponse du LLM tronquée (limite de tokens).');
  }
  return r.content;
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
 * Les messages illisibles sont écartés silencieusement. */
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
  var raw = await callLlm([
    { role: 'system', content: prompts.system },
    { role: 'user', content: prompts.user }
  ], true, settings);

  var groups = parseGroups(raw, messages.map(function (m) { return m.id; }));
  var missing = missingIds(groups, messages);

  if (missing.length) {
    progress('Relance du regroupement (identifiants oubliés : ' +
      missing.length + ')…');
    var fix = clusterFixPrompt(missing, messages);
    raw = await callLlm([
      { role: 'system', content: prompts.system },
      { role: 'user', content: prompts.user },
      { role: 'assistant', content: raw },
      { role: 'user', content: fix }
    ], true, settings);
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
  var raw = await callLlm([
    { role: 'system', content: prompts.system },
    { role: 'user', content: prompts.user }
  ], true, settings);
  var result = parseSummary(raw);
  if (!result) {
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
    var label = PROVIDERS[settings.provider].label;
    if (!settings.apiKey) {
      throw new Error('Aucune clé API configurée (Options de l\'extension).');
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
      progress('Regroupement thématique via ' + label + '…');
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
      ? label + ' : ' + TOKEN_USAGE.calls + ' appel(s), ' +
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

log('extension chargée, prête à recevoir un dossier.');
