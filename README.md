# Digest IA pour Thunderbird

Extension Thunderbird qui transforme les messages d'un dossier en une **revue de veille HTML** : les messages sont regroupés par thématique et synthétisés par le **LLM de votre choix**, dans un onglet Thunderbird. Aucun export de messages, aucun service tiers : tout se passe sur votre machine.

![Version](https://img.shields.io/badge/version-2.1.0-blue) ![Thunderbird](https://img.shields.io/badge/Thunderbird-%E2%89%A5115-orange) ![Langue](https://img.shields.io/badge/langue-Fran%C3%A7ais-blueviolet)

## LLM-agnostique

Choisissez votre fournisseur dans les options, l'extension s'adapte à son API :

| Fournisseur | Point d'accès par défaut | Modèle par défaut |
|---|---|---|
| **Mistral AI** | `https://api.mistral.ai/v1` | `mistral-small-latest` |
| **OpenAI (ChatGPT)** | `https://api.openai.com/v1` | `gpt-4o-mini` |
| **Anthropic (Claude)** | `https://api.anthropic.com` | `claude-sonnet-4-5` |
| **Google (Gemini)** | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.0-flash` |
| **Autre (compatible OpenAI)** | à renseigner | à renseigner |

La ligne « Autre » couvre tout service exposant une API compatible OpenAI : OpenRouter, Groq, Together, Ollama (`http://localhost:11434/v1`), LM Studio, llama.cpp, vLLM, etc. Le point d'accès et l'identifiant du modèle sont modifiables pour n'importe quel fournisseur. Changer de fournisseur ou de modèle invalide la mémoire des traitements : chaque relance paie ses tokens (c'est voulu, un même corpus de messages mérite d'être relu par le modèle que vous avez choisi).

## Fonctionnalités

- **Un clic** : le dossier affiché dans l'onglet de messagerie actif est proposé en tête du popup (« Dossier courant »), sinon tous les comptes et sous-dossiers sont listés
- **Regroupement thématique** (1 appel LLM), puis **synthèse par thème** (appels parallèles) avec une ligne « à retenir » par message
- **Multi-liens et liens fréquents** : toutes les URL utiles d'un message sont conservées (pas seulement la première — un message d'Alerte Google contient plusieurs résultats), les redirections `google.com/url?q=…` sont détourées, les paramètres de pistage (`utm_*`, `fbclid`…) retirés ; la section **« Liens les plus fréquents »** ouvre le digest avec les adresses citées dans plusieurs messages, classées par fréquence — pensée pour les dossiers d'**Alertes Google et Google Scholar**
- **Thématiques de veille** : les thèmes suivis (ex. *Nucléaire, Photographie*) remontent en tête du digest, marqués ★
- **Mémoire des traitements** : un second lancement identique ne consomme aucun token (empreintes des messages, TTL configurable)
- **Consommation affichée** : nombre d'appels et de tokens en fin de run
- **Nettoyage du corpus** : HTML converti en texte, liens de désabonnement et de pistage écartés, messages vides ou illisibles ignorés, temps de lecture estimé
- **Robustesse** : relance automatique du regroupement si des messages sont oubliés, réessais avec temporisation sur erreurs 429/5xx, repli sans `response_format` si le serveur ne le supporte pas, repli « Divers » si la réponse du modèle est illisible
- **Confidentialité** : la clé API et le cache restent dans le stockage local de Thunderbird ; seuls les extraits de texte partent vers le point d'accès du fournisseur choisi

## Installation

Téléchargez le dernier `digest-ai-tb-v*.xpi` sur la page **[Releases](../../releases)** (chaque commit construit une archive à jour), puis dans Thunderbird : **Outils → Modules et thèmes → ⚙ → Installer un module depuis un fichier** → sélectionnez le `.xpi`.

Thunderbird ≥ 115 requis (128 recommandé). Mise à jour : même manipulation, Thunderbird remplace la version existante et conserve les réglages.

## Configuration

Dans les options de l'extension (Outils → Modules et thèmes → Digest IA → Options) :

| Réglage | Description | Défaut |
|---|---|---|
| Fournisseur | Mistral, OpenAI, Anthropic, Gemini ou compatible OpenAI | Mistral AI |
| Point d'accès | URL de base de l'API, pré-remplie par fournisseur | selon fournisseur |
| Clé API | Clé chez le fournisseur choisi — **obligatoire** | vide |
| Modèle | Identifiant exact chez le fournisseur (suggestions intégrées) | selon fournisseur |
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
5. La revue s'ouvre dans un onglet Thunderbird : liens fréquents en tête, sections par thème, synthèses, sources et liens

## Architecture

- `manifest.json` — Manifest V2, permissions : `messagesRead`, `accountsRead`, `folders`, `storage`, `tabs` ; accès réseau largé sur `https://*/*` et `http://localhost/*` (nécessaire pour les fournisseurs au choix, y compris serveurs locaux)
- `digest-lib.js` — Extraction (multi-parties, HTML → texte, entités), collecte et classement des URL (détourage des redirections Google, retrait du pistage, fréquences), prompts (regroupement, correction, synthèse), analyse des réponses JSON (avec repli), rendu HTML autonome (CSS embarqué, aucun CDN)
- `background.js` — Orchestration : pagination des en-têtes (`messages.list` / `continueList`), chargement des corps en pool (`getFull`), couche LLM à adaptateurs (chat/completions, Anthropic Messages, Gemini generateContent), réessais, cache `storage.local`, suivi des tokens
- `popup.{html,js}` — Choix du dossier (dossier courant via l'API `mailTabs` ou arborescence complète) et lancement
- `options.{html,js}` — Réglages persistés dans `storage.local`, pré-remplissage selon le fournisseur
- `digest.{html,js}` — Affichage du dernier digest (iframe `srcdoc`, liens ouverts dans le navigateur système)
- `.github/workflows/release.yml` — À chaque commit sur `main`, construction du `.xpi` et mise à jour de la release **latest** ; chaque tag `vX.Y.Z` publie une release versionnée

## Développement

```bash
# Vérification syntaxique
for f in *.js; do node --check "$f"; done

# Construction de l'archive (identique au workflow CI)
zip -r -X ../digest-ai-tb.xpi manifest.json *.js *.html
```

Aucune dépendance, aucune étape de build : JavaScript standard (ES2017+) adapté à la page de fond Thunderbird.

## License

Distribué sous [Licence publique de l'Union européenne v. 1.2 (EUPL-1.2)](LICENSE). © Justin Poncet.

---

*English summary: a Thunderbird MailExtension that turns the messages of any folder into a themed HTML digest using the LLM of your choice (Mistral, OpenAI, Anthropic, Gemini or any OpenAI-compatible endpoint, including local ones). Fully local, multi-link extraction with frequency ranking for Google Alerts folders, token-cache reuse, automated .xpi releases via CI and a French UI.*
