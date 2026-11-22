# Digest IA pour Thunderbird

Extension Thunderbird qui transforme les messages d'un dossier en une **revue de veille HTML** : les messages sont regroupés par thématique et synthétisés par l'API [Mistral AI](https://mistral.ai), dans un onglet Thunderbird. Aucun export de messages, aucun service tiers : tout se passe sur votre machine.

![Version](https://img.shields.io/badge/version-1.0.3-blue) ![Thunderbird](https://img.shields.io/badge/Thunderbird-%E2%89%A5115-orange) ![Langue](https://img.shields.io/badge/langue-Fran%C3%A7ais-blueviolet)

## Fonctionnalités

- **Un clic** : le dossier affiché dans l'onglet de messagerie actif est proposé en tête du popup (« Dossier courant »), sinon tous les comptes et sous-dossiers sont listés
- **Regroupement thématique** (1 appel Mistral), puis **synthèse par thème** (appels parallèles) avec une ligne « à retenir » par message
- **Thématiques de veille** : les thèmes suivis (ex. *Nucléaire, Photographie*) remontent en tête du digest, marqués ★
- **Mémoire des traitements** : un second lancement identique ne consomme aucun token (empreintes des messages, TTL configurable)
- **Consommation affichée** : nombre d'appels et de tokens en fin de run
- **Nettoyage du corpus** : HTML converti en texte, liens de désabonnement et de pistage écartés, messages vides ou illisibles ignorés, temps de lecture estimé
- **Robustesse** : relance automatique du regroupement si des messages sont oubliés, réessais avec temporisation sur erreurs 429/5xx, repli « Divers » si la réponse du modèle est illisible
- **Confidentialité** : la clé API et le cache restent dans le stockage local de Thunderbird ; seuls les extraits de texte partent vers `api.mistral.ai`

## Installation

1. Téléchargez ou clonez ce dépôt
2. Zippez le contenu **à la racine** (le fichier `manifest.json` doit être à la racine de l'archive), renommez l'archive en `digest-ia-tb.xpi`
3. Dans Thunderbird : **Outils → Modules et thèmes → ⚙ → Installer un module depuis un fichier** → sélectionnez le `.xpi`

Thunderbird ≥ 115 requis (128 recommandé).

## Configuration

Dans les options de l'extension (Outils → Modules et thèmes → Digest IA → Options) :

| Réglage | Description | Défaut |
|---|---|---|
| Clé API Mistral | Clé depuis [console.mistral.ai](https://console.mistral.ai) — **obligatoire** | vide |
| Modèle | `mistral-small-latest` recommandé | `mistral-small-latest` |
| Titre | Titre de la revue | `Revue de veille` |
| Nb max de messages | Plafond de messages traités par run | 40 |
| Thématiques de veille | Séparées par des virgules (sections ★ en tête) | vide |
| Non lus seulement | Ignorer les messages déjà lus | non |
| Sections dépliées | Ouvrir les `<details>` par défaut | non |
| Mémoire (jours) | Durée de validité du cache, 0 = illimitée | 30 |

## Utilisation

1. Sélectionnez le dossier de votre choix dans Thunderbird
2. Cliquez sur le bouton **Digest IA** de la barre d'outils
3. Le popup propose « Dossier courant : … » ; cliquez sur **Générer le digest**
4. Suivez la progression (lecture, regroupement, synthèses), même si vous fermez le popup : le traitement continue en arrière-plan
5. La revue s'ouvre dans un onglet Thunderbird : sections par thème, synthèses, sources et liens

## Architecture

- `manifest.json` — Manifest V2, permissions : `messagesRead`, `accountsRead`, `folders`, `storage`, `tabs` ; accès réseau limité à `https://api.mistral.ai/*`
- `digest-lib.js` — Extraction (multi-parties, HTML → texte, entités, liens utiles), prompts (regroupement, correction, synthèse), analyse des réponses JSON (avec repli), rendu HTML autonome (CSS embarqué, aucun CDN)
- `background.js` — Orchestration : pagination des en-têtes (`messages.list` / `continueList`), chargement des corps en pool (`getFull`), appels Mistral (JSON mode, réessais), cache `storage.local`, suivi des tokens
- `popup.{html,js}` — Choix du dossier (dossier courant via l'API `mailTabs` ou arborescence complète) et lancement
- `options.{html,js}` — Réglages persistés dans `storage.local`
- `digest.{html,js}` — Affichage du dernier digest (iframe `srcdoc`, liens ouverts dans le navigateur système)

## Développement

```bash
# Vérification syntaxique
for f in *.js; do node --check "$f"; done

# Construction de l'archive
zip -r -X ../digest-ia-tb.xpi manifest.json *.js *.html
```

Aucune dépendance, aucune étape de build : JavaScript standard (ES2017+) adapté à la page de fond Thunderbird.

## License

Distribué sous [Licence publique de l'Union européenne v. 1.2 (EUPL-1.2)](LICENSE). © Justin Poncet.

---

*English summary: a Thunderbird MailExtension that turns the messages of any folder into a themed HTML digest using the Mistral AI API. Fully local (no third-party service beyond api.mistral.ai), with token-cache reuse and a French UI.*
