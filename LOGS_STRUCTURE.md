# Android Hub — Structure des logs

> Audit code source (2026-07-06). Étape préparatoire au nettoyage — **aucune logique de suppression décrite ici**, seulement l’inventaire et les recommandations.

---

## Racine de données (`userData`)

| Plateforme | Chemin typique |
|------------|----------------|
| Windows (dev + installé) | `%APPDATA%\android-hub\` |
| Résolution Electron | `app.getPath("userData")` (`package.json` → `"name": "android-hub"`) |

Tous les chemins relatifs ci-dessous sont sous cette racine, sauf mention contraire.

---

## 1. Logs internes Hub (fichiers)

### 1.1 Fichier confirmé — `update.log`

| Propriété | Valeur |
|-----------|--------|
| **Chemin** | `{userData}/update.log` |
| **Écrivain** | `src/main/auto-updater.js` → `appendLog()` |
| **Format** | Texte brut, une ligne par événement : `[ISO8601] message` |
| **Rotation** | **Aucune** — fichier unique qui grossit indéfiniment |
| **Fréquence** | À chaque événement auto-update (vérif toutes les 4 h + actions install/téléchargement) |
| **Taille observée** | Non instrumentée dans le code ; dépend du nombre de mises à jour / erreurs réseau |

Exemple de ligne :

```text
[2026-07-06T14:22:01.123Z] Vérification des mises à jour…
```

### 1.2 Dossier `logs/` — cible de nettoyage, **non alimenté par le Hub**

| Propriété | Valeur |
|-----------|--------|
| **Chemin** | `{userData}/logs/` (récursif) |
| **Référence code** | `MaintenanceCleanupManager.buildTargetsByCategory()` |
| **Écriture Hub** | **Aucune** `fs.write*` / `appendFile` / `createWriteStream` vers ce dossier dans `src/` |
| **Origine possible** | Création manuelle, ancienne version, ou fichiers Electron/Chromium hors contrôle explicite du projet |

`app.getPath("logs")` n’est **jamais** appelé dans le code ; le dossier n’est pas créé par l’application.

### 1.3 Dossier `cache/` — idem (cache générique, pas des logs)

Référencé par le nettoyage maintenance ; **aucune écriture** trouvée dans le code actuel. Ne pas confondre avec `app-icons/` (cache icônes).

### 1.4 Console Node / Electron — pas de fichier persistant

La quasi-totalité des messages « logs » du Hub passent par `console.log` / `console.warn` / `console.error` :

- **Dev** (`npm start`) → sortie terminal du processus Electron.
- **Build installé** (sans console) → ces lignes ne sont **pas** redirigées vers un fichier par le Hub.

Il n’y a pas de dépendance `electron-log`, `winston`, etc.

---

## 2. Sortie ADB / scrcpy — **aucune redirection fichier**

Aucun processus ne redirige stdout/stderr ADB ou scrcpy vers un fichier sur disque. Tout est lu en mémoire puis affiché en console.

### 2.1 Type A — flux socket Hub (`ScrcpySocketClient`)

| Élément | Détail |
|---------|--------|
| **Fichier** | `src/native/scrcpy/scrcpy-socket.js` |
| **Processus** | `adb shell app_process … com.genymobile.scrcpy.Server` (scrcpy-server sur l’appareil) |
| **stdio** | `stdout` / `stderr` → handlers `_appendServerLogChunk` → `console.log` / `console.error` |
| **Préfixe** | `[scrcpy-server {serial}]`, `[scrcpy-server {serial} ERROR]` |
| **Par session** | Un processus `adb` par client socket / serial actif |
| **Fichier par device/session** | **Non** |

### 2.2 Type B — scrcpy.exe externe (nouvelle instance)

| Élément | Détail |
|---------|--------|
| **Fichiers** | `src/main/main.js` (`new-instance:launch`, `spawnExternalLaunchChild`, `launchCompanionScrcpyWindow`) |
| **Binaire** | `{tools}/scrcpy.exe` (packagé : `resources/tools/scrcpy.exe`) |
| **stdio** | `pipe` ; stderr (et parfois stdout) parsé pour `New display: (id=…)` puis `console.error` |
| **Préfixes** | `[NewInstance scrcpy]`, `[NewInstance scrcpy {launchId}]`, `[Companion scrcpy {serial}]` |
| **Par lancement** | Un processus `scrcpy.exe` par lancement externe / companion ; clé interne `launchId` ou `serial` |
| **Fichier par device/session** | **Non** |

### 2.3 Audio PC — scrcpy.exe dédié (`--no-video`)

| Élément | Détail |
|---------|--------|
| **Fichier** | `src/main/managers/session-audio-process-manager.js` |
| **Processus** | Un `scrcpy.exe` par **sessionId** Hub actif (audio ON) |
| **stdio** | stderr → `console.log` préfixe `[SessionAudio {sessionId}]` |
| **Fichier** | **Non** |

### 2.4 Commandes ADB ponctuelles (`exec`)

`DeviceManager`, `WifiAdbService`, `AdbInputController`, `main.js`, etc. utilisent `child_process.exec` avec capture stdout/stderr **en mémoire** uniquement — pas de journal fichier.

---

## 3. Fichiers `userData` à **ne pas** traiter comme logs

Ces fichiers sont de la **config / données métier** (déjà exclus du nettoyage logs dans `PROGRESS_CHECK.md`) :

| Fichier / dossier | Rôle |
|-------------------|------|
| `custom-names.json` | Noms appareils / onglets |
| `device-colors.json` | Couleurs appareils |
| `device-history.json` | Historique connexions USB |
| `wifi-devices.json` | Config WiFi ADB |
| `launch-history.json` | Historique apps lancées (catégorie maintenance **historique**, pas logs) |
| `maintenance-preferences.json` | Préférences auto-nettoyage |
| `app-metadata-cache.json` | Index cache métadonnées apps |
| `app-icons/` | PNG icônes extraites |

---

## 4. Fichiers potentiellement « actifs » au moment d’un nettoyage

| Artefact | Actif pendant | Risque verrouillage |
|----------|---------------|---------------------|
| `update.log` | Écriture lors des checks auto-update (intervalle 4 h) | Faible ; append court possible → `EBUSY` |
| `logs/*` | N/A (Hub n’écrit pas) | Faible sauf fichier ouvert par un autre outil |
| Sortie scrcpy/ADB | Sessions en cours | **Aucun fichier** côté Hub — pas de conflit disque |
| `app-metadata-cache.json` | Prefetch icônes | Écriture concurrente possible — classé **cache**, pas log |

**Sessions scrcpy actives** : n’empêchent pas la suppression de fichiers log Hub, car elles ne créent pas de fichiers log locaux.

---

## 5. Détection sécurisée avant suppression (recommandation)

Mécanisme **déjà en place** dans `MaintenanceCleanupManager.tryDeleteFile()` :

1. Tentative d’ouverture du fichier en `r+` (détecte verrou exclusif Windows).
2. Si `EBUSY`, `EPERM` ou `EACCES` → **skip** (compteur `skippedLocked`), pas de suppression forcée.
3. Sinon `unlink` avec même gestion d’erreurs.

Recommandations complémentaires pour la feature de nettoyage :

| Pratique | Justification |
|----------|----------------|
| Conserver le test `r+` + skip sur lock | Suffisant pour `update.log` et tout futur log fichier |
| Filtre d’âge (ex. 7 jours) pour l’auto-nettoyage | Évite de toucher un `update.log` en cours d’écriture si la ligne vient d’être ajoutée ; fichiers récents souvent encore utiles |
| Ne cibler que les chemins inventoriés | `update.log`, `logs/` — pas les JSON de config |
| Registre optionnel des descripteurs ouverts | Si de futurs logs fichier sont ajoutés, centraliser les `WriteStream` dans un manager qui expose `isPathActive(filePath)` |
| Ne pas supprimer pendant `appendFileSync` sans queue | Pour `update.log`, le pattern actuel (append synchrone court) + skip lock est acceptable |
| Exclure explicitement les processus | Inutile aujourd’hui (pas de log scrcpy fichier) ; à réévaluer si redirection fichier ajoutée plus tard |

**Cas limite `update.log`** : un append en cours peut provoquer un skip ponctuel ; acceptable — le fichier sera éligible au prochain cycle auto ou nettoyage manuel.

---

## 6. Synthèse pour le nettoyage « Logs »

| Inclus dans la catégorie maintenance **logs** | Écrit par le Hub ? | Priorité nettoyage |
|-----------------------------------------------|--------------------|--------------------|
| `update.log` | Oui | Haute — seul vrai log fichier Hub |
| `logs/**` | Non (dossier réservé / externe) | Moyenne — nettoyer si présent et ancien |
| Console ADB/scrcpy | N/A (pas de fichier) | Hors périmètre |

**Taille moyenne** : non mesurée automatiquement dans le projet ; à estimer en conditions réelles sur `%APPDATA%\android-hub\` (notamment `update.log` et contenu éventuel de `logs/`).

---

## 7. Références code

| Sujet | Fichier |
|-------|---------|
| Écriture `update.log` | `src/main/auto-updater.js` |
| Cibles nettoyage logs | `src/main/managers/maintenance-cleanup-manager.js` |
| Détection fichier verrouillé | `MaintenanceCleanupManager.tryDeleteFile()` |
| Logs scrcpy-server (ADB) | `src/native/scrcpy/scrcpy-socket.js` |
| Logs scrcpy.exe Type B | `src/main/main.js` |
| Logs scrcpy audio | `src/main/managers/session-audio-process-manager.js` |
| Binaires ADB/scrcpy | `src/main/paths.js` → `tools/adb.exe`, `tools/scrcpy.exe` |
