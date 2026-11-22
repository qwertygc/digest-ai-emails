/* digest.js — affiche le dernier digest stocké par le script de fond
 * dans un iframe srcdoc. Rechargement mannel via le bouton. */

async function show() {
  var stored = await browser.storage.local.get('lastDigest');
  var html = stored.lastDigest;
  var frame = document.getElementById('view');
  var empty = document.getElementById('empty');
  var hint = document.getElementById('hint');
  if (html) {
    frame.srcdoc = html;
    frame.style.display = '';
    empty.style.display = 'none';
    hint.textContent = 'Dernier digest en cache local.';
  } else {
    frame.style.display = 'none';
    empty.style.display = '';
    hint.textContent = '';
  }
}

document.getElementById('refresh').addEventListener('click', show);
show();
