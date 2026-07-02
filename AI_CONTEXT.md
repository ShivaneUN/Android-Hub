# 🧠 ANDROID HUB — AI CONTEXT FILE

Ce fichier définit les règles fondamentales que toute IA (Claude Code, Copilot, Cline, etc.)
DOIT respecter lorsqu'elle analyse, modifie ou génère du code pour Android Hub.

Toute violation de ces règles est considérée comme une erreur critique d'architecture.

---

# 🚨 1. PRINCIPES FONDAMENTAUX

## 1.1 Architecture générale

Android Hub est une application Electron basée sur 4 couches :

- MAIN PROCESS (logique métier)
- RENDERER (interface utilisateur)
- PRELOAD (sécurité IPC)
- NATIVE (scrcpy / vidéo / input)

Ces couches ne doivent JAMAIS être mélangées.

---

## 1.2 Règle centrale du projet

👉 La SESSION est l'unité centrale du système.

Tout le reste dépend des Sessions.

- Layout = affichage des Sessions
- Canvas = rendu vidéo d'une Session
- Focus = sélection d'une Session
- Input = contrôle d'une Session

Une Session peut exister sans être affichée.

---

## 1.3 Séparation stricte des responsabilités

- Renderer : UI uniquement (aucune logique métier)
- Main Process : logique métier complète
- Native : performance bas niveau (scrcpy)
- Preload : API sécurisée entre Renderer et Main

---

# 🧩 2. RÈGLES ARCHITECTURALES ABSOLUES

## 2.1 Interdictions critiques

L'IA NE DOIT JAMAIS :

- Faire communiquer Renderer directement avec Native
- Mettre de la logique métier dans le Renderer
- Faire dépendre scrcpy de l'UI
- Créer une Session depuis un Layout
- Lier le Focus à un onglet UI
- Mélanger UI et gestion d'état global
- Contourner IPC

---

## 2.2 Flux obligatoire

Tout doit suivre ce flux :

```text
Renderer
   ↓ (IPC)
Main Process
   ↓
Core Managers
   ↓
Native (scrcpy)
   ↓
Android Device
```

---

# 🎨 3. RÈGLES UI / DIRECTION ARTISTIQUE (DA)

## 3.1 DA figée

La direction artistique actuelle est CONSIDÉRÉE COMME VALIDÉE.

L'IA NE DOIT PAS :

- Refaire l'interface
- Changer les couleurs globales
- Modifier la structure UI globale
- Créer une nouvelle sidebar
- Créer un nouveau système de navigation

## 3.2 Ajout de fonctionnalités UI

Toute nouvelle fonctionnalité doit être intégrée dans l'existant :

- ✔ Sessions
- ✔ Layouts
- ✔ Control Center
- ✔ Performance Panel
- ✔ Settings

## 3.3 Interdictions UI

- Pas de refonte UI globale
- Pas de duplication de menus
- Pas de nouveaux systèmes de navigation sans demande explicite

---

# 📱 4. SESSIONS

## 4.1 Définition

Une Session représente une connexion active à un appareil Android.

Elle contient :

- deviceId
- stream vidéo
- canal input
- état
- paramètres (FPS, bitrate)

## 4.2 Règles

- Une Session existe indépendamment de l'UI
- Une Session peut être invisible
- Une Session peut survivre à un changement de layout
- Une Session ne doit jamais être recréée inutilement

## 4.3 États possibles

- Disconnected
- Connecting
- Connected
- Reconnecting
- Paused
- Error

---

# 🖥️ 5. LAYOUTS

## 5.1 Définition

Un Layout définit comment les Sessions sont affichées.

## 5.2 Modes

- SINGLE MODE : 1 Session affichée
- MULTI MODE : plusieurs Sessions visibles

## 5.3 Règles

- Un Layout ne crée pas de Session
- Un Layout n'affecte pas les données
- Un Layout est uniquement visuel

---

# 🎯 6. FOCUS

## 6.1 Définition

Le Focus détermine quelle Session reçoit :

- clavier
- souris
- commandes utilisateur

## 6.2 Règles

- Un seul Focus actif à la fois
- Le Focus est indépendant des onglets
- Le Focus est indépendant du Layout

---

# 🔌 7. IPC (COMMUNICATION)

## 7.1 Règle obligatoire

Toutes les communications passent par IPC.

## 7.2 Interdiction

- Pas d'appel direct Renderer → Main logic
- Pas de logique dans les events UI

---

# 🎥 8. VIDEO / SCRCPY

## 8.1 Règle

Le module scrcpy :

- ne connaît pas l'UI
- ne connaît pas les Layouts
- ne connaît pas les Tabs

Il gère uniquement :

- stream vidéo
- input clavier/souris
- encoding
- performance

---

# 📂 9. TRANSFERTS

## 9.1 Règle

Les transferts de fichiers :

- passent uniquement par Main Process
- utilisent une queue
- sont indépendants de l'UI

---

# ⚡ 10. PERFORMANCE

## 10.1 Règles

Le système doit pouvoir :

- ajuster FPS automatiquement
- réduire bitrate en mode éco
- maintenir stabilité multi-session

---

# 🤖 11. AUTOMATIONS

## 11.1 Définition

Système SI / ALORS basé sur événements système.

## 11.2 Exemple

SI batterie < 20%
ALORS activer mode éco

## 11.3 Règle

Les automations ne doivent jamais :

- casser une Session
- supprimer une Session
- modifier la structure UI

---

# 🧹 12. CLEANUP / OPTIMISATION

## 12.1 Mode cleanup autorisé

L'IA peut proposer la suppression de :

- fichiers non utilisés
- doublons
- tests obsolètes

## 12.2 Interdiction

L'IA NE DOIT JAMAIS supprimer :

- SessionManager
- LayoutManager
- FocusManager
- IPC core
- scrcpy bridge
- documentation /docs
- AI_CONTEXT.md

## 12.3 Procédure obligatoire

Avant suppression :

1. Vérifier les imports
2. Vérifier les dépendances
3. Générer un rapport
4. Attendre validation utilisateur

---

# 📊 13. RÈGLE DE STABILITÉ

Toute modification doit respecter :

- compatibilité sessions existantes
- non-régression UI
- conservation des flux vidéo actifs

---

# 🧠 14. COMPORTEMENT IA ATTENDU

L'IA doit :

- respecter l'architecture existante
- éviter les refontes inutiles
- privilégier l'ajout plutôt que la modification
- maintenir séparation des couches
- suivre strictement les flux définis

---

# 🚀 15. RÈGLE FINALE

Si une instruction entre en conflit avec ce fichier :

👉 CE FICHIER A PRIORITÉ ABSOLUE
