# Android Hub — État d'avancement

Dernière mise à jour : 2026-07-23

---

## switchSessionTransport — Commit 1/3 : Type A + toggle WiFi manuel (2026-07-23)

**Statut : implémenté (pas encore commité — review + test manuel requis).**

`switchSessionTransport` Commit 1/3 : Type A + branchement toggle manuel WiFi ON sans USB. Stub `closed` USB→WiFi neutralisé. Type B (4a) : `switchSessionTransportTypeB` + même branchement. **4b** : toggle UI resync sur état session / reattach. Plan 4c infobulle USB perdu / 4d USB rebranché à venir.

---

## Audit catégorie (b) — point 3 : fix orientation Type B / letterbox (2026-07-23)

**Statut : validé par test manuel — pas de commit isolé (option 3).**

Fix orientation Type B (letterbox) — comportement LOCK à préserver, validé indépendamment :
- `applyTypeBLaunchOrientation` → `captureOrientationLock = null` + `captureRotation = 0`
- `scrcpy-socket.js` → `hasOwnProperty` sur `captureOrientationLock` pour rendre ce `null` effectif

Testé sans WiFi : lancement Type B nominal + restart paramètres + garde-fou Type A (portrait plein cadre, Type A non affecté). Hunks déjà dans `a8940ec` (WIP mélangé) ; historique laissé tel quel, pas de commit dédié.

---

## Audit catégorie (b) — point 2 : bootstrap respecte le preset default (2026-07-23)

**Statut : implémenté (pas encore commité — review + test manuel requis).**

Le bootstrap externe Type B lit désormais la résolution du preset par défaut (`--new-display=WxH[/DPI]`) au lieu de forcer `1920x1080`. Corrige la perte de résolution custom après la priorité `display_id` + `skipPackageLaunch` (attach au VD bootstrap). Fallback `1920x1080` si preset indisponible/invalide. Priorité `_runClientStart` et fix orientation inchangés.

---

## Audit catégorie (b) — point 1 : vestige preferredNewDisplay (2026-07-23)

**Statut : nettoyage effectué (pas encore commité — review requise).**

Retrait de `preferredNewDisplay` (session) et de `resolveTypeBNewDisplay` (`new-instance-manager.js`), orphelins depuis le retrait de la catégorie (a) — aucun lecteur restant, aucun effet runtime.

---

## Reattach USB/WiFi — nettoyage rebind in-place (2026-07-22)

**Statut : nettoyage effectué (pas encore commité — review requise).**

Retrait de `ScrcpySocketClient.rebind()` / `rebindTransportOnly()` (`scrcpy-socket.js`) et `AdbInputController.rebind()` (`adb-input-controller.js`). Approche rebind in-place abandonnée après test réel (flux vidéo cassé + décalage input). Suite : `switchSessionTransport` (destroy+recreate orchestré), commit séparé à venir.

---

## Reattach USB/WiFi Option A — Commit 3/4 (2026-07-21) — OBSOLÈTE

**Statut : abandonné.** `AdbInputController.rebind()` retiré au nettoyage 2026-07-22.

---

## Reattach USB/WiFi Option A — Commit 2/4 (2026-07-21) — OBSOLÈTE

**Statut : abandonné.** `ScrcpySocketClient.rebind()` / `rebindTransportOnly()` retirés au nettoyage 2026-07-22.

---

## Reattach USB/WiFi Option A — Commit 1/4 (2026-07-21)

**Statut : commité (`d8be5f1`) — état `reconnecting` + garde `_onScrcpyClosed` + helpers non branchés.**

**Objectif :** poser l'infrastructure `reconnecting` sans changer le comportement runtime (helpers non branchés).

| Élément | Détail |
|---------|--------|
| Fichier | `src/main/managers/new-instance-manager.js` **uniquement** |
| État | `"reconnecting"` documenté (JSDoc `session.state`) |
| Garde | `_onScrcpyClosed` : early return si `state === "reconnecting"` — pas de force-stop, delete, ni emit |
| Helpers | `beginTransportReconnect` / `endTransportReconnect` — définis, **aucun appelant** |
| No-op | Aucun branchement `wifi:toggle` / DevicePanel ; zéro changement observable tant que les helpers ne sont pas appelés |

**Hors scope (commits suivants) :** rebind serial/scrcpy (2/3), orchestration entrée/sortie + timeout (4).

**LOCK :** createSession, input/gesture, `--new-display`, `stopNewInstanceSession`, `restartWithStreamOptions`, `_intentionalStop` / `_appForceStopped` — inchangés.

---

## DIAGNOSTIC — Cache listUnifiedDevices (2026-07-12, étape 1)

**Statut : diagnostic validé — aucun patch code à cette étape.**

### Signature `listUnifiedDevices` (`device-registry.js` ~L205-257)

```javascript
async listUnifiedDevices()  // → Promise<object[]>
```

Pipeline actuel (sans paramètres) :
1. `getRawAdbDevices()` — `adb devices` (+ fallbacks)
2. `importDiscoveredWifiDevices(raw)` — upsert WiFi manuels
3. `attachStableIds(...)` — `getStableDeviceId` par appareil connecté
4. `mergeByDeviceId` → boucle `buildUnifiedEntry` + entrées WiFi hors ligne depuis `wifiDevicesManager`

### Appelants internes (`device-registry.js`)

| Ligne | Méthode | Usage |
|-------|---------|-------|
| ~L342 | `discoverNewDevices` | Après double `getRawAdbDevices` + import WiFi |
| ~L432 | `resolveEffectiveAdbSerial` | Résolution serial effectif (transport → live) |
| ~L480 | `resolveStableDeviceIdFromTransport` | Clé transport → `deviceId` stable |
| ~L526 | `buildDevicesPanelData` | Panneau Appareils (avec `getRawAdbDevices` séparé pour statut USB) |
| ~L619 | `buildAdbSerialToDeviceIdMap` | Map serial → deviceId (couleurs / noms) |

### Appelant externe

| Fichier | Ligne | Contexte |
|---------|-------|----------|
| `src/main/main.js` | ~L1335 | `listDevicesForUI` → IPC `get-devices` (poll renderer ~12 s) |

### `global.getDevicesPollState` (`main.js` ~L356-360, ~L1380-1397)

- Objet global : `{ inProgress, startedAt, lastEndedAt }`
- Mis à jour uniquement autour du handler IPC `get-devices` (instrumentation latence / overlap poll UI)
- **Recommandation : rester séparé** — couvre `listDevicesForUI` entier (registry + enrich battery/wifi + historique), pas seulement `listUnifiedDevices` ; mutex/cache registry ne doit pas remplacer ce flag

**LOCK / vidéo :** aucun lien — `listUnifiedDevices` = découverte/registry ADB uniquement.

---

## Perf ADB — cache TTL + mutex listUnifiedDevices (2026-07-12, étape 2)

**Statut : livré — 1 commit, fichier unique `device-registry.js`.**

| Changement | Détail |
|------------|--------|
| TTL 10 s | `LIST_UNIFIED_DEVICES_CACHE_TTL_MS` — retour cache si âge < 10 s |
| Mutex | `_listUnifiedScanInProgress` — scan parallèle évité ; retourne cache existant (même expiré) ou attend la promesse en cours |
| Invalidation | Fingerprint raw ADB (`serial:status:online:transport`) — log + reset cache si topologie USB/WiFi change au début d'un scan |
| Corps scan | Déplacé dans `_executeListUnifiedDevices()` ; `listUnifiedDevices()` inchangée en signature/contrat |

### Vérification appelants (étape 3 — sans modification)

| Appelant | Comportement avec cache | Risque signalé |
|----------|-------------------------|----------------|
| `listDevicesForUI` / `get-devices` | Bénéfice direct (poll ~12 s > TTL 10 s) | Aucun |
| `discoverNewDevices` | Peut voir liste unifiée jusqu'à 10 s stale si aucun scan concurrent | **Acceptable** — double `getRawAdbDevices` reste frais ; nouveaux devices détectés au prochain scan TTL ou si topologie change |
| `buildDevicesPanelData` | `getRawAdbDevices` toujours frais pour statut USB ligne ; unified peut être cache 10 s | Faible — libellés WiFi config hors ADB peuvent lag 10 s max |
| `resolveEffectiveAdbSerial` / `resolveAdbSerialForDims` | Cache 10 s sur serial effectif | **À surveiller** au clic lancement WiFi juste après bascule transport — pas de bypass ajouté (contrainte signature unique) |
| `resolveStableDeviceIdFromTransport` | Idem | Faible |
| `buildAdbSerialToDeviceIdMap` | Idem | Faible |

**Pas de bypass cache ajouté** — aucun appelant ne requiert de modification dans ce prompt.

**LOCK / vidéo :** non touchés.

---

## Perf ADB — bypass cache lancement (`forceFresh`) (2026-07-12)

**Statut : livré — 2 commits (`device-registry.js`, `main.js`).**

| Commit | Fichier | Changement |
|--------|---------|------------|
| `9a5d05d` | `device-registry.js` | `listUnifiedDevices({ forceFresh = false })` — ignore TTL si `true`, mutex inchangé ; `resolveEffectiveAdbSerial` propage `forceFresh` |
| *(main)* | `main.js` | `resolveAdbSerialForDims` passe `forceFresh: true` aux deux branches `resolveEffectiveAdbSerial` |

### Vérification appelants `resolveAdbSerialForDims`

| Appelant | Contexte | Poll ? |
|----------|----------|--------|
| `resolveDeviceDimensionsForSerial` | Dimensions au lancement Type A/B | Non |
| `new-instance-ipc.js` | Fallback dims Type B | Non (lancement) |
| `main.js` ~L1847, L2005 | Start stream / virtual display | Non (lancement) |

**LOCK / vidéo :** non touchés.

---

## DIAGNOSTIC — Chronométrage passage USB/WiFi au lancement (2026-07-12)

**Statut : diagnostic uniquement — aucune modification du code applicatif.**

**Instrumentation :** script temporaire `scripts/_temp-diag-launch-timing.js` (supprimé après mesure). Aucun `console.time` dans `src/`.

### Mesures USB réelles (`e176518f`, cache dims vide)

| Étape | Durée | % dims (~226 ms) |
|-------|-------|------------------|
| `resolveEffectiveAdbSerial(forceFresh)` | 50 ms | 22 % |
| ↳ `getRawAdbDevices` | 48 ms | 21 % |
| ↳ `attachStableIds` (cache hit) | 0 ms | 0 % |
| `wm size` | 176 ms | **78 %** |

WiFi : **non mesuré** (appareil hors ligne ADB) — estimé 0,5–2,5 s froid (`attachStableIds` + `wm size`).

### Causes principales

1. **`wm size` domine le chemin dims sur USB** (78 %).
2. **`forceFresh` annule le bénéfice cache** (~50 ms scan USB à chaque lancement avec `stableDeviceId`).
3. **Raccourci USB contourné** : branche `stableDeviceId` avant `isLikelyUsbTransportSerial` dans `resolveAdbSerialForDims`.
4. **Mutex + poll `get-devices`** : attente scan concurrent + contention ADB (`enrichDevicesWithStatus`).
5. **Type B** : dims résolues 2–3× (`launch` + `start`).
6. **Post-dims** : scrcpy start / display virtuel (LOCK) — dominant du clic→frame total.

**LOCK / vidéo :** causes registry hors flux stream ; goulet global post-dims dans zones LOCK non modifiées.

---

## Fix — raccourci USB avant forceFresh (2026-07-12)

**Statut : livré — `main.js` uniquement.**

| Changement | Détail |
|------------|--------|
| `resolveAdbSerialForDims` | `isLikelyUsbTransportSerial(serial)` testé **en premier** → retour direct du serial USB, sans `resolveEffectiveAdbSerial` |
| WiFi inchangé | `forceFresh: true` conservé sur les branches registry (serial WiFi / `stableDeviceId`) |

**LOCK / vidéo :** non touchés.

---

## DIAGNOSTIC — Cache wm size / dims Type B redondantes (2026-07-12)

**Statut : diagnostic uniquement — aucune modification code ; pas d'instrumentation temporaire.**

### Partie 1 — Cache existant (`deviceDimensionsCache`, TTL 60 s)

- Écriture : `resolveDeviceDimensionsForSerial` (~L458-460) sous clés `adbSerial` + `serial` transport.
- Lecture : `readCachedDeviceDimensions` (~L343-352) ; priorité dims input controller si session active.
- `getDeviceDimensions` (`device-orientation-manager.js` ~L46) : pas de cache propre.

**Pourquoi insuffisant aujourd'hui :** (1) 1er lancement toujours froid ~176 ms USB ; (2) `resolveAdbSerialForDims` exécuté avant lecture cache à chaque `resolveDeviceDimensionsForSerial` ; (3) fallback `resolveLaunchDims` L24-31 appelle `getDeviceDimensions` sans remplir `deviceDimensionsCache` ; (4) clé `entry.deviceId` vs serial transport peut rater le cache.

**Dims changeantes pendant lancement :** rotation/`wm override` = marginal ; display virtuel Type B n'altère pas `Physical size`.

### Partie 2 — Appels Type B

| Étape | Fichier | Lignes |
|-------|---------|--------|
| Launch | `main.js` | L1851 (+ L1853-1854 retry 400 ms si null) |
| Start | `new-instance-ipc.js` | L52 `resolveLaunchDims` ; L94 si L52 null |

**`wm size` réels typiques :** Type A froid **1×** ; Type B happy path **1×** (start = cache hit L5) ; pire cas launch retry + fallback **jusqu'à 4×**.

Retry 400 ms : 2ᵉ `wm size` **uniquement** si 1ᵉʳ appel retourne `null`.

### Partie 3 — LOCK

`new-instance-manager.js` et `scrcpy-socket.js` : **aucun** appel dims/wm size.

---

## FIX — Fallback resolveLaunchDims écrit deviceDimensionsCache (2026-07-12)

**Commit étape 1** — `writeDeviceDimensionsCache` (`main.js`) + fallback `resolveLaunchDims` (`new-instance-ipc.js`).

- Si le fallback `getDeviceDimensions` réussit, écriture cache sous clés `serial` + `adbSerial` (même logique que `resolveDeviceDimensionsForSerial`).
- Retry inchangé. Type A non touché. LOCK non touchés.

---

## FIX — Propagation launchDims launch → start Type B (2026-07-12)

**Commit étape 2** — `main.js` + `new-instance-ipc.js`.

- `new-instance:launch` stocke `launchDims` dans `externalLaunches[launchId]`.
- `new-instance:create` copie via `getExternalLaunchLaunchDims(externalLaunchId)` sur l'objet session (`session.launchDims`, sans modifier `new-instance-manager.js`).
- `resolveLaunchDims` accepte `preresolvedDims` : réutilisation directe au `start`, sans `readCachedDeviceDimensions` ni `resolveDeviceDimensionsForSerial`.
- Type A non touché. LOCK non touchés.

---

**Statut : livré — 2 commits, 1 fichier par patch.**

| Commit | Fichier | Changement |
|--------|---------|------------|
| `aad55b3` | `src/renderer/apps/AppLauncherSearch.js` | `SEARCH_DEBOUNCE_MS = 100` ; `_onSearchInput` debounce via `clearTimeout`/`setTimeout` avant `filterAndRender` ; cleanup timer dans `destroy()` |
| `28344f4` | `src/renderer/apps/AppList.js` | Même délai 100 ms sur `_handleSearchInput` → `setSearchQuery` ; cleanup timer dans `destroy()` |

**Comportement :** la logique filtre/tri/render (`filterAndRender`, `applyFilter`) est inchangée ; seul le déclenchement depuis l'événement `input` est différé. Les appels programmatiques (`loadForDevice`, `setItems`, `resetSearch`, `updateMetadata`) restent immédiats.

**LOCK intact** : aucun fichier scrcpy-socket / new-instance-manager / input / Type A-B / `createSession` touché.

Référence diagnostic : rapport CPU 2026-07-11 (P0 — recherche apps sans debounce).

---

## Presets d'affichage session — commit 1 (2026-07-09)

**Statut : commit 1 livré — manager + persistance. IPC / UI / nouvelles sessions : commits suivants.**

### Fichiers

| Fichier | Changement |
|---------|------------|
| `src/main/managers/display-presets-manager.js` | **Nouveau** — CRUD presets nommés (`width`, `height`, `maxFps`, `bitRateMbps`) ; `defaultPreset` ; seed `full-hd` (= anciens défauts) |
| `src/main/main.js` | `global.displayPresetsManager = new DisplayPresetsManager(userDataPath)` |

### Persistance

- Chemin : `{userData}/display-presets.json`
- Schéma : `{ "defaultPreset": "full-hd", "presets": [{ "id", "name", "width", "height", "maxFps", "bitRateMbps" }] }`
- `resolveParams(presetId)` : merge champs preset + `dpi` / `iFrameInterval` depuis `DEFAULT_STREAM_PARAMS` (`stream-params.js`)

### API manager (main process)

| Méthode | Rôle |
|---------|------|
| `list()` | Liste + `defaultPreset` |
| `getDefault()` | Preset par défaut + `params` normalisés |
| `resolveParams(presetId?)` | Params flux complets pour `toScrcpyOptions()` |
| `savePreset({ name, params })` | Ajoute un preset (id slug unique) |
| `setDefaultPreset(presetId)` | Définit le preset pour nouvelles sessions (commit 3) |
| `deletePreset(presetId)` | Supprime (garde au moins un preset) |
| `getAllowedOptions()` | Valeurs autorisées (miroir `CONTROL_OPTIONS`) |

**LOCK intact** : aucun fichier scrcpy-socket / new-instance-manager / input / Type A-B modifié.

---

## Presets d'affichage session — commit 2 (2026-07-09)

**Statut : commit 2 livré — IPC + preload renderer.**

### Fichiers

| Fichier | Changement |
|---------|------------|
| `src/main/ipc/display-presets-handlers.js` | **Nouveau** — handlers IPC |
| `src/main/main.js` | `registerDisplayPresetsHandlers()` |
| `src/preload/preload.js` | `window.displayPresetsAPI` |

### IPC (`display-presets:*`)

| Canal | Rôle |
|-------|------|
| `list` | Liste presets + `defaultPreset` |
| `get-default` | Preset par défaut + `params` |
| `resolve-params` | Params normalisés pour un `presetId` |
| `get-allowed-options` | Résolutions / fps / bitrates autorisés |
| `save` | `{ name, params }` → nouveau preset |
| `set-default` | `{ presetId }` |
| `delete` | `{ presetId }` |

Push renderer : `display-presets:updated` (fenêtre principale + hub modal) après save / set-default / delete.

### Preload (`displayPresetsAPI`)

`list`, `getDefault`, `resolveParams`, `getAllowedOptions`, `save`, `setDefault`, `delete`, `onUpdated`.

---

## Presets d'affichage session — commit 3 (2026-07-09)

**Statut : commit 3 livré — défaut sur nouvelles sessions.**

### Fichier

| Fichier | Changement |
|---------|------------|
| `src/renderer/new-session.js` | `resolveDefaultLaunchStreamParams()` + `buildDefaultScrcpyOptions(type)` |

### Comportement

| Lancement | Avant | Après |
|-----------|-------|-------|
| **Type A** (`launchMirrorSession`) | `toScrcpyOptions(DEFAULT_STREAM_PARAMS, "A")` | `toScrcpyOptions(defaultPreset.params, "A")` via IPC |
| **Type B** (`launchTypeBSession`) | `streamOptions` = flags seulement | merge `toScrcpyOptions(defaultPreset.params, "B")` + `stayAwake` / `turnScreenOff` / `audio: false` |

Fallback si `displayPresetsAPI` indisponible : `StreamParams.DEFAULT_STREAM_PARAMS` (comportement inchangé).

**LOCK intact** : `new-instance-manager.js` non modifié — reçoit `streamOptions` enrichis en amont.

---

## Presets d'affichage session — commit 4 (2026-07-09)

**Statut : commit 4 livré — UI panneau Contrôle.**

### Fichiers

| Fichier | Changement |
|---------|------------|
| `src/renderer/hub-modal/hub-modal-window.html` | Section presets (select, checkbox, boutons) |
| `src/renderer/control-panel/ControlPanel.js` | Chargement presets, save, défaut, draft depuis preset |
| `src/renderer/styles/control-panel.css` | Styles section presets |
| `src/shared/locales/{fr,en}.json` + `src/renderer/locales/{fr,en}.json` | Clés `controlPanel.presets.*` |

### UI

- **Sélecteur** : charge le draft (résolution / fps / bitrate) sans appliquer à la session
- **Enregistrer le réglage actuel** : champ nom → `displayPresetsAPI.save`
- **Définir par défaut** : checkbox → `setDefault` pour le preset sélectionné (★ dans la liste)
- **Appliquer à toutes les instances** : `displayPresetsAPI.updateDefaultFromParams` → prochains lancements

---

## Presets d'affichage session — étape A retrait commit 5 (2026-07-09)

**Statut : étapes A–C terminées.**

| Étape | Rôle |
|-------|------|
| A | Retrait `applyParamsToAllSessions` (restart global) |
| B | `updateDefaultFromParams` — écrase `defaultPreset` |
| C | UI : bouton → `displayPresetsAPI.updateDefaultFromParams` |

### Comportement final « Appliquer à toutes les instances »

- Écrit le draft (résolution / fps / bitrate) dans le preset `defaultPreset`
- `new-session.js` lit ce preset au **prochain** lancement Type A / B
- Sessions **actives** : inchangées (sauf « Appliquer » manuel sur une session)

---

## DIAGNOSTIC — Worker apps (fork) — Étape 1 lecture seule (2026-07-09)

**Statut : diagnostic terminé — aucun patch code. En attente validation plan + règle rétention historique.**  
**Objectif :** déporter liste apps / logos / historique dans `child_process.fork()` pour libérer le main process, **sans toucher au LOCK** (§ rappel ci-dessous).

### Rappel LOCK (inchangé)

Ne pas modifier : `scrcpy-socket.js`, `new-instance-manager.js`, `createSession()`, fichiers input, flag `--new-display`, logique sessions Type A / Type B.

---

### 1. Où sont gérés app list / logos / historique ?

| Domaine | Fichier(s) | Fonctions / rôle |
|---------|------------|------------------|
| **Liste apps installées** | `src/main/managers/device-manager.js` | `getInstalledApps`, `getInstalledAppsWithDetails`, `_fetchAllPackages`, `getInstalledPackagesByUser`, `getUserIds` |
| **IPC liste apps** | `src/main/main.js` | `ipcMain.handle("device:apps")`, `ipcMain.handle("get-apps")` |
| **Enrichissement cache logos** | `src/main/managers/app-metadata-manager.js` | `enrichApps`, `resolveOne`, `queuePrefetch`, `enrichHistoryEntries`, `mergeAppMetadata` |
| **Extraction icône APK** | `src/main/managers/app-icon-extractor.js` | `extractIcon`, `getAllApkPathsOnDevice`, `pullApk`, `extractIconFromApk` |
| **IPC métadonnées** | `src/main/ipc/appMetadataHandlers.js` | `app-metadata:resolve`, `app-metadata:prefetch` ; monkey-patch `getInstalledAppsWithDetails` → `enrichApps` |
| **Historique lancement** | `src/main/managers/launch-history-manager.js` | `recordLaunch`, `list`, `remove`, `pruneStale`, `migrateDeviceIdsToStable` |
| **IPC historique** | `src/main/ipc/launchHistoryHandlers.js` | `launch-history:list`, `launch-history:record`, `launch-history:remove` |
| **Init main** | `src/main/main.js` (~L1122–1164) | `new AppMetadataManager`, `attachAppMetadataPrefetch`, `new LaunchHistoryManager`, handlers IPC |
| **Enregistrement historique Type B** | `src/main/ipc/new-instance-ipc.js` (~L65–87) | `launchHistoryManager.recordLaunch` après `startNewInstanceSession` (lecture cache icône via `appMetadataManager`) |
| **Preload renderer** | `src/preload/preload.js` | `getAppsWithDetails`, `resolveAppMetadata`, `prefetchAppMetadata`, `launchHistoryAPI.*` |
| **UI** | `src/renderer/new-session.js`, `AppLauncherSearch.js`, `AppList.js`, `Sidebar.js` | Affichage liste / historique / hydratation icônes |

**Verdict :** tout le métier lourd est aujourd'hui dans le **main process** (managers + IPC), pas dans le renderer.

---

### 2. Appels ADB utilisés (liste apps + icônes)

| Étape | Commande ADB / outil | Fichier |
|-------|----------------------|---------|
| Profils Android | `shell pm list users` | `device-manager.js` |
| Liste packages | `shell pm list packages -3 -l --user {N}` (fallback sans `-l`) | `device-manager.js` |
| Chemins APK | `shell pm path [--user N] {package}` | `app-icon-extractor.js` |
| Pull APK | `pull {remoteApk} {local}` (timeout 45 s) | `app-icon-extractor.js` |
| Label app (optionnel) | `shell pm dump [--user N] {package}` (timeout 12 s) | `app-metadata-manager.js` |
| versionCode (hors prefetch) | `shell dumpsys package [--user N] {package}` (timeout 12 s) | `app-metadata-manager.js` |
| Extraction locale | `tar -xf {apk} -C {dir}` (pas ADB) | `app-icon-extractor.js` |

**Concurrence prefetch :** `PREFETCH_CONCURRENCY = 2` dans `app-metadata-manager.js` — jusqu'à 2 extractions parallèles par appareil.

---

### 3. Async vs bloquant — impact event loop main

| Type | Détail | Bloquant main ? |
|------|--------|-----------------|
| **ADB** | `child_process.exec` enveloppé en `Promise` (`execPromise` / `execWithTimeout`) | **Non** pendant l'attente I/O (async) |
| **Cache JSON** | `readFileSync` / `writeFileSync` (`launch-history.json`, `app-metadata-cache.json`) | **Oui** — pics courts ; `saveIndex` déjà debouncé (500 ms) côté métadonnées |
| **Extraction icône** | `readdirSync`, `readFileSync`, `rmSync`, `copyFileSync`, `statSync`, `existsSync` dans `app-icon-extractor.js` | **Oui** — **principal risque** : arborescence APK + `tar` sur le thread Node du main |
| **Lookup cache** | `isFresh` → `existsSync` (atténué par `_verifiedIconPaths` en mémoire) | Faible si cache chaud |
| **enrichApps** | Merge mémoire uniquement (prune retiré du hot path, 2026-07-08) | Faible |

**Verdict :** les appels ADB sont async, mais **le CPU/disque synchrone** (tar, walk `res/`, écritures JSON) sur le main process peut retarder IPC sessions / scrcpy pendant un chargement apps ou prefetch icônes. Un worker isolé déplace ce coût hors du main.

**Référence pattern existant :** `SessionAudioProcessManager` utilise `spawn` (scrcpy audio) — pas de `fork` métier aujourd'hui ; le worker apps sera le **premier fork dédié données**.

---

### 4. Cache logos — existe déjà

| Stockage | Chemin | Contenu |
|----------|--------|---------|
| **Index métadonnées** | `{userData}/app-metadata-cache.json` | Clé `deviceId::packageName::userId`, `appName`, `iconPath`, `iconAttempts`, `versionCode`, `fetchedAt` |
| **PNG icônes** | `{userData}/app-icons/{deviceId}/{package}[@uN].png` | Fichiers raster (seuil min 1 Ko, filtre faux positifs) |
| **URL renderer** | `file://` via `pathToFileURL` | Exposé comme `iconUrl` |
| **TTL** | 7 jours (`CACHE_TTL_MS`) | Entrée sans icône : retry max 3 (`iconAttempts`) |
| **Historique** | `{userData}/launch-history.json` | Entrées par clé `deviceId::packageName::userId` |

**Verdict :** le cache est **persistant entre redémarrages** — pas de re-extraction systématique. Le worker **doit réutiliser les mêmes chemins `{userData}`** pour compatibilité.

---

### 5. Historique — règle de rétention actuelle (à confirmer)

| Règle | Valeur | Fichier |
|-------|--------|---------|
| Auto-suppression | Entrées **> 2 jours** sans lancement récent | `TWO_DAYS_MS` dans `launch-history-manager.js` |
| Exception | Entrées dont la clé est dans **sessions Type B actives** (`getActiveTypeBKeys`) | Callback injecté depuis `main.js` → lit `newInstanceManager` + `browserViewManager` (**lecture seule**, pas de patch LOCK) |
| Fréquence prune | Toutes les **6 h** + à chaque `list()` | `PRUNE_INTERVAL_MS` |
| Purge manuelle | `purgeOlderThan(cutoffMs)` via maintenance | `maintenance-cleanup-manager.js` |

**Question ouverte pour le mainteneur :** conserver **2 jours / exception sessions actives / prune 6 h**, ou ajuster avant implémentation worker ?

---

### 6. Plan d'implémentation proposé (après validation)

**Principe :** le main process **relaye uniquement** (résolution serial stable → worker → réponse UI). Managers existants **réutilisés dans le worker** (pas de duplication métier) ; bridge IPC typé.

#### Fichiers à créer (hors LOCK)

| Fichier | Rôle |
|---------|------|
| `src/main/workers/apps-worker.js` | Process enfant `fork()` : instancie `DeviceManager` (partie apps), `AppMetadataManager`, `LaunchHistoryManager` avec `{userData, adbPath}` |
| `src/main/managers/apps-worker-bridge.js` | Lifecycle fork, file de requêtes, timeout, crash → restart / fallback in-process |

#### Messages IPC worker (proposition)

| Type | Direction | Payload | Réponse |
|------|-----------|---------|---------|
| `INIT` | main → worker | `{ userDataPath, adbPath }` | `{ ok }` |
| `GET_APP_LIST` | main → worker | `{ transportSerial, cacheDeviceId, adbSerial }` | `{ apps }` |
| `ENRICH_APPS` | main → worker | `{ transportSerial, cacheDeviceId, apps[] }` | `{ apps }` |
| `RESOLVE_APP_METADATA` | main → worker | `{ deviceId, packageName, userId, appNameHint? }` | `{ metadata }` |
| `PREFETCH_APP_METADATA` | main → worker | `{ deviceId, apps[], maxCount }` | `{ ok }` (+ push `METADATA_UPDATED` worker → main) |
| `GET_HISTORY` | main → worker | `{ activeKeys?: string[] }` | `{ entries }` |
| `ADD_HISTORY_ENTRY` | main → worker | `{ deviceId, packageName, appName, iconPath?, userId? }` | `{ entry }` |
| `REMOVE_HISTORY_ENTRY` | main → worker | `{ key \| deviceId+packageName+userId }` | `{ success }` |
| `SHUTDOWN` | main → worker | — | process exit |

**Note :** `activeKeys` pour prune/list fourni par le **main** (calcul `getActiveTypeBHistoryKeys` inchangé) — évite d'importer `new-instance-manager.js` dans le worker.

#### Fichiers main à modifier (minimal, hors LOCK)

| Fichier | Changement |
|---------|------------|
| `src/main/main.js` | Init / shutdown bridge ; `device:apps` délègue au worker |
| `src/main/ipc/appMetadataHandlers.js` | Handlers → bridge |
| `src/main/ipc/launchHistoryHandlers.js` | Handlers → bridge |
| `src/main/ipc/new-instance-ipc.js` | `recordLaunch` → bridge (**1 appel**, pas de changement `startNewInstanceSession`) |

#### Fichiers LOCK — non touchés

`scrcpy-socket.js`, `new-instance-manager.js`, `session.js` (input), `adb-input-controller.js`, `createSession()`, routage input Type A/B.

#### Lifecycle / robustesse

1. **Démarrage :** `fork` après `app.whenReady`, message `INIT` avec chemins `userData` + `adbPath`.
2. **Quit :** `app.on("before-quit")` → `SHUTDOWN` + `worker.kill()` ; `unref` timer prune dans worker.
3. **Crash worker :** log + restart (max 3) ; si échec → **fallback in-process** temporaire (managers actuels sur main) pour ne pas casser l'UI.
4. **Push prefetch :** worker envoie `METADATA_UPDATED` → bridge relaye `app-metadata:updated` vers renderer (comportement actuel).

#### Phases livraison

| Phase | Contenu | Test manuel |
|-------|---------|-------------|
| **P0** | Bridge + worker skeleton ; historique (`GET/ADD/REMOVE`) | Ouvrir Nouvelle instance → historique OK |
| **P1** | `GET_APP_LIST` + `ENRICH_APPS` | Liste apps charge ; session Type A/B reste fluide pendant chargement |
| **P2** | `RESOLVE` + `PREFETCH` icônes | Logos apparaissent ; pas de freeze main |
| **P3** | Shutdown propre + crash recovery | Quit app → pas de zombie ; kill worker → retry OK |

#### Test manuel cible (section 5 livrable)

1. Démarrer session Type B active (flux + input).
2. Ouvrir panneau Nouvelle instance → charger liste apps (200+ packages).
3. Vérifier : pas de freeze input/vidéo ; batterie sidebar inchangée ; historique + icônes OK après prefetch.

---

### 7. Décision requise avant code

- [x] Valider le plan phases P0–P3 (**P0 validé 2026-07-09**)
- [x] Confirmer règle rétention historique (2 j / exception Type B actif / prune 6 h) — **conservée**
- [x] Valider `new-instance-ipc.js` — **inchangé** ; `global.launchHistoryManager` = facade bridge

---

## IMPL — Worker apps P0 historique (2026-07-09)

**Statut : ✅ implémenté (P0).** LOCK intact.

### Fichiers ajoutés

| Fichier | Rôle |
|---------|------|
| `src/main/workers/apps-worker.js` | Process enfant : `INIT`, historique P0, `GET_APP_LIST`, `ENRICH_APPS` P1, `SHUTDOWN` |
| `src/main/managers/apps-worker-bridge.js` | `fork()`, requêtes corrélées, restart (max 3), fallback in-process, facade `global.launchHistoryManager` |

### Fichiers modifiés (hors LOCK)

| Fichier | Changement |
|---------|------------|
| `src/main/main.js` | Bootstrap migration → worker ; shutdown `before-quit` |
| `src/main/ipc/launchHistoryHandlers.js` | Délégation au bridge |
| `src/main/managers/launch-history-manager.js` | Option `enablePruneTimer` (désactivé dans worker ; prune via `list` + `activeKeys` main) |

### Messages IPC worker (P0)

| Type | Sens |
|------|------|
| `INIT` | `{ userDataPath, adbPath }` |
| `GET_HISTORY` | `{ activeKeys }` ← `getActiveTypeBHistoryKeys()` main |
| `ADD_HISTORY_ENTRY` | payload `recordLaunch` |
| `REMOVE_HISTORY_ENTRY` | payload `remove` |
| `PURGE_HISTORY_OLDER_THAN` | maintenance cleanup |
| `SHUTDOWN` | quit propre worker |

### Test manuel P0

1. Ouvrir Nouvelle instance → historique visible.
2. Lancer Type B → entrée ajoutée à l'historique.
3. Supprimer une entrée historique → OK.
4. Quit app → pas de process `apps-worker` zombie (Task Manager).

### Prochaine étape (P0)

~~**P1** — `GET_APP_LIST` + `ENRICH_APPS` dans le worker.~~ → voir section IMPL P1 ci-dessous.

---

## IMPL — Worker apps P1 liste + enrich (2026-07-09)

**Statut : ✅ implémenté (P1).** LOCK intact.

### Changements

| Fichier | Changement |
|---------|------------|
| `src/main/workers/apps-worker.js` | `INIT` reçoit `adbPath` ; instancie `DeviceManager` + `AppMetadataManager` ; handlers `GET_APP_LIST`, `ENRICH_APPS` |
| `src/main/managers/apps-worker-bridge.js` | `getAppList(serial)`, `enrichApps(serial, apps)` ; timeout 90 s liste ; fallback in-process via `setAppListFallback` |
| `src/main/main.js` | `device:apps` → bridge ; `adbPath` passé au `start()` ; fallback `deviceManager` + `appMetadataManager` |

### Messages IPC worker (P1)

| Type | Payload | Réponse |
|------|---------|---------|
| `INIT` | `{ userDataPath, adbPath }` | `{ ready: true }` |
| `GET_APP_LIST` | `{ transportSerial, cacheDeviceId, adbSerial }` | `{ apps }` — `pm list` (adbSerial) + enrich (cacheDeviceId) |
| `ENRICH_APPS` | `{ transportSerial, cacheDeviceId, apps[] }` | `{ apps }` — cache métadonnées uniquement |

**Note :** clé cache unifiée via `cacheDeviceId` résolu sur le main — voir **P1.5** ci-dessous. Prefetch icônes (`resolveOne`) reste sur main → **P2**.

### Test manuel P1

1. Ouvrir Nouvelle instance → liste apps charge (200+ packages).
2. Pendant chargement : session Type B active — input/vidéo fluides.
3. Icônes en cache visibles ; nouvelles icônes via prefetch main (P2).
4. `await electronAPI.debugCrashWorker()` → fallback ; recharger liste apps → OK.

---

## IMPL — Worker apps P1.5 unification cache deviceId (2026-07-09)

**Statut : ✅ implémenté (P1.5).** LOCK intact.

### Problème P1

Le worker n'a pas accès à `global.deviceRegistry` : `enrichApps` utilisait le serial transport (`ABC123` USB vs `192.168.x.x:5555` WiFi) comme clé cache → entrées dupliquées ou miss (icônes prefetchées sous `ro.serialno` introuvables après switch transport).

### Correctif

Le **main** résout l'identité avant chaque appel worker (pattern Hub existant) ; le worker consomme les champs sans importer `device-registry`.

| Fichier | Changement |
|---------|------------|
| `src/main/main.js` | `resolveAppListDeviceContext()` : `resolveStableDeviceIdFromTransport` + `resolveEffectiveAdbSerial` ; `device:apps` passe `{ transportSerial, cacheDeviceId, adbSerial }` |
| `src/main/managers/apps-worker-bridge.js` | `getAppList(ctx)`, `enrichApps(ctx, apps)` — payload IPC aligné plan diagnostic |
| `src/main/workers/apps-worker.js` | `GET_APP_LIST` : `adbSerial` pour ADB, `cacheDeviceId` pour cache ; `ENRICH_APPS` : `cacheDeviceId` + `transportSerial` |
| `src/main/managers/app-metadata-manager.js` | `enrichApps(serial, apps, { cacheDeviceId, transportSerial })` — bypass `resolveDeviceContext` si contexte fourni |

### Messages IPC worker (P1.5)

| Type | Payload | Usage |
|------|---------|-------|
| `GET_APP_LIST` | `{ transportSerial, cacheDeviceId, adbSerial }` | ADB → `adbSerial` ; index cache → `cacheDeviceId` ; lookup cascade inclut `transportSerial` |
| `ENRICH_APPS` | `{ transportSerial, cacheDeviceId, apps[] }` | idem enrich sans `pm list` |

### Test manuel P1.5

1. Ouvrir Nouvelle instance en **USB** → liste apps avec logos (prefetch ou cache existant).
2. Basculer le même appareil en **WiFi** (sans débrancher physiquement si possible).
3. Rouvrir / rafraîchir la liste apps sur le transport WiFi.
4. **Attendu :** logos et noms inchangés (cache partagé sous `cacheDeviceId` stable) — pas de placeholders, pas de re-extraction APK.
5. Logs `[device:apps]` : `cache=<ro.serialno>` identique USB et WiFi ; `adb=` change selon transport.

### Prochaine étape (après P1.5)

**P2** — `RESOLVE_APP_METADATA` + `PREFETCH_APP_METADATA` dans le worker (+ push `METADATA_UPDATED`).

---

## IMPL — Nettoyage cache icônes stale (2026-07-09)

**Statut : ✅ implémenté (2026-07-09).** LOCK intact (hors `app-metadata-manager.js`).

### Journal

- 2026-07-09 — Demande correctif cache stale (`iconPath` JSON présent, fichier PNG absent). Périmètre : **tous les `deviceId`** du cache (`e176518f`, `a3acba7c`, `192.168.1.10:5555`, `192.168.1.11:5555`, …).

### Diagnostic pré-code (§2)

#### Où `enrichApps()` lit `iconPath` ?

Chaîne complète dans `src/main/managers/app-metadata-manager.js` :

| Étape | Lignes | Rôle |
|-------|--------|------|
| `enrichApps()` | 469–481 | Délègue à `mergeAppMetadata()` par app |
| `mergeAppMetadata()` | 445–467 | `lookupCacheEntry` → `getCachedEntry` → lit `cached?.iconPath` / `cached?.iconUrl` |
| `lookupCacheEntry()` | 179–186 | Parcourt `this.index[key]` ; filtre via `isFresh(entry)` |
| `getCachedEntry()` | 228–232 | `formatCachedEntry(found.entry)` |
| `formatCachedEntry()` | 147–155 | `iconPath` exposé **uniquement si** `hasUsableIcon(entry)` (fichier ≥ 1 Ko) |
| `isFresh()` | 118–127 | Si `iconPath` absent → fresh ; si `_verifiedIconPaths` contient le chemin → fresh **sans re-vérifier le disque** ; sinon `fs.existsSync` |

**Important :** `enrichApps` n'affiche en général **pas** un `iconPath` stale (fichier absent) grâce à `hasUsableIcon` / `isFresh`. Le bug opérationnel est **en amont** :

1. **Index JSON pollué** : `iconPath` non null alors que le PNG n'existe plus → état incohérent pour `needsIconExtraction` / prefetch / logs.
2. **`_verifiedIconPaths` (mémoire)** : si le fichier a été supprimé après une vérification réussie dans la même session, `isFresh()` peut retourner `true` sans `existsSync` (l.122) → entrée traitée comme valide jusqu'au redémarrage.
3. **Prefetch plafonné à 16 apps** (cause séparée) : même après nettoyage, seules 16 apps/session sont candidates à `resolveOne`.

#### `rejectFalsePositiveCacheEntry` — existe ? rôle ?

**Oui**, `app-metadata-manager.js` l.157–177. Appelée **uniquement** depuis `resolveOne()` (l.374) quand :

- une entrée cache est trouvée,
- l'icône n'est pas utilisable,
- et `shouldRetryIconExtract` est encore vrai.

**Comportement actuel :**

1. Supprime le fichier PNG s'il existe encore (`unlinkSync`).
2. Réécrit l'entrée via `setCachedEntry` avec `iconPath: null`.
3. **Incrémente** `iconAttempts` (plafonné à `MAX_ICON_EXTRACT_ATTEMPTS`).

Ne s'applique **pas** aux entrées stale jamais repassées par `resolveOne` (prefetch hors batch, ou session longue avec `_verifiedIconPaths`).

#### Où faire la vérification d'existence ? (a / b / c)

| Option | Verdict |
|--------|---------|
| **(a) À la lecture** (`enrichApps` / `lookupCacheEntry`) | Utile pour corriger `_verifiedIconPaths` à chaud, mais coûteux si scan complet à chaque liste (52–200+ apps × `access`). |
| **(b) Tâche ponctuelle au démarrage** | **Recommandé principal** : scan async une fois par process (main + worker fork), tous `deviceId`, persiste le JSON nettoyé. |
| **(c) Les deux** | **Retenu** : (b) scan complet async au init + `await` du même promise au début de `enrichApps()` / `queuePrefetch()` pour garantir cohérence avant lecture (sans re-scan si déjà fait). Pas de `existsSync` en boucle synchrone sur le main. |

#### `iconAttempts` après invalidation stale ?

**Garder le compteur existant** (ne pas remettre à 0).

| Raison |
|--------|
| Stale ≠ échec d'extraction ; souvent fichier supprimé / migration / `rejectFalsePositive` partiel. |
| Remettre à 0 relancerait 3 tentatives sur des apps **déjà** à 2–3 échecs réels → boucle inutile. |
| Entrées **abandonnées légitimes** (`iconPath` null, `iconAttempts ≥ 3`) : **non touchées** (skip `!entry.iconPath`). |
| Cas limite `iconPath` set + `iconAttempts ≥ 3` + fichier absent : nettoyer `iconPath` seulement, **conserver** `attempts ≥ 3` → pas de nouvelle extraction (échec réel antérieur). |

### Plan d'implémentation (avant code)

| # | Action | Fichier |
|---|--------|---------|
| 1 | `async isIconFileAccessible(iconPath)` — `fs.promises.access` + `stat` (≥ `MIN_ICON_FILE_BYTES`) | `app-metadata-manager.js` |
| 2 | `async pruneStaleIconCacheEntries()` — parcours **tout** `this.index` ; si `iconPath` truthy et fichier invalide → `iconPath = null`, purge `_verifiedIconPaths`, **conserver** `iconAttempts` | idem |
| 3 | Logger : total invalidé + répartition par `deviceId` | idem |
| 4 | Déclencher : constructeur (`void prune…()`) + `await` même promise en tête de `enrichApps()` / `queuePrefetch()` | idem |
| 5 | Ne pas toucher : entrées sans `iconPath` (dont 17 abandonnées e176518f) | idem |

**Hors scope immédiat (causes séparées) :** quota prefetch 16, `MAX_APK_PULL_ATTEMPTS`, extracteur adaptive-icon.

### Implémentation livrée

| Fichier | Changement |
|---------|------------|
| `src/main/managers/app-metadata-manager.js` | `isIconFileAccessible()` (async) ; `pruneStaleIconCacheEntries()` (tous deviceId) ; appel au constructeur + avant `enrichApps` / `queuePrefetch` ; `isFresh()` ne fait plus confiance à `_verifiedIconPaths` sans vérif disque |

### Test manuel

1. Avant fix : compter entrées stale dans JSON (`iconPath` non null, fichier absent) — tous `deviceId`.
2. Relancer l'app → log `[AppMetadataManager] prune stale icon cache: N entrée(s)…` avec détail par device.
3. Réinspecter JSON : `iconPath` null pour les anciennes stale ; `iconAttempts` inchangé.
4. Nouvelle instance sur `e176518f` → apps stale redeviennent éligibles `needsIconExtraction` (si `iconAttempts < 3`).
5. Autres devices (`a3acba7c`, `192.168.1.10:5555`, …) : vérifier dans JSON post-fix même nettoyage (pas d'appareil requis si 0 PNG physique).

### Prochaine étape (après stale cache)

Prefetch élargi + déport worker (P2) — voir section ci-dessous.

---

## IMPL — P2 prefetch icônes étendu + worker (2026-07-09)

**Statut : ✅ implémenté (2026-07-09).** LOCK intact.

### Journal

- 2026-07-09 — Demande : étendre le prefetch à **toutes** les apps (52 typiques), arrière-plan non bloquant, fusion avec P2 (worker). Hors scope : extracteur adaptive-icon (YouTube Music, Spotify, AR Core…).

### Diagnostic pré-code (§2)

#### Où tourne le prefetch aujourd'hui ?

**100 % main process** — le worker apps (P1/P1.5) ne gère **pas** encore le prefetch.

| Étape | Emplacement | Fichier / ligne |
|-------|-------------|-----------------|
| Déclenchement UI | Renderer après chargement liste | `new-session.js` l.189–213 `scheduleAppsMetadataPrefetchOnce` |
| IPC | `app-metadata:prefetch` | `preload.js` → `appMetadataHandlers.js` l.23–37 |
| Orchestration | `queuePrefetch` → `resolveOne` → `extractIcon` | `app-metadata-manager.js` l.542–620 |
| Instance utilisée | `getAppMetadataManager()` sur **main** | `main.js` l.1174–1179 (`notifyUpdate` → `app-metadata:updated`) |
| Worker fork | `GET_APP_LIST` + `ENRICH_APPS` uniquement | `apps-worker.js` — **pas** de `PREFETCH_APP_METADATA` |

Le worker instancie déjà `AppMetadataManager` (enrich cache) mais **sans** `notifyUpdate` et sans handler prefetch. Le CPU/disque sync (`tar`, walk `res/`) du prefetch bloque encore le **main** pendant les extractions.

#### `PREFETCH_CONCURRENCY = 2` — choix ou arbitraire ?

**Choix délibéré de modération ADB**, documenté dans le diagnostic worker (`PROGRESS_CHECK.md` § worker apps l.50) : « jusqu'à 2 extractions parallèles par appareil ».

| Contexte audit perf | Observation |
|---------------------|-------------|
| `connectSockets` benchmark isolé | ~9–30 ms |
| `connectSockets` avec session + audio + polls | **457–497 ms** (×14) — contention ADB / charge parallèle |
| Prefetch actuel | 2× (`pm path` + `pull` + parfois `pm dump`) en parallèle sur le **même serial** |

**Verdict :** augmenter à 3–4 **possible** mais **non recommandé** tant qu'une session Type A/B + audio est active sur le même appareil. **Garder 2** pour le second passage (plan §3) ; réévaluer après mesure si sessions fermées.

#### Estimation temps total (36 apps positions 17–52, hors cache)

Timeouts codés (plafonds, pas temps typiques) : `pm path` 20 s, `pull` 45 s, `tar` 30 s, `pm dump` 12 s (`app-icon-extractor.js` / `app-metadata-manager.js`).

**Temps observés sur `e176518f` (diagnostic 2026-07-09) :**

| Opération | Mesure réelle |
|-----------|---------------|
| `pm path` | < 1 s |
| `adb pull` base.apk (ARCore 52 Mo) | **~1,3 s** |
| `extractIcon` Cast WebVideo (succès) | **~quelques s** (total pipeline) |
| `extractIcon` ARCore (échec raster) | pull OK, extract `null` en ~tens of s (2 APK max) |

**Estimation second passage (36 apps, concurrence 2) :**

| Scénario | Calcul | Durée indicative |
|----------|--------|------------------|
| Optimiste (50 % déjà en cache / skip `needsIconExtraction`) | ~18 extractions × ~4 s / 2 | **~35–45 s** |
| Nominal (30 apps à tenter, ~4–6 s/succès, 6 échecs rapides) | 15 batches × ~5 s | **~1–1,5 min** |
| Pessimiste (36 apps, échecs lents 2 APK × 3 tentatives déjà en cache) | majorité skip si `iconAttempts ≥ 3` | **< 30 s** (peu de travail réel) |
| Pire cas (36 extractions lourdes type gros APK) | 18 × ~8–15 s | **2–4 min** |

→ Le test manuel **1–2 min** pour voir des icônes apparaître (apps 17–52) est **réaliste** pour le cas nominal. Les timeouts 20/45/30 s ne s'appliquent qu'en cas de blocage ADB.

#### Priorité viewport vs séquentiel 17–52 ?

| Approche | Pour | Contre |
|----------|------|--------|
| **Viewport d'abord** (IntersectionObserver) | UX optimale scroll | Complexité renderer ; hors scope minimal |
| **Séquentiel slice(16) puis slice(16+)** (plan §3) | Simple ; les 16 premières = déjà visibles sans scroll ; ordre liste = ordre prefetch | Apps en bas de liste attendent plus longtemps |
| **Une seule queue 52 apps, concurrence 2** | Même effet que séquentiel si ordre liste préservé | Mélange avec cap `maxCount` actuel |

**Recommandation :** **séquentiel simple** — passage 1 = apps `[0..15]`, passage 2 = apps `[16..]` en arrière-plan (pas de viewport pour P2). Option viewport = amélioration ultérieure si le scroll long reste frustrant.

### Plan proposé (validation avant code)

Aligné sur la demande §3 + fusion P2 worker.

#### Phase A — Worker : handlers prefetch (P2 cœur)

| # | Fichier | Changement |
|---|---------|------------|
| A1 | `apps-worker.js` | Handler `PREFETCH_APP_METADATA` : `{ transportSerial, cacheDeviceId, adbSerial, apps[], maxCount? }` → `appMetadataManager.queuePrefetch` avec `notifyUpdate` = `process.send({ type: 'METADATA_UPDATED', … })` |
| A2 | `apps-worker.js` | Handler `RESOLVE_APP_METADATA` (optionnel sidebar, même PR) — hors chemin critique liste |
| A3 | `app-metadata-manager.js` | **Aucun changement logique extraction** ; réutiliser `queuePrefetch` / `resolveOne` tels quels |
| A4 | `apps-worker-bridge.js` | `prefetchAppMetadata(ctx, apps, options)` ; écouter push `METADATA_UPDATED` → relayer `win.webContents.send('app-metadata:updated')` |
| A5 | `app-metadataHandlers.js` | `app-metadata:prefetch` → bridge si worker actif, sinon fallback main `appMetadataManager` |
| A6 | `main.js` | Résoudre `cacheDeviceId` + `adbSerial` (comme `device:apps` / P1.5) avant appel bridge |

#### Phase B — UI : deux passages prefetch

| # | Fichier | Changement |
|---|---------|------------|
| B1 | `new-session.js` | **Passage 1 (inchangé)** : `apps.slice(0, 16)`, `maxCount: 16`, debounce 450 ms |
| B2 | `new-session.js` | **Passage 2 (nouveau)** : `apps.slice(16)`, `maxCount: apps.length` (ou constante `METADATA_PREFETCH_EXTENDED_MAX`), déclenché `setTimeout` ~500 ms après passage 1 — **fire-and-forget**, pas d'await UI |
| B3 | `new-session.js` | Remplacer le garde `metadataPrefetchDoneSerial` unique par **deux flags** (`prefetchPrimaryDoneSerial`, `prefetchExtendedDoneSerial`) ou une structure `{ serial, extended: boolean }` pour autoriser le second passage une fois par ouverture de liste |
| B4 | Renderer | **Aucune popup** — icônes via `onAppMetadataUpdated` → `applyMetadataUpdates` (déjà en place l.1293–1301) |

#### Phase C — Concurrence & non-régression

- `PREFETCH_CONCURRENCY = 2` **inchangé** (main et worker).
- `MAX_ICON_EXTRACT_ATTEMPTS = 3`, `MAX_APK_PULL_ATTEMPTS = 2` **inchangés**.
- Passage 1 reste sur le **même chemin** qu'aujourd'hui (priorité perçue identique).
- Passage 2 dans le **worker** → `tar`/walk hors main → sessions Type A/B moins impactées côté event loop.
- ADB reste partagé (worker + sessions) : **test manuel obligatoire** fluidité Type B pendant passage 2.

#### Flux cible

```
loadAppsForSelectedDevice()
  → GET_APP_LIST (worker) + enrich cache     [immédiat, UI liste]
  → prefetch passage 1 : apps[0..15]         [worker, concurrence 2]
  → prefetch passage 2 : apps[16..]         [worker, concurrence 2, async différé]
       → METADATA_UPDATED (push worker→main→renderer)
       → applyMetadataUpdates (icônes au fur et à mesure)
```

#### Hors scope (confirmé)

- `extractIcon`, `findBestIconFile`, adaptive-icon XML
- Augmentation `PREFETCH_CONCURRENCY` > 2
- Prefetch viewport / scroll-triggered

### Test manuel (§5)

1. Appareil 50+ apps → **16 premières** icônes / placeholders comme avant (pas de régression temps ouverture panneau).
2. Attendre **1–2 min** → icônes apps **17–52** apparaissent progressivement (pas toutes si échec extracteur légitime).
3. **Session Type B active** pendant passage 2 → input/vidéo fluides (comparer à baseline sans prefetch étendu).
4. `app-metadata-cache.json` : apps hors top-16 ont `iconAttempts` incrémenté si extraction tentée ; entrées `≥ 3` inchangées si déjà abandonnées.
5. Log worker : `[AppMetadataManager] prefetch …` / `METADATA_UPDATED` sans erreur bridge.

### Prochaine étape

~~**Validation plan** → implémentation Phase A + B (LOCK respecté).~~ → livré ci-dessous.

### Implémentation livrée

| Fichier | Changement |
|---------|------------|
| `apps-worker.js` | `PREFETCH_APP_METADATA` → `queuePrefetch` + push `METADATA_UPDATED` |
| `apps-worker-bridge.js` | `prefetchAppMetadata`, relay push → `app-metadata:updated`, fallback prefetch |
| `app-metadata-manager.js` | `resolvePrefetchContext()` pour worker (cacheDeviceId/adbSerial explicites) |
| `appMetadataHandlers.js` | Prefetch délégué au bridge + `resolveAppListDeviceContext` |
| `main.js` | `setMetadataUpdatedRelay`, fallback prefetch |
| `new-session.js` | Passage 1 (16 apps) + passage 2 différé (`slice(16)`, `maxCount` = reste) |

### Prochaine étape (après P2 prefetch)

Extracteur adaptive-icon (YouTube Music, Spotify, AR Core) — hors scope P2.

---

## DIAGNOSTIC — Icônes applications manquantes (2026-07-08)

**Statut : Étape 1 terminée (lecture seule, aucun patch).**  
**Symptôme :** placeholder gris (SVG) au lieu du vrai logo — ex. Ar Core, Avod Thirdparty client, Cast Webvideo ; Ankama Dofustouch OK.  
**Zones concernées :** panneau « Nouvelle instance » + sidebar onglets/fenêtres.

### 1. Source commune ou chemins séparés ?

| Couche | Rôle | Fichier(s) |
|--------|------|------------|
| **Extraction APK** | Pull `base.apk` → `tar -xf` → recherche PNG/WebP | `src/main/managers/app-icon-extractor.js` |
| **Orchestration + cache** | `resolveOne`, `enrichApps`, `queuePrefetch` | `src/main/managers/app-metadata-manager.js` |
| **IPC** | `app-metadata:resolve`, `app-metadata:prefetch` ; hook liste apps | `src/main/ipc/appMetadataHandlers.js` |
| **Preload** | `resolveAppMetadata`, `prefetchAppMetadata`, `onAppMetadataUpdated`, `getAppsWithDetails` | `src/preload/preload.js` |
| **UI Nouvelle instance** | Affichage liste + prefetch | `src/renderer/new-session.js`, `src/renderer/apps/AppLauncherSearch.js`, `src/renderer/apps/AppList.js` |
| **UI Sidebar onglets** | Placeholder immédiat + résolution async | `src/renderer/sidebar/Sidebar.js` |
| **Styles placeholder** | Gris SVG | `src/renderer/styles/style.css` (`.tab-app-icon.is-placeholder`, `.new-instance-app-icon svg`) |

**Verdict :** les deux affichages utilisent **la même source backend** (`AppMetadataManager` + `AppIconExtractor`) et les **mêmes champs** (`iconUrl` / `iconPath`). Pas de deuxième extracteur parallèle.

**Différence :** deux composants UI indépendants (rendu HTML séparé), mais alimentés par le même pipeline IPC/cache.

### 2. Cache d'icônes

| Type | Emplacement | Clé | Partagé ? |
|------|-------------|-----|-----------|
| **Index JSON** | `{userData}/app-metadata-cache.json` | `deviceId::packageName::userId` | Oui (main process) |
| **Fichiers PNG** | `{userData}/app-icons/{deviceId}/{package}[@uN].png` | segment deviceId + package | Oui |
| **Renderer sidebar** | `sessionIconCache` (`Map` en mémoire) | `stableDeviceId\|\|deviceId::package::userId` | Non persistant ; hydratation via `app-metadata:updated` |
| **TTL** | 7 jours (`CACHE_TTL_MS`) | — | Entrées avec `iconPath: null` comptées **fraîches** → pas de retry prefetch |

**Incohérence de clé deviceId (secondaire, pas cause per-app) :**

| Appelant | Clé `deviceId` utilisée |
|----------|---------------------------|
| `enrichApps` / `getAppsWithDetails` / prefetch Nouvelle instance | **Serial ADB transport** (`selectedDevice.serial`) |
| `Sidebar.resolveSessionTabIcon` | **`stableDeviceId \|\| deviceId`** |
| `new-instance-ipc.js` lecture cache historique | **`session.serial`** (transport) mais enregistrement avec `stableDeviceId \|\| serial` |

→ Sur WiFi (`ip:port` vs `ro.serialno`), cache disque et hydratation sidebar peuvent diverger. **Ne explique pas** pourquoi Dofustouch OK et Ar Core KO sur le **même** appareil.

### 3. Flux de données (sans latence bloquante sur liste / onglet)

```
getAppsWithDetails(serial)
  → device-manager.js (packages + labels pm list uniquement, pas d'icône)
  → enrichApps(serial) : merge cache JSON uniquement (sync, pas d'ADB extract)
  → UI affiche placeholder si iconUrl absent

prefetch (debounce 450 ms, max 16 apps, concurrency 2)
  → queuePrefetch(serial) → resolveOne → extractIcon (async)
  → notify app-metadata:updated → new-session.js + Sidebar.js

Ouverture onglet sidebar
  → placeholder SVG immédiat (renderTabAppIcon)
  → resolveSessionTabIcon → app-metadata:resolve (async, non bloquant)
```

**Confirmé :** le chargement liste et l'ouverture d'onglet ne bloquent pas sur l'extraction APK (déjà async + placeholder).

### 4. Cause probable des échecs (apps citées)

**Extraction limitée** (`app-icon-extractor.js`) :

| Ligne | Comportement | Limite |
|-------|--------------|--------|
| 84–96 | `pm path` → **seul `base.apk`** retenu | Ressources icône souvent dans **split APK** (`split_config.*.apk`) |
| 41–54 | `walkFiles` : extensions **`.png` / `.webp` uniquement** | Ignore XML adaptive-icon, vector drawable |
| 9–18 | Priorité `ic_launcher` mipmap/drawable | Ne parse pas `res/mipmap-anydpi-v26/ic_launcher.xml` |
| 120–122 | `tar -xf` sur base.apk | Si icône uniquement en adaptive XML ou split → `findBestIconFile` → `null` |

**Format réel des apps en échec (analyse statique, non vérifiée sur device — ADB indisponible dans l'environnement de diagnostic) :**

| App (nom UI) | Package probable | Format attendu |
|--------------|------------------|----------------|
| Ar Core | `com.google.ar.core` | Adaptive icon API 26+ ; splits ressources Google Play |
| Avod Thirdparty client | (tierce, nom pm list) | Packaging moderne, souvent adaptive + splits |
| Cast Webvideo | (tierce) | Idem |
| Ankama Dofustouch | `com.ankama.dofustouch` (probable) | **PNG legacy** `mipmap-*/ic_launcher.png` dans base.apk → extraction OK |

**À valider en Étape 3 sur device :** `adb shell pm path <pkg>` puis inspection `tar -tf` / listing `res/mipmap*` de chaque APK retourné.

### 5. Fallback en cas d'échec

| Zone | Comportement |
|------|--------------|
| `app-icon-extractor.js:122` | `return null` silencieux si aucun candidat |
| `app-metadata-manager.js:211–224` | Catch log warn ; `setCachedEntry` avec **`iconPath: null`** (cache négatif 7 jours) |
| `new-session.js:145–150`, `AppLauncherSearch.js:244–249` | SVG placeholder (carré gris) si pas `iconUrl`/`iconPath` |
| `Sidebar.js:45–49, 87–90` | Classe `is-placeholder` + SVG ; **ne met en cache renderer que si `iconUrl` truthy** |
| `Sidebar.js:91–92` | Erreur IPC : `catch` vide (silencieux) |

Pas de logo générique distinct du placeholder : l'utilisateur voit le **même SVG gris** partout.

### 6. Fichiers et lignes en cause

| Fichier | Lignes | Problème |
|---------|--------|----------|
| `app-icon-extractor.js` | 84–96, 110–122, 41–71 | base.apk seul ; PNG/WebP only ; pas adaptive/splits |
| `app-metadata-manager.js` | 78–83, 190–224, 272–275 | Cache négatif `iconPath:null` frais 7j ; prefetch skip si cache hit |
| `appMetadataHandlers.js` | 41–49, 4–21 | Hook enrich (OK) ; resolve utilise `deviceId` tel quel pour ADB |
| `new-session.js` | 145–150, 220–241, 574, 1229–1238 | Rendu + prefetch serial ; écoute updates |
| `AppLauncherSearch.js` | 244–249, 201–222 | Idem Nouvelle instance (composant recherche) |
| `Sidebar.js` | 38–43, 45–49, 73–95, 431–442 | Clé stableDeviceId ; placeholder ; hydratation |
| `new-instance-ipc.js` | 73–78 | Lookup cache sur `session.serial` ≠ clé sidebar stable |
| `style.css` | ~190–211, ~1410–1428 | Style placeholder gris |

**Fichiers LOCK — non touchés :** `scrcpy-socket.js`, `new-instance-manager.js`, `createSession()`, input, `--new-display`, sessions Type A/B.

### 7. Proposition de correctif (Étape 2 — en attente validation utilisateur)

**Piste unique backend** (corrige les deux UI d'un coup car source commune) :

1. **`app-icon-extractor.js`** — enrichir l'extraction sans bloquer l'UI :
   - Parcourir **tous** les APK retournés par `pm path` (pas seulement `base.apk`).
   - Si aucun PNG/WebP launcher classique : parser `res/mipmap-anydpi-v26/ic_launcher.xml` (adaptive-icon) et résoudre les layers foreground/background en PNG/WebP dans les mêmes APK.
   - Conserver la priorité actuelle `ic_launcher` mipmap pour ne pas casser Dofustouch.

2. **`app-metadata-manager.js`** — cache :
   - **Ne pas** traiter `iconPath: null` comme cache frais bloquant (retry prefetch / resolve), ou TTL court pour échecs.
   - **Normaliser la clé cache** sur `stableDeviceId` ; résoudre le serial ADB transport uniquement pour les commandes `adb` (via `deviceRegistry.resolveEffectiveAdbSerial` — pattern déjà utilisé ailleurs, hors LOCK input).

3. **Pas de changement UI obligatoire** si le backend renvoie `iconUrl` ; optionnel : unifier la clé `sessionIconCache` côté sidebar si normalisation deviceId.

**Risques identifiés :**

| Risque | Mitigation |
|--------|------------|
| Latence prefetch si multi-pull splits | Rester async ; concurrency 2 inchangée ; premier candidat trouvé short-circuit |
| Régression Dofustouch | Tester en priorité ; garder `ICON_ENTRY_PRIORITY` actuel en premier pass |
| Invalidation cache existant (changement clé deviceId) | Re-extract async one-shot ; liste/onglets restent avec placeholder jusqu'à prefetch |
| Adaptive XML edge cases (vector only) | Fallback placeholder explicite ; pas de blocage |
| Patch UI double si backend insuffisant | Peu probable : même `iconUrl` consommé partout |
| WiFi serial vs stable | Normalisation clé + resolve ADB amont évite miss sidebar ↔ liste |

**Hors scope proposition :** `aapt`/`apkanalyzer` externe (dépendance lourde) ; screenshot launcher (trop lent).

### 8. Prochaine étape

**Implémenté 2026-07-08** — voir § Implémentation icônes ci-dessous.

---

## Implémentation — Icônes applications (2026-07-08)

**Statut : patché (backend uniquement, zones LOCK respectées).**

### Clarifications validées

1. **Clé cache `stableDeviceId`** : lookup en cascade (`stableDeviceId` puis serial transport) ; migration lazy à la lecture (réécriture clé canonique, **même `iconPath`**, pas de re-extract). Aucune boucle au démarrage — `loadIndex()` reste lecture JSON seule.
2. **Retry cache négatif** : `iconAttempts` dans `app-metadata-cache.json`, **max 3** (`MAX_ICON_EXTRACT_ATTEMPTS`), puis plus de prefetch/extract jusqu'au TTL 7 jours.

### Fichiers modifiés

| Fichier | Changement |
|---------|------------|
| `app-icon-extractor.js` | Multi-APK ; adaptive XML → foreground/background raster |
| `app-metadata-manager.js` | Fallback clés, migration lazy, `iconAttempts`, resolve ADB serial |
| `appMetadataHandlers.js` | `enrichApps` async |
| `new-instance-ipc.js` | Lookup cache stable + fallback transport |

### Latence

- Liste apps / ouverture onglet : **inchangé** (placeholder immédiat, extract async prefetch/resolve).
- Post-patch : **pas de ré-scan global** ; seules les apps affichées/prefetchées sans icône valide et `iconAttempts < 3` sont re-tentées.

---

## AUDIT — Latence ouverture fenêtres/instances + réglages par défaut (2026-07-07)

**Statut : audit lecture seule (aucune modification code LOCK).**

Objectif : cartographier les réglages par défaut et la chronologie clic → flux vidéo stable, pour choisir une piste d'optimisation.

### 1. Réglages par défaut (utilisateur sans config manuelle)

#### Source canonique

Fichier unique : `src/shared/stream-params.js` — constante `DEFAULT_STREAM_PARAMS` (l.6–13).

| Paramètre | Valeur par défaut | Remarque |
|-----------|-------------------|----------|
| Résolution | **1920 × 1080** | Preset « FULL HD » |
| DPI | **240** | Label panneau : « Normal » |
| FPS max | **60** | |
| Bitrate | **8 Mbps** | `bitRateMbps: 8` → `8_000_000` bps côté scrcpy |
| GOP / I-frame | **1 s** | `iFrameInterval: 1` → `video_codec_options=i-frame-interval=1` |
| Orientation UI | **Paysage** | `DEFAULT_ORIENTATION = landscape` |

**Pas de preset global persisté sur disque** pour ces valeurs : elles sont codées en dur dans `stream-params.js`. Le panneau Contrôle (`ControlPanel.js`) permet de modifier les params **par session active** via `StreamParamsManager` (mémoire + registry), mais au premier lancement sans action utilisateur c'est toujours `DEFAULT_STREAM_PARAMS`.

#### Type A — Mirroring

| Couche | Fichier | Valeurs effectives |
|--------|---------|-------------------|
| UI lancement | `new-session.js` l.1008–1016 | `StreamParams.toScrcpyOptions(DEFAULT_STREAM_PARAMS, "A")` |
| Registry BrowserView | `browserViewManager.js` l.97–98 | `streamParams: cloneParams(extraQuery.streamParams \|\| DEFAULT_STREAM_PARAMS)` |
| scrcpy-server | `scrcpy-socket.js` l.280–283 | Fallbacks identiques si option absente |

**Args scrcpy-server Type A (défaut) :**
- `video_bit_rate=8000000`, `max_fps=60`, `max_size=1920`, `i-frame-interval=1`
- Pas de `new_display` (miroir écran physique, redimensionné `max_size`)
- `capture_orientation` calculé selon dims appareil (`applyCaptureOrientationToOptions` dans `main.js`)

#### Type B — Nouvelle instance (deux phases)

**Phase 1 — scrcpy.exe externe (bootstrap display virtuel)**

| Fichier | Valeurs |
|---------|---------|
| `main.js` `buildNewInstanceExternalBaseArgs` l.646–664 | `--new-display=1920x1080` (**sans DPI**), `--turn-screen-off`, `--stay-awake`, `--no-window`, `--record=NUL` |
| `new-session.js` l.787–791 | `streamOptions` payload create : `{ stayAwake, turnScreenOff, audio: true }` seulement |

→ Bitrate / FPS / GOP **non passés** au binaire scrcpy externe : **défauts internes du binaire scrcpy**.

**Phase 2 — Hub socket (flux affiché)**

| Fichier | Valeurs |
|---------|---------|
| `new-instance-manager.js` l.27–38, 98 | Fallback `newDisplay: "1920x1080/240"` via `toScrcpyOptions(DEFAULT_STREAM_PARAMS, "B")` |
| `scrcpy-socket.js` l.280–283 | `bitRate=8000000`, `maxFps=60`, `iFrameInterval=1` ; `display_id=<preset>` si phase 1 OK (pas de recréation display) |
| Hub socket audio | `main.js` `resolveHubSocketAudioEnabled` | `audio=false` sur socket Hub ; son PC via scrcpy.exe séparé |

---

### 2. Méthode d'affichage actuelle

**Pas de fenêtre SDL native visible.** scrcpy tourne avec `--no-window` ; la vidéo SDL du binaire n'est pas affichée.

| Couche | Technologie |
|--------|-------------|
| Surface visible | **Electron `BrowserView`** → `session.html` → **`<canvas id="video-canvas">`** |
| Décodage | **WebCodecs `VideoDecoder`** (`session.js`) |
| Rendu | `CanvasRenderingContext2D.drawImage(VideoFrame)` via `createVideoFramePresenter` (RAF) |
| Legacy | Canvas cachés `#video-stage` + `video-player.js` / `new-instance-pipeline.js` — **ne décodent plus** (commentaire `video-player.js` l.308) |

#### Chemin des frames H.264

```
Android scrcpy-server.jar
  → socket TCP ADB reverse (localhost)
  → ScrcpySocketClient (main, scrcpy-socket.js)
  → emit codec-meta + raw-packet
  → IPC webContents.send vers BrowserView
      Type A : video-codec-meta / video-packet
      Type B : new-instance:video-codec-meta / new-instance:video-packet
  → sessionPreload.js → session.js
  → VideoDecoder → canvas
```

Pas de pipe fichier, pas de texture partagée GPU : **buffers binaires via IPC Electron**.

---

### 3. Chronologie du lancement (clic → flux stable)

**Flux stable** = première frame décodée et dessinée sur le canvas BrowserView (`session.js` `framePresenter`).

> ⚠️ **Aucun `performance.now()` ni timestamp dans le code actuel.** Les temps ci-dessous sont des **étapes identifiées** + **délais fixes codés en dur** (pas de mesures runtime effectuées dans cet audit).

#### Jalons de diagnostic existants (sans timestamp)

Événement IPC `video-stream-state` (`main.js` l.1768–1801, `sessionHandlers.js` l.340–355) :

| Stage | Signification |
|-------|----------------|
| `adb-socket-connected` | Handshake socket vidéo (après device name) |
| `codec-meta` | Dimensions flux connues (SPS/PPS header) |
| `h264-first-packet` | Premier paquet H.264 reçu côté main |

Logs console utiles : `[BrowserViewManager] Session créée`, `[ScrcpySocketClient] Device/Codec/Session vidéo`, `[scrcpy-server] args`.

#### Type A — Mirroring (séquentiel critique)

```
Clic (DevicePanel dblclick / bouton Mirroring)
  → launchMirrorSession / createInstance                    [renderer]
  → setupInstance:
      1. registerView (BrowserView create + load session.html)  [IPC, ATTEND did-finish-load]
      2. player.start → start-video-stream                    [IPC, puis scrcpy]
  → startVideoStreamLogic:
      - resolveDeviceDimensions (ADB, cache ou requête)
      - ScrcpySocketClient.start():
          a. adb push jar
          b. adb reverse tunnel
          c. spawn scrcpy-server
          d. pause fixe 350 ms                               [scrcpy-socket.js l.178]
          e. _connectSockets (timeout 12 s max)              [l.428–494]
      - waitForFirstPacket (timeout 5 s)                     [main.js l.1911]
  → registerClientEvents → IPC packets → BrowserView
  → WebCodecs configure + decode + RAF draw
  → finalizeSessionUI → switchTo + reportContentBounds
```

**Goulots probables (qualitatif, à mesurer) :**
1. **Séquentialité** `registerView` puis `start` — BrowserView doit charger avant le stream, mais le stream ne démarre qu'après.
2. **ADB push + reverse + spawn server** — coût fixe par session.
3. **Pause 350 ms** après spawn server.
4. **Attente premier keyframe** (GOP 1 s → keyframe au plus tard ~1 s après début flux).
5. **Init WebCodecs** + premier `drawImage` (généralement faible vs ADB).

#### Type B — Nouvelle instance (double lancement scrcpy)

```
Clic Lancer
  → launchTypeBSession
  → PHASE 1 : electronAPI.launchNewInstance
      - resolveDeviceDimensions (ADB, retry 400 ms si absent)   [main.js l.1518–1521]
      - spawn scrcpy.exe --new-display=1920x1080
      - attente regex display id (timeout IPC 10 s)            [main.js l.1609–1627]
  → waitForVirtualDisplayId (jusqu'à 10 s)                   [new-session.js l.475–488]
  → newInstanceCreate → createNewInstanceSession             [LOCK — non modifié]
  → registerView (BrowserView Type B)
  → createNewInstanceVideoPipeline (canvas legacy, non affiché)
  → newInstanceStart → startNewInstanceSession
  → PHASE 2 : ScrcpySocketClient.start (même pipeline ADB/socket)
      - display_id=presetDisplayId (réutilise display phase 1)
  → IPC video → BrowserView → WebCodecs → canvas
  → finalizeSessionUI
  → (parallèle) scrcpy.exe audio séparé
```

**Goulots probables Type B (qualitatif) :**
1. **Double scrcpy** (externe + Hub socket) — **suspect #1** pour latence totale.
2. **Double attente 10 s** (launch IPC + waitForVirtualDisplayId) en cas de lenteur display.
3. Même coûts ADB/socket/WebCodecs que Type A en phase 2.
4. Bug diagnostic : `new-instance:first-frame` (`new-instance-pipeline.js`) ne reflète que le canvas legacy masqué, pas le BrowserView.

#### Délais fixes codés en dur (référence)

| Délai | Fichier | Ligne |
|-------|---------|-------|
| 350 ms post-spawn server | `scrcpy-socket.js` | 178 |
| 12 s timeout connexion sockets | `scrcpy-socket.js` | 494 |
| 15 s attente socket contrôle (audio actif) | `scrcpy-socket.js` | 469 |
| 5 s waitForFirstPacket | `main.js` | 1911 |
| 10 s attente display externe | `main.js` | 1610 |
| 10 s waitForVirtualDisplayId | `new-session.js` | 475 |
| 400 ms retry dims device | `main.js` | 1520 |
| 500 ms entre force-restart streams | `main.js` | 1680 |

---

### 4. Mesures runtime — non effectuées (proposition instrumentation)

**Aucun log temporaire ajouté** (respect audit LOCK + lecture seule).

Pour mesurer précisément, instrumentation recommandée **hors zones LOCK** :

| Point | Fichier sûr | Événement |
|-------|-------------|-----------|
| T0 clic | `new-session.js` / `DevicePanel.js` | `performance.now()` au clic |
| T1 BrowserView ready | `browserViewManager.js` | `did-finish-load` |
| T2 stream IPC reçu | `main.js` `start-video-stream` handler | avant/après `startVideoStreamLogic` |
| T3–T5 stages | enrichir `video-stream-state` payload | `{ stage, ts: performance.now() }` côté main |
| T6 première frame canvas | `session.js` | premier `framePresenter.schedule` (hors LOCK input — zone sensible, valider avant) |

Alternative : script DevTools branché sur `electronAPI.onVideoStreamState` dans la console renderer.

---

### 5. Pistes d'optimisation (à décider ensemble — non implémentées)

| Piste | Impact estimé | Risque |
|-------|---------------|--------|
| **Paralléliser** `registerView` + `startVideoStream` (Type A) | Moyen–élevé | Régression ordre init input |
| **Réduire/supprimer pause 350 ms** | Faible–moyen | Race socket/server |
| **Type B : éviter double scrcpy** (socket direct sans bootstrap exe) | **Élevé** | Touche architecture Type B (LOCK `new-instance-manager`) |
| **Preset launch plus léger** (720p / 30 fps / 4 Mbps) | Moyen (bitrate + keyframe) | Qualité visuelle |
| **GOP 1 s → plus court au launch** | Faible au 1er frame | Bitrate / qualité |
| **Pré-warm jar ADB / tunnel** par serial connecté | Moyen sur 2e+ session | Complexité |

---

### 6. Instrumentation latence (2026-07-07)

**Statut : implémentée (diagnostic uniquement — aucun changement de comportement métier).**

#### Fichiers instrumentés (hors LOCK)

| Fichier | Rôle |
|---------|------|
| `main/managers/launch-latency-tracker.js` | Agrégation stages, résumé console + `launch-latency.log` |
| `main/main.js` | IPC handlers, timestamps `video-stream-state`, marqueurs `new-instance:launch` |
| `main/managers/browserViewManager.js` | `registerViewStart`, `browserViewReady` |
| `main/ipc/sessionHandlers.js` | Timestamps Type B `codec-meta` / `h264-first-packet` |
| `main/ipc/new-instance-ipc.js` | `hubSocketStart` |
| `preload/preload.js` + `sessionPreload.js` | Bridges IPC |
| `renderer/launch-latency.js` | `window.LaunchLatency.markClick()` |
| `renderer/new-session.js` | Clic Type A/B, `waitForVirtualDisplayId` |
| `renderer/sidebar/DevicePanel.js` | Clic double-clic mirroring |
| `renderer/instance-manager.js` | `bindSession` |
| `renderer/session/session.js` | Première frame canvas (`reportLaunchLatencyFirstFrame`) |
| `main/managers/scrcpy-start-profiler.js` | Sous-décomposition ADB (`[LATENCE-ADB]`, monkey-patch externe) |

#### Format console

```
[LATENCE] Type A - Total: XXXms | registerView: XXms | adb-socket: XXms | first-packet: XXms | decode+render: XXms
[LATENCE] Type B - Total: XXXms | external-display: XXms | waitDisplayId: XXms | hub-socket: XXms | registerView: XXms | first-packet: XXms | decode+render: XXms
```

Après **3 lancements** du même type, une ligne **Moyenne** est imprimée automatiquement.

Log fichier : `{userData}/launch-latency.log`

#### Protocole de mesure (3× Type A + 3× Type B USB)

1. `npm start` — ouvrir DevTools → onglet **Terminal** (main process) ou console renderer selon l'environnement.
2. **Type A** : double-clic appareil sidebar (mirroring) × 3 — noter les 3 lignes `[LATENCE] Type A` + la moyenne.
3. **Type B** : Nouvelle instance → choisir app → Lancer × 3 — noter les lignes `[LATENCE] Type B` + moyenne.
4. Fermer les sessions entre chaque mesure pour éviter le cache tunnel ADB biaisant la 2e/3e mesure.

#### Résultats mesurés (session 2026-07-07)

**Non exécutés dans l'environnement agent** (`adb` absent du PATH — pas d'appareil USB accessible pour l'automatisation).

| Étape | Type A (moy. n=3) | Type B (moy. n=3) |
|-------|-------------------|-------------------|
| Total | *à compléter* | *à compléter* |
| registerView | *à compléter* | *à compléter* |
| adb-socket / hub-socket | *à compléter* | *à compléter* |
| external-display | — | *à compléter* |
| waitDisplayId | — | *à compléter* |
| first-packet | *à compléter* | *à compléter* |
| decode+render | *à compléter* | *à compléter* |

> Compléter ce tableau après 3 lancements de chaque type sur device USB réel. Coller les lignes `[LATENCE] Moyenne` de la console ou de `launch-latency.log`.

---

### 7. Diagnostic ciblé — intervalle `streamInvoke` → `adb-socket-connected` (Type A) (2026-07-07)

**Statut : analysé + sous-instrumentation ajoutée (aucun correctif métier).**

#### Constat utilisateur

~**74 %** du temps Type A (ordre de grandeur **1200–1900 ms**) se situe entre `streamInvoke` et `adb-socket-connected`.

#### Décomposition code (lecture `scrcpy-socket.js` — LOCK, non modifié)

Séquence exacte de `ScrcpySocketClient.start()` (l.166–179) :

| # | Étape | Fichier | Mécanisme | Bloquant ? |
|---|--------|---------|-----------|------------|
| 0 | Résolution dims appareil | `main.js` `startVideoStreamLogic` | `resolveDeviceDimensionsForSerial` si cache TTL 60 s expiré | Oui (avant `client.start`) |
| 1 | **Push jar** | `scrcpy-socket.js` l.194–196 | `adb push "<jar>" /data/local/tmp/scrcpy-server.jar` | Oui — **à chaque lancement** |
| 2 | **Tunnel ADB** | l.198–207 | `_findFreePort()` + `adb reverse --remove localabstract:scrcpy_<scid>` + `adb reverse … tcp:<port>` | Oui — **nouveau `scid` aléatoire par client** |
| 3 | **Spawn serveur** | l.262–315 | `spawn(adb, shell app_process … Server 4.0 scid=…)` | Non bloquant côté Node (retour immédiat) |
| 4 | **Pause fixe** | l.178 | `setTimeout(350)` | Oui — **350 ms garantis** |
| 5 | **connectSockets** | l.335–494 | Écoute TCP locale ; attente sockets vidéo + contrôle ; timeout **12 s** | Oui |
| 6 | **deviceMeta → `connected`** | l.498–522 | Réception **64 octets** (nom appareil) sur socket vidéo → `emit("connected")` = `adb-socket-connected` | Oui (souvent court une fois TCP établi) |

**Formule approximative :**

```
streamInvoke → adb-socket-connected
  ≈ dimsResolve
  + jarPush
  + tunnelSetup
  + ~350 ms (fixe)
  + connectSockets
  + deviceMeta
```

(`serverSpawn` côté Node ≈ 0 ms — le coût réel du démarrage Java sur le device est absorbé dans `connectSockets` / `deviceMeta`.)

#### Jar repoussé à chaque lancement ?

**Oui — sans condition.**

```194:196:src/native/scrcpy/scrcpy-socket.js
    async _pushServer(serverJarPath) {
        await this._runAdb(`push "${serverJarPath}" ${DEVICE_SERVER_PATH}`);
    }
```

- **Aucun** `adb shell ls`, hash, taille ou version comparée avant push.
- Chemin device fixe : `/data/local/tmp/scrcpy-server.jar`.
- Même si le jar est déjà présent et identique, `adb push` est ré-exécuté (coût typique **300–800 ms** USB selon taille jar ~90 Ko et état link).

#### Tunnel pré-établissable à la sélection sidebar ?

**Pas en l'état actuel — tunnel lié au `scid` de la session.**

- Chaque `ScrcpySocketClient` génère un **`scid` hex aléatoire** (l.34–37) → socket `localabstract:scrcpy_<scid>`.
- À l'arrêt : `reverse --remove` sur ce nom (l.841).
- **Impossible de réutiliser** un tunnel créé avant le clic sans figer le `scid` (collision multi-sessions / multi-fenêtres).

**Pré-chauffage possible (hors LOCK, à décider) :**

| Action | Faisabilité | Effet attendu |
|--------|-------------|---------------|
| `adb push` jar à la connexion / sélection device | ✅ Oui (couche amont sidebar / `devices-refreshed`) | Retire **jarPush** du chemin critique au clic |
| `adb reverse` avant clic | ⚠️ Partiel | Nécessite **même `scid`** que la session → incompatible avec architecture actuelle |
| Cache dims (déjà 60 s) + résolution au poll 8 s | ✅ Déjà partiel | Réduit **dimsResolve** si cache chaud |
| Garder `ScrcpySocketClient` vivant entre sessions | ❌ Non trivial | Conflit avec `stop()` + lifecycle onglets |

#### Nouvelle ligne de log (sous-décomposition)

Monkey-patch externe `scrcpy-start-profiler.js` (installé depuis `main.js`, **sans modifier** `scrcpy-socket.js`) :

```
[LATENCE-ADB] <sessionId> | dims: XXms | jarPush: XXms | tunnel: XXms | spawn: 0ms | delay350~: ~350ms | connectSockets: XXms | deviceMeta: XXms | scrcpy.start total: XXms
```

Émis à chaque `adb-socket-connected`, en plus de la ligne `[LATENCE] Type A`.

#### Temps mesurés — sous-étapes scrcpy.start (benchmark isolé USB, 2026-07-07)

**Script :** `scripts/benchmark-type-a-latency.js` (3 runs, serial `e176518f`, audio=false).

| Sous-étape | Run 1 | Run 2 | Run 3 | Moyenne | % du bloc scrcpy.start |
|------------|-------|-------|-------|---------|------------------------|
| dimsResolve | 0 | 0 | 0 | **0** | 0 % |
| jarPush | 110 | 91 | 93 | **98** | ~17 % |
| tunnelSetup | 127 | 119 | 122 | **123** | ~21 % |
| delay350~ (fixe) | 333 | 337 | 347 | **339** | ~58 % |
| connectSockets | 30 | 26 | 13 | **23** | ~4 % |
| deviceMeta | 0 | 0 | 0 | **0** | 0 % |
| **Total scrcpy.start** (fin `client.start()`) | ~610 | ~573 | ~565 | **~583** | 100 % |

> Hypothèse §7 (jarPush 40–55 %, connectSockets 25–35 %) **invalidée** sur jar déjà présent : le goulot interne est `delay350~` (~58 %), pas le push.

#### Mesures réelles Type A (UI, `%APPDATA%/android-hub/launch-latency.log`)

| Run | streamInvoke | adb-socket-connected | **Δ streamInvoke→adb** | codec-meta | **Δ adb→codec** |
|-----|-------------|----------------------|------------------------|------------|-----------------|
| 1 | 79 ms | 1867 ms | **1788 ms** | 2770 ms | 903 ms |
| 2 | 76 ms | 1571 ms | **1495 ms** | 1856 ms | 285 ms |
| 3 | 74 ms | 1258 ms | **1184 ms** | 1541 ms | 283 ms |
| **Moyenne** | **76 ms** | **1565 ms** | **≈ 1489 ms** | **2056 ms** | **≈ 490 ms** |

**Écart à expliquer :** `streamInvoke → adb-socket-connected` (**≈ 1489 ms**) − `scrcpy.start` benchmark (**≈ 583 ms**) = **≈ 906 ms non capturés** par le benchmark isolé (fourchette réelle **601–1205 ms** selon run).

---

### 8. Diagnostic — écart benchmark isolé (~583 ms) vs lancement réel (~1489 ms streamInvoke→adb) (2026-07-07)

**Statut : analysé (lecture code + corrélation logs existants). Aucun correctif.**

#### Rappel sémantique des métriques

| Métrique | Début | Fin | Piège |
|----------|-------|-----|-------|
| `[LATENCE] adb-socket` | **clic** | `adb-socket-connected` | ≠ intervalle streamInvoke→adb |
| `streamInvoke → adb-socket-connected` | entrée IPC `start-video-stream` | `emit("connected")` (64 o nom appareil) | C'est le bon intervalle pour comparer au profiler |
| `[LATENCE-ADB] scrcpy.start total` | `profiler.begin()` | fin `client.start()` (benchmark) ou `connected` (UI) | UI : log à `connected` ; benchmark corrigé : log après `start()` |

`adb-socket-connected` est marqué **dès réception du nom appareil** sur la socket vidéo (`scrcpy-socket.js` l.509–522), **avant** la fin de `_connectSockets` (socket contrôle) et **avant** le codec-id (`codec-meta`). Le délai `adb-socket-connected → codec-meta` (**≈ 490 ms** en moyenne, jusqu'à **903 ms** run 1) est du temps **encore dans `client.start()`** mais **après** le marqueur `adb-socket-connected`.

#### Chronologie réelle Type A (mirroring sidebar)

```
clic (0 ms)
  │  IPC launch-latency:click
  ├─► registerViewStart (~3 ms)
  │     createSessionView → loadFile(session.html) → BrowserView
  ├─► browserViewReady (~4 ms)
  │     await registerView IPC retourne
  ├─► player.start() → IPC start-video-stream
  ├─► streamInvoke (~76 ms)                    ← marqueur IPC main
  │     │
  │     ├─ [A] resolveDeviceDimensionsForSerial   ← PAS dans le benchmark
  │     │      ├─ resolveEffectiveAdbSerial(deviceId)
  │     │      │    └─ deviceRegistry.listUnifiedDevices()
  │     │      │         adb devices -l + getprop ro.serialno / device + import WiFi
  │     │      └─ si cache dims miss → adb shell wm size
  │     ├─ applyCaptureOrientationToOptions (sync, pas d'ADB)
  │     ├─ new ScrcpySocketClient + registerClientEvents
  │     └─ scrcpyStartProfiler.begin()
  │     └─ await client.start()                 ← profiler [LATENCE-ADB]
  │           ├─ jarPush / tunnel / delay350 / connectSockets…
  │           ├─ emit("connected") → adb-socket-connected (~1565 ms clic)
  │           └─ (suite) socket contrôle + codec-id → codec-meta (~2056 ms clic)
  └─► firstFrame
```

**Réponses aux 3 vérifications demandées**

**1. IPC renderer → main avant `client.start()` ?**

Oui, mais **court** : `streamInvoke` arrive **~76 ms** après le clic (moyenne 3 runs). Décomposition clic → `streamInvoke` :

| Étape | Durée observée | Mécanisme |
|-------|----------------|-----------|
| `markClick` IPC | inclus dans ~76 ms | `launch-latency.js` → main |
| `registerView` IPC | `browserViewReady` ≈ **4 ms** | `instance-manager.js` → `session:registerView` → `BrowserViewManager.registerSessionView` (création BrowserView + `session.html`) |
| `player.start` IPC | **~72 ms** (79−4) | `video-player.js` → `start-video-stream` |

→ Les IPC + BrowserView expliquent **~76 ms**, pas **~900 ms**.

**2. Résolution device / lookup / attente avant lancement effectif ?**

**Oui — principal suspect hors `scrcpy.start`.** Dans `startVideoStreamLogic` (`main.js` l.1704–1713), **avant** `profiler.begin()` / `client.start()` :

```1704:1713:src/main/main.js
        if (isTypeA) {
            const dimsT0 = Date.now();
            let dims = readCachedDeviceDimensions(serial);
            if (!dims) {
                dims = await resolveDeviceDimensionsForSerial(serial);
            }
            dimsResolveMs = Date.now() - dimsT0;
            global.launchLatencyTracker?.mark?.({ sessionId: tabId, stage: "dimsResolve", ts: Date.now() });
            const orientation = options.orientation || getOrientationFromScrcpyOptions(options);
            applyCaptureOrientationToOptions(options, orientation, dims?.width, dims?.height);
```

`resolveDeviceDimensionsForSerial(serial)` est appelé **sans** `stableDeviceId` (`main.js` l.1708) — seul le serial transport est passé. Malgré tout, **`resolveEffectiveAdbSerial({ serial })` invoque toujours `listUnifiedDevices()`** (`device-registry.js` l.386–387) : `adb devices -l`, `attachStableIds` (`getprop ro.serialno` par appareil), import WiFi, merge JSON.
2. Si cache dims absent → **`adb shell wm size`** (`device-orientation-manager.js` l.46–60).

**Cache dims quasi toujours froid au lancement :** chaque poll `get-devices` (8 s, `devices.js`) appelle `deviceDimensionsCache.clear()` (`main.js` l.1115–1117). Le TTL 60 s ne protège pas si un poll a eu lieu depuis le dernier mirroring.

**Contention ADB concurrente :** le même poll exécute `listUnifiedDevices` + `enrichDevicesWithStatus` (`dumpsys battery` + `dumpsys wifi` par appareil, `device-manager.js` l.302–318). Si un poll 8 s chevauche le double-clic, les commandes ADB du lancement (`listUnifiedDevices` dims + `jarPush` + `reverse` + `shell`) **sérialisent sur le device** → allongement de toutes les sous-étapes scrcpy.

**3. Le benchmark isolé saute-t-il des étapes du vrai flux ?**

**Oui.**

| Étape présente en UI | Benchmark `benchmark-type-a-latency.js` |
|----------------------|----------------------------------------|
| `markClick` / `bindSession` IPC | ❌ absent |
| `registerView` + BrowserView + `session.html` | ❌ absent (~4 ms mesuré UI) |
| IPC `start-video-stream` (aller-retour) | ❌ appel direct `startVideoStreamLogic` / `client.start` |
| `resolveEffectiveAdbSerial` → `listUnifiedDevices` | ❌ serial hardcodé via `adb devices` |
| `resolveDeviceDimensionsForSerial` / `wm size` | ❌ `dimsResolveMs: 0` |
| `stableDeviceId` | ❌ absent |
| Poll `get-devices` concurrent | ❌ pas de polling renderer |
| `startSessionAudioPlayback` | ❌ absent (après succès stream, n'impacte pas `adb-socket-connected`) |
| Sémantique `onAdbSocketConnected` | benchmark : après `start()` ; UI : à `connected` (plus tôt) |

#### Où passent les ~900 ms manquants (estimation par exclusion)

```
streamInvoke → adb-socket-connected   ≈ 1489 ms  (mesuré)
− scrcpy.start benchmark (fin)        ≈  583 ms  (isolé, même jar/orientation)
─────────────────────────────────────────────────
= écart non expliqué par scrcpy seul  ≈  906 ms
```

| Poste | Estimation | Preuve / mécanisme |
|-------|------------|-------------------|
| **A. `dimsResolve` + `resolveEffectiveAdbSerial`** | **~200–800 ms** (variable) | Code obligatoire avant `client.start` en UI ; benchmark à 0 ms ; cache dims invalidé par `get-devices` ; `listUnifiedDevices` = scan ADB complet |
| **B. Contention ADB (poll 8 s chevauchant)** | **0–1500 ms** | `get-devices` → `listUnifiedDevices` + `dumpsys` × N ; même fenêtre temporelle que `jarPush`/`reverse` ; explique run 1 (**1788 ms**) >> run 3 (**1184 ms**) |
| **C. `scrcpy.start` plus lent en contexte app** | **~0–300 ms** | Même séquence mais file ADB device déjà occupée ; jar/tunnel mesurés 98+123 ms en isolé vs peut doubler sous charge |
| **D. IPC + BrowserView (hors intervalle streamInvoke→adb)** | **~76 ms** | Déjà **avant** `streamInvoke` — ne compte pas dans les 906 ms |
| **E. Queue `connected` → `codec-meta` (après marqueur adb)** | **~490 ms** moy. | Dans `client.start()` mais **après** `adb-socket-connected` ; attente socket contrôle + codec-id ; visible runs 2–3 (**~285 ms**), run 1 outlier (**903 ms**) |

**Conclusion provisoire :** les **~900 ms** manquants ne sont **pas** un second `scrcpy.start` caché. Ils se situent principalement **entre `streamInvoke` et l'entrée effective dans `client.start()`** (poste **A** : résolution device/dims via `listUnifiedDevices`) et/ou en **ralentissement des mêmes commandes ADB** par contention avec le poll devices (poste **B**). Le benchmark mesure uniquement le tronçon **profiler.begin → fin `start()`** (~583 ms), sans le préambule métier ni la charge parallèle de l'app.

#### Instrumentation manquante pour confirmer (sans correctif)

| Stage à ajouter | Emplacement | Permet de trancher |
|-----------------|-------------|-------------------|
| `profilerBegin` | juste avant `client.start()` (`main.js` l.1940) | Mesurer **streamInvoke → profilerBegin** (= poste A) |
| `dimsResolve` dans `[LATENCE] Détail` | `STAGE_ORDER` tracker | Déjà marqué mais **absent du JSON Détail** |
| `[LATENCE-ADB]` sur lancement UI réel | même flux que mirroring | Comparer jarPush/tunnel réel vs benchmark |
| `adbPollOverlap` | flag si `get-devices` en cours pendant `start-video-stream` | Valider poste B |

**Prochaine mesure recommandée :** 3 mirroring UI avec `[LATENCE-ADB]` + ligne `[LATENCE] Détail` enrichie — comparer `dims` profiler et `streamInvoke→profilerBegin` avant tout correctif.

#### Mesures UI réelles — dimsResolve + profilerBegin (2026-07-07)

**Méthode :** 3 mirroring Type A via chemin UI (`markClick` + `launchMirrorSession`, équivalent double-clic sidebar). Script déclencheur : `node scripts/run-type-a-ui-latency.js` (`ANDROID_HUB_UI_LATENCY_RUNS=3`). Device USB `e176518f` (Xiaomi 21051182G). Log : `%APPDATA%/android-hub/launch-latency.log`.

**Instrumentation ajoutée (diagnostic uniquement) :**
- Stages `dimsResolveBegin`, `dimsResolve`, `profilerBegin` dans `[LATENCE] Détail`
- Sous-décomposition dims : `listUnifiedMs`, `wmSizeMs`, `cacheHit`, `totalMs`
- Flag `getDevicesPollOverlap` au clic (poll `get-devices` 8 s en cours ?)
- Ligne `[LATENCE-DIMS]` par run

##### Run 1 — `instance-1783438625780-376`

| Mesure | Valeur |
|--------|--------|
| **dimsResolve total** | **205 ms** (listUnified **64 ms** + wmSize **141 ms**, cache **non**) |
| **poll get-devices au clic** | **non** |
| streamInvoke → profilerBegin | **205 ms** |
| profilerBegin → adb-socket-connected | **1040 ms** |
| streamInvoke → adb-socket-connected | **1245 ms** |

```
[LATENCE] Type A - Total: 2104ms | registerView: 3ms | adb-socket: 1326ms | first-packet: 2085ms | decode+render: 19ms
[LATENCE] Détail A instance-1783438625780-376: {"stages":{"click":0,"registerViewStart":2,"browserViewReady":3,"streamInvoke":81,"dimsResolveBegin":81,"dimsResolve":286,"profilerBegin":286,"adb-socket-connected":1326,"codec-meta":2018,"h264-first-packet":2085,"firstFrame":2104},"dimsResolveDurationMs":205,"getDevicesPollOverlap":false,"getDevicesPollStartedAt":null,"dims":{"cacheHit":false,"listUnifiedMs":64,"wmSizeMs":141,"totalMs":205,"resolvedFromCache":false}}
[LATENCE-DIMS] instance-1783438625780-376 | total: 205ms | listUnified: 64ms | wmSize: 141ms | cacheHit: no | pollOverlap@click: no
[LATENCE-ADB] instance-1783438625780-376 | dims: 205ms | jarPush: 82ms | tunnel: 128ms | spawn: 0ms | delay350~: 0ms | connectSockets: 457ms | deviceMeta: 1ms | scrcpy.start total: —ms
```

##### Run 2 — `instance-1783438630052-322`

| Mesure | Valeur |
|--------|--------|
| **dimsResolve total** | **180 ms** (listUnified **58 ms** + wmSize **122 ms**, cache **non**) |
| **poll get-devices au clic** | **non** |
| streamInvoke → profilerBegin | **180 ms** |
| profilerBegin → adb-socket-connected | **1064 ms** |
| streamInvoke → adb-socket-connected | **1244 ms** |

```
[LATENCE] Type A - Total: 1344ms | registerView: 2ms | adb-socket: 1320ms | first-packet: 1320ms | decode+render: 24ms
[LATENCE] Détail A instance-1783438630052-322: {"stages":{"click":0,"registerViewStart":1,"browserViewReady":2,"streamInvoke":76,"dimsResolveBegin":76,"dimsResolve":256,"profilerBegin":256,"adb-socket-connected":1320,"codec-meta":1320,"h264-first-packet":1320,"firstFrame":1344},"dimsResolveDurationMs":180,"getDevicesPollOverlap":false,"getDevicesPollStartedAt":null,"dims":{"cacheHit":false,"listUnifiedMs":58,"wmSizeMs":122,"totalMs":180,"resolvedFromCache":false}}
[LATENCE-DIMS] instance-1783438630052-322 | total: 180ms | listUnified: 58ms | wmSize: 122ms | cacheHit: no | pollOverlap@click: no
[LATENCE-ADB] instance-1783438630052-322 | dims: 180ms | jarPush: 75ms | tunnel: 123ms | spawn: 0ms | delay350~: 0ms | connectSockets: 497ms | deviceMeta: 2ms | scrcpy.start total: —ms
```

##### Run 3 — `instance-1783438633473-849`

| Mesure | Valeur |
|--------|--------|
| **dimsResolve total** | **0 ms** (cache dims **oui** — pas de listUnified ni wmSize) |
| **poll get-devices au clic** | **non** |
| streamInvoke → profilerBegin | **0 ms** |
| profilerBegin → adb-socket-connected | **632 ms** |
| streamInvoke → adb-socket-connected | **632 ms** |

```
[LATENCE] Type A - Total: 1059ms | registerView: 2ms | adb-socket: 710ms | first-packet: 1048ms | decode+render: 11ms
[LATENCE] Détail A instance-1783438633473-849: {"stages":{"click":0,"registerViewStart":1,"browserViewReady":2,"streamInvoke":78,"dimsResolveBegin":78,"dimsResolve":78,"profilerBegin":78,"adb-socket-connected":710,"codec-meta":1027,"h264-first-packet":1048,"firstFrame":1059},"dimsResolveDurationMs":0,"getDevicesPollOverlap":false,"getDevicesPollStartedAt":null,"dims":{"cacheHit":true,"listUnifiedMs":0,"wmSizeMs":0,"totalMs":0}}
[LATENCE-DIMS] instance-1783438633473-849 | total: 0ms | listUnified: 0ms | wmSize: 0ms | cacheHit: yes | pollOverlap@click: no
[LATENCE-ADB] instance-1783438633473-849 | dims: 0ms | jarPush: 136ms | tunnel: 118ms | spawn: 0ms | delay350~: 359ms | connectSockets: 9ms | deviceMeta: 1ms | scrcpy.start total: —ms
```

##### Synthèse — trancher poste A vs poste B

| Poste | Moyenne (3 runs) | Verdict |
|-------|------------------|---------|
| **A — dimsResolve** (`listUnifiedDevices` + `wm size`) | **~128 ms** (205 + 180 + 0) / 3 ; **~192 ms** si cache froid seulement | **Écart mineur** — n'explique pas les ~900 ms |
| **B — poll `get-devices` au clic** | **0 / 3 overlap** | **Écartué sur ces runs** (pas de chevauchement au moment du clic) |
| **profilerBegin → adb-socket-connected** (`client.start()` en contexte app) | **~912 ms** (1040 + 1064 + 632) / 3 | **Goulot principal** |
| dont `connectSockets` (`[LATENCE-ADB]`) | **~321 ms** (457 + 497 + 9) / 3 vs **~23 ms** benchmark isolé | **×14 en app** — contention ADB / charge parallèle (audio `scrcpy.exe`, `DevicePower`, etc.) |
| Benchmark isolé `scrcpy.start` | **~583 ms** | Référence sans préambule dims ni charge app |

**Conclusion mesurée :** le poste **A** (dims) contribue **~13 %** de `streamInvoke→adb` quand le cache dims est froid (~200 ms), **0 %** quand chaud. Le poste **B** (poll 8 s au clic) est **absent** sur ces 3 runs. Le reliquat (**~700–1000 ms**) se situe dans **`client.start()` sous charge réelle**, principalement **`connectSockets`** (457–497 ms vs 9–30 ms en benchmark isolé), pas dans la résolution dims ni dans un poll chevauchant le clic.

**Moyenne globale (3 runs UI) :**

```
[LATENCE] Moyenne Type A (n=3) - Total: 1502ms | registerView: 2ms | adb-socket: 1119ms | first-packet: 1484ms | decode+render: 18ms
```

#### Pistes d'optimisation (non implémentées — décision ensemble)

1. Skip push si jar présent + hash/taille OK (modif `_pushServer` — zone LOCK).
2. Réduire / supprimer les **350 ms** (zone LOCK — risque race).
3. Pré-push jar à la détection device (couche amont, hors LOCK).
4. Éviter `listUnifiedDevices()` complet dans `resolveDeviceDimensionsForSerial` si serial USB déjà connu (hors LOCK `scrcpy-socket.js`).
5. Ne plus vider `deviceDimensionsCache` à chaque `get-devices` — ou pré-remplir au poll (hors LOCK).
6. Paralléliser `registerView` + `client.start()` (gain hors ce bloc mais sur total clic→frame).

---

## TÂCHE — Sidebar rétractable (2026-07-07)

**Statut : implémenté & verrouillé.**

### Comportement

- Toute la sidebar (`#sidebar` + contenu actuel) se replie en un seul bloc via `#sidebar-shell`.
- État `sidebarOpen` (défaut `true`), persisté dans `ui-preferences.json` (`sidebarOpen`) + miroir `localStorage` (`androidHub.sidebarOpen`) pour éviter le flash au chargement.
- Bouton flèche `#sidebar-collapse-btn` toujours visible sur le bord (chevron gauche/droite).
- Raccourci **Ctrl+B** / **Cmd+B** — toggle ; `preventDefault()` ; ignoré dans les champs texte ; pas de conflit avec Ctrl+Tab.
- Animation CSS `width 0.2s ease` sur `.sidebar-shell`.
- Layout vidéo : `sidebar-panel-layout.js` mesure `#sidebar-shell` → `--sidebar-width` → `reportContentBounds()` → `sessionAPI.setContentBounds` (BrowserView canvas, zones LOCK intactes).

### Fichiers

| Fichier | Rôle |
|---------|------|
| `sidebar/SidebarCollapse.js` | Toggle, persistance, raccourci, API `window.toggleSidebar` |
| `index.html` | Wrapper `#sidebar-shell`, script anti-flash, chargement |
| `styles/style.css` | Shell, bouton, transitions |
| `sidebar-panel-layout.js` | Mesure shell + ResizeObserver |
| `ui-preferences-manager.js` | `sidebarOpen` dans `ui-preferences.json` |
| `uiPreferencesHandlers.js` + `preload.js` | IPC `ui:get-preferences` / `ui:set-sidebar-open` |
| `locale-data-*.js` + JSON | `sidebar.collapse` / `sidebar.expand`, aide Ctrl+B |

### Règle LOCK

> Ne pas modifier la logique interne des panneaux sidebar (devices, toggles, etc.) pour le repli — uniquement le wrapper shell / layout / persistance UI. Toute évolution layout doit passer par `SidebarCollapse.js` + `sidebar-panel-layout.js` + `reportContentBounds`.

**Zones LOCK :** aucune (`scrcpy-socket.js`, `new-instance-manager.js`, input, audio, orientation).

---

## TÂCHE — Fix collisions scope global i18n / modales (2026-07-06)

**Statut : corrigé & verrouillé.**

### Diagnostic

- Après i18n FR/EN (`d25edef`), plusieurs scripts `<script>` globaux déclaraient les mêmes identifiants :
  - `const t` dans `DevicePanel.js` + `new-session.js` → `SyntaxError: Identifier 't' has already been declared` → **`new-session.js` ne chargeait plus**.
  - `const api` dans `app-display.js` + `stream-params.js` → `AppDisplay` / `StreamParams` absents du renderer.
- Conséquence : aucune modale (Nouvelle instance, Paramètres, Aide), pas de mirroring, pas de `__hubModalMainActions`.

### Correctif

| Fichier | Changement |
|---------|------------|
| `sidebar/DevicePanel.js` | Helper i18n renommé `dt` (scope global unique) |
| `shared/app-display.js` | `appDisplayApi` (plus de collision `api`) |
| `shared/stream-params.js` | `streamParamsApi` |
| `new-session.js` | `window.openNewSessionPanel` exposé |
| `app.js` | `openNewSessionPanelFromMain()` |
| `index.html` | Sidebar → `openNewSessionPanelFromMain()` |
| `hub-modal/hub-modal-window.js` | Références `window.openNewSessionPanel` / `openSettingsPanel` / `openHelpPanel` |

### Détection appareils (inchangée)

- Polling renderer **8 s** (`devices.js`).
- `get-devices` invalide toujours les caches à chaque appel (`invalidateSessionAdbSerialCache`, `deviceDimensionsCache.clear`).

### Règle LOCK (post-i18n)

> **Ne pas déclarer `const t` ni `const api` au scope global** dans les scripts renderer chargés via `<script>` sans IIFE. Utiliser un nom unique (`dt`, `appDisplayApi`, …) ou encapsuler dans une IIFE comme les autres composants.

**Zones LOCK :** aucune touchée (`scrcpy-socket.js`, `new-instance-manager.js`, input, audio, orientation).

---

## TÂCHE — Sidebar Paramètres (regroupement Appareils / Contrôle / Nettoyage) (2026-07-06)

**Statut : implémenté.**

- Nouveau bouton **Paramètres** dans la sidebar (remplace Appareils + Contrôle).
- Modal unique `panel-settings` avec onglets : Appareils | Contrôle | Nettoyage.
- Logique inchangée : `DevicesPanel.js`, `ControlPanel.js`, maintenance/cleanup (mêmes IDs DOM).
- Rétrocompatibilité : `openDevicesPanel` / `openControlPanel` et `panel: devices|control` redirigent vers Paramètres.
- i18n : `settingsPanel.*`, `sidebar.settings`.

---

## TÂCHE — Support multi-langue FR/EN (2026-07-06)

**Statut : implémenté.**

- i18n léger côté Renderer (`HubI18n` : `t()`, `setLocale`, `applyDomI18n`, événement `hub:locale-changed`).
- Fichiers de traduction : `src/shared/locales/fr.json` + `en.json` (clés identiques, ~260+ entrées dont aide complète). Miroir généré dans `src/renderer/locales/` via `node scripts/build-locales.js`.
- Persistance : `ui-preferences.json` (`locale: fr|en`) via `UiPreferencesManager` + IPC `ui:get/set-locale`.
- Bouton langue dans la sidebar, sous « Aide » : badge FR/EN, bascule immédiate + broadcast vers fenêtre modale.
- Menus contextuels natifs (Main) traduits via la même locale.
- Zones LOCK (input, vidéo, audio, orientation) non modifiées.

---

## TÂCHE — Contour vert fenêtre/onglet actif (2026-07-06)

**Statut : implémenté.**

- Réutilise `setActiveSessionTab` / `session.active` / `session:activated` / `session:cycleTab` (Ctrl+Tab) — pas de nouveau tracking.
- Onglet actif : bordure verte inset 2px + accent bas 3px (`.scrcpy-tab.active`).
- Zone vidéo : `box-shadow` inset 3px sur `.content.content--session-focused`.
- Pastille couleur appareil (`.tab-icon.device-color-pill`) inchangée, distincte du contour de focus.

---

## TÂCHE — Inventaire emplacements logs (2026-07-06)

**Statut : documenté (audit code, pas de code nettoyage).**

Livrable détaillé : **[LOGS_STRUCTURE.md](./LOGS_STRUCTURE.md)**

### Résumé

| Zone | Chemin / comportement |
|------|------------------------|
| **Seul log fichier Hub confirmé** | `{userData}/update.log` — append illimité, auto-updater (`auto-updater.js`) |
| **Dossier `logs/`** | Cible maintenance mais **non écrit** par le code actuel |
| **ADB / scrcpy** | **Aucune** redirection fichier — stdout/stderr → `console.*` uniquement |
| **Par session / device** | Processus en mémoire (`scrcpy.exe`, `adb shell` server) ; pas de `*.log` par serial ou sessionId |
| **Détection verrou** | Déjà implémentée : `tryDeleteFile()` ouvre en `r+`, skip si `EBUSY`/`EPERM`/`EACCES` |

**Recommandation nettoyage** : ne supprimer que `update.log` + contenu ancien de `logs/` ; s’appuyer sur le skip lock existant + filtre d’âge pour l’auto-nettoyage.

---

## TÂCHE — Fix compteur historique modal Nettoyer (2026-07-06)

**Statut : corrigé.**

### Diagnostic

- L'affichage principal (`launch-history:list` → `LaunchHistoryManager.list()`) montre toutes les entrées valides visibles (après `pruneStale` 2 jours).
- Le compteur modal utilisait `purgeOlderThan(cutoff 7 jours)` : une app lancée récemment comptait **0** entrée éligible alors que l'historique principal en affichait au moins 1.
- Même source (`launch-history.json` / `LaunchHistoryManager`), mais **logique de comptage différente** (filtre d'âge 7 jours vs liste complète).

### Correctif

- `LaunchHistoryManager.collectMaintenanceKeys()` + `purgeForMaintenance({ olderThanMs })` : alignés sur `list()` (même `pruneStale`, exclusion sessions Type B actives).
- **Preview / nettoyage manuel** : `olderThanMs = null` → compte et supprime toutes les entrées visibles dans l'historique.
- **Nettoyage auto** (`startup` / `interval`) : conserve le filtre 7 jours via `olderThanMs = cutoff`.

---

## TÂCHE — Nettoyage sélectif logs / cache / historique (2026-07-06)

**Statut : implémenté (main + preload + panneau Appareils).**

### Diagnostic

- Le nettoyage global existant (`MaintenanceCleanupManager`) ciblait logs + cache sans distinction ; l'historique (`launch-history.json`) était exclu.
- Les catégories naturelles : **logs** (`update.log`, `logs/`), **cache** (`app-icons/`, `app-metadata-cache.json`, `cache/`), **historique** (entrées `LaunchHistoryManager` plus anciennes que le seuil).
- Le panneau `Appareils` est le point d'entrée UX ; les préférences auto-clean sont regroupées dans la section Maintenance (pas de panneau Paramètres global dédié).

### Implémentation

- **Main** : refactor `MaintenanceCleanupManager` par catégorie (`logs`, `cache`, `history`), préférences persistées (`maintenance-preferences.json`), auto-clean respecte les toggles par catégorie.
- **LaunchHistoryManager** : `purgeOlderThan(cutoff, { dryRun })` pour preview/run historique (respecte sessions Type B actives).
- **IPC** : `maintenance:cleanup-preview` / `maintenance:cleanup-run` acceptent `{ categories }` ; `maintenance:get-preferences` / `maintenance:set-preferences`.
- **Preload** : `maintenanceAPI` étendu (preview/run avec catégories, get/set preferences).
- **Renderer** : modal de sélection avec 3 cases + tailles/comptes, boutons tout sélectionner/désélectionner, résumé détaillé par catégorie en toast ; 3 toggles auto-clean dans la section Maintenance.

---

## TÂCHE — Nettoyage logs/cache auto + bouton manuel (2026-07-06)

**Statut : implémenté (main + preload + panneau Appareils).**

### Diagnostic

- Les artefacts réellement "nettoyables" côté Hub sont principalement sous `userData`: `app-icons/` (cache icônes APK), `app-metadata-cache.json` (index cache), `update.log`; dossiers `logs/` et `cache/` pris en charge s'ils existent.
- Les fichiers de configuration/historique (`custom-names.json`, `wifi-devices.json`, `device-history.json`, `launch-history.json`, `device-colors.json`) ne doivent jamais être ciblés.
- Le panneau `Appareils` est déjà le bon point d'entrée UX (`DevicesPanel.js` + `hub-modal-window.html`).

### Implémentation

- **Main** : `MaintenanceCleanupManager` modulaire (preview/run, auto au démarrage + intervalle, prune dossiers vides, skip fichiers verrouillés `EBUSY/EPERM/EACCES`).
- **IPC** : `maintenance:cleanup-preview` + `maintenance:cleanup-run` (`maintenanceHandlers.js`) avec résumé UI.
- **Preload** : `maintenanceAPI.previewCleanup()` / `maintenanceAPI.runCleanup()`.
- **Renderer** : bouton `Nettoyer maintenant` dans le panneau `Appareils`, confirmation utilisateur avec taille estimée, toast de résultat (`X Mo libérés, N fichiers supprimés`).
- Seuil par défaut: **7 jours**, configurable via `ANDROID_HUB_CLEANUP_MAX_AGE_DAYS`.

---

## TÂCHE — Logo application sur onglets/fenêtres (2026-07-06)

**Statut : implémenté (async + fallback).**

- Réutilisation du mécanisme existant `AppMetadataManager` via IPC `app-metadata:resolve` (pas de duplication extraction APK).
- Onglets session (`Sidebar.js`) : ajout d'une icône applicative à côté du badge type, avec placeholder SVG immédiat.
- Chargement non bloquant : résolution asynchrone par session (`stableDeviceId + package + userId`) puis mise à jour visuelle à chaud.
- Cache côté renderer pour éviter les résolutions répétées ; écoute `app-metadata:updated` pour hydrater les onglets dès qu'une icône est prête.
- Aucune modification des zones LOCK input/vidéo/orientation/audio.

---

## Validé & verrouillé (LOCK)

| Domaine | Statut | Commit / note |
|---------|--------|----------------|
| Audio capture + son PC Type A/B | ✅ LOCK | Validé utilisateur |
| **Audio OFF par défaut au démarrage** | ✅ **LOCK** | **2026-07-08** — `globalMuted: true`, Type B `audio: false` |
| Mute global OFF (silence) | ✅ LOCK | Validé utilisateur |
| **Input global (Type A/B, USB/WiFi, portrait/paysage)** | ✅ **LOCK DÉFINITIF** | **2026-07-05** — voir § ci-dessous |
| Input Type A multi-fenêtres | ✅ LOCK | `c23e7cb` (inclus dans lock définitif) |
| Input Type B multi-fenêtres (display virtuel) | ✅ LOCK | `c23e7cb` (inclus dans lock définitif) |
| `scrcpy-socket.js` | ✅ LOCK | Section 13 + orientation `capture_orientation` (2026-07-05) |
| `new-instance-manager.js` | ✅ LOCK | Section 13 |
| `adb-input-controller.js` | ✅ LOCK | Input ADB / display virtuel (2026-07-05) |
| **Noms appareils & onglets (USB/WiFi)** | ✅ **LOCK** | **2026-07-05** — `custom-names-manager.js`, `namesHandlers.js` |
| **Multi-appareils (poll, labels, input cache)** | ✅ **LOCK** | **2026-07-08** — `973a28a` — voir § ci-dessous |
| Toggle Audio ON/OFF (bouton) | ✅ OK | Voir section ci-dessous |

**Aucune modification sur ces zones sans accord explicite.**

---

## ⚠️ INPUT LOCKÉ (2026-07-05)

Ne plus modifier la logique d'input (Type A/B, USB/WiFi, portrait/paysage). Ce module a causé plusieurs régressions lors de l'ajout de l'orientation WiFi. Toute nouvelle feature doit passer par une **couche en amont**, jamais dans les fichiers input directement.

**Si un bug d'input apparaît à l'avenir :** diagnostiquer avant toute correction et **valider avec l'utilisateur** avant de toucher à ce module.

### Fichiers LOCK input (liste complète)

| Fichier | Rôle |
|---------|------|
| `src/renderer/session/session.js` | Handlers pointer Type A/B, remap portrait, clic droit BACK, `getCanvasContentRect` |
| `src/main/main.js` | `send-input`, `sendTypeBInputViaHubAdb`, contrôleurs ADB session |
| `src/native/scrcpy/control/adb-input-controller.js` | Injection ADB tactile / clés / display virtuel |
| `src/main/ipc/sessionHandlers.js` | `session:getInputContext` |
| `src/preload/sessionPreload.js` | `videoAPI.sendInput`, `getInputContext` |

### Comportements validés

- Type A paysage + portrait (interim et flux natif) — USB/WiFi
- Type B display virtuel — coords canvas, hub ADB `displayId` — USB/WiFi
- Clic, drag, clic long, BACK clic droit, clavier

Référence détaillée : `AI_CONTEXT.md` § Input LOCK DÉFINITIF.

---

## ⚠️ NOMS LOCKÉS (2026-07-05)

Source de vérité unique pour noms appareils + onglets/fenêtres. Clé canonique = **`deviceId` stable**, pas serial transport (`ip:port`).

| Fichier | Rôle |
|---------|------|
| `src/main/managers/custom-names-manager.js` | `custom-names.json` ; consolidation alias USB/WiFi |
| `src/main/ipc/namesHandlers.js` | IPC rename/reset ; résolution stable ; sync sessions ouvertes |

**Validé :** renommer depuis USB ou WiFi → panneau, sidebar, Nouvelle instance, onglets cohérents.

Référence : `AI_CONTEXT.md` § Noms appareils & onglets — LOCK.

---

## Bugs corrigés & verrouillés — ne pas réouvrir sauf régression (2026-07-05)

| Bug / domaine | Statut | Note |
|---------------|--------|------|
| Parité USB/WiFi Phase 1–2 (identité, `adbSerialArg`) | ✅ RÉSOLU | Ne pas réouvrir |
| Flux vidéo à l'envers (orientation capture) | ✅ RÉSOLU LOCK | `scrcpy-socket.js` validé |
| Bouton orientation portrait WiFi | ✅ RÉSOLU | Amont `stream-params-manager` / `session.js` |
| Clic long Type B display virtuel (USB/WiFi) | ✅ RÉSOLU LOCK | `_activeTouchStart` + ADB virtuel (2026-07-08) |
| Clic long + BACK Type B WiFi (F1–F4) | ✅ RÉSOLU LOCK | Ne pas réouvrir |
| Input continu mode portrait WiFi/USB | ✅ RÉSOLU LOCK | `session.js` remap + drag guards (2026-07-05) |
| Input cassé global post-orientation (R1) | ✅ RÉSOLU LOCK | Retrait pointerleave/lostpointercapture |
| Input Type A portrait surface complète | ✅ RÉSOLU LOCK | Fix remap `canvasWidth` vs `canvasHeight` (2026-07-05) |
| Input Type B display virtuel | ✅ RÉSOLU LOCK | Coords canvas directes + hub ADB (2026-07-05) |
| Orientation Type B (paysage fixe) | ✅ RÉSOLU | Isolation Type A dans session + stream-params |

**Instruction utilisateur :** ces items sont considérés réglés — ne revenir dessus que si un **nouveau symptôme** apparaît.

---

## Toggle Audio ON/OFF — état du bouton (2026-07-04, défaut OFF 2026-07-08)

**Verdict : fonctionnel — défaut OFF au démarrage (LOCK 2026-07-08).**

### Défaut au démarrage (LOCK)

| Élément | Valeur | Fichier |
|---------|--------|---------|
| Mute global initial | `globalMuted: true` (OFF) | `global-audio-output-manager.js` |
| UI sidebar | Badge OFF, icône coupée | `index.html`, `GlobalAudioToggle.js` |
| Hub renderer fallback | `globalMuted: true` | `session-audio-hub.js` |
| Type B création session | `audio: false` dans `streamOptions` | `new-session.js` |

L'utilisateur active le son via le toggle sidebar (ON). Ne pas remettre audio ON par défaut sans accord explicite.

### Comportement vérifié (câblage)

| Action utilisateur | Déclenchement | Effet métier (LOCK, inchangé) |
|--------------------|---------------|------------------------------|
| Clic → passer OFF | `audioAPI.toggleGlobalMuted()` → `audio:toggleGlobalMuted` | `GlobalAudioOutputManager.setGlobalMuted(true)` → `applyGlobalAudioMuteSideEffects` → `sessionAudioProcessManager.stopAll()` |
| Clic → passer ON | idem | `setGlobalMuted(false)` → `syncAllActiveSessions()` (relance scrcpy audio PC) |

### Synchronisation UI

- **Au chargement :** `refreshGlobalAudioToggle()` lit `audio:getGlobalState`.
- **Au clic :** état mis à jour depuis le résultat IPC + classe `pending` pendant l'appel async.
- **Broadcast :** `audio:global-state-changed` (main + BrowserViews) → `onGlobalStateChanged` dans `GlobalAudioToggle.js`.
- **Visuel :** classes `audio-on` / `audio-off`, badge ON/OFF, icônes on/off, tooltip.

### Fichiers du bouton uniquement

- `src/renderer/sidebar/GlobalAudioToggle.js`
- `src/renderer/index.html` (`#nav-toggle-global-audio`)
- `src/preload/preload.js` (`audioAPI`)
- `src/main/ipc/audioHandlers.js` (handlers + broadcast — pas la logique mute)

---

## En attente / hors scope LOCK

- (aucun item documentation LOCK en attente — input + noms + contexte à jour 2026-07-05)

---

## Double-clic sidebar → bouton Mirroring (2026-07-04)

| Élément | Détail |
|---------|--------|
| **Fichiers modifiés** | `src/renderer/sidebar/DevicePanel.js`, `src/renderer/new-session.js` |
| **Handler ponté** | `onMirrorButtonClick()` — même handler que `#new-instance-mirror-btn` |
| **Préparation device** | `setSelectedDeviceForMirror(serial, name)` puis `onMirrorButtonClick()` (équivalent sélection + clic Mirroring) |
| **Clic simple (sidebar)** | Aucun handler — inchangé |
| **Clic droit (sidebar)** | Menu contextuel renommage / couleur — inchangé |
| **Double-clic (sidebar)** | Mirroring Type A direct, sans confirmation |

Zones LOCK non touchées (`scrcpy-socket.js`, `new-instance-manager.js`).

---

## Style visuel bouton — carte device sidebar (2026-07-04)

| Élément | Détail |
|---------|--------|
| **Fichier modifié** | `src/renderer/styles/style.css` (`.sidebar-device-card`) |
| **Trigger mirroring** | Double-clic uniquement — inchangé (`DevicePanel.js`, handler `onMirrorButtonClick`) |
| **Clic simple** | Aucun handler ajouté — inchangé |
| **Clic droit** | Menu contextuel renommage / couleur — inchangé |
| **Style appliqué** | `cursor: pointer`, hover (fond + bordure + ombre), `:active` (effet pressed) |

Aucune modification JS, tooltip, texte ou logique métier.

---

## ÉTAPE 1 — Diagnostic WiFi ADB (2026-07-05)

**Statut : validé par l'utilisateur — implémentation en cours.**

---

### 1. Détection / liste des devices — où, comment, source de vérité

#### Backend (main process)

| Fichier | Rôle |
|---------|------|
| `src/main/managers/device-manager.js` | **`DeviceManager.getConnectedDevices()`** — exécute `adb devices -l`, parse serial / state / model → `{ serial, status, name, connected }` |
| `src/main/main.js` | Fallbacks dupliqués **`getConnectedDevices()`** et **`getConnectedDevicesSimple()`** (même parsing, sans `-l` pour le simple) |
| `src/main/main.js` | Handlers IPC **`get-devices`** (l.741) et **`device:list`** (l.788) — **logique quasi identique dupliquée** |
| `src/main/main.js` | Post-traitement commun : `updateDevicesInHistory()` → `customNamesManager.applyDeviceNames()` → `applyDeviceColorMetadata()` → fusion historique déconnecté |

Enrichissement live (batterie + état radio WiFi du téléphone) :

- `DeviceManager.enrichDevicesWithStatus()` / `getDeviceLiveStatus()` via `dumpsys battery` + `dumpsys wifi`
- ⚠️ Le badge « WiFi » sidebar = **état radio WiFi Android**, pas le transport ADB-over-WiFi.

#### Renderer (UI)

| Fichier | Rôle |
|---------|------|
| `src/renderer/devices.js` | **Polling partagé** : `electronAPI.getDevices()` toutes les 8 s → `currentDevices` → event **`devices-refreshed`** |
| `src/renderer/sidebar/DevicePanel.js` | Sidebar : écoute `devices-refreshed`, **`dedupeConnectedDevices()`** par serial, rendu cartes |
| `src/renderer/new-session.js` | Sélecteur « Nouvelle instance » : **`fetchConnectedDevices()`**, cache `connectedDevicesCache`, **`renderDeviceList()`**, écoute `devices-refreshed` (modal enfant uniquement) |

#### Verdict source de vérité

| Couche | Une seule source ? | Détail |
|--------|-------------------|--------|
| Backend ADB brut | ❌ Non | 3 implémentations de parsing (`DeviceManager` + 2 fallbacks `main.js`) + 2 handlers IPC identiques |
| Renderer état devices | ⚠️ Partiel | **`devices.js`** est le hub de polling, mais **déduplication dupliquée** (`dedupeDevices` vs `dedupeConnectedDevices`), rendu dupliqué (sidebar vs new-session), fallback IPC direct dans `fetchConnectedDevices()` |
| Identité / noms / couleurs | ❌ Clé = serial ADB | Tous les managers persistent par **serial brut** — USB et WiFi du même téléphone = **2 entrées distinctes** aujourd'hui |

**Structure objet device actuelle (connecté) :**

```js
{
  serial,           // clé primaire partout (USB id ou futur ip:port)
  status,           // "green" | "orange" | "red"
  name,             // modèle ADB ou nom custom
  originalName,
  hasCustomName,
  connected,        // true/false
  battery,          // enrichi
  wifiStatus,       // radio WiFi téléphone ("Connecté", "Désactivé"…)
  deviceColor,      // pill couleur sidebar
  lastSeen          // devices historiques déconnectés
}
```

---

### 2. Identification device — serial ADB vs identifiant stable

#### Aujourd'hui

- **Identifiant unique = serial ADB brut** retourné par `adb devices` (1re colonne).
- USB : ex. `R58M90ABCDE`
- WiFi (futur) : ex. `192.168.1.10:5555`
- **Aucun appel** à `getprop ro.serialno`, `android_id`, ou autre identifiant stable dans le codebase (grep : 0 occurrence `tcpip`, `adb connect`, `ro.serialno`, `android_id`).

#### Persistance existante (toutes indexées par serial ADB)

| Fichier userData | Manager | Clé |
|------------------|---------|-----|
| `custom-names.json` | `CustomNamesManager` | `devices[serial]` |
| `device-colors.json` | `DeviceColorsManager` | `devices[serial]` |
| `device-history.json` | inline `main.js` | `history[serial]` |
| `launch-history.json` | `LaunchHistoryManager` | `deviceId` (= serial) |
| `app-metadata-cache.json` | `AppMetadataManager` | serial + package |

#### Recommandation pour fusion USB + WiFi

| Identifiant | Commande | Intérêt |
|-------------|----------|---------|
| **`ro.serialno`** (recommandé) | `adb -s <serial> shell getprop ro.serialno` | Stable matériel, identique USB et WiFi, déjà convention ADB |
| `android_id` | `adb shell settings get secure android_id` | Stable par profil utilisateur ; peut diverger multi-utilisateur |
| Serial USB brut | — | **Ne convient pas** seul : change quand on bascule transport |

**Point d'attention :** migrer ou mapper `custom-names`, `device-colors`, `launch-history` vers un **`deviceId` stable** (ou maintenir un mapping stableId ↔ transports) pour éviter perte de noms/couleurs au toggle WiFi.

---

### 3. Point d'injection — où le target/serial entre dans les sessions (avant zones LOCK)

> Note : il n'existe pas de fonction `createSession()` dans le code. Les équivalents sont **`createInstance()`** (Type A) et **`createNewInstanceSession()`** (Type B, LOCK).

#### Type A — Mirroring complet

```
DevicePanel dblclick / onMirrorButtonClick
  → launchMirrorSession({ serial, deviceName })          [new-session.js]
  → createInstance(serial, deviceName, null, opts)       [instance-manager.js]
  → player.start(serial, …)                              [video-player.js]
  → IPC start-video-stream { serial, tabId, … }          [main.js]
  → startVideoStreamLogic → new ScrcpySocketClient(adb, serial)   [LOCK scrcpy-socket.js]
```

#### Type B — Nouvelle instance (display virtuel)

```
selectDevice(serial) / launchNewInstanceSession
  → launchTypeBSession({ serial, … })                    [new-session.js]
  → IPC new-instance:launch { serial, packageName }        [main.js → scrcpy externe]
  → IPC new-instance:create { serial, … }                [new-instance-ipc.js]
  → createNewInstanceSession({ serial, … })              [LOCK new-instance-manager.js]
  → startNewInstanceSession → ScrcpySocketClient         [LOCK]
```

#### Couche cible recommandée (respect Mode LOCK)

**Nouvelle couche « target resolution » en amont**, sans modifier les fichiers LOCK :

1. **Main process** : service dédié (ex. `device-target-resolver.js` + `wifi-devices-manager.js`) qui :
   - fusionne transports USB/WiFi par `deviceId` stable ;
   - expose la liste unifiée aux IPC ;
   - résout `resolveAdbSerial(logicalDeviceId)` → serial effectif (`usbSerial` ou `ip:port`) selon `wifiEnabled`.

2. **Points d'injection renderer (serial → serial résolu)** — **avant** tout appel session :
   - `launchMirrorSession` / `createInstance`
   - `launchTypeBSession` / `selectedDevice.serial`
   - `loadAppsForSelectedDevice` / `getAppsWithDetails(serial)`
   - Double-clic sidebar (`setSelectedDeviceForMirror`)

3. **Alternative plus propre** : résolution **côté main** dans les handlers IPC existants (`get-devices`, `get-apps`, `new-instance:launch`, `start-video-stream`) via un wrapper — le renderer manipule un **`deviceId` logique**, le main traduit en serial ADB. Les zones LOCK reçoivent déjà un serial string ; elles n'ont pas besoin de savoir USB vs WiFi.

---

### 4. Stockage local — existant vs à créer

#### Pattern établi

- Répertoire : `app.getPath("userData")` (Electron)
- Managers dédiés dans `src/main/managers/` + handlers IPC dans `src/main/ipc/`
- JSON synchrones ou flush différé (`device-history` flush 2 s)

#### Fichiers existants (réutilisables comme modèle)

- `custom-names-manager.js` → renommage (popup première connexion WiFi pourrait s'appuyer dessus **ou** champ `name` dédié WiFi)
- `device-colors-manager.js` → couleurs (à re-cléer sur `deviceId` stable si fusion)
- `launch-history-manager.js` → historique apps Type B (impact si `deviceId` change de serial)

#### WiFi — rien n'existe

- Pas de config `{ deviceId, name, ip, port, wifiEnabled, lastSeen }`
- Pas de logique `adb tcpip`, `adb connect`, parsing `wlan0`
- **À créer** : nouveau manager + JSON (ex. `wifi-devices.json`) + handlers IPC dédiés

#### Feedback UI (toasts)

- Pas de système toast global aujourd'hui
- « Nouvelle instance » : `setStatus()` inline dans `new-session.js` (texte statut panneau)
- Panneau contrôle : `ControlPanel.setStatus()` avec types info/success/error
- **À créer** pour C-bis : composant toast léger (sidebar ou overlay global) — hors zones LOCK

---

### 5. Risques / contraintes identifiés pour l'implémentation

| Risque | Impact |
|--------|--------|
| Double entrée ADB (USB + WiFi simultanés) | 2 serials → 2 cartes sidebar, 2 sessions possibles sur le même téléphone |
| Clés serial dans custom-names / colors / launch-history | Toggle WiFi casse continuité noms/couleurs/historique sans migration |
| Handlers IPC dupliqués `get-devices` / `device:list` | Refactor source de vérité doit toucher les deux (ou fusionner) |
| Confusion badge WiFi sidebar | Affichage actuel = radio téléphone ; feature demandée = transport ADB — **badges distincts requis** |
| `DeviceManager.getDeviceLiveStatus(serial)` | Doit cibler le serial **effectif** (WiFi si toggle ON) |
| Auto-connect au démarrage (feature D) | Hook dans `main.js` après init managers, avant polling renderer |
| Panneau Appareils (feature E) | Nouvelle fenêtre/modal — pattern existant : `hub-modal` ou panneau dédié |

---

### 6. Plan d'implémentation proposé (après validation — ne pas exécuter sans OK)

1. **Source de vérité unique** — manager + IPC unifié, supprimer duplication renderer
2. **Fusion identité** — `getprop ro.serialno`, merge USB/WiFi, priorité affichage USB > WiFi
3. **Toggle + persistance + auto-connect** — manager WiFi, IPC, switch sidebar, toasts
4. **Panneau Appareils** — historique USB/WiFi, actions Renommer / Supprimer / Reconnecter

**Fichiers LOCK intouchables confirmés :** `scrcpy-socket.js`, `new-instance-manager.js`, fichiers input, `createNewInstanceSession()` / `--new-display`.

---

## ÉTAPE A–E — Implémentation WiFi ADB (2026-07-05)

**Statut : implémenté — en attente tests utilisateur.**

### Backend (nouveaux fichiers)

| Fichier | Rôle |
|---------|------|
| `src/main/managers/wifi-devices-manager.js` | Persistance `wifi-devices.json` |
| `src/main/managers/wifi-adb-service.js` | `tcpip`, parse IP `wlan0`, `adb connect`, `getprop ro.serialno` |
| `src/main/managers/device-registry.js` | Liste unifiée, fusion USB/WiFi, résolution serial effectif, auto-connect démarrage |
| `src/main/ipc/wifiHandlers.js` | IPC toggle / panneau / rename / remove / reconnect |

### Backend (modifiés — hors LOCK)

| Fichier | Changement |
|---------|------------|
| `src/main/main.js` | `listDevicesForUI()` unique pour `get-devices` + `device:list`, init registry, auto-connect |
| `custom-names-manager.js` | Clé `deviceId \|\| serial` |
| `device-colors-manager.js` | Idem |
| `namesHandlers.js` | Sync nom → config WiFi si présente |

### Renderer

| Fichier | Changement |
|---------|------|
| `devices.js` | Source renderer unique + `getConnectedDevices()` |
| `sidebar/DevicePanel.js` | Toggle WiFi, badge transport USB/WiFi |
| `toast.js` | Feedback progression / succès / erreur |
| `devices-panel/DevicesPanel.js` | Panneau Appareils (USB + WiFi) |
| `new-session.js` | Liste devices unifiée (transport, deviceId) |
| `preload.js` | `wifiAPI` + `devices:refresh-request` |
| `index.html` | Nav Appareils, scripts |
| `hub-modal/*` | Panel devices |
| `styles/style.css` | Toggle, toasts, panneau |

### Zones LOCK

Aucune modification de `scrcpy-socket.js`, `new-instance-manager.js`, input Type A/B. Le serial passé aux sessions est résolu **en amont** via `DeviceRegistry`.

---

## BUG — Toggle WiFi absent en connexion WiFi seule (2026-07-05)

**Symptôme rapporté :** le switch USB/WiFi n'apparaît pas dans la sidebar quand l'appareil est déjà connecté en WiFi (sans USB).

**Statut : corrigé (2026-07-05).**

### Correctifs appliqués

| Priorité | Fichier | Correction |
|----------|---------|------------|
| P0 | `wifi-adb-service.js` | Helper `adbSerialArg()` — serial quoté dans **toutes** les commandes `-s` / `connect` / `disconnect` |
| P0 | `wifi-adb-service.js` | `findConfigByWifiSerial()` + fallback identité via config si `getprop` échoue |
| P0 | `device-registry.js` | Lookup config par IP/port + réconciliation `deviceId` canonique (`reconcileGroupDeviceId`) |
| P1 | `device-registry.js` | Fusion WiFi : merge par `deviceId` config si serial = ip:port |
| P1 | `DevicePanel.js` | `canToggleWifi` élargi : `usbSerial \|\| wifiConfigured \|\| (transport==='wifi' && connected)` |

---

Le switch n'est injecté dans le DOM **que si** :

```js
const canToggleWifi = Boolean(device.usbSerial || device.wifiConfigured);
```

| Champ | Signification | WiFi seul (USB débranché) |
|-------|---------------|---------------------------|
| `usbSerial` | Serial ADB USB présent dans le groupe fusionné | **`null`** |
| `wifiConfigured` | Entrée trouvée dans `wifi-devices.json` pour ce `deviceId` | **`false` si lookup échoue** |

→ Si les deux sont falsy, **aucun toggle**, même si la carte s'affiche avec le badge « WiFi connecté » (`transport === "wifi"`).

**Écart spec :** un appareil actif en WiFi devrait toujours exposer le toggle (au minimum pour repasser OFF), mais la condition actuelle ne considère ni `transport`, ni `wifiAvailable`, ni `wifiEnabled`.

---

### 2. Source de vérité — le device WiFi est-il bien reconnu ?

**Chaîne :** `get-devices` → `listDevicesForUI()` → `DeviceRegistry.listUnifiedDevices()` → `devices.js` → `devices-refreshed` → `DevicePanel.renderDevicePanel()`.

**Verdict :** oui, l'appareil WiFi **peut apparaître** dans la sidebar sans que le toggle soit éligible.

Cas typique WiFi seul dans `adb devices` (`192.168.x.x:5555`) :

1. `attachStableIds()` appelle `getStableDeviceId("192.168.x.x:5555")`
2. `mergeByDeviceId()` crée un groupe `{ deviceId, wifiSerial, usbSerial: null }`
3. `buildUnifiedEntry()` résout `transport: "wifi"`, `connected: true`, badge OK
4. **Mais** `wifiConfigured` dépend de `configById.get(group.deviceId)`

Le device **est listé** ; c'est le **rattachement config → groupe** qui échoue, pas la détection ADB.

---

### 3. Fusion d'identité — cause racine probable

#### 3a. Mismatch `deviceId` ↔ clé `wifi-devices.json`

Config persistée à la 1ère connexion :

```json
{ "deviceId": "<ro.serialno lu via USB>", "ip": "...", "wifiEnabled": true }
```

À la fusion WiFi seule, lookup :

```js
const wifiConfig = configById.get(group.deviceId) || null;
wifiConfigured: Boolean(wifiConfig)
```

Si `group.deviceId !== entry.deviceId` du JSON → **`wifiConfigured: false`**.

#### 3b. `getStableDeviceId()` — serial WiFi non quoté (bug technique)

Commande actuelle (`wifi-adb-service.js`) :

```js
`"${adbPath}" -s ${key} shell getprop ro.serialno`   // key = 192.168.1.10:5555
```

Sans guillemets autour du serial, **`192.168.1.10:5555` est mal parsé** par le shell Windows (le `:5555` casse l'argument `-s`). `getprop` échoue → fallback :

```js
deviceId: deviceId || device.serial   // → "192.168.1.10:5555"
```

Alors que la config WiFi est indexée par **`ro.serialno`**. Lookup `configById.get("192.168.1.10:5555")` → **`null`**.

#### 3c. Fallback `getStableDeviceId` pour serial WiFi

Si `getprop` échoue et serial est WiFi :

```js
return null;  // pas de fallback ro.serialno
// attachStableIds: deviceId = device.serial (ip:port)
```

Pas de second essai (`settings get secure android_id`) ni lookup config par IP.

#### 3d. Boucle secondaire `listUnifiedDevices` (configs orphelines)

Les configs dont le `deviceId` ne matche aucun groupe restent dans `configById` et peuvent produire une **2e entrée** (si `wifiEnabled`). Risque de **doublon sidebar** : une carte sans toggle (`deviceId=ip:port`) + une avec toggle (`deviceId=ro.serialno`), selon succès/échec de `getprop`.

---

### 4. Synthèse cause → effet

```
adb WiFi seul (ip:port)
  → getprop ro.serialno échoue (serial non quoté / timeout)
  → group.deviceId = "ip:port"  ≠  config.deviceId = "ro.serialno"
  → wifiConfigured = false
  → usbSerial = null
  → canToggleWifi = false
  → PAS DE TOGGLE (carte visible quand même)
```

---

### 5. Corrections proposées (après validation)

| Priorité | Fichier | Correction |
|----------|---------|--------------|
| P0 | `wifi-adb-service.js` | Quoter le serial dans **toutes** les commandes `-s` (`"${serial}"`) |
| P0 | `device-registry.js` | Fallback lookup config par **IP/port** (`wifiSerial` ↔ `ip:5555`) si `configById.get(deviceId)` échoue |
| P1 | `device-registry.js` | Réconcilier `deviceId` du groupe avec config trouvée par IP (éviter doublons) |
| P1 | `DevicePanel.js` | Élargir `canToggleWifi` : `usbSerial \|\| wifiConfigured \|\| (transport==='wifi' && connected)` |
| P2 | `wifi-adb-service.js` | Fallback identité si getprop échoue : `android_id` ou match config par IP |

**Zones LOCK :** aucune touchée — corrections limitées à registry / wifi-adb-service / DevicePanel.

---

## BUG — Panneau Appareils : WiFi classé en USB (2026-07-05)

**Symptôme rapporté :** `192.168.1.10:5555` apparaît dans la section **USB** du panneau Appareils, alors qu'il devrait être fusionné avec l'entrée USB `21051182G` (même appareil) ou listé uniquement en **WiFi**.

**Statut : corrigé (2026-07-05).**

### Correctifs appliqués

| Priorité | Fichier | Correction |
|----------|---------|------------|
| P0 | `wifiHandlers.js` | `wifi:panel-data` → `DeviceRegistry.buildDevicesPanelData(loadHistory())` |
| P0 | `device-registry.js` | `buildDevicesPanelData()` — USB = serial USB réel uniquement ; exclut `ip:port` |
| P1 | `main.js` | `updateDevicesInHistory()` — champs `{ deviceId, usbSerial, wifiSerial, lastUsbSeen, lastWifiSeen }` |
| P1 | `main.js` | `migrateDeviceHistoryKeys()` — fusion / purge clés history `ip:port` orphelines au démarrage |

---

### 1. Identifiant stable — récupération et comparaison USB vs WiFi

#### Où la fusion par `ro.serialno` existe (sidebar / sessions)

| Couche | Utilise `getprop ro.serialno` ? | Compare USB + WiFi ? |
|--------|----------------------------------|----------------------|
| `DeviceRegistry.attachStableIds()` | ✅ Oui (via `WifiAdbService.getStableDeviceId`) | ✅ Oui — `mergeByDeviceId()` regroupe par `deviceId` |
| `DeviceRegistry` + `wifi-devices.json` | ✅ Lookup config par IP si besoin | ✅ Réconciliation `deviceId` canonique |
| **`wifi:panel-data` (panneau Appareils)** | ❌ **Non** | ❌ **Non** |

Le panneau **n'utilise pas** `DeviceRegistry` ni `getStableDeviceId()` pour construire ses listes.

#### Chaîne d'identité pour `21051182G` vs `192.168.1.10:5555`

**Hypothèse même appareil physique :** si `adb -s 21051182G shell getprop ro.serialno` et `adb -s "192.168.1.10:5555" shell getprop ro.serialno` retournent la **même valeur**, c'est le même device.

**Dans le Hub (sidebar) — après correctifs récents :**

1. Transport USB → `getStableDeviceId("21051182G")` → `ro.serialno` (ou fallback serial USB si getprop échoue)
2. Transport WiFi → `getStableDeviceId("192.168.1.10:5555")` → même `ro.serialno` **ou** match via `findConfigByWifiSerial()` → `deviceId` de `wifi-devices.json`
3. `mergeByDeviceId()` → **une seule entrée** unifiée si les `deviceId` convergent

**Dans le panneau Appareils — aucune de ces étapes.**

#### Pollution de l'historique (`device-history.json`)

À chaque `listDevicesForUI()` :

```js
// main.js — updateDevicesInHistory()
const key = device.deviceId || device.serial;
history[key] = {
  serial: device.serial || key,   // ← serial EFFECTIF (ip:port si WiFi actif)
  name: device.name,
  lastSeen: now
};
```

Conséquences :

| Scénario | Clé history | Champ `serial` enregistré |
|----------|-------------|---------------------------|
| USB seul | `21051182G` ou `ro.serialno` | `21051182G` |
| WiFi seul (fusion OK) | `ro.serialno` / config.deviceId | **`192.168.1.10:5555`** |
| WiFi seul (fusion KO, ancien bug) | **`192.168.1.10:5555`** | `192.168.1.10:5555` |

→ L'historique peut contenir une entrée dont le **serial affiché est un ip:port**, stockée sous une clé USB-centric ou WiFi-centric selon l'époque / les bugs passés.

**Aucun appel `android_id`** n'existe dans le code ; seul `ro.serialno` (+ fallback config IP) est utilisé.

**Vérification runtime non faite ici :** pas d'accès ADB live depuis cet environnement. Pour confirmer sur ta machine :

```bash
adb -s 21051182G shell getprop ro.serialno
adb -s "192.168.1.10:5555" shell getprop ro.serialno
```

Si les deux sorties sont identiques → même appareil ; la sidebar devrait fusionner, le panneau non.

---

### 2. Logique de catégorisation USB vs WiFi dans le panneau

**Handler :** `wifi:panel-data` dans `wifiHandlers.js`  
**Renderer :** `DevicesPanel.js` — affiche `response.usb` et `response.wifi` tels quels.

#### Section WiFi

```js
wifiEntries = wifiDevicesManager.list().map(config => ({ ...config, adbTarget: ip:port }))
```

→ Uniquement les entrées de **`wifi-devices.json`**. Critère correct.

#### Section USB

```js
usbEntries = Object.values(history).map(entry => ({
  serial: entry.serial,
  connected: raw.some(d => d.serial === entry.serial)
}))
```

→ **Tout** `device-history.json`, **sans aucun filtre** :

| Critère attendu (spec) | Implémenté ? |
|------------------------|--------------|
| Exclure serials format `ip:port` | ❌ Non |
| Exclure devices déjà en `wifi-devices.json` | ❌ Non |
| Fusionner par `deviceId` / `ro.serialno` | ❌ Non |
| Priorité USB si les deux transports connus | ❌ Non |
| Utiliser `usbSerialHint` de la config WiFi | ❌ Non |

**Verdict :** la section « USB » n'est pas « devices vus en USB » — c'est **l'intégralité de l'historique générique**, alimenté par `updateDevicesInHistory()` avec le **serial effectif du moment** (y compris `192.168.1.10:5555` quand la session active est WiFi).

Le critère de tri n'est **pas** basé sur le format serial de façon explicite — c'est pire : **aucun tri** ; tout historique → USB, toute config → WiFi → **doublons possibles** pour le même appareil.

#### Schéma du bug

```
listDevicesForUI()
  └─ updateDevicesInHistory()  → device-history.json
        serial effectif = 192.168.1.10:5555  (WiFi connecté)

wifi:panel-data()
  ├─ usb  ← Object.values(history)     → affiche 192.168.1.10:5555 en USB ❌
  └─ wifi ← wifi-devices.json          → affiche aussi l'entrée config ✅ (doublon)
```

La sidebar (`DeviceRegistry`) et le panneau Appareils (**deux pipelines disjoints**).

---

### 3. `21051182G` et `192.168.1.10:5555` — même device ?

| Indice | Analyse |
|--------|---------|
| `21051182G` | Ressemble au **modèle** Xiaomi (Redmi Note 10 Pro) souvent lu comme `name` via `adb devices -l model:…` ; peut aussi être le **serial ADB USB** selon l'appareil |
| `192.168.1.10:5555` | Serial ADB **transport WiFi** (format `ip:port`) — jamais un identifiant matériel |
| Config WiFi (`wifi-devices.json`) | `deviceId` = `ro.serialno` capturé à la 1ère config (souvent ≠ serial USB brut) ; `usbSerialHint` peut contenir le serial USB au moment du setup |
| Fusion sidebar | Si `deviceId` converge → **1 carte** ; sinon 2 entrées |

**Conclusion logique (sans ADB live) :**

- **Très probablement le même appareil** si le WiFi a été configuré via le toggle depuis cet USB, ou si `getprop ro.serialno` est identique sur les deux transports.
- Le panneau **ne peut pas** le prouver ni fusionner : il ne compare jamais les `ro.serialno`.
- L'affichage `192.168.1.10:5555` en USB est un **artefact de catégorisation** (historique + serial effectif), pas forcément une preuve que le Hub les traite comme deux devices distincts côté sidebar.

**Doublon typique observé :**

1. Section **USB** : `{ serial: "192.168.1.10:5555" }` (depuis history)
2. Section **WiFi** : `{ deviceId: "<ro.serialno>", ip: 192.168.1.10 }` (depuis config)

…ou entrée USB `{ serial: "21051182G" }` **et** entrée WiFi séparée, sans lien visible.

---

### 4. Synthèse cause → effet

| Cause | Effet panneau |
|-------|---------------|
| Panneau USB = `device-history.json` brut | Serial WiFi effectif (`ip:port`) listé en USB |
| `updateDevicesInHistory` écrit le serial **effectif** (WiFi) dans history | Pollution USB même quand fusion sidebar OK |
| Pas de réutilisation `DeviceRegistry` / `getStableDeviceId` | Pas de fusion USB+WiFi dans le panneau |
| WiFi = `wifi-devices.json` seul | Doublon possible (history USB + config WiFi) |
| Anciennes entrées history clé `ip:port` | Entrée USB fantôme persistante |

---

### 5. Corrections proposées (après validation)

| Priorité | Fichier | Correction |
|----------|---------|------------|
| P0 | `wifiHandlers.js` (`wifi:panel-data`) | Construire les listes via **`DeviceRegistry`** + historique structuré, pas `Object.values(history)` brut |
| P0 | `wifiHandlers.js` | Section USB : entrées avec **serial USB réel** uniquement ; exclure `isWifiSerial(serial)` |
| P0 | `wifiHandlers.js` | Fusion : si config WiFi existe pour un `deviceId`, **ne pas** dupliquer en USB ; afficher USB prioritaire si `usbSerialHint` / transport USB connu |
| P1 | `main.js` (`updateDevicesInHistory`) | Persister **`usbSerial` / `wifiSerial` / `deviceId`** séparément ; ne pas écraser le serial USB par l'ip:port WiFi |
| P1 | `wifi-devices-manager.js` | Exposer lookup par `deviceId` pour enrichir entrée USB fusionnée |
| P2 | `DevicesPanel.js` | Afficher transport / serial USB + ip WiFi sur une ligne fusionnée si applicable |

**Zones LOCK :** aucune.

---

## BUG — Séparation USB / WiFi panneau Appareils (21051182G / e176518f) — 2026-07-05

**Symptôme rapporté :**

- `21051182G` → visible en WiFi (`192.168.1.10:5555`) et semble lié à USB
- `e176518f` → visible en USB

**Statut : corrigé (2026-07-05).**

**Comportement attendu après correction :**

- **USB** : une ligne `e176518f` (serial USB réel), jamais `192.168.1.10:5555`
- **WiFi** : une ligne depuis `wifi-devices.json` (`deviceId` = `e176518f`, `adbTarget` = `192.168.1.10:5555`)
- Clés history `ip:port` orphelines migrées ou purgées au démarrage

**Données persistées relevées** (`C:\Users\S_UN\AppData\Roaming\android-hub\`, session du 2026-07-05) :

```json
// device-history.json (source section USB du panneau)
{
  "192.168.1.10:5555": { "serial": "192.168.1.10:5555", "name": "21051182G", ... },
  "e176518f":          { "serial": "e176518f",          "name": "21051182G", ... }
}
// wifi-devices.json → absent sur disque au moment du diagnostic (section WiFi vide ou alimentée seulement en session)
```

```json
// custom-names.json — clés device (hors scope panneau mais même pollution d'identité)
"e176518f", "192.168.1.10:5555", "a3acba7c" (Tab 6 = 23043RP34G, appareil distinct)
```

---

### 1. Cartographie des trois identifiants — rôle réel et catégorisation actuelle

| Identifiant | Nature réelle | Serial ADB ? | `ro.serialno` ? | Où apparaît aujourd'hui (panneau) | Critère de classement actuel |
|-------------|---------------|--------------|-----------------|-----------------------------------|----------------------------|
| **`21051182G`** | **Nom d'affichage** (modèle Xiaomi / `adb devices -l model:21051182G`) — **pas un serial** | ❌ Non | ❌ Non utilisé comme clé | Nulle part directement ; affiché comme **`name`** sur les lignes `e176518f` et `192.168.1.10:5555` | Aucun — simple champ `name` copié depuis le modèle ADB |
| **`e176518f`** | **Identifiant stable matériel** — serial USB ADB **et** très probablement `ro.serialno` | ✅ Oui (USB) | ✅ Oui (hypothèse forte, confirmée par usage comme `deviceId` WiFi dans le code) | **Section USB** via `device-history.json` | Présence dans **historique brut** → dumpé en USB sans filtre |
| **`192.168.1.10:5555`** | **Serial ADB transport WiFi** (`ip:port`) — pas un identifiant matériel | ✅ Oui (WiFi) | N/A (c'est l'adresse de transport) | **Section USB** (incorrect) via `device-history.json` ; **Section WiFi** si entrée dans `wifi-devices.json` (`deviceId` = `e176518f`, `name` = `21051182G`) | USB : historique ; WiFi : config JSON |

**Point clé :** `21051182G` et `e176518f` ne sont **pas** deux appareils — `21051182G` est le **libellé** de l'appareil dont l'identité stable est **`e176518f`**. Le vrai doublon est **`e176518f` + `192.168.1.10:5555`** = même Tab 5 sur deux transports.

Le second appareil physique du setup utilisateur est **`a3acba7c`** (nom `23043RP34G`, Tab 6) — absent du symptôme actuel mais présent dans `custom-names.json`.

---

### 2. Critères de catégorisation — code actuel vs attendu

#### Panneau (`wifi:panel-data` — `wifiHandlers.js`)

| Section | Source | Critère réel | Utilise `ro.serialno` ? | Utilise format `ip:port` ? |
|---------|--------|--------------|-------------------------|----------------------------|
| **USB** | `Object.values(device-history.json)` | **Aucun filtre** — toute clé/valeur history | ❌ | ❌ (mais laisse passer les ip:port) |
| **WiFi** | `wifiDevicesManager.list()` → `wifi-devices.json` | Présence d'une config `{ deviceId, ip, port }` | ❌ (deviceId devrait être ro.serialno mais non vérifié) | ✅ via `adbTarget = ip:port` |

→ **Pas de fusion**, pas de dédoublonnage, **pas de comparaison** entre transports pour le panneau.

#### Sidebar / liste unifiée (`DeviceRegistry` — hors panneau)

| Étape | Critère |
|-------|---------|
| `getStableDeviceId(serial)` | `getprop ro.serialno` (+ fallback config IP pour WiFi) |
| `mergeByDeviceId()` | Regroupe par `deviceId` stable |
| Affichage transport | USB prioritaire si les deux online ; sinon WiFi seul |

→ La fusion **existe** pour la sidebar, **pas** pour le panneau Appareils.

#### Alimentation history (`updateDevicesInHistory` — `main.js`)

```js
key = device.deviceId || device.serial;
history[key].serial = device.serial;  // serial EFFECTIF (ip:port si session WiFi)
```

| Poll | Effet sur history |
|------|-------------------|
| WiFi actif, fusion sidebar OK (`deviceId=e176518f`) | 1 entrée clé `e176518f`, **`serial` écrasé en `192.168.1.10:5555`** → ligne USB affiche ip:port |
| Fusion KO / ancienne clé | 2 entrées : `e176518f` **et** `192.168.1.10:5555` → **2 lignes USB** même nom `21051182G` |

**État observé sur disque : les deux clés coexistent** → pollution historique + panneau USB dupliqué.

**`android_id` :** jamais utilisé dans le codebase.

---

### 3. Même appareil ou deux appareils ? — Verdict pour ce setup

| Question | Réponse |
|----------|---------|
| `21051182G` vs `e176518f` = 2 devices ? | **Non** — `21051182G` = nom/modèle ; `e176518f` = identité stable (serial USB / ro.serialno) |
| `e176518f` vs `192.168.1.10:5555` = 2 devices ? | **Non** — même Tab 5 : USB (`e176518f`) + WiFi (`192.168.1.10:5555`) |
| Preuve indirecte | Même `name: "21051182G"`, même `lastSeen` synchronisé, `custom-names` / `mirror:` sur les deux clés, `device-colors` sur les deux clés |
| Preuve à confirmer côté user | `adb -s e176518f shell getprop ro.serialno` et `adb -s "192.168.1.10:5555" shell getprop ro.serialno` → doivent être identiques (probablement `e176518f`) |

**Scénario applicable : #2 (fusion)** — un seul appareil physique, deux transports. Le panneau viole la spec en :

1. Affichant **`192.168.1.10:5555` en USB** (historique)
2. Affichant **`e176518f` en USB** (doublon)
3. Affichant **encore** l'entrée en **WiFi** si `wifi-devices.json` existe → **jusqu'à 3 représentations** d'un seul Tab 5

**Comportement attendu après correction :**

- **Une seule entrée** dans le panneau (fusionnée, USB prioritaire à l'affichage si les deux transports connus)
- Ou : **WiFi section seule** si WiFi-only + config ; **USB section seule** si USB-only — jamais les deux + jamais ip:port en USB

---

### 4. Schéma du bug actuel (Tab 5)

```
                    ┌─────────────────────────────────────┐
  adb devices       │  e176518f (USB)  │ 192.168.1.10:5555 (WiFi)  │
                    └─────────┬───────────────────┬─────────┘
                              │                   │
              DeviceRegistry  │  merge → 1 carte sidebar (OK)
                              │                   │
              updateDevicesInHistory              │
                              ▼                   ▼
              device-history.json:
                [e176518f] serial=e176518f OR serial=ip:port
                [192.168.1.10:5555] serial=ip:port   ← doublon
                              │
              wifi:panel-data │
                              ▼
              USB section: 2 lignes "21051182G"     ← BUG
              WiFi section: 1 ligne si wifi-devices ← doublon vs USB
```

---

### 5. Corrections proposées (après validation — inchangées, priorisées)

| P | Action |
|---|--------|
| **P0** | Refondre `wifi:panel-data` via **`DeviceRegistry.listUnifiedDevices()`** + dedupe par `deviceId` |
| **P0** | USB panel : serials USB réels uniquement (`!isWifiSerial`) ; exclure entrées dont `deviceId` a config WiFi |
| **P0** | Fusion panneau : **1 row / deviceId** ; libellé USB prioritaire ; sous-texte WiFi `ip:port` optionnel |
| **P1** | `updateDevicesInHistory` : champs séparés `{ deviceId, usbSerial, wifiSerial, lastUsbSeen, lastWifiSeen }` — ne plus écrire ip:port comme serial USB |
| **P1** | Migration / purge clés history orphelines `ip:port` |
| **P2** | Nettoyer `custom-names.json` / `device-colors.json` : une clé = `deviceId` stable, supprimer clés `ip:port` |

**Zones LOCK :** aucune.

---

## BUG — Toggle WiFi ne reflète pas l'état réel (2026-07-05)

**Symptôme rapporté :** le switch USB/WiFi doit être **ON** quand l'appareil est connecté en WiFi ADB (`wifiEnabled: true` en stockage **et** connexion active vérifiée), que ce soit juste après une connexion réussie ou après redémarrage du Hub. Le toggle ne semble pas refléter cet état correctement.

**Statut : corrigé (2026-07-05).**

### Correctifs appliqués

| P | Fichier | Correction |
|---|---------|------------|
| **P0** | `device-registry.js` | Champ `wifiActive` = `wifiEnabled && transport==='wifi' && online` |
| **P0** | `DevicePanel.js` | `wifiChecked` basé sur `device.wifiActive` (plus seulement `wifiEnabled`) |
| **P1** | `main.js` | `listDevicesForUI()` attend `startupAutoConnect()` avant le 1er listing |
| **P1** | `wifiHandlers.js` | Toggle OFF → `adb disconnect` sur le serial WiFi sauvegardé |

---

#### Renderer (`DevicePanel.js`)

| Aspect | Comportement actuel |
|--------|---------------------|
| State local React/Vue | ❌ **Aucun** — pas de state persistant dans le composant |
| Re-render | **Full innerHTML** à chaque event `devices-refreshed` (polling 8 s + refresh post-toggle) |
| Position du switch | `wifiChecked = Boolean(device.wifiEnabled)` — ligne 203 |
| Visibilité du switch | `canToggleWifi` = `usbSerial \|\| wifiConfigured \|\| (transport==='wifi' && connected)` — critère **différent** de `wifiChecked` |

```js
// DevicePanel.js — seule source de vérité UI pour checked
const wifiChecked = Boolean(device.wifiEnabled);
// …
<input … ${wifiChecked ? "checked" : ""}>
```

**Verdict :** le toggle ne lit **pas** un state local ; il reflète **uniquement** le champ `device.wifiEnabled` renvoyé par `get-devices`. Il **n'utilise pas** `transport`, `wifiAvailable`, ni l'état ADB live.

#### Backend — origine de `device.wifiEnabled`

| Couche | Source de `wifiEnabled` |
|--------|-------------------------|
| `DeviceRegistry.buildUnifiedEntry()` | `Boolean(wifiConfig?.wifiEnabled)` — lu depuis **`wifi-devices.json`** via `findWifiConfigForGroup()` |
| Entrée orpheline (config sans groupe ADB) | Hardcodé `wifiEnabled: true` si config reste dans `configById` après merge |
| `listDevicesForUI()` — devices historiques déconnectés | Forcé à **`false`** (l.891) |

**Écart spec vs code :**

| Spec utilisateur | Code actuel |
|------------------|-------------|
| ON = `wifiEnabled: true` **ET** connexion WiFi **active** | ON = `wifiEnabled: true` **seul** (préférence stockée, indépendamment du transport effectif) |

Conséquence : le toggle peut être **ON** alors que le transport effectif est **USB** (USB branché, `wifiEnabled: true`, WiFi ADB pas encore reconnecté ou hors ligne).

Conséquence inverse : le toggle peut être **OFF** alors que le badge affiche **« WiFi connecté »** si `wifiConfig` est introuvable (`wifiEnabled: false`) malgré `transport === "wifi"`.

#### Handler toggle (`handleWifiToggle`)

- Succès → `refreshDevices()` ; position recalculée au prochain render (pas de mise à jour optimiste du `checked`).
- Erreur → revert local `toggleInput.checked = false` puis refresh.
- **Pas de state intermédiaire** entre clic et refresh IPC.

---

### 2. Redémarrage / refresh — recharge `wifiEnabled` depuis le JSON ?

#### Persistance (`wifi-devices-manager.js`)

| Étape | Comportement |
|-------|--------------|
| Init Hub | `WifiDevicesManager` constructor → **`load()`** synchrone depuis `userData/wifi-devices.json` |
| Toggle ON (config existante) | `setWifiEnabled(deviceId, true)` → `upsert()` → **`save()`** immédiat |
| Toggle ON (1ère config) | `upsert({ wifiEnabled: true, … })` dans `wifi:toggle` |
| Toggle OFF | `setWifiEnabled(deviceId, false)` → JSON persisté |
| Échec connexion | Rollback `setWifiEnabled(deviceId, false)` dans le catch de `wifi:toggle` |

→ **`wifiEnabled` est bien persisté et relu au redémarrage.**

#### Chaîne refresh après démarrage

```
app.whenReady
  → WifiDevicesManager.load()          // JSON en mémoire
  → registerWifiHandlers
  → startupAutoConnect()               // async : adb connect pour chaque config wifiEnabled+ip
       └─ then → requestRendererDeviceRefresh()

Renderer (devices.js)
  → startDevicePolling() on DOMContentLoaded
  → refreshDevices() immédiat + toutes les 8 s
  → get-devices → listDevicesForUI() → listUnifiedDevices()
  → devices-refreshed → renderDevicePanel()
```

#### Problèmes de timing identifiés

| Scénario | Effet sur le toggle |
|----------|---------------------|
| **1er poll avant `startupAutoConnect` terminé** | WiFi-only : appareil **absent** de la sidebar (pas dans `adb devices`) → pas de toggle. USB+config `wifiEnabled:true` : carte USB visible, **`wifiEnabled:true` → toggle ON** mais transport **USB** jusqu'à fin auto-connect |
| **Auto-connect échoue au démarrage** | JSON garde `wifiEnabled:true` → toggle **ON** ; `resolveEffectiveTransport` retombe sur USB si USB online, sinon WiFi hors ligne (`connected:false`) → carte peut disparaître (filtre `connected !== false`) |
| **Après toggle réussi** | `refreshDeviceList()` → refresh immédiat ; si registry renvoie `wifiEnabled:true` → toggle ON ✓ |
| **Toggle OFF** | Met `wifiEnabled:false` en JSON ; **ne appelle pas** `adb disconnect` — le transport bascule via `resolveEffectiveTransport` mais la session WiFi ADB peut rester dans `adb devices` |

**Verdict refresh/redémarrage :** le JSON est bien rechargé ; le bug n'est **pas** une absence de persistance, mais (a) la **sémantique** du `checked` (stockage seul vs stockage+connexion active), et (b) une **race** entre polling renderer et `startupAutoConnect`.

---

### 3. Impact de la fusion d'identité USB+WiFi sur le toggle

#### Lookup config → `wifiEnabled`

Dans `listUnifiedDevices()` :

```js
wifiConfig = findWifiConfigForGroup(group, configById, wifiConfigs)
// direct: configById.get(group.deviceId)
// fallback: findConfigByWifiSerial(group.wifiSerial)
wifiEnabled: Boolean(wifiConfig?.wifiEnabled)
```

| Condition | `wifiConfig` | `wifiEnabled` UI | Toggle visible ? |
|-----------|--------------|------------------|------------------|
| `group.deviceId` = `e176518f`, config OK | ✅ trouvée | `true` si JSON | ✅ si usbSerial ou wifiConfigured |
| `group.deviceId` = `192.168.1.10:5555` (getprop KO, pas de match IP) | ❌ null | **`false`** | ✅ (transport wifi) — **toggle OFF alors que WiFi connecté** |
| Config orpheline + groupe séparé (deviceIds divergents) | 2 entrées possibles | États **contradictoires** sur 2 cartes | Doublon sidebar |

#### Transport effectif vs toggle (`resolveEffectiveTransport`)

```js
if (wifiEnabled && wifiOnline)  → transport "wifi"
else if (usbOnline)               → transport "usb"  // wifiEnabled peut rester true en JSON
else if (wifiOnline)              → transport "wifi" // même sans wifiEnabled (WiFi ADB manuel)
```

| État ADB | `wifiEnabled` JSON | Transport effectif | Toggle actuel | Attendu (spec) |
|----------|-------------------|--------------------|---------------|----------------|
| USB seul | `false` | USB | OFF | OFF |
| WiFi seul, config OK | `true` | WiFi | ON | ON |
| USB + WiFi, config ON | `true` | WiFi (si wifiOnline) | ON | ON |
| USB + WiFi, auto-connect pending | `true` | **USB** (wifiOnline false) | **ON** | **OFF** (pas encore en WiFi actif) |
| WiFi seul, config lookup KO | n/a | WiFi | **OFF** | ON (si connexion active) |
| WiFi manuel sans `wifi-devices.json` | n/a | WiFi | OFF | OFF (pas configuré) |

#### Badge transport vs toggle — incohérence UI possible

```js
const showUsbBadge = device.usbAvailable && !(wifiChecked && device.transport === "wifi");
```

Le badge peut afficher **« WiFi connecté »** (`transport === "wifi"`) pendant que le toggle est **OFF** (`wifiConfigured === false`).

**Verdict fusion :** un `deviceId` mal réconcilié ou une config non trouvée produit **`wifiEnabled:false`** indépendamment du transport réel — cause directe d'un toggle mal positionné. La fusion sidebar et le toggle partagent `DeviceRegistry`, mais le toggle ignore le transport effectif.

---

### 4. Synthèse cause → effet

```
wifi-devices.json (wifiEnabled: true)
        │
        ▼
DeviceRegistry.buildUnifiedEntry()
  wifiEnabled = Boolean(wifiConfig?.wifiEnabled)   ← pas de check connexion active
  transport   = resolveEffectiveTransport()        ← peut être "usb" même si wifiEnabled true
        │
        ▼
get-devices → devices-refreshed → renderDevicePanel()
  checked = device.wifiEnabled ONLY               ← ignore transport / wifiOnline
```

| Cause | Effet toggle |
|-------|--------------|
| `checked` = stockage seul, pas transport+connexion | ON pendant session USB avec `wifiEnabled:true` ; OFF possible avec badge WiFi si config absente |
| Race `startupAutoConnect` vs 1er poll | État transitoire incorrect au redémarrage (ON+USB ou carte absente) |
| Échec lookup config (deviceId mismatch) | OFF alors que WiFi ADB actif |
| `canToggleWifi` ≠ critère `wifiChecked` | Toggle visible mais OFF sur WiFi non configuré |
| Toggle OFF sans `adb disconnect` | JSON `wifiEnabled:false` mais WiFi peut rester dans `adb devices` (impact transport limité) |

---

### 5. Corrections proposées (après validation)

| P | Fichier | Correction |
|---|---------|------------|
| **P0** | `DevicePanel.js` | `wifiChecked` = `device.wifiEnabled && device.transport === 'wifi' && device.connected` (aligner sur spec utilisateur) |
| **P0** | `device-registry.js` | Exposer `wifiActive: wifiEnabled && wifiOnline` (ou équivalent) pour éviter logique dupliquée renderer |
| **P1** | `device-registry.js` / `main.js` | Attendre `startupAutoConnect` (ou 1er refresh post auto-connect) avant 1er `get-devices` significatif côté renderer |
| **P1** | `wifiHandlers.js` | Toggle OFF : optionnel `adb disconnect` sur le serial WiFi sauvegardé |
| **P2** | `DevicePanel.js` | Mise à jour optimiste du `checked` après succès IPC, avant refresh (éviter flash OFF) |
| **P2** | `device-registry.js` | Durcir réconciliation config (IP/port) pour que `wifiConfigured`/`wifiEnabled` ne divergent jamais du transport WiFi actif |

**Zones LOCK :** aucune.

---

## FEATURE — Détecter devices WiFi connectés hors Hub (2026-07-05)

**Besoin :** un appareil connecté via `adb connect ip:port` manuellement (hors toggle Hub) doit être détecté et ajouté à `wifi-devices.json` avec identité stable, nom par défaut, `wifiEnabled: true`.

**Statut : implémenté (2026-07-05).**

### Implémentation

| Fichier | Ajout |
|---------|-------|
| `wifi-adb-service.js` | `parseWifiSerial()`, `getAndroidId()`, `resolveStableDeviceId()` |
| `device-registry.js` | `importDiscoveredWifiDevices()` appelé au début de `listUnifiedDevices()` |

Import idempotent : skip si `ip:port` déjà dans JSON ; met à jour IP/`lastSeen` si même `deviceId` connu.

---

### 1. Où se fait le scan `adb devices` aujourd'hui

| Couche | Fichier | Fonction | Commande | Appelé par |
|--------|---------|----------|----------|------------|
| **Primaire** | `device-manager.js` | `DeviceManager.getConnectedDevices()` | `adb devices -l` | `DeviceRegistry.getRawAdbDevices()` |
| Fallback 1 | `main.js` | `getConnectedDevices()` | `adb devices -l` | registry si DeviceManager vide/erreur |
| Fallback 2 | `main.js` | `getConnectedDevicesSimple()` | `adb devices` | registry si fallback 1 vide |
| **Fusion UI** | `device-registry.js` | `getRawAdbDevices()` → `listUnifiedDevices()` | — | `listDevicesForUI()` |
| **Polling renderer** | `devices.js` | `refreshDevices()` → IPC `get-devices` | — | toutes les **8 s** + post-toggle |
| **Démarrage** | `main.js` | `startupAutoConnect()` | `adb connect` (configs **existantes** uniquement) | avant 1er `listDevicesForUI` |
| **Panneau Appareils** | `wifiHandlers.js` | `wifi:panel-data` | via `buildDevicesPanelData()` → `getRawAdbDevices()` | à l'ouverture du modal |

**Point d'injection recommandé :** `DeviceRegistry.listUnifiedDevices()` — appelé à **chaque** listing UI, juste après `getRawAdbDevices()`, **avant** merge/fusion. Idempotent si entrée déjà en JSON (lookup par `ip:port`).

**Alternative écartée :** scan uniquement au démarrage — raterait un `adb connect` manuel pendant que le Hub tourne.

---

### 2. Comportement actuel pour un WiFi manuel (`ip:port` absent du JSON)

```
adb devices → getRawAdbDevices()
  → attachStableIds() : getprop ro.serialno (ou deviceId = ip:port si échec)
  → mergeByDeviceId() : groupe WiFi créé
  → findWifiConfigForGroup() : null (pas dans wifi-devices.json)
  → buildUnifiedEntry() :
       wifiConfigured: false
       wifiEnabled: false
       resolveEffectiveTransport() : wifiOnline → transport "wifi" (l.150)
       wifiActive: false
```

| Aspect | État actuel |
|--------|-------------|
| Visible sidebar | ✅ Oui (transport WiFi si `state=device`) |
| Toggle WiFi | Visible (`canToggleWifi`) mais **OFF** (`wifiActive` false) |
| `wifi-devices.json` | ❌ **Non créé** |
| Panneau Appareils section WiFi | ❌ Absent (section = configs JSON seulement) |
| `device-history.json` | Entrée créée via `updateDevicesInHistory()` avec clé `deviceId` |

→ Détection ADB **OK** ; persistance WiFi **manquante**.

---

### 3. Identité stable — outils existants

| Méthode | Fichier | Disponible |
|---------|---------|------------|
| `getprop ro.serialno` | `wifi-adb-service.js` → `getStableDeviceId()` | ✅ (serial quoté) |
| Fallback config par IP | `findConfigByWifiSerial()` | ✅ (inutile si pas encore en JSON) |
| `settings get secure android_id` | — | ❌ **À ajouter** (fallback spec utilisateur) |
| USB serial hint | `usbSerialHint` dans JSON | N/A pour import pur WiFi |

---

### 4. Plan d'implémentation

| Étape | Fichier | Action |
|-------|---------|--------|
| 1 | `wifi-adb-service.js` | `parseWifiSerial()`, `getAndroidId()`, `resolveStableDeviceId()` |
| 2 | `device-registry.js` | `importDiscoveredWifiDevices(raw)` — ip:port online absent du JSON → upsert |
| 3 | `device-registry.js` | Appeler import au début de `listUnifiedDevices()` |
| 4 | Nom par défaut | modèle ADB (`device.name`) → `deviceId` → `Appareil WiFi N` |
| 5 | Champs upsert | `{ deviceId, name, ip, port, wifiEnabled: true, lastSeen: now }` |

**Zones LOCK :** aucune.

---

## BUG — Serial USB obsolète pour tcpip / récupération IP (2026-07-05)

**Symptôme confirmé :** `adb -s a3acba7c shell ip addr show wlan0` fonctionne manuellement, mais le Hub exécute tcpip/IP avec un serial incorrect (ex. `e176518f` au lieu de `a3acba7c`).

**Statut : diagnostic terminé — correction appliquée (2026-07-05).**

---

### 1. Où le serial USB est capturé / stocké

| Source | Fichier | Champ | Quand | Problème |
|--------|---------|-------|-------|----------|
| **Toggle renderer** | `DevicePanel.js` | `device.usbSerial` passé à IPC | Clic toggle | Valeur du **dernier poll** (8 s), pas re-vérifiée |
| **Liste unifiée** | `device-registry.js` | `group.usbSerial` ← `adb devices` au poll | `listUnifiedDevices()` | OK au moment du poll, **stale** au clic |
| **Persistance WiFi** | `wifi-devices.json` | `usbSerialHint` | 1ère config toggle | **Jamais rafraîchi** si serial USB change |
| **Historique** | `device-history.json` | `usbSerial` | Chaque `get-devices` | Peut conserver un ancien serial sur une clé `deviceId` |
| **Backend toggle (1ère config)** | `wifiHandlers.js` | `usbSerial` reçu du renderer | `setupFirstConnection(usbSerial)` | Utilise le param IPC **tel quel** — **pas de re-scan adb** |
| **Backend toggle (config existante)** | `wifiHandlers.js` | — | `reconnectSaved(deviceId)` | **Aucun USB** — IP sauvegardée uniquement, pas de tcpip |

**Seul appel tcpip / fetchWlan0Ip :** `WifiAdbService.setupFirstConnection(usbSerial)` — serial = paramètre IPC direct.

---

### 2. Divergence des sources de serial (toggle vs détection)

| Chemin | Serial utilisé pour commandes ADB USB |
|--------|--------------------------------------|
| Détection sidebar | `getRawAdbDevices()` → serial live `adb devices -l` |
| Clic toggle ON (1ère fois) | `device.usbSerial` du renderer (**cache poll**) |
| Clic toggle ON (config JSON) | IP du JSON — **pas de serial USB** |
| Auto-connect démarrage | IP du JSON — **pas de serial USB** |

→ **Deux pipelines disjoints** : affichage = adb live ; actions WiFi = cache renderer ou JSON figé.

**Scénario bug `e176518f` vs `a3acba7c` :**

1. Poll précédent ou mauvaise carte : `device.usbSerial = "e176518f"` passé au toggle
2. Appareil actuel branché = `a3acba7c` (`deviceId` correct)
3. Backend exécute `adb -s e176518f tcpip` / `ip addr show wlan0` → échec ou mauvais appareil
4. Test manuel `adb -s a3acba7c …` → OK

Autre cas : `usbSerialHint: "e176518f"` dans config d'un autre appareil réutilisée par erreur si lookup `deviceId` échoue.

---

### 3. IP DHCP — non rafraîchie après la 1ère config

| Moment | Mise à jour IP dans JSON |
|--------|--------------------------|
| 1ère config (`setupFirstConnection`) | ✅ `upsert({ ip })` |
| Toggle ON (config existante) | ❌ `reconnectSaved` → IP **figée** |
| Auto-connect démarrage | ❌ IP **figée** |
| Reconnect panneau | ❌ IP **figée** |

→ Si DHCP change (`192.168.1.10` → `192.168.1.11`), reconnexion échoue tant que USB ne refetch pas l'IP.

---

### 4. Corrections appliquées

| P | Fichier | Correction |
|---|---------|------------|
| **P0** | `device-registry.js` | `resolveLiveUsbSerial({ deviceId, preferredSerial })` — re-scan `adb devices`, match par `deviceId` / `ro.serialno`, **ignore preferredSerial** si mismatch |
| **P0** | `wifiHandlers.js` | Avant tcpip/IP : résoudre serial live ; ne plus faire confiance au seul param renderer |
| **P0** | `wifi-adb-service.js` | `reconnectSaved(deviceId, { usbSerial })` — si USB online : tcpip + fetch IP + **upsert IP** + connect |
| **P1** | `device-registry.js` | `startupAutoConnect()` — refresh IP via USB si appareil branché |
| **P1** | `wifiHandlers.js` | `wifi:reconnect` — même logique refresh IP |
| **P1** | `wifiHandlers.js` | 1ère config : `usbSerialHint` = serial live résolu |

**Zones LOCK :** aucune.

---

## BUG — Serial correct mais IP non extraite (wlan0) (2026-07-05)

**Symptôme confirmé :** serial `a3acba7c` OK côté Hub, mais « IP introuvable ». Manuel :

```text
adb -s a3acba7c shell ip addr show wlan0
→ inet 192.168.1.11/24 brd 192.168.1.255 scope global dynamic wlan0
```

**Statut : diagnostic terminé — correction appliquée (2026-07-05).**

---

### 1. Sortie brute reçue par le Hub (analyse code + logging ajouté)

**Commande exécutée :**

```js
`"${adbPath}" -s "${usbSerial}" shell ip addr show wlan0`
```

**Exécution :** `execWithTimeout` → `execPromise` → `await` sur stdout **complet** (maxBuffer 1 Mo). Pas de lecture partielle — le Hub attend la fin du processus avant de parser.

**Logging ajouté :** `[WifiAdbService] fetchWlan0Ip raw (serial):` + JSON.stringify(output) dans la console main.

**Cause racine identifiée (ordre des opérations) — pas un timeout async :**

Dans `setupFirstConnection()` et `reconnectSaved()` **avant correction** :

```js
await this.enableTcpip(usbSerial, port);   // adb tcpip 5555 — reset ADB USB
ip = await this.fetchWlan0Ip(usbSerial);   // shell ip addr — session USB souvent morte/vide
```

`adb tcpip` bascule l'appareil en mode TCP et **coupe ou déstabilise la session USB**. Le `shell ip addr` qui suit reçoit souvent **stdout vide** ou une erreur — d'où `parseWlan0Ip → null` alors que la même commande **sans tcpip préalable** fonctionne au terminal.

**Sortie brute typique attendue (si exécutée AVANT tcpip) :**

```text
3: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP group default qlen 1000
    link/ether aa:bb:cc:dd:ee:ff brd ff:ff:ff:ff:ff:ff
    inet 192.168.1.11/24 brd 192.168.1.255 scope global dynamic wlan0
    inet6 fe80::xxxx:xxxx:xxxx:xxxx/64 scope link stable-privacy
```

**Sortie probable reçue par le Hub (APRÈS tcpip, bug) :** `""` ou message d'erreur stderr → parsing impossible.

---

### 2. Regex / parsing — vérification sur la ligne utilisateur

**Parser actuel (`parseWlan0Ip`) :**

```js
/inet\s+(\d{1,3}(?:\.\d{1,3}){3})/
```

| Test | Résultat |
|------|----------|
| Ligne `inet 192.168.1.11/24 … wlan0` | ✅ Capture `192.168.1.11` |
| Ligne `inet6 fe80::…` | ✅ **Ignorée** (`inet6` ≠ `inet` + espace + chiffre) |
| Ligne `3: wlan0: …` (sans inet) | Ignorée en passe 1 ; passe 2 fallback |

→ Le regex est **correct** pour la sortie manuelle de l'utilisateur. Le bug n'est **pas** le pattern en soi, mais l'**absence de sortie** après `tcpip`.

**Amélioration parsing appliquée :** lecture par bloc interface `wlan0:` + regex `\binet\s+(\d+\.\d+\.\d+\.\d+)` explicite IPv4.

---

### 3. Corrections appliquées

| P | Fichier | Correction |
|---|---------|------------|
| **P0** | `wifi-adb-service.js` | **Ordre inversé :** `fetchWlan0Ip()` **puis** `enableTcpip()` |
| **P0** | `wifi-adb-service.js` | Log stdout brut + IP parsée en console |
| **P1** | `wifi-adb-service.js` | `parseWlan0Ip()` — bloc `wlan0:`, IPv4 only, skip 127.x |

**Zones LOCK :** aucune.

---

## BUG/FEATURE — Panneau Appareils sans rafraîchissement auto (2026-07-05)

**Symptôme :** le panneau USB/WiFi n'affiche statuts / nouveaux devices / changements toggle qu'après fermeture/réouverture manuelle.

**Statut : corrigé (2026-07-05).**

---

### 1. Source de données actuelle — pas de state réactif

| Aspect | Implémentation actuelle (avant fix) |
|--------|-------------------------------------|
| **Composant** | `src/renderer/devices-panel/DevicesPanel.js` |
| **Fetch** | `wifiAPI.getPanelData()` → IPC `wifi:panel-data` → `DeviceRegistry.buildDevicesPanelData()` |
| **Moment du fetch** | **Une seule fois** à l'ouverture (`openDevicesPanel` → `renderPanel()`) |
| **State / store** | ❌ Aucun — pas de React/store ; variables DOM réécrites |
| **Sidebar** | `DevicePanel.js` écoute `devices-refreshed` (poll 8 s) — **panneau modal non** |
| **Fenêtre modal** | `hub-modal-window.html` (BrowserWindow overlay) — scripts `devices.js` + `DevicesPanel.js` |
| **Broadcast post-toggle** | `requestRendererDeviceRefresh()` → main window seulement — **overlay non notifié** |

→ Fetch **statique au montage** ; aucun polling ni écoute d'événements sur le panneau Appareils.

---

### 2. Corrections appliquées

| P | Fichier | Correction |
|---|---------|------------|
| **P0** | `DevicesPanel.js` | Polling **4 s** tant que `#panel-devices.active` |
| **P0** | `DevicesPanel.js` | Écoute `devices-refreshed` + `devices:refresh-request` → refresh silencieux |
| **P0** | `main.js` | `requestRendererDeviceRefresh()` notifie aussi l'overlay si panneau `devices` ouvert |
| **P1** | `hub-modal-window.html` | Bouton **Rafraîchir** manuel |
| **P1** | `DevicesPanel.js` | `renderPanel({ silent })` — pas de flash « Chargement… » en poll |
| **P1** | `hub-modal-window.js` | `stopDevicesPanelLiveRefresh()` à la fermeture / changement de panneau |

Actions locales (rename, reconnect, remove) appelaient déjà `renderPanel()` — inchangé.

**Zones LOCK :** aucune.

---

## TÂCHE — Panneau Appareils : Renommer / USB / couleurs / sync toggle (2026-07-05)

**Statut : corrigé (2026-07-05).**

### Correctifs appliqués

| P | Fichier | Correction |
|---|---------|------------|
| P0 | `DevicesPanel.js` | Renommer → `namesAPI.openRenameDialog` (plus `window.prompt`) |
| P0 | `wifiHandlers.js` | `wifi:reconnect` → `setWifiEnabled(true)` avant connect |
| P1 | `DevicesPanel.js` | Actions USB Renommer / Supprimer (même handlers) |
| P1 | `wifiHandlers.js` | `devices:panel-remove` unifié + enrichissement noms/couleurs panel |
| P1 | `DevicesPanel.js` | Pill `device-color-pill` via `getColorForDevice` |
| P1 | `namesHandlers.js` | `refreshDeviceList` après renommage device |

---

| Vérification | Résultat |
|--------------|----------|
| `onClick` attaché ? | ✅ Oui — `bindWifiRowActions` → `handleWifiAction` sur `[data-action]` |
| Handler déclenché ? | ✅ Probable — pas d'erreur JS bloquante avant `prompt` |
| Popup modal existante ? | ✅ **Oui** — `RenameDialogManager` + `namesAPI.openRenameDialog` (sidebar, clic droit) |
| Ce que fait le panneau | ❌ **`window.prompt()`** — API bloquée / invisible dans la fenêtre overlay Electron (`hub-modal-window`) |
| Scripts rename dans modal ? | ❌ `rename-actions.js` non chargé dans `hub-modal-window.html` (inutile si on utilise `namesAPI` via preload) |

**Cause racine :** le panneau n'utilise **pas** le dialogue de renommage partagé ; `window.prompt` ne fonctionne pas dans le BrowserWindow modal enfant.

**Fix prévu :** `namesAPI.openRenameDialog({ kind: "device", serial: deviceId, ... })` — même chemin que `rename-actions.openDeviceRename`.

---

### 2. Couleur device — où c'est implémenté

| Couche | Fichier | Rôle |
|--------|---------|------|
| Persistance | `device-colors-manager.js` | `device-colors.json`, `getColorForDevice(deviceId)` |
| Liste UI | `main.js` → `applyDeviceColorMetadata()` | `applyDeviceColors()` sur devices connectés |
| Sidebar | `DevicePanel.js` | `device.deviceColor.hex` → pill `.device-color-pill` |
| Clic droit couleur | `contextMenuHandlers.js` + `deviceColorsAPI` | setManual / setAuto |
| Panneau Appareils | ❌ **Absent** — `buildDevicesPanelData()` ne lit pas `DeviceColorsManager` |

**Fix prévu :** enrichir `wifi:panel-data` avec `getColorForDevice(deviceId)` + pill dans le template (même classe CSS).

---

### 3. Sync toggle sidebar ↔ Reconnecter

| Source | Toggle sidebar | Bouton Reconnecter |
|--------|----------------|-------------------|
| Lecture état | `listUnifiedDevices()` → `wifiActive` | `wifi:reconnect` → `reconnectSaved()` |
| Écriture `wifiEnabled` | `wifi:toggle` ON/OFF | ❌ **Ne met pas** `wifiEnabled: true` avant reconnect |
| Refresh après action | `refreshDeviceList()` → `devices:refresh-request` | Appelle `refreshDeviceList()` mais JSON reste `wifiEnabled: false` |

**Cause racine Reconnecter :** connexion ADB WiFi réussie mais **`wifiEnabled` reste false** → `wifiActive` false → toggle OFF.

**Fix prévu :** `wifi:reconnect` → `setWifiEnabled(deviceId, true)` avant `reconnectSaved` ; `syncAfterPanelAction()` → `refreshDevices()` + `renderPanel()`.

---

### 4. Plan implémentation

| P | Action |
|---|--------|
| P0 | Renommer panneau → `namesAPI.openRenameDialog` + écoute `names:updated` |
| P0 | `wifi:reconnect` → `setWifiEnabled(true)` |
| P1 | Actions USB Renommer / Supprimer (handler `devices:panel-remove` unifié) |
| P1 | Couleurs via `getColorForDevice` dans `wifi:panel-data` |
| P1 | `performDeviceRename` + panel actions → `refreshDeviceList()` (sidebar + panneau) |

**Zones LOCK :** aucune.

---

## BUG — ReferenceError notifyDeviceViewsUpdated (2026-07-05)

**Erreur :** `ReferenceError: notifyDeviceViewsUpdated is not defined` à `performDeviceRename` (namesHandlers.js:23).

**Statut : corrigé (2026-07-05).**

### Correctif

`notifyDeviceViewsUpdated(mainWindow, refreshDeviceList)` déplacée au **niveau module** ; `performDeviceRename` et `names:resetDevice` reçoivent `refreshDeviceList` depuis `registerNamesHandlers`.

---

| Point | Détail |
|-------|--------|
| Appel | `performDeviceRename()` (module-level, l.23) → `notifyDeviceViewsUpdated()` |
| Définition | `notifyDeviceViewsUpdated` déclarée **à l'intérieur** de `registerNamesHandlers()` (l.71) — closure locale |
| Export global ? | ❌ Non — n'existe pas dans `main.js`, `device-registry`, ni ailleurs |
| Rôle attendu | `notifyNamesUpdated(mainWindow)` + `refreshDeviceList()` (= `requestRendererDeviceRefresh` dans main.js) |
| Autres fichiers | `wifiHandlers.js` appelle directement `refreshDeviceList` — pas d'usage de `notifyDeviceViewsUpdated` |
| `names:resetDevice` | N'appelle que `notifyNamesUpdated` — pas de refresh devices (mineur) |

**Cause racine :** refactor incomplet — helper de refresh multi-vues défini dans la mauvaise portée (closure `registerNamesHandlers` inaccessible depuis `performDeviceRename` module-level).

**Fix prévu :** helper module-level `notifyDeviceViewsUpdated(mainWindow, refreshDeviceList)` ; passer `refreshDeviceList` depuis `registerNamesHandlers` aux appels `performDeviceRename`.

**Zones LOCK :** aucune.

---

## BUG — Couleur instances + popup Renommer always-on-top (2026-07-05)

**Statut : corrigé (2026-07-05).**

### Correctifs appliqués

| Bug | Fichiers | Correction |
|-----|----------|------------|
| Couleur instances | `sessionHandlers.js`, `browserViewManager.js`, `session.html`, `session.js`, `sessionPreload.js`, `deviceColorsHandlers.js`, `contextMenuHandlers.js` | `deviceColorHex` en query URL à la création ; bordure `body` ; IPC `session:device-color-changed` pour mise à jour live |
| Popup Renommer | `rename-dialog-manager.js` | Suppression `setAlwaysOnTop` + `setVisibleOnAllWorkspaces` |

**Mise à jour live couleur :** oui — toute session ouverte pour le `deviceId` reçoit la nouvelle bordure sans relancer la session.

---

### 1. Couleur non appliquée aux fenêtres (instances)

| Zone | Fichier | Couleur appliquée ? |
|------|---------|---------------------|
| Sidebar devices | `DevicePanel.js` | ✅ pill `.device-color-pill` via `device.deviceColor` |
| Onglets session | `Sidebar.js` | ✅ pill onglet via `sessionAPI.list()` → `applySessionColors` |
| Panneau Appareils | `wifiHandlers.js` → `DevicesPanel.js` | ✅ `getColorForDevice(deviceId)` |
| **BrowserView (flux vidéo)** | `session.html` / `browserViewManager.js` | ❌ **Aucune** — pas de `deviceColor` dans `extraQuery` ni query URL |
| Overlay HTML `.content` | `index.html` / `layout-metrics.js` | ❌ Impossible — BrowserView natif passe **au-dessus** du DOM renderer |

**Source de vérité :** `DeviceColorsManager` (`device-colors.json`) — `getColorForDevice(deviceId)` ; enrichissement sessions via `applySessionColors()` dans `sessionHandlers.js` (IPC `session:list` uniquement, pas propagé à la vue).

**Création session :** `session:registerView` → `browserViewManager.registerSessionView()` → `loadFile(session.html, { query: sessionId, type, deviceId, label, orientation })` — **sans** `deviceColorHex`.

**Mise à jour live :** aucun canal IPC vers les BrowserViews ; changement de couleur ne met à jour que sidebar / panneau (event `device-colors:updated`).

**Zones LOCK :** le problème est **en amont** (`browserViewManager`, `sessionHandlers`, `session.html`) — pas dans `createSession()` / `scrcpy-socket.js` / `new-instance-manager.js`.

**Fix prévu :**
1. À l'enregistrement : résoudre `deviceColorHex` depuis `DeviceColorsManager` et le passer en query URL.
2. `session.html` : bordure `inset` sur `body` via `--device-color`.
3. Mise à jour live : IPC `session:device-color-changed` → `browserViewManager.updateDeviceColorForDevice(deviceId, hex)` depuis `device-colors:setManual` / `setAuto` (et menu contextuel).

---

### 2. Popup Renommer toujours au premier plan

| Point | Détail |
|-------|--------|
| Type | **BrowserWindow** Electron (`RenameDialogManager`) — pas une modal HTML |
| `parent` | `mainWindow` (comportement enfant correct) |
| Cause | `setAlwaysOnTop(true, "screen-saver")` dans `_ensureWindow()` (l.82) **et** `show()` (l.114) |
| Extra | `setVisibleOnAllWorkspaces(true)` (l.83-85) — renforce le comportement « flottant » |

**Fix prévu :** retirer les deux `setAlwaysOnTop` ; retirer `setVisibleOnAllWorkspaces` (inutile sans always-on-top).

**Zones LOCK :** aucune.

---

## CORRECTION — Retrait bordure flux + pastille onglet (2026-07-05)

**Statut : corrigé (2026-07-05).**

### Correctifs appliqués

| Point | Action |
|-------|--------|
| 1. Bordure flux | Retirée (`session.html`, `session.js`, `sessionPreload.js`, `browserViewManager`, handlers IPC) |
| 2. Bordure fenêtre focus | Non implémentée (frameless + BrowserView — trop risqué) |
| 3. Pastille onglet | `refreshSessionTabColors()` dans `Sidebar.js` — mise à jour ciblée sur `device-colors:updated` |

---

### 1. Retrait bordure colorée sur le flux (demandé)

| Fichier | Élément ajouté récemment | Action |
|---------|--------------------------|--------|
| `session.html` | `body[data-device-color]{border:…}` | Retirer |
| `session.js` | `applyDeviceColor`, query `deviceColorHex`, listener IPC | Retirer |
| `sessionPreload.js` | `onDeviceColorChanged` | Retirer |
| `browserViewManager.js` | `deviceColorHex` entry/query, `updateDeviceColorForDevice()` | Retirer |
| `sessionHandlers.js` | résolution `deviceColorHex` dans `session:registerView` | Retirer |
| `deviceColorsHandlers.js` | push couleur vers BrowserViews | Retirer |
| `contextMenuHandlers.js` | idem | Retirer |

**Zones LOCK :** aucun de ces fichiers n'est dans `createSession()` / `scrcpy-socket.js` / `new-instance-manager.js`.

---

### 2. Alternative bordure fenêtre au focus (optionnel)

| Contrainte | Détail |
|------------|--------|
| Fenêtre principale | `frame: false` — pas de chrome OS natif |
| Flux vidéo | BrowserView natif au-dessus du DOM |
| Overlay HTML `.content` | Masqué sous le BrowserView |

→ Bordure « fenêtre active » cohérente sans toucher au flux = refonte titlebar/CSS + sync focus OS — **hors scope, non implémenté**.

---

### 3. Pastille couleur dans l'onglet — diagnostic

| Point | État actuel |
|-------|-------------|
| Rendu initial | `Sidebar.js` → `createSessionTabElement` : pill `.tab-icon.device-color-pill` + `deviceColor.hex` inline |
| Source | `sessionAPI.list()` → `applySessionColors()` (`device-colors.json` via `deviceId` session) |
| Event changement | `deviceColorsAPI.onUpdated` → **`renderSidebar()`** (rebuild complet `tabsBar.innerHTML = ""`) |
| Problème | Rebuild lourd ; `upsertSessionTab` ne met à jour la pill que si `deviceColor?.hex` truthy (pas de reset) ; pas de refresh ciblé des pills existantes |

**Fix prévu :** `refreshSessionTabColors()` — met à jour uniquement les pills des onglets ouverts via `sessionAPI.list()`, sans détruire les tabs ; appelé sur `device-colors:updated`.

**Zones LOCK :** aucune.

---

## BUG — Pastille couleur USB OK / WiFi KO (2026-07-05)

**Statut : corrigé (2026-07-05).**

### Correctif

`DeviceRegistry.buildAdbSerialToDeviceIdMap()` + `applySessionColors(sessions, map)` dans `session:list` — résolution `ip:port` → `deviceId` stable pour le lookup couleur, sans modifier `entry.deviceId` (serial ADB pour scrcpy/ADB).

---

### 1. Source de vérité couleur vs clé session

| Couche | Clé utilisée | WiFi |
|--------|--------------|------|
| `device-colors.json` | `deviceId` stable (`ro.serialno` / `android_id`) | ✅ via `applyDeviceColors` → `device.deviceId` |
| Menu contextuel sidebar | `device.deviceId` stable (`DevicePanel.js` l.295) | ✅ `setManualColor(stableId)` |
| Carte sidebar (pill) | `device.deviceColor` enrichi sur `deviceId` stable | ✅ |
| **`BrowserView` session (`entry.deviceId`)** | **Serial ADB effectif** (`ip:port` en WiFi) | ❌ |
| `applySessionColors()` | `getColorForDevice(session.deviceId)` = serial ADB | ❌ cherche `192.168.x.x:5555` au lieu de `e176518f` |

**Cause racine :** couleur stockée sous **deviceId stable**, session enregistrée avec **serial transport** (`ip:port`). USB masque le bug car souvent `serial USB === deviceId stable`.

---

### 2. Fusion identité USB + WiFi à cet endroit

| Étape | Fusion |
|-------|--------|
| Liste devices (`DeviceRegistry.listUnifiedDevices`) | ✅ 1 entrée / `deviceId`, `serial` = transport effectif |
| Lancement miroir / Type B | `createInstance(serial)` / `registerView({ deviceId: serial })` → **serial WiFi**, pas `device.deviceId` |
| `applySessionColors` | ❌ **Pas de résolution** serial ADB → deviceId stable |

---

### 3. Écouteur changement couleur

| Point | USB | WiFi |
|-------|-----|------|
| `device-colors:updated` → `refreshSessionTabColors()` | ✅ même chemin | ✅ même chemin |
| `sessionAPI.list()` → couleur | ✅ si clé session = clé JSON | ❌ clé session `ip:port` ≠ clé JSON |

→ Le listener est **commun** ; l'échec WiFi vient du **lookup**, pas d'un écouteur manquant.

**Fix prévu :** `DeviceRegistry.buildAdbSerialToDeviceIdMap()` + `applySessionColors(sessions, map)` pour résoudre la clé couleur via deviceId stable tout en gardant `entry.deviceId` = serial ADB (LOCK scrcpy/ADB).

**Zones LOCK :** aucune (`entry.deviceId` reste le serial ADB pour `runAdbShell`, `new-instance-manager`).

---

**Zones LOCK :** aucune (`entry.deviceId` reste le serial ADB pour `runAdbShell`, `new-instance-manager`).

---

## TÂCHE — Parité USB/WiFi Session Type A/B (2026-07-05)

**Statut : diagnostic terminé — en attente validation utilisateur avant toute correction.**

Objectif : même pipeline Type A/B, seule la cible ADB change (`usbSerial` vs `ip:port`).

### Modèle d'identité (rappel)

| Concept | Exemple USB | Exemple WiFi | Où |
|---------|-------------|--------------|-----|
| **deviceId stable** | `e176518f` | `e176518f` | `device-colors.json`, noms, fusion registry |
| **serial ADB effectif** | `a3acba7c` | `192.168.1.10:5555` | `listUnifiedDevices().serial`, scrcpy, `adb -s` |
| **`entry.deviceId` session** | serial USB | `ip:port` | `browserViewManager` (nom trompeur = serial ADB au moment du lancement) |

Le lancement session utilise **toujours** `device.serial` (transport effectif) — pas de branche `if (wifi)` dans `instance-manager.js`, `video-player.js`, `new-session.js`, `scrcpy-socket.js` (hors quoting serial).

---

### 1. Lancement Session Type A (mirroring complet)

| | USB | WiFi |
|---|-----|------|
| **Chemin** | `DevicePanel` dblclick / `launchMirrorSession` → `createInstance(serial)` → `registerView(A)` → `start-video-stream` → `ScrcpySocketClient` | **Identique** — `serial` = `ip:port` depuis `resolveEffectiveTransport` |
| **Fichiers** | `DevicePanel.js:325-333`, `new-session.js:968-986`, `instance-manager.js:57-64`, `main.js:1770+` | idem |
| **Parité** | ✅ **Pipeline identique** si `adb devices` liste le `ip:port` en `device` |

**Écarts potentiels (pas de chemin WiFi séparé) :**

| ID | Problème | Impact WiFi | Zone fix |
|----|----------|-------------|----------|
| A1 | `selectDevice` auto (1 device) omet `deviceId` stable | `deviceId` = serial WiFi en UI | `new-session.js:643-644` — amont |
| A2 | `entry.deviceId` figé au lancement, jamais mis à jour si bascule USB↔WiFi mid-session | Session ouverte avant toggle transport | `browserViewManager` — amont |
| A3 | `scrcpyClientsBySerial[serial]` — clé = serial au moment du start | Reconnect autre transport = nouveau client | `main.js:1721` — amont |

**Verdict point 1 :** le mirroring Type A **devrait** fonctionner en WiFi au lancement. Si échec observé → vérifier connexion ADB (`adb devices`), pas une branche code WiFi absente.

---

### 2. Lancement Session Type B (`--new-display`)

| | USB | WiFi |
|---|-----|------|
| **Chemin** | `launchTypeBSession` → `launchNewInstance(serial)` → scrcpy externe `--serial` + `--new-display` → `newInstanceCreate` → `pipeline.start` → `registerView(B)` | **Identique** |
| **Fichiers** | `new-session.js:737-819`, `main.js:538-552`, `new-instance-manager.js`, `new-instance-ipc.js` | idem |
| **Parité** | ✅ **Pipeline identique** |

**Écarts potentiels :**

| ID | Problème | Impact WiFi | Zone fix |
|----|----------|-------------|----------|
| B1 | `buildNewInstanceExternalBaseArgs` : `--serial` passé à `spawn` (pas shell) | OK pour `ip:port` | — |
| B2 | `waitForVirtualDisplayId` matche `waiter.serial === data.serial` exact | Bascule transport pendant attente | `new-session.js` — amont |
| B3 | Commandes ADB package/display dans `main.js` (`resolveLaunchActivity`, `launchPackageOnDisplay`) : `-s ${serial}` **non quoté** | Risque shell Windows si serial mal formé ; `ip:port` sans espace souvent OK | `main.js:74-114` — amont |
| B4 | `new-instance-manager.js` commandes `adb -s ${serial}` non quotées (l.162, 189, 571+) | Idem B3 | amont (hors LOCK si hors createSession core) |

**Verdict point 2 :** Type B utilise le même pipeline. Échecs WiFi probables = latence ADB / display virtuel pas détecté à temps, ou commandes `adb -s` fragiles — pas d'option `--new-display` différente.

**⚠️ LOCK :** `new-instance-manager.js` — ne pas modifier `_runClientStart` / create sans validation.

---

### 3. Orientation image (portrait/paysage)

#### Où se prend la décision

```
┌─ Stream (re)start ─────────────────────────────────────────────┐
│ stream-params.resolveCaptureOrientationLock(orientation, w, h) │
│   → capture_orientation=@270|@90|null                          │
│   → scrcpy-socket.js:295-300 (LOCK)                            │
├─ Toggle sidebar (sans restart scrcpy) ───────────────────────┤
│ StreamParamsManager.setOrientation()                           │
│   → getDeviceDimensions(entry.deviceId) [cache input ctrl]     │
│   → DeviceOrientationManager.applyOrientation(serial, …)       │
│     → wm size + user_rotation via ADB (serial quoté)           │
│   → browserViewManager.setSessionCaptureOrientation            │
│   → session.js canvas rotation + remap touch                   │
└────────────────────────────────────────────────────────────────┘
```

| Couche | Fichier | Dépend du transport ? |
|--------|---------|----------------------|
| Lock scrcpy | `scrcpy-socket.js:295-300` | ❌ Non — `capture_orientation` depuis options |
| Dims au démarrage stream | `main.js:1474-1483` | ❌ Non — cache input controller ; **dims souvent null** → assume appareil paysage natif |
| Rotation physique | `device-orientation-manager.js:88-125` | ❌ Non — `shellQuote(serial)` OK pour `ip:port` |
| Dims au toggle | `stream-params-manager.js:299` | ❌ Non — mais cache vide si pas encore de touch/input init |
| UI canvas | `session.js`, `layout-metrics.js` | ❌ Non |

| | USB | WiFi |
|---|-----|------|
| **Code orientation** | Même chemin | Même chemin |
| **Parité théorique** | ✅ | ✅ |

**Pourquoi l'orientation peut sembler « cassée » en WiFi :**

| ID | Cause | USB | WiFi | Zone |
|----|-------|-----|------|------|
| O1 | `startVideoStreamLogic` : pas de dims au 1er start → `naturalLandscape=true` par défaut | Impacte si téléphone portrait-natif | **Idem** + latence `wm size` plus visible au toggle | `main.js:1474-1483` amont |
| O2 | `getDeviceDimensions(entry.deviceId)` = cache input uniquement, pas ADB live au toggle | Cache vide avant 1er input | WiFi : `AdbInputController.init()` / `wm size` plus lent | `stream-params-manager.js:299`, `main.js:1967-1974` amont |
| O3 | Toggle : si `applyPhysicalOrientation` échoue, UI tourne mais pas l'appareil → décalage visuel | Possible | **Plus fréquent** si ADB WiFi lent/timeout | `device-orientation-manager.js` OK ; échec silencieux `physical: false` |
| O4 | `runAdbShell(entry.deviceId, …)` **sans quoting** (`sessionHandlers.js:14`) pour `toggleScreen` / `stayon` | Rare | Possible fragilité `ip:port` | `sessionHandlers.js` amont |
| O5 | Restauration orientation à la fermeture : `entry.deviceId` comme serial | OK si serial correct | OK si `ip:port` | `sessionHandlers.js:140-143` amont |

**⚠️ LOCK — scrcpy-socket.js :** la logique `capture_orientation` (l.295-300) est **identique** pour USB et WiFi. Si le flux scrcpy lui-même envoie une mauvaise orientation au démarrage, correction **dans LOCK** — **attendre validation**.

**Verdict point 3 :** pas de branche WiFi dans le code orientation. Symptôme WiFi probablement = **timing/dims manquantes** (amont) ou **échec rotation physique ADB** (latence), pas une résolution d'écran « différente selon transport » dans scrcpy-socket.

---

### 4. Contrôle input (clic, drag, clavier)

| | USB | WiFi |
|---|-----|------|
| **Type A** | `session.js` → `sendInput({ deviceId })` → `main.js:1113+` → `AdbInputController` / scrcpy control | **Identique** — `deviceId` payload = `entry.deviceId` = serial ADB |
| **Type B** | `sendInput` sans deviceId → résolution `entry.deviceId` / `typeBSession.serial` | **Identique** |
| **Quoting ADB input** | `adb-input-controller.js:95` `shellQuote(serial)` | ✅ `ip:port` géré |

| ID | Problème | WiFi |
|----|----------|------|
| I1 | Pas d'appel `device:resolve-serial` avant input | OK au lancement ; KO si `entry.deviceId` obsolète après bascule transport |
| I2 | `getOrCreateSessionInputController(deviceId)` — param = serial ADB, pas stable ID | Même règle USB/WiFi |
| I3 | Scrcpy control socket routé par **sessionId** uniquement (`main.js:995-1008`) | ✅ Parité |

**Verdict point 4 :** input **fonctionne en WiFi** si session lancée sur le bon `ip:port`. Pas d'écouteur USB-only. Échec = serial session ≠ serial ADB actuel.

### 4 bis. Contrôle clavier — touche ESPACE (diagnostic uniquement)

**LOCK concerné :** oui (capture keydown + mapping + envoi ADB). Ne pas modifier avant validation.

#### 1) Fichiers qui gèrent le clavier
- Capture `keydown` + table “spéciales” (Enter/Escape/Tab/Arrows/…) : `src/renderer/session/session.js` (initTypeAInputHandlers + initTypeBInputHandlers)
- Passage au main : `src/preload/sessionPreload.js` (`videoAPI.sendInput`)
- Routage key→scrcpy/ADB selon `key.length` : `src/main/main.js` (handler IPC `send-input`)
- Conversion “string key → injection Android” : `src/native/scrcpy/control/adb-input-controller.js` (`AdbInputController.sendKey` + `KEYCODE_MAP`)

#### 2) Couverture mapping (key → Android)
Dans `session.js`, l’envoi suit cette règle (identique Type A et Type B) :
`if (key.length === 1 || KEYCODE_MAP[key]) { ... sendInput({ type:"key", key }) }`.

- Lettres `a-z` : `event.key` length==1 ⇒ chemin “texte” (`shell input text "<lettre>"`)
- Chiffres/symboles : length==1 ⇒ “texte”
- ESPACE : `event.key` = `" "` ⇒ length==1 ⇒ chemin **“texte”** (`shell input text " "`)
- Enter / Backspace / Escape / Tab / Arrows / Home / Back / Menu / Delete / VolumeUp/VolumeDown / Power :
  - `event.key` est une chaîne (ex: `"Enter"`, `"Escape"`, `"ArrowUp"`)
  - Présente dans la table `KEYCODE_MAP` du renderer ⇒ envoi `"Enter"`, etc.
  - Côté `adb-input-controller.js`, ces chaînes mappent vers des **keyevent** (ex: Enter→66, Escape→4, etc.)

#### 3) Cause la plus probable pour ESPACE
- `KEYCODE_MAP` du renderer ne couvre pas l’espace (pas d’entrée pour `" "`).
- Comme `" "` a `length===1`, la touche ESPACE n’est **jamais** envoyée comme keyevent KEYCODE_SPACE=62.
- Résultat : ESPACE est injecté via `shell input text " "` plutôt qu’un `keyevent 62`.
- Beaucoup d’apps (jeux / UI non-text) réagissent à KEYCODE_SPACE, pas à l’injection “texte”.

#### 4) Touches “pattern similaire” à surveiller
Toute touche qui arrive en `event.key` avec `length===1` suit le même chemin “texte” :
- espace `" "` (déjà problématique)
- éventuellement d’autres whitespace si elles arrivent comme single-char (`\u00A0`, etc.)
- (les lettres/chiffres/symboles sont aussi single-char, mais chez toi elles semblent OK)

#### 5) Correctif proposé (en attente de validation)
Minimal (LOCK) : dans `src/native/scrcpy/control/adb-input-controller.js`, dans `sendKey(key)` :
- si `key === " "` (et idéalement `\u00A0`) ⇒ envoyer `shell input keyevent 62` (au lieu de `shell input text " "`).

**⚠️ LOCK :** fichiers input natifs — ne pas modifier sans validation.

---

### 5. Clic droit → BACK

| | USB | WiFi |
|---|-----|------|
| **Handler** | `session.js:211-218` contextmenu → Type A `sendInput({ key: "Back", deviceId })` / Type B sans deviceId | **Identique** |
| **Parité** | ✅ Même pipeline que §4 | |

**Verdict point 5 :** parité OK si input OK (§4).

---

### 6. Double-clic sidebar → lancement mirroring

| | USB | WiFi |
|---|-----|------|
| **Flux** | `DevicePanel.js:325-333` → `setSelectedDeviceForMirror(serial, name, device.deviceId)` → `launchMirrorSession` → `selectedDevice.serial` | `serial` = `ip:port` quand transport WiFi actif |
| **Parité** | ✅ | ✅ **Correct by design** |

**Verdict point 6 :** parité OK — utilise `device.serial` effectif du registry.

---

### 7. Contrôle audio par fenêtre

| | USB | WiFi |
|---|-----|------|
| **Démarrage** | `session-audio-process-manager.start(sessionId, { serial })` depuis serial du stream start | **Identique** au lancement |
| **Resync global unmute** | `syncAllActiveSessions()` lit `entry?.deviceId` (`session-audio-process-manager.js:161`) | **Risque** si entry stale |
| **Renderer** | `session-audio-hub.js` — clé `sessionId` seulement | ✅ Parité |

| ID | Problème | WiFi |
|----|----------|------|
| AU1 | Resync utilise `entry.deviceId` sans `resolveAdbSerial` | Mauvais `--serial` si bascule transport |

**Verdict point 7 :** audio **OK au lancement WiFi** ; resync après unmute/global toggle **peut diverger** (amont, pas LOCK).

---

### 8. Historique de lancement d'app (Type B)

| | USB | WiFi |
|---|-----|------|
| **Enregistrement** | `new-instance-ipc.js:24-25` → `deviceId: session.serial` (**serial ADB**, pas stable ID) | Clé = `ip:port` |
| **Relance** | `new-session.js:850, 889` → `devices.find(d => d.serial === deviceId)` | **Échoue** si historique USB et device maintenant WiFi (ou inverse) |
| **Libellé** | `resolveDeviceName(serial)` — match `d.serial` only | Affiche `ip:port` si transport changé |

| ID | Problème | Impact |
|----|----------|--------|
| H1 | Champ `deviceId` dans history = serial ADB | Entrées dupliquées USB + WiFi pour même appareil |
| H2 | Relance ne matche pas `d.deviceId` stable | **KO WiFi** après lancement USB (et inverse) |
| H3 | Pas de fusion comme `device-history.json` (stable ID + usbSerial/wifiSerial) | Parité historique device OK vs launch history KO |

**Verdict point 8 :** ❌ **Parité cassée** — bug amont (`launch-history-manager` + `new-session.js`), pas LOCK.

---

### 9. Autres fonctions Type A/B existantes

| Fonction | USB | WiFi | Statut | Notes |
|----------|-----|------|--------|-------|
| Toggle écran (Type A) | `session:toggleScreen` + scrcpy `setDisplayPower` | Idem | ⚠️ | `runAdbShell` non quoté (`sessionHandlers.js:14`) |
| Stay-awake ADB | `runAdbShell(entry.deviceId, "svc power stayon true")` | Idem | ⚠️ | §O4 |
| Fermeture session → restore orientation | `entry.deviceId` | Idem | ✅/⚠️ | Serial correct si session WiFi |
| Restart stream (params) | `stream-params-manager` → `entry.deviceId` as serial | Idem | ✅ au lancement | KO si entry stale |
| Pastille couleur onglet | Résolu `fa2f278` | ✅ après fix map serial→stable | ✅ | `session:list` + `buildAdbSerialToDeviceIdMap` |
| Noms custom session/device | stable `deviceId` via context menu | ✅ cross-transport | ✅ | `DevicePanel.js:295` |
| `device:resolve-serial` IPC | Existe | **Jamais appelé** renderer | ⚠️ | `preload.js:157` — opportunité amont |
| App metadata / icônes cache | Clé = serial from history | Cache miss si transport change | ⚠️ | `app-metadata-manager.js` |
| Hub modal délégation miroir | `hubModalHandlers` → main actions | ✅ | ✅ | Même serial passé |
| Polling devices / toggle WiFi | Registry | N/A session | ✅ | Hors scope session ouverte |

---

### Synthèse — causes racines par zone

| Priorité | Cause | Symptômes WiFi | Zone correction |
|----------|-------|----------------|-----------------|
| **P0** | Historique lancement clé sur serial ADB, relance `d.serial === deviceId` | Type B historique ne relance pas ; libellés `ip:port` | `new-instance-ipc.js`, `launch-history-manager.js`, `new-session.js` — **amont** |
| **P0** | `entry.deviceId` = serial figé, pas de résolution live | Input/audio/orientation/restart après bascule USB↔WiFi | `browserViewManager` + helper `resolveAdbSerial` avant ADB — **amont** |
| **P1** | Dims orientation null au 1er stream + cache input vide au toggle | Image mal orientée (surtout portrait / téléphones portrait-natifs) | `main.js` startVideoStreamLogic, `stream-params-manager` — **amont** |
| **P1** | `adb -s ${serial}` non quoté (main.js, sessionHandlers) | Commandes shell fragiles | Helper `adbSerialArg` partagé (`wifi-adb-service` pattern) — **amont** |
| **P1** | Audio resync `entry.deviceId` | Unmute global sur mauvais serial | `session-audio-process-manager.js` — **amont** |
| **P2** | `device:resolve-serial` non branché | Code mort utile pour parité | Brancher en amont session/input |
| **LOCK?** | `capture_orientation` dans scrcpy-socket | Bug flux scrcpy avéré | **✅ LOCK validé** (2026-07-05) |

---

### Plan correction proposé (après validation)

| Phase | Actions | LOCK ? |
|-------|---------|--------|
| **1 — amont identité** | Canonicaliser launch history sur `deviceId` stable ; relance `d.deviceId \|\| d.serial` ; `resolveAdbSerial` avant ADB session | Non |
| **2 — amont ADB** | `shellQuote` / `adbSerialArg` unifié dans `sessionHandlers`, `main.js` helpers | Non |
| **3 — orientation amont** | Fetch `wm size` live au toggle si cache vide ; optionnel au stream start | **Implémentée** |
| **4 — LOCK orientation scrcpy** | Fallback `resolveCaptureOrientationLock` ; fix `EventEmitter` | **✅ LOCK validé** |

**Phase 1 — implémentée (2026-07-05).**

| Fichier | Changement |
|---------|------------|
| `device-registry.js` | `resolveEffectiveAdbSerial()`, `resolveStableDeviceIdFromTransport()` |
| `launch-history-manager.js` | `migrateDeviceIdsToStable()` ; clés sur deviceId stable |
| `new-instance-ipc.js` | `recordLaunch` avec deviceId stable |
| `new-session.js` | `findDeviceForHistory()` ; relance cross-transport ; `stableDeviceId` au lancement |
| `browserViewManager.js` | `entry.stableDeviceId` |
| `instance-manager.js` / `preload.js` | `stableDeviceId` dans `registerView` |
| `new-instance-manager.js` | `session.stableDeviceId` |
| `sessionHandlers.js` | `resolveEntryAdbSerial()` ; quoting `runAdbShell` ; toggle/close orientation |
| `main.js` | `send-input` resolve ; `applyPhysicalOrientation` resolve ; history migration startup ; `getActiveTypeBHistoryKeys` stable |
| `session-audio-process-manager.js` | resync avec serial résolu |
| `stream-params-manager.js` | restart Type A avec serial résolu |

**Zones LOCK :** non touchées.

---

## Diagnostic — input / curseur qui bouge tout seul (phase 1, 2026-07-05)

**Symptôme rapporté :** pendant le mirroring (probablement WiFi), le curseur ou le point de contact sur l'appareil se déplace en continu sans action utilisateur.

**Méthode :** analyse statique du code + corrélation avec Phase 1 (non commitée). Pas de reproduction matérielle dans cet environnement — tests USB vs WiFi à faire côté utilisateur avec les procédures ci-dessous.

---

### 1. WiFi uniquement ou aussi USB ?

| Aspect | Constat |
|--------|---------|
| Chemin renderer | **Identique** USB / WiFi — `session.js` `initTypeAInputHandlers` / Type B, pas de branche `isWifiTransport` |
| Chemin main `send-input` | **Identique** — même handler, même routage scrcpy puis fallback ADB |
| Différence transport | Phase 1 ajoute `resolveEffectiveAdbSerial()` sur **chaque** `send-input` (USB et WiFi) |
| Hypothèse WiFi plus visible | ADB sur WiFi plus lent → latence + contention daemon ADB plus marquées ; scrcpy tunnel partage le même serveur ADB |

**Verdict :** le code n'isole pas le bug au WiFi. **Probable amplification WiFi**, pas exclusivité. À valider : même scénario en USB après Phase 1 (drag long, main immobile après tap).

**Test utilisateur :**
1. Session Type A USB — main sur canvas 10 s sans bouger → curseur device stable ?
2. Même chose WiFi — drift apparaît-il ?
3. Si les deux : cause commune (Phase 1). Si WiFi seul : ajouter trace latence `adb devices` + perte paquets.

---

### 2. Événements input parasites (polling / listeners) ?

| Source recherchée | Résultat |
|-------------------|----------|
| `setInterval` + `sendInput` | **Aucun** dans le repo |
| `pointermove` sans drag | Listener ajouté **uniquement** entre `pointerdown` et `pointerup`/`pointercancel` (`session.js` ~848–905) |
| Throttle move | ≥ 2 px ou ≥ 16 ms entre envois |
| `AdbInputController.sendTouch("move")` | **No-op** — ne lance pas de commande ADB (seuls down/up/tap/swipe envoient) |
| Mouvement continu device | Nécessite **scrcpy** `sendTouchEvent(ACTION_MOVE)` (action `2`) ou rafale tap/swipe |
| Wheel zoom | CSS only (`session-wheel-zoom.js`) — pas d'IPC touch |
| FPS / preview timers | `FpsMonitor`, `useVideoPreview` — pas d'input |

**Chemins qui envoient ACTION_MOVE :** uniquement `main.js` → `scrcpyClient.sendTouchEvent(2, …)` quand `action === "move"` et socket contrôle active.

**Verdict :** pas de générateur logiciel continu évident. Causes plausibles sans « polling » :
- **A** — `pointermove` fantômes (layout canvas / BrowserView qui bouge sous curseur fixe, `isDragging` bloqué à `true`) ;
- **B** — file `pendingInput` + latence Phase 1 qui rejoue des moves en rafale après un drag ;
- **C** — saturation ADB → messages contrôle scrcpy retardés / réordonnés (effet visuel de drift).

---

### 3. Check statut WiFi (`getAdbState` / ping) vs flux input ?

| Mécanisme | Canal | Pendant mirroring session |
|-----------|-------|---------------------------|
| Panneau Appareils ouvert | `buildDevicesPanelData` → `getAdbState` par config WiFi | Poll 4 s (`DevicesPanel.js` `PANEL_POLL_MS`) — **pas le canal scrcpy** |
| Sidebar devices | `refreshDevices` 8 s → IPC `get-devices` → `listUnifiedDevices` | Arrière-plan léger si panneau fermé |
| **Phase 1 `send-input`** | `resolveEffectiveAdbSerial` → **`listUnifiedDevices()`** | **À chaque touch/key**, y compris chaque `move` (~ jusqu'à 60/s) |

Chaîne `listUnifiedDevices` (par appel) :
1. `getRawAdbDevices()` → `adb devices -l`
2. `importDiscoveredWifiDevices`
3. `attachStableIds` → `getStableDeviceId` / `getprop` si cache TTL expiré

**Interférence :** pas sur le socket TCP contrôle scrcpy, mais **même daemon ADB** que le tunnel scrcpy. Sous charge (drag WiFi + Phase 1), risque de :
- latence IPC `send-input` ;
- réordonnancement file renderer `pendingInput` ;
- dégradation tunnel → symptômes input erratiques.

**Verdict :** le check WiFi panneau **n'explique pas seul** un drift continu si le panneau est fermé. **Phase 1 resolve sur chaque move** est le suspect principal d'interférence timing / ADB (introduit dans le même lot de changements que le bug rapporté).

---

### 4. Logs / événements bruts pendant le bug

**Logs existants** (`main.js` ~1237–1245) — chaque `send-input` :
```text
[Input] device=<serial> session=<id> type=touch action=move x=… y=… stream=…x…
```

**Procédure diagnostic runtime :**
1. Lancer l'app depuis terminal (`npm start`) pour voir stdout main.
2. Reproduire drift **sans toucher** la souris.
3. Observer :
   - **Rafale `[Input] … action=move`** sans drag → bug renderer (pointer fantôme ou `isDragging` coincé) ;
   - **Aucun log move** mais device bouge → hors Hub (app device, autre client scrcpy, ghost touch hardware) ;
   - **Moves avec x/y qui dérivent lentement** alors que coords écran stables → remap portrait / `streamWidth` incohérent ;
   - **Rafale moves après fin de drag** → file async Phase 1.

**Log complémentaire suggéré (fix phase, pas encore appliqué) :** durée `resolveEffectiveAdbSerial` + flag `cached` pour confirmer charge ADB.

---

### Synthèse causes probables

| Priorité | Cause | Mécanisme | Fix proposé (après validation) |
|----------|-------|-----------|--------------------------------|
| **P0** | `resolveEffectiveAdbSerial` dans `send-input` à chaque event | `adb devices -l` jusqu'à ~60×/s au drag ; pire en WiFi | **Cache par session** : serial résolu au lancement + invalidation sur `refreshDevices` / changement transport ; retirer `listUnifiedDevices` du hot path |
| **P1** | `isDragging` / pointer capture perdue | `pointerup` manqué → micro-moves continus | `pointerleave` / `blur` → force `pointercancel` + `up` |
| **P1** | Layout canvas / portrait `syncPortraitLayout` | Redimensionnement flux sous curseur → `pointermove` synthétiques | Débouncer resize ; ne pas reset wheel pendant stream actif |
| **P2** | Panneau Appareils ouvert + WiFi poll | Charge ADB additive | Déjà isolé ; fermer panneau pendant test |
| **P2** | `preferAdbTouch` (audio fallback) | Move ADB = no-op → **peu probable** pour drift continu | N/A sauf si socket contrôle absente |

**Corrélation temporelle :** le handler `send-input` du commit `fa2f278` **n'appelait pas** `resolveEffectiveAdbSerial` ; l'appel n'existe que dans les changements Phase 1 non commités (`main.js:1141–1150`). **Fortement corrélé** au rapport de bug post-Phase 1.

**Fichiers LOCK :** diagnostic ne propose **aucune** modification `scrcpy-socket.js` / `createSession` tant que P0 cache amont non testé.

---

### Plan validation avant patch

1. Repro USB vs WiFi (main immobile).
2. Compter logs `[Input] action=move` pendant drift sans toucher.
3. Patch P0 cache serial session → retest WiFi.
4. Si persiste : instrumenter `isDragging` + `pointerType` côté renderer.

---

## Diagnostic — clic long (infos app) + clic droit BACK WiFi (2026-07-05)

**Symptômes :**
1. **Clic long** sur l'écran mirrord (menu infos app Android) — OK USB, KO WiFi.
2. **Clic droit → BACK** en session **Type B** — OK USB, KO WiFi.

**Méthode :** analyse statique des chemins `session.js` → `send-input` → scrcpy / ADB. Pas de repro matérielle ici.

---

### 1. Chemin d'exécution USB vs WiFi — serial / cible

| Étape | USB | WiFi | Branche transport ? |
|-------|-----|------|-------------------|
| Renderer touch / clic droit | `session.js` handlers | **Identique** | Non |
| IPC | `videoAPI.sendInput` | **Identique** | Non |
| Résolution serial | `getSessionAdbSerial()` (cache session) | **Identique** — doit donner `ip:port` si lancé WiFi | Non (même code) |
| Type A touch | scrcpy control **ou** `AdbInputController` | Idem | Non |
| Type B touch | `sendTypeBInputViaHubAdb` si `displayId` **ou** `routeInputToSession` | Idem | Non |
| Type B **key** (BACK) | **`routeInputToSession` uniquement** — utilise `session.serial` du `NewInstanceManager`, **pas** `resolvedDeviceId` | Idem | Non |

**Écart serial potentiel (Type B clés) :**

- `main.js` résout `resolvedDeviceId` (WiFi `ip:port`) **avant** le bloc Type B.
- Pour `type === "key"`, **`sendTypeBInputViaHubAdb` n'est jamais appelé** (`preferHubAdbTouch` = touch/scroll seulement).
- `new-instance-manager.routeInputToSession` injecte via `session.serial` figé au lancement + `AdbInputController(this.adbPath, session.serial)`.

→ Si session lancée en WiFi, `session.serial` = `ip:port` : **OK**.  
→ Si session USB puis bascule transport sans relance : **serial stale** — casserait **toutes** les entrées, pas seulement long press / BACK.

**Verdict point 1 :** pas de branche `if (wifi)` dédiée. Un mauvais serial expliquerait un échec global, pas ciblé. **Hypothèse secondaire** : décalage `resolvedDeviceId` (touch hub-adb) vs `session.serial` (clés scrcpy) si relance cross-transport — à vérifier en logs.

**Logs à comparer WiFi vs USB :**

```text
# Type B clic droit — attendu :
[Input] Type B session=<id> device=<serial> type=key key=Back path=scrcpy-key
# ou
[Input] Type B session=<id> device=<serial> type=key key=Back path=adb

# Type A / instance clic long (après micro-mouvement) :
[Input] device=<serial> session=<id> type=touch action=down ...
[Input] device=<serial> session=<id> type=touch action=up ...
```

Si **aucun log** au clic droit → événement `contextmenu` pas déclenché ou handler bloqué côté renderer.  
Si log `path=scrcpy-key` sans effet device → injection scrcpy ne cible pas le **display virtuel** Type B.

---

### 2. Clic long — timing / détection

**Pas de handler « long press » dédié** dans le Hub. Le menu « Infos sur l'application » est le **long press Android natif** (launcher / icône), qui exige sur le device :

1. `ACTION_DOWN`  
2. maintien ~400–500 ms  
3. `ACTION_UP` (ou maintien continu)

**Comportement actuel `session.js` (`initTypeAInputHandlers` / Type B identique) :**

| Gesture | IPC envoyé |
|---------|------------|
| Clic court **sans** bouger la souris | `pointerdown` → rien → `pointerup` → **`action=tap`** (`scrcpy.sendTap` = down+up instantané) |
| Clic avec **micro-mouvement** (≥2 px stream) | 1er `pointermove` → **`action=down`** → … maintien … → `pointerup` → **`action=up`** |

→ **Clic long immobile = tap court** : Android ne peut pas afficher « Infos app ».  
→ **Clic long avec léger mouvement** : séquence down/hold/up via **scrcpy** (ou fallback ADB) — peut fonctionner.

**WiFi / latence :**

- Le maintien réel est côté **horloge locale** (entre down et up), pas entre l'envoi réseau des paquets — la latence WiFi **retarde** down/up mais ne raccourcit pas le maintien perçu par Android si les paquets arrivent dans l'ordre.
- Correctifs récents **coalescence des `move`** + `isSyntheticLayoutPointerMove` (ignore `movementX/Y === 0` souris) : peuvent **empêcher** le premier `pointermove` synthétique (layout canvas / letterboxing) de déclencher `action=down` — utilisateur reste sur le chemin **tap** uniquement.

**`preferAdbTouch` (`main.js` ~1311)** — si `controlFromFallback && hasAudio` :

- Touch **contourné** vers `AdbInputController` au lieu de scrcpy.
- `AdbInputController.sendTouch("down")` = **no-op device** (état local seulement) ; seul `up` envoie `input tap` ou `swipe 150ms`.
- **Long press impossible** sur ce chemin, quel que soit le transport.

WiFi peut basculer plus souvent en `controlFromFallback` (socket contrôle scrcpy dégradé) — **corrélé WiFi**, pas une branche code WiFi.

**Verdict point 2 :** le bug « USB OK / WiFi KO » est **compatible** avec : (A) micro-mouvement habituel sur USB + chemin scrcpy stable ; (B) WiFi → `preferAdbTouch` ou moindre jitter layout → reste sur `tap` ou chemin ADB sans maintien. **Pas un seuil de durée explicite** dans le code — c'est l'absence de `down` au `pointerdown` qui est structurelle.

---

### 3. Clic droit → BACK — dépendance résolution / orientation

**Handler :** `attachRightClickBackHandler` → `contextmenu` → `sendInput({ type: "key", key: "Back" })` (`session.js`).

| Session | `deviceId` dans payload | Routage BACK |
|---------|-------------------------|--------------|
| **Type A** | Oui (`ensureDeviceId()`) | `main.js` → scrcpy `sendKeyCode` puis fallback `AdbInputController.sendKey` |
| **Type B** | **Non** | `routeInputToSession` → scrcpy `sendKeyCode` **ou** `controller.sendKey` avec `setDisplayId(displayId)` si display virtuel |

**Orientation / résolution :** BACK ne dépend **pas** des coords stream. Pas de mapping orientation pour les touches.

**Dépendance display Type B :**

- Scrcpy `sendKeyCode` = injection **globale** (pas de `-d displayId`).
- Fallback ADB `input -d <displayId> keyevent 4` = **cible le display virtuel**.

Si WiFi garde `hasLiveControl=true` et scrcpy-key « réussit » côté socket mais n'affecte **pas** l'app sur le display virtuel → **BACK silencieux** ; le fallback ADB avec `-d` n'est **jamais** tenté.

**Verdict point 3 :** pas de bug orientation/résolution. **Suspect principal Type B** : priorité scrcpy-key sans `displayId` sur display virtuel ; USB peut masquer le bug si le tunnel contrôle est plus fiable ou si l'utilisateur teste un contexte display 0.

---

### 4. Logs / échec silencieux

| Action | Log attendu (main) | Échec silencieux possible |
|--------|-------------------|---------------------------|
| Clic droit Type B | `[Input] Type B … type=key key=Back path=scrcpy-key` ou `path=adb` | scrcpy-key OK socket mais pas d'effet sur virtual display |
| Clic long (avec move) | `[Input] … action=down` puis `action=up` (délai ≥500 ms entre les deux côté utilisateur) | `action=tap` seul → long press impossible |
| Clic long (sans move) | `[Input] … action=tap` uniquement | **Normal** — pas un long press Android |
| Résolution serial | `device=192.168.x.x:5555` dans les logs | `device=<usb-serial>` sur session WiFi = serial stale |

**Procédure utilisateur :**

1. Terminal `npm start`, session WiFi Type B, clic droit → noter la ligne `[Input] Type B …`.
2. Session WiFi Type A (miroir launcher), clic long 1 s **sans bouger** puis **avec** léger glissement → comparer `tap` vs `down`/`up`.
3. Répéter en USB.

---

### Synthèse causes probables

| Bug | Priorité | Cause probable | Zone correction | LOCK ? |
|-----|----------|----------------|-----------------|--------|
| **Clic long WiFi** | **P0** | Pas de `down` au `pointerdown` ; maintien immobile → `tap` | `session.js` : envoyer `down` au press + `up` au release ; timer long-press optionnel | **Oui** — gestion input renderer |
| **Clic long WiFi** | **P1** | `preferAdbTouch` force ADB où `down` = no-op | `main.js` : ne pas bypass scrcpy pour touch si seul fallback audio ; ou `adb-input-controller.js` : `down` → `input swipe x y x y <durée>` | main/adb-input : **non** ; scrcpy-socket : **oui** |
| **Clic long WiFi** | **P2** | `isSyntheticLayoutPointerMove` bloque le move qui déclenchait `down` | `session.js` | **Oui** |
| **BACK Type B WiFi** | **P0** | Clés Type B via scrcpy global, pas `input -d displayId` | `main.js` : inclure `type==="key"` dans `sendTypeBInputViaHubAdb` quand `displayId` défini | **Non** (amont) |
| **BACK Type B WiFi** | **P1** | `routeInputToSession` utilise `session.serial` non résolu | `main.js` : passer serial résolu à Type B keys (sans modifier `new-instance-manager` si routage entièrement dans main) | **new-instance-manager** = LOCK si changement interne requis |

---

### Correctifs proposés (après validation)

| # | Fichier | Changement | Validation |
|---|---------|------------|--------------|
| **F1** | `main.js` | `preferHubAdbInput` : touch **+ key** (+ scroll) → `sendTypeBInputViaHubAdb` si `displayId` Type B | Amont — OK direct |
| **F2** | `session.js` | `pointerdown` → queue `down` ; `pointerup` → `up` ; tap si durée < seuil sans move | **LOCK input** — attendre OK |
| **F3** | `adb-input-controller.js` | `sendTouch("down")` envoie maintien (`swipe` même point, durée longue) ou swipe long press | Hors LOCK scrcpy |
| **F4** | `main.js` | Revoir `preferAdbTouch` (ne pas forcer ADB touch quand contrôle scrcpy vivant) | Amont — OK direct |

**Fichiers LOCK non proposés en première intention :** `scrcpy-socket.js`, `createSession()`, `new-instance-manager.js` (sauf si F1 insuffisant et routage clé doit changer à l'intérieur).

---

## FIX — Flux vidéo à l'envers (orientation) USB/WiFi (2026-07-05)

**Statut : ✅ LOCK validé utilisateur.**

### Symptôme

Image mirroring à l'envers ou orientation incorrecte (USB et WiFi).

### Causes

| # | Cause | Fichier |
|---|--------|---------|
| O1 | Verrous `@90` / `@270` inversés vs orientation naturelle | `stream-params.js` |
| O2 | `wm size` lisait parfois `Override size` au lieu de `Physical size` | `device-orientation-manager.js` |
| O3 | Ancien `captureOrientationLock` conservé au redémarrage flux | `main.js` |
| O4 | Rotation canvas +90° sans compenser le verrou scrcpy serveur | `session.js` |

### Correctifs

| Fichier | Changement | LOCK ? |
|---------|------------|--------|
| `stream-params.js` | Inversion `@90`↔`@270` ; défaut portrait si dims absentes | Non |
| `device-orientation-manager.js` | `Physical size` prioritaire | Non |
| `main.js` | Recalcul verrou à chaque `startVideoStreamLogic` | Non |
| `session.js` | Rotation canvas compensée (`captureRotation`) | Non |
| `adb-input-controller.js` | Remap tactile selon `captureRotation` | Non |
| `scrcpy-socket.js` | Fallback `resolveCaptureOrientationLock` + `EventEmitter` | **Oui** |

**Zones LOCK non touchées :** `new-instance-manager.js`.

---

## BUG — Bouton orientation portrait incorrect en WiFi (2026-07-05)

**Statut : ✅ corrigé (amont, hors LOCK).**

### 1. Chaîne du bouton orientation

```
OrientationToggle.js
  → sessionAPI.toggleOrientation(sessionId)
  → ipc session:toggleOrientation
  → streamParamsManager.toggleOrientation()
  → setOrientation(sessionId, "portrait"|"landscape")
       ├─ _resolveDeviceDimensions(entry)     → wm size (Physical size)
       ├─ applyPhysicalOrientation(deviceId)  → adb shell user_rotation + cmd window
       ├─ setSessionCaptureOrientation()      → entry + IPC session:orientation-changed
       └─ PAS de redémarrage flux scrcpy
```

**Renderer (affichage seul) :** `session:orientation-changed` → `portraitDisplayBySession` → `drawVideoFrame` rotation canvas si flux encore paysage.

**Pas de flag scrcpy au toggle** — le verrou `capture_orientation` du flux reste celui du démarrage.

### 2. USB vs WiFi — même code ?

| Étape | USB | WiFi | Branche `if (wifi)` ? |
|-------|-----|------|----------------------|
| IPC toggle | Identique | Identique | ❌ Non |
| `applyPhysicalOrientation` | `adb -s <serial> shell settings put system user_rotation N` | Idem (`ip:port` quoté) | ❌ Non |
| `resolveUserRotation` | `f(orientation, Physical wm size)` | Idem | ❌ Non |
| Rotation canvas client | `session.js` si flux paysage | Idem | ❌ Non |

**Différences observées (pas de branche transport) :**

| # | Écart | Impact WiFi |
|---|--------|-------------|
| W1 | `setOrientation` appelle `applyPhysicalOrientation(entry.deviceId)` **sans** `resolveEffectiveAdbSerial` + `stableDeviceId` (contrairement à `session:close`) | Rotation physique peut **échouer** si serial session obsolète |
| W2 | Latence ADB WiFi → rotation physique lente ; flux reste paysage plus longtemps | Canvas client utilisé plus longtemps |
| W3 | `setOrientation` conserve `captureRotation=270` (verrou stream paysage) et le repousse à la vue session | Voir cause P1 ci-dessous |

### 3. Lecture rotation / dims avant application

| Donnée | Utilisée pour calcul cible ? | Source |
|--------|------------------------------|--------|
| `user_rotation` actuel | ❌ Non (sauvegarde restore uniquement) | `settings get system user_rotation` |
| `wm size` Physical | ✅ Oui — `naturalLandscape` | `device-orientation-manager.getDeviceDimensions` |
| Dims absentes | Défaut portrait (`naturalLandscape=false`) | `resolveUserRotation` |

**WiFi :** si `wm size` timeout → dims null → défaut portrait (cohérent téléphone). Pas de lecture `user_rotation` avant calcul — **pas de cause directe WiFi** sauf échec fetch dims (même symptôme USB).

### 4. Lien avec bug flux vidéo à l'envers

| Aspect | Même cause racine ? | Détail |
|--------|---------------------|--------|
| Verrous `@90`/`@270` au stream start | **Partiellement** | Corrigé (LOCK validé) — concerne affichage **paysage initial** |
| Bouton portrait WiFi | **Cause distincte mais régression liée** | Fix vidéo a ajouté `resolvePortraitCanvasRotation(captureRotation)` + conservation `liveRotation=270` au toggle |

**Cause racine bouton portrait (P1) :** au toggle sans redémarrage flux :

1. Flux scrcpy garde `captureRotation=270` (verrou paysage au démarrage).
2. `setOrientation` repousse ce `270` à la vue session.
3. `resolvePortraitCanvasRotation` calcule `(90−270) mod 360 = 180°` → **image à l'envers**.
4. Sur **USB**, la rotation physique ADB réussit vite → flux passe en portrait → branche sans rotation canvas → **semble OK**.
5. Sur **WiFi**, rotation physique plus lente ou échoue (W1) → flux reste paysage → rotation canvas 180° → **incorrect**.

**Verdict :** pas la même cause que O1–O4 (verrous stream start), mais **effet de bord du fix vidéo** + **résolution serial incomplète au toggle** (W1).

### 5. Correctifs prévus (amont — hors LOCK)

| # | Fichier | Changement |
|---|---------|------------|
| F1 | `stream-params-manager.js` | `resolveEffectiveAdbSerial` avant `applyPhysicalOrientation` |
| F2 | `main.js` | `applyPhysicalOrientation` : résolution avec `stableDeviceId` |
| F3 | `session.js` | Rotation canvas portrait toggle : **+90° fixe** (pas de compensation `captureRotation` serveur) |
| F4 | `browserViewManager.js` | Toggle orientation : met à jour `captureOrientation` sans repousser `captureRotation` au canvas |
| F5 | `stream-params-manager.js` | Délai post-rotation plus long si serial WiFi (`ip:port`) |

**Zones LOCK :** aucune modification requise (`scrcpy-socket.js`, `new-instance-manager.js` intacts).

---

## BUG — Input continu en mode portrait WiFi/USB (2026-07-05)

**Statut : ✅ corrigé (amont `session.js`, hors LOCK).**

### 1. Reproduction attendue (USB vs WiFi × orientation)

| Scénario | Code identique ? | Symptôme attendu si cause portrait |
|----------|------------------|-------------------------------------|
| Paysage USB | Oui | Stable (pas de remap canvas) |
| Paysage WiFi | Oui | Stable |
| **Portrait USB** | Oui | Parfois OK (rotation physique rapide → flux portrait, pas de remap) |
| **Portrait WiFi** | Oui | **Plus visible** — flux reste paysage plus longtemps → remap actif |

**Verdict :** lié à **l'orientation portrait** (remap + layout canvas), **pas au transport** en soi. WiFi amplifie via latence rotation physique ADB.

### 2. Recalcul coords orientation → boucle input ?

| Mécanisme | Boucle ? | Détail |
|-----------|----------|--------|
| `mapDisplayCoordsToStream` | ⚠️ **Oui (indirect)** | Appelé à chaque `move` ; si `portraitInputRemap` **oscille** frame à frame (flux paysage↔portrait), les coords mappées **sautent** → rafale `action=move` |
| `drawVideoFrame` | ⚠️ **Oui** | `setPortraitInputRemap(true/false)` **à chaque frame** selon `landscapeFrame` |
| `syncPortraitLayout` | ⚠️ **Oui** | Appelé **à chaque frame** (~60/s) ; `resetZoom()` mutait le transform CSS → layout sous curseur → `pointermove` fantômes si drag actif |

**Pas une boucle orientation→IPC→orientation**, mais une **boucle vidéo→layout→coords→move**.

### 3. Listener / polling orientation → input ?

| Source | Envoie touch ? |
|--------|----------------|
| `session:orientation-changed` | ❌ Non — met à jour `portraitDisplay` uniquement |
| `setInputControllerOrientation` (main) | ❌ Non — métadonnée contrôleur ADB fallback |
| `setInterval` + sendInput | ❌ Aucun |

### 4. Logs attendus pendant le bug

Sans toucher la souris, si drift device :
- **Rafale `[Input] action=move`** → généré par le **renderer** (drag coincé ou coords qui sautent).
- **Aucun log** → hors Hub (autre client scrcpy).

Avec drag actif en portrait interim : `orientation=landscape` + `stream=HxW` (dims permutées) dans les logs.

### 5. Lien bug flux vidéo / orientation précédent

| | |
|---|---|
| **Même cause racine ?** | **Non directement** — fixes vidéo (@90/@270, canvas +90° toggle) sont **amont validés**. |
| **Effet de bord** | Le remap portrait (`mapDisplayCoordsToStream`) et `syncPortraitLayout` par frame **coexistent** avec le toggle portrait ; la **désynchronisation flux paysage / UI portrait** provoque le drift. |

### 6. Correctifs prévus (amont — `session.js` uniquement)

| # | Changement |
|---|------------|
| F1 | `syncPortraitLayout` : appel uniquement si état layout change ; `resetZoom` seulement au toggle orientation |
| F2 | Hystérésis `portraitInputRemap` (éviter oscillation flux paysage/portrait) |
| F3 | Seuil `move` basé sur coords **mappées** (post-remap) |
| F4 | `pointerleave` / `lostpointercapture` / `blur` → force fin de drag |

**Zones LOCK :** `adb-input-controller.js`, `scrcpy-socket.js`, `new-instance-manager.js` — **non touchés**.

---

## BUG CRITIQUE — Input cassé global + orientation Type B (2026-07-05)

**Statut : ✅ corrigé v2 (2026-07-05).**

### 4. Correctifs appliqués (v1 + v2)

| # | Fichier | Changement |
|---|---------|------------|
| F1 | `session.js` | `isOrientationManagedSession()` — orientation/remap/rotation canvas **Type A only** |
| F2 | `session.js` | Type B bootstrap : pas d'`initSessionDisplayOrientation`, `portraitDisplay=0` |
| F3 | `session.js` | **v2** — handlers pointer simplifiés ; retrait `blur`/`pointerleave`/`lostpointercapture`/`forceEndPointerDrag` |
| F4 | `session.js` | **v2** — `activateSession` uniquement si session inactive (évite blur au clic) |
| F5 | `session.js` | **v2** — `drawVideoFrame` : branche Type B directe (pas de rotation/layout portrait) |
| F6 | `stream-params.js` | **v2** — `sanitizeTypeBScrcpyOptions()` |
| F7 | `stream-params-manager.js` | Type B no-op orientation ; sanitize avant `restartWithStreamOptions` + purge `session.streamOptions` |
| F8 | `new-instance-ipc.js` | **v2** — sanitize `streamOptions` avant `start` et après démarrage |
| F9 | `main.js` | **v2** — `applyCaptureOrientationToOptions` uniquement si Type A |
| F10 | `browserViewManager.js` | Type B : `captureOrientation` forcé paysage |
| F11 | `OrientationToggle.js` | Désactivé si session active Type B |

**Cause input persistante (v2) :** `window blur` déclenché par `activateSession()` à chaque `pointerdown` annulait le drag.  
**Cause orientation Type B persistante (v2) :** `mergeTypeBScrcpyOptions` (LOCK) réinjectait `captureOrientationLock` depuis `session.streamOptions` stale → purge amont via `sanitizeTypeBScrcpyOptions`.

### 4bis. Correctifs v1 (historique)

| # | Fichier / fonction | Changement | Impact |
|---|-------------------|------------|--------|
| **R1** | `session.js` — `pointerleave` + `lostpointercapture` (fix input continu portrait) | Fin de drag forcée au resize canvas / perte capture | **Input cassé global** — clic/drag annulés dès le 1er frame vidéo |
| **R2** | `session.js` — `mapDisplayCoordsToStream` sans garde type | Remap portrait appliqué à **Type B** si `portraitDisplay` actif | Coords Type B incorrectes |
| **R3** | `session.js` — `drawVideoFrame` + `initSessionDisplayOrientation` Type B | Rotation canvas + remap sur virtual display | Orientation / input Type B cassés |
| **R4** | `stream-params-manager.js` — `_buildScrcpyOptions` / `setOrientation` | `applyCaptureOrientationToOptions` + rotation physique ADB sur **Type B** | Verrous scrcpy + `user_rotation` sur display virtuel |
| **R5** | `OrientationToggle.js` | Toggle actif sur session Type B active | Portrait forcé sur Type B par erreur |

**Cause racine input global : R1** (guards pointer trop agressifs).  
**Cause racine orientation Type B : R2–R5** (logique orientation non isolée à Type A).

**Pas dans LOCK** — aucune modification `scrcpy-socket.js` / `new-instance-manager.js` / `adb-input-controller.js` requise.

### 2. USB vs WiFi / portrait vs paysage

| Combinaison | Cassé par | Mécanisme |
|-------------|-----------|-----------|
| Type A paysage USB/WiFi | R1 | `lostpointercapture` au resize canvas |
| Type A portrait USB/WiFi | R1 + remap | Idem + coords portrait |
| Type B paysage USB/WiFi | R1 + R2–R4 | Guards + orientation sur B |
| Type B « portrait » | R3–R5 | Toggle / capture lock sur virtual display |

**Verdict :** pas lié au transport — **régression code orientation/input partagé**.

### 3. Lien bugs orientation précédents

| Bug précédent | Lien |
|---------------|------|
| Flux vidéo à l'envers | Verrous `@90`/`@270` — **Type A stream start uniquement** ; ne doit pas toucher B |
| Bouton portrait WiFi | `setOrientation` / canvas rotation — **doit rester Type A only** |
| Input continu portrait | Fix R1 (pointerleave) — **a cassé tout l'input** → retiré pointerleave/lostpointercapture |

### 4. Correctifs appliqués

| # | Fichier | Changement |
|---|---------|------------|
| F1 | `session.js` | `isOrientationManagedSession()` — orientation/remap/rotation canvas **Type A only** |
| F2 | `session.js` | Type B bootstrap : pas d'`initSessionDisplayOrientation`, `portraitDisplay=0` |
| F3 | `session.js` | Retrait `pointerleave` / `lostpointercapture` (garde `blur` uniquement) |
| F4 | `session.js` | Type B input : coords directes (pas de `mapDisplayCoordsToStream`) |
| F5 | `stream-params-manager.js` | Type B : `_buildScrcpyOptions` sans orientation/lock ; `setOrientation`/`toggle` no-op |
| F6 | `browserViewManager.js` | Type B : `captureOrientation` forcé paysage |
| F7 | `OrientationToggle.js` | Désactivé si session active Type B |

### 5. Matrice non-régression (tests utilisateur)

| Fonction | Type A USB | Type A WiFi | Type A portrait | Type B USB | Type B WiFi |
|----------|------------|-------------|-----------------|------------|-------------|
| Input clic/drag | ☐ | ☐ | ☐ | ☐ | ☐ |
| Clavier | ☐ | ☐ | ☐ | ☐ | ☐ |
| Clic long (infos app) | ☐ | ☐ | — | ☐ | ☐ |
| Clic droit → BACK | ☐ | ☐ | — | ☐ | ☐ |
| Orientation portrait/paysage | ☐ | ☐ | ☐ | **paysage fixe** | **paysage fixe** |
| Double-clic sidebar mirroring | ☐ | ☐ | — | — | — |
| Audio par fenêtre | ☐ | ☐ | ☐ | ☐ | ☐ |
| Pastille couleur temps réel | ☐ | ☐ | — | ☐ | ☐ |
| Toggle USB/WiFi + panneau Appareils | ☐ | ☐ | — | ☐ | ☐ |

---

## BUG — Renommer non synchronisé USB ↔ WiFi (2026-07-05)

**Symptôme :** appareil fusionné (même identité physique, visible en USB et WiFi) renommé depuis le panneau Appareils (section USB ou WiFi) → l'autre entrée/transport ne reflète pas le nouveau nom (sidebar, panneau, sélecteur Nouvelle instance).

**Statut : corrigé (2026-07-05).**

### 1. Stockage des noms — clés par transport vs identité stable

| Source | Fichier / module | Clé utilisée | Problème |
|--------|-----------------|--------------|----------|
| Noms personnalisés | `custom-names.json` via `CustomNamesManager` | Paramètre `serial` passé à `setDeviceCustomName()` | **Pas de résolution stable** : une entrée peut exister sous `e176518f` (USB) **et** `192.168.1.10:5555` (WiFi) pour le même appareil |
| Noms WiFi config | `wifi-devices.json` via `WifiDevicesManager.rename()` | `deviceId` stable | Mis à jour **seulement** si `getByDeviceId(serial)` réussit avec le bon id |
| Affichage unifié | `buildUnifiedEntry()` | `wifiConfig?.name \|\| baseDevice.name` | Source parallèle avant overlay `applyDeviceNames` |
| Lecture noms | `applyDeviceNames()` | `device.deviceId \|\| device.serial` | **Une seule clé** — ignore alias transport (`usbSerial`, `wifiSerial`, `adbTarget`, `ip:port`) |

**Preuve disque** (session 2026-07-05, `custom-names.json`) : clés dupliquées `e176518f` + `192.168.1.10:5555` pour le même Tab 5 — renommer depuis une entrée écrit sous une clé, l'autre transport lit l'autre clé.

### 2. Fusion identité — utilisée à l'affichage, pas au Renommer

| Zone | Utilise `deviceId` stable ? | Utilise `resolveStableDeviceIdFromTransport` ? |
|------|---------------------------|-----------------------------------------------|
| Sidebar / `listUnifiedDevices` | ✅ `mergeByDeviceId` | ✅ (résolution serial ADB) |
| Panneau Appareils (UI) | ✅ `data-device-id` = `entry.deviceId` | ❌ |
| `performDeviceRename` (`namesHandlers.js`) | ❌ écrit sous `payload.serial` tel quel | ❌ |
| `applyDeviceNames` | Partiel (`deviceId \|\| serial`) | ❌ pas de lookup multi-clés |

Le panneau et la sidebar **passent** `deviceId` stable au dialogue (`DevicesPanel.js`, `DevicePanel.js`). Mais :
- les **anciennes clés** `ip:port` dans `custom-names.json` ne sont pas migrées ;
- `performDeviceRename` ne **nettoie pas** les alias ni ne synchronise `wifi-devices.json` si le `serial` reçu est un transport WiFi non résolu ;
- `applyDeviceNames` sur la ligne WiFi (`deviceId` = stable) ne trouve pas un nom stocké sous `ip:port`.

### 3. Correctif prévu

1. **`CustomNamesManager`** — lookup multi-clés (`deviceId`, `serial`, `usbSerial`, `wifiSerial`, `adbTarget`) ; écriture **unique** sous `deviceId` stable ; purge des alias à la lecture/écriture.
2. **`namesHandlers.js`** — `performDeviceRename` / `resetDevice` : `resolveStableDeviceIdFromTransport()` + collecte alias + `wifiDevicesManager.rename(stableId)` systématique.
3. Pas de changement renderer requis (UI envoie déjà `deviceId`).

**Fichiers modifiés :** `custom-names-manager.js`, `namesHandlers.js`.

**Hors scope :** fichiers INPUT LOCK, `scrcpy-socket.js`, `new-instance-manager.js`.

---

## BUG — Renommer fenêtres/onglets non synchronisé USB ↔ WiFi (2026-07-05)

**Symptôme :** appareil fusionné — renommer l'onglet/fenêtre d'une session (miroir Type A ou instance Type B) depuis un transport (USB ou WiFi) → une nouvelle session sur l'autre transport garde l'ancien nom d'onglet.

**Statut : corrigé (2026-07-05).**

### 1. Stockage — clé session par transport vs identité stable

| Source | Fichier | Clé session | Problème |
|--------|---------|-------------|----------|
| Noms onglets/fenêtres | `custom-names.json` → `sessions{}` | `mirror:${deviceId}` (Type A) ou `instance:${deviceId}:pkg:uid` (Type B) | `deviceId` dans la clé = **serial ADB transport** (`e176518f` USB vs `192.168.1.10:5555` WiFi) — **deux clés pour le même appareil** |
| Métadonnée session live | `browserViewManager` entry | `deviceId` = serial ADB ; `stableDeviceId` = ro.serialno (déjà présent) | `buildSessionKey()` **ignore** `stableDeviceId` |
| Preuve disque | `custom-names.json` sessions | `mirror:e176518f` + `mirror:192.168.1.10:5555` | Même symptôme que noms appareils (documenté § Renommer panneau) |

**Type A :** `buildSessionKey` → `mirror:${entry.deviceId}` où `entry.deviceId` = serial effectif scrcpy/ADB (souvent `ip:port` en WiFi).

**Type B :** `instance:${entry.deviceId}:${packageName}:${userId}` — même pollution.

### 2. Même source de vérité que panneau Appareils ?

| Fonction | Module | Utilise `CustomNamesManager` ? | Résout `stableDeviceId` ? |
|----------|--------|-------------------------------|---------------------------|
| Renommer appareil (panneau) | `namesHandlers.performDeviceRename` | ✅ | ✅ (corrigé 2026-07-05) |
| Renommer onglet/fenêtre | `namesHandlers.performSessionRename` | ✅ | ❌ — `buildSessionKey({ deviceId: entry.deviceId })` sans `stableDeviceId` |
| Affichage onglets | `applySessionNames` / `session:list` | ✅ | ❌ — clé dérivée du transport |
| Enregistrement session | `session:registerView` → `resolveSessionLabel` | ✅ | ⚠️ passe `deviceId` transport seulement (mais entry a `stableDeviceId`) |

**Conclusion :** même fichier `custom-names.json`, **logique de clé non alignée** avec le fix appareils — pas de lookup/consolidation multi-clés pour les sessions.

### 3. Fichiers LOCK — impact

| Fichier | Touché ? | Action |
|---------|----------|--------|
| `sessionHandlers.js` | ❌ non requis | `resolveSessionLabel` corrigé via résolution sync dans `CustomNamesManager` |
| `new-instance-manager.js` | ❌ | — |
| `scrcpy-socket.js` | ❌ | — |
| Input LOCK (`main.js`, `session.js`, `adb-input-controller`) | ❌ | — |

**Correctif :** couche noms uniquement — `custom-names-manager.js` + `namesHandlers.js` + `contextMenuHandlers.js` (reset session).

1. `buildSessionKey` → `stableDeviceId || resolveSessionStableDeviceId(entry)` pour la clé canonique.
2. Alias transport (`mirror:ip:port`) → consolidation/migration vers clé stable (comme appareils).
3. `performSessionRename` / reset : résolution async si `stableDeviceId` absent + sync labels sur **toutes** les sessions ouvertes partageant la même clé stable.

---

## ⚠️ MULTI-APPAREILS & POLLING DEVICES — LOCK (2026-07-08)

> Validé commit `973a28a`. Ne pas réintroduire les régressions corrigées (liste vide, même nom d'onglet, input perdu à 2 devices).

### Fichiers concernés

| Fichier | Rôle LOCK |
|---------|-----------|
| `src/renderer/devices.js` | `pollDeviceList()` — **ne jamais** réassigner `window.refreshDevices` à une fn qui s'appelle elle-même via le nom global `refreshDevices` |
| `src/renderer/new-session.js` | Labels Type B : `Appareil — App` ; `stableDeviceId` au launch ; `fetchConnectedDevices({ force: true })` à l'ouverture panneau |
| `src/main/main.js` | **Pas** de `invalidateSessionAdbSerialCache()` dans `get-devices` (poll 8 s) — invalidation uniquement à la fermeture session |
| `src/main/ipc/sessionHandlers.js` | `stableDeviceId` dans `resolveSessionLabel` et `session:getInputContext` |
| `src/renderer/session/session.js` | Type B : **pas** d'`activateSession` au bootstrap (évite vol de focus input) |

### Comportements validés

- 2 appareils USB connectés : liste sidebar + panneau Nouvelle instance OK
- Onglets Type B distincts : `Xiaomi tab 5 — App` / `Xiaomi Tab 6 — App`
- Input : clic onglet cible avant interaction ; cache serial stable entre polls

Référence : `AI_CONTEXT.md` § Multi-appareils & polling.

---

## LOCALISATION — Switch USB/WiFi (2026-07-12)

**Statut : étape 1 diagnostic — avant overlay.**

| Élément | Détail |
|---------|--------|
| **UI** | Toggle checkbox `.sidebar-wifi-toggle-input` dans `src/renderer/sidebar/DevicePanel.js` (sidebar « Appareils connectés »), **pas** `devices-panel/DevicesPanel.js` |
| **Handler clic** | `change` sur l'input → `handleWifiToggle(device, toggleInput.checked, toggleInput)` (~L177-181) |
| **IPC** | `window.wifiAPI.toggle({ deviceId, enabled, usbSerial, name })` → preload `wifi:toggle` → `src/main/ipc/wifiHandlers.js` (~L129) |
| **Fin du switch (renderer)** | Réponse directe de `ipcRenderer.invoke` : `result.success` / `result.error` ; pas d'event séparé ni poll. Succès → toasts + `window.refreshDevices()`. Échec → toast erreur + reset checkbox |
| **LOCK** | Aucun fichier LOCK concerné |

---

## FIX — Composant overlay chargement hub (2026-07-12)

**Commit étape 2** — `src/renderer/hub-loading-overlay.js` + styles `style.css` + script `index.html`.

- API : `showHubLoadingOverlay`, `hideHubLoadingOverlay`, `showHubLoadingOverlayError`.
- Centré, `pointer-events: none`, spinner CSS, état erreur auto-fermeture.

---

## FIX — Overlay branché sur switch USB/WiFi (2026-07-12)

**Commit étape 3** — `DevicePanel.js` + i18n `devicePanel.switchInProgress` / `switchFailed`.

- Affichage au clic toggle ; masquage au succès ; erreur + auto-fermeture 2,8 s ; timeout client 120 s.
- Type A / LOCK non touchés.

---

## DIAGNOSTIC — Que garantit `success` de `wifi:toggle` ? (2026-07-12)

**Statut : diagnostic uniquement — avant patch overlay transport réel.**

### 1. Ce que garantit réellement `success: true`

| Branche | Actions await avant `success` | Garantie réelle |
|---------|------------------------------|-----------------|
| **WiFi ON — 1ère config** (`setupFirstConnection`) | `fetchWlan0Ip` → `adb tcpip` → `adb connect` + **`get-state === device`** (timeout 7 s) → persistance config `wifiEnabled: true` → `refreshDeviceList()` | **ADB** : serial WiFi `ip:port` vu en état `device` au moment du connect. **Pas** de relecture `listUnifiedDevices` avant le retour IPC |
| **WiFi ON — config existante** (`reconnectSaved`) | `setWifiEnabled(true)` → (si USB dispo : re-fetch IP + `tcpip`) → `connect()` + **`get-state === device`** → `refreshDeviceList()` | Idem : état ADB `device` sur le serial WiFi à la fin du handler |
| **WiFi OFF** | `setWifiEnabled(false)` → `adb disconnect` (erreurs **avalées**, timeout 5 s) → `refreshDeviceList()` | **Faible** : commande disconnect envoyée ; **aucune** attente que le serial WiFi disparaisse de `adb devices`, ni que `transport` redevienne `usb` |

`refreshDeviceList()` dans le handler = `requestRendererDeviceRefresh()` uniquement (event `devices:refresh-request`), **sans** `await` de sync UI ni invalidation explicite du cache registry côté main.

### 2. Champ / source de vérité transport UI

| Champ | Rôle | Source |
|-------|------|--------|
| `transport` | `"usb"` \| `"wifi"` effectif affiché | `device-registry.resolveEffectiveTransport()` : `wifiEnabled` (config persistée) + présence online USB/WiFi dans `adb devices` (`status === green`) |
| `serial` | Serial ADB actif pour ce transport | Même résolution (`group.wifiSerial` ou `group.usbSerial`) |
| `wifiActive` | Toggle sidebar coché | `wifiEnabled && transport === "wifi" && connected` |
| `wifiEnabled` | Préférence persistée | `wifi-devices-manager` |
| `connected` / `status` | Online | `adb devices -l` via `getRawAdbDevices` + enrichissement optionnel |

Chaîne renderer : `get-devices` → `listDevicesForUI()` → `listUnifiedDevices()` (cache TTL **10 s**, pas de `forceFresh` depuis le renderer).

### 3. Délai typique commande acceptée → transport visible UI

| Mécanisme | Délai |
|-----------|-------|
| Réponse IPC `wifi:toggle` | Fin des opérations ADB du handler (jusqu'à ~25 s 1ère config ; ~7 s reconnect ; quasi-immédiat WiFi OFF) |
| `refreshDevices()` post-toggle (`DevicePanel`) | `refreshDevicesForce` → `get-devices` immédiat si pas de `refreshInFlight` (debounce min **2,5 s** contourné par `force: true`) |
| Cache `listUnifiedDevices` | Peut servir une entrée **périmée jusqu'à 10 s** si `_executeListUnifiedDevices` n'est pas relancé (pas de `forceFresh` sur `get-devices`) |
| Poll normal (`devices.js`) | **12 s** ; scan complet (`force: true`) toutes les **4** itérations (~**48 s**) |
| Overlay actuel (`afe0dab`) | Masqué **avant** `await refreshDevices()` → peut disparaître **avant** que l'UI reflète le nouveau transport |

**Écart constaté** : `success` WiFi ON ≈ confirmation ADB ponctuelle ; `success` WiFi OFF ≈ commande envoyée. L'UI unifiée peut **laguer** (cache 10 s + overlay fermé trop tôt).

### 4. `refreshDevices()` réutilisable ?

- **Oui partiellement** : `window.refreshDevices` = `refreshDevicesForce` → `get-devices` → met à jour `currentDevices` + event `devices-refreshed` (sidebar `DevicePanel` écoute).
- **Limite** : pas de `forceFresh` registry ; pas de condition « transport cible atteint » ; pas d'attente dans l'overlay actuel.
- **Manque** : boucle courte post-toggle vérifiant `findDeviceById(deviceId)` jusqu'à `(enabled && transport==='wifi' && wifiActive)` ou `(!enabled && transport==='usb')`, avec timeout ~15–20 s et intervalle 500–800 ms + `forceFresh` côté main si exposé.

### 5. Proposition mécanisme (non implémenté)

**Option A (renderer, min scope)** — dans `handleWifiToggle` après IPC success :
1. Garder overlay ouvert
2. Boucle `await refreshDevicesForce()` toutes les 600 ms
3. Lire `findDeviceById(deviceId)` ; fermer overlay quand condition transport OK ou timeout → erreur
4. Exposer `get-devices({ forceFresh: true })` pour éviter cache 10 s (petit patch `main.js` + preload)

**Option B (main)** — avant `return { success: true }` dans `wifi:toggle` : `listUnifiedDevices({ forceFresh: true })` + vérif `transport` / `wifiActive` pour le `deviceId` ; retourner `transportConfirmed: true/false`.

**Recommandation** : Option A + `forceFresh` sur le poll post-toggle ; conserver `success: false` IPC inchangé pour les vrais échecs ADB.

**LOCK** : non concerné.

---

## FIX — get-devices forceFresh (2026-07-12)

**Commit étape 1** — `main.js` : `get-devices({ forceFresh: true })` → `listUnifiedDevices({ forceFresh: true })`. Poll normal inchangé (sans option).

---

## FIX — Overlay switch : poll transport réel (2026-07-12)

**Commit étape 2** — `DevicePanel.js`.

- Après `result.success` IPC : overlay maintenu ; `waitForTransportSwitch` poll `getDevices({ forceFresh: true })` toutes les 600 ms (max 18 s).
- Succès : WiFi ON → `transport==='wifi' && wifiActive` ; USB → `transport==='usb'`.
- Timeout : `showHubLoadingOverlayError` + reset toggle ; boucle `while` + `await` (pas d'intervalle résiduel).

---

## DIAGNOSTIC — I/O sync métadonnées / icônes (2026-07-12)

**Statut : diagnostic uniquement — aucune modification code.**

### Partie 1 — `app-metadata-manager.js`

**Deux instances** (même module, chemins disque partagés `app-metadata-cache.json` + `app-icons/`) :
| Instance | Process | Création |
|----------|---------|----------|
| Main | `main.js` ~L1208 | Toujours |
| Worker | `apps-worker.js` INIT ~L87 | Fork `apps-worker-bridge` |

**Prefetch typique (panneau apps)** : `app-metadata:prefetch` → worker `PREFETCH_APP_METADATA` → **`queuePrefetch` worker**. Les `writeFileSync` de flush viennent donc **du worker** en pratique.

**Main encore actif pour** :
- `app-metadata:resolve` → `resolveOne` complet (icônes incluses) — **main thread**
- `launch-history:list` → `enrichHistoryEntries` + `queuePrefetch` via `setImmediate` — **main thread** si entrées sans icône
- `getCachedEntry` (ex. `new-instance-ipc.js` L88, historique) — lectures mémoire + `existsSync` / `statSync` via `isFresh` / `isValidIconFileSize`
- `pruneStaleIconCacheEntries` au boot + maintenance cleanup — **main**
- **Fallback in-process** : même code sur main (voir Partie 3)

**Flush `writeFileSync` (~L145-161, ~L164-171)** :
- `scheduleSaveIndex` : debounce **500 ms** (`INDEX_SAVE_DEBOUNCE_MS`) — coalesce les `setCachedEntry` pendant prefetch
- `flushIndex` : appel **fin de queue** prefetch (`runQueue` ~L694) + SHUTDOWN worker
- Rafales : pendant batch 4–6 icônes parallèles, **≤ ~2 écritures/s max** (debounce) + 1 flush final ; pas de contournement massif du debounce sauf `flushIndex` / `invalidate` ponctuels
- **Estimation prefetch 32 icônes** : ~5–15 `writeFileSync` debouncés sur **30–90 s** + 1 flush final — **worker**

**Sync restants main (hors prefetch worker)** : `loadIndex` `readFileSync` (1× boot), `mkdirSync`, `existsSync`/`unlinkSync` dans `isFresh`/`invalidate`/`rejectFalsePositive` — **faible fréquence** sauf `resolveOne` / fallback.

### Partie 2 — `app-icon-extractor.js`

**Exécution** : instancié par `AppMetadataManager` → **worker** pour prefetch/liste apps normale ; **main** pour `app-metadata:resolve`, `enrichHistory` prefetch, fallback.

| Fichier | Fonction | Op. sync | Thread | Fréq. estimée |
|---------|----------|----------|--------|---------------|
| `app-icon-extractor.js` | `walkFiles` | `existsSync`, `readdirSync` | Worker (prefetch) / Main (resolve/fallback) | Par extraction APK (pull path) |
| `app-icon-extractor.js` | `walkXmlFiles` | `existsSync`, `readdirSync` | idem | idem |
| `app-icon-extractor.js` | `resolveResourceFile` | `existsSync`, `readdirSync` | idem | Adaptive icon path |
| `app-icon-extractor.js` | `findAdaptiveIconRaster` | `readFileSync` | idem | Adaptive icon path |
| `app-icon-extractor.js` | `streamExecOutToFile` | `mkdirSync`, `writeFileSync`, `existsSync`, `unlinkSync` | idem | Zip stream path (prioritaire) |
| `app-icon-extractor.js` | `pullApk` | `mkdirSync`, `existsSync`, `statSync` | idem | Fallback pull APK |
| `app-icon-extractor.js` | `extractIconFromApk` | `mkdirSync`, `rmSync`, `copyFileSync`, `unlinkSync` | idem | Si zip stream échoue |
| `app-icon-extractor.js` | `extractIcon` finally | `existsSync`, `unlinkSync` | idem | Chaque tentative |
| `app-metadata-manager.js` | `loadIndex` | `existsSync`, `readFileSync` | Main + Worker (INIT) | 1× / process |
| `app-metadata-manager.js` | `saveIndex` / `flushIndex` | `writeFileSync` | Worker (prefetch) / Main (resolve) | Debounce + fin queue |
| `app-metadata-manager.js` | `isFresh` / `hasUsableIcon` | `existsSync` + `statSync` via `isValidIconFileSize` | Main surtout | Chaque lookup cache |
| `app-metadata-manager.js` | `invalidate` / `rejectFalsePositive` | `existsSync`, `unlinkSync` | Worker + Main | Retry icône / erreur |
| `app-metadata-manager.js` | `pruneStaleIconCacheEntries` | `fs.promises` (async) | Main boot + cleanup | Rare |
| `shared/app-icon-placeholder.js` | `isValidIconFileSize` | `statSync` | Partout | Chaque vérif taille icône |

**Équivalent async existant** : `isIconFileAccessible` (~L94-102) utilise `fs.promises.access` + `stat` — modèle pour remplacer `statSync`/`existsSync` ailleurs.

**Blocage main thread** : **résolu pour le prefetch bulk** (déporté worker). **Non résolu** pour `app-metadata:resolve` (onglets sidebar), `enrichHistoryEntries` prefetch main, fallback.

### Partie 3 — Impact réel

**Bénéfice async si tout est déjà dans le worker** :
- **UI / main thread** : **aucun** pour le prefetch worker seul
- **Worker** : réduction latence perçue du worker (meilleur entrelacement messages IPC METADATA_UPDATED) ; gain modéré sur durée totale prefetch (I/O toujours séquentiel par icône)

**Fallback in-process** (`apps-worker-bridge.js` `activateFallback`, `main.js` ~L1235-1250) :
- Déclenché si : échec INIT worker, **3** crashs/restarts (`MAX_RESTART_ATTEMPTS`)
- **Usage réel estimé : rare** (worker stable en nominal) ; alors **100 %** prefetch + enrich repasse sur main avec sync I/O complet

**Proposition vérification (non implémentée)** : prioriser routage **main → worker** pour `app-metadata:resolve` et prefetch historique ; async I/O en second sur `app-icon-extractor` (gain worker perf).

### Conclusion

| Question | Réponse |
|----------|---------|
| Chantier encore pertinent ? | **Oui**, mais priorité déplacée |
| Priorité 1 | Chemins **encore sur main** : `app-metadata:resolve`, `enrichHistoryEntries` → `queuePrefetch` |
| Priorité 2 | `app-icon-extractor.js` async — accélère **worker**, pas l'UI |
| Priorité 3 | Fallback in-process (rare mais sync total main) |
| Debounce index | **Efficace** pour prefetch worker ; pas le goulot principal |

- **LOCK** : non concerné.

---

## FIX — Async cache lookup metadata (étape 1/3, 2026-07-12)

`app-metadata-manager.js` : `isFresh`, `hasUsableIcon`, `lookupCacheEntry`, `getCachedEntry` → `fs.promises` via `isIconFileAccessible`. Appelants mis à jour (`enrichApps`, `queuePrefetch`, `resolveOne`, `enrichHistoryEntries`). `new-instance-ipc.js` : `await getCachedEntry`.

---

## FIX — Async icon extraction (étape 2/3, 2026-07-12)

`app-icon-extractor.js` : `walkFiles`, `extractIconFromApk`, `streamExecOutToFile`, `pullApk` → `fs.promises`. `toIconUrl` async. Handler `app-metadata:resolve` inchangé (déjà `await resolveOne`).

---

## FIX — Async launch-history prefetch (étape 3/3, 2026-07-12)

`app-metadata-manager.js` : `enrichHistoryEntries` — `setImmediate` + `queuePrefetch` sync remplacés par `void prefetchHistoryApps(byDevice)` (async, fire-and-forget). `invalidate` / `rejectFalsePositiveCacheEntry` → `removeIconFileIfExists` (`fs.promises`). Handler `launch-history:list` inchangé (déjà `await enrichHistoryEntries`).

**Appelants vérifiés :** `launchHistoryHandlers.js` — contrat renderer intact (liste enrichie retournée avant fin prefetch). `apps-worker.js` — non modifié.

---

## FIX — Async pruneForDevice (2026-07-12)

`app-metadata-manager.js` : `pruneForDevice` → `async`, suppression icônes via `removeIconFileIfExists` (remplace `existsSync` / `unlinkSync`). Logique de purge inchangée (entrées hors `activePackageKeys` pour le `deviceId` donné).

**Appelants :** aucun dans le dépôt (`pruneForDevice` n'est invoqué nulle part actuellement) — pas d'ajustement IPC/renderer requis. Futurs appelants devront `await manager.pruneForDevice(...)`.

---

## DIAGNOSTIC — Listeners IPC sans désabonnement (2026-07-12)

**Statut : diagnostic uniquement — aucun patch code.**

Référence initiale : rapport optimisation § 6.1 (`ipcRenderer.on` dans preloads sans `removeListener`).

### Partie 1 — Inventaire preload (aucune API ne retourne de fonction de désinscription)

**Règle commune :** toutes les APIs `on*` font `ipcRenderer.on(channel, wrapper)` et **ne retournent rien** (pas de `() => ipcRenderer.removeListener(...)`).

| Preload | API exposée | Canal IPC |
|---------|-------------|-----------|
| `preload.js` | `electronAPI.onDevicesRefreshRequest` | `devices:refresh-request` |
| `preload.js` | `electronAPI.onSessionUpdate` | `session:update` |
| `preload.js` | `electronAPI.onVideoCodecMeta` | `video-codec-meta` |
| `preload.js` | `electronAPI.onVideoPacket` | `video-packet` |
| `preload.js` | `electronAPI.onVideoError` | `video-error` |
| `preload.js` | `electronAPI.onVideoStreamState` | `video-stream-state` |
| `preload.js` | `electronAPI.onNewInstanceDisplayReady` | `new-instance:display-ready` |
| `preload.js` | `electronAPI.onAppMetadataUpdated` | `app-metadata:updated` |
| `preload.js` | `electronAPI.onNewInstanceVideoCodecMeta` | `new-instance:video-codec-meta` |
| `preload.js` | `electronAPI.onNewInstanceVideoPacket` | `new-instance:video-packet` |
| `preload.js` | `electronAPI.onNewInstanceVideoError` | `new-instance:video-error` |
| `preload.js` | `electronAPI.onNewInstanceState` | `new-instance:state` |
| `preload.js` | `electronAPI.onNewInstanceScrcpyClosed` | `new-instance:scrcpy-closed` |
| `preload.js` | `electronAPI.onAudioCodecMeta` | `audio-codec-meta` |
| `preload.js` | `electronAPI.onAudioPacket` | `audio-packet` |
| `preload.js` | `electronAPI.onNewInstanceAudioCodecMeta` | `new-instance:audio-codec-meta` |
| `preload.js` | `electronAPI.onNewInstanceAudioPacket` | `new-instance:audio-packet` |
| `preload.js` | `electronAPI.onUpdateStatus` | `update:status` |
| `preload.js` | `audioAPI.onGlobalStateChanged` | `audio:global-state-changed` |
| `preload.js` | `sessionAPI.onSessionActivated` | `session:activated` |
| `preload.js` | `sessionAPI.onSessionListChanged` | `session:list-changed` |
| `preload.js` | `sessionAPI.onStreamRestarting` | `stream-restarting` |
| `preload.js` | `sessionAPI.onOrientationChanged` | `session:orientation-changed` |
| `preload.js` | `sessionAPI.onRestartStreamRequest` | `session:restart-stream-request` |
| `preload.js` | `namesAPI.onContextMenuAction` | `context-menu:action` |
| `preload.js` | `namesAPI.onUpdated` | `names:updated` |
| `preload.js` | `launchHistoryAPI.onUpdated` | `launch-history:updated` |
| `preload.js` | `deviceColorsAPI.onUpdated` | `device-colors:updated` |
| `preload.js` | `displayPresetsAPI.onUpdated` | `display-presets:updated` |
| `preload.js` | `uiPreferencesAPI.onLocaleChanged` | `ui:locale-changed` |
| `preload.js` | `duoPopupAPI.onSlotsChanged` | `duo-popup:slots-changed` |
| `preload.js` | `duoPopupAPI.onClosed` | `duo-popup:closed` |
| `preload.js` | `hubModalAPI.onClosed` | `hub-modal:closed` |
| `preload.js` | `hubModalWindowAPI.onOpen` | `hub-modal:open` |
| `sessionPreload.js` | `videoAPI.on*` (11 méthodes) | `video-*`, `new-instance:*`, `stream-restarting`, `session:orientation-changed`, `session:capture-rotation-changed`, `session:input-active`, `audio-*` |
| `sessionPreload.js` | `audioAPI.onGlobalStateChanged` | `audio:global-state-changed` |
| `duoPopupPreload.js` | `duoPopupOverlayAPI.onOpen` | `duo-popup:open` |
| `duoPopupPreload.js` | `uiPreferencesAPI.onLocaleChanged` | `ui:locale-changed` |
| `renameDialogPreload.js` | `renameDialogAPI.onOpen` | `rename-dialog:open` |
| `renameDialogPreload.js` | `uiPreferencesAPI.onLocaleChanged` | `ui:locale-changed` |
| `tooltipPreload.js` | `tooltipOverlayAPI.onUpdate` | `video-preview:update` |

**Note :** `preload.js` racine (legacy) expose aussi `onVideoCodecMeta` / `onVideoPacket` / `onVideoError` — hors chemin runtime actuel (`src/preload/preload.js` utilisé par la fenêtre principale et hub-modal).

**APIs exposées sans consommateur renderer :** `electronAPI.onSessionUpdate`, `videoAPI.onCaptureRotationChanged` (sessionPreload).

### Partie 2–3 — Consommateurs, cleanup, risque

| Canal IPC | Preload | Consommateur(s) | Cleanup existant ? | Risque |
|-----------|---------|-----------------|-------------------|--------|
| `devices:refresh-request` | `preload.js` | `devices.js` (module, 1×) | Non | **Théorique** — singleton chargement page |
| `devices:refresh-request` | `preload.js` | `DevicesPanel.js` `bindPanelRefreshListeners` | Garde `panelListenersBound` ; pas de `removeListener` à la fermeture | **Théorique** — bind 1× par contexte ; hub-modal réutilise la même overlay window |
| `session:list-changed` | `preload.js` | `Sidebar.js`, `FpsMonitor.js`, `StreamDeckBar.js`, `StreamDeckZone.js`, `ControlPanel.js` | `ControlPanel` : `__controlPanelEventsBound` ; autres : init DOMContentLoaded 1× | **Théorique** — fan-out fixe au boot (5 handlers/canal) |
| `session:activated` | `preload.js` | `Sidebar.js`, `OrientationToggle.js`, `StreamDeckZone.js`, `ControlPanel.js`, `session-audio-hub.js` | Idem guards init / flag global | **Théorique** — fan-out fixe au boot (5 handlers) |
| `stream-restarting` | `preload.js` / `sessionPreload` | `session-audio-hub.js`, `video-player.js` **factory**, `new-instance-pipeline.js` **factory**, `new-instance-pipeline` path, `Sidebar` N/A | **Aucun** sur fermeture session | **Réel** — +1 listener par `createVideoPlayer()` / `createNewInstanceVideoPipeline()` ; `closeInstance` / `closeNewInstanceSession` ne désinscrivent pas |
| `stream-restarting` | `sessionPreload` | `session/session.js` (Type A + Type B pipelines) | Contexte BrowserView détruit avec la vue | **Théorique** — 1× par BrowserView (pas cumul cross-sessions dans le même contexte) |
| `session:orientation-changed` | `preload.js` | `layout-metrics.js` | Init DOMContentLoaded 1× | **Théorique** |
| `session:orientation-changed` | `sessionPreload` | `session.js` `initSessionDisplayOrientation` + `initTypeAInputHandlers` | BrowserView lifecycle | **Théorique** — 2 handlers fixes par vue (pas remontage) |
| `session:restart-stream-request` | `preload.js` | `session-stream-bridge.js` | IIFE 1× | **Théorique** |
| `session:input-active` | `sessionPreload` | `session.js` `attachSessionInputActivation` | 1× par handlers input | **Théorique** (par BrowserView) |
| `video-codec-meta` / `video-packet` / `video-error` | `sessionPreload` | `session.js` Type A pipeline | BrowserView lifecycle | **Théorique** |
| `new-instance:video-*` / `new-instance:state` | `preload.js` + `sessionPreload` | `new-session.js` (DOMContentLoaded 1×), `session.js` Type B | Main : singleton ; BrowserView : 1× | **Théorique** sur main ; **théorique** par vue |
| `new-instance:display-ready` | `preload.js` | `new-session.js` | DOMContentLoaded 1× | **Théorique** |
| `new-instance:scrcpy-closed` | `preload.js` | `new-session.js` | DOMContentLoaded 1× | **Théorique** |
| `video-stream-state` | `preload.js` | `new-session.js` (launch pipeline debug) | DOMContentLoaded 1× | **Théorique** |
| `app-metadata:updated` | `preload.js` | `new-session.js`, `Sidebar.js` | Module / DOMContentLoaded 1× | **Théorique** — 2 abonnés intentionnels |
| `audio-codec-meta` / `audio-packet` (+ new-instance) | `preload.js` | `session-audio-hub.js` | IIFE 1× (4 handlers) | **Théorique** |
| `audio:global-state-changed` | `preload.js` | `GlobalAudioToggle.js`, `session-audio-hub.js` | Init DOMContentLoaded / IIFE 1× | **Théorique** |
| `names:updated` | `preload.js` | `rename-actions.js`, `DevicesPanel.js` (si panel ouvert) | `DevicesPanel` : garde `panelListenersBound` | **Théorique** — 2× max sur hub-modal |
| `device-colors:updated` | `preload.js` | `rename-actions.js`, `Sidebar.js`, `DevicesPanel.js` | Guards idem | **Théorique** — fan-out fixe |
| `launch-history:updated` | `preload.js` | `new-session.js` | DOMContentLoaded 1× | **Théorique** |
| `display-presets:updated` | `preload.js` | `ControlPanel.js` | `__controlPanelEventsBound` | **Théorique** |
| `context-menu:action` | `preload.js` | `rename/ContextMenu.js` | IIFE 1× | **Théorique** |
| `update:status` | `preload.js` | `update-notifier.js` | IIFE 1× | **Théorique** |
| `ui:locale-changed` | `preload.js` / satellites | `i18n/i18n.js` (`HubI18n.init`) | `ready` / `readyPromise` dedupe | **Théorique** |
| `hub-modal:closed` | `preload.js` | `app.js` | Module 1× | **Théorique** |
| `hub-modal:open` | `preload.js` | `hub-modal/hub-modal-window.js` | Overlay window créée 1× puis réutilisée (`HubModalOverlayManager._ensureWindow`) | **Théorique** |
| `duo-popup:slots-changed` / `duo-popup:closed` | `preload.js` | `StreamDeckDuoCollapse.js` | `init()` DOMContentLoaded 1× | **Théorique** |
| `duo-popup:open` | `duoPopupPreload.js` | `stream-deck/duo-popup-overlay.js` | Popup overlay window 1× | **Théorique** |
| `rename-dialog:open` | `renameDialogPreload.js` | `rename/rename-dialog-overlay.js` | Dialog overlay 1× | **Théorique** |
| `video-preview:update` | `tooltipPreload.js` | (overlay tooltip — chargement unique) | Fenêtre tooltip 1× | **Théorique** |
| `session:update` | `preload.js` | *(aucun)* | — | **N/A** — API morte |

### Cas signalés dans le rapport initial

| Composant | Verdict |
|-----------|---------|
| `DevicesPanel.bindPanelRefreshListeners` | **Pas de fuite pratique** : `panelListenersBound` empêche la réinscription ; `stopDevicesPanelLiveRefresh` ne reset pas le flag (donc pas de re-bind au reopen). Manque de `removeListener` seulement si le flag était un jour reset sans cleanup. |
| `FpsMonitor` | **Pas de fuite pratique** : `initFpsMonitor` 1× au boot ; `startFpsMonitor` idempotent. Pas de désinscription `onSessionListChanged` au `stopFpsMonitor` (interval seulement). |

### Conclusion — priorité de patch (diagnostic, non implémenté)

| Priorité | Fichier(s) | Raison |
|----------|------------|--------|
| **P0** | `src/preload/preload.js`, `src/preload/sessionPreload.js`, preloads satellites | Point unique : faire retourner `() => ipcRenderer.removeListener(channel, handler)` depuis chaque `on*` |
| **P1** | `src/renderer/video-player.js`, `src/renderer/new-instance/new-instance-pipeline.js` | **Risque réel** : factory appelée à chaque ouverture session Type A (`instance-manager`) / Type B (`new-session`) sans cleanup à la fermeture |
| **P2** | `src/renderer/instance-manager.js`, `src/renderer/new-session.js` | Appeler le futur `unsubscribe` dans `closeInstance` / `closeNewInstanceSession` |
| **P3** | Fan-out boot (`Sidebar.js`, `StreamDeck*.js`, `session-audio-hub.js`, etc.) | Dette architecturale (N handlers/canal) — pas d'accumulation au runtime sauf si guards retirés |
| **Hors scope** | `scrcpy-socket.js`, `new-instance-manager.js`, inputs, sessions Type A/B core | LOCK — ne pas toucher dans un futur fix |

**LOCK / worker :** non concernés par ce diagnostic.

---

## FIX — Cleanup listener stream-restarting (étape 1/3, 2026-07-12)

`preload.js` : `sessionAPI.onStreamRestarting` retourne `() => ipcRenderer.removeListener(...)`. Autres `on*` inchangés.

---

## FIX — Cleanup listener stream-restarting Type A (étape 2/3, 2026-07-12)

`video-player.js` : `createVideoPlayer` stocke l'unsubscribe, expose `dispose()`. `instance-manager.js` : `dispose()` dans `closeInstance` et chemins d'échec au démarrage.

---

## FIX — Cleanup listener stream-restarting Type B (étape 3/3, 2026-07-12)

`new-instance-pipeline.js` : `dispose()` sur unsubscribe. `new-session.js` : `closeNewInstanceSession` appelle `pipeline.dispose()` après `stop()`.

**Appelants non modifiés (hors scope) :** `session-audio-hub.js`, `session-stream-bridge.js`, BrowserView `session.js` (sessionPreload) — listeners singleton / par vue.

---

## DIAGNOSTIC — Audit nettoyage 7.2 / 7.3 / 7.5 / 7.6 (2026-07-12)

**Statut : diagnostic uniquement — aucune suppression ni modification de code.**

### 7.2 — Double preload Electron

**Preload actif :** `src/preload/preload.js` uniquement.

| Référence | Chemin résolu |
|-----------|---------------|
| `src/main/main.js` L270 | `path.join(__dirname, "..", "preload", "preload.js")` → `src/preload/preload.js` |
| `hub-modal-overlay-manager.js` L45 | `../../preload/preload.js` → idem |
| `package.json` | `"main": "src/main/main.js"` — pas de preload racine |

**Preload racine `preload.js` (racine repo) : INACTIF** — aucune référence runtime ni dans `electron-builder` (`files`: `src/**/*` + `package.json` seulement → **non packagé**).

**Contenu unique du preload racine (absent de `src/preload/preload.js` ou sans handler IPC main) :**

| API racine | Canal IPC | Handler main existant ? |
|------------|-----------|-------------------------|
| `startVirtualDisplay` / `stopVirtualDisplay` | `start-virtual-display` / `stop-virtual-display` | **Non** (`src/main/` — 0 match) |
| `sessionsList` / `sessionsCreate` / `sessionsUpdate` / `sessionsRemove` | `sessions-*` | **Non** (remplacé par `session:*`) |
| `bringAppToForeground` | `bring-app-to-foreground` | **Non** |

APIs partagées (sous-ensemble obsolète) : `getDevices`, `getApps`, `startVideoStream`, `stopVideoStream`, `sendInput`, `onVideoCodecMeta/Packet/Error`, contrôles fenêtre.

**Verdict 7.2 :** **Sûr à supprimer** — fichier legacy non chargé, non packagé, APIs uniques sans implémentation main.

**Fichiers/lignes si suppression future :** `preload.js` (racine, entier, 33 lignes).

---

## CLEANUP — Suppression preload.js racine (2026-07-12)

Fichier `preload.js` (racine) supprimé. Preload actif inchangé : `src/preload/preload.js` (`main.js` L270, `hub-modal-overlay-manager.js` L45). Recherche globale : aucune référence runtime au fichier racine.

---

### 7.3 — Handlers IPC `get-apps` vs `device:apps`

| Handler | Fichier | Lignes | Comportement |
|---------|---------|--------|--------------|
| `get-apps` | `src/main/main.js` | L1428–L1436 | `deviceManager.getInstalledApps(serial)` → **tableau de strings** (packages) |
| `device:apps` | `src/main/main.js` | L1438–L1463 | Worker / `getInstalledAppsWithDetails` → `{ success, apps[] }` enrichi |

**Exposition preload :** `src/preload/preload.js` L8 et L49 — `getApps` dupliqué (même clé 2×) ; L50 `getAppsWithDetails` → `device:apps`.

**Appelants renderer :**

| API | Fichier | Scénario |
|-----|---------|----------|
| `getAppsWithDetails` | `new-session.js` L725, `AppLauncherSearch.js` L163 | Chemin nominal liste apps |
| `getApps` → `get-apps` | **Aucun** dans `src/renderer/` | — |

**Verdict 7.3 :** **Sûr à déprécier** côté handler + preload `getApps` — aucun appelant renderer. Migration requise **uniquement** sur `src/preload/preload.js` (retirer les 2 entrées `getApps` L8/L49) avant suppression handler `get-apps` L1428–L1436. Pas de migration renderer.

---

## DEPRECATION — get-apps étape 1/2 (2026-07-12)

`src/preload/preload.js` : retrait `electronAPI.getApps` (doublon L8 + L49). `getAppsWithDetails` → `device:apps` inchangé.

---

## DEPRECATION — get-apps étape 2/2 (2026-07-12)

`src/main/main.js` : suppression handler IPC `get-apps` (L1428–L1436). Canal nominal : `device:apps` uniquement. `DeviceManager.getInstalledApps()` reste (usage interne possible) — seul l'IPC legacy retiré.

**Vérification interne :** aucun `invoke("get-apps")` restant dans le repo.

---

### 7.5 — `test.js` racine

| Vérification | Résultat |
|--------------|----------|
| `package.json` scripts | **Aucune** référence à `test.js` |
| Imports / requires repo | **Aucun** (`grep test.js` → 0) |
| Packaging `package.json` `build.files` | `src/**/*` + `package.json` — **`test.js` exclu** |
| `electron-builder.config.js` | Spread `pkg.build` — même exclusion |

Contenu : snippet Electron minimal **syntaxiquement invalide** (parenthèses/arrow cassées) — script de test manuel abandonné.

**Verdict 7.5 :** **Sûr à supprimer** — non référencé, non packagé, non exécutable.

**Fichiers/lignes si suppression future :** `test.js` (racine, entier, 1 ligne).

---

## CLEANUP — Suppression test.js racine (2026-07-12)

Fichier `test.js` (racine) supprimé. Non référencé (`package.json`, scripts, imports) ; exclu du build `files: src/**/*`.

---

### 7.6 — `getConnectedDevices` dupliqué

| Implémentation | Fichier | Lignes | Rôle |
|----------------|---------|--------|------|
| `DeviceManager.getConnectedDevices()` | `device-manager.js` | L187–L208 | **Chemin primaire** via `DeviceRegistry.getRawAdbDevices()` L67 |
| `getConnectedDevices()` | `main.js` | L724–L743 | **Fallback 1** injecté L1189 `getConnectedDevicesFallback` — si primaire vide/échec |
| `getConnectedDevicesSimple()` | `main.js` | L745+ | **Fallback 2** `getConnectedDevicesSimpleFallback` — si fallback 1 vide |

**Comparaison parsing — pas identique :**

| Aspect | `device-manager.js` | `main.js` fallback |
|--------|---------------------|-------------------|
| Exécution ADB | `execWithTimeout` (async) | `exec` callback |
| Split lignes | `\n` seul | `\r?\n` |
| Champ `connected` | **`true` pour toutes les lignes** | **`state === "device"`** |
| `status` / `name` / `model:` | Identique | Identique |

**Impact :** le primaire (`device-manager`) marque `connected: true` même pour `offline`/`unauthorized` ; le fallback main est plus correct sur `connected`. `DeviceRegistry.attachStableIds` (L96) filtre `device.connected === false` — comportement divergent selon le chemin emprunté.

**Verdict 7.6 :** **À garder (justifié)** — chaîne fallback intentionnelle dans `device-registry.js`. **Pas sûr à supprimer** `main.js` L724–L758 sans d'abord aligner `device-manager.js` L202 (`connected: state === "device"`) et unifier le parsing (split `\r?\n`). **Source de vérité cible :** `device-manager.js` (primaire, timeout, classe dédiée) ; fallbacks main à retirer une fois primaire fiable.

**Fichiers/lignes pour fusion future (pas suppression immédiate) :** `device-manager.js` L187–L208 (corriger `connected`) ; puis `main.js` L724–L758 + injection L1189–L1190.

---

## FIX — device-manager getConnectedDevices connected (étape 1/2, 2026-07-12)

`device-manager.js` L206 : `connected: state === "device"`. `main.js` fallbacks inchangés.

**Appelants :** `device-registry.js` — aucun ne dépend de `connected: true` sur offline/unauthorized ; le fix aligne primaire et fallbacks.

**Test :** device USB `state=device` → `{ connected: true, status: "green" }`.

---

## VERIFICATION — fallbacks getConnectedDevices main.js (étape 2/2, 2026-07-12)

**Pourquoi les fallbacks existent :** filet de sécurité dans `DeviceRegistry.getRawAdbDevices` — pas un chemin normal parallèle.

| Déclencheur | Comportement |
|-------------|--------------|
| `deviceManager.getConnectedDevices()` throw | Fallback 1 (`main.js` exec `devices -l`) |
| Résultat primaire vide `[]` | Idem puis fallback 2 (`adb devices` simple) |

**Après fix `connected` :** le chemin normal = primaire uniquement quand ADB répond. Les fallbacks compensaient surtout timeout/`execWithTimeout` ou échec exec — **pas** le bug `connected`.

**Décision :** retirer la duplication `main.js` **en relocalisant** la chaîne fallback dans `device-manager.js` (erreur/vide uniquement). **Ne pas supprimer** la robustesse sans remplacement.

---

## CLEANUP — getConnectedDevices fallbacks main.js (étape 2/2, 2026-07-12)

Chaîne fallback relocalisée dans `device-manager.js` (`_fetchConnectedDevicesLong` → relaxed → simple). `device-registry.js` : `getRawAdbDevices` délègue uniquement à `deviceManager`. Suppression `getConnectedDevices` / `getConnectedDevicesSimple` + injection L1189–L1190 dans `main.js`.

**Tests :** `diagnose-devices.js` → 1 USB connecté ; Electron boot + `[get-devices] connected count=1`.

---

## CLEANUP — Retrait DEBUG_CRASH (7.4, 2026-07-12)

**Protection env :** aucune — `debugCrashWorker` / `DEBUG_CRASH` actifs en production (DevTools : `await electronAPI.debugCrashWorker()`).

**Retiré (4 commits) :**

| Fichier | Commit | Contenu supprimé |
|---------|--------|------------------|
| `apps-worker.js` | `3c55450` | `case "DEBUG_CRASH"` → `process.exit(1)` |
| `apps-worker-bridge.js` | `6cfa5b6` | `debugCrashWorker()` |
| `preload.js` | `303bafc` | `electronAPI.debugCrashWorker` |
| `main.js` | *(ce commit)* | IPC `apps-worker:debug-crash` |

**Conservé :** restart / `MAX_RESTART_ATTEMPTS` / fallback in-process sur crash réel (`child.on("exit")`).

**Tests auto :** aucun ne dépendait de `DEBUG_CRASH`.

---

## DIAGNOSTIC — execPromise / execWithTimeout dupliqués (7.1, 2026-07-12)

**Statut : diagnostic uniquement — aucune modification de code.**

### Tableau des copies

| Fichier | Ligne(s) | Signature | `execWithTimeout` ? | Identique au noyau ? |
|---------|----------|-----------|---------------------|----------------------|
| `device-manager.js` | L12, L24 | `execPromise(cmd)` / `execWithTimeout(cmd, timeoutMs=12000)` | Oui | **Référence** — `maxBuffer` 10 Mo, `stdout.trim()`, msg `Timeout ADB` |
| `app-metadata-manager.js` | L21, L33 | `execPromise(cmd)` / `execWithTimeout(cmd, timeoutMs)` | Oui | **Non** — `String(stdout).trim()` ; msg `Timeout (${ms}ms)` sans « ADB » ; pas de default sur `execWithTimeout` |
| `app-icon-extractor.js` | L76, L88 | `execPromise(cmd, timeoutMs=12000)` / `execWithTimeout(cmd, timeoutMs=12000)` | Oui | **Non** — `maxBuffer` **20 Mo** ; `timeoutMs` passé à `execPromise` mais **non utilisé** dans le corps |
| `wifi-adb-service.js` | L9, L21 | `execPromise(cmd, timeoutMs=12000)` / `execWithTimeout(cmd, timeoutMs)` | Oui | **Non** — `maxBuffer` 1 Mo ; erreur `String(stderr\|\|msg).trim()` ; `timeoutMs` inutilisé dans `execPromise` |
| `main.js` | L78 | `execPromise(cmd)` | Non | **Non** — identique à device-manager sauf usage local launch ADB |
| `device-orientation-manager.js` | L5 | `execPromise(cmd)` | Non | **Non** — `maxBuffer` 1 Mo ; **`resolve(stdout)` sans trim** |
| `device-power-manager.js` | L4 | `execPromise(cmd)` | Non | **Non** — **pas de `maxBuffer`** ; stdout brut |
| `device-audio-volume-manager.js` | L6 | `execPromise(cmd)` | Non | **Non** — `maxBuffer` 1 Mo ; stdout brut |
| `adb-input-controller.js` **LOCK** | L6 | `execPromise(cmd)` | Non | **Non** — `maxBuffer` 5 Mo ; **non modifiable** ce chantier |
| `new-instance-manager.js` **LOCK** | L41 | `execPromise(cmd)` | Non | **Non** — pas de `maxBuffer` ; stdout brut ; **non modifiable** ce chantier |

**Total :** 10 fichiers, **4 paires** `execPromise`+`execWithTimeout`, **6** `execPromise` seul.

### Variations fonctionnellement importantes

| Variation | Fichiers | Impact factorisation |
|-----------|----------|----------------------|
| `maxBuffer` 1 / 5 / 10 / 20 Mo / absent | icon 20 Mo, managers 1–10 Mo, power/new-instance aucun | Module doit accepter `maxBuffer` optionnel |
| `stdout.trim()` vs brut | device-manager vs orientation/power/audio/LOCK | Option `trim: boolean` (défaut `true`) |
| Message timeout `ADB` vs générique | device-manager/icon/wifi vs metadata | Paramètre `label` ou `prefix` optionnel |
| `execWithTimeout` default 12000 | device-manager, icon ; metadata/wifi sans default | Paramètre requis ou default configurable |
| `timeoutMs` dans signature `execPromise` (wifi, icon) | Inutilisé — dead param | Ne pas reproduire ; timeout uniquement via race |

### LOCK — référence uniquement (hors chantier)

- `adb-input-controller.js` L6–15 : copie locale 5 Mo + trim ; utilisée pour `wm size` et commandes shell input.
- `new-instance-manager.js` L41–50 : copie minimale (pas maxBuffer) ; stay-awake / keyevent / launch.

### Emplacement module partagé proposé

**`src/main/utils/adb-exec.js`** (à créer) — aucun conflit : pas de `utils/` existant, pas de `adb-exec.js` dans le repo. `src/shared/` possible pour usage cross-process mais **LOCK** `adb-input-controller` resterait local.

API suggérée :

```javascript
execPromise(command, { maxBuffer = 10 * 1024 * 1024, trim = true } = {})
execWithTimeout(command, timeoutMs, options?) // délègue à execPromise + Promise.race
```

### Verdict 7.1

**Factorisation possible hors LOCK, mais module paramétrable requis** — pas une extraction mot-pour-mot unique.

| Périmètre migration (futur) | Fichiers |
|-----------------------------|----------|
| Cible immédiate | `device-manager`, `app-metadata-manager`, `app-icon-extractor`, `wifi-adb-service`, `main.js`, `device-orientation-manager`, `device-power-manager`, `device-audio-volume-manager` |
| **Exclus LOCK** | `adb-input-controller.js`, `new-instance-manager.js` |

**LOCK / input / sessions :** non concernés par ce diagnostic.

---

## ADD — Module partagé adb-exec.js (7.1, 2026-07-12)

**Fichier créé :** `src/main/utils/adb-exec.js` — **non importé** par le code existant (migration différée).

**API :**

- `execPromise(command, { maxBuffer = 10 Mo, trim = true })`
- `execWithTimeout(command, timeoutMs = 12000, { maxBuffer, trim, timeoutLabel = "ADB", timeoutMessage })`
- Constantes exportées : `DEFAULT_MAX_BUFFER_BYTES`, `DEFAULT_COMMAND_TIMEOUT_MS`

**Migration :** au cas par cas sur les 8 managers + `main.js` si jugée utile ; **LOCK** `adb-input-controller.js` / `new-instance-manager.js` exclus.

---

- **2026-07-24** — **switchSessionTransport 4b** — Toggle WiFi resync depuis état session (`new-instance:state`) + `transport:reattach-state` end/error.
- **2026-07-24** — **switchSessionTransport 4a Type B** — `switchSessionTransportTypeB` + toggle ON sans USB (A+B) ; overlay end si les deux OK. Stub closed déjà neutralisé. 4b/4c/4d à venir.
- **2026-07-23** — **switchSessionTransport Commit 1/3** — Type A destroy+recreate + branchement `wifi:toggle` ON sans USB ; overlay `end` ; Type B mark/TODO/fail ; topologie auto non branchée.
- **2026-07-23** — **Audit catégorie (b) point 3** — Fix orientation Type B (letterbox) validé (portrait plein cadre, Type A OK ; sans WiFi). LOCK comportement `null` lock + `hasOwnProperty`. Pas de commit isolé — hunks dans `a8940ec`.
- **2026-07-23** — **Audit catégorie (b) point 2** — Correction : bootstrap externe Type B respecte la résolution du preset par défaut (`bootstrapNewDisplay` → `--new-display`) au lieu de forcer `1920x1080` ; corrige la perte de résolution custom introduite par la priorité `display_id`/`skipPackageLaunch`.
- **2026-07-23** — **Audit catégorie (b) point 1** — Retrait vestige `preferredNewDisplay` / `resolveTypeBNewDisplay` (`new-instance-manager.js`), orphelin depuis retrait catégorie (a) — aucun effet runtime.
- **2026-07-22** — **Reattach USB/WiFi — nettoyage rebind in-place** — Retrait de `ScrcpySocketClient.rebind()` / `rebindTransportOnly()` (`scrcpy-socket.js`) et `AdbInputController.rebind()` (`adb-input-controller.js`). Approche rebind in-place abandonnée après test réel (flux vidéo cassé + décalage input). Suite : `switchSessionTransport` (destroy+recreate orchestré), commit séparé à venir.
- **2026-07-21** — **Reattach USB/WiFi — Commit 3/4** — `AdbInputController.rebind()` — **abandonné / retiré** (voir nettoyage 2026-07-22).
- **2026-07-21** — **Reattach USB/WiFi — Commit 2/4** — `ScrcpySocketClient.rebind()` — **abandonné / retiré** (voir nettoyage 2026-07-22).
- **2026-07-21** — **Reattach USB/WiFi — Commit 1/4** — état `reconnecting` + garde `_onScrcpyClosed` + helpers non branchés (`new-instance-manager.js`, `d8be5f1`). No-op runtime. LOCK createSession/input/`--new-display` intact.
- **2026-07-12** — **Diagnostic I/O sync metadata/icônes** — prefetch worker OK ; main : resolve + historique. LOCK intact.
- **2026-07-12** — **Overlay switch poll transport** — confirmation transport réel post-toggle. LOCK intact.
- **2026-07-12** — **Diagnostic wifi:toggle** — garanties `success` vs transport UI réel ; cache 10 s. LOCK intact.
- **2026-07-12** — **Overlay switch USB/WiFi** — spinner centré sidebar toggle. LOCK intact.
- **2026-07-12** — **Fix Type B** — propagation `launchDims` launch→start ; fallback dims écrit cache. LOCK intact.
- **2026-07-12** — **Diagnostic** — cache wm size / dims Type B redondantes.
- **2026-07-12** — **Fix USB** — raccourci `isLikelyUsbTransportSerial` avant `forceFresh` dans `resolveAdbSerialForDims`.
- **2026-07-12** — **Perf ADB** — `forceFresh: true` sur `resolveAdbSerialForDims` (lancement session). Commits `9a5d05d` + main.js.
- **2026-07-12** — **Perf ADB** — cache TTL 10 s + mutex `listUnifiedDevices` (`device-registry.js`). LOCK / vidéo : non concernés.
- **2026-07-12** — **Diagnostic** — cache `listUnifiedDevices` (étape 1, docs seulement).
- **2026-07-12** — **Perf UI** — debounce 100 ms recherche apps : `AppLauncherSearch.js` (`aad55b3`), `AppList.js` (`28344f4`). LOCK intact.
- **2026-07-08** — **LOCK validé** — Clic long Type B : `adb-input-controller.js`, `new-instance-manager.js`, `main.js` (synthèse swipe, ADB display virtuel, contrôleur unifié).
- **2026-07-08** — Implémentation icônes apps : multi-APK, adaptive XML, cache fallback stableDeviceId, retry max 3 (`iconAttempts`), placeholder stylé, prefetch once + auto-refresh Nouvelle instance.
- **2026-07-08** — Diagnostic icônes apps manquantes (Nouvelle instance + sidebar) : source commune `AppMetadataManager`/`AppIconExtractor`, cache partagé, faux positifs micro-PNG filtrés.
- **2026-07-08** — **LOCK** — Audio OFF par défaut (`globalMuted: true`, Type B `audio: false`, UI badge OFF).
- **2026-07-08** — **LOCK** — Multi-appareils + polling devices (`973a28a`) : `pollDeviceList`, labels Type B, cache serial poll, découverte appareils Paramètres.
- **2026-07-07** — Fix multi-device sessions, polling, device discovery (`973a28a`).
- **2026-07-05** — Fix critique input global + isolation orientation Type B (F1–F7). : layout sans reset 60fps, hystérésis remap, seuil coords mappées, guards pointer.
- **2026-07-05** — Fix bouton orientation portrait WiFi (F1–F5) : serial résolu, canvas +90° fixe au toggle, délai WiFi post-rotation.
- **2026-07-05** — **LOCK validé** — Fix orientation vidéo (flux à l'envers USB/WiFi) : `stream-params.js`, `device-orientation-manager.js`, `main.js`, `session.js`, `scrcpy-socket.js`.
- **2026-07-05** — Phase 3 orientation : `wm size` live (toggle, stream start, cache 60s).
- **2026-07-05** — Fix clic long + BACK Type B WiFi (F1–F4).
- **2026-07-05** — Diagnostic clic long + clic droit BACK WiFi vs USB.
- **2026-07-05** — Phase 2 ADB quoting (`adbSerialArg` partagé).
- **2026-07-05** — Phase 1 parité USB/WiFi : identité stable + resolve ADB serial.
- **2026-07-05** — Diagnostic pastille couleur USB vs WiFi (clé serial vs deviceId stable).
- **2026-07-05** — Diagnostic couleur instances + popup Renommer always-on-top.
- **2026-07-05** — Fix ReferenceError `notifyDeviceViewsUpdated` (portée namesHandlers).
- **2026-07-05** — Diagnostic toggle WiFi ne reflète pas l'état réel (stockage vs connexion active, race auto-connect, fusion identité).
- **2026-07-05** — Diagnostic séparation USB/WiFi panneau (21051182G / e176518f / ip:port).
- **2026-07-05** — Diagnostic bug toggle WiFi absent (connexion WiFi seule).
- **2026-07-05** — Implémentation WiFi ADB (registry, toggle, panneau Appareils) — tests utilisateur pending.
- **2026-07-05** — Diagnostic WiFi ADB (Étape 1) validé.
- **2026-07-04** — Style visuel bouton sur `.sidebar-device-card` (CSS only, double-clic seul trigger).
- **2026-07-04** — Double-clic carte device sidebar → `onMirrorButtonClick()` (`DevicePanel.js`).
- **2026-07-04** — Fix input multi-fenêtres Type A + Type B (`c23e7cb`).
- **2026-07-04** — Documentation LOCK général + audit toggle audio (aucun patch requis).
