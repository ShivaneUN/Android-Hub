const openTabs = {};
let activeTabId = null;

function setWindowTitle(label) {
    const appName = "ScrcpyManager";
    const normalizedLabel = String(label || "").trim();
    const finalTitle = normalizedLabel || appName;

    document.title = finalTitle;

    const titlebarTitle = document.querySelector(".titlebar-title");
    if (titlebarTitle) {
        titlebarTitle.textContent = finalTitle;
    }
}

function createTab(tabId, label) {
    const tabsBar = document.getElementById("tabs-bar");
    if (!tabsBar) return;

    const tab = document.createElement("div");
    tab.className = "scrcpy-tab active";
    tab.dataset.tabId = tabId;
    tab.innerHTML = `
        <span class="tab-icon"></span>
        <span class="tab-label">${label}</span>
        <span class="tab-close">&#10005;</span>
    `;

    tab.addEventListener("click", (e) => {
    if (e.target.classList.contains("tab-close")) return;
    activateInstance(tabId);
});

    tab.querySelector(".tab-close").addEventListener("click", async (e) => {
    e.stopPropagation();
    await closeInstance(tabId);
});

    document.querySelectorAll(".scrcpy-tab").forEach(t => t.classList.remove("active"));
    tabsBar.appendChild(tab);
    openTabs[tabId] = { label, element: tab };
    setActiveTab(tabId);
}

function setActiveTab(tabId) {
    Object.values(openTabs).forEach(t => t.element.classList.remove("active"));
    if (openTabs[tabId]) {
        openTabs[tabId].element.classList.add("active");
        activeTabId = tabId;
        setWindowTitle(openTabs[tabId].label);
    }
}

function removeTab(tabId) {
    if (openTabs[tabId]) {
        openTabs[tabId].element.remove();
        delete openTabs[tabId];
    }
    if (activeTabId === tabId) {
        activeTabId = null;
        setWindowTitle("");
    }
}

function createExternalProcessTab(tabId, label) {
    const tabsBar = document.getElementById("tabs-bar");
    if (!tabsBar) return;

    if (openTabs[tabId]) {
        setActiveTab(tabId);
        return;
    }

    const tab = document.createElement("div");
    tab.className = "scrcpy-tab active";
    tab.dataset.tabId = tabId;
    tab.innerHTML = `
        <span class="tab-icon"></span>
        <span class="tab-label">${label}</span>
        <span class="tab-close">&#10005;</span>
    `;

    tab.addEventListener("click", (e) => {
        if (e.target.classList.contains("tab-close")) return;
        setActiveTab(tabId);
    });

    tab.querySelector(".tab-close").addEventListener("click", (e) => {
        e.stopPropagation();
        removeTab(tabId);
    });

    document.querySelectorAll(".scrcpy-tab").forEach(t => t.classList.remove("active"));
    tabsBar.appendChild(tab);
    openTabs[tabId] = { label, element: tab, external: true };
    setActiveTab(tabId);
}

window.createExternalProcessTab = createExternalProcessTab;
setWindowTitle("");