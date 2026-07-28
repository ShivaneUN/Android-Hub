(function () {
  let recentEntries = [];
  let pinnedEntries = [];
  let pinnedAppsLoaded = false;
  const HOME_PINNED_APPS_STORAGE_KEY = "android-hub.home-pinned-apps.v1";
  const HOME_PINNED_APPS_MAX = 16;
  const HOME_APPS_STRIP_VISIBLE = 3;
  const HOME_RECENT_APPS_MAX = 24;
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
    const connected = hasConnectedDevice();
    if (intro) intro.hidden = connected;
    if (appsSection) appsSection.hidden = !connected;
    if (devicesSection) devicesSection.hidden = !connected;
    if (sessionsSection) sessionsSection.hidden = !connected;
    if (connected) {
      void syncHomeSessions();
      // Restaurer les positions sauvegardées sans les recalculer ni séparer
      if (!homeModulesState) loadHomeModulesState();
      HOME_MODULE_IDS.forEach(applyHomeModuleState);
      if (canMutateHomeModuleLayout()) {
        HOME_MODULE_IDS.forEach(rememberHomeModuleTitleCenter);
      }
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
      const pill = tab.querySelector(".tab-icon.device-color-pill");
      const pillBg = pill?.style?.background || "";
      const colorHex = /^#[0-9A-Fa-f]{6}$/i.test(pillBg) ? pillBg : "";
      return {
        sessionId: tab.dataset.tabId,
        type: tab.dataset.sessionType || "A",
        label: label || tab.dataset.tabId,
        active: tab.classList.contains("active"),
        deviceId: tab.dataset.deviceKey || "",
        stableDeviceId: tab.dataset.deviceKey || "",
        deviceColor: colorHex ? { hex: colorHex } : null
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

  /** True seulement si on peut lire/écrire les positions des modules sans les corrompre. */
  function canMutateHomeModuleLayout() {
    if (!isHomeVisible()) return false;
    const content = document.querySelector(".content");
    if (content?.classList.contains("content--session-view")) return false;
    if (content?.classList.contains("content--stream-deck")) return false;
    const host = document.querySelector(".empty-state");
    if (!host || host.hidden) return false;
    const hostRect = host.getBoundingClientRect();
    // Host trop petit = vue session/stream deck ou layout transitoire → ne rien écrire
    if (hostRect.width < 240 || hostRect.height < 180) return false;
    return true;
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
      .map((session) => `${session.sessionId}:${session.active ? 1 : 0}:${session.label || ""}:${session.deviceColor?.hex || ""}`)
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

  function partitionAroundCenter(items) {
    const list = Array.isArray(items) ? items : [];
    const n = list.length;
    if (n === 0) return { left: [], mid: [], right: [] };
    if (n % 2 === 1) {
      const i = Math.floor(n / 2);
      return { left: list.slice(0, i), mid: list.slice(i, i + 1), right: list.slice(i + 1) };
    }
    const i = n / 2;
    return { left: list.slice(0, i), mid: [], right: list.slice(i) };
  }

  /**
   * Répartit les items autour de l’axe central du titre :
   * 2 → 1|1, 3 → 1|1|1, 4 → 2|2, 5 → 2|1|2, etc.
   */
  function layoutHomeCenterSplit(container, itemSelector) {
    if (!container || !itemSelector) return;
    const moduleEl = container.closest(".home-module");
    const isVertical = moduleEl?.dataset?.orientation === "vertical";

    const existing = container.querySelector(":scope > .home-center-split");
    let items;
    if (existing) {
      items = [
        ...existing.querySelector(".home-center-split-left")?.children || [],
        ...existing.querySelector(".home-center-split-mid")?.children || [],
        ...existing.querySelector(".home-center-split-right")?.children || []
      ];
    } else {
      items = [...container.children].filter((el) => el.matches?.(itemSelector));
    }
    if (!items.length) return;

    items.forEach((el) => el.remove());
    container.replaceChildren();

    if (isVertical) {
      items.forEach((el) => container.appendChild(el));
      return;
    }

    const { left, mid, right } = partitionAroundCenter(items);
    const wrap = document.createElement("div");
    wrap.className = "home-center-split";
    const leftEl = document.createElement("div");
    leftEl.className = "home-center-split-left";
    const midEl = document.createElement("div");
    midEl.className = "home-center-split-mid";
    const rightEl = document.createElement("div");
    rightEl.className = "home-center-split-right";
    left.forEach((el) => leftEl.appendChild(el));
    mid.forEach((el) => midEl.appendChild(el));
    right.forEach((el) => rightEl.appendChild(el));
    wrap.append(leftEl, midEl, rightEl);
    container.appendChild(wrap);
  }

  function layoutHomeDevicesSplit() {
    layoutHomeCenterSplit(document.getElementById("home-devices-panel"), ".sidebar-device-card");
  }

  /** Sessions : 1–2 → placement centré (comme appareils) ; 3+ → grille 3×2 + scroll. */
  function layoutHomeSessionsSplit() {
    const grid = document.getElementById("home-sessions-grid");
    if (!grid) return;

    const existing = grid.querySelector(":scope > .home-center-split");
    if (existing) {
      const items = [
        ...existing.querySelector(".home-center-split-left")?.children || [],
        ...existing.querySelector(".home-center-split-mid")?.children || [],
        ...existing.querySelector(".home-center-split-right")?.children || []
      ];
      items.forEach((el) => el.remove());
      existing.remove();
      items.forEach((el) => grid.appendChild(el));
    }

    const moduleEl = grid.closest(".home-module");
    const vertical = moduleEl?.dataset?.orientation === "vertical";
    const count = grid.querySelectorAll(".home-session-tile").length;
    const few = count > 0 && count <= 2;
    grid.classList.toggle("is-few", few);
    grid.classList.remove("is-compact");
    // Preview 3×2 = 6 visibles ; 1–2 : pas de scroll.
    const visibleMax = few ? 2 : (vertical ? 2 : 6);
    grid.classList.toggle("is-scrollable", !few && count > visibleMax);
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
      grid.classList.remove("is-compact", "is-few", "is-scrollable");
      empty.hidden = false;
      stopHomePreviewPolling();
      scheduleHomeModulesSeparation();
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
        const colorHex = session.deviceColor?.hex || "";
        if (colorHex) {
          tile.style.setProperty("--device-color", colorHex);
          tile.classList.add("has-device-color");
          const pill = tile.querySelector(".home-session-device-pill");
          if (pill) pill.style.background = colorHex;
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
      const colorHex = session.deviceColor?.hex || "";
      const colorClass = colorHex ? " has-device-color" : "";
      const colorStyle = colorHex ? ` style="--device-color:${escapeAttr(colorHex)}"` : "";
      const pillHtml = colorHex
        ? `<span class="home-session-device-pill device-color-pill" style="background:${escapeAttr(colorHex)}" aria-hidden="true"></span>`
        : "";
      const keptSrc = previousThumbs.get(id);
      const thumbHtml = keptSrc
        ? `<img class="home-session-thumb" data-session-thumb="${escapeAttr(id)}" src="${escapeAttr(keptSrc)}" alt="">`
        : `<div class="home-session-thumb-fallback" data-session-thumb="${escapeAttr(id)}">${escapeHtml(label)}</div>`;
      return (
        `<div class="home-session-tile${activeClass}${colorClass}" data-session-id="${escapeAttr(id)}" title="${escapeAttr(label)}" role="button" tabindex="0"${colorStyle}>` +
        `<span class="home-session-live">${escapeHtml(liveLabel)}</span>` +
        `<span class="home-session-fps" data-session-fps="${escapeAttr(id)}">${escapeHtml(fpsText)}</span>` +
        `<button type="button" class="home-session-close" data-home-session-close="${escapeAttr(id)}" aria-label="${escapeAttr(tHome("homeDashboard.closeSessionConfirm", "Fermer"))}">&#10005;</button>` +
        thumbHtml +
        pillHtml +
        `<div class="home-session-meta"><span class="home-session-name">${escapeHtml(label)}</span></div>` +
        `</div>`
      );
    }).join("");

    grid.querySelectorAll(".home-session-tile").forEach(bindHomeSessionTile);
    layoutHomeSessionsSplit();
    startHomePreviewPolling();
    void refreshHomeSessionPreviews();
    scheduleHomeModulesSeparation();
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
    if (window.HubPerformance && !window.HubPerformance.isEnabled("homePreview")) return;
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
    if (window.HubPerformance && !window.HubPerformance.isEnabled("homePreview")) {
      stopHomePreviewPolling();
      return;
    }
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
      cancelHomeModulesSeparation();
      clearHomeModuleTitleCenters();
      syncHomeFabsVisibility();
      stopHomePreviewPolling();
      hideCloseConfirm();

      document.querySelectorAll(".content > .page").forEach((page) => page.classList.add("hidden"));
      document.getElementById("nav-home")?.classList.remove("active");

      const content = document.querySelector(".content");
      if (content) {
        content.classList.add("content--session-view");
      }
      syncHomeFabsVisibility();

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
    positionWifiReconnectPopupNearFab();

    try {
      const response = await window.wifiAPI?.getPanelData?.();
      if (!response?.success) {
        list.innerHTML = `<p class="home-wifi-reconnect-status">${escapeHtml(tHome("homeDashboard.wifiReconnectError", "Impossible de charger la liste"))}</p>`;
        positionWifiReconnectPopupNearFab();
        return;
      }
      renderWifiReconnectList(Array.isArray(response.wifi) ? response.wifi : []);
      positionWifiReconnectPopupNearFab();
    } catch (_err) {
      list.innerHTML = `<p class="home-wifi-reconnect-status">${escapeHtml(tHome("homeDashboard.wifiReconnectError", "Impossible de charger la liste"))}</p>`;
      positionWifiReconnectPopupNearFab();
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
      if (btn.dataset.fabDidDrag === "1") {
        btn.dataset.fabDidDrag = "0";
        return;
      }
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

    const openNewInstance = () => {
      if (typeof window.openNewSessionPanelFromMain === "function") {
        void window.openNewSessionPanelFromMain();
      } else if (typeof window.openNewSessionPanel === "function") {
        void window.openNewSessionPanel();
      }
    };

    document.getElementById("home-fab-new-instance")?.addEventListener("click", (event) => {
      if (event.currentTarget?.dataset?.fabDidDrag === "1") {
        event.currentTarget.dataset.fabDidDrag = "0";
        return;
      }
      if (!isHomeShortcutFabEnabled("new-instance")) return;
      openNewInstance();
    });
    document.getElementById("home-action-new-instance")?.addEventListener("click", openNewInstance);

    document.getElementById("home-fab-stream-deck")?.addEventListener("click", (event) => {
      if (event.currentTarget?.dataset?.fabDidDrag === "1") {
        event.currentTarget.dataset.fabDidDrag = "0";
        return;
      }
      if (!isHomeShortcutFabEnabled("stream-deck")) return;
      void openStreamDeckFromHome();
    });
    document.getElementById("home-action-stream-deck")?.addEventListener("click", () => {
      void openStreamDeckFromHome();
    });

    document.querySelectorAll(".home-fab-btn--shortcut").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        if (event.currentTarget?.dataset?.fabDidDrag === "1") {
          event.currentTarget.dataset.fabDidDrag = "0";
          return;
        }
        const fabId = btn.dataset.fabId;
        if (!isHomeShortcutFabEnabled(fabId)) return;
        const tab = btn.dataset.settingsTab || "devices";
        if (typeof window.openSettingsPanelFromMain === "function") {
          window.openSettingsPanelFromMain(tab);
        } else if (typeof window.openSettingsPanel === "function") {
          void window.openSettingsPanel({ tab });
        }
      });
    });

    document.getElementById("home-session-close-cancel")?.addEventListener("click", () => {
      hideCloseConfirm();
    });

    document.getElementById("home-session-close-ok")?.addEventListener("click", () => {
      const sessionId = pendingCloseSessionId;
      void closeHomeSession(sessionId);
    });
  }

  const HOME_FABS_STORAGE_KEY = "android-hub.home-fabs.v5";
  const HOME_SHORTCUT_FABS_STORAGE_KEY = "android-hub.home-shortcut-fabs.v1";
  const HOME_FAB_SIZE = 40;
  /** Écart cible entre pastilles accrochées. */
  const HOME_FAB_GAP = 4;
  const HOME_FAB_SNAP = 96;
  /** Aimant du bloc sur l’axe de la barre centrale. */
  const HOME_FAB_GUIDE_SNAP = 56;
  const HOME_FAB_CORE_IDS = ["new-instance", "stream-deck", "wifi"];
  const HOME_FAB_OPTIONAL_IDS = [
    "settings-devices",
    "settings-appearance",
    "settings-control",
    "settings-maintenance",
    "settings-performance"
  ];
  const HOME_FAB_TOGGLE_IDS = [...HOME_FAB_CORE_IDS, ...HOME_FAB_OPTIONAL_IDS];
  const HOME_FAB_ALL_IDS = [...HOME_FAB_TOGGLE_IDS];
  /** Liste active selon les cases Raccourcis Accueil. */
  let HOME_FAB_IDS = [...HOME_FAB_CORE_IDS];
  let homeShortcutFabPrefs = null;
  let homeFabsState = null;
  let homeFabDrag = null;
  let homeFabGroupDrag = null;

  function defaultHomeShortcutFabPrefs() {
    const prefs = {};
    HOME_FAB_CORE_IDS.forEach((id) => {
      prefs[id] = true;
    });
    HOME_FAB_OPTIONAL_IDS.forEach((id) => {
      prefs[id] = false;
    });
    return prefs;
  }

  function loadHomeShortcutFabPrefs() {
    try {
      const raw = localStorage.getItem(HOME_SHORTCUT_FABS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      homeShortcutFabPrefs = { ...defaultHomeShortcutFabPrefs(), ...(parsed || {}) };
      // Nettoyer d’anciennes clés retirées (À propos / Aide).
      delete homeShortcutFabPrefs["settings-about"];
      delete homeShortcutFabPrefs["open-help"];
    } catch (_err) {
      homeShortcutFabPrefs = defaultHomeShortcutFabPrefs();
    }
    syncActiveHomeFabIds();
    return homeShortcutFabPrefs;
  }

  function saveHomeShortcutFabPrefs() {
    if (!homeShortcutFabPrefs) return;
    try {
      localStorage.setItem(HOME_SHORTCUT_FABS_STORAGE_KEY, JSON.stringify(homeShortcutFabPrefs));
    } catch (_err) {
      /* ignore */
    }
  }

  function syncActiveHomeFabIds() {
    if (!homeShortcutFabPrefs) loadHomeShortcutFabPrefs();
    HOME_FAB_IDS = HOME_FAB_TOGGLE_IDS.filter((id) => Boolean(homeShortcutFabPrefs?.[id]));
  }

  function isHomeShortcutFabEnabled(fabId) {
    if (!homeShortcutFabPrefs) loadHomeShortcutFabPrefs();
    return Boolean(homeShortcutFabPrefs?.[fabId]);
  }

  function setHomeShortcutFabEnabled(fabId, enabled) {
    if (!HOME_FAB_TOGGLE_IDS.includes(fabId)) {
      return getHomeShortcutFabPrefs();
    }
    if (!homeShortcutFabPrefs) loadHomeShortcutFabPrefs();
    const next = Boolean(enabled);
    const wasEnabled = Boolean(homeShortcutFabPrefs[fabId]);
    homeShortcutFabPrefs[fabId] = next;
    saveHomeShortcutFabPrefs();
    syncActiveHomeFabIds();

    if (!homeFabsState) loadHomeFabsState();
    if (next && !wasEnabled) {
      ensureHomeShortcutFabPlacement(fabId);
    }

    applyHomeShortcutFabAvailability();
    applyHomeFabsLayout();
    syncHomeFabsVisibility();
    return getHomeShortcutFabPrefs();
  }

  function getHomeShortcutFabPrefs() {
    if (!homeShortcutFabPrefs) loadHomeShortcutFabPrefs();
    const prefs = {};
    HOME_FAB_TOGGLE_IDS.forEach((id) => {
      prefs[id] = Boolean(homeShortcutFabPrefs[id]);
    });
    return prefs;
  }

  function ensureHomeShortcutFabPlacement(fabId) {
    if (!homeFabsState) loadHomeFabsState();
    if (!homeFabsState[fabId]) {
      homeFabsState[fabId] = { x: 24, y: 120, locked: false };
    }
    const next = resolveHomeFabPosition(
      fabId,
      homeFabsState[fabId].x,
      homeFabsState[fabId].y,
      HOME_FAB_SIZE
    );
    homeFabsState[fabId].x = next.x;
    homeFabsState[fabId].y = next.y;
    saveHomeFabsState();
  }

  function applyHomeShortcutFabAvailability() {
    if (!homeShortcutFabPrefs) loadHomeShortcutFabPrefs();
    HOME_FAB_TOGGLE_IDS.forEach((fabId) => {
      const btn = getHomeFabEl(fabId);
      if (!btn) return;
      const enabled = Boolean(homeShortcutFabPrefs[fabId]);
      btn.hidden = !enabled;
      btn.classList.toggle("is-shortcut-disabled", !enabled);
      btn.setAttribute("aria-hidden", enabled ? "false" : "true");
    });
  }

  function defaultHomeFabsState() {
    const size = HOME_FAB_SIZE;
    const gap = HOME_FAB_GAP;
    const bottom = Math.max(80, window.innerHeight - 120 - size);
    const total = size * 3 + gap * 2;
    const startX = Math.max(12, Math.round((window.innerWidth - total) / 2));
    const leftStackX = 24;
    const leftStackY = 100;
    const state = {
      "new-instance": { x: startX, y: bottom, locked: false },
      "stream-deck": { x: startX + size + gap, y: bottom, locked: false },
      wifi: { x: startX + (size + gap) * 2, y: bottom, locked: false }
    };
    HOME_FAB_OPTIONAL_IDS.forEach((id, index) => {
      state[id] = {
        x: leftStackX,
        y: leftStackY + index * (size + gap),
        locked: false
      };
    });
    return state;
  }

  function loadHomeFabsState() {
    try {
      let raw = localStorage.getItem(HOME_FABS_STORAGE_KEY);
      if (!raw) raw = localStorage.getItem("android-hub.home-fabs.v4");
      const parsed = raw ? JSON.parse(raw) : null;
      const defaults = defaultHomeFabsState();
      homeFabsState = {};
      HOME_FAB_ALL_IDS.forEach((id) => {
        homeFabsState[id] = { ...defaults[id], ...(parsed?.[id] || {}) };
        homeFabsState[id].x = Math.round(Number(homeFabsState[id].x) || 0);
        homeFabsState[id].y = Math.round(Number(homeFabsState[id].y) || 0);
        homeFabsState[id].locked = Boolean(homeFabsState[id].locked);
      });
    } catch (_err) {
      homeFabsState = defaultHomeFabsState();
    }
    syncActiveHomeFabIds();
    return homeFabsState;
  }

  function saveHomeFabsState() {
    if (!homeFabsState) return;
    try {
      localStorage.setItem(HOME_FABS_STORAGE_KEY, JSON.stringify(homeFabsState));
    } catch (_err) {
      /* ignore */
    }
  }

  function getHomeFabEl(fabId) {
    return document.querySelector(`.home-fab-btn[data-fab-id="${fabId}"]`);
  }

  /** Taille réelle d’une pastille (mesure DOM), fallback constante. */
  function measureHomeFabSize(fabId = null) {
    const el = fabId ? getHomeFabEl(fabId) : document.querySelector(".home-fab-btn");
    const w = el?.getBoundingClientRect?.().width;
    return w > 0 ? w : HOME_FAB_SIZE;
  }

  /** Zone interdite de la barre centrale (viewport), avec marge. */
  function getCentralDockExclusionRect(pad = 12) {
    const dock = document.getElementById("quick-actions-dock");
    if (!dock || dock.classList.contains("dock-covered") || dock.hidden) {
      return {
        left: 0,
        top: window.innerHeight - 56,
        right: window.innerWidth,
        bottom: window.innerHeight
      };
    }
    const r = dock.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      return {
        left: 0,
        top: window.innerHeight - 56,
        right: window.innerWidth,
        bottom: window.innerHeight
      };
    }
    return {
      left: r.left - pad,
      top: r.top - pad,
      right: r.right + pad,
      bottom: Math.max(r.bottom + pad, window.innerHeight)
    };
  }

  /** Zones interdites pour les pastilles : barre centrale + modules + bouton Aide. */
  function getFabForbiddenZones(pad = 10) {
    const zones = [getCentralDockExclusionRect(pad)];
    document.querySelectorAll(".home-module").forEach((el) => {
      if (el.hidden || el.classList.contains("is-dragging")) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      zones.push({
        left: r.left - pad,
        top: r.top - pad,
        right: r.right + pad,
        bottom: r.bottom + pad
      });
    });
    const helpBtn = document.getElementById("nav-aide");
    if (helpBtn && !helpBtn.hidden) {
      const r = helpBtn.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const helpPad = Math.max(pad, HOME_FAB_GAP);
        zones.push({
          left: r.left - helpPad,
          top: r.top - helpPad,
          right: r.right + helpPad,
          bottom: r.bottom + helpPad
        });
      }
    }
    return zones;
  }

  function boxesOverlap(a, b) {
    return !(
      a.x + a.w <= b.left
      || b.right <= a.x
      || a.y + a.h <= b.top
      || b.bottom <= a.y
    );
  }

  function pushBoxOutOfZone(x, y, w, h, zone) {
    const next = { x, y, w, h };
    if (!boxesOverlap(next, zone)) return { x, y };

    const candidates = [
      { x: next.x, y: zone.top - h },
      { x: next.x, y: zone.bottom },
      { x: zone.left - w, y: next.y },
      { x: zone.right, y: next.y }
    ];
    let best = null;
    let bestDist = Infinity;
    candidates.forEach((c) => {
      const box = { x: c.x, y: c.y, w, h };
      if (boxesOverlap(box, zone)) return;
      const dist = Math.hypot(c.x - next.x, c.y - next.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    });
    if (!best) {
      return { x: next.x, y: Math.min(zone.top - h, window.innerHeight - h - 8) };
    }
    return best;
  }

  /** Pousse une boîte hors de toutes les zones interdites (dock + modules). */
  function pushBoxOutOfExclusions(x, y, w, h) {
    let next = { x, y };
    for (let pass = 0; pass < 16; pass += 1) {
      let moved = false;
      for (const zone of getFabForbiddenZones()) {
        if (!boxesOverlap({ x: next.x, y: next.y, w, h }, zone)) continue;
        next = pushBoxOutOfZone(next.x, next.y, w, h, zone);
        moved = true;
      }
      if (!moved) break;
    }
    return next;
  }

  /** Pousse uniquement hors de la barre centrale (modules, etc.). */
  function pushBoxOutOfDock(x, y, w, h) {
    return pushBoxOutOfZone(x, y, w, h, getCentralDockExclusionRect());
  }

  function clampHomeFabPosition(x, y, size = HOME_FAB_SIZE) {
    const maxX = Math.max(0, window.innerWidth - size - 8);
    const maxY = Math.max(0, window.innerHeight - size - 8);
    let next = {
      x: Math.min(Math.max(8, x), maxX),
      y: Math.min(Math.max(8, y), maxY)
    };
    next = pushBoxOutOfExclusions(next.x, next.y, size, size);
    next.x = Math.min(Math.max(8, next.x), maxX);
    next.y = Math.min(Math.max(8, next.y), maxY);
    if (getFabForbiddenZones().some((z) => boxesOverlap({ x: next.x, y: next.y, w: size, h: size }, z))) {
      next = pushBoxOutOfExclusions(next.x, next.y, size, size);
      next.x = Math.min(Math.max(8, next.x), maxX);
      next.y = Math.min(Math.max(8, next.y), maxY);
    }
    return next;
  }

  /** Boîte visuelle viewport (getBoundingClientRect) — source de vérité pour slots / snap. */
  function getHomeFabVisualBox(fabId) {
    const el = getHomeFabEl(fabId);
    if (!el || el.hidden) return null;
    const rect = el.getBoundingClientRect();
    const w = rect.width > 0 ? rect.width : HOME_FAB_SIZE;
    const h = rect.height > 0 ? rect.height : HOME_FAB_SIZE;
    return {
      id: fabId,
      x: rect.left,
      y: rect.top,
      w,
      h,
      cx: rect.left + w / 2,
      cy: rect.top + h / 2
    };
  }

  function getFabStateBox(fabId) {
    const state = homeFabsState?.[fabId];
    if (!state) return getHomeFabVisualBox(fabId);
    const size = HOME_FAB_SIZE;
    return {
      id: fabId,
      x: state.x,
      y: state.y,
      w: size,
      h: size,
      cx: state.x + size / 2,
      cy: state.y + size / 2
    };
  }

  function syncHomeFabStateFromVisual(fabId) {
    const visual = getHomeFabVisualBox(fabId);
    if (!visual || !homeFabsState?.[fabId]) return null;
    homeFabsState[fabId].x = visual.x;
    homeFabsState[fabId].y = visual.y;
    return visual;
  }

  function fabsOverlap(a, b, gap = HOME_FAB_GAP) {
    return !(
      a.x + a.w + gap <= b.x
      || b.x + b.w + gap <= a.x
      || a.y + a.h + gap <= b.y
      || b.y + b.h + gap <= a.y
    );
  }

  /** Repousse une pastille hors des autres (gap minimum inclus). */
  function pushFabAwayFromOthers(fabId, x, y, size = HOME_FAB_SIZE, excludeIds = null) {
    const skip = new Set(excludeIds || []);
    skip.add(fabId);
    let next = { x, y };
    for (let pass = 0; pass < 16; pass += 1) {
      let moved = false;
      for (const otherId of HOME_FAB_IDS) {
        if (skip.has(otherId)) continue;
        const other = getFabStateBox(otherId);
        if (!other) continue;
        const zone = {
          left: other.x - HOME_FAB_GAP,
          top: other.y - HOME_FAB_GAP,
          right: other.x + other.w + HOME_FAB_GAP,
          bottom: other.y + other.h + HOME_FAB_GAP
        };
        if (!boxesOverlap({ x: next.x, y: next.y, w: size, h: size }, zone)) continue;
        next = pushBoxOutOfZone(next.x, next.y, size, size, zone);
        moved = true;
      }
      if (!moved) break;
    }
    return next;
  }

  /** Position finale : hors dock/modules, hors autres pastilles, dans l’écran. */
  function resolveHomeFabPosition(fabId, x, y, size = HOME_FAB_SIZE) {
    const maxX = Math.max(0, window.innerWidth - size - 8);
    const maxY = Math.max(0, window.innerHeight - size - 8);
    let next = clampHomeFabPosition(x, y, size);
    for (let pass = 0; pass < 8; pass += 1) {
      const away = pushFabAwayFromOthers(fabId, next.x, next.y, size);
      const clamped = clampHomeFabPosition(away.x, away.y, size);
      if (Math.abs(clamped.x - next.x) < 0.5 && Math.abs(clamped.y - next.y) < 0.5) {
        next = clamped;
        break;
      }
      next = clamped;
    }
    next.x = Math.min(Math.max(8, next.x), maxX);
    next.y = Math.min(Math.max(8, next.y), maxY);
    return next;
  }

  /**
   * Sépare les pastilles qui se chevauchent.
   * stayId = pastille qui doit rester en place (celle qu’on drag / qu’on vient d’accrocher).
   */
  function separateAllHomeFabs(stayId = null, { persist = true } = {}) {
    if (!homeFabsState) loadHomeFabsState();
    const gap = HOME_FAB_GAP;
    const size = HOME_FAB_SIZE;

    for (let pass = 0; pass < 16; pass += 1) {
      let moved = false;
      for (let i = 0; i < HOME_FAB_IDS.length; i += 1) {
        for (let j = i + 1; j < HOME_FAB_IDS.length; j += 1) {
          const aId = HOME_FAB_IDS[i];
          const bId = HOME_FAB_IDS[j];
          const a = getFabStateBox(aId);
          const b = getFabStateBox(bId);
          if (!a || !b || !fabsOverlap(a, b, gap)) continue;

          let moveId;
          let keepId;
          if (stayId === aId) {
            keepId = aId;
            moveId = bId;
          } else if (stayId === bId) {
            keepId = bId;
            moveId = aId;
          } else if (!homeFabsState[bId].locked) {
            moveId = bId;
            keepId = aId;
          } else if (!homeFabsState[aId].locked) {
            moveId = aId;
            keepId = bId;
          } else {
            moveId = bId;
            keepId = aId;
          }

          // Ne jamais déplacer la pastille "stay" (drag / snap), même si l’autre est verrouillée
          if (stayId && moveId === stayId) {
            moveId = keepId;
            keepId = stayId;
          }
          if (homeFabsState[moveId]?.locked && moveId !== stayId) {
            // Impossible d’écarter une pastille verrouillée : on ignore ce couple
            if (keepId === stayId) continue;
            if (!homeFabsState[keepId]?.locked) {
              const swap = moveId;
              moveId = keepId;
              keepId = swap;
            } else {
              continue;
            }
          }

          const stay = getFabStateBox(keepId);
          const mov = getFabStateBox(moveId);
          if (!stay || !mov) continue;

          const centerDx = (mov.x + mov.w / 2) - (stay.x + stay.w / 2);
          const centerDy = (mov.y + mov.h / 2) - (stay.y + stay.h / 2);
          const overlapX = Math.min(mov.x + mov.w, stay.x + stay.w) - Math.max(mov.x, stay.x);
          const overlapY = Math.min(mov.y + mov.h, stay.y + stay.h) - Math.max(mov.y, stay.y);

          if (overlapX <= overlapY) {
            homeFabsState[moveId].x = centerDx >= 0
              ? stay.x + size + gap
              : stay.x - size - gap;
            if (Math.abs(mov.y - stay.y) <= 28) {
              homeFabsState[moveId].y = stay.y;
            }
          } else {
            homeFabsState[moveId].y = centerDy >= 0
              ? stay.y + size + gap
              : stay.y - size - gap;
            if (Math.abs(mov.x - stay.x) <= 28) {
              homeFabsState[moveId].x = stay.x;
            }
          }

          const resolved = resolveHomeFabPosition(
            moveId,
            homeFabsState[moveId].x,
            homeFabsState[moveId].y,
            size
          );
          homeFabsState[moveId].x = resolved.x;
          homeFabsState[moveId].y = resolved.y;
          moved = true;
        }
      }
      if (!moved) break;
    }

    HOME_FAB_IDS.forEach((fabId) => {
      const state = homeFabsState?.[fabId];
      if (!state) return;
      const resolved = resolveHomeFabPosition(fabId, state.x, state.y, size);
      state.x = resolved.x;
      state.y = resolved.y;
      applyHomeFabState(fabId);
    });
    if (persist) {
      saveHomeFabsState();
      updateHomeFabGroupBoxes();
    }
  }

  function findHomeFabSnapCandidate(fabId, x, y) {
    if (!homeFabsState) loadHomeFabsState();
    const size = HOME_FAB_SIZE;
    const next = resolveHomeFabPosition(fabId, x, y, size);
    const nextCx = next.x + size / 2;
    const nextCy = next.y + size / 2;

    let best = null;
    let bestDist = Infinity;
    for (const slot of listHomeFabAttachSlots(fabId)) {
      const dist = Math.hypot(nextCx - slot.cx, nextCy - slot.cy);
      if (dist <= HOME_FAB_SNAP && dist < bestDist) {
        bestDist = dist;
        best = slot;
      }
    }
    return best;
  }

  function listHomeFabAttachSlots(fabId) {
    if (!homeFabsState) loadHomeFabsState();
    const size = HOME_FAB_SIZE;
    const gap = HOME_FAB_GAP;
    const step = size + gap;
    const slots = [];

    for (const otherId of HOME_FAB_IDS) {
      if (otherId === fabId) continue;
      const otherEl = getHomeFabEl(otherId);
      if (!otherEl || otherEl.hidden || otherEl.classList.contains("is-hidden-off-home")) continue;
      const other = getHomeFabVisualBox(otherId);
      if (!other) continue;

      const centerCandidates = [
        { cx: other.cx - step, cy: other.cy },
        { cx: other.cx + step, cy: other.cy },
        { cx: other.cx, cy: other.cy - step },
        { cx: other.cx, cy: other.cy + step }
      ];

      for (const c of centerCandidates) {
        const topLeft = clampHomeFabPosition(c.cx - size / 2, c.cy - size / 2, size);
        const cleared = pushFabAwayFromOthers(fabId, topLeft.x, topLeft.y, size, [otherId]);
        if (Math.hypot(cleared.x - topLeft.x, cleared.y - topLeft.y) > 0.75) continue;
        const finalPos = clampHomeFabPosition(cleared.x, cleared.y, size);
        if (Math.hypot(finalPos.x - topLeft.x, finalPos.y - topLeft.y) > 0.75) continue;
        const gotCx = finalPos.x + size / 2;
        const gotCy = finalPos.y + size / 2;
        if (Math.hypot(gotCx - c.cx, gotCy - c.cy) > 0.75) continue;

        let occupied = false;
        for (const occId of HOME_FAB_IDS) {
          if (occId === fabId || occId === otherId) continue;
          const occ = getFabStateBox(occId);
          if (!occ) continue;
          if (fabsOverlap({ x: finalPos.x, y: finalPos.y, w: size, h: size }, occ, HOME_FAB_GAP)) {
            occupied = true;
            break;
          }
        }
        if (occupied) continue;

        const key = `${Math.round(gotCx)}:${Math.round(gotCy)}`;
        if (slots.some((s) => s.key === key)) continue;
        slots.push({
          key,
          x: finalPos.x,
          y: finalPos.y,
          cx: gotCx,
          cy: gotCy,
          size
        });
      }
    }
    return slots;
  }

  function ensureHomeFabSlotsLayer() {
    const bar = document.getElementById("home-fab-bar");
    if (!bar) return null;
    let layer = bar.querySelector(".home-fab-slots-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "home-fab-slots-layer";
      layer.setAttribute("aria-hidden", "true");
      bar.appendChild(layer);
    }
    return layer;
  }

  function clearHomeFabAttachSlots() {
    const layer = document.querySelector("#home-fab-bar .home-fab-slots-layer");
    if (layer) layer.innerHTML = "";
  }

  function showHomeFabAttachSlots(fabId, activeSlot = null) {
    const layer = ensureHomeFabSlotsLayer();
    if (!layer) return;
    layer.innerHTML = "";
    const slots = listHomeFabAttachSlots(fabId);
    slots.forEach((slot) => {
      const ghost = document.createElement("div");
      ghost.className = "home-fab-slot";
      if (
        activeSlot
        && Math.hypot(activeSlot.cx - slot.cx, activeSlot.cy - slot.cy) <= 1
      ) {
        ghost.classList.add("is-active");
      }
      ghost.style.left = `${slot.cx}px`;
      ghost.style.top = `${slot.cy}px`;
      ghost.style.width = `${slot.size}px`;
      ghost.style.height = `${slot.size}px`;
      layer.appendChild(ghost);
    });
  }

  function snapHomeFabPosition(fabId, x, y) {
    if (!homeFabsState) loadHomeFabsState();
    const size = measureHomeFabSize(fabId);
    const next = resolveHomeFabPosition(fabId, x, y, size);
    const best = findHomeFabSnapCandidate(fabId, next.x, next.y);
    homeFabsState[fabId].x = best ? best.x : next.x;
    homeFabsState[fabId].y = best ? best.y : next.y;
    applyHomeFabState(fabId);
    separateAllHomeFabs(fabId);
    return { x: homeFabsState[fabId].x, y: homeFabsState[fabId].y };
  }

  function applyHomeFabState(fabId) {
    const btn = getHomeFabEl(fabId);
    const state = homeFabsState?.[fabId];
    if (!btn || !state) return;
    btn.style.left = `${Math.round(state.x)}px`;
    btn.style.top = `${Math.round(state.y)}px`;
    btn.style.width = `${HOME_FAB_SIZE}px`;
    btn.style.height = `${HOME_FAB_SIZE}px`;
    btn.classList.toggle("is-locked", Boolean(state.locked));
  }

  function applyHomeFabsLayout() {
    if (!homeFabsState) loadHomeFabsState();
    tightenHomeFabGaps();
    for (let pass = 0; pass < 8; pass += 1) {
      HOME_FAB_IDS.forEach((fabId) => {
        const state = homeFabsState?.[fabId];
        if (!state) return;
        const next = resolveHomeFabPosition(fabId, state.x, state.y, HOME_FAB_SIZE);
        state.x = next.x;
        state.y = next.y;
        applyHomeFabState(fabId);
      });
      separateAllHomeFabs(null, { persist: false });
    }
    updateHomeFabGroupBoxes();
    saveHomeFabsState();
    positionWifiReconnectPopupNearFab();
    syncHomeFabsVisibility();
  }

  /** Resserre les pastilles déjà côte à côte (ancien écart trop large). */
  function tightenHomeFabGaps() {
    if (!homeFabsState) return;
    const size = HOME_FAB_SIZE;
    const gap = HOME_FAB_GAP;
    const maxOldGap = size + 24;

    for (let pass = 0; pass < 6; pass += 1) {
      let changed = false;
      for (let i = 0; i < HOME_FAB_IDS.length; i += 1) {
        for (let j = i + 1; j < HOME_FAB_IDS.length; j += 1) {
          const a = homeFabsState[HOME_FAB_IDS[i]];
          const b = homeFabsState[HOME_FAB_IDS[j]];
          if (!a || !b) continue;

          if (Math.abs(a.y - b.y) <= 2) {
            const left = a.x <= b.x ? a : b;
            const right = a.x <= b.x ? b : a;
            const dist = right.x - left.x;
            if (dist > size + gap && dist <= maxOldGap) {
              right.x = left.x + size + gap;
              right.y = left.y;
              changed = true;
            }
          }
          if (Math.abs(a.x - b.x) <= 2) {
            const top = a.y <= b.y ? a : b;
            const bottom = a.y <= b.y ? b : a;
            const dist = bottom.y - top.y;
            if (dist > size + gap && dist <= maxOldGap) {
              bottom.y = top.y + size + gap;
              bottom.x = top.x;
              changed = true;
            }
          }
        }
      }
      if (!changed) break;
    }
    HOME_FAB_IDS.forEach(applyHomeFabState);
  }

  /** Deux pastilles sont « accrochées » si leurs centres visuels sont voisins (sans chevauchement). */
  function fabsAreAttached(aId, bId) {
    const a = getHomeFabVisualBox(aId) || getFabStateBox(aId);
    const b = getHomeFabVisualBox(bId) || getFabStateBox(bId);
    if (!a || !b) return false;
    // Chevauchement réel = pas accrochées
    if (fabsOverlap(a, b, 0)) return false;
    const expected = (a.w + b.w) / 2 + HOME_FAB_GAP;
    const tol = 6;
    if (Math.abs(a.cy - b.cy) <= tol) {
      if (Math.abs(Math.abs(a.cx - b.cx) - expected) <= tol) return true;
    }
    if (Math.abs(a.cx - b.cx) <= tol) {
      if (Math.abs(Math.abs(a.cy - b.cy) - expected) <= tol) return true;
    }
    return false;
  }

  /** Sépare les pastilles qui se chevauchent vraiment (jamais d’empilement). */
  function separateOverlappingUnattachedFabs(stayId = null) {
    separateAllHomeFabs(stayId, { persist: false });
  }

  /** Clusters de pastilles accrochées (taille ≥ 2). */
  function getHomeFabClusters() {
    if (!homeFabsState) loadHomeFabsState();
    const parent = {};
    HOME_FAB_IDS.forEach((id) => {
      parent[id] = id;
    });
    function find(id) {
      if (parent[id] !== id) parent[id] = find(parent[id]);
      return parent[id];
    }
    function union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }

    for (let i = 0; i < HOME_FAB_IDS.length; i += 1) {
      for (let j = i + 1; j < HOME_FAB_IDS.length; j += 1) {
        if (fabsAreAttached(HOME_FAB_IDS[i], HOME_FAB_IDS[j])) {
          union(HOME_FAB_IDS[i], HOME_FAB_IDS[j]);
        }
      }
    }

    const groups = new Map();
    HOME_FAB_IDS.forEach((id) => {
      const root = find(id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(id);
    });
    return [...groups.values()].filter((ids) => ids.length >= 2);
  }

  function getHomeFabClusterBounds(fabIds) {
    const size = HOME_FAB_SIZE;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    fabIds.forEach((id) => {
      const state = homeFabsState?.[id];
      if (!state) return;
      minX = Math.min(minX, state.x);
      minY = Math.min(minY, state.y);
      maxX = Math.max(maxX, state.x + size);
      maxY = Math.max(maxY, state.y + size);
    });
    if (!Number.isFinite(minX)) return null;
    return {
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY
    };
  }

  function findHomeFabClusterFor(fabId) {
    return getHomeFabClusters().find((ids) => ids.includes(fabId)) || null;
  }

  /**
   * Boîtes invisibles autour des pastilles accrochées (2 ou 3).
   * Ctrl + clic gauche → déplace le bloc.
   * Ctrl + clic droit → menu verrouiller le groupe.
   */
  function updateHomeFabGroupBoxes() {
    const bar = document.getElementById("home-fab-bar");
    if (!bar) return;
    if (!homeFabsState) loadHomeFabsState();

    const clusters = getHomeFabClusters();
    const keep = new Set();

    clusters.forEach((fabIds) => {
      const key = [...fabIds].sort().join("+");
      keep.add(key);
      let box = bar.querySelector(`.home-fab-group[data-group-key="${key}"]`);
      if (!box) {
        box = document.createElement("div");
        box.className = "home-fab-group";
        box.dataset.groupKey = key;
        box.setAttribute("aria-hidden", "true");
        bar.appendChild(box);
      }
      box.dataset.fabIds = fabIds.join(",");
      const allLocked = fabIds.every((id) => Boolean(homeFabsState[id]?.locked));
      box.classList.toggle("is-group-locked", allLocked);
      const bounds = getHomeFabClusterBounds(fabIds);
      if (!bounds) return;
      box.style.left = `${bounds.x}px`;
      box.style.top = `${bounds.y}px`;
      box.style.width = `${bounds.w}px`;
      box.style.height = `${bounds.h}px`;
    });

    bar.querySelectorAll(".home-fab-group").forEach((box) => {
      if (!keep.has(box.dataset.groupKey)) box.remove();
    });
  }

  function setHomeFabGroupLocked(fabIds, locked) {
    if (!homeFabsState) loadHomeFabsState();
    (fabIds || []).forEach((id) => {
      if (!homeFabsState[id]) return;
      homeFabsState[id].locked = Boolean(locked);
      applyHomeFabState(id);
    });
    saveHomeFabsState();
    updateHomeFabGroupBoxes();
  }

  function toggleHomeFabGroupLock(fabIds) {
    if (!fabIds?.length) return;
    if (!homeFabsState) loadHomeFabsState();
    const allLocked = fabIds.every((id) => Boolean(homeFabsState[id]?.locked));
    setHomeFabGroupLocked(fabIds, !allLocked);
  }

  function showHomeFabGroupLockMenu(event, fabIds) {
    if (!fabIds?.length || !window.namesAPI?.showContextMenu) return;
    if (!homeFabsState) loadHomeFabsState();
    const allLocked = fabIds.every((id) => Boolean(homeFabsState[id]?.locked));
    void window.namesAPI.showContextMenu({
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      target: {
        kind: "homeFabGroup",
        fabIds,
        locked: allLocked
      }
    });
  }

  /**
   * Axe vertical de la barre centrale (viewport), si elle est bien centrée.
   */
  function getFabDockCenterGuideX() {
    const dock = document.getElementById("quick-actions-dock");
    if (dock && !dock.classList.contains("dock-covered")) {
      const dockRect = dock.getBoundingClientRect();
      if (dockRect.width > 0) {
        const dockCenterX = dockRect.left + dockRect.width / 2;
        const viewportCenterX = window.innerWidth / 2;
        if (Math.abs(dockCenterX - viewportCenterX) <= 14) {
          return dockCenterX;
        }
      }
    }
    return window.innerWidth / 2;
  }

  function ensureHomeFabGuideLayer() {
    const bar = document.getElementById("home-fab-bar");
    if (!bar) return null;
    let layer = bar.querySelector(".home-fab-guide-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "home-fab-guide-layer";
      layer.setAttribute("aria-hidden", "true");
      bar.appendChild(layer);
    }
    return layer;
  }

  function clearHomeFabGuides() {
    const layer = document.querySelector("#home-fab-bar .home-fab-guide-layer");
    if (layer) layer.innerHTML = "";
    clearHomeFabAttachSlots();
  }

  function showHomeFabDockGuide(activeX = null) {
    const layer = ensureHomeFabGuideLayer();
    if (!layer) return;
    layer.innerHTML = "";
    const guideX = getFabDockCenterGuideX();
    const line = document.createElement("div");
    line.className = "home-fab-guide home-fab-guide--x home-fab-guide--dock";
    if (activeX !== null && Math.abs(activeX - guideX) <= 1) {
      line.classList.add("is-active");
    }
    line.style.left = `${guideX}px`;
    layer.appendChild(line);
  }

  /**
   * Aimante le centre horizontal du bloc sur la barre centrale.
   */
  function snapHomeFabGroupToDockGuide(bounds, proposedX, proposedY) {
    const guideX = getFabDockCenterGuideX();
    const blockCx = proposedX + bounds.w / 2;
    const dist = Math.abs(blockCx - guideX);
    if (dist <= HOME_FAB_GUIDE_SNAP) {
      return {
        x: guideX - bounds.w / 2,
        y: proposedY,
        snapped: true,
        guideX
      };
    }
    return {
      x: proposedX,
      y: proposedY,
      snapped: false,
      guideX
    };
  }

  function getHomeFabGroupOriginBounds(origins, fabIds) {
    const size = HOME_FAB_SIZE;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    fabIds.forEach((id) => {
      const o = origins[id];
      if (!o) return;
      minX = Math.min(minX, o.x);
      minY = Math.min(minY, o.y);
      maxX = Math.max(maxX, o.x + size);
      maxY = Math.max(maxY, o.y + size);
    });
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function clampHomeFabGroupDelta(fabIds, origins, dx, dy) {
    const bounds = getHomeFabGroupOriginBounds(origins, fabIds);
    if (!bounds) return { dx: 0, dy: 0 };
    const maxPosX = Math.max(0, window.innerWidth - bounds.w - 8);
    const maxPosY = Math.max(0, window.innerHeight - bounds.h - 8);
    let nextX = Math.min(Math.max(8, bounds.x + dx), maxPosX);
    let nextY = Math.min(Math.max(8, bounds.y + dy), maxPosY);
    const pushed = pushBoxOutOfExclusions(nextX, nextY, bounds.w, bounds.h);
    nextX = Math.min(Math.max(8, pushed.x), maxPosX);
    nextY = Math.min(Math.max(8, pushed.y), maxPosY);
    const away = pushClusterAwayFromOtherFabs(fabIds, nextX, nextY, bounds.w, bounds.h);
    nextX = Math.min(Math.max(8, away.x), maxPosX);
    nextY = Math.min(Math.max(8, away.y), maxPosY);
    return {
      dx: nextX - bounds.x,
      dy: nextY - bounds.y
    };
  }

  function pushClusterAwayFromOtherFabs(fabIds, x, y, w, h) {
    const skip = new Set(fabIds || []);
    let next = { x, y };
    for (let pass = 0; pass < 12; pass += 1) {
      let moved = false;
      for (const otherId of HOME_FAB_IDS) {
        if (skip.has(otherId)) continue;
        const other = getFabStateBox(otherId);
        if (!other) continue;
        const zone = {
          left: other.x - HOME_FAB_GAP,
          top: other.y - HOME_FAB_GAP,
          right: other.x + other.w + HOME_FAB_GAP,
          bottom: other.y + other.h + HOME_FAB_GAP
        };
        if (!boxesOverlap({ x: next.x, y: next.y, w, h }, zone)) continue;
        next = pushBoxOutOfZone(next.x, next.y, w, h, zone);
        moved = true;
      }
      if (!moved) break;
    }
    return next;
  }

  function applyHomeFabClusterOrigins(fabIds, origins, dx, dy) {
    if (!homeFabsState) return;
    fabIds.forEach((id) => {
      const state = homeFabsState[id];
      const origin = origins[id];
      if (!state || !origin) return;
      state.x = Math.round(origin.x + dx);
      state.y = Math.round(origin.y + dy);
      applyHomeFabState(id);
    });
    // Garantir qu’aucun membre du bloc n’est sur la barre / modules / autre pastille
    const bounds = getHomeFabClusterBounds(fabIds);
    if (bounds) {
      let pushed = pushBoxOutOfExclusions(bounds.x, bounds.y, bounds.w, bounds.h);
      pushed = pushClusterAwayFromOtherFabs(fabIds, pushed.x, pushed.y, bounds.w, bounds.h);
      const fixDx = pushed.x - bounds.x;
      const fixDy = pushed.y - bounds.y;
      if (fixDx || fixDy) {
        fabIds.forEach((id) => {
          const state = homeFabsState[id];
          if (!state) return;
          state.x += fixDx;
          state.y += fixDy;
          applyHomeFabState(id);
        });
      }
    }
    updateHomeFabGroupBoxes();
  }

  function startHomeFabGroupDrag(event, fabIds) {
    if (!fabIds?.length || homeFabGroupDrag || homeFabDrag) return false;
    const movable = fabIds.filter((id) => !homeFabsState?.[id]?.locked);
    if (!movable.length) return false;

    const ids = fabIds.filter((id) => homeFabsState?.[id]);
    const origins = {};
    ids.forEach((id) => {
      origins[id] = {
        x: homeFabsState[id].x,
        y: homeFabsState[id].y
      };
    });
    const bounds = getHomeFabGroupOriginBounds(origins, ids);
    homeFabGroupDrag = {
      fabIds: ids,
      origins,
      bounds,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    };
    ids.forEach((id) => getHomeFabEl(id)?.classList.add("is-dragging"));
    document.querySelectorAll(".home-fab-group").forEach((box) => {
      const boxIds = (box.dataset.fabIds || "").split(",");
      if (ids.some((id) => boxIds.includes(id))) box.classList.add("is-dragging");
    });
    if (bounds) showHomeFabDockGuide(null);
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function positionWifiReconnectPopupNearFab() {
    const popup = document.getElementById("home-wifi-reconnect-popup");
    const btn = getHomeFabEl("wifi");
    if (!popup || !btn || popup.classList.contains("hidden") || popup.hasAttribute("hidden")) return;
    const rect = btn.getBoundingClientRect();
    const popupW = popup.offsetWidth || 280;
    const popupH = popup.offsetHeight || 200;
    let left = rect.left + rect.width / 2 - popupW / 2;
    let top = rect.top - popupH - 10;
    if (top < 8) top = rect.bottom + 10;
    left = Math.max(8, Math.min(left, window.innerWidth - popupW - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - popupH - 8));
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
    popup.style.bottom = "auto";
    popup.style.transform = "none";
  }

  function toggleHomeFabLock(fabId) {
    if (!homeFabsState) loadHomeFabsState();
    const state = homeFabsState[fabId];
    if (!state) return;
    state.locked = !state.locked;
    saveHomeFabsState();
    applyHomeFabState(fabId);
    updateHomeFabGroupBoxes();
  }

  /** Zone à gauche du dock central : pastilles visibles hors accueil si placées ici. */
  function getOffHomeFabKeepZone() {
    const dock = document.getElementById("quick-actions-dock");
    const dockRect = dock && !dock.classList.contains("dock-covered") && !dock.hidden
      ? dock.getBoundingClientRect()
      : null;

    // Bord droit de la zone = bord gauche du dock (avec une petite marge)
    let right = window.innerWidth * 0.5;
    if (dockRect && dockRect.width > 0) {
      right = dockRect.left - 8;
    }

    return {
      left: 0,
      top: 0,
      right: Math.max(80, right),
      bottom: window.innerHeight
    };
  }

  function isFabInOffHomeKeepZone(x, y, size = HOME_FAB_SIZE) {
    const zone = getOffHomeFabKeepZone();
    // Visible si le centre de la pastille est à gauche du dock central
    const cx = x + size / 2;
    return cx < zone.right;
  }

  function syncHomeFabsVisibility() {
    const bar = document.getElementById("home-fab-bar");
    if (!bar) return;
    if (!homeShortcutFabPrefs) loadHomeShortcutFabPrefs();
    if (!homeFabsState) loadHomeFabsState();
    applyHomeShortcutFabAvailability();

    const content = document.querySelector(".content");
    const offHome = !isHomeVisible()
      || Boolean(content?.classList.contains("content--stream-deck"))
      || Boolean(content?.classList.contains("content--session-view"));

    let anyVisible = false;
    HOME_FAB_IDS.forEach((fabId) => {
      const btn = getHomeFabEl(fabId);
      const state = homeFabsState?.[fabId];
      if (!btn || !state || btn.hidden) return;
      // Accueil : tout visible. Session / Stream Deck : seulement à gauche du dock.
      const hide = offHome && !isFabInOffHomeKeepZone(state.x, state.y, HOME_FAB_SIZE);
      btn.classList.toggle("is-hidden-off-home", hide);
      btn.setAttribute("aria-hidden", hide ? "true" : "false");
      if (!hide) anyVisible = true;
    });

    bar.querySelectorAll(".home-fab-group").forEach((box) => {
      const ids = (box.dataset.fabIds || "").split(",").filter(Boolean);
      const allHidden = ids.length > 0 && ids.every((id) => {
        const el = getHomeFabEl(id);
        return !el || el.hidden || el.classList.contains("is-hidden-off-home");
      });
      box.classList.toggle("is-hidden-off-home", allHidden);
    });

    bar.classList.toggle("is-all-hidden-off-home", offHome && !anyVisible);
    bar.setAttribute("aria-hidden", offHome && !anyVisible ? "true" : "false");

    if (offHome && !anyVisible) {
      hideWifiReconnectPopup();
      if (typeof clearHomeFabGuides === "function") clearHomeFabGuides();
    }
  }

  function bindHomeFabs() {
    const bar = document.getElementById("home-fab-bar");
    if (!bar || bar.dataset.homeFabsBound === "1") return;
    bar.dataset.homeFabsBound = "1";
    loadHomeShortcutFabPrefs();
    loadHomeFabsState();
    applyHomeShortcutFabAvailability();
    applyHomeFabsLayout();
    syncHomeFabsVisibility();

    // Ctrl + clic gauche sur la boîte → déplacer le bloc
    bar.addEventListener("pointerdown", (event) => {
      const groupEl = event.target.closest?.(".home-fab-group");
      if (!groupEl) return;
      if (event.button === 0 && event.ctrlKey) {
        const fabIds = (groupEl.dataset.fabIds || "").split(",").filter(Boolean);
        startHomeFabGroupDrag(event, fabIds);
      }
    });

    // Ctrl + clic droit sur la boîte → popup verrouiller le groupe
    bar.addEventListener("contextmenu", (event) => {
      const groupEl = event.target.closest?.(".home-fab-group");
      if (!groupEl) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.ctrlKey) return;
      const fabIds = (groupEl.dataset.fabIds || "").split(",").filter(Boolean);
      showHomeFabGroupLockMenu(event, fabIds);
    });

    bar.querySelectorAll(".home-fab-btn").forEach((btn) => {
      btn.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (homeFabGroupDrag) return;
        const fabId = btn.dataset.fabId;
        if (!fabId) return;
        if (!homeFabsState) loadHomeFabsState();

        // Ctrl + clic droit sur une pastille du groupe → lock groupe
        if (event.ctrlKey) {
          const cluster = findHomeFabClusterFor(fabId);
          if (cluster) {
            showHomeFabGroupLockMenu(event, cluster);
            return;
          }
        }

        if (!window.namesAPI?.showContextMenu) return;
        void window.namesAPI.showContextMenu({
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
          target: {
            kind: "homeFab",
            fabId,
            locked: Boolean(homeFabsState[fabId]?.locked)
          }
        });
      });

      btn.addEventListener("pointerdown", (event) => {
        const fabId = btn.dataset.fabId;
        if (!fabId) return;
        if (!homeFabsState) loadHomeFabsState();
        if (event.button !== 0) return;
        if (homeFabGroupDrag) return;

        // Ctrl + clic gauche → déplacer le bloc si accroché
        if (event.ctrlKey) {
          const cluster = findHomeFabClusterFor(fabId);
          if (cluster) {
            startHomeFabGroupDrag(event, cluster);
            return;
          }
        }

        if (homeFabsState[fabId]?.locked) return;

        // Sync state ↔ position visuelle réelle (évite le décalage curseur / slots)
        const visual = btn.getBoundingClientRect();
        const originX = visual.left;
        const originY = visual.top;
        homeFabsState[fabId].x = originX;
        homeFabsState[fabId].y = originY;
        btn.style.left = `${originX}px`;
        btn.style.top = `${originY}px`;
        homeFabDrag = {
          fabId,
          pointerId: event.pointerId,
          offsetX: event.clientX - originX,
          offsetY: event.clientY - originY,
          size: visual.width > 0 ? visual.width : HOME_FAB_SIZE,
          startX: event.clientX,
          startY: event.clientY,
          moved: false
        };
        btn.dataset.fabDidDrag = "0";
        btn.classList.add("is-dragging");
        btn.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      });
    });

    window.addEventListener("pointermove", (event) => {
      if (homeFabGroupDrag && homeFabGroupDrag.pointerId === event.pointerId) {
        if (Math.hypot(event.clientX - homeFabGroupDrag.startX, event.clientY - homeFabGroupDrag.startY) > 4) {
          homeFabGroupDrag.moved = true;
        }
        const bounds = homeFabGroupDrag.bounds
          || getHomeFabGroupOriginBounds(homeFabGroupDrag.origins, homeFabGroupDrag.fabIds);
        if (!bounds) return;

        const dx = event.clientX - homeFabGroupDrag.startX;
        const dy = event.clientY - homeFabGroupDrag.startY;
        const free = clampHomeFabGroupDelta(
          homeFabGroupDrag.fabIds,
          homeFabGroupDrag.origins,
          dx,
          dy
        );
        const proposedX = bounds.x + free.dx;
        const proposedY = bounds.y + free.dy;
        const guided = snapHomeFabGroupToDockGuide(bounds, proposedX, proposedY);
        const finalDx = guided.x - bounds.x;
        const finalDy = guided.y - bounds.y;

        applyHomeFabClusterOrigins(
          homeFabGroupDrag.fabIds,
          homeFabGroupDrag.origins,
          finalDx,
          finalDy
        );
        showHomeFabDockGuide(guided.snapped ? guided.guideX : null);
        if (homeFabGroupDrag.fabIds.includes("wifi")) positionWifiReconnectPopupNearFab();
        return;
      }

      if (!homeFabDrag || homeFabDrag.pointerId !== event.pointerId) return;
      const btn = getHomeFabEl(homeFabDrag.fabId);
      if (!btn || !homeFabsState) return;
      if (Math.hypot(event.clientX - homeFabDrag.startX, event.clientY - homeFabDrag.startY) > 4) {
        homeFabDrag.moved = true;
        btn.dataset.fabDidDrag = "1";
      }
      const size = homeFabDrag.size || HOME_FAB_SIZE;
      let next = resolveHomeFabPosition(
        homeFabDrag.fabId,
        event.clientX - homeFabDrag.offsetX,
        event.clientY - homeFabDrag.offsetY,
        size
      );
      const snapped = findHomeFabSnapCandidate(homeFabDrag.fabId, next.x, next.y);
      if (snapped) {
        next = resolveHomeFabPosition(homeFabDrag.fabId, snapped.x, snapped.y, size);
      }
      homeFabsState[homeFabDrag.fabId].x = next.x;
      homeFabsState[homeFabDrag.fabId].y = next.y;
      btn.style.left = `${next.x}px`;
      btn.style.top = `${next.y}px`;
      if (homeFabDrag.moved) {
        showHomeFabAttachSlots(homeFabDrag.fabId, snapped);
      }
      if (homeFabDrag.fabId === "wifi") positionWifiReconnectPopupNearFab();
    });

    const endFabDrag = (event) => {
      if (homeFabGroupDrag && homeFabGroupDrag.pointerId === event.pointerId) {
        const bounds = homeFabGroupDrag.bounds
          || getHomeFabGroupOriginBounds(homeFabGroupDrag.origins, homeFabGroupDrag.fabIds);
        if (bounds && homeFabGroupDrag.moved) {
          const current = getHomeFabClusterBounds(homeFabGroupDrag.fabIds);
          if (current) {
            const guided = snapHomeFabGroupToDockGuide(bounds, current.x, current.y);
            if (guided.snapped) {
              applyHomeFabClusterOrigins(
                homeFabGroupDrag.fabIds,
                homeFabGroupDrag.origins,
                guided.x - bounds.x,
                guided.y - bounds.y
              );
            }
          }
        }
        homeFabGroupDrag.fabIds.forEach((id) => {
          const el = getHomeFabEl(id);
          el?.classList.remove("is-dragging");
          if (homeFabGroupDrag.moved && el) el.dataset.fabDidDrag = "1";
        });
        document.querySelectorAll(".home-fab-group.is-dragging").forEach((box) => {
          box.classList.remove("is-dragging");
        });
        clearHomeFabGuides();
        separateAllHomeFabs(null);
        positionWifiReconnectPopupNearFab();
        syncHomeFabsVisibility();
        homeFabGroupDrag = null;
        return;
      }

      if (!homeFabDrag || homeFabDrag.pointerId !== event.pointerId) return;
      const fabId = homeFabDrag.fabId;
      const btn = getHomeFabEl(fabId);
      clearHomeFabGuides();
      if (btn && homeFabsState?.[fabId]) {
        btn.classList.remove("is-dragging");
        if (homeFabDrag.moved) {
          snapHomeFabPosition(fabId, homeFabsState[fabId].x, homeFabsState[fabId].y);
        } else {
          separateAllHomeFabs(fabId);
        }
        positionWifiReconnectPopupNearFab();
        syncHomeFabsVisibility();
      }
      homeFabDrag = null;
    };

    window.addEventListener("pointerup", endFabDrag);
    window.addEventListener("pointercancel", endFabDrag);

    window.addEventListener("home-fab-toggle-lock", (event) => {
      const fabId = event.detail?.fabId;
      if (fabId) toggleHomeFabLock(fabId);
    });

    window.addEventListener("home-fab-group-toggle-lock", (event) => {
      const fabIds = event.detail?.fabIds;
      if (Array.isArray(fabIds) && fabIds.length) toggleHomeFabGroupLock(fabIds);
    });

    window.addEventListener("resize", () => {
      if (!homeFabsState) return;
      applyHomeFabsLayout();
    });
  }

  const HOME_MODULES_STORAGE_KEY = "android-hub.home-modules.v2";
  const HOME_MODULE_IDS = ["devices", "sessions", "apps"];
  const HOME_MODULE_GAP = 12;
  /** Distance d’aimantation aux lignes-guides des titres. */
  const HOME_MODULE_TITLE_SNAP = 56;
  const HOME_MODULE_DEFAULTS = {
    devices: { x: 28, y: 28, orientation: "horizontal", locked: false, align: true, contentHidden: false },
    sessions: { x: 28, y: 160, orientation: "horizontal", locked: false, align: true, contentHidden: false },
    apps: { x: 520, y: 28, orientation: "vertical", locked: false, align: true, contentHidden: false }
  };

  let homeModulesState = null;
  let homeModuleDrag = null;

  function loadHomeModulesState() {
    try {
      let raw = localStorage.getItem(HOME_MODULES_STORAGE_KEY);
      if (!raw) {
        // Migrer v1 → v2 (ajoute align: true par défaut)
        raw = localStorage.getItem("android-hub.home-modules.v1");
      }
      const parsed = raw ? JSON.parse(raw) : null;
      homeModulesState = {
        devices: { ...HOME_MODULE_DEFAULTS.devices, ...(parsed?.devices || {}) },
        sessions: { ...HOME_MODULE_DEFAULTS.sessions, ...(parsed?.sessions || {}) },
        apps: { ...HOME_MODULE_DEFAULTS.apps, ...(parsed?.apps || {}) }
      };
      HOME_MODULE_IDS.forEach((id) => {
        if (typeof homeModulesState[id].align !== "boolean") {
          homeModulesState[id].align = true;
        }
        if (typeof homeModulesState[id].contentHidden !== "boolean") {
          homeModulesState[id].contentHidden = false;
        }
      });
    } catch (_err) {
      homeModulesState = {
        devices: { ...HOME_MODULE_DEFAULTS.devices },
        sessions: { ...HOME_MODULE_DEFAULTS.sessions },
        apps: { ...HOME_MODULE_DEFAULTS.apps }
      };
    }
    return homeModulesState;
  }

  function saveHomeModulesState(force = false) {
    if (!homeModulesState) return;
    // Ne jamais écraser la sauvegarde hors accueil (évite corruption session → retour)
    if (!force && typeof canMutateHomeModuleLayout === "function" && !canMutateHomeModuleLayout()) return;
    try {
      localStorage.setItem(HOME_MODULES_STORAGE_KEY, JSON.stringify(homeModulesState));
    } catch (_err) {
      /* ignore quota */
    }
  }

  function getHomeModuleEl(moduleId) {
    return document.querySelector(`.home-module[data-module-id="${moduleId}"]`);
  }

  function closeAllHomeModuleMenus(exceptId = null) {
    document.querySelectorAll(".home-module").forEach((module) => {
      const id = module.dataset?.moduleId;
      const menu = module.querySelector(".home-module-menu");
      const btn = module.querySelector(".home-module-menu-btn");
      if (exceptId && id === exceptId && menu && !menu.hasAttribute("hidden")) {
        module.classList.add("is-menu-open");
        return;
      }
      if (menu) {
        menu.hidden = true;
        menu.style.top = "";
        menu.style.left = "";
      }
      if (btn) btn.setAttribute("aria-expanded", "false");
      module.classList.remove("is-menu-open");
    });
  }

  function positionHomeModuleMenu(moduleEl) {
    const btn = moduleEl?.querySelector(".home-module-menu-btn");
    const menu = moduleEl?.querySelector(".home-module-menu");
    if (!btn || !menu || menu.hidden) return;

    // Mesure hors écran pour avoir width/height fiables
    menu.style.top = "-9999px";
    menu.style.left = "-9999px";
    const btnRect = btn.getBoundingClientRect();
    const menuW = menu.offsetWidth || 168;
    const menuH = menu.offsetHeight || 120;
    const gap = 8;
    const fabReserve = 90;
    let top = btnRect.bottom + gap;
    let left = btnRect.left + (btnRect.width / 2) - (menuW / 2);

    if (top + menuH > window.innerHeight - fabReserve) {
      top = btnRect.top - gap - menuH;
    }
    top = Math.max(8, Math.min(top, window.innerHeight - menuH - 8));
    left = Math.max(8, Math.min(left, window.innerWidth - menuW - 8));

    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
  }

  function updateHomeModuleMenuLabels(moduleEl) {
    if (!moduleEl) return;
    const id = moduleEl.dataset.moduleId;
    const state = homeModulesState?.[id];
    if (!state) return;
    const lockBtn = moduleEl.querySelector('[data-module-action="lock"]');
    if (lockBtn) {
      lockBtn.textContent = state.locked
        ? tHome("homeDashboard.moduleUnlock", "Déverrouiller")
        : tHome("homeDashboard.moduleLock", "Verrouiller");
    }
    const alignBtn = moduleEl.querySelector('[data-module-action="align"]');
    if (alignBtn) {
      const aligned = state.align !== false;
      alignBtn.textContent = aligned
        ? tHome("homeDashboard.moduleAlignOff", "Ne plus aligner les titres")
        : tHome("homeDashboard.moduleAlignOn", "Aligner les titres");
      alignBtn.classList.toggle("is-active", aligned);
    }
    const hideBtn = moduleEl.querySelector('[data-module-action="hide-content"]');
    if (hideBtn) {
      hideBtn.textContent = state.contentHidden
        ? tHome("homeDashboard.moduleShowContent", "Afficher le contenu")
        : tHome("homeDashboard.moduleHideContent", "Masquer le contenu");
      hideBtn.classList.toggle("is-active", Boolean(state.contentHidden));
    }
    moduleEl.querySelectorAll("[data-module-action]").forEach((btn) => {
      const action = btn.getAttribute("data-module-action");
      if (action === "horizontal" || action === "vertical") {
        btn.classList.toggle("is-active", action === state.orientation);
      }
    });
    moduleEl.classList.toggle("is-align-off", state.align === false);
  }

  function applyHomeModuleState(moduleId) {
    const moduleEl = getHomeModuleEl(moduleId);
    const state = homeModulesState?.[moduleId];
    if (!moduleEl || !state) return;

    if (typeof state.align !== "boolean") state.align = true;
    if (typeof state.contentHidden !== "boolean") state.contentHidden = false;
    moduleEl.dataset.orientation = state.orientation === "vertical" ? "vertical" : "horizontal";
    moduleEl.classList.toggle("is-locked", Boolean(state.locked));
    moduleEl.classList.toggle("is-content-hidden", Boolean(state.contentHidden));
    moduleEl.classList.toggle("is-align-off", state.align === false);
    moduleEl.style.left = `${Math.max(0, Number(state.x) || 0)}px`;
    moduleEl.style.top = `${Math.max(0, Number(state.y) || 0)}px`;
    updateHomeModuleMenuLabels(moduleEl);
  }

  /** Mémorise le centre X du titre pour le recentrer après un reflow. */
  const homeModuleTitleCenterX = Object.create(null);
  let homeModuleSepLock = false;
  let homeModuleSepTimer = 0;

  function clearHomeModuleTitleCenters() {
    HOME_MODULE_IDS.forEach((id) => {
      delete homeModuleTitleCenterX[id];
    });
  }

  function rememberHomeModuleTitleCenter(moduleId) {
    // Critique : ne jamais mémoriser hors accueil (sinon centre=0 → modules collés à gauche au retour)
    if (!canMutateHomeModuleLayout()) return;
    const box = getHomeModuleTitleBoxInHost(moduleId);
    if (!box || box.titleW < 8) return;
    homeModuleTitleCenterX[moduleId] = box.titleCenterX;
  }

  /**
   * Taille visuelle réelle d’un module (titre + contenu absolute).
   * offsetX/Y = décalage du coin haut-gauche visuel vs position sauvegardée (left/top).
   */
  function getHomeModuleVisualMetrics(moduleEl) {
    if (!moduleEl || moduleEl.hidden) {
      return { offsetX: 0, offsetY: 0, w: 160, h: 80 };
    }
    const moduleRect = moduleEl.getBoundingClientRect();
    let minL = Infinity;
    let minT = Infinity;
    let maxR = -Infinity;
    let maxB = -Infinity;
    const addRect = (el) => {
      if (!el) return;
      try {
        if (getComputedStyle(el).display === "none") return;
      } catch (_err) {
        return;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) return;
      minL = Math.min(minL, r.left);
      minT = Math.min(minT, r.top);
      maxR = Math.max(maxR, r.right);
      maxB = Math.max(maxB, r.bottom);
    };

    addRect(moduleEl.querySelector(".home-module-chrome") || moduleEl.querySelector(".home-module-title"));
    if (!moduleEl.classList.contains("is-content-hidden")) {
      addRect(moduleEl.querySelector(".home-module-body"));
    }
    if (!Number.isFinite(minL)) {
      const w = Math.max(moduleEl.offsetWidth || 160, 8);
      const h = Math.max(moduleEl.offsetHeight || 80, 8);
      return { offsetX: 0, offsetY: 0, w, h };
    }
    return {
      offsetX: minL - moduleRect.left,
      offsetY: minT - moduleRect.top,
      w: Math.max(1, maxR - minL),
      h: Math.max(1, maxB - minT)
    };
  }

  /** Boîte visuelle viewport pour anti-collision dock / modules. */
  function getHomeModuleViewportBox(moduleEl, x, y) {
    const host = document.querySelector(".empty-state");
    if (!host || !moduleEl) return null;
    const hostRect = host.getBoundingClientRect();
    const vis = getHomeModuleVisualMetrics(moduleEl);
    return {
      x: hostRect.left + x + vis.offsetX,
      y: hostRect.top + y + vis.offsetY,
      w: vis.w,
      h: vis.h
    };
  }

  /** Repousse les modules hors du dock en remontant tout le stack (écarts relatifs conservés). */
  function ensureHomeModulesClearOfDock() {
    if (!canMutateHomeModuleLayout() || !homeModulesState) return;
    const host = document.querySelector(".empty-state");
    if (!host) return;
    const dock = getCentralDockExclusionRect();
    let maxOverflow = 0;

    HOME_MODULE_IDS.forEach((moduleId) => {
      const moduleEl = getHomeModuleEl(moduleId);
      const state = homeModulesState[moduleId];
      if (!moduleEl || !state || moduleEl.hidden) return;

      const viewBox = getHomeModuleViewportBox(moduleEl, state.x, state.y);
      if (!viewBox || !boxesOverlap(viewBox, dock)) return;
      const overflow = (viewBox.y + viewBox.h) - dock.top;
      if (overflow > maxOverflow) maxOverflow = overflow;
    });

    if (maxOverflow <= 0.5) return;

    let changed = false;
    HOME_MODULE_IDS.forEach((moduleId) => {
      const moduleEl = getHomeModuleEl(moduleId);
      const state = homeModulesState[moduleId];
      if (!moduleEl || !state || moduleEl.hidden) return;
      const nextY = Math.max(0, state.y - maxOverflow);
      if (Math.abs(nextY - state.y) <= 0.5) return;
      state.y = Math.round(nextY);
      applyHomeModuleState(moduleId);
      rememberHomeModuleTitleCenter(moduleId);
      changed = true;
    });

    if (changed) saveHomeModulesState();
  }

  /** Séparation planifiée : décoller collisions + repousser hors du dock. */
  function scheduleHomeModulesSeparation() {
    if (!canMutateHomeModuleLayout()) return;
    if (homeModuleSepTimer) window.clearTimeout(homeModuleSepTimer);
    // Debounce un peu plus long pour éviter le saut 2 positions (RO + sync).
    homeModuleSepTimer = window.setTimeout(() => {
      homeModuleSepTimer = 0;
      if (!canMutateHomeModuleLayout() || homeModuleDrag) return;
      requestAnimationFrame(() => {
        if (!canMutateHomeModuleLayout() || homeModuleDrag) return;
        unstickOverlappingHomeModules();
        ensureHomeModulesClearOfDock();
        if (homeModulesStillOverlap()) unstickOverlappingHomeModules();
      });
    }, 120);
  }

  function cancelHomeModulesSeparation() {
    if (homeModuleSepTimer) {
      window.clearTimeout(homeModuleSepTimer);
      homeModuleSepTimer = 0;
    }
  }

  /**
   * Ancre titre : avec body en absolute sous le titre, le centre
   * ne bouge plus au reflow — on mémorise seulement.
   */
  function restoreHomeModuleTitleCenter(moduleId) {
    if (!canMutateHomeModuleLayout()) return;
    if (!homeModulesState?.[moduleId]) return;
    if (homeModuleDrag?.moduleId === moduleId) return;
    rememberHomeModuleTitleCenter(moduleId);
  }

  /** Recharge les positions depuis localStorage et les applique (sans recalcul ni séparation). */
  function restoreHomeModulesFromStorage() {
    try {
      const raw = localStorage.getItem(HOME_MODULES_STORAGE_KEY)
        || localStorage.getItem("android-hub.home-modules.v1");
      if (!raw) {
        if (!homeModulesState) loadHomeModulesState();
      } else {
        const parsed = JSON.parse(raw);
        if (!homeModulesState) loadHomeModulesState();
        HOME_MODULE_IDS.forEach((id) => {
          const saved = parsed?.[id];
          if (!saved || !homeModulesState[id]) return;
          const x = Number(saved.x);
          const y = Number(saved.y);
          if (Number.isFinite(x)) homeModulesState[id].x = Math.round(x);
          if (Number.isFinite(y)) homeModulesState[id].y = Math.round(y);
          if (saved.orientation) homeModulesState[id].orientation = saved.orientation;
          if (typeof saved.locked === "boolean") homeModulesState[id].locked = saved.locked;
          if (typeof saved.align === "boolean") homeModulesState[id].align = saved.align;
          if (typeof saved.contentHidden === "boolean") homeModulesState[id].contentHidden = saved.contentHidden;
        });
      }
    } catch (_err) {
      if (!homeModulesState) loadHomeModulesState();
    }
    HOME_MODULE_IDS.forEach(applyHomeModuleState);
  }

  /**
   * Boîte de collision visuelle (coords host) — titre + contenu
   * (le body est en absolute et peut dépasser du module).
   */
  function getHomeModuleCollisionBox(moduleId) {
    const host = document.querySelector(".empty-state");
    const moduleEl = getHomeModuleEl(moduleId);
    if (!host || !moduleEl || moduleEl.hidden) return null;
    const hostRect = host.getBoundingClientRect();
    if (hostRect.width < 80) return null;

    let minL = Infinity;
    let minT = Infinity;
    let maxR = -Infinity;
    let maxB = -Infinity;
    const addRect = (el) => {
      if (!el) return;
      try {
        if (getComputedStyle(el).display === "none") return;
      } catch (_err) {
        return;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) return;
      minL = Math.min(minL, r.left);
      minT = Math.min(minT, r.top);
      maxR = Math.max(maxR, r.right);
      maxB = Math.max(maxB, r.bottom);
    };

    addRect(moduleEl.querySelector(".home-module-chrome") || moduleEl.querySelector(".home-module-title"));
    if (!moduleEl.classList.contains("is-content-hidden")) {
      addRect(moduleEl.querySelector(".home-module-body"));
    }
    if (!Number.isFinite(minL)) {
      addRect(moduleEl);
    }
    if (!Number.isFinite(minL)) return null;

    const w = Math.max(1, maxR - minL);
    const h = Math.max(1, maxB - minT);
    if (w < 8 || h < 8) return null;
    return {
      id: moduleId,
      x: minL - hostRect.left,
      y: minT - hostRect.top,
      w,
      h
    };
  }

  function homeModulesStillOverlap() {
    for (let i = 0; i < HOME_MODULE_IDS.length; i += 1) {
      for (let j = i + 1; j < HOME_MODULE_IDS.length; j += 1) {
        const a = getHomeModuleCollisionBox(HOME_MODULE_IDS[i]);
        const b = getHomeModuleCollisionBox(HOME_MODULE_IDS[j]);
        if (a && b && homeModulesOverlap(a, b, HOME_MODULE_GAP)) return true;
      }
    }
    return false;
  }

  /**
   * Écarte les modules qui se chevauchent.
   * Règle : le module le plus bas (ou à égalité le 2ᵉ dans l’ordre) est poussé sous l’autre.
   * Les verrous n’empêchent PAS la séparation (sinon les collisions restent possibles).
   */
  function separateOverlappingHomeModules() {
    if (!homeModulesState) loadHomeModulesState();
    if (homeModuleSepLock) return;
    if (!canMutateHomeModuleLayout()) return;

    const host = document.querySelector(".empty-state");
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    if (hostRect.width < 240 || hostRect.height < 180) return;

    homeModuleSepLock = true;
    const gap = HOME_MODULE_GAP;
    let changed = false;

    try {
      for (let pass = 0; pass < 24; pass += 1) {
        let moved = false;
        const boxes = HOME_MODULE_IDS
          .map((id) => getHomeModuleCollisionBox(id))
          .filter(Boolean)
          // Haut → bas, puis ordre devices/sessions/apps
          .sort((a, b) => (a.y - b.y) || (HOME_MODULE_IDS.indexOf(a.id) - HOME_MODULE_IDS.indexOf(b.id)));

        for (let i = 0; i < boxes.length; i += 1) {
          for (let j = i + 1; j < boxes.length; j += 1) {
            const keep = boxes[i];
            const mov = boxes[j];
            if (!homeModulesOverlap(keep, mov, gap)) continue;

            const moveId = mov.id;
            const moveEl = getHomeModuleEl(moveId);
            const state = homeModulesState[moveId];
            if (!moveEl || !state) continue;

            // Toujours empiler sous le module du dessus (garde X du module déplacé)
            const moveVis = getHomeModuleVisualMetrics(moveEl);
            let nextX = state.x;
            let nextY = keep.y + keep.h + gap - moveVis.offsetY;

            // Si chevauchement surtout horizontal (côte à côte), pousser sur le côté
            const overlapX = Math.min(mov.x + mov.w, keep.x + keep.w) - Math.max(mov.x, keep.x);
            const overlapY = Math.min(mov.y + mov.h, keep.y + keep.h) - Math.max(mov.y, keep.y);
            const centersDx = Math.abs((mov.x + mov.w / 2) - (keep.x + keep.w / 2));
            const sideBySide = overlapY > overlapX && centersDx > Math.max(keep.w, mov.w) * 0.55;
            if (sideBySide) {
              nextX = mov.x >= keep.x
                ? keep.x + keep.w + gap - moveVis.offsetX
                : keep.x - mov.w - gap - moveVis.offsetX;
              nextY = state.y;
            }

            let clamped = clampHomeModulePosition(moveEl, nextX, nextY);
            // Si toujours en collision après clamp, forcer sous keep
            const trial = {
              x: clamped.x + moveVis.offsetX,
              y: clamped.y + moveVis.offsetY,
              w: mov.w,
              h: mov.h
            };
            if (homeModulesOverlap(trial, keep, gap)) {
              clamped = clampHomeModulePosition(moveEl, state.x, keep.y + keep.h + gap - moveVis.offsetY);
            }
            // Dernier recours : descendre sans clamp host trop strict
            if (
              clamped.x === state.x
              && clamped.y === state.y
            ) {
              clamped = {
                x: state.x,
                y: Math.round(keep.y + keep.h + gap - moveVis.offsetY)
              };
            }

            if (clamped.x === state.x && clamped.y === state.y) continue;

            state.x = Math.round(clamped.x);
            state.y = Math.round(clamped.y);
            applyHomeModuleState(moveId);
            // Remesurer pour la suite de cette passe
            const updated = getHomeModuleCollisionBox(moveId);
            if (updated) boxes[j] = updated;
            moved = true;
            changed = true;
          }
        }
        if (!moved) break;
      }

      // Vérification finale : encore un chevauchement → stack strict haut→bas
      if (homeModulesStillOverlap()) {
        const ordered = HOME_MODULE_IDS
          .map((id) => getHomeModuleCollisionBox(id))
          .filter(Boolean)
          .sort((a, b) => (a.y - b.y) || (HOME_MODULE_IDS.indexOf(a.id) - HOME_MODULE_IDS.indexOf(b.id)));
        for (let i = 1; i < ordered.length; i += 1) {
          const prev = getHomeModuleCollisionBox(ordered[i - 1].id) || ordered[i - 1];
          const cur = getHomeModuleCollisionBox(ordered[i].id) || ordered[i];
          if (!homeModulesOverlap(prev, cur, gap)) continue;
          const state = homeModulesState[cur.id];
          const el = getHomeModuleEl(cur.id);
          if (!state || !el) continue;
          const curVis = getHomeModuleVisualMetrics(el);
          const nextY = prev.y + prev.h + gap - curVis.offsetY;
          const clamped = clampHomeModulePosition(el, state.x, nextY);
          state.x = Math.round(clamped.x);
          state.y = Math.round(Math.max(clamped.y, nextY));
          applyHomeModuleState(cur.id);
          changed = true;
        }
      }

      if (changed) {
        HOME_MODULE_IDS.forEach(rememberHomeModuleTitleCenter);
        saveHomeModulesState();
      }
    } finally {
      homeModuleSepLock = false;
    }
  }

  /**
   * Écarte les autres modules du module `stayId` (qui reste en place).
   */
  function pushOthersAwayFromHomeModule(stayId) {
    if (!homeModulesState) loadHomeModulesState();
    if (homeModuleSepLock) return;
    separateOverlappingHomeModules();
    const stayState = homeModulesState[stayId];
    const stayEl = getHomeModuleEl(stayId);
    if (!stayState || !stayEl || stayEl.hidden) return;
    if (!homeModulesStillOverlap()) return;
    const fixed = resolveHomeModuleOverlaps(stayId, stayState.x, stayState.y);
    if (fixed.x !== stayState.x || fixed.y !== stayState.y) {
      stayState.x = fixed.x;
      stayState.y = fixed.y;
      applyHomeModuleState(stayId);
      rememberHomeModuleTitleCenter(stayId);
      saveHomeModulesState();
    }
  }

  function getHomeModuleStateBox(moduleId) {
    return getHomeModuleCollisionBox(moduleId);
  }

  function bindHomeModuleTitleCenterObservers() {
    HOME_MODULE_IDS.forEach((moduleId) => {
      const moduleEl = getHomeModuleEl(moduleId);
      if (!moduleEl || moduleEl.dataset.titleCenterObs === "1") return;
      moduleEl.dataset.titleCenterObs = "1";
      rememberHomeModuleTitleCenter(moduleId);
      const ro = new ResizeObserver(() => {
        if (!canMutateHomeModuleLayout()) return;
        if (homeModuleDrag?.moduleId === moduleId) {
          rememberHomeModuleTitleCenter(moduleId);
          return;
        }
        restoreHomeModuleTitleCenter(moduleId);
        scheduleHomeModulesSeparation();
      });
      ro.observe(moduleEl);
      const bodyEl = moduleEl.querySelector(".home-module-body");
      if (bodyEl) ro.observe(bodyEl);
    });
  }

  /**
   * Lignes-guides des titres (axe vertical + ligne horizontale).
   * Aimantation live pendant le drag + lignes visibles.
   */
  function getHomeModuleTitleBoxInHost(moduleId) {
    const host = document.querySelector(".empty-state");
    const moduleEl = getHomeModuleEl(moduleId);
    const titleEl = moduleEl?.querySelector(".home-module-title");
    if (!host || !moduleEl || !titleEl || moduleEl.hidden) return null;
    const hostRect = host.getBoundingClientRect();
    const titleRect = titleEl.getBoundingClientRect();
    const moduleRect = moduleEl.getBoundingClientRect();
    // Centre sur le libellé (pas le ⋮) pour aligner le contenu sous le texte.
    const labelEl = titleEl.querySelector("span") || titleEl;
    const labelRect = labelEl.getBoundingClientRect();
    if (labelRect.width < 4 || titleRect.height < 4 || hostRect.width < 80) return null;
    return {
      titleW: Math.max(1, labelRect.width),
      titleH: Math.max(1, titleRect.height),
      titleCenterX: labelRect.left - hostRect.left + labelRect.width / 2,
      titleCenterY: titleRect.top - hostRect.top + titleRect.height / 2,
      titleY: titleRect.top - hostRect.top,
      offsetTitleX: labelRect.left - moduleRect.left,
      offsetTitleY: titleRect.top - moduleRect.top
    };
  }

  function getCentralDockGuideInHost() {
    const host = document.querySelector(".empty-state");
    if (!host) return null;
    const hostRect = host.getBoundingClientRect();
    const dock = document.getElementById("quick-actions-dock");

    if (dock && !dock.classList.contains("dock-covered")) {
      const dockRect = dock.getBoundingClientRect();
      if (dockRect.width > 0 && dockRect.height > 0) {
        const dockCenterX = dockRect.left + dockRect.width / 2;
        const viewportCenterX = window.innerWidth / 2;
        // Ne l’utilise comme axe de centrage que si la barre est bien centrée
        if (Math.abs(dockCenterX - viewportCenterX) <= 14) {
          return {
            axis: "x",
            value: dockCenterX - hostRect.left,
            sourceId: "dock"
          };
        }
      }
    }

    // Repli : centre de la zone d’accueil
    return {
      axis: "x",
      value: hostRect.width / 2,
      sourceId: "center"
    };
  }

  function collectHomeModuleTitleGuides(excludeId = null) {
    if (!homeModulesState) loadHomeModulesState();
    const guides = [];

    const dockGuide = getCentralDockGuideInHost();
    if (dockGuide) guides.push(dockGuide);

    HOME_MODULE_IDS.forEach((id) => {
      if (id === excludeId) return;
      const state = homeModulesState[id];
      if (!state || state.align === false) return;
      const box = getHomeModuleTitleBoxInHost(id);
      if (!box) return;
      guides.push({ axis: "x", value: box.titleCenterX, sourceId: id });
      guides.push({ axis: "y", value: box.titleCenterY, sourceId: id });
    });
    return guides;
  }

  function ensureHomeModuleGuideLayer() {
    const host = document.querySelector(".empty-state");
    if (!host) return null;
    let layer = host.querySelector(".home-module-guide-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "home-module-guide-layer";
      layer.setAttribute("aria-hidden", "true");
      host.appendChild(layer);
    }
    return layer;
  }

  function clearHomeModuleGuides() {
    const layer = document.querySelector(".empty-state .home-module-guide-layer");
    if (layer) layer.innerHTML = "";
  }

  function showHomeModuleGuides(activeGuides) {
    const layer = ensureHomeModuleGuideLayer();
    if (!layer) return;
    layer.innerHTML = "";
    if (!activeGuides?.length) return;

    const seen = new Set();
    activeGuides.forEach((guide) => {
      const key = `${guide.axis}:${Math.round(guide.value)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const line = document.createElement("div");
      const isDock = guide.sourceId === "dock" || guide.sourceId === "center";
      line.className = `home-module-guide home-module-guide--${guide.axis}${isDock ? " home-module-guide--dock" : ""}`;
      if (guide.axis === "x") {
        line.style.left = `${Math.round(guide.value)}px`;
      } else {
        line.style.top = `${Math.round(guide.value)}px`;
      }
      layer.appendChild(line);
    });
  }

  /**
   * Applique l’aimantation aux lignes-guides des titres (+ axe central du dock).
   * titleMetrics : offsets/taille du titre (mesurés au début du drag).
   */
  function snapModuleToTitleGuides(moduleId, x, y, titleMetrics = null) {
    const moduleEl = getHomeModuleEl(moduleId);
    const state = homeModulesState?.[moduleId];
    if (!moduleEl || !state || state.align === false) {
      return { x, y, guides: [] };
    }

    const metrics = titleMetrics || getHomeModuleTitleBoxInHost(moduleId);
    if (!metrics) return { x, y, guides: [] };

    const guides = collectHomeModuleTitleGuides(moduleId);
    if (!guides.length) return { x, y, guides: [] };

    const titleCenterX = x + metrics.offsetTitleX + metrics.titleW / 2;
    const titleCenterY = y + metrics.offsetTitleY + metrics.titleH / 2;

    let bestX = null;
    let bestY = null;
    let bestXDist = Infinity;
    let bestYDist = Infinity;
    const active = [];

    guides.forEach((guide) => {
      if (guide.axis === "x") {
        const dist = Math.abs(titleCenterX - guide.value);
        // Légère priorité à l’axe du dock pour un centrage fluide
        const score = dist - (guide.sourceId === "dock" || guide.sourceId === "center" ? 0.5 : 0);
        if (dist <= HOME_MODULE_TITLE_SNAP && score < bestXDist) {
          bestXDist = score;
          bestX = guide;
        }
      } else {
        const dist = Math.abs(titleCenterY - guide.value);
        if (dist <= HOME_MODULE_TITLE_SNAP && dist < bestYDist) {
          bestYDist = dist;
          bestY = guide;
        }
      }
    });

    let nextX = x;
    let nextY = y;
    if (bestX) {
      nextX = bestX.value - metrics.offsetTitleX - metrics.titleW / 2;
      active.push(bestX);
    }
    if (bestY) {
      nextY = bestY.value - metrics.offsetTitleY - metrics.titleH / 2;
      active.push(bestY);
    }

    const clamped = clampHomeModulePosition(moduleEl, nextX, nextY);
    return {
      x: Math.round(clamped.x),
      y: Math.round(clamped.y),
      guides: active
    };
  }

  function snapHomeModuleTitleIfSameLine(moduleId) {
    if (!homeModulesState) loadHomeModulesState();
    const state = homeModulesState[moduleId];
    if (!state || state.align === false) return false;
    const snapped = snapModuleToTitleGuides(moduleId, state.x, state.y);
    if (!snapped.guides.length) return false;
    state.x = snapped.x;
    state.y = snapped.y;
    applyHomeModuleState(moduleId);
    return true;
  }

  function toggleHomeModuleAlign(moduleId) {
    if (!homeModulesState) loadHomeModulesState();
    const state = homeModulesState[moduleId];
    if (!state) return;
    state.align = state.align === false;
    saveHomeModulesState();
    applyHomeModuleState(moduleId);
    closeAllHomeModuleMenus();
  }

  function applyHomeModulesLayout() {
    if (!homeModulesState) loadHomeModulesState();
    // Appliquer uniquement les positions sauvegardées — jamais de repositionnement auto
    HOME_MODULE_IDS.forEach(applyHomeModuleState);
  }

  function clampHomeModulePosition(moduleEl, x, y) {
    const host = document.querySelector(".empty-state");
    if (!host || !moduleEl) return { x, y };
    const hostRect = host.getBoundingClientRect();
    const vis = getHomeModuleVisualMetrics(moduleEl);
    const width = vis.w;
    const height = vis.h;
    // Host invalide / vue session : ne pas écraser la position (sinon → x=0 à gauche)
    if (hostRect.width < 240 || hostRect.height < 180) {
      return { x, y };
    }
    const maxX = Math.max(0, hostRect.width - width - vis.offsetX - 8);
    const maxY = Math.max(0, hostRect.height - height - vis.offsetY - 8);
    let next = {
      x: width + vis.offsetX + 8 >= hostRect.width ? x : Math.min(Math.max(0, x), maxX),
      y: height + vis.offsetY + 8 >= hostRect.height ? y : Math.min(Math.max(0, y), maxY)
    };

    // Interdire le chevauchement avec la barre centrale (titre + contenu absolute)
    const dock = getCentralDockExclusionRect();
    const viewBox = getHomeModuleViewportBox(moduleEl, next.x, next.y);
    if (viewBox && boxesOverlap(viewBox, dock)) {
      const pushed = pushBoxOutOfDock(viewBox.x, viewBox.y, viewBox.w, viewBox.h);
      next = {
        x: pushed.x - hostRect.left - vis.offsetX,
        y: pushed.y - hostRect.top - vis.offsetY
      };
      if (width + vis.offsetX + 8 < hostRect.width) {
        next.x = Math.min(Math.max(0, next.x), maxX);
      }
      if (height + vis.offsetY + 8 < hostRect.height) {
        next.y = Math.min(Math.max(0, next.y), maxY);
      }
    }
    return next;
  }

  function getHomeModuleBoxInHost(moduleId) {
    const host = document.querySelector(".empty-state");
    const moduleEl = getHomeModuleEl(moduleId);
    if (!host || !moduleEl || moduleEl.hidden) return null;
    const hostRect = host.getBoundingClientRect();
    const rect = moduleEl.getBoundingClientRect();
    return {
      x: rect.left - hostRect.left,
      y: rect.top - hostRect.top,
      w: Math.max(1, rect.width),
      h: Math.max(1, rect.height)
    };
  }

  function homeModulesOverlap(a, b, gap = HOME_MODULE_GAP) {
    return !(
      a.x + a.w + gap <= b.x
      || b.x + b.w + gap <= a.x
      || a.y + a.h + gap <= b.y
      || b.y + b.h + gap <= a.y
    );
  }

  /**
   * Trouve une position sans chevauchement pour un module.
   * Si (x,y) est libre → inchangé. Sinon pousse sous les modules en conflit (garde X autant que possible).
   * Ne renvoie jamais une position encore en collision si une place libre existe plus bas.
   */
  function resolveHomeModuleOverlaps(moduleId, x, y) {
    const moduleEl = getHomeModuleEl(moduleId);
    if (!moduleEl) return { x, y };

    const vis = getHomeModuleVisualMetrics(moduleEl);
    const gap = HOME_MODULE_GAP;
    let next = clampHomeModulePosition(moduleEl, x, y);
    next = { x: next.x, y: next.y, w: vis.w, h: vis.h, ox: vis.offsetX, oy: vis.offsetY };

    for (let pass = 0; pass < 20; pass += 1) {
      let blocker = null;
      for (const otherId of HOME_MODULE_IDS) {
        if (otherId === moduleId) continue;
        const other = getHomeModuleCollisionBox(otherId);
        if (!other) continue;
        const trial = { x: next.x + next.ox, y: next.y + next.oy, w: next.w, h: next.h };
        if (!homeModulesOverlap(trial, other, gap)) continue;
        if (!blocker || other.y + other.h > blocker.y + blocker.h) {
          blocker = other;
        }
      }
      if (!blocker) break;

      const belowY = blocker.y + blocker.h + gap - next.oy;
      const sideRight = blocker.x + blocker.w + gap - next.ox;
      const sideLeft = blocker.x - next.w - gap - next.ox;

      const candidates = [
        { x: next.x, y: belowY },
        { x: sideRight, y: blocker.y - next.oy },
        { x: sideLeft, y: blocker.y - next.oy },
        { x: next.x, y: blocker.y - next.h - gap - next.oy }
      ];

      let chosen = null;
      for (const c of candidates) {
        const clamped = clampHomeModulePosition(moduleEl, c.x, c.y);
        const trial = {
          x: clamped.x + vis.offsetX,
          y: clamped.y + vis.offsetY,
          w: vis.w,
          h: vis.h
        };
        const hits = HOME_MODULE_IDS.some((oid) => {
          if (oid === moduleId) return false;
          const o = getHomeModuleCollisionBox(oid);
          return o && homeModulesOverlap(trial, o, gap);
        });
        if (!hits) {
          chosen = clamped;
          break;
        }
      }

      if (!chosen) {
        chosen = clampHomeModulePosition(moduleEl, next.x, belowY);
        if (chosen.y < belowY) chosen = { x: next.x, y: belowY };
      }

      if (Math.abs(chosen.x - next.x) < 0.5 && Math.abs(chosen.y - next.y) < 0.5) {
        next.y = belowY + pass + 1;
        next.x = chosen.x;
      } else {
        next.x = chosen.x;
        next.y = chosen.y;
      }
    }

    const finalPos = clampHomeModulePosition(moduleEl, next.x, next.y);
    const still = HOME_MODULE_IDS
      .filter((id) => id !== moduleId)
      .map((id) => getHomeModuleCollisionBox(id))
      .filter(Boolean)
      .filter((o) => homeModulesOverlap(
        { x: finalPos.x + vis.offsetX, y: finalPos.y + vis.offsetY, w: vis.w, h: vis.h },
        o,
        gap
      ));
    if (still.length) {
      const bottom = still.reduce((m, o) => Math.max(m, o.y + o.h), 0);
      return { x: finalPos.x, y: Math.round(bottom + gap - vis.offsetY) };
    }
    return finalPos;
  }

  /** Corrige les collisions existantes (Y seulement) sans toucher au X — safe au chargement. */
  function unstickOverlappingHomeModules() {
    if (!homeModulesState || !canMutateHomeModuleLayout()) return;
    if (homeModuleDrag) return;
    let changed = false;
    for (let pass = 0; pass < 12; pass += 1) {
      let moved = false;
      const boxes = HOME_MODULE_IDS
        .map((id) => {
          const box = getHomeModuleCollisionBox(id);
          return box ? { ...box, state: homeModulesState[id] } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (a.y - b.y) || (HOME_MODULE_IDS.indexOf(a.id) - HOME_MODULE_IDS.indexOf(b.id)));

      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const keep = boxes[i];
          const mov = boxes[j];
          if (!homeModulesOverlap(keep, mov, HOME_MODULE_GAP)) continue;
          const state = homeModulesState[mov.id];
          const el = getHomeModuleEl(mov.id);
          if (!state || !el) continue;
          const movVis = getHomeModuleVisualMetrics(el);
          const belowY = keep.y + keep.h + HOME_MODULE_GAP - movVis.offsetY;
          const fixed = resolveHomeModuleOverlaps(mov.id, state.x, belowY);
          // Préserver X d’origine si possible
          const withX = resolveHomeModuleOverlaps(mov.id, state.x, fixed.y);
          if (withX.x !== state.x || withX.y !== state.y) {
            state.x = withX.x;
            state.y = withX.y;
            applyHomeModuleState(mov.id);
            moved = true;
            changed = true;
          }
        }
      }
      if (!moved) break;
    }
    if (changed) saveHomeModulesState(true);
  }

  function setHomeModuleOrientation(moduleId, orientation) {
    if (!homeModulesState) loadHomeModulesState();
    const state = homeModulesState[moduleId];
    if (!state) return;
    state.orientation = orientation === "vertical" ? "vertical" : "horizontal";
    applyHomeModuleState(moduleId);
    if (moduleId === "devices") layoutHomeDevicesSplit();
    if (moduleId === "sessions") layoutHomeSessionsSplit();
    const fixed = resolveHomeModuleOverlaps(moduleId, state.x, state.y);
    state.x = fixed.x;
    state.y = fixed.y;
    applyHomeModuleState(moduleId);
    saveHomeModulesState();
    closeAllHomeModuleMenus();
  }

  function toggleHomeModuleLock(moduleId) {
    if (!homeModulesState) loadHomeModulesState();
    const state = homeModulesState[moduleId];
    if (!state) return;
    state.locked = !state.locked;
    saveHomeModulesState();
    applyHomeModuleState(moduleId);
    closeAllHomeModuleMenus();
  }

  function toggleHomeModuleContentHidden(moduleId) {
    if (!homeModulesState) loadHomeModulesState();
    const state = homeModulesState[moduleId];
    if (!state) return;
    state.contentHidden = !state.contentHidden;
    saveHomeModulesState();
    applyHomeModuleState(moduleId);
    closeAllHomeModuleMenus();
    scheduleHomeModulesSeparation();
  }

  function bindHomeModules() {
    const root = document.querySelector(".empty-state");
    if (!root || root.dataset.homeModulesBound === "1") return;
    root.dataset.homeModulesBound = "1";
    loadHomeModulesState();
    applyHomeModulesLayout();
    bindHomeModuleTitleCenterObservers();
    HOME_MODULE_IDS.forEach(rememberHomeModuleTitleCenter);
    scheduleHomeModulesSeparation();

    root.addEventListener("click", (event) => {
      const menuBtn = event.target.closest?.(".home-module-menu-btn");
      if (menuBtn) {
        event.preventDefault();
        event.stopPropagation();
        const moduleId = menuBtn.getAttribute("data-module-menu");
        const moduleEl = getHomeModuleEl(moduleId);
        const menu = moduleEl?.querySelector(".home-module-menu");
        if (!menu) return;
        const willOpen = menu.hasAttribute("hidden");
        closeAllHomeModuleMenus();
        if (willOpen) {
          updateHomeModuleMenuLabels(moduleEl);
          menu.hidden = false;
          menuBtn.setAttribute("aria-expanded", "true");
          moduleEl.classList.add("is-menu-open");
          positionHomeModuleMenu(moduleEl);
        }
        return;
      }

      const actionBtn = event.target.closest?.("[data-module-action]");
      if (actionBtn) {
        event.preventDefault();
        event.stopPropagation();
        const moduleEl = actionBtn.closest(".home-module");
        const moduleId = moduleEl?.dataset?.moduleId;
        const action = actionBtn.getAttribute("data-module-action");
        if (!moduleId || !action) return;
        if (action === "lock") toggleHomeModuleLock(moduleId);
        else if (action === "hide-content") toggleHomeModuleContentHidden(moduleId);
        else if (action === "align") toggleHomeModuleAlign(moduleId);
        else if (action === "vertical" || action === "horizontal") {
          setHomeModuleOrientation(moduleId, action);
        }
      }
    });

    root.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest?.(".home-module-menu-btn, .home-module-menu, button, a, input, .home-session-tile, .home-app-tile, .sidebar-device-card")) {
        return;
      }
      const title = event.target.closest?.(".home-module-title");
      if (!title) return;
      const moduleEl = title.closest(".home-module");
      const moduleId = moduleEl?.dataset?.moduleId;
      if (!moduleEl || !moduleId) return;
      if (!homeModulesState) loadHomeModulesState();
      if (homeModulesState[moduleId]?.locked) return;

      const host = document.querySelector(".empty-state");
      if (!host) return;
      const hostRect = host.getBoundingClientRect();
      const originX = Number(homeModulesState[moduleId].x) || 0;
      const originY = Number(homeModulesState[moduleId].y) || 0;
      moduleEl.style.left = `${originX}px`;
      moduleEl.style.top = `${originY}px`;
      const titleMetrics = getHomeModuleTitleBoxInHost(moduleId);
      homeModuleDrag = {
        moduleId,
        pointerId: event.pointerId,
        offsetX: event.clientX - hostRect.left - originX,
        offsetY: event.clientY - hostRect.top - originY,
        titleMetrics,
        alignEnabled: homeModulesState[moduleId]?.align !== false
      };
      moduleEl.classList.add("is-dragging");
      closeAllHomeModuleMenus();
      title.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    root.addEventListener("pointermove", (event) => {
      if (!homeModuleDrag || homeModuleDrag.pointerId !== event.pointerId) return;
      const host = document.querySelector(".empty-state");
      const moduleEl = getHomeModuleEl(homeModuleDrag.moduleId);
      if (!host || !moduleEl || !homeModulesState) return;
      const hostRect = host.getBoundingClientRect();
      let next = clampHomeModulePosition(
        moduleEl,
        event.clientX - hostRect.left - homeModuleDrag.offsetX,
        event.clientY - hostRect.top - homeModuleDrag.offsetY
      );

      if (homeModuleDrag.alignEnabled) {
        const snapped = snapModuleToTitleGuides(
          homeModuleDrag.moduleId,
          next.x,
          next.y,
          homeModuleDrag.titleMetrics
        );
        const resolved = resolveHomeModuleOverlaps(
          homeModuleDrag.moduleId,
          snapped.x,
          snapped.y
        );
        // N’accepter le snap que s’il ne provoque pas un chevauchement irrésolu
        const vis = getHomeModuleVisualMetrics(moduleEl);
        const trial = {
          x: resolved.x + vis.offsetX,
          y: resolved.y + vis.offsetY,
          w: vis.w,
          h: vis.h
        };
        const stillHits = HOME_MODULE_IDS.some((oid) => {
          if (oid === homeModuleDrag.moduleId) return false;
          const o = getHomeModuleCollisionBox(oid);
          return o && homeModulesOverlap(trial, o, HOME_MODULE_GAP);
        });
        if (!stillHits) {
          next = { x: resolved.x, y: resolved.y };
          showHomeModuleGuides(snapped.guides);
        } else {
          next = resolveHomeModuleOverlaps(homeModuleDrag.moduleId, next.x, next.y);
          clearHomeModuleGuides();
        }
      } else {
        clearHomeModuleGuides();
        next = resolveHomeModuleOverlaps(homeModuleDrag.moduleId, next.x, next.y);
      }

      homeModulesState[homeModuleDrag.moduleId].x = next.x;
      homeModulesState[homeModuleDrag.moduleId].y = next.y;
      moduleEl.style.left = `${next.x}px`;
      moduleEl.style.top = `${next.y}px`;
      rememberHomeModuleTitleCenter(homeModuleDrag.moduleId);
    });

    const endDrag = (event) => {
      if (!homeModuleDrag || homeModuleDrag.pointerId !== event.pointerId) return;
      const moduleId = homeModuleDrag.moduleId;
      const moduleEl = getHomeModuleEl(moduleId);
      clearHomeModuleGuides();
      if (moduleEl && homeModulesState?.[moduleId]) {
        moduleEl.classList.remove("is-dragging");
        let left = Number(homeModulesState[moduleId].x) || 0;
        let top = Number(homeModulesState[moduleId].y) || 0;
        if (homeModuleDrag.alignEnabled) {
          const snapped = snapModuleToTitleGuides(
            moduleId,
            left,
            top,
            homeModuleDrag.titleMetrics
          );
          left = snapped.x;
          top = snapped.y;
        }
        // Snap d’abord, puis anti-collision — refuse de rester sur un autre module
        const fixed = resolveHomeModuleOverlaps(moduleId, left, top);
        homeModulesState[moduleId].x = fixed.x;
        homeModulesState[moduleId].y = fixed.y;
        applyHomeModuleState(moduleId);
        unstickOverlappingHomeModules();
        ensureHomeModulesClearOfDock();
        saveHomeModulesState(true);
        applyHomeFabsLayout();
        rememberHomeModuleTitleCenter(moduleId);
      }
      homeModuleDrag = null;
    };

    root.addEventListener("pointerup", endDrag);
    root.addEventListener("pointercancel", endDrag);

    window.addEventListener("resize", () => {
      // Ne pas déplacer ni réécrire les positions hors de l’accueil
      // (ex. Stream Deck / session : le host peut faire 0×0 et écraserait tout en haut à gauche).
      if (!homeModulesState || !isHomeVisible()) return;
      const host = document.querySelector(".empty-state");
      if (!host) return;
      const hostRect = host.getBoundingClientRect();
      if (hostRect.width < 80 || hostRect.height < 80) return;
      const openModule = document.querySelector(".home-module.is-menu-open");
      if (openModule) positionHomeModuleMenu(openModule);
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

  async function resolveHistoryDeviceColor(deviceId) {
    const id = String(deviceId || "").trim();
    if (!id) return "";

    const candidates = new Set([id]);
    const devices = typeof window.getCurrentDevices === "function" ? window.getCurrentDevices() : [];
    const live = (Array.isArray(devices) ? devices : []).find((device) =>
      device?.deviceId === id
      || device?.serial === id
      || device?.usbSerial === id
      || device?.wifiSerial === id
    );
    if (live) {
      [live.deviceId, live.serial, live.usbSerial, live.wifiSerial]
        .filter(Boolean)
        .forEach((key) => candidates.add(String(key)));
    }

    // Toujours privilégier l’API (source de vérité après changement de couleur),
    // le cache renderer peut encore porter l’ancienne pastille.
    if (window.deviceColorsAPI?.get) {
      for (const key of candidates) {
        try {
          const response = await window.deviceColorsAPI.get({ deviceId: key });
          if (response?.deviceColor?.hex) return String(response.deviceColor.hex);
        } catch (_err) {
          /* try next key */
        }
      }
    }

    return live?.deviceColor?.hex ? String(live.deviceColor.hex) : "";
  }

  async function resolveHistoryDeviceAliases(deviceId) {
    const id = String(deviceId || "").trim();
    if (!id) return [];

    const aliases = [];
    const push = (value) => {
      const name = String(value || "").trim();
      if (name && !aliases.includes(name)) aliases.push(name);
    };

    const devices = typeof window.getCurrentDevices === "function" ? window.getCurrentDevices() : [];
    const live = (Array.isArray(devices) ? devices : []).find((device) =>
      device?.deviceId === id
      || device?.serial === id
      || device?.usbSerial === id
      || device?.wifiSerial === id
    );
    if (live) {
      push(live.name);
      push(live.originalName);
      push(live.model);
    }

    const candidates = [id];
    if (live) {
      [live.deviceId, live.serial, live.usbSerial, live.wifiSerial]
        .filter(Boolean)
        .forEach((key) => {
          if (!candidates.includes(String(key))) candidates.push(String(key));
        });
    }

    if (window.namesAPI?.getDeviceInfo) {
      for (const key of candidates) {
        try {
          const info = await window.namesAPI.getDeviceInfo({
            serial: key,
            fallbackName: live?.name || key
          });
          push(info?.name);
          push(info?.originalName);
          push(info?.customName);
        } catch (_err) {
          /* try next */
        }
      }
    }

    if (!aliases.length) push(id);
    return aliases;
  }

  async function resolveHistoryDeviceName(deviceId) {
    const aliases = await resolveHistoryDeviceAliases(deviceId);
    return aliases[0] || "";
  }

  function buildAppLaunchTipHtml(_appName, deviceName, colorHex) {
    const label = String(deviceName || "").trim();
    if (!label) return "";
    const color = /^#[0-9A-Fa-f]{6}$/.test(String(colorHex || "").trim())
      ? String(colorHex).trim()
      : "";
    const pillStyle = color ? ` style="background:${escapeAttr(color)}"` : "";
    return (
      `<span class="app-launch-tip" aria-hidden="true">` +
      `<span class="app-launch-tip-pill"${pillStyle}></span>` +
      `<span class="app-launch-tip-title">${escapeHtml(label)}</span>` +
      `</span>`
    );
  }

  function buildHomeAppKey(entry = {}) {
    const deviceId = String(entry.deviceId || "");
    const packageName = String(entry.packageName || entry.package || "");
    const userId = entry.userId === undefined || entry.userId === null || entry.userId === ""
      ? 0
      : Number(entry.userId);
    return `${deviceId}::${packageName}::${Number.isFinite(userId) ? userId : 0}`;
  }

  function loadPinnedApps() {
    try {
      const raw = localStorage.getItem(HOME_PINNED_APPS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      pinnedEntries = Array.isArray(parsed)
        ? parsed
          .filter((entry) => entry && entry.deviceId && entry.packageName)
          .map((entry) => ({
            key: buildHomeAppKey(entry),
            deviceId: String(entry.deviceId),
            packageName: String(entry.packageName),
            appName: entry.appName || entry.packageName,
            userId: entry.userId === undefined || entry.userId === null ? null : Number(entry.userId),
            iconPath: entry.iconPath || null,
            iconUrl: entry.iconUrl || null,
            pinnedAt: Number(entry.pinnedAt) || Date.now()
          }))
          .slice(0, HOME_PINNED_APPS_MAX)
        : [];
    } catch (_err) {
      pinnedEntries = [];
    }
    pinnedAppsLoaded = true;
    return pinnedEntries;
  }

  function ensurePinnedAppsLoaded() {
    if (!pinnedAppsLoaded) loadPinnedApps();
    return pinnedEntries;
  }

  function savePinnedApps() {
    try {
      localStorage.setItem(HOME_PINNED_APPS_STORAGE_KEY, JSON.stringify(pinnedEntries));
    } catch (_err) {
      /* ignore quota */
    }
  }

  function isHomeAppPinned(entry) {
    ensurePinnedAppsLoaded();
    const key = buildHomeAppKey(entry);
    return pinnedEntries.some((item) => item.key === key);
  }

  function getHomePinnedAppKeys() {
    ensurePinnedAppsLoaded();
    return pinnedEntries.map((entry) => entry.key);
  }

  function pinHomeApp(entry = {}) {
    if (!entry.deviceId || !entry.packageName) return getHomePinnedApps();
    ensurePinnedAppsLoaded();
    const key = buildHomeAppKey(entry);
    const existing = pinnedEntries.findIndex((item) => item.key === key);
    const next = {
      key,
      deviceId: String(entry.deviceId),
      packageName: String(entry.packageName),
      appName: entry.appName || entry.packageName,
      userId: entry.userId === undefined || entry.userId === null || entry.userId === ""
        ? null
        : Number(entry.userId),
      iconPath: entry.iconPath || null,
      iconUrl: entry.iconUrl || null,
      pinnedAt: Date.now()
    };
    if (existing >= 0) {
      pinnedEntries[existing] = { ...pinnedEntries[existing], ...next, pinnedAt: pinnedEntries[existing].pinnedAt };
    } else {
      pinnedEntries = [next, ...pinnedEntries].slice(0, HOME_PINNED_APPS_MAX);
    }
    savePinnedApps();
    void syncHomeApps();
    return getHomePinnedApps();
  }

  function unpinHomeApp(entry = {}) {
    ensurePinnedAppsLoaded();
    const key = buildHomeAppKey(entry);
    pinnedEntries = pinnedEntries.filter((item) => item.key !== key);
    savePinnedApps();
    void syncHomeApps();
    return getHomePinnedApps();
  }

  function getHomePinnedApps() {
    ensurePinnedAppsLoaded();
    return pinnedEntries.map((entry) => ({ ...entry }));
  }

  function getHomeAppPlaceholderSvg() {
    return globalThis.HubAppIconPlaceholder?.APP_ICON_PLACEHOLDER_SVG
      || '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="10" r="2.2" fill="currentColor"/><path d="M7.5 17c1.2-1.6 2.7-2.4 4.5-2.4s3.3.8 4.5 2.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  }

  async function buildHomeAppTileHtml(entry, index, { pinned = false, indexAttr = "data-recent-index" } = {}) {
    const deviceId = entry.deviceId || "";
    const aliases = await resolveHistoryDeviceAliases(deviceId);
    const deviceName = aliases[0] || "";
    const name = window.AppDisplay?.resolveHistoryAppName
      ? window.AppDisplay.resolveHistoryAppName(entry, aliases || deviceName)
      : (entry.appName || entry.packageName || "");
    const iconSrc = (window.HubPerformance && !window.HubPerformance.isEnabled("appLogos"))
      ? ""
      : (entry.iconUrl || entry.iconPath || "");
    const iconHtml = iconSrc
      ? `<img src="${escapeAttr(iconSrc)}" alt="" loading="lazy">`
      : getHomeAppPlaceholderSvg();
    const iconClass = iconSrc ? "" : " is-placeholder";
    const color = await resolveHistoryDeviceColor(deviceId);
    const tipHtml = buildAppLaunchTipHtml(name, deviceName || deviceId, color);
    const pillHtml = color
      ? `<span class="home-app-device-pill device-color-pill" style="background:${escapeAttr(color)}" aria-hidden="true"></span>`
      : "";
    const pinBadge = pinned
      ? `<span class="home-app-pin-badge" aria-hidden="true"><svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M14.5 3.5 20.5 9.5 13 17l-1.5-1.5L17 10l-4-4-5.5 5.5L6 10l7.5-7.5zM4 20l5-2-3-3-2 5z"/></svg></span>`
      : "";
    const label = name || deviceName;
    const classes = pinned ? "home-app-tile home-app-tile--pinned" : "home-app-tile";
    return (
      `<button type="button" class="${classes}" ${indexAttr}="${index}" data-device-id="${escapeAttr(deviceId)}" data-pinned="${pinned ? "1" : "0"}" aria-label="${escapeAttr(label)}">` +
      `<div class="home-app-tile-icon${iconClass}">${iconHtml}${pillHtml}${pinBadge}</div>` +
      `<span class="home-app-tile-name">${escapeAttr(name)}</span>` +
      tipHtml +
      `</button>`
    );
  }

  function bindHomeAppTileInteractions(container, entries, { pinned = false, indexAttr = "data-recent-index" } = {}) {
    if (!container) return;
    container.querySelectorAll(".home-app-tile").forEach((tile) => {
      tile.addEventListener("click", () => {
        const index = Number(tile.getAttribute(indexAttr));
        const entry = entries[index];
        if (!entry) return;
        void launchRecentApp(entry);
      });
      tile.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const index = Number(tile.getAttribute(indexAttr));
        const entry = entries[index];
        if (!entry || !window.namesAPI?.showContextMenu) return;
        void window.namesAPI.showContextMenu({
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
          target: {
            kind: "app",
            deviceId: entry.deviceId,
            packageName: entry.packageName,
            appName: entry.appName || entry.packageName,
            userId: entry.userId ?? null,
            iconPath: entry.iconPath || null,
            iconUrl: entry.iconUrl || null,
            pinned: pinned || isHomeAppPinned(entry)
          }
        });
      });
    });
  }

  let homeAppsMoreIgnoreCloseUntil = 0;
  /** @type {"pinned"|"recent"|null} */
  let homeAppsMoreOpenKind = null;
  let homeAppsMoreOpenSeq = 0;

  function getHomeAppsMoreAnchor(kind) {
    return document.querySelector(`.home-apps-more-btn[data-apps-more="${kind}"]`);
  }

  function closeHomeAppsMorePopup() {
    homeAppsMoreOpenKind = null;
    const popup = document.getElementById("home-apps-more-popup");
    if (!popup) return;
    popup.classList.add("hidden");
    popup.setAttribute("hidden", "");
    popup.dataset.appsGroup = "";
    const grid = document.getElementById("home-apps-more-grid");
    if (grid) grid.innerHTML = "";
    document.querySelectorAll(".home-apps-more-btn[aria-expanded='true']").forEach((btn) => {
      btn.setAttribute("aria-expanded", "false");
    });
  }

  function positionHomeAppsMorePopup(anchorEl) {
    const popup = document.getElementById("home-apps-more-popup");
    if (!popup || !anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const popupW = popup.offsetWidth || 280;
    const popupH = popup.offsetHeight || 220;
    let left = rect.left + rect.width / 2 - popupW / 2;
    let top = rect.bottom + 8;
    if (top + popupH > window.innerHeight - 8) {
      top = rect.top - popupH - 8;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - popupW - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - popupH - 8));
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  }

  /** Après rebuild de la strip : garder le popup ouvert et le ré-ancrer. */
  function preserveHomeAppsMoreAfterStripSync() {
    const kind = homeAppsMoreOpenKind;
    if (!kind) {
      closeHomeAppsMorePopup();
      return;
    }
    const popup = document.getElementById("home-apps-more-popup");
    const anchor = getHomeAppsMoreAnchor(kind);
    if (!popup || !anchor) {
      closeHomeAppsMorePopup();
      return;
    }
    popup.dataset.appsGroup = kind;
    popup.classList.remove("hidden");
    popup.removeAttribute("hidden");
    document.querySelectorAll(".home-apps-more-btn").forEach((btn) => {
      btn.setAttribute("aria-expanded", btn.dataset.appsMore === kind ? "true" : "false");
    });
    positionHomeAppsMorePopup(anchor);
  }

  async function openHomeAppsMorePopup(kind, anchorEl) {
    const popup = document.getElementById("home-apps-more-popup");
    const titleEl = document.getElementById("home-apps-more-title");
    const grid = document.getElementById("home-apps-more-grid");
    if (!popup || !grid) return;

    const pinned = kind === "pinned";
    const entries = pinned ? pinnedEntries : recentEntries;
    const overflow = entries.slice(HOME_APPS_STRIP_VISIBLE);
    if (!overflow.length) {
      closeHomeAppsMorePopup();
      return;
    }

    const openSeq = ++homeAppsMoreOpenSeq;
    homeAppsMoreOpenKind = kind;
    // Ignore les fermetures « extérieur » pendant l’ouverture + chargement des tuiles.
    homeAppsMoreIgnoreCloseUntil = Date.now() + 800;
    const titleKey = pinned ? "homeDashboard.morePinnedApps" : "homeDashboard.moreRecentApps";
    const titleFallback = pinned ? "Autres épinglées" : "Autres récentes";
    if (titleEl) titleEl.textContent = tHome(titleKey, titleFallback);
    grid.innerHTML = `<p class="home-apps-more-loading">${escapeAttr(tHome("homeDashboard.wifiReconnectLoading", "Chargement…"))}</p>`;
    popup.dataset.appsGroup = kind;
    popup.classList.remove("hidden");
    popup.removeAttribute("hidden");
    document.querySelectorAll(".home-apps-more-btn").forEach((btn) => {
      btn.setAttribute("aria-expanded", btn.dataset.appsMore === kind ? "true" : "false");
    });
    positionHomeAppsMorePopup(getHomeAppsMoreAnchor(kind) || anchorEl);

    const tiles = await Promise.all(
      overflow.map((entry, index) => buildHomeAppTileHtml(entry, HOME_APPS_STRIP_VISIBLE + index, {
        pinned,
        indexAttr: pinned ? "data-pinned-index" : "data-recent-index"
      }))
    );
    // Une autre ouverture / fermeture a pris le relais.
    if (openSeq !== homeAppsMoreOpenSeq || homeAppsMoreOpenKind !== kind) return;
    if (popup.dataset.appsGroup !== kind || popup.classList.contains("hidden")) return;

    grid.innerHTML = tiles.join("");
    bindHomeAppTileInteractions(grid, entries, {
      pinned,
      indexAttr: pinned ? "data-pinned-index" : "data-recent-index"
    });
    grid.querySelectorAll(".home-app-tile").forEach((tile) => {
      tile.addEventListener("click", () => closeHomeAppsMorePopup(), { once: true });
    });
    positionHomeAppsMorePopup(getHomeAppsMoreAnchor(kind) || anchorEl);
    homeAppsMoreIgnoreCloseUntil = Date.now() + 150;
  }

  function bindHomeAppsMoreButton(btn) {
    if (!btn || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("pointerdown", (event) => {
      // Empêche le listener document (fermeture) de voir ce geste comme un clic extérieur.
      event.stopPropagation();
    });
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const kind = btn.dataset.appsMore === "pinned" ? "pinned" : "recent";
      const isOpen = homeAppsMoreOpenKind === kind;
      if (isOpen) {
        closeHomeAppsMorePopup();
        return;
      }
      void openHomeAppsMorePopup(kind, btn);
    });
  }

  async function applyInstanceCustomNamesToHomeEntries(entries) {
    if (!Array.isArray(entries) || !entries.length || !window.namesAPI?.resolveInstanceAppNames) {
      return false;
    }
    try {
      const response = await window.namesAPI.resolveInstanceAppNames(
        entries.map((entry) => ({
          deviceId: entry.deviceId,
          packageName: entry.packageName,
          userId: entry.userId ?? 0,
          appName: entry.appName || entry.packageName
        }))
      );
      const names = response?.names && typeof response.names === "object" ? response.names : null;
      if (!names) return false;

      let changed = false;
      entries.forEach((entry) => {
        const key = buildHomeAppKey(entry);
        const nextName = names[key];
        if (nextName && nextName !== entry.appName) {
          entry.appName = nextName;
          changed = true;
        }
      });
      return changed;
    } catch (_err) {
      return false;
    }
  }

  async function syncHomeApps() {
    const strip = document.getElementById("home-apps-strip");
    const appsSection = document.querySelector(".home-apps-section");
    if (!strip) return;

    try {
      loadPinnedApps();
      const pinnedKeys = new Set(pinnedEntries.map((entry) => entry.key));

      if (window.launchHistoryAPI?.list) {
        const response = await window.launchHistoryAPI.list();
        const entries = Array.isArray(response?.entries) ? response.entries : [];
        recentEntries = entries
          .filter((entry) => !pinnedKeys.has(buildHomeAppKey(entry)))
          .slice(0, HOME_RECENT_APPS_MAX);
      } else {
        recentEntries = [];
      }

      // Noms custom des apps clonées (sessions Type-B) → tuiles Accueil.
      const pinnedNamesChanged = await applyInstanceCustomNamesToHomeEntries(pinnedEntries);
      if (pinnedNamesChanged) savePinnedApps();
      await applyInstanceCustomNamesToHomeEntries(recentEntries);

      const pinnedVisible = pinnedEntries.slice(0, HOME_APPS_STRIP_VISIBLE);
      const recentVisible = recentEntries.slice(0, HOME_APPS_STRIP_VISIBLE);
      const pinnedHasMore = pinnedEntries.length > HOME_APPS_STRIP_VISIBLE;
      const recentHasMore = recentEntries.length > HOME_APPS_STRIP_VISIBLE;

      const pinnedTiles = await Promise.all(
        pinnedVisible.map((entry, index) => buildHomeAppTileHtml(entry, index, {
          pinned: true,
          indexAttr: "data-pinned-index"
        }))
      );
      const recentTiles = await Promise.all(
        recentVisible.map((entry, index) => buildHomeAppTileHtml(entry, index, {
          pinned: false,
          indexAttr: "data-recent-index"
        }))
      );

      const morePinnedLabel = tHome("homeDashboard.showMorePinned", "Plus d’épinglées");
      const moreRecentLabel = tHome("homeDashboard.showMoreRecent", "Plus de récentes");
      const moreBtnHtml = (kind, label) => (
        `<button type="button" class="home-apps-more-btn" data-apps-more="${kind}" aria-haspopup="dialog" aria-expanded="false" aria-controls="home-apps-more-popup" aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}">` +
        `<span aria-hidden="true">+</span>` +
        `</button>`
      );

      const hasSep = pinnedTiles.length > 0 && recentTiles.length > 0;
      appsSection?.classList.toggle("has-apps-sep", hasSep);

      const parts = [];
      if (pinnedTiles.length) {
        parts.push(
          `<div class="home-apps-strip-group" data-apps-group="pinned">` +
          pinnedTiles.join("") +
          (pinnedHasMore ? moreBtnHtml("pinned", morePinnedLabel) : "") +
          `</div>`
        );
      }
      if (hasSep) {
        parts.push(`<span class="home-apps-strip-sep" aria-hidden="true"></span>`);
      }
      if (recentTiles.length) {
        parts.push(
          `<div class="home-apps-strip-group" data-apps-group="recent">` +
          recentTiles.join("") +
          (recentHasMore ? moreBtnHtml("recent", moreRecentLabel) : "") +
          `</div>`
        );
      }

      strip.innerHTML = parts.join("");
      // Ne pas fermer si ouvert : devices-refreshed / métadonnées rebuildent la strip.
      preserveHomeAppsMoreAfterStripSync();

      const pinnedGroup = strip.querySelector('[data-apps-group="pinned"]');
      const recentGroup = strip.querySelector('[data-apps-group="recent"]');
      if (pinnedGroup) {
        bindHomeAppTileInteractions(pinnedGroup, pinnedEntries, {
          pinned: true,
          indexAttr: "data-pinned-index"
        });
      }
      if (recentGroup) {
        bindHomeAppTileInteractions(recentGroup, recentEntries, {
          pinned: false,
          indexAttr: "data-recent-index"
        });
      }
      strip.querySelectorAll(".home-apps-more-btn").forEach(bindHomeAppsMoreButton);
    } catch (_err) {
      appsSection?.classList.remove("has-apps-sep");
      if (!homeAppsMoreOpenKind) closeHomeAppsMorePopup();
    }
    scheduleHomeModulesSeparation();
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
      const onHome = isHomeVisible();
      if (!onHome) {
        cancelHomeModulesSeparation();
        clearHomeModuleTitleCenters();
        stopHomePreviewPolling();
      } else {
        // Recharger les positions sauvegardées — décolle seulement si collision
        restoreHomeModulesFromStorage();
        clearHomeModuleTitleCenters();
        void syncHomeSessions();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!canMutateHomeModuleLayout()) return;
            HOME_MODULE_IDS.forEach(rememberHomeModuleTitleCenter);
            scheduleHomeModulesSeparation();
          });
        });
      }
      syncHomeFabsVisibility();
      void syncDockBatteries();
    });
    observer.observe(content, { attributes: true, attributeFilter: ["class"] });

    const tabs = document.getElementById("tabs-bar-track") || document.getElementById("tabs-bar");
    if (tabs) {
      const tabsObserver = new MutationObserver(() => {
        void syncDockBatteries();
        if (document.body.classList.contains("theme-tablet") && isHomeVisible()) {
          void syncHomeSessions();
        }
      });
      tabsObserver.observe(tabs, { childList: true, subtree: true });
    }
  }

  window.syncDockBatteries = syncDockBatteries;
  window.syncHomeSessions = syncHomeSessions;
  window.layoutHomeDevicesSplit = layoutHomeDevicesSplit;
  window.layoutHomeSessionsSplit = layoutHomeSessionsSplit;
  window.syncRecentApps = syncHomeApps;
  window.syncHomeApps = syncHomeApps;
  window.pinHomeApp = pinHomeApp;
  window.unpinHomeApp = unpinHomeApp;
  window.isHomeAppPinned = isHomeAppPinned;
  window.getHomePinnedApps = getHomePinnedApps;
  window.stopHomePreviewPolling = stopHomePreviewPolling;
  window.getHomeShortcutFabPrefs = getHomeShortcutFabPrefs;
  window.setHomeShortcutFabEnabled = setHomeShortcutFabEnabled;
  window.applyHomeShortcutFabs = () => {
    loadHomeShortcutFabPrefs();
    if (!homeFabsState) loadHomeFabsState();
    applyHomeShortcutFabAvailability();
    applyHomeFabsLayout();
    syncHomeFabsVisibility();
    return getHomeShortcutFabPrefs();
  };
  window.__hubModalMainActions = {
    ...(window.__hubModalMainActions || {}),
    getHomeShortcutFabPrefs,
    setHomeShortcutFabEnabled,
    applyHomeShortcutFabs: window.applyHomeShortcutFabs,
    getHomePinnedApps,
    getHomePinnedAppKeys,
    isHomeAppPinned,
    pinHomeApp,
    unpinHomeApp
  };
  window.launchHistoryAPI?.onUpdated?.(syncHomeApps);
  window.namesAPI?.onUpdated?.(() => {
    void syncHomeApps();
  });
  window.electronAPI?.onAppMetadataUpdated?.(() => {
    void syncHomeApps();
  });
  window.addEventListener("devices-refreshed", () => {
    if (!window.HubPerformance || window.HubPerformance.isEnabled("dockBatteryLive")) {
      void syncDockBatteries();
    }
    syncEmptyStateIntro();
    void syncHomeApps();
  });

  window.addEventListener("home-app-pin", (event) => {
    pinHomeApp(event.detail || {});
  });
  window.addEventListener("home-app-unpin", (event) => {
    unpinHomeApp(event.detail || {});
  });

  window.addEventListener("fps-updated", (event) => {
    if (window.HubPerformance && !window.HubPerformance.isEnabled("fpsMonitor")) return;
    updateHomeSessionFps(event.detail || {});
  });

  async function refreshHomeAppDevicePills() {
    const tiles = document.querySelectorAll("#home-apps-strip .home-app-tile[data-device-id]");
    if (!tiles.length) return;

    const ids = [...new Set(Array.from(tiles).map((tile) => tile.dataset.deviceId).filter(Boolean))];
    const colorById = {};
    await Promise.all(ids.map(async (deviceId) => {
      colorById[deviceId] = await resolveHistoryDeviceColor(deviceId);
    }));

    tiles.forEach((tile) => {
      const color = colorById[tile.dataset.deviceId] || "";
      const pill = tile.querySelector(".home-app-device-pill");
      const tipPill = tile.querySelector(".app-launch-tip-pill");
      if (color) {
        if (pill) pill.style.background = color;
        else {
          const icon = tile.querySelector(".home-app-tile-icon");
          if (icon) {
            icon.insertAdjacentHTML(
              "beforeend",
              `<span class="home-app-device-pill device-color-pill" style="background:${escapeAttr(color)}" aria-hidden="true"></span>`
            );
          }
        }
        if (tipPill) tipPill.style.background = color;
      }
    });
  }

  if (window.deviceColorsAPI?.onUpdated) {
    window.deviceColorsAPI.onUpdated(() => {
      void syncDockBatteries();
      void refreshHomeAppDevicePills();
      window.setTimeout(() => {
        void syncHomeApps();
        homeSessionsKey = "";
        void syncHomeSessions();
      }, 0);
    });
  }

  window.HubI18n?.onChange?.(() => {
    void syncDockBatteries();
    void syncHomeApps();
    void syncHomeSessions();
  });

  if (window.audioAPI?.onGlobalStateChanged) {
    window.audioAPI.onGlobalStateChanged(() => {
      void syncDockBatteries();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    syncHomeApps();
    observeSessionView();
    bindHomeActions();
    bindHomeModules();
    bindHomeFabs();
    bindWifiReconnectUi();
    void syncDockBatteries();
    syncEmptyStateIntro();
    syncHomeFabsVisibility();
  });

  const originalGoHome = window.goToLaunchHome;
  if (typeof originalGoHome === "function" && !originalGoHome.__homeSessionsWrapped) {
    const wrapped = async (...args) => {
      const result = await originalGoHome(...args);
      clearHomeModuleTitleCenters();
      restoreHomeModulesFromStorage();
      syncEmptyStateIntro();
      void syncHomeSessions();
      syncHomeFabsVisibility();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!canMutateHomeModuleLayout()) return;
          HOME_MODULE_IDS.forEach(rememberHomeModuleTitleCenter);
        });
      });
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
        clearHomeModuleTitleCenters();
        restoreHomeModulesFromStorage();
        syncEmptyStateIntro();
        void syncHomeSessions();
        syncHomeFabsVisibility();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!canMutateHomeModuleLayout()) return;
            HOME_MODULE_IDS.forEach(rememberHomeModuleTitleCenter);
          });
        });
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
    if (event.target.closest?.(".home-module-menu, .home-module-menu-btn")) return;
    closeAllHomeModuleMenus();
  });

  document.addEventListener("pointerdown", (event) => {
    const popup = document.getElementById("home-wifi-reconnect-popup");
    if (!popup || popup.classList.contains("hidden") || popup.hasAttribute("hidden")) return;
    const btn = document.getElementById("home-wifi-reconnect-btn");
    const bar = document.getElementById("home-fab-bar");
    if (popup.contains(event.target) || btn?.contains(event.target) || bar?.contains(event.target)) return;
    hideWifiReconnectPopup();
  });

  document.addEventListener("pointerdown", (event) => {
    if (Date.now() < homeAppsMoreIgnoreCloseUntil) return;
    const popup = document.getElementById("home-apps-more-popup");
    if (!popup || popup.classList.contains("hidden") || popup.hasAttribute("hidden")) return;
    if (popup.contains(event.target)) return;
    if (event.target.closest?.(".home-apps-more-btn")) return;
    closeHomeAppsMorePopup();
  });

  document.getElementById("home-apps-more-close")?.addEventListener("click", () => {
    closeHomeAppsMorePopup();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dockMoreOpen) {
      setDockMoreOpen(false);
    }
    if (event.key === "Escape") {
      hideWifiReconnectPopup();
      closeHomeAppsMorePopup();
      closeAllHomeModuleMenus();
    }
  });
})();
