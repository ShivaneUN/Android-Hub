(function initDuoPopupOverlay() {
    const picksRoot = document.getElementById("stream-deck-duo-picks");
    const titleEl = document.getElementById("stream-deck-duo-popup-title");

    let labels = {
        panelTitle: "Sélection Duo",
        slot1: "Appareil 1",
        slot2: "Appareil 2",
        pick: "Choisir…",
        disconnected: "Déconnecté"
    };

    let currentSessions = [];

    function renderPicks(slots = [null, null], sessions = currentSessions) {
        if (!picksRoot) return;

        picksRoot.innerHTML = `
            <label class="stream-deck-duo-label">
                <span>${labels.slot1}</span>
                <select class="stream-deck-duo-select" data-duo-slot="0"></select>
            </label>
            <label class="stream-deck-duo-label">
                <span>${labels.slot2}</span>
                <select class="stream-deck-duo-select" data-duo-slot="1"></select>
            </label>
        `;

        picksRoot.querySelectorAll(".stream-deck-duo-select").forEach((select, index) => {
            const current = slots[index] || "";
            const excludedId = slots[index === 0 ? 1 : 0] || null;

            select.innerHTML = `<option value="">${labels.pick}</option>`;

            if (current && !sessions.some((s) => s.sessionId === current)) {
                const opt = document.createElement("option");
                opt.value = current;
                opt.textContent = `${current} (${labels.disconnected})`;
                opt.selected = true;
                select.appendChild(opt);
            }

            for (const session of sessions) {
                if (excludedId && session.sessionId === excludedId && session.sessionId !== current) {
                    continue;
                }
                const opt = document.createElement("option");
                opt.value = session.sessionId;
                opt.textContent = session.label || session.sessionId;
                if (session.sessionId === current) opt.selected = true;
                select.appendChild(opt);
            }

            select.addEventListener("change", () => {
                const values = [0, 1].map((slotIndex) => {
                    const el = picksRoot.querySelector(`[data-duo-slot="${slotIndex}"]`);
                    return el?.value || null;
                });

                if (values[0] && values[1] && values[0] === values[1]) {
                    const otherSlot = index === 0 ? 1 : 0;
                    values[otherSlot] = null;
                    const otherSelect = picksRoot.querySelector(`[data-duo-slot="${otherSlot}"]`);
                    if (otherSelect) otherSelect.value = "";
                }

                window.duoPopupOverlayAPI?.notifySlotsChange?.(values);
                renderPicks(values, sessions);
            });
        });
    }

    function applyPayload(payload = {}) {
        labels = { ...labels, ...(payload.labels || {}) };
        currentSessions = payload.sessions || [];
        if (titleEl) titleEl.textContent = labels.panelTitle || "Sélection Duo";
        renderPicks(payload.slots || [null, null], currentSessions);
    }

    window.duoPopupOverlayAPI?.onOpen?.((payload) => {
        applyPayload(payload);
    });

    window.__duoPopupOverlayReady = true;
    window.dispatchEvent(new Event("duo-popup-overlay-ready"));
})();
