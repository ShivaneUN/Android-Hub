# Android Hub — État d'avancement

Dernière mise à jour : 2026-07-05

---

## Validé & verrouillé (LOCK)

| Domaine | Statut | Commit / note |
|---------|--------|----------------|
| Audio capture + son PC Type A/B | ✅ LOCK | Validé utilisateur |
| Mute global OFF (silence) | ✅ LOCK | Validé utilisateur |
| Input Type A multi-fenêtres | ✅ LOCK | `c23e7cb` |
| Input Type B multi-fenêtres (display virtuel) | ✅ LOCK | `c23e7cb` |
| `scrcpy-socket.js` | ✅ LOCK | Section 13 |
| `new-instance-manager.js` | ✅ LOCK | Section 13 |
| Toggle Audio ON/OFF (bouton) | ✅ OK | Voir section ci-dessous |

**Aucune modification sur ces zones sans accord explicite.**

---

## Toggle Audio ON/OFF — état du bouton (2026-07-04)

**Verdict : fonctionnel tel quel — aucune correction code nécessaire.**

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

- Commit documentation LOCK (fichiers `AI_CONTEXT.md`, `PROGRESS_CHECK.md`) — **en attente validation utilisateur**.

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

## Historique récent

- **2026-07-05** — Fix IP wlan0 (ordre fetch avant tcpip, parsing IPv4, log brut).
- **2026-07-05** — Diagnostic toggle WiFi ne reflète pas l'état réel (stockage vs connexion active, race auto-connect, fusion identité).
- **2026-07-05** — Diagnostic séparation USB/WiFi panneau (21051182G / e176518f / ip:port).
- **2026-07-05** — Diagnostic bug toggle WiFi absent (connexion WiFi seule).
- **2026-07-05** — Implémentation WiFi ADB (registry, toggle, panneau Appareils) — tests utilisateur pending.
- **2026-07-05** — Diagnostic WiFi ADB (Étape 1) validé.
- **2026-07-04** — Style visuel bouton sur `.sidebar-device-card` (CSS only, double-clic seul trigger).
- **2026-07-04** — Double-clic carte device sidebar → `onMirrorButtonClick()` (`DevicePanel.js`).
- **2026-07-04** — Fix input multi-fenêtres Type A + Type B (`c23e7cb`).
- **2026-07-04** — Documentation LOCK général + audit toggle audio (aucun patch requis).
