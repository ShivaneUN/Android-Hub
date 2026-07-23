(function () {
  let recentEntries = [];

  function escapeAttr(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
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
    const connected = hasConnectedDevice();
    if (intro) intro.hidden = connected;
    if (appsSection) appsSection.hidden = !connected;
    if (devicesSection) devicesSection.hidden = !connected;
  }

  async function syncDockBatteries() {
    const strip = document.getElementById("dock-battery-strip");
    if (!strip) return;

    if (!document.body.classList.contains("theme-tablet") || !hasActiveStream()) {
      strip.innerHTML = "";
      strip.hidden = true;
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
      return;
    }

    if (window.__deviceAudioUi?.refreshState) {
      await window.__deviceAudioUi.refreshState();
    }

    const audioUi = window.__deviceAudioUi;
    strip.hidden = false;
    strip.innerHTML = devices.map((device) => {
      const name = device.name || device.serial || "Device";
      const level = formatBattery(device.battery);
      const tone = batteryTone(device.battery);
      const key = device.deviceId || device.serial || "";
      const color = device.deviceColor?.hex || "";
      const colorStyle = color ? ` style="--device-chip-color:${escapeAttr(color)}"` : "";
      const audioOn = audioUi?.isOn?.(device) !== false;
      const audioIcon = audioOn ? (audioUi?.iconOn || "") : (audioUi?.iconOff || "");
      const audioLabel = globalThis.HubI18n?.t?.("sidebar.devicePanel.audioToggle") || "Audio";
      return (
        `<div class="dock-device-chip${color ? " has-device-color" : ""}" data-device-id="${escapeAttr(device.deviceId || "")}" data-serial="${escapeAttr(device.serial || "")}"${colorStyle}>` +
        `<span class="dock-battery-item dock-battery-${tone}" data-dock-tip="${escapeAttr(name)}">` +
        batteryIconSvg(device.battery, tone) +
        `<span class="dock-battery-pct">${level}</span>` +
        `</span>` +
        `<button type="button" class="sidebar-device-audio-btn dock-device-audio-btn ${audioOn ? "audio-on" : "audio-off"}" data-device-key="${escapeAttr(key)}" data-dock-tip="${escapeAttr(audioLabel)}" aria-label="${escapeAttr(audioLabel)}">` +
        audioIcon +
        `</button>` +
        `</div>`
      );
    }).join("");

    strip.querySelectorAll(".dock-device-audio-btn").forEach((btn) => {
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

    strip.querySelectorAll(".dock-device-chip").forEach((chip) => {
      chip.addEventListener("contextmenu", (event) => {
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
    });
    observer.observe(content, { attributes: true, attributeFilter: ["class"] });

    const tabs = document.getElementById("tabs-bar-track") || document.getElementById("tabs-bar");
    if (tabs) {
      const tabsObserver = new MutationObserver(() => {
        void syncDockBatteries();
      });
      tabsObserver.observe(tabs, { childList: true, subtree: true });
    }
  }

  window.syncDockBatteries = syncDockBatteries;
  window.launchHistoryAPI?.onUpdated?.(syncRecentApps);
  window.electronAPI?.onAppMetadataUpdated?.(() => {
    void syncRecentApps();
  });
  window.addEventListener("devices-refreshed", () => {
    void syncDockBatteries();
    syncEmptyStateIntro();
  });

  if (window.deviceColorsAPI?.onUpdated) {
    window.deviceColorsAPI.onUpdated(() => {
      void syncDockBatteries();
    });
  }

  window.HubI18n?.onChange?.(() => {
    void syncDockBatteries();
    void syncRecentApps();
  });

  if (window.audioAPI?.onGlobalStateChanged) {
    window.audioAPI.onGlobalStateChanged(() => {
      void syncDockBatteries();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    syncRecentApps();
    observeSessionView();
    void syncDockBatteries();
    syncEmptyStateIntro();
  });
})();
