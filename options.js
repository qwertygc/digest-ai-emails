/* options.js — édition des réglages dans storage.local. */

var FIELDS = ['apiKey', 'model', 'title', 'watch', 'cacheDays'];
var NUMERIC = { cacheDays: true };
var CHECKBOXES = ['unreadOnly', 'sectionsOpen'];

async function load() {
  var stored = await browser.storage.local.get('settings');
  var s = stored.settings || {
    apiKey: '', model: 'mistral-small-latest', limit: 40, watch: '',
    unreadOnly: false, sectionsOpen: false, cacheDays: 30,
    title: 'Revue de veille'
  };
  ['apiKey', 'model', 'title', 'watch', 'cacheDays', 'limit'].forEach(
    function (id) {
      var el = document.getElementById(id);
      if (el) el.value = s[id] != null ? s[id] : '';
    });
  CHECKBOXES.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.checked = !!s[id];
  });
}

async function save() {
  var stored = await browser.storage.local.get('settings');
  var s = stored.settings || {};
  ['apiKey', 'model', 'title', 'watch', 'limit', 'cacheDays'].forEach(
    function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      s[id] = NUMERIC[id] ? (parseInt(el.value, 10) || 0) : el.value.trim();
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

document.getElementById('save').addEventListener('click', save);
load();
