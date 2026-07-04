# Android Hub — Contexte agent & zones verrouillées

> **Règle générale :** tout ce qui est listé ci-dessous comme **LOCK** est stable, validé en tests utilisateur, et **ne doit pas être modifié** sans accord explicite du mainteneur.

Dernière mise à jour : 2026-07-04

---

## LOCK GÉNÉRAL (validé 2026-07-04)

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

### Input Type A — LOCK

- Commit : `c23e7cb` (multi-fenêtres).
- Fallback ADB quand le socket contrôle scrcpy est absent (`main.js` handler `send-input`).
- Vérification `result.success === false` côté renderer (`session.js`, `initTypeAInputHandlers`).

**Fichiers :** `src/main/main.js` (branche Type A de `send-input`), `src/renderer/session/session.js` (handlers Type A).

### Input Type B — LOCK

- Commit : `c23e7cb`.
- Routage touch display virtuel via hub ADB + `displayId` dans `main.js` (`resolveTypeBDisplayId`, `sendTypeBInputViaHubAdb`).
- Fallback vers `routeInputToSession` conservé.

**Fichiers core Type B (LOCK section 13 — ne jamais modifier sans accord) :**

- `src/native/scrcpy/scrcpy-socket.js`
- `src/main/managers/new-instance-manager.js`

### Toggle Audio ON/OFF (bouton sidebar)

- **Composant UI :** `src/renderer/sidebar/GlobalAudioToggle.js`
- **Câblage IPC :** `src/preload/preload.js` (`audioAPI`), `src/main/ipc/audioHandlers.js` (broadcast uniquement)
- Le bouton déclenche la logique audio **LOCK** ci-dessus ; ne pas réimplémenter le métier dans le composant.

---

## Architecture session (rappel)

- Fenêtres session = `BrowserView` + `session.html` / `session.js`.
- Type A : flux socket Hub vidéo ; Type B : `NewInstanceManager` + display virtuel.
- Input : IPC `send-input` → main process.

---

## Avant toute modification

1. Vérifier si la zone touchée est **LOCK**.
2. Si oui → **STOP** et demander accord explicite.
3. Préférer des changements **additifs** ; ne pas supprimer de comportement validé.
