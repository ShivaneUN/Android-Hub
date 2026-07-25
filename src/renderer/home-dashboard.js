(function () {
  let recentEntries = [];
  /** Nombre max de pastilles compactes visibles ; le reste passe dans +N. */
  const DOCK_BATTERY_VISIBLE_MAX = 5;
  let dockMoreOpen = false;
  let homeSessionsCache = [];
  let homeSessionsKey = "";
  let homeFpsBySession = {};
  let homePreviewTimer = null;
  let homePreviewInFlight = false;
  let pendingCloseSessionId = null;

  function escapeAttr(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function batteryTone(battery) {
    if (battery === null || battery === undefined || Number.isNaN(battery)) return "unknown";
    if (battery <= 20) return "low";
    if (battery <= 50) return "medium";
    return "good";
  }

  function formatBattery(battery) {
    if (battery === null || battery === undefined || Number.isNaN(battery)) return "—";
    return `${Math.round(battery)}%`;
  }

  function batteryFillWidth(battery) {
    if (battery === null || battery === undefined || Number.isNaN(battery)) return 0;
    return Math.max(0, Math.min(14, (Math.round(battery) / 100) * 14));
  }

  function hasActiveStream() {
    return Boolean(document.querySelector(".content.content--session-view"));
  }

  function getStreamingDeviceKeys() {
    const keys = new Set();
    document.querySelectorAll(".scrcpy-tab").forEach((tab) => {
      const key = tab.dataset.deviceKey || tab.dataset.deviceId || "";
      if (key) keys.add(key);
    });
    return keys;
  }

  function batteryIconSvg(battery, tone) {
    const fill = batteryFillWidth(battery).toFixed(1);
    return (
      `<svg class="dock-battery-icon" viewBox="0 0 24 24" aria-hidden="true">` +
      `<rect x="2" y="7" width="18" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/>` +
      `<rect x="20" y="10" width="2" height="4" rx="0.5" fill="currentColor"/>` +
      `<rect class="dock-battery-fill dock-battery-fill-${tone}" x="4" y="9" width="${fill}" height="6" rx="1" fill="currentColor"/>` +
      `</svg>`
    );
  }

  function hasConnectedDevice() {
    const devices = typeof window.getCurrentDevices === "function" ? window.getCurrentDevices() : [];
    return devices.some((device) => device?.connected !== false);
  }

  function syncEmptyStateIntro() {
    const intro = document.getElementById("empty-state-intro");
    const appsSection = document.querySelector(".home-apps-section");
    const devicesSection = document.querySelector(".home-devices-section");
    const sessionsSection = document.querySelector(".home-sessions-section");
    const actionsSection = document.querySelector(".home-actions-section");
    const connected = hasConnectedDevice();
    if (intro) intro.hidden = connected;
    if (appsSection) appsSection.hidden = !connected;
    if (devicesSection) devicesSection.hidden = !connected;
    if (sessionsSection) sessionsSection.hidden = !connected;
    if (actionsSection) actionsSection.hidden = !connected;
    if (connected) {
      void syncHomeSessions();
    } else {
      stopHomePreviewPolling();
      homeSessionsKey = "";
      homeSessionsCache = [];
      const grid = document.getElementById("home-sessions-grid");
      const empty = document.getElementById("home-sessions-empty");
      if (grid) grid.innerHTML = "";
      if (empty) empty.hidden = true;
      syncHomeMascot(0);
      hideCloseConfirm();
    }
  }

  function syncHomeMascot(sessionCount) {
    const mascot = document.querySelector(".empty-state-mascot");
    if (!mascot) return;
    // Logo visible tant qu'aucune session n'est ouverte (même avec appareil connecté).
    mascot.hidden = Number(sessionCount) > 0;
  }

  function tHome(key, fallback) {
    return globalThis.HubI18n?.t?.(key) || fallback;
  }

  function sessionsFromTabBar() {
    const tabs = document.querySelectorAll(".scrcpy-tab");
    return Array.from(tabs).map((tab) => {
      const labelEl = tab.querySelector(".tab-label");
      const raw = labelEl?.textContent?.replace(/\s+/g, " ").trim() || tab.dataset.tabId;
      const badge = labelEl?.querySelector(".session-type-badge");
      const label = badge ? raw.replace(badge.textContent, "").trim() : raw;
      return {
        sessionId: tab.dataset.tabId,
        type: tab.dataset.sessionType || "A",
        label: label || tab.dataset.tabId,
        active: tab.classList.contains("active")
      };
    }).filter((session) => session.sessionId);
  }

  async function fetchHomeSessions() {
    let list = [];
    try {
      if (window.sessionAPI?.list) {
        list = await window.sessionAPI.list();
      }
    } catch (_err) {
      list = [];
    }
    if (Array.isArray(list) && list.length) return list;
    return sessionsFromTabBar();
  }

  function isHomeVisible() {
    const page = document.getElementById("page-new");
    return Boolean(
      document.body.classList.contains("theme-tablet")
      && page
      && !page.classList.contains("hidden")
      && window.__hubShowingHome
    );
  }

  function hideCloseConfirm() {
    pendingCloseSessionId = null;
    document.getElementById("home-session-close-confirm")?.classList.add("hidden");
  }

  function showCloseConfirm(sessionId, label) {
    pendingCloseSessionId = sessionId;
    const dialog = document.getElementById("home-session-close-confirm");
    const lead = document.getElementById("home-session-close-lead");
    if (lead) lead.textContent = label || sessionId || "";
    dialog?.classList.remove("hidden");
  }

  async function closeHomeSession(sessionId) {
    if (!sessionId) return;
    try {
      if (sessionId.startsWith("instance-") && typeof closeInstance === "function") {
        await closeInstance(sessionId);
      } else if (typeof closeNewInstanceSession === "function") {
        await closeNewInstanceSession(sessionId, "home-session-close");
      } else if (window.sessionAPI?.close) {
        await window.sessionAPI.close(sessionId);
        if (typeof renderSidebar === "function") await renderSidebar();
      }
    } catch (err) {
      console.error("[HomeDashboard] closeHomeSession:", err);
    }
    hideCloseConfirm();
    await syncHomeSessions();
  }

  function homeSessionsSignature(sessions) {
    return (Array.isArray(sessions) ? sessions : [])
      .map((session) => `${session.sessionId}:${session.active ? 1 : 0}:${session.label || ""}`)
      .join("|");
  }

  function bindHomeSessionTile(tile) {
    const activate = () => {
      const sessionId = tile.dataset.sessionId;
      if (!sessionId) return;
      if (typeof window.activateSessionTab === "function") {
        void window.activateSessionTab(sessionId);
      } else if (window.sessionAPI?.switchTo) {
        void window.sessionAPI.switchTo(sessionId);
      }
    };
    tile.addEventListener("click", (event) => {
      if (event.target.closest?.("[data-home-session-close]")) return;
      activate();
    });
    tile.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activate();
    });
    tile.querySelector("[data-home-session-close]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const sessionId = event.currentTarget.getAttribute("data-home-session-close");
      const session = homeSessionsCache.find((item) => item.sessionId === sessionId);
      showCloseConfirm(sessionId, session?.label || sessionId);
    });
  }

  function renderHomeSessions(sessions) {
    const grid = document.getElementById("home-sessions-grid");
    const empty = document.getElementById("home-sessions-empty");
    if (!grid || !empty) return;

    homeSessionsCache = Array.isArray(sessions) ? sessions : [];
    syncHomeMascot(homeSessionsCache.length);

    if (!homeSessionsCache.length) {
      homeSessionsKey = "";
      grid.innerHTML = "";
      empty.hidden = false;
      stopHomePreviewPolling();
      return;
    }

    empty.hidden = true;
    const nextKey = homeSessionsSignature(homeSessionsCache);
    if (nextKey === homeSessionsKey && grid.querySelector(".home-session-tile")) {
      homeSessionsCache.forEach((session) => {
        const tile = grid.querySelector(`.home-session-tile[data-session-id="${CSS.escape(session.sessionId)}"]`);
        if (!tile) return;
        tile.classList.toggle("is-active", Boolean(session.active));
        const name = tile.querySelector(".home-session-name");
        if (name && session.label) name.textContent = session.label;
        const fpsBadge = tile.querySelector("[data-session-fps]");
        if (fpsBadge) {
          const fps = homeFpsBySession[session.sessionId];
          fpsBadge.textContent = fps === null || fps === undefined ? "— fps" : `${fps} fps`;
        }
      });
      startHomePreviewPolling();
      return;
    }

    homeSessionsKey = nextKey;
    const liveLabel = tHome("homeDashboard.live", "LIVE");
    const previousThumbs = new Map();
    grid.querySelectorAll(".home-session-tile").forEach((tile) => {
      const id = tile.dataset.sessionId;
      const img = tile.querySelector("img.home-session-thumb");
      if (id && img?.src) previousThumbs.set(id, img.src);
    });

    grid.innerHTML = homeSessionsCache.map((session) => {
      const id = session.sessionId;
      const label = session.label || id;
      const fps = homeFpsBySession[id];
      const fpsText = fps === null || fps === undefined ? "— fps" : `${fps} fps`;
      const activeClass = session.active ? " is-active" : "";
      const keptSrc = previousThumbs.get(id);
      const thumbHtml = keptSrc
        ? `<img class="home-session-thumb" data-session-thumb="${escapeAttr(id)}" src="${escapeAttr(keptSrc)}" alt="">`
        : `<div class="home-session-thumb-fallback" data-session-thumb="${escapeAttr(id)}">${escapeHtml(label)}</div>`;
      return (
        `<div class="home-session-tile${activeClass}" data-session-id="${escapeAttr(id)}" title="${escapeAttr(label)}" role="button" tabindex="0">` +
        `<span class="home-session-live">${escapeHtml(liveLabel)}</span>` +
        `<span class="home-session-fps" data-session-fps="${escapeAttr(id)}">${escapeHtml(fpsText)}</span>` +
        `<button type="button" class="home-session-close" data-home-session-close="${escapeAttr(id)}" aria-label="${escapeAttr(tHome("homeDashboard.closeSessionConfirm", "Fermer"))}">&#10005;</button>` +
        thumbHtml +
        `<div class="home-session-meta"><span class="home-session-name">${escapeHtml(label)}</span></div>` +
        `</div>`
      );
    }).join("");

    grid.querySelectorAll(".home-session-tile").forEach(bindHomeSessionTile);
    startHomePreviewPolling();
    void refreshHomeSessionPreviews();
  }

  async function syncHomeSessions() {
    if (!document.body.classList.contains("theme-tablet")) return;
    if (!hasConnectedDevice()) {
      syncHomeMascot(0);
      return;
    }
    const sessions = await fetchHomeSessions();
    renderHomeSessions(sessions);
  }

  async function refreshHomeSessionPreviews() {
    if (!isHomeVisible() || !window.sessionAPI?.getPreviewFrame || homePreviewInFlight) return;
    homePreviewInFlight = true;
    try {
      const hosts = document.querySelectorAll("#home-sessions-grid [data-session-thumb]");
      for (const host of hosts) {
        const sessionId = host.getAttribute("data-session-thumb");
        if (!sessionId) continue;
        try {
          const result = await window.sessionAPI.getPreviewFrame(sessionId);
          if (!result?.available || !result.dataUrl) continue;
          if (host.tagName === "IMG") {
            if (host.src !== result.dataUrl) host.src = result.dataUrl;
            continue;
          }
          const tile = host.closest(".home-session-tile");
          if (!tile) continue;
          const img = document.createElement("img");
          img.className = "home-session-thumb";
          img.alt = "";
          img.setAttribute("data-session-thumb", sessionId);
          img.src = result.dataUrl;
          host.replaceWith(img);
        } catch (_err) {
          /* ignore */
        }
      }
    } finally {
      homePreviewInFlight = false;
    }
  }

  function startHomePreviewPolling() {
    if (homePreviewTimer) return;
    homePreviewTimer = window.setInterval(() => {
      if (!isHomeVisible()) {
        stopHomePreviewPolling();
        return;
      }
      void refreshHomeSessionPreviews();
    }, 1500);
  }

  function stopHomePreviewPolling() {
    if (!homePreviewTimer) return;
    window.clearInterval(homePreviewTimer);
    homePreviewTimer = null;
  }

  function updateHomeSessionFps(fpsBySession) {
    homeFpsBySession = fpsBySession && typeof fpsBySession === "object" ? fpsBySession : {};
    document.querySelectorAll("[data-session-fps]").forEach((badge) => {
      const sessionId = badge.getAttribute("data-session-fps");
      const fps = homeFpsBySession[sessionId];
      badge.textContent = fps === null || fps === undefined ? "— fps" : `${fps} fps`;
    });
  }

  async function openStreamDeckFromHome() {
    try {
      // Quitter l'accueil AVANT d'activer Stream Deck, sinon le layout
      // se calcule avec __hubShowingHome=true et le flux reste suppressé.
      window.__hubShowingHome = false;
      stopHomePreviewPolling();
      hideCloseConfirm();

      document.querySelectorAll(".content > .page").forEach((page) => page.classList.add("hidden"));
      document.getElementById("nav-home")?.classList.remove("active");

      const content = document.querySelector(".content");
      if (content) {
        content.classList.add("content--session-view");
      }

      // Lever immédiatement le mask 0×0 laissé par l'Accueil.
      if (window.sessionAPI?.restoreView) {
        await window.sessionAPI.restoreView();
      }

      if (window.getStreamDeckMode?.() !== true) {
        window.setStreamDeckMode?.(true);
      }
      window.updateStreamDeckToggle?.();

      const sessions = await fetchHomeSessions();
      if (sessions.length && typeof window.activateSessionTab === "function") {
        const active = sessions.find((session) => session.active) || sessions[0];
        await window.activateSessionTab(active.sessionId);
      }

      window.refreshStreamDeckBar?.();
      window.refreshStreamDeckZone?.();

      await new Promise((resolve) => setTimeout(resolve, 64));
      window.refreshStreamDeckZone?.();
      if (typeof window.invalidateVideoLayoutBoundsCache === "function") {
        window.invalidateVideoLayoutBoundsCache();
      }
      if (window.sessionAPI?.restoreView) {
        await window.sessionAPI.restoreView();
      }
      if (typeof reportContentBounds === "function") {
        reportContentBounds();
      }
    } catch (err) {
      console.error("[HomeDashboard] openStreamDeckFromHome:", err);
    }
  }

  function hideWifiReconnectPopup() {
    const popup = document.getElementById("home-wifi-reconnect-popup");
    if (!popup) return;
    popup.classList.add("hidden");
    popup.setAttribute("hidden", "");
  }

  function wifiReconnectSubLine(entry) {
    if (entry?.adbTarget) return String(entry.adbTarget);
    const ip = entry?.ip;
    if (!ip) return "";
    return `${ip}:${entry.port || 5555}`;
  }

  function renderWifiReconnectList(entries) {
    const list = document.getElementById("home-wifi-reconnect-list");
    if (!list) return;

    if (!entries.length) {
      list.innerHTML = `<p class="home-wifi-reconnect-empty">${escapeHtml(tHome("homeDashboard.wifiReconnectEmpty", "Aucun appareil Wi‑Fi enregistré"))}</p>`;
      return;
    }

    list.innerHTML = entries.map((entry) => {
      const deviceId = entry.deviceId || entry.serial || "";
      const name = entry.name || deviceId;
      const sub = wifiReconnectSubLine(entry);
      const online = entry.adbState === "connected";
      const statusLabel = online
        ? tHome("devicesPanel.online", "En ligne")
        : tHome("devicesPanel.offline", "Hors ligne");
      return (
        `<div class="home-wifi-reconnect-row" data-device-id="${escapeAttr(deviceId)}">` +
        `<div class="home-wifi-reconnect-row-main">` +
        `<div class="home-wifi-reconnect-row-name">${escapeHtml(name)}</div>` +
        (sub ? `<div class="home-wifi-reconnect-row-sub">${escapeHtml(sub)}</div>` : "") +
        `<div class="home-wifi-reconnect-row-status${online ? " is-online" : ""}">` +
        `<span class="home-wifi-reconnect-dot" aria-hidden="true"></span>${escapeHtml(statusLabel)}` +
        `</div>` +
        `</div>` +
        `<button type="button" class="home-wifi-reconnect-action" data-wifi-reconnect="${escapeAttr(deviceId)}">` +
        `${escapeHtml(tHome("homeDashboard.wifiReconnectAction", "Reconnecter"))}` +
        `</button>` +
        `</div>`
      );
    }).join("");
  }

  async function openWifiReconnectPopup() {
    const popup = document.getElementById("home-wifi-reconnect-popup");
    const list = document.getElementById("home-wifi-reconnect-list");
    if (!popup || !list) return;

    popup.classList.remove("hidden");
    popup.removeAttribute("hidden");
    list.innerHTML = `<p class="home-wifi-reconnect-status">${escapeHtml(tHome("homeDashboard.wifiReconnectLoading", "Chargement…"))}</p>`;

    try {
      const response = await window.wifiAPI?.getPanelData?.();
      if (!response?.success) {
        list.innerHTML = `<p class="home-wifi-reconnect-status">${escapeHtml(tHome("homeDashboard.wifiReconnectError", "Impossible de charger la liste"))}</p>`;
        return;
      }
      renderWifiReconnectList(Array.isArray(response.wifi) ? response.wifi : []);
    } catch (_err) {
      list.innerHTML = `<p class="home-wifi-reconnect-status">${escapeHtml(tHome("homeDashboard.wifiReconnectError", "Impossible de charger la liste"))}</p>`;
    }
  }

  async function reconnectWifiDevice(deviceId, button) {
    if (!deviceId || !window.wifiAPI?.reconnect) return;
    if (button) button.disabled = true;
    try {
      const result = await window.wifiAPI.reconnect({ deviceId });
      if (result?.success) {
        window.showHubToast?.(result.message || tHome("devicesPanel.toastReconnected", "Reconnecté en WiFi"), "success");
        await openWifiReconnectPopup();
      } else {
        window.showHubToast?.(result?.error || tHome("devicesPanel.toastReconnectFailed", "Échec de la reconnexion"), "error");
      }
    } catch (_err) {
      window.showHubToast?.(tHome("devicesPanel.toastReconnectFailed", "Échec de la reconnexion"), "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  function bindWifiReconnectUi() {
    const btn = document.getElementById("home-wifi-reconnect-btn");
    if (!btn || btn.dataset.wifiReconnectBound === "1") return;
    btn.dataset.wifiReconnectBound = "1";

    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const popup = document.getElementById("home-wifi-reconnect-popup");
      if (popup && !popup.classList.contains("hidden") && !popup.hasAttribute("hidden")) {
        hideWifiReconnectPopup();
        return;
      }
      void openWifiReconnectPopup();
    });

    document.getElementById("home-wifi-reconnect-close")?.addEventListener("click", () => {
      hideWifiReconnectPopup();
    });

    document.getElementById("home-wifi-reconnect-list")?.addEventListener("click", (event) => {
      const actionBtn = event.target?.closest?.("[data-wifi-reconnect]");
      if (!actionBtn) return;
      const deviceId = actionBtn.getAttribute("data-wifi-reconnect");
      void reconnectWifiDevice(deviceId, actionBtn);
    });
  }

  function bindHomeActions() {
    const root = document.querySelector(".empty-state");
    if (!root || root.dataset.homeActionsBound === "1") return;
    root.dataset.homeActionsBound = "1";

    document.getElementById("home-action-new-instance")?.addEventListener("click", () => {
      if (typeof window.openNewSessionPanelFromMain === "function") {
        void window.openNewSessionPanelFromMain();
      } else if (typeof window.openNewSessionPanel === "function") {
        void window.openNewSessionPanel();
      }
    });

    document.getElementById("home-action-stream-deck")?.addEventListener("click", () => {
      void openStreamDeckFromHome();
    });

    document.getElementById("home-session-close-cancel")?.addEventListener("click", () => {
      hideCloseConfirm();
    });

    document.getElementById("home-session-close-ok")?.addEventListener("click", () => {
      const sessionId = pendingCloseSessionId;
      void closeHomeSession(sessionId);
    });
  }

  function wifiIconSvg() {
    return (
      `<svg class="flyout-wifi-icon" viewBox="0 0 24 24" aria-hidden="true">` +
      `<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5a9 9 0 0 1 14 0"/>` +
      `<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M8.5 15.5a5 5 0 0 1 7 0"/>` +
      `<circle cx="12" cy="19" r="1.2" fill="currentColor"/>` +
      `</svg>`
    );
  }

  function buildDockFlyoutInnerHtml(device) {
    const audioUi = window.__deviceAudioUi;
    const t = (key, fallback) => globalThis.HubI18n?.t?.(key) || fallback;
    const level = formatBattery(device.battery);
    const tone = batteryTone(device.battery);
    const key = device.deviceId || device.serial || "";
    const audioOn = audioUi?.isOn?.(device) !== false;
    const audioIcon = audioOn ? (audioUi?.iconOn || "") : (audioUi?.iconOff || "");
    const audioLabel = audioOn
      ? t("sidebar.devicePanel.flyoutAudioOn", "Audio")
      : t("sidebar.devicePanel.flyoutMuted", "Muet");
    const wifiLabel = t("sidebar.devicePanel.flyoutWifi", "Wi‑Fi");
    const canToggleWifi = Boolean(
      device.usbSerial
      || device.wifiConfigured
      || (device.transport === "wifi" && device.connected !== false)
    );
    const wifiChecked = Boolean(
      device.wifiActive
      || (device.wifiEnabled && device.transport === "wifi" && device.connected !== false)
      || (device.wifiEnabled && device.wifiAvailable)
    );
    const wifiBusy = Boolean(
      (device.deviceId && window.__deviceWifiUi?.isInFlight?.(device.deviceId))
      || (device.serial && window.__deviceWifiUi?.isInFlight?.(device.serial))
    );

    const wifiRow = canToggleWifi
      ? (
        `<div class="flyout-row flyout-row-wifi">` +
        `<span class="flyout-row-main">` +
        wifiIconSvg() +
        `<span class="flyout-row-label">${escapeHtml(wifiLabel)}</span>` +
        `</span>` +
        `<label class="sidebar-wifi-toggle dock-device-wifi-toggle" aria-label="${escapeAttr(wifiLabel)}">` +
        `<input type="checkbox" class="sidebar-wifi-toggle-input" data-device-id="${escapeAttr(device.deviceId || "")}" ${wifiChecked ? "checked" : ""}${wifiBusy ? " disabled" : ""}>` +
        `<span class="sidebar-wifi-toggle-ui"></span>` +
        `</label>` +
        `</div>`
      )
      : "";

    return (
      `<div class="flyout-row flyout-row-battery dock-battery-${tone}">` +
      batteryIconSvg(device.battery, tone) +
      `<span class="flyout-pct">${level}</span>` +
      `</div>` +
      `<button type="button" class="flyout-row flyout-row-audio dock-device-audio-btn ${audioOn ? "audio-on" : "audio-off"}" data-device-key="${escapeAttr(key)}" aria-label="${escapeAttr(audioLabel)}">` +
      audioIcon +
      `<span class="flyout-row-label">${escapeHtml(audioLabel)}</span>` +
      `</button>` +
      wifiRow
    );
  }

  function findDockDevice(deviceId, serial) {
    const devicesNow = typeof window.getCurrentDevices === "function" ? window.getCurrentDevices() : [];
    return devicesNow.find((d) => d.deviceId === deviceId || d.serial === serial) || null;
  }

  function buildDockDeviceChip(device, { variant = "compact" } = {}) {
    const audioUi = window.__deviceAudioUi;
    const name = device.name || device.serial || "Device";
    const level = formatBattery(device.battery);
    const tone = batteryTone(device.battery);
    const key = device.deviceId || device.serial || "";
    const color = device.deviceColor?.hex || "";
    const colorStyle = color ? ` style="--device-chip-color:${escapeAttr(color)}"` : "";
    const audioOn = audioUi?.isOn?.(device) !== false;
    const audioIcon = audioOn ? (audioUi?.iconOn || "") : (audioUi?.iconOff || "");
    const audioLabel = globalThis.HubI18n?.t?.("sidebar.devicePanel.audioToggle") || "Audio";
    const wifiLabel = globalThis.HubI18n?.t?.("sidebar.devicePanel.wifiToggle") || "WiFi";
    const canToggleWifi = Boolean(
      device.usbSerial
      || device.wifiConfigured
      || (device.transport === "wifi" && device.connected !== false)
    );
    const wifiChecked = Boolean(
      device.wifiActive
      || (device.wifiEnabled && device.transport === "wifi" && device.connected !== false)
      || (device.wifiEnabled && device.wifiAvailable)
    );
    const wifiHtml = canToggleWifi
      ? (
        `<label class="sidebar-wifi-toggle dock-device-wifi-toggle" data-dock-tip="${escapeAttr(wifiLabel)}" aria-label="${escapeAttr(wifiLabel)}">` +
        `<input type="checkbox" class="sidebar-wifi-toggle-input" data-device-id="${escapeAttr(device.deviceId || "")}" ${wifiChecked ? "checked" : ""}>` +
        `<span class="sidebar-wifi-toggle-ui"></span>` +
        `</label>`
      )
      : "";
    const controls =
      `<span class="dock-device-chip-controls">` +
      `<button type="button" class="sidebar-device-audio-btn dock-device-audio-btn ${audioOn ? "audio-on" : "audio-off"}" data-device-key="${escapeAttr(key)}" data-dock-tip="${escapeAttr(audioLabel)}" aria-label="${escapeAttr(audioLabel)}">` +
      audioIcon +
      `</button>` +
      wifiHtml +
      `</span>`;
    const batteryHtml =
      `<span class="dock-battery-item dock-battery-${tone}"${variant === "menu" ? ` data-dock-tip="${escapeAttr(name)}"` : ""}>` +
      batteryIconSvg(device.battery, tone) +
      `<span class="dock-battery-pct">${level}</span>` +
      `</span>`;

    if (variant === "compact") {
      return (
        `<div class="dock-device-chip dock-device-chip--compact${color ? " has-device-color" : ""}" data-device-id="${escapeAttr(device.deviceId || "")}" data-serial="${escapeAttr(device.serial || "")}"${colorStyle}>` +
        batteryHtml +
        `</div>`
      );
    }

    return (
      `<div class="dock-device-chip dock-device-chip--menu${color ? " has-device-color" : ""}" data-device-id="${escapeAttr(device.deviceId || "")}" data-serial="${escapeAttr(device.serial || "")}"${colorStyle}>` +
      `<span class="dock-device-chip-name">${escapeHtml(name)}</span>` +
      batteryHtml +
      controls +
      `</div>`
    );
  }

  let flyoutHideTimer = null;
  let flyoutActiveKey = "";

  function clearFlyoutHideTimer() {
    if (flyoutHideTimer) {
      clearTimeout(flyoutHideTimer);
      flyoutHideTimer = null;
    }
  }

  function hideChipFlyout() {
    clearFlyoutHideTimer();
    flyoutActiveKey = "";
    window.dockChipFlyoutAPI?.hide?.();
  }

  function showChipFlyout(chip) {
    if (!chip || !window.dockChipFlyoutAPI?.show) return;
    const deviceId = chip.dataset.deviceId || "";
    const serial = chip.dataset.serial || "";
    const device = findDockDevice(deviceId, serial);
    if (!device) return;

    const key = deviceId || serial;
    clearFlyoutHideTimer();
    const alreadyOpen = flyoutActiveKey === key;
    flyoutActiveKey = key;
    const html = buildDockFlyoutInnerHtml(device);

    if (alreadyOpen && window.dockChipFlyoutAPI.update) {
      void window.dockChipFlyoutAPI.update({ deviceId, serial, html });
      return;
    }

    const rect = chip.getBoundingClientRect();
    void window.dockChipFlyoutAPI.show({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      deviceId,
      serial,
      html
    });
  }

  function scheduleHideChipFlyout() {
    clearFlyoutHideTimer();
    flyoutHideTimer = setTimeout(() => {
      hideChipFlyout();
    }, 280);
  }

  function bindCompactFlyouts(root) {
    root.querySelectorAll(".dock-device-chip--compact").forEach((chip) => {
      chip.addEventListener("pointerenter", () => {
        showChipFlyout(chip);
      });
      chip.addEventListener("pointerleave", () => {
        if (!chip.isConnected) return;
        scheduleHideChipFlyout();
      });
    });
  }

  function refreshOpenFlyoutContent() {
    if (!flyoutActiveKey || !window.dockChipFlyoutAPI?.update) return;
    const device = findDockDevice(flyoutActiveKey, flyoutActiveKey);
    if (!device) {
      hideChipFlyout();
      return;
    }
    clearFlyoutHideTimer();
    void window.dockChipFlyoutAPI.update({
      deviceId: device.deviceId || "",
      serial: device.serial || "",
      html: buildDockFlyoutInnerHtml(device)
    });
  }

  window.refreshOpenDockFlyout = refreshOpenFlyoutContent;

  window.__dockChipFlyoutHost = {
    onOverlayHidden() {
      flyoutActiveKey = "";
      clearFlyoutHideTimer();
    },
    keepOpen() {
      clearFlyoutHideTimer();
    },
    async toggleAudio(payload = {}) {
      const device = findDockDevice(payload.deviceId, payload.serial);
      if (!device || !window.__deviceAudioUi?.toggle) return { ok: false };
      clearFlyoutHideTimer();
      flyoutActiveKey = payload.deviceId || payload.serial || flyoutActiveKey;
      await window.__deviceAudioUi.toggle(device);
      if (window.__deviceAudioUi?.refreshState) {
        await window.__deviceAudioUi.refreshState();
      }
      const updated = findDockDevice(payload.deviceId, payload.serial) || device;
      return {
        ok: true,
        deviceId: payload.deviceId || "",
        serial: payload.serial || "",
        html: buildDockFlyoutInnerHtml(updated)
      };
    },
    async toggleWifi(payload = {}) {
      const device = findDockDevice(payload.deviceId, payload.serial);
      if (!device || !window.__deviceWifiUi?.toggle) return { ok: false };
      clearFlyoutHideTimer();
      flyoutActiveKey = payload.deviceId || payload.serial || flyoutActiveKey;
      await window.__deviceWifiUi.toggle(device, Boolean(payload.checked));
      const updated = findDockDevice(payload.deviceId, payload.serial) || device;
      return {
        ok: true,
        deviceId: payload.deviceId || "",
        serial: payload.serial || "",
        html: buildDockFlyoutInnerHtml(updated)
      };
    },
    async refreshFlyout(payload = {}) {
      const device = findDockDevice(payload.deviceId, payload.serial);
      if (!device) return { ok: false };
      return {
        ok: true,
        deviceId: payload.deviceId || "",
        serial: payload.serial || "",
        html: buildDockFlyoutInnerHtml(device)
      };
    }
  };

  function bindDockChipInteractions(root) {
    if (!root) return;

    root.querySelectorAll(".dock-device-audio-btn").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const chip = btn.closest(".dock-device-chip");
        const deviceId = chip?.dataset.deviceId || "";
        const serial = chip?.dataset.serial || "";
        const devicesNow = typeof window.getCurrentDevices === "function" ? window.getCurrentDevices() : [];
        const device = devicesNow.find((d) => d.deviceId === deviceId || d.serial === serial);
        if (!device || !window.__deviceAudioUi?.toggle) return;
        void window.__deviceAudioUi.toggle(device, btn).then(() => {
          void syncDockBatteries();
          if (typeof window.renderDevicePanel === "function") {
            window.renderDevicePanel(devicesNow);
          }
        });
      });
    });

    root.querySelectorAll(".dock-device-chip .sidebar-wifi-toggle-input").forEach((input) => {
      input.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      input.addEventListener("change", (event) => {
        event.stopPropagation();
        const chip = input.closest(".dock-device-chip");
        const deviceId = chip?.dataset.deviceId || input.dataset.deviceId || "";
        const serial = chip?.dataset.serial || "";
        const devicesNow = typeof window.getCurrentDevices === "function" ? window.getCurrentDevices() : [];
        const device = devicesNow.find((d) => d.deviceId === deviceId || d.serial === serial);
        if (!device || !window.__deviceWifiUi?.toggle) return;
        void window.__deviceWifiUi.toggle(device, input.checked, input).then(() => {
          void syncDockBatteries();
        });
      });
    });

    root.querySelectorAll(".dock-device-chip").forEach((chip) => {
      chip.addEventListener("contextmenu", (event) => {
        if (event.target.closest(".sidebar-wifi-toggle, .dock-device-audio-btn")) return;
        if (!window.showRenameContextMenu) return;
        const deviceId = chip.dataset.deviceId || "";
        const serial = chip.dataset.serial || "";
        const colorKey = deviceId || serial;
        if (!colorKey) return;
        window.showRenameContextMenu(event, {
          kind: "device",
          serial: colorKey,
          connected: true,
          colorsOnly: true
        });
      });
    });
  }

  function setDockMoreOpen(open) {
    const strip = document.getElementById("dock-battery-strip");
    if (!strip) return;
    dockMoreOpen = Boolean(open);
    strip.classList.toggle("is-more-open", dockMoreOpen);
    const btn = strip.querySelector(".dock-battery-more");
    const panel = strip.querySelector(".dock-battery-more-panel");
    if (btn) btn.setAttribute("aria-expanded", dockMoreOpen ? "true" : "false");
    if (panel) panel.hidden = !dockMoreOpen;
  }

  async function syncDockBatteries() {
    const strip = document.getElementById("dock-battery-strip");
    if (!strip) return;

    if (!document.body.classList.contains("theme-tablet") || !hasActiveStream()) {
      strip.innerHTML = "";
      strip.hidden = true;
      dockMoreOpen = false;
      hideChipFlyout();
      return;
    }

    const streamKeys = getStreamingDeviceKeys();
    const devices = (typeof window.getCurrentDevices === "function" ? window.getCurrentDevices() : [])
      .filter((device) => device?.connected !== false)
      .filter((device) => {
        if (!streamKeys.size) return true;
        const id = device.deviceId || "";
        const serial = device.serial || "";
        return streamKeys.has(id) || streamKeys.has(serial);
      });

    if (!devices.length) {
      strip.innerHTML = "";
      strip.hidden = true;
      dockMoreOpen = false;
      hideChipFlyout();
      return;
    }

    if (window.__deviceAudioUi?.refreshState) {
      await window.__deviceAudioUi.refreshState();
    }

    const visible = devices.slice(0, DOCK_BATTERY_VISIBLE_MAX);
    const overflow = devices.slice(DOCK_BATTERY_VISIBLE_MAX);
    const keepMoreOpen = dockMoreOpen && overflow.length > 0;

    strip.hidden = false;
    let html = visible.map((device) => buildDockDeviceChip(device, { variant: "compact" })).join("");

    if (overflow.length) {
      const moreLabel = `+${overflow.length}`;
      html +=
        `<div class="dock-battery-more-wrap">` +
        `<button type="button" class="dock-battery-more" aria-expanded="${keepMoreOpen ? "true" : "false"}" aria-haspopup="true" data-dock-tip="${escapeAttr(moreLabel)}">${moreLabel}</button>` +
        `<div class="dock-battery-more-panel" ${keepMoreOpen ? "" : "hidden"}>` +
        overflow.map((device) => buildDockDeviceChip(device, { variant: "menu" })).join("") +
        `</div>` +
        `</div>`;
    }

    strip.innerHTML = html;
    strip.classList.toggle("is-more-open", keepMoreOpen);
    dockMoreOpen = keepMoreOpen;

    bindDockChipInteractions(strip);
    bindCompactFlyouts(strip);

    if (flyoutActiveKey) {
      refreshOpenFlyoutContent();
    }

    const moreBtn = strip.querySelector(".dock-battery-more");
    if (moreBtn) {
      moreBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        hideChipFlyout();
        setDockMoreOpen(!dockMoreOpen);
      });
    }
  }

  async function syncRecentApps() {
    const target = document.getElementById("home-apps-recent");
    if (!target || !window.launchHistoryAPI?.list) return;

    const placeholderSvg =
      globalThis.HubAppIconPlaceholder?.APP_ICON_PLACEHOLDER_SVG
      || '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="10" r="2.2" fill="currentColor"/><path d="M7.5 17c1.2-1.6 2.7-2.4 4.5-2.4s3.3.8 4.5 2.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

    try {
      const response = await window.launchHistoryAPI.list();
      const entries = Array.isArray(response?.entries) ? response.entries : [];
      recentEntries = entries.slice(0, 8);

      if (!recentEntries.length) {
        target.innerHTML = "";
        return;
      }

      target.innerHTML = recentEntries.map((entry, index) => {
        const name = entry.appName || entry.packageName || "";
        const iconSrc = entry.iconUrl || entry.iconPath || "";
        const iconHtml = iconSrc
          ? `<img src="${escapeAttr(iconSrc)}" alt="" loading="lazy">`
          : placeholderSvg;
        const iconClass = iconSrc ? "" : " is-placeholder";
        return (
          `<button type="button" class="home-app-tile" data-recent-index="${index}" title="${escapeAttr(name)}">` +
          `<div class="home-app-tile-icon${iconClass}">${iconHtml}</div>` +
          `<span class="home-app-tile-name">${escapeAttr(name)}</span>` +
          `</button>`
        );
      }).join("");

      target.querySelectorAll(".home-app-tile").forEach((tile) => {
        tile.addEventListener("click", () => {
          const index = Number(tile.dataset.recentIndex);
          const entry = recentEntries[index];
          if (!entry) return;
          void launchRecentApp(entry);
        });
      });
    } catch (_err) {}
  }

  async function launchRecentApp(entry) {
    const launch = window.__hubModalMainActions?.launchFromHistory;
    if (typeof launch !== "function") return;
    try {
      await launch({
        deviceId: entry.deviceId,
        packageName: entry.packageName,
        appName: entry.appName,
        userId: entry.userId ?? null,
        iconPath: entry.iconPath || null,
        iconUrl: entry.iconUrl || null
      });
    } catch (err) {
      console.error("[HomeDashboard] launchRecentApp:", err);
    }
  }

  function observeSessionView() {
    const content = document.querySelector(".content");
    if (!content || content.dataset.dockBatteryObserve === "1") return;
    content.dataset.dockBatteryObserve = "1";
    const observer = new MutationObserver(() => {
      void syncDockBatteries();
      if (isHomeVisible()) void syncHomeSessions();
      else stopHomePreviewPolling();
    });
    observer.observe(content, { attributes: true, attributeFilter: ["class"] });

    const tabs = document.getElementById("tabs-bar-track") || document.getElementById("tabs-bar");
    if (tabs) {
      const tabsObserver = new MutationObserver(() => {
        void syncDockBatteries();
        if (document.body.classList.contains("theme-tablet")) {
          void syncHomeSessions();
        }
      });
      tabsObserver.observe(tabs, { childList: true, subtree: true });
    }
  }

  window.syncDockBatteries = syncDockBatteries;
  window.syncHomeSessions = syncHomeSessions;
  window.launchHistoryAPI?.onUpdated?.(syncRecentApps);
  window.electronAPI?.onAppMetadataUpdated?.(() => {
    void syncRecentApps();
  });
  window.addEventListener("devices-refreshed", () => {
    void syncDockBatteries();
    syncEmptyStateIntro();
  });
  window.addEventListener("fps-updated", (event) => {
    updateHomeSessionFps(event.detail || {});
  });

  if (window.deviceColorsAPI?.onUpdated) {
    window.deviceColorsAPI.onUpdated(() => {
      void syncDockBatteries();
    });
  }

  window.HubI18n?.onChange?.(() => {
    void syncDockBatteries();
    void syncRecentApps();
    void syncHomeSessions();
  });

  if (window.audioAPI?.onGlobalStateChanged) {
    window.audioAPI.onGlobalStateChanged(() => {
      void syncDockBatteries();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    syncRecentApps();
    observeSessionView();
    bindHomeActions();
    bindWifiReconnectUi();
    void syncDockBatteries();
    syncEmptyStateIntro();
  });

  const originalGoHome = window.goToLaunchHome;
  if (typeof originalGoHome === "function" && !originalGoHome.__homeSessionsWrapped) {
    const wrapped = async (...args) => {
      const result = await originalGoHome(...args);
      syncEmptyStateIntro();
      void syncHomeSessions();
      return result;
    };
    wrapped.__homeSessionsWrapped = true;
    window.goToLaunchHome = wrapped;
  } else {
    // goToLaunchHome may be defined later in index.html — hook after load
    window.addEventListener("load", () => {
      const goHome = window.goToLaunchHome;
      if (typeof goHome !== "function" || goHome.__homeSessionsWrapped) return;
      const wrapped = async (...args) => {
        const result = await goHome(...args);
        syncEmptyStateIntro();
        void syncHomeSessions();
        return result;
      };
      wrapped.__homeSessionsWrapped = true;
      window.goToLaunchHome = wrapped;
    });
  }

  document.addEventListener("pointerdown", (event) => {
    if (!dockMoreOpen) return;
    const strip = document.getElementById("dock-battery-strip");
    if (!strip || strip.contains(event.target)) return;
    setDockMoreOpen(false);
  });

  document.addEventListener("pointerdown", (event) => {
    const popup = document.getElementById("home-wifi-reconnect-popup");
    if (!popup || popup.classList.contains("hidden") || popup.hasAttribute("hidden")) return;
    const btn = document.getElementById("home-wifi-reconnect-btn");
    if (popup.contains(event.target) || btn?.contains(event.target)) return;
    hideWifiReconnectPopup();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dockMoreOpen) {
      setDockMoreOpen(false);
    }
    if (event.key === "Escape") {
      hideWifiReconnectPopup();
    }
  });
})();
