# Android Hub — Contexte agent & zones verrouillées

> **Règle générale :** tout ce qui est listé ci-dessous comme **LOCK** est stable, validé en tests utilisateur, et **ne doit pas être modifié** sans accord explicite du mainteneur.

Dernière mise à jour : 2026-07-21

---

## LOCK GÉNÉRAL (validé 2026-07-04 — input étendu 2026-07-05)

### Audio — LOCK

- Capture audio, lancement Type A / Type B avec son PC, mute global OFF (silence).
- **Défaut au démarrage (LOCK 2026-07-08) : audio global OFF** — `globalMuted: true` ; Type B `streamOptions.audio: false` ; toggle sidebar pour activer.
- Fichiers concernés (ne pas modifier sans accord) :
  - `src/main/managers/global-audio-output-manager.js`
  - `src/main/managers/session-audio-process-manager.js`
  - `src/main/ipc/audioHandlers.js` (handlers IPC métier)
  - `src/main/main.js` — fonctions `applyGlobalAudioMuteSideEffects`, `resolveHubSocketAudioEnabled`, `startSessionAudioPlayback`, `stopSessionAudioPlayback`
  - `src/renderer/session-audio-hub.js`
  - `src/renderer/session/session-audio-player.js`

**Comportement attendu (déjà validé) :**

- **Démarrage Hub** : audio global **OFF** (badge OFF, pas de capture jusqu'au toggle utilisateur).
- **Audio ON (global)** : processus scrcpy dédié `--no-video` par session → son PC ; device muet côté OS.
- **Audio OFF (global)** : arrêt des processus audio + pas de capture socket Hub.
- **Type B nouveau lancement** : `audio: false` dans payload create (pas d'audio scrcpy externe tant que l'utilisateur n'a pas activé le son global).

### Multi-appareils & polling devices — LOCK (validé 2026-07-08, `973a28a`)

> Ne pas casser la liste devices, les labels d'onglets distincts, ni le routage input serial quand 2+ appareils sont connectés.

| Fichier | Règle |
|---------|-------|
| `src/renderer/devices.js` | Fonction interne `pollDeviceList()` ; éviter collision nom global `refreshDevices` |
| `src/renderer/new-session.js` | Label Type B = `{deviceName} — {appLabel}` ; `stableDeviceId` propagé |
| `src/main/main.js` | Pas d'invalidation cache serial ADB sur chaque `get-devices` |
| `src/main/ipc/sessionHandlers.js` | `stableDeviceId` dans labels et `getInputContext` |
| `src/renderer/session/session.js` | Type B : pas d'auto-`activateSession` au chargement BrowserView |

Référence : `PROGRESS_CHECK.md` § Multi-appareils & polling devices.

### Input — LOCK DÉFINITIF (validé 2026-07-05)

> ⚠️ **INPUT LOCKÉ (2026-07-05)** — Ne plus modifier la logique d'input (Type A/B, USB/WiFi, portrait/paysage). Ce module a causé plusieurs régressions lors de l'ajout de l'orientation WiFi. Toute nouvelle feature doit passer par une **couche en amont**, jamais dans ces fichiers directement. Si un bug d'input apparaît à l'avenir : **diagnostiquer d'abord**, puis **valider avec l'utilisateur** avant de toucher à ce module.

**Périmètre validé (ne plus modifier sans accord explicite) :**

| Zone | Fichiers / fonctions |
|------|----------------------|
| Renderer — pointer, remap, clic droit | `src/renderer/session/session.js` — `createCanvasPointerHandlers`, `mapDisplayCoordsToStream`, `needsDisplayCoordRemap`, `normalizePointerPosition`, `getCanvasContentRect`, `initTypeAInputHandlers`, `initTypeBInputHandlers`, `attachRightClickBackHandler`, `resolveTouchOrientationForSession`, guards portrait (`portraitInputRemap*`, `portraitRemapLocked*`) |
| Main — IPC input | `src/main/main.js` — handler `send-input`, `sendTypeBInputViaHubAdb`, `getOrCreateSessionInputController`, `syncInputControllerCaptureRotation`, `resolveTypeBDisplayId`, `resolveScrcpyClientForInput` |
| ADB input core | `src/native/scrcpy/control/adb-input-controller.js` — `AdbInputController`, remap `captureRotation`, injection `-d displayId` |
| IPC contexte session | `src/main/ipc/sessionHandlers.js` — `session:getInputContext` |
| Preload session | `src/preload/sessionPreload.js` — surface `videoAPI.sendInput` / `getInputContext` |

**Comportements validés (2026-07-05) :**

- **Type A paysage** — USB/WiFi : clic, drag, clic long, BACK (clic droit), clavier.
- **Type A portrait** — remap canvas +90° (interim flux paysage), coords sur toute la surface ; flux portrait natif sans remap.
- **Type B** — display virtuel : coords canvas directes ; hub ADB `input -d displayId` ; clic long (maintien ≥400 ms, tolérance 12 px) ; USB/WiFi.
- **Multi-fenêtres** — commit `c23e7cb` ; fallback ADB Type A ; fallback `routeInputToSession` Type B.

**Règles pour toute évolution future :**

1. Ne jamais modifier directement le recalcul de coordonnées, le mapping touch, le clic droit / clic long, ni les handlers pointer partagés.
2. Greffer en amont uniquement : résolution serial, métadonnées session, orientation avant le pipeline input.
3. Bug input suspect : diagnostiquer sans patch tant que l'utilisateur n'a pas validé.

### Renderer — scripts globaux & i18n (LOCK 2026-07-06)

> Les scripts chargés via `<script src>` dans `index.html` / `hub-modal-window.html` partagent **un seul scope global**. Ne pas déclarer `const t`, `const api` ou tout identifiant générique au top-level.

**Règles :**

1. Helper i18n : nom unique par fichier (`dt`, `nsT`, …) **ou** IIFE comme `SettingsPanel.js` / `HelpPanel.js`.
2. Exports partagés : noms explicites (`appDisplayApi`, `streamParamsApi`) — pas `const api`.
3. Fonctions panel : exposer sur `window.*` (`window.openNewSessionPanel`, `openNewSessionPanelFromMain`, …).
4. Zones LOCK (input, vidéo, audio, `scrcpy-socket.js`, `new-instance-manager.js`) : inchangées.

Référence détaillée : `PROGRESS_CHECK.md` § Fix collisions scope global i18n / modales.

### Sidebar rétractable — LOCK (validé 2026-07-07)

> La sidebar entière se replie via `#sidebar-shell` sans toucher au contenu interne (devices, toggles, navigation). État `sidebarOpen` persisté (`ui-preferences.json`).

**Fichiers concernés (ne pas modifier sans accord) :**

| Fichier | Rôle |
|---------|------|
| `src/renderer/sidebar/SidebarCollapse.js` | Toggle, Ctrl+B, persistance, `window.toggleSidebar` |
| `src/renderer/index.html` | Wrapper `#sidebar-shell`, bouton flèche |
| `src/renderer/styles/style.css` | `.sidebar-shell`, `.sidebar-collapse-btn`, transitions |
| `src/renderer/sidebar-panel-layout.js` | Mesure `#sidebar-shell` → `--sidebar-width` |

**Comportements validés :**

- Repli / dépli en un bloc ; bouton flèche toujours visible.
- Ctrl+B / Cmd+B ; pas de conflit Ctrl+Tab.
- Redimensionnement flux vidéo via `reportContentBounds()` (BrowserView), sans modifier `session.js` / zones LOCK.

**Règles pour toute évolution future :**

1. Ne pas déplacer la logique métier des panneaux sidebar dans le mécanisme de repli.
2. Tout changement de layout sidebar → mettre à jour `sidebar-panel-layout.js` + `reportContentBounds`.
3. Persistance UI via `ui-preferences.json` (`sidebarOpen`), pas de stockage parallèle.

Référence : `PROGRESS_CHECK.md` § Sidebar rétractable.

### Mode Stream Deck — LOCK (validé 2026-07-07)

> Affichage multi-sessions en grille, focus ou duo. **Désactivé par défaut** au démarrage (`streamDeckMode: false`). Changement de layout = **bounds BrowserView uniquement** — pas de recréation de session scrcpy. Popup Duo = **fenêtre overlay enfant** (au-dessus des flux vidéo, inatteignable en z-index DOM seul).

**Fichiers concernés (ne pas modifier sans accord) :**

| Fichier | Rôle |
|---------|------|
| `src/renderer/stream-deck/DisplayLayoutState.js` | État layout, duo slots, persistance, `streamDeckMode` défaut `false` |
| `src/renderer/stream-deck/StreamDeckBar.js` | Boutons Grille/Focus/Duo dans la barre d'onglets |
| `src/renderer/stream-deck/StreamDeckZone.js` | Tuiles, sync bounds multi, activation session |
| `src/renderer/stream-deck/StreamDeckDuoCollapse.js` | Ouverture/fermeture popup Duo (overlay) |
| `src/renderer/stream-deck/stream-deck.css` | Styles zone Stream Deck + barre onglets |
| `src/renderer/stream-deck/duo-popup-overlay.*` | UI popup Duo (fenêtre overlay) |
| `src/renderer/sidebar/StreamDeckToggle.js` | Toggle sidebar Mode Stream Deck |
| `src/main/managers/stream-deck-duo-popup-manager.js` | Fenêtre overlay Duo (parent = fenêtre principale) |
| `src/main/ipc/streamDeckDuoPopupHandlers.js` | IPC `duo-popup:*` |
| `src/preload/duoPopupPreload.js` | Bridge overlay popup |
| `src/main/managers/browserViewManager.js` | Bounds single/multi, skip bounds identiques, `suppressView` / `restoreView` |
| `src/main/managers/ui-preferences-manager.js` | Persistance `displayLayout`, `duoDeviceIds`, `streamDeckMode` |
| `src/renderer/layout-metrics.js` | Debounce `reportContentBounds`, délégation Stream Deck |
| `src/renderer/index.html` | Rail layout onglets, shell `#stream-deck-shell` |

**Comportements validés :**

- Toggle sidebar → mode multi ; layouts Grille / Focus / Duo dans la barre d'onglets (à droite).
- **Duo** : popup sous les boutons layout, **au-dessus du flux vidéo** ; re-clic Duo ou clic extérieur pour fermer.
- `Ctrl+Shift+L` : cycle layouts si Stream Deck actif.
- 3+ sessions : duo auto-remplit les slots ; pas de casse du mode multi.
- Perf : pas de spam `setContentBounds` (debounce + cache bounds).

**Hors périmètre LOCK (ne jamais toucher pour le Stream Deck) :**

- `src/native/scrcpy/scrcpy-socket.js`
- `src/main/managers/new-instance-manager.js` — `createNewInstanceSession()`, input Type B
- `src/renderer/session/session.js` — pipeline input

**Règles pour toute évolution future :**

1. Nouveau layout = bounds + renderer uniquement ; pas de reconnexion scrcpy.
2. UI au-dessus de la vidéo = fenêtre overlay enfant ou API existante (`suppressView`), pas de z-index DOM seul.
3. Greffer toggles/layout en amont de `session.js` / input / scrcpy-socket.

Référence aide : `help.shortcuts` § Mode Stream Deck (locales `scripts/locale-data-*.js`).

### Input Type A — LOCK (historique `c23e7cb`, étendu 2026-07-05)

- Fallback ADB quand le socket contrôle scrcpy est absent.
- Vérification `result.success === false` côté renderer.

### Input Type B — LOCK (historique `c23e7cb`, étendu 2026-07-05, clic long 2026-07-08)

- Routage touch display virtuel via hub ADB + `displayId`.
- Clic long : synthèse ADB `swipe` même point (400–3000 ms) ; `_activeTouchStart` + tolérance 12 px (`adb-input-controller.js`).
- Touch display virtuel : fallback `routeInputToSession` → ADB (pas scrcpy) si `displayId` (`new-instance-manager.js`).
- Contrôleur ADB unifié hub ↔ session (`main.js` réutilise `session.inputController`).

**Fichiers core scrcpy / Type B (LOCK — ne jamais modifier sans accord) :**

- `src/native/scrcpy/scrcpy-socket.js`
- `src/main/managers/new-instance-manager.js` — `createNewInstanceSession()`, `routeInputToSession`, `mergeTypeBScrcpyOptions`

### Toggle Audio ON/OFF (bouton sidebar)

- **Composant UI :** `src/renderer/sidebar/GlobalAudioToggle.js`
- **Câblage IPC :** `src/preload/preload.js` (`audioAPI`), `src/main/ipc/audioHandlers.js` (broadcast uniquement)
- Le bouton déclenche la logique audio **LOCK** ci-dessus ; ne pas réimplémenter le métier dans le composant.

### Noms appareils & onglets — LOCK (validé 2026-07-05)

> **NOMS LOCKÉS (2026-07-05)** — Source de vérité unique pour les noms personnalisés (panneau Appareils, sidebar, sélecteur Nouvelle instance, onglets/fenêtres session). Clé canonique = **`deviceId` stable** (`ro.serialno` / config WiFi), jamais le serial transport (`ip:port`). Ne pas réintroduire de stockage parallèle ni de clés par transport.

**Fichiers concernés (ne pas modifier sans accord) :**

| Fichier | Rôle |
|---------|------|
| `src/main/managers/custom-names-manager.js` | Persistance `custom-names.json` ; clés device + session stables ; consolidation alias transport |
| `src/main/ipc/namesHandlers.js` | IPC rename/reset ; `resolveStableDeviceId` ; sync WiFi config + labels sessions ouverts |

**Comportements validés :**

- Renommer appareil depuis USB ou WiFi → visible partout (panneau, sidebar, Nouvelle instance).
- Renommer onglet/fenêtre Type A/B depuis un transport → même nom au relancement sur l'autre transport.
- Reset nom (dialogue ou menu contextuel) → cohérent USB/WiFi.

**Règles pour toute évolution future :**

1. Toujours résoudre vers `stableDeviceId` avant lecture/écriture.
2. Greffer en amont (registry, handlers IPC) — ne pas dupliquer la logique de clé dans le renderer.
3. `contextMenuHandlers.js` (reset device/session) doit passer par les helpers `namesHandlers` — pas d'écriture directe `custom-names.json` ailleurs.

---

## Architecture session (rappel)

- Fenêtres session = `BrowserView` + `session.html` / `session.js`.
- Type A : flux socket Hub vidéo ; Type B : `NewInstanceManager` + display virtuel.
- Input : IPC `send-input` → main process.

---

## Avant toute modification

1. Vérifier si la zone touchée est **LOCK** (audio, **input**, **noms**, **Stream Deck**, `scrcpy-socket.js`, `new-instance-manager.js`, etc.).
2. Si oui → **STOP** et demander accord explicite.
3. Pour l'**input** : toute évolution passe par une couche **amont** ; jamais de patch direct dans les fichiers listés § Input LOCK DÉFINITIF.
4. Pour le **renderer** : pas de `const t` / `const api` au scope global dans les `<script>` — voir § Renderer scripts globaux & i18n.
5. Pour la **sidebar rétractable** : wrapper shell uniquement — voir § Sidebar rétractable LOCK.
6. Pour le **mode Stream Deck** : bounds + overlay uniquement — voir § Mode Stream Deck LOCK ; ne pas toucher scrcpy-socket / new-instance-manager / session.js input.
7. Préférer des changements **additifs** ; ne pas supprimer de comportement validé.

### Worker apps (fork) — plan validé diagnostic 2026-07-09

> **P0–P1.5+P2 prefetch livré (2026-07-09)** — Historique, liste apps, enrich cache, prefetch étendu (16 + reste) dans le worker via `AppsWorkerBridge`. **Extracteur adaptive-icon en attente.** **LOCK inchangé**.

**Fichiers cibles (création) :**

| Fichier | Rôle |
|---------|------|
| `src/main/workers/apps-worker.js` | Process enfant : managers apps/métadonnées/historique |
| `src/main/managers/apps-worker-bridge.js` | Pont IPC main ↔ worker, lifecycle, fallback crash |

**Pont main (modifications minimales, hors LOCK) :** `main.js` (init/shutdown + `device:apps`), `appMetadataHandlers.js`, `launchHistoryHandlers.js`, `new-instance-ipc.js` (seul `recordLaunch` → bridge).

#### Ajouter un nouveau type de message IPC worker

1. Définir la constante `TYPE` dans `apps-worker.js` (handler `process.on("message")`).
2. Documenter le contrat request/response dans ce fichier (payload + erreurs).
3. Exposer une méthode sur `AppsWorkerBridge` (ex. `bridge.request("MON_TYPE", payload)`).
4. Appeler depuis le handler IPC Electron concerné (main reste relayeur).
5. Si push worker → renderer : envoyer `METADATA_UPDATED` (ou équivalent) depuis le worker, bridge relaye vers `webContents.send` existant.
6. Logger le changement dans `PROGRESS_CHECK.md` + entrée journal ci-dessous.

**Messages initiaux prévus :** `INIT`, `GET_APP_LIST`, `ENRICH_APPS`, `RESOLVE_APP_METADATA`, `PREFETCH_APP_METADATA`, `GET_HISTORY`, `ADD_HISTORY_ENTRY`, `REMOVE_HISTORY_ENTRY`, `METADATA_UPDATED` (push), `SHUTDOWN`.

**Cache partagé :** réutiliser `{userData}/app-metadata-cache.json`, `{userData}/app-icons/`, `{userData}/launch-history.json` — pas de second stockage.

Référence diagnostic : `PROGRESS_CHECK.md` § DIAGNOSTIC — Worker apps (fork) 2026-07-09.

### Async I/O metadata — main thread (2026-07-12, 3 étapes)

| Étape | Fichier | Changement |
|-------|---------|------------|
| 1 | `app-metadata-manager.js` | `getCachedEntry` / `isFresh` → `fs.promises` via `isIconFileAccessible` |
| 2 | `app-icon-extractor.js` + metadata | Extraction icône `resolveOne` → async (`walkFiles`, `pullApk`, `toIconUrl`) |
| 3 | `app-metadata-manager.js` | `enrichHistoryEntries` : `prefetchHistoryApps` async remplace `setImmediate` ; `invalidate` async |
| 4 | `app-metadata-manager.js` | `pruneForDevice` async via `removeIconFileIfExists` (aucun appelant actuel) |

**LOCK / worker :** `apps-worker.js`, `scrcpy-socket.js`, `new-instance-manager.js` — non touchés.

### Diagnostic IPC listeners sans désabonnement (2026-07-12)

Aucune API `on*` dans `src/preload/*.js` ne retourne de fonction de désinscription. **Risque réel identifié :** factories `createVideoPlayer` / `createNewInstanceVideoPipeline` ajoutent un handler `stream-restarting` par session sans cleanup à la fermeture. **Correctif (2026-07-12, 3 étapes) :** `sessionAPI.onStreamRestarting` retourne unsubscribe ; `dispose()` à la fermeture Type A/B. Autres `on*` : P3 dette théorique. Détail : `PROGRESS_CHECK.md` § FIX — Cleanup listener stream-restarting.

### Audit nettoyage 7.2–7.6 (2026-07-12, diagnostic)

| Point | Verdict |
|-------|---------|
| 7.2 preload racine | **Supprimé** (2026-07-12) — `src/preload/preload.js` seul actif |
| 7.3 `get-apps` | **Supprimé** (2026-07-12) — `device:apps` / `getAppsWithDetails` seul chemin |
| 7.5 `test.js` | **Supprimé** (2026-07-12) — non référencé, exclu du build |
| 7.6 `getConnectedDevices` | **Terminé** — fallbacks relocalisés dans `device-manager` ; duplication `main.js` retirée |
| 7.4 `DEBUG_CRASH` | **Supprimé** (2026-07-12) — pas de garde env ; résilience worker légitime conservée |
| 7.1 `execPromise` dup | **Module créé** (2026-07-12) — `src/main/utils/adb-exec.js` ; migration différée |

Détail : `PROGRESS_CHECK.md` § DIAGNOSTIC — execPromise / execWithTimeout dupliqués.

---

## Presets d'affichage session (en cours — 2026-07-09)

| Commit | Fichier(s) | Rôle |
|--------|------------|------|
| 1 | `src/main/managers/display-presets-manager.js` | Persistance `{userData}/display-presets.json` ; seed `full-hd` ; `resolveParams()` merge dpi/gop depuis `DEFAULT_STREAM_PARAMS` |
| 1 | `src/main/main.js` | `global.displayPresetsManager` à l'init |
| 2 | `src/main/ipc/display-presets-handlers.js` | IPC `display-presets:*` ; event `display-presets:updated` |
| 2 | `src/preload/preload.js` | `window.displayPresetsAPI` |
| 3 | `src/renderer/new-session.js` | Défaut lancement Type A/B via `displayPresetsAPI.getDefault()` → `toScrcpyOptions()` |
| 4 | `hub-modal-window.html`, `ControlPanel.js`, `control-panel.css`, locales | UI presets : sélecteur, enregistrer, défaut, appliquer à toutes (UI) |
| 5 | Étapes A–C : « Appliquer à toutes » → `updateDefaultFromParams` (prochains lancements, pas restart) |

### Étapes A–C — « Appliquer à toutes » reformulé (terminé)

| Commit | Fichier | Action |
|--------|---------|--------|
| A1 | `stream-params-manager.js` | Suppression `applyParamsToAllSessions()` ✓ |
| A2 | `sessionHandlers.js` | Suppression IPC `session:applyStreamParamsToAll` ✓ |
| B1 | `display-presets-manager.js` | `updateDefaultFromParams()` + `_ensureDefaultPreset()` ✓ |
| B2 | `display-presets-handlers.js`, `preload.js` | IPC `update-default-from-params` + `displayPresetsAPI.updateDefaultFromParams` ✓ |
| C | `ControlPanel.js`, locales, hint UI | bouton → `updateDefaultFromParams` ✓ |

**Raison :** « Appliquer à toutes » = défaut pour **prochains lancements**, pas restart des sessions actives.

---

**LOCK intact** : pas de modification `scrcpy-socket.js`, `new-instance-manager.js`, input, Type A/B.

Prochaines étapes : feature presets complète (commits 1–5 + reformulation A–C).

Référence : `PROGRESS_CHECK.md` § Presets d'affichage session.

### Correctif UI (2026-07-09)

- `window.prompt()` remplacé par champ texte (Electron ne supporte pas `prompt`)
- `syncPresetControls()` : réactive les boutons après chargement

---

## Journal des micro-changements (validés)

- **2026-07-12** — **Diagnostic I/O sync metadata/icônes** — prefetch bulk worker ; sync main : `resolve` + historique. LOCK intact.
- **2026-07-12** — **Overlay switch poll transport** — overlay fermé après confirmation `transport`/`wifiActive` (poll 600 ms, 18 s max). LOCK intact.
- **2026-07-12** — **get-devices forceFresh** — option `forceFresh` pour bypass cache registry 10 s ; poll 12 s inchangé. LOCK intact.
- **2026-07-12** — **Diagnostic wifi:toggle success** — `success` WiFi ON = `adb get-state device` sur serial WiFi ; WiFi OFF = disconnect sans vérif ; UI `transport` via `listUnifiedDevices` (cache 10 s). Overlay actuel peut se fermer trop tôt. LOCK intact.
- **2026-07-12** — **Overlay switch USB/WiFi** — spinner centré au toggle sidebar ; masqué à la réponse IPC. LOCK intact.
- **2026-07-12** — **Overlay chargement hub** — composant `hub-loading-overlay.js` (spinner centré, non bloquant). LOCK intact.
- **2026-07-12** — **Localisation switch USB/WiFi** — toggle sidebar `DevicePanel.js` → `wifiAPI.toggle` / `wifi:toggle` ; fin = réponse IPC invoke. LOCK intact.
- **2026-07-12** — **Async I/O metadata main (3 étapes)** — (1) cache lookup `fs.promises` ; (2) `app-icon-extractor` async pour `resolveOne` ; (3) `enrichHistoryEntries` → `prefetchHistoryApps` (remplace `setImmediate`). Worker / LOCK inchangés.
- **2026-07-12** — **Add adb-exec.js** — module partagé exec ADB (non branché) ; migration managers différée. LOCK intact.
- **2026-07-12** — **Diagnostic execPromise dup (7.1)** — 10 copies, variations maxBuffer/trim ; module `src/main/utils/adb-exec.js` paramétrable ; LOCK adb-input + new-instance exclus. LOCK intact.
- **2026-07-12** — **Cleanup DEBUG_CRASH** — retrait crash volontaire worker (4 fichiers) ; restart/fallback inchangés. LOCK intact.
- **2026-07-12** — **Cleanup getConnectedDevices** — fallbacks `main.js` → `device-manager` ; `DeviceRegistry` source unique. LOCK intact.
- **2026-07-12** — **Fix device-manager connected** — `state === "device"` dans `getConnectedDevices` ; fallbacks main inchangés. LOCK intact.
- **2026-07-12** — **Deprecation get-apps** — preload `getApps` + handler IPC retirés ; liste apps via `device:apps`. LOCK intact.
- **2026-07-12** — **Cleanup** — suppression `test.js` racine (script abandonné). LOCK intact.
- **2026-07-12** — **Cleanup** — suppression `preload.js` racine (legacy inactif). LOCK intact.
- **2026-07-12** — **Audit nettoyage 7.2–7.6** — preload racine + `test.js` sûrs à supprimer ; `get-apps` mort (preload d'abord) ; `getConnectedDevices` fallback à garder. LOCK intact.
- **2026-07-12** — **Fix IPC stream-restarting leak** — `onStreamRestarting` retourne unsubscribe ; `dispose()` Type A (`video-player`/`instance-manager`) + Type B (`new-instance-pipeline`/`new-session`). LOCK intact.
- **2026-07-12** — **Diagnostic IPC listeners preload** — inventaire 40+ `on*` sans `removeListener` ; risque réel = factories `video-player` / `new-instance-pipeline` (`stream-restarting`). LOCK intact.
- **2026-07-12** — **Async pruneForDevice** — `removeIconFileIfExists` ; aucun appelant dans le repo. LOCK / worker inchangés.
- **2026-07-12** — **Fix Type B launchDims propagation** — `launchDims` stockées dans `externalLaunches`, copiées sur session au `create`, réutilisées au `start` via `preresolvedDims`. LOCK intact.
- **2026-07-12** — **Fix Type B fallback dims cache** — `resolveLaunchDims` écrit `deviceDimensionsCache` après succès fallback ; helper `writeDeviceDimensionsCache` dans `main.js`. LOCK intact.
- **2026-07-12** — **Diagnostic cache wm size / dims Type B** — TTL 60 s existe ; happy path Type B = 1× wm réel ; redondance = appels fonction + fallback sans cache. LOCK : non touchés.
- **2026-07-12** — **Fix USB resolveAdbSerialForDims** — `isLikelyUsbTransportSerial` avant `forceFresh` : lancement USB sans scan `listUnifiedDevices`. WiFi garde `forceFresh: true`. LOCK intact.
- 2026-07-12 — **Diagnostic lancement USB/WiFi** — Mesure USB : dims path 226 ms (`wm size` 78 %, `forceFresh` listUnified 22 %). WiFi non mesuré (hors ligne). Causes : `forceFresh` systématique si `stableDeviceId`, mutex vs poll, dims Type B 2–3×, post-dims scrcpy LOCK dominant total. Script temp supprimé.
- 2026-07-12 — **Perf ADB — forceFresh lancement** — `listUnifiedDevices({ forceFresh })` + `resolveAdbSerialForDims` → `forceFresh: true` uniquement au lancement session. Autres appelants cache inchangés. LOCK / vidéo : non concernés.
- 2026-07-12 — **Perf ADB — cache listUnifiedDevices** — `device-registry.js` : TTL 10 s, mutex scan (`_listUnifiedScanInProgress`), fingerprint raw USB/WiFi pour invalidation topologie, corps dans `_executeListUnifiedDevices`. Signature `listUnifiedDevices()` inchangée. `getDevicesPollState` reste séparé. LOCK / vidéo : non concernés.
- 2026-07-12 — **Diagnostic cache listUnifiedDevices (étape 1)** — signature, 5 appelants internes + `main.js` L1335 ; `getDevicesPollState` à garder séparé du mutex registry. Aucun patch code. LOCK / vidéo : non concernés.
- 2026-07-12 — **Perf UI — debounce recherche apps** — `AppLauncherSearch.js` + `AppList.js` : 100 ms (`clearTimeout`/`setTimeout`) sur handler `input` uniquement ; filtre/tri/render inchangés ; timer nettoyé dans `destroy()`. Commits `aad55b3`, `28344f4`. LOCK intact.
- 2026-07-21 — **Reattach USB/WiFi — Commit 2/4** — `scrcpy-socket.js` uniquement : `ScrcpySocketClient.rebind(newSerial, options)` posé, **non branché**. Cleanup ancien serial puis relaunch push/tunnel/server/sockets ; `start()`/`stop()`/`scid`/`socketName` inchangés.
- 2026-07-21 — **Reattach USB/WiFi — Commit 1/4** — `new-instance-manager.js` uniquement : état `reconnecting` + garde `_onScrcpyClosed` (no-op runtime) + helpers `beginTransportReconnect` / `endTransportReconnect` **non branchés**. Pas de touch createSession / input / `--new-display` / stop / restart / `_intentionalStop`.
- 2026-07-09 — **Presets affichage — étape C** — bouton « Appliquer à toutes » → `updateDefaultFromParams` (prochains lancements, pas restart).
- 2026-07-09 — **Presets affichage — étape B2** — IPC + preload `updateDefaultFromParams`.
- 2026-07-09 — **Presets affichage — étape B1** — `updateDefaultFromParams()` dans `display-presets-manager.js`.
- 2026-07-09 — **Presets affichage — étape A3** — retrait `sessionAPI.applyStreamParamsToAll` du preload.
- 2026-07-09 — **Presets affichage — étape A2** — retrait IPC `session:applyStreamParamsToAll`.
- 2026-07-09 — **Presets affichage — étape A1** — retrait `applyParamsToAllSessions` de `stream-params-manager.js` (commit 5 annulé).
- 2026-07-09 — **Presets affichage — fix UI**
- 2026-07-09 — **Presets affichage — commit 4** — UI panneau Contrôle (sélecteur, enregistrer, défaut, bouton appliquer toutes). LOCK intact.
- 2026-07-09 — **Presets affichage — commit 3** — `new-session.js` : preset par défaut pour miroir Type A et `streamOptions` Type B. LOCK intact.
- 2026-07-09 — **Presets affichage — commit 2** — IPC `display-presets-handlers.js` + `displayPresetsAPI` preload. LOCK intact.
- 2026-07-09 — **Presets affichage — commit 1** — `display-presets-manager.js` + init `main.js` ; fichier `display-presets.json` en userData. LOCK intact.
- 2026-07-09 — **P2 worker prefetch étendu** — `PREFETCH_APP_METADATA` dans worker ; passage 1 (16 apps) + passage 2 arrière-plan (`new-session.js`) ; push `METADATA_UPDATED` ; `resolvePrefetchContext` pour cacheDeviceId/adbSerial. Concurrence 2 inchangée. LOCK intact.
- 2026-07-09 — **Cache icônes stale** — `pruneStaleIconCacheEntries()` : invalide `iconPath` si PNG absent (tous deviceId), conserve `iconAttempts` ; async `fs.promises` ; log par deviceId. LOCK intact.
- 2026-07-09 — **P0 worker apps** — `src/main/workers/apps-worker.js`, `src/main/managers/apps-worker-bridge.js` : historique lancement (`GET/ADD/REMOVE_HISTORY`, purge maintenance) hors main via `fork()` ; fallback in-process si crash ; `launch-history-manager.js` option `enablePruneTimer`. LOCK intact.
- 2026-07-09 — **Plan worker apps (fork)** — Diagnostic lecture seule validé ; rétention historique 2 j + exception sessions Type B actives conservée.
- 2026-07-08 — **LOCK** — Clic long Type B : `adb-input-controller.js` (`_activeTouchStart`, tolérance 12 px, seuil 400 ms), `new-instance-manager.js` (touch display virtuel → ADB, pas scrcpy), `main.js` (contrôleur ADB session unifié). Raison : long press KO (micro-mouvements + chemin scrcpy sans synthèse).
- 2026-07-08 — `src/renderer/apps/app-list.css`, `src/renderer/styles/style.css` (historique), `src/shared/app-icon-placeholder.js` (classe `hub-app-icon-placeholder`) — `fill: none` limité aux SVG stroke ; placeholder historique visible. Raison : carré gris dans liste historique Nouvelle instance.
- 2026-07-08 — `src/renderer/new-session.js` — Après chargement apps : prefetch métadonnées une seule fois par appareil connecté + refresh silencieux (500 ms) ; plus de prefetch à chaque recherche/filtre tant que l'appareil reste connecté.
- 2026-07-08 — `src/main/managers/app-icon-extractor.js`, `src/main/managers/app-metadata-manager.js`, `src/main/ipc/appMetadataHandlers.js`, `src/main/ipc/new-instance-ipc.js` — Icônes apps : scan multi-APK (splits), parsing adaptive-icon XML → raster PNG/WebP (priorité legacy `ic_launcher` inchangée), lookup cache avec fallback clé transport → `stableDeviceId` (migration lazy sans ré-scan au démarrage), compteur `iconAttempts` max 3 dans `app-metadata-cache.json` avant abandon extraction. Raison : placeholders gris (Ar Core, Avod, Cast Webvideo) ; zéro latence bloquante liste/sidebar.
- 2026-07-08 — `src/native/scrcpy/control/adb-input-controller.js` — `sendKey(key)` : cas `key === " "` ⇒ `shell input ... keyevent 62` (insertion au voisinage de la ligne 234). Raison : la barre espace était injectée via le chemin `shell input ... text " "` (key.length==1) au lieu du `KEYCODE_SPACE` attendu par certaines apps.
