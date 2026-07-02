# 🔌 IPC CONTRACT — Android Hub

> Complète la section 7 de `AI_CONTEXT.md`.
> Toute IA ajoutant une fonctionnalité doit étendre ce contrat plutôt que créer un canal parallèle.

---

## 1. Principe

Le Renderer n'a JAMAIS accès à `ipcRenderer` directement.
Il passe exclusivement par l'API exposée dans `src/preload/preload.js` via `contextBridge`.

```js
// preload.js (exemple de structure attendue)
contextBridge.exposeInMainWorld("androidHub", {
  sessions: {
    create: (deviceId) => ipcRenderer.invoke("session:create", deviceId),
    destroy: (sessionId) => ipcRenderer.invoke("session:destroy", sessionId),
    list: () => ipcRenderer.invoke("session:list"),
    onUpdate: (callback) => ipcRenderer.on("session:update", (_e, data) => callback(data)),
  },
  layout: {
    set: (layoutId) => ipcRenderer.invoke("layout:set", layoutId),
  },
  focus: {
    set: (sessionId) => ipcRenderer.invoke("focus:set", sessionId),
  },
});
```

---

## 2. Canaux IPC (Main ↔ Renderer)

### Invoke (Renderer → Main, avec réponse)

| Canal | Payload | Retour | Géré par |
|---|---|---|---|
| `session:create` | `deviceId: string, options?: object` | `{ success, session }` | SessionManager |
| `session:destroy` | `sessionId: string` | `{ success }` | SessionManager |
| `session:list` | — | `{ success, sessions }` | SessionManager |
| `session:get` | `sessionId: string` | `{ success, session }` | SessionManager |
| `session:pause` | `sessionId: string` | `{ success }` | SessionManager |
| `session:resume` | `sessionId: string` | `{ success }` | SessionManager |
| `layout:set` | `layoutId: string` | `{ success }` | LayoutManager |
| `layout:list` | — | `{ success, layouts }` | LayoutManager |
| `layout:create` | `mode: string, slots: array` | `{ success, layout }` | LayoutManager |
| `focus:set` | `sessionId: string` | `{ success }` | FocusManager |
| `focus:get` | — | `{ success, sessionId }` | FocusManager |
| `device:list` | — | `Device[]` | DeviceManager |
| `device:apps` | `serial: string` | `{ success, apps }` | DeviceManager |
| `device:info` | `serial: string` | `{ success, info }` | DeviceManager |
| `start-video-stream` | `{ serial, tabId, packageName, options }` | `{ success }` | ScrcpySocketClient |
| `stop-video-stream` | `tabId: string` | `{ success }` | ScrcpySocketClient |
| `send-input` | `payload` | `void` | AdbInputController |

### Events (Main → Renderer, push)

| Canal | Payload | Description |
|---|---|---|
| `session:update` | `Session` | État d'une Session a changé |
| `focus:changed` | `{ sessionId }` | Le Focus a changé de Session |
| `video-codec-meta` | `{ tabId, codecId, width, height }` | Métadonnées codec reçues |
| `video-packet` | `{ tabId, pts, isConfig, isKeyFrame, data }` | Paquet vidéo brut H.264 |
| `video-error` | `{ tabId, error }` | Erreur de flux vidéo |

---

## 3. Règles strictes

1. **Jamais d'appel direct** entre Renderer et Native — tout passe par Main.
2. **Jamais de logique métier dans un handler IPC** — le handler appelle un Manager,
   il ne contient pas lui-même la logique (validation simple OK, business logic NON).
3. **Tout nouveau canal doit être documenté ici** avant d'être implémenté.
4. **Nommage des canaux** : `domaine:action` (kebab/colon case), ex. `session:create`, `layout:set`.

---

## 4. Notes techniques

### Flux vidéo

Le flux vidéo utilise une approche **WebCodecs** (décodage dans le Renderer) :

1. Main → `video-codec-meta` : envoi des métadonnées codec (width, height, codecId)
2. Main → `video-packet` : envoi des paquets H.264 bruts avec PTS
3. Renderer : WebCodecs VideoDecoder décode les paquets
4. Renderer : `canvas.getContext('2d').drawImage()` affiche les frames

**Note** : Le canal `session:video-frame` initialement prévu dans le contrat n'est pas utilisé
car le décodage H.264 via WebCodecs doit se faire dans le Renderer (pas d'accès à cette API
dans le Main Process). Les paquets bruts sont donc envoyés directement au décodeur.