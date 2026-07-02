# 🗺️ ROADMAP — Android Hub

> Document de suivi. À mettre à jour à chaque étape majeure.
> Ne remplace pas `AI_CONTEXT.md`, qui reste la référence absolue en cas de conflit.

---

## Phase 0 — Setup projet
- [ ] Initialiser `package.json` (Electron + dépendances de base)
- [ ] Configurer `electron-builder` pour le packaging Windows
- [ ] Mettre en place le squelette des 4 couches (main / renderer / preload / native)
- [ ] Fenêtre Electron minimale qui s'ouvre (hello world)

## Phase 1 — Core Managers (Main Process)
- [ ] `SessionManager` (création, destruction, états)
- [ ] `LayoutManager` (single / multi mode)
- [ ] `FocusManager`
- [ ] Contrat IPC de base (`session:*`, `layout:*`, `focus:*`)

## Phase 2 — Bridge Native / scrcpy
- [ ] Détection des appareils ADB connectés
- [ ] Listing des apps installées par appareil
- [ ] Lancement d'un flux scrcpy pour une Session
- [ ] Réception du flux vidéo dans le Renderer (Canvas)

## Phase 3 — UI (Renderer)
- [ ] Thème dark (inspiré TabDesk)
- [ ] Vue Sessions (liste des appareils connectés)
- [ ] Vue Layout SINGLE
- [ ] Vue Layout MULTI (grille)
- [ ] Control Center (FPS, bitrate, pause/resume)

## Phase 4 — Fonctionnalités avancées
- [ ] Transferts de fichiers (queue, progress)
- [ ] Automations (SI batterie < 20% ALORS mode éco)
- [ ] Performance Panel (stats temps réel)
- [ ] Settings globaux

## Phase 5 — Stabilisation
- [ ] Tests de non-régression sur Sessions actives
- [ ] Gestion des reconnexions réseau
- [ ] Packaging final Windows (.exe installer)

---

## Notes
- Toute nouvelle phase ou tâche doit respecter strictement `AI_CONTEXT.md`.
- Ne pas cocher une tâche sans validation explicite de l'utilisateur si elle touche
  à un fichier protégé (voir section 12.2 de `AI_CONTEXT.md`).
