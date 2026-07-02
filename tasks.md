# ✅ TASKS.md — Tâches unitaires à valider une par une

> Ce fichier découpe `docs/ROADMAP.md` en tâches précises et petites.
> Donne UNE tâche à la fois à l'IA (Cline, Copilot, Claude Code...), valide son travail,
> puis passe à la suivante. Ne jamais donner plusieurs tâches d'un coup.
>
> Avant chaque tâche, l'IA doit lire `AI_CONTEXT.md` et `PROGRESS_CHECK.md`.
> Coche `[x]` une tâche seulement après l'avoir vérifiée toi-même.

---

## Comment utiliser ce fichier

1. Copie le texte d'une tâche (section "Prompt à donner")
2. Colle-le à ton IA
3. Lis sa réponse / vérifie son travail
4. Si c'est bon → coche la case ici, passe à la tâche suivante
5. Si ce n'est pas bon → corrige ou redemande, ne passe pas à la suite

---

## PHASE 0 — Setup projet

### Tâche 0.1 — Audit de l'existant
- [ ] Fait

**Prompt à donner :**
```
Lis AI_CONTEXT.md et PROGRESS_CHECK.md.
Liste tous les fichiers présents dans src/, dis-moi lesquels ont du contenu réel 
et lesquels sont vides. Ne modifie rien, juste un état des lieux.
```

### Tâche 0.2 — Vérifier package.json
- [ ] Fait

**Prompt à donner :**
```
Vérifie package.json : le champ "main" pointe-t-il bien vers le bon fichier ?
Les scripts "start" et "build" sont-ils corrects pour une app Electron ?
Ne modifie rien sans me le proposer d'abord.
```

### Tâche 0.3 — Test de démarrage minimal
- [ ] Fait

**Prompt à donner :**
```
Lance "npm run start" et dis-moi exactement ce qui se passe (succès, erreur, 
message d'erreur complet). Ne corrige rien tout de suite, montre-moi juste 
le résultat.
```

---

## PHASE 1 — Core Managers (Main Process)

### Tâche 1.1 — État de SessionManager
- [ ] Fait

**Prompt à donner :**
```
Lis docs/SESSIONS.md puis src/main/managers/session-manager.js.
Dis-moi quelles fonctions de l'API attendue (createSession, destroySession, 
getSession, listSessions, pauseSession, resumeSession, updateSettings) existent 
déjà et lesquelles manquent. Ne modifie rien.
```

### Tâche 1.2 — Compléter SessionManager
- [ ] Fait

**Prompt à donner :**
```
D'après ton audit précédent, ajoute UNIQUEMENT les fonctions manquantes de 
SessionManager listées dans docs/SESSIONS.md. Ne touche pas aux fonctions 
qui existent déjà et qui fonctionnent. Montre-moi le diff avant de valider.
```

### Tâche 1.3 — État de LayoutManager
- [ ] Fait

**Prompt à donner :**
```
Lis docs/LAYOUTS.md. Le fichier src/main/managers/layout-manager.js existe-t-il ? 
Si oui, audit comme pour la tâche 1.1. Si non, dis-le moi simplement, 
ne le crée pas encore.
```

### Tâche 1.4 — Créer LayoutManager
- [ ] Fait

**Prompt à donner :**
```
Crée src/main/managers/layout-manager.js avec le mode SINGLE et MULTI 
décrits dans docs/LAYOUTS.md. Respecte la règle : un Layout ne crée 
ni ne détruit de Session.
```

### Tâche 1.5 — État de FocusManager
- [ ] Fait

**Prompt à donner :**
```
Le fichier src/main/managers/focus-manager.js existe-t-il ? Audit comme 
pour la tâche 1.1, ou dis-moi qu'il n'existe pas.
```

### Tâche 1.6 — Créer FocusManager
- [ ] Fait

**Prompt à donner :**
```
Crée src/main/managers/focus-manager.js. Un seul Focus actif à la fois, 
indépendant du Layout et des onglets (voir AI_CONTEXT.md section 6).
```

### Tâche 1.7 — Contrat IPC de base
- [ ] Fait

**Prompt à donner :**
```
Lis docs/IPC_CONTRACT.md. Vérifie quels canaux IPC (session:*, layout:*, 
focus:*) ont déjà un handler dans src/main/ipc/ et lesquels manquent. 
Liste-les, ne code rien encore.
```

---

## PHASE 2 — Bridge Native / scrcpy

### Tâche 2.1 — État du bridge scrcpy existant
- [ ] Fait

**Prompt à donner :**
```
Audit src/native/scrcpy/ (h264-parser.js, scrcpy-socket.js, test-connection.js, 
control/). Pour chaque fichier, dis-moi à quoi il sert et s'il a l'air complet 
ou en cours (TODO, fonctions vides). Ne modifie rien.
```

### Tâche 2.2 — Détection des appareils ADB
- [ ] Fait

**Prompt à donner :**
```
Est-ce que la détection des appareils ADB connectés fonctionne déjà 
(via tools/adb.exe ou les packages @yume-chan) ? Teste-la si possible 
et montre-moi le résultat.
```

*(Les tâches suivantes de la Phase 2 seront détaillées une fois les tâches 2.1 et 2.2 validées — pas la peine de planifier dans le vide avant de savoir où en est le code réel.)*

---

### Tâche 2.3 — Lister les apps installées sur un appareil
- [ ] Fait

**Prompt à donner :**
```
Ajoute une fonction qui liste les applications installées sur un appareil 
Android connecté (via adb shell pm list packages ou l'équivalent @yume-chan/adb). 
Place-la dans le Manager ou le module le plus logique selon AI_CONTEXT.md 
(pas dans le Renderer). Montre-moi où tu la places et pourquoi avant de coder.
```

### Tâche 2.4 — Lancer un flux scrcpy pour une Session
- [ ] Fait

**Prompt à donner :**
```
Quand SessionManager.createSession(deviceId) est appelé, le flux scrcpy doit 
démarrer pour cet appareil (via src/native/scrcpy/). Vérifie si ce branchement 
existe déjà. Si non, propose-moi comment le faire SANS mettre de logique 
métier dans le Renderer (voir AI_CONTEXT.md section 2.1). Attends ma validation 
avant de coder.
```

### Tâche 2.5 — Réception du flux vidéo dans le Renderer
- [ ] Fait

**Prompt à donner :**
```
Vérifie comment le flux vidéo décodé (h264-parser.js) arrive jusqu'au Renderer 
pour être affiché dans un <canvas> ou <video>. Ça doit passer par IPC 
(docs/IPC_CONTRACT.md, canal session:video-frame). Dis-moi si ce canal existe 
déjà et fonctionne, ou ce qui manque.
```

---

## PHASE 3 — UI (Renderer)

### Tâche 3.1 — Audit du thème actuel
- [ ] Fait

**Prompt à donner :**
```
Regarde src/renderer/styles/style.css. Décris le thème actuel (couleurs, 
police, structure). Ne change rien — AI_CONTEXT.md section 3.1 dit que 
la direction artistique actuelle est validée et ne doit pas être refaite.
```

### Tâche 3.2 — Vue Sessions (liste des appareils)
- [ ] Fait

**Prompt à donner :**
```
Vérifie si src/renderer/devices.js affiche déjà la liste des appareils 
connectés avec leur état (Session disconnected/connecting/connected...). 
Si incomplet, complète-le en respectant le thème existant (Tâche 3.1), 
sans créer de nouveau système de navigation.
```

### Tâche 3.3 — Vue Layout SINGLE
- [ ] Fait

**Prompt à donner :**
```
Vérifie si le mode d'affichage SINGLE (une seule Session plein cadre, voir 
docs/LAYOUTS.md) est déjà géré dans le Renderer. Si non, implémente-le en 
respectant le découplage Layout/Canvas décrit dans docs/LAYOUTS.md section 3.
```

### Tâche 3.4 — Vue Layout MULTI
- [ ] Fait

**Prompt à donner :**
```
Même chose que la tâche 3.3 mais pour le mode MULTI (grille de plusieurs 
Sessions visibles). Vérifie d'abord l'existant (tabs.js, instance-manager.js 
semblent liés), complète seulement ce qui manque.
```

### Tâche 3.5 — Control Center (FPS, bitrate, pause/resume)
- [ ] Fait

**Prompt à donner :**
```
Ajoute ou complète un panneau de contrôle permettant de changer le FPS et 
le bitrate d'une Session (SessionManager.updateSettings), et de la mettre 
en pause/reprendre (pauseSession/resumeSession). Intègre-le dans l'UI 
existante, ne crée pas de nouvelle sidebar (AI_CONTEXT.md section 3.3).
```

---

## PHASE 4 — Fonctionnalités avancées

### Tâche 4.1 — Audit TransferManager
- [ ] Fait

**Prompt à donner :**
```
Le fichier src/main/managers/filemanager.js gère-t-il déjà une queue de 
transferts de fichiers vers/depuis l'appareil Android ? Décris ce qui 
existe. Ne modifie rien.
```

### Tâche 4.2 — Compléter le système de transferts
- [ ] Fait

**Prompt à donner :**
```
D'après ton audit (tâche 4.1), complète filemanager.js pour qu'il gère 
une queue de transferts indépendante de l'UI (voir AI_CONTEXT.md section 9). 
Ajoute le canal IPC transfer:enqueue et l'event transfer:progress 
(docs/IPC_CONTRACT.md) s'ils n'existent pas.
```

### Tâche 4.3 — Audit du moteur d'automations
- [ ] Fait

**Prompt à donner :**
```
Existe-t-il déjà un fichier ou module gérant des règles SI/ALORS (ex: 
"si batterie < 20% alors mode éco") ? Si non, dis-le simplement, ne crée 
rien encore.
```

### Tâche 4.4 — Créer AutomationEngine (version simple)
- [ ] Fait

**Prompt à donner :**
```
Crée un AutomationEngine simple dans src/main/managers/ qui peut déclencher 
une action quand une condition système est vraie (ex: batterie faible). 
Respecte la règle : une automation ne doit JAMAIS casser, supprimer une 
Session, ni modifier la structure UI (AI_CONTEXT.md section 11.3). 
Commence par UNE seule règle d'exemple, pas un système générique complexe.
```

### Tâche 4.5 — Performance Panel
- [ ] Fait

**Prompt à donner :**
```
Ajoute un panneau affichant des statistiques temps réel (FPS actuel, 
bitrate, nombre de Sessions actives). Utilise les données déjà présentes 
dans SessionManager, n'invente pas un second système de suivi d'état 
en parallèle (AI_CONTEXT.md interdit les sources de vérité dupliquées).
```

### Tâche 4.6 — Settings globaux
- [ ] Fait

**Prompt à donner :**
```
Vérifie l'état de src/main/managers/settings.js. Complète-le si besoin 
pour gérer des préférences globales (ex: bitrate par défaut, dossier de 
téléchargement des transferts). Expose-le proprement via IPC.
```

---

## PHASE 5 — Stabilisation

### Tâche 5.1 — Test de non-régression Sessions
- [ ] Fait

**Prompt à donner :**
```
Teste manuellement (ou décris comment tester) : créer 2-3 Sessions, changer 
de Layout plusieurs fois, changer le Focus. Vérifie qu'aucune Session n'est 
recréée inutilement (AI_CONTEXT.md section 4.2). Rapporte tout comportement 
anormal sans le corriger tout de suite.
```

### Tâche 5.2 — Gestion des reconnexions réseau
- [ ] Fait

**Prompt à donner :**
```
Vérifie ce qui se passe quand un appareil perd la connexion (wifi coupé, 
câble débranché). La Session doit passer en "reconnecting" puis retenter, 
pas planter ni disparaître (voir docs/SESSIONS.md section 2). Corrige si 
ce n'est pas déjà le cas.
```

### Tâche 5.3 — Packaging Windows final
- [ ] Fait

**Prompt à donner :**
```
Lance "npm run build" et vérifie que le .exe portable se génère correctement 
(electron-builder, déjà configuré dans package.json). Montre-moi les erreurs 
s'il y en a, sans les corriger avant de me les expliquer.
```

---

## Règle d'or

> Une tâche = une action vérifiable. Si une tâche te semble trop grosse 
> pour être validée d'un coup d'œil, découpe-la encore en sous-tâches 
> avant de la donner à l'IA.
