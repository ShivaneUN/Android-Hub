/**
 * Tests purs — options handoff Type B USB↔WiFi (pas de device requis).
 * Run: node scripts/test-typeb-handoff-options.js
 */
const assert = require("assert");
const {
    resolveCaptureOrientationLock,
    applyTypeBLaunchOrientation,
    DEFAULT_STREAM_PARAMS,
    toScrcpyOptions,
    parseNewDisplay,
    formatNewDisplay
} = require("../src/shared/stream-params");
const { buildTypeBHandoffScrcpyOptions } = require("../src/shared/typeb-handoff-options");

/** Miroir de la logique critique scrcpy-socket (lock explicite y compris null). */
function resolveServerCaptureLock(options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, "captureOrientationLock")) {
        return options.captureOrientationLock || null;
    }
    return resolveCaptureOrientationLock(
        options.orientation === "portrait" ? "portrait" : "landscape",
        options.deviceWidth,
        options.deviceHeight
    );
}

function buildServerArgsPreview(options) {
    const args = [];
    if (options.newDisplay) args.push(`new_display=${options.newDisplay}`);
    if (options.displayId !== undefined && options.displayId !== null) {
        args.push(`display_id=${options.displayId}`);
    }
    if (options.vdDestroyContent === false) args.push("vd_destroy_content=false");
    const lock = resolveServerCaptureLock(options);
    if (lock) args.push(`capture_orientation=${lock}`);
    return args;
}

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  OK  ${name}`);
    } catch (err) {
        console.error(`  FAIL ${name}`);
        console.error(`       ${err.message}`);
        process.exitCode = 1;
    }
}

console.log("\n[test-typeb-handoff-options]\n");

test("sans dims, landscape ⇒ @270 (bug historique Type A / resolve seul)", () => {
    const lock = resolveCaptureOrientationLock("landscape", undefined, undefined);
    assert.strictEqual(lock, "@270");
});

test("Type B launch téléphone portrait ⇒ lock null (pas @270)", () => {
    const opts = {};
    applyTypeBLaunchOrientation(opts, 1600, 2560);
    assert.strictEqual(opts.captureOrientationLock, null);
    assert.strictEqual(opts.captureRotation, 0);
    assert.strictEqual(resolveServerCaptureLock(opts), null);
});

test("tablette paysage + Type B launch ⇒ null", () => {
    const opts = {};
    applyTypeBLaunchOrientation(opts, 2560, 1600);
    assert.strictEqual(opts.captureOrientationLock, null);
    assert.strictEqual(resolveServerCaptureLock(opts), null);
});

test("captureOrientationLock null explicite ⇒ pas de capture_orientation dans argv", () => {
    const args = buildServerArgsPreview({
        newDisplay: "1920x1080/240",
        captureOrientationLock: null,
        orientation: "landscape"
    });
    assert.ok(args.includes("new_display=1920x1080/240"));
    assert.ok(!args.some((a) => a.startsWith("capture_orientation=")));
});

test("sans clé captureOrientationLock + landscape ⇒ @270 dans argv (régression socket)", () => {
    const args = buildServerArgsPreview({
        newDisplay: "1920x1080/240",
        orientation: "landscape"
    });
    assert.ok(args.includes("capture_orientation=@270"));
});

test("handoff sans displayId ⇒ new_display + lock null", () => {
    const session = {
        preferredNewDisplay: "1920x1080/240",
        streamOptions: {
            newDisplay: "1920x1080/240",
            orientation: "landscape",
            maxSize: 1920
        },
        streamSize: { width: 1080, height: 1920 }
    };
    const opts = buildTypeBHandoffScrcpyOptions(session);
    assert.strictEqual(opts.newDisplay, "1920x1080/240");
    assert.strictEqual(opts.captureOrientationLock, null);
    assert.strictEqual(opts.vdDestroyContent, false);
    assert.strictEqual(opts.displayId, undefined);
    const args = buildServerArgsPreview(opts);
    assert.ok(!args.some((a) => a.startsWith("capture_orientation=")));
});

test("handoff avec displayId live ⇒ rattache display_id (pas de new_display)", () => {
    const session = {
        displayId: 374,
        presetDisplayId: 374,
        preferredNewDisplay: "1920x1080/240",
        streamOptions: { newDisplay: "1920x1080/240" }
    };
    const opts = buildTypeBHandoffScrcpyOptions(session);
    assert.strictEqual(opts.displayId, 374);
    assert.strictEqual(opts.newDisplay, undefined);
    assert.strictEqual(opts.captureOrientationLock, null);
    const args = buildServerArgsPreview(opts);
    assert.ok(args.includes("display_id=374"));
    assert.ok(!args.some((a) => a.startsWith("new_display=")));
});

test("handoff forceNewDisplay ignore displayId live", () => {
    const session = {
        displayId: 374,
        preferredNewDisplay: "1920x1080/240",
        streamOptions: { newDisplay: "1920x1080/240" }
    };
    const opts = buildTypeBHandoffScrcpyOptions(session, { forceNewDisplay: true });
    assert.strictEqual(opts.newDisplay, "1920x1080/240");
    assert.strictEqual(opts.displayId, undefined);
});

test("handoff ne doit pas adopter un streamSize portrait pour un display paysage", () => {
    const session = {
        streamOptions: { newDisplay: "1920x1080/240" },
        streamSize: { width: 1080, height: 1920 }
    };
    const opts = buildTypeBHandoffScrcpyOptions(session);
    const parsed = parseNewDisplay(opts.newDisplay);
    assert.ok(parsed.width >= parsed.height, "display handoff doit rester paysage");
});

test("formatNewDisplay défaut Type B est paysage", () => {
    const nd = toScrcpyOptions(DEFAULT_STREAM_PARAMS, "B").newDisplay;
    const parsed = parseNewDisplay(nd);
    assert.ok(parsed.width >= parsed.height);
    assert.strictEqual(nd, formatNewDisplay(DEFAULT_STREAM_PARAMS));
});

if (process.exitCode) {
    console.log(`\nÉchec — ${passed} tests OK avant erreur.\n`);
} else {
    console.log(`\nTous les tests OK (${passed}).\n`);
}
