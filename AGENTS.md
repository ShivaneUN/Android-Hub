# Android Hub

Electron desktop app (`android-hub`) that displays and controls multiple Android devices from one PC using bundled `scrcpy` + `ADB`. It is a **Windows-targeted** GUI app: the production build (`npm run build`) is Windows/NSIS only, and the `tools/` directory ships **Windows binaries** (`adb.exe`, `scrcpy.exe`, `*.dll`). There is no backend server and no database — state is persisted to local JSON files in the Electron `userData` dir.

- Package manager: **npm** (`package-lock.json`). Main entry: `src/main/main.js`.
- Key scripts live in `package.json` (`start`, `dev`, `build`, `build:dir`, etc.) and `electron-builder.config.js`.
- There is **no automated test suite** (no `test` script); the repo relies on manual validation (see `PROGRESS_CHECK.md`, `AI_CONTEXT.md`).

## Cursor Cloud specific instructions

This environment is **Linux**, but the app is a **Windows-targeted Electron GUI**. Dev-mode Electron still runs on Linux (it downloads a Linux Electron binary during `npm install`), so the UI can be launched and exercised here, with these caveats:

- **Run the app on the existing VNC desktop, not a throwaway Xvfb**, so it's visible to computer-use tooling:
  `DISPLAY=:1 ./node_modules/.bin/electron . --no-sandbox`
  `--no-sandbox` is required (the container can't use the Chromium sandbox). Run it in a tmux session since it's a long-running foreground process; don't put it in the update/install script.
- `npm start` / `npm run dev` are written for Windows shells (`dev` uses `set VAR=...`). On Linux, launch Electron directly as above (optionally prefix `ANDROID_HUB_DEVTOOLS=1` to open DevTools).
- **Device features do NOT work on Linux.** `src/main/paths.js` hardcodes `tools/adb.exe` (a Windows binary), so device polling logs `adb.exe: Permission denied` and shows 0 devices. This is expected — mirroring/controlling a real Android device requires Windows + a physical/emulated device + USB/WiFi and cannot be exercised in this cloud VM. Do not treat these adb errors as setup failures.
- **Benign startup noise on Linux:** `Failed to connect to the bus` (no dbus), `Exiting GPU process ... viz_main_impl` / SwiftShader GL fallback, and the `[AutoUpdater] Mode développement` message are all normal in the headless container.
- What *is* verifiable here without a device: the window/UI renders, renderer↔main IPC works, and preferences persist. Example smoke test: toggle the **Langue** (FR/EN) sidebar control and confirm `~/.config/android-hub/ui-preferences.json` updates (`"locale"`), which exercises the IPC + `UiPreferencesManager` persistence path.
- `npm run build` targets Windows (`electron-builder --win`) and will not produce a usable artifact on Linux; use it only for packaging on a Windows host.
