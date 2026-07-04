# Android Hub — État d'avancement

Dernière mise à jour : 2026-07-04

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

## Historique récent

- **2026-07-04** — Fix input multi-fenêtres Type A + Type B (`c23e7cb`).
- **2026-07-04** — Documentation LOCK général + audit toggle audio (aucun patch requis).
