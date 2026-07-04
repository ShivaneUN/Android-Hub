/**
 * Contrôleur renderer du tooltip — délègue à une fenêtre Electron always-on-top
 * (au-dessus des BrowserView vidéo, inatteignable via z-index DOM seul).
 * @typedef {'hidden' | 'loading' | 'live' | 'unavailable'} VideoPreviewState
 */

(function initVideoPreviewTooltip() {
    const WIDTH = 300;
    const HEIGHT = 170;

    /** @type {VideoPreviewState} */
    let state = "hidden";
    /** @type {number} */
    let posX = 0;
    /** @type {number} */
    let posY = 0;

    function getApi() {
        return window.videoPreviewAPI || null;
    }

    function applyState(nextState) {
        state = nextState;
        const api = getApi();
        if (!api) return;

        if (nextState === "hidden") {
            void api.hide();
            return;
        }

        void api.setState({ state: nextState });
    }

    function setPosition(x, y) {
        posX = x;
        posY = y;
        const api = getApi();
        if (!api || state === "hidden") return;
        void api.setPosition({ x, y });
    }

    function updateFrame(dataUrl) {
        if (!dataUrl) return;
        state = "live";
        const api = getApi();
        if (!api) return;
        void api.setFrame({ dataUrl });
    }

    function showLoading() {
        state = "loading";
        const api = getApi();
        if (!api) return;
        void api.show({ state: "loading", x: posX, y: posY });
    }

    function showUnavailable() {
        applyState("unavailable");
    }

    function hide() {
        state = "hidden";
        const api = getApi();
        if (!api) return;
        void api.hide();
    }

    function getSize() {
        return { width: WIDTH, height: HEIGHT };
    }

    window.VideoPreviewTooltip = {
        showLoading,
        showUnavailable,
        updateFrame,
        setPosition,
        hide,
        getSize,
        getState() {
            return state;
        }
    };
})();
