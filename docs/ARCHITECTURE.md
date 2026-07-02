# 🏗️ ARCHITECTURE — Android Hub

> Ce document détaille techniquement l'architecture définie dans `AI_CONTEXT.md`.
> En cas de conflit, `AI_CONTEXT.md` est toujours prioritaire.

---

## 1. Vue d'ensemble des couches

```
┌─────────────────────────────────────────────┐
│              RENDERER (UI)                    │
│  - Affichage des Sessions (Layout)            │
│  - Inputs utilisateur (clic, clavier...)      │
│  - Aucune logique métier                      │
└───────────────────┬───────────────────────────┘
                     │ IPC (preload bridge)
┌───────────────────▼───────────────────────────┐
│              PRELOAD                           │
│  - Expose une API restreinte et typée          │
│  - contextIsolation: true                      │
│  - Aucune logique, juste du passthrough sûr    │
└───────────────────┬───────────────────────────┘
                     │ ipcRenderer ↔ ipcMain
┌───────────────────▼───────────────────────────┐
│              MAIN PROCESS                      │
│  - SessionManager                              │
│  - LayoutManager                               │
│  - FocusManager                                │
│  - TransferManager                             │
│  - AutomationEngine                            │
└───────────────────┬───────────────────────────┘
                     │ appels directs (Node)
┌───────────────────▼───────────────────────────┐
│              NATIVE                            │
│  - Bridge scrcpy (process spawn / socket)      │
│  - Gestion ADB                                 │
│  - Encodage / décodage vidéo                   │
│  - Capture input bas niveau                    │
└─────────────────────────────────────────────────┘
```

---

## 2. Dossiers du projet

```
android-hub/
├── AI_CONTEXT.md          # Règles absolues pour toute IA — LIRE EN PREMIER
├── docs/                  # Documentation complémentaire
│   ├── ARCHITECTURE.md
│   ├── SESSIONS.md
│   ├── LAYOUTS.md
│   ├── IPC_CONTRACT.md
│   └── ROADMAP.md
├── src/
│   ├── main/              # MAIN PROCESS
│   │   ├── managers/       # SessionManager, LayoutManager, FocusManager...
│   │   ├── ipc/            # Handlers IPC (ipcMain.handle / .on)
│   │   └── index.js        # Point d'entrée Electron (app, BrowserWindow)
│   ├── renderer/           # RENDERER
│   │   ├── components/      # Composants UI réutilisables
│   │   ├── views/           # Vues principales (Sessions, Settings...)
│   │   ├── styles/          # CSS / thème (dark, inspiré TabDesk)
│   │   └── index.html
│   ├── preload/             # PRELOAD
│   │   └── preload.js       # contextBridge.exposeInMainWorld
│   └── native/              # NATIVE
│       └── scrcpy/           # Bridge scrcpy + ADB
├── assets/                 # Icônes, images, ressources statiques
├── package.json
└── .gitignore
```

---

## 3. Core Managers (Main Process)

| Manager | Responsabilité |
|---|---|
| `SessionManager` | Créer, détruire, suivre l'état de chaque Session |
| `LayoutManager` | Définir comment les Sessions sont disposées à l'écran |
| `FocusManager` | Déterminer quelle Session reçoit le clavier/souris |
| `TransferManager` | Gérer la queue de transferts de fichiers |
| `AutomationEngine` | Exécuter les règles SI/ALORS |

Chaque Manager est indépendant et ne connaît pas l'UI.
La communication avec le Renderer passe **uniquement** par les handlers IPC dans `src/main/ipc/`.

---

## 4. Règle de dépendance

```
Renderer  -->  ne dépend QUE du Preload
Preload   -->  ne dépend QUE du Main (via ipcRenderer)
Main      -->  dépend des Managers
Managers  -->  dépendent du Native (scrcpy bridge)
Native    -->  ne dépend de RIEN d'autre (isolé, testable seul)
```

Aucune flèche ne doit remonter dans l'autre sens.
