# NEW_SESSION_VIDEO_PIPELINE.md

## Objectif

Décrire le pipeline technique utilisé au lancement d'une nouvelle session Android,
depuis scrcpy/ADB jusqu'au rendu dans un canvas du Renderer.

## Pipeline cible

```text
Android app
   |
   | scrcpy-server (device)
   v
ADB reverse socket
   |
   v
Main Process (Electron)
   |
   | paquets H.264 (raw packet)
   v
Renderer (VideoDecoder / WebCodecs)
   |
   | frames decodees
   v
Canvas 2D
```

## Correspondance dans le code

1. Scrcpy + socket ADB:
   - `src/native/scrcpy/scrcpy-socket.js`
   - Le client ouvre le tunnel ADB reverse et lit les paquets video.

2. Reception et relay IPC:
   - `src/main/main.js`
   - Handler `start-video-stream` cree un `ScrcpySocketClient`.
   - Les evenements `raw-packet` sont relayes via `video-packet`.
   - Les metadonnees codec sont relayees via `video-codec-meta`.

3. Decodage video:
   - `src/renderer/video-player.js`
   - Le `VideoDecoder` decode les chunks H.264 (annexb).

4. Rendu:
   - `src/renderer/video-player.js`
   - Les frames decodees sont dessinees dans le canvas de l'instance.

5. UI Nouvelle session:
   - `src/renderer/new-session.js`
   - Affiche la progression du pipeline en temps reel:
     - ADB Socket connecte
     - Premier paquet H.264 recu
     - Decoder initialise
     - Canvas actif (premiere frame rendue)

## Note FFmpeg / SDL

Dans cette application Electron, le chemin de rendu actif est:

- H.264 -> WebCodecs VideoDecoder -> Canvas

et non:

- H.264 -> FFmpeg -> AVFrame -> SDL/OpenGL/Vulkan

Le resultat fonctionnel reste le meme (decode + rendu), avec une integration
nativement adaptee au Renderer Chromium.
