# Ressources de build

Icône Windows pour electron-builder :

- `icon.ico` — ICO multi-résolutions (16, 32, 48, 256 px)
- `icon.png` — PNG haute résolution (source)

Source canonique UI : `src/assets/icons/android-hub-logo.png`  
Copie runtime fenêtre : `src/assets/icons/icon.ico`

Regénérer les `.ico` depuis le PNG : `npm run icons`

Configuration dans `package.json` → `build.win.icon` et `build.nsis.installerIcon`.
