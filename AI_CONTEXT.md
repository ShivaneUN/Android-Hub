# Android Hub — Contexte agent & zones verrouillées

> **Règle générale :** tout ce qui est listé ci-dessous comme **LOCK** est stable, validé en tests utilisateur, et **ne doit pas être modifié** sans accord explicite du mainteneur.

Dernière mise à jour : 2026-07-06

---

## LOCK GÉNÉRAL (validé 2026-07-04 — input étendu 2026-07-05)

### Audio — LOCK

- Capture audio, lancement Type A / Type B avec son PC, mute global OFF (silence).
- Fichiers concernés (ne pas modifier sans accord) :
  - `src/main/managers/global-audio-output-manager.js`
  - `src/main/managers/session-audio-process-manager.js`
  - `src/main/ipc/audioHandlers.js` (handlers IPC métier)
  - `src/main/main.js` — fonctions `applyGlobalAudioMuteSideEffects`, `resolveHubSocketAudioEnabled`, `startSessionAudioPlayback`, `stopSessionAudioPlayback`
  - `src/renderer/session-audio-hub.js`
  - `src/renderer/session/session-audio-player.js`

**Comportement attendu (déjà validé) :**

- **Audio ON (global)** : processus scrcpy dédié `--no-video` par session → son PC ; device muet côté OS.
- **Audio OFF (global)** : arrêt des processus audio + pas de capture socket Hub.

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
- **Type B** — display virtuel : coords canvas directes ; hub ADB `input -d displayId` ; USB/WiFi.
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

### Input Type A — LOCK (historique `c23e7cb`, étendu 2026-07-05)

- Fallback ADB quand le socket contrôle scrcpy est absent.
- Vérification `result.success === false` côté renderer.

### Input Type B — LOCK (historique `c23e7cb`, étendu 2026-07-05)

- Routage touch display virtuel via hub ADB + `displayId`.
- Fallback vers `routeInputToSession` conservé (sans modifier `new-instance-manager.js`).

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

1. Vérifier si la zone touchée est **LOCK** (audio, **input**, **noms**, `scrcpy-socket.js`, `new-instance-manager.js`, etc.).
2. Si oui → **STOP** et demander accord explicite.
3. Pour l'**input** : toute évolution passe par une couche **amont** ; jamais de patch direct dans les fichiers listés § Input LOCK DÉFINITIF.
4. Pour le **renderer** : pas de `const t` / `const api` au scope global dans les `<script>` — voir § Renderer scripts globaux & i18n.
5. Préférer des changements **additifs** ; ne pas supprimer de comportement validé.
