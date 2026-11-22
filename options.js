/* options.js — édition des réglages dans storage.local.
 * Le couple fournisseur/modèle pilote le pré-remplissage du point
 * d'accès et des suggestions de modèles. */

var PROVIDERS = {
  mistral: { label: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    models: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest'] },
  openai: { label: 'OpenAI (ChatGPT)', baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'o4-mini'] },
  anthropic: { label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'] },
  gemini: { label: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'] },
  custom: { label: 'Autre (compatible OpenAI)', baseUrl: '', model: '',
    models: [] }
};

var TEXT_FIELDS = ['baseUrl', 'apiKey', 'model', 'title', 'watch'];
var NUMERIC = { limit: true, cacheDays: true };
var CHECKBOXES = ['unreadOnly', 'sectionsOpen'];

function fillProviderSelect() {
  var sel = document.getElementById('provider');
  Object.keys(PROVIDERS).forEach(function (key) {
    var opt = document.createElement('option');
    opt.value = key;
    opt.textContent = PROVIDERS[key].label;
    sel.appendChild(opt);
  });
}

/* Suggestions de modèles pour le fournisseur courant. */
function refreshModelList(providerKey) {
  var list = document.getElementById('models');
  list.innerHTML = '';
  (PROVIDERS[providerKey] || { models: [] }).models.forEach(function (m) {
    var opt = document.createElement('option');
    opt.value = m;
    list.appendChild(opt);
  });
}

/* À chaque changement de fournisseur : remplacer le point d'accès et le
 * modèle si l'utilisateur n'avait pas déjà personnifié un champ. */
function onProviderChange() {
  var key = document.getElementById('provider').value;
  var p = PROVIDERS[key];
  var baseUrlEl = document.getElementById('baseUrl');
  var modelEl = document.getElementById('model');

  var knownUrls = Object.keys(PROVIDERS).map(function (k) {
    return PROVIDERS[k].baseUrl;
  });
  if (!baseUrlEl.value.trim() ||
      knownUrls.indexOf(baseUrlEl.value.trim()) >= 0) {
    baseUrlEl.value = p.baseUrl;
  }
  var knownModels = Object.keys(PROVIDERS).reduce(function (acc, k) {
    return acc.concat(PROVIDERS[k].models);
  }, []);
  if (!modelEl.value.trim() ||
      knownModels.indexOf(modelEl.value.trim()) >= 0) {
    modelEl.value = p.model;
  }
  refreshModelList(key);
}

async function load() {
  var stored = await browser.storage.local.get('settings');
  var s = Object.assign({
    provider: 'mistral', baseUrl: '', apiKey: '', model: '',
    title: 'Revue de veille', watch: '', limit: 40, cacheDays: 30
  }, stored.settings || {});
  if (!PROVIDERS[s.provider]) s.provider = 'mistral';

  document.getElementById('provider').value = s.provider;
  document.getElementById('baseUrl').value = s.baseUrl || '';
  document.getElementById('apiKey').value = s.apiKey || '';
  document.getElementById('model').value = s.model ||
    PROVIDERS[s.provider].model;
  ['title', 'watch', 'limit', 'cacheDays'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = s[id] != null ? s[id] : '';
  });
  CHECKBOXES.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.checked = !!s[id];
  });
  onProviderChange();
}

async function save() {
  var stored = await browser.storage.local.get('settings');
  var s = stored.settings || {};
  s.provider = document.getElementById('provider').value;
  s.baseUrl = document.getElementById('baseUrl').value.trim();
  s.apiKey = document.getElementById('apiKey').value.trim();
  s.model = document.getElementById('model').value.trim();
  ['title', 'watch'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) s[id] = el.value.trim();
  });
  ['limit', 'cacheDays'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) s[id] = NUMERIC[id] ? (parseInt(el.value, 10) || 0) : el.value.trim();
  });
  CHECKBOXES.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) s[id] = el.checked;
  });
  await browser.storage.local.set({ settings: s });
  var status = document.getElementById('status');
  status.textContent = 'Options enregistrées.';
  setTimeout(function () { status.textContent = ''; }, 2500);
}

fillProviderSelect();
document.getElementById('provider')
  .addEventListener('change', onProviderChange);
document.getElementById('save').addEventListener('click', save);
load();
