/* popup.js — choisit un dossier, envoie la commande au script de fond.
 * Le traitement survit à la fermeture du popup : tout se passe dans
 * background.js ; le log ci-dessous est un simple miroir. */

var folderSelect = document.getElementById('folder');
var unreadBox = document.getElementById('unreadOnly');
var runButton = document.getElementById('run');
var logBox = document.getElementById('log');
var folders = [];

function addLog(text, cls) {
  var line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

/* Parcours récursif des comptes et sous-dossiers.
 * On ignore les dossiers techniques (corbeille, indésirables, brouillons). */
var SKIPPED_TYPES = ['trash', 'junk', 'templates', 'outbox', 'drafts'];

async function collectFolders(folderList, prefix, out) {
  for (var i = 0; i < (folderList || []).length; i++) {
    var f = folderList[i];
    var label = (prefix ? prefix + ' / ' : '') + f.name;
    if (SKIPPED_TYPES.indexOf(f.type) < 0 && !f.isUnified) {
      out.push({ label: label, folder: f });
    }
    var subs = f.subFolders;
    if (!subs || !subs.length) {
      /* Selon les versions de Thunderbird, subFolders peut être absent :
       * on interroge alors l'API folders (permission « folders »). */
      try {
        subs = await browser.folders.getSubFolders(f);
      } catch (err) {
        subs = null;
      }
    }
    if (subs && subs.length) {
      await collectFolders(subs, label, out);
    }
  }
  return out;
}

/* Dossier affiché dans l'onglet de messagerie actif (permission
 * accountsRead, déjà accordée). Renvoie null si l'onglet actif n'est
 * pas un onglet de messagerie. */
async function currentFolder() {
  try {
    var tabs = await browser.mailTabs.query({
      active: true, currentWindow: true
    });
    if (!tabs || !tabs.length) return null;
    var f = tabs[0].displayedFolder;
    if (!f || !f.name) return null;
    return f;
  } catch (err) {
    return null;
  }
}

async function init() {
  var stored = await browser.storage.local.get('settings');
  var settings = stored.settings || {};
  if (settings.unreadOnly) unreadBox.checked = true;

  try {
    /* Le dossier affiché dans l'onglet de messagerie actif, s'il existe,
     * est proposé en tête et sélectionné par défaut. */
    var cur = await currentFolder();
    if (cur) {
      folders.push({ label: 'Dossier courant : ' + cur.name, folder: cur });
    }
    /* true = inclure les dossiers de chaque compte (sinon la liste est vide) */
    var accounts = await browser.accounts.list(true);
    for (var i = 0; i < accounts.length; i++) {
      await collectFolders(accounts[i].folders, accounts[i].name, folders);
    }
    if (!folders.length) {
      addLog('Aucun dossier trouvé. Vérifiez qu\'au moins un compte ' +
        'de messagerie est configuré dans Thunderbird.', 'error');
      return;
    }
    folders.forEach(function (entry, idx) {
      var opt = document.createElement('option');
      opt.textContent = entry.label;
      opt.value = String(idx);
      folderSelect.appendChild(opt);
    });
  } catch (err) {
    addLog('Impossible de lister les dossiers : ' + err.message, 'error');
  }
}

runButton.addEventListener('click', async function () {
  var idx = parseInt(folderSelect.value, 10);
  if (!(idx >= 0) || !(idx in folders)) {
    addLog('Choisissez d\'abord un dossier.', 'error');
    return;
  }
  var stored = await browser.storage.local.get('settings');
  var settings = stored.settings || {};
  settings.unreadOnly = unreadBox.checked;
  await browser.storage.local.set({ settings: settings });

  runButton.disabled = true;
  addLog('Lancement…');
  var port = browser.runtime.connect({ name: 'digest' });
  port.onMessage.addListener(function (msg) {
    if (msg.type === 'progress') addLog(msg.text);
    else if (msg.type === 'done') {
      addLog('Terminé. ' + msg.text, 'ok');
      runButton.disabled = false;
    } else if (msg.type === 'error') {
      addLog('Erreur : ' + msg.text, 'error');
      runButton.disabled = false;
    }
  });
  port.onDisconnect.addListener(function () {
    runButton.disabled = false;
  });
  port.postMessage({ type: 'run', folder: folders[idx].folder });
});

init();
