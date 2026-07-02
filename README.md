# Android Hub

Application Electron pour gérer et contrôler plusieurs appareils Android via scrcpy/ADB,
avec une architecture stricte en 4 couches (Main / Renderer / Preload / Native)
centrée sur le concept de **Session**.

## ⚠️ Pour toute IA travaillant sur ce projet

Ordre de lecture obligatoire, **avant toute ligne de code** :

1. **`AI_CONTEXT.md`** — règles d'architecture non négociables (priorité absolue en cas de conflit)
2. **`PROGRESS_CHECK.md`** — vérifier l'état réel du projet avant de coder (surtout après une pause ou une interruption)
3. **`docs/ROADMAP.md`** — savoir à quelle phase on en est

## Documentation

| Fichier | Contenu |
|---|---|
| [`AI_CONTEXT.md`](./AI_CONTEXT.md) | Règles fondamentales — **à lire en premier** |
| [`PROGRESS_CHECK.md`](./PROGRESS_CHECK.md) | Checklist d'état du projet — **à lire en second**, avant de coder |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Détail technique des 4 couches |
| [`docs/SESSIONS.md`](./docs/SESSIONS.md) | Modèle de données et cycle de vie des Sessions |
| [`docs/LAYOUTS.md`](./docs/LAYOUTS.md) | Modes d'affichage (single/multi) |
| [`docs/IPC_CONTRACT.md`](./docs/IPC_CONTRACT.md) | Contrat de communication Renderer ↔ Main |
| [`docs/NEW_SESSION_VIDEO_PIPELINE.md`](./docs/NEW_SESSION_VIDEO_PIPELINE.md) | Pipeline vidéo de la page Nouvelle instance |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | Suivi des phases de développement |

## Structure du projet

```
android-hub/
├── AI_CONTEXT.md
├── docs/
├── src/
│   ├── main/         # logique métier (Managers, IPC handlers)
│   ├── renderer/      # interface utilisateur
│   ├── preload/        # pont sécurisé IPC
│   └── native/          # bridge scrcpy / ADB
├── assets/
└── package.json
```

## Stack
- Electron
- Node.js
- scrcpy / ADB (bridge natif)

## Démarrage (à venir — Phase 0 de la roadmap)
```bash
npm install
npm start
```
