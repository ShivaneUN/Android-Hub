# 📱 SESSIONS — Spécification détaillée

> Complète la section 4 de `AI_CONTEXT.md`.

---

## 1. Modèle de données

```ts
interface Session {
  id: string;              // uuid unique de la session
  deviceId: string;        // serial ADB de l'appareil
  deviceName: string;      // nom lisible (ex: "Pixel 7")
  state: SessionState;
  video: {
    fps: number;
    bitrate: number;       // en Mbps
    resolution: string;    // ex: "1080x2400"
  };
  inputChannel: InputChannelRef;
  createdAt: number;
  lastActiveAt: number;
}

type SessionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "paused"
  | "error";
```

---

## 2. Cycle de vie d'une Session

```
disconnected
     │ (connect())
     ▼
connecting
     │ (succès)              │ (échec)
     ▼                       ▼
connected                  error
     │ (perte réseau)         │ (retry)
     ▼                       │
reconnecting ◄────────────────┘
     │ (succès)
     ▼
connected
     │ (pause utilisateur)
     ▼
paused
```

---

## 3. Règles strictes

1. **Une Session n'est jamais créée par un Layout.**
   Elle est créée par `SessionManager.createSession(deviceId)` à la demande explicite (ajout d'un appareil).

2. **Une Session peut exister sans être affichée.**
   Exemple : 4 Sessions actives, mais le Layout en mode SINGLE n'en affiche qu'une. Les 3 autres continuent de tourner en arrière-plan (stream actif, input possible si Focus dessus).

3. **Une Session ne doit jamais être recréée inutilement.**
   Changer de Layout, changer de Focus, ou rouvrir un onglet ne doit **jamais** déclencher une nouvelle connexion scrcpy si la Session existe déjà.

4. **Le SessionManager est la seule source de vérité.**
   Le Renderer ne maintient aucun état de Session en propre — il reflète uniquement ce que le Main lui envoie via IPC (`session:update` events).

---

## 4. API attendue (Main Process)

```js
SessionManager.createSession(deviceId)        // → Session
SessionManager.destroySession(sessionId)      // → void
SessionManager.getSession(sessionId)          // → Session | null
SessionManager.listSessions()                 // → Session[]
SessionManager.pauseSession(sessionId)        // → void
SessionManager.resumeSession(sessionId)       // → void
SessionManager.updateSettings(sessionId, { fps, bitrate }) // → void
```

Toute IA ajoutant une fonctionnalité liée aux Sessions doit étendre cette API,
**jamais** la dupliquer ou créer un second gestionnaire d'état parallèle.
