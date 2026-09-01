"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

function resolveChromePath() {
    if (process.env.CHROME) return process.env.CHROME;
    const candidates = [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser"
    ];
    for (const bin of candidates) {
        if (fs.existsSync(bin)) return bin;
    }
    const pwCache = path.join(os.homedir(), ".cache/ms-playwright");
    if (fs.existsSync(pwCache)) {
        let found = null;
        function walkShell(dir) {
            if (found) return;
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) walkShell(full);
                else if (ent.isFile() && ent.name.includes("headless-shell")) {
                    found = full;
                    return;
                }
            }
        }
        walkShell(pwCache);
        if (found) return found;

        function walkChrome(dir) {
            if (found) return;
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) walkChrome(full);
                else if (ent.isFile() && (ent.name === "chrome" || ent.name === "chromium")) {
                    found = full;
                    return;
                }
            }
        }
        walkChrome(pwCache);
        if (found) return found;
    }
    return "/usr/bin/google-chrome";
}

const TARGET_URL = process.env.EMU_URL || "http://127.0.0.1:8080/";
const CHROME = resolveChromePath();
const SCREENSHOT = process.env.EMU_SCREENSHOT || "";
const EXPECTED_MODE = process.env.EMU_EXPECT_MODE || "mock";
const EXPECT_OVERLAY_APP = process.env.EMU_EXPECT_OVERLAY_APP === "true";
const REQUIRE_QUEUED_STARTUP = process.env.EMU_REQUIRE_QUEUED_STARTUP === "true";
const WIDTH = 800;
const HEIGHT = 480;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => { body += chunk; });
            response.on("end", () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error("HTTP " + response.statusCode + " from " + url));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(error);
                }
            });
        }).on("error", reject);
    });
}

function assertHealthMode(health) {
    if (health.mode !== EXPECTED_MODE) {
        throw new Error(
            "expected harness mode " + EXPECTED_MODE + ", got " + health.mode
        );
    }
    if (EXPECTED_MODE === "proxy" && !health.proxy) {
        throw new Error("proxy health details are missing");
    }
}

function assertNativeDisplayLifecycle(health) {
    const readiness = health.proxy.mmuiReadiness;
    if (!readiness.ready || readiness.notifications < 1
            || readiness.lastNotification !== "mmui-ready"
            || !readiness.lastNotificationAt) {
        throw new Error("native MMUI readiness was not established: " + JSON.stringify(readiness));
    }
    if (REQUIRE_QUEUED_STARTUP && readiness.queuedFrontendMessages < 1) {
        throw new Error(
            "startup-race regression did not queue a frontend message before MMUI readiness"
        );
    }

    const display = health.proxy.nativeDisplay;
    const expectedCounts = {
        notifications: 1,
        startEvents: 1,
        finishEvents: 1,
        showDisclaimerEvents: 1,
        frontendDisposeEvents: 1
    };
    for (const [name, expected] of Object.entries(expectedCounts)) {
        if (display[name] !== expected) {
            throw new Error(
                "native display lifecycle " + name + " was " + display[name]
                + ", expected " + expected
            );
        }
    }
    if (display.lastError !== null
            || display.lastNotification !== "splash-complete surface=TRANLOGO_SURFACE") {
        throw new Error("native display completion was not clean: " + JSON.stringify(display));
    }

    const messages = health.proxy.backends.guiifm.controlMessages;
    const expectedSequence = [
        ["native-display-to-guest", "eventId", "StartIntroAnimation"],
        ["guest-to-frontend", "ctxtId", "IntroAnimation"],
        ["native-display-to-guest", "eventId", "FinishIntroAnimation"],
        ["native-display-to-guest", "eventId", "ShowDisclaimer"],
        ["guest-to-frontend", "ctxtId", "Disclaimer"],
        ["frontend-to-guest", "eventId", "DisposeIntroVideo"],
        ["frontend-to-guest", "eventId", "Timeout"],
        ["guest-to-frontend", "ctxtId", "HomeScreen"],
        ["frontend-to-guest", "eventId", "NotifyDisclaimerEnd"]
    ];
    let cursor = 0;
    for (const [direction, field, value] of expectedSequence) {
        const found = messages.findIndex((entry, index) => (
            index >= cursor
            && entry.direction === direction
            && entry.summary
            && entry.summary[field] === value
        ));
        if (found < 0) {
            throw new Error(
                "native lifecycle trace is missing " + direction + " " + field + "=" + value
            );
        }
        cursor = found + 1;
    }
}

function summarizeProxyHealth(health) {
    const lifecycleIds = new Set([
        "InitializeGuiComplete", "StartIntroAnimation", "FinishIntroAnimation",
        "ShowDisclaimer", "DisposeIntroVideo", "Timeout", "NotifyDisclaimerEnd"
    ]);
    const lifecycleContexts = new Set(["IntroAnimation", "Disclaimer", "HomeScreen"]);
    return {
        rootfs: health.rootfs,
        mockFallbackMessages: health.proxy.mockFallbackMessages,
        mmuiReadiness: health.proxy.mmuiReadiness,
        nativeDisplay: health.proxy.nativeDisplay,
        backends: Object.fromEntries(Object.entries(health.proxy.backends).map(
            ([name, backend]) => [name, {
                status: backend.status,
                activeConnections: backend.activeConnections,
                frontendToGuestMessages: backend.frontendToGuestMessages,
                guestToFrontendMessages: backend.guestToFrontendMessages,
                frontendToGuestBinaryMessages: backend.frontendToGuestBinaryMessages,
                guestToFrontendBinaryMessages: backend.guestToFrontendBinaryMessages,
                lastError: backend.lastError
            }]
        )),
        lifecycleTrace: health.proxy.backends.guiifm.controlMessages
            .filter((entry) => entry.summary && (
                lifecycleIds.has(entry.summary.eventId)
                || lifecycleContexts.has(entry.summary.ctxtId)
            ))
            .map((entry) => ({ direction: entry.direction, summary: entry.summary }))
    };
}

async function waitForNativeProxy() {
    const healthUrl = new URL("/__emu/health", TARGET_URL);
    const deadline = Date.now() + 45000;
    let health;
    while (Date.now() < deadline) {
        health = await getJson(healthUrl);
        assertHealthMode(health);
        if (health.nativeProxyReady) {
            const backends = Object.values(health.proxy.backends);
            if (backends.every((backend) => backend.activeConnections > 0)
                    && health.proxy.mockFallbackMessages === 0) {
                return health;
            }
        }
        await delay(100);
    }
    throw new Error(
        "native proxy did not connect all backends: " + JSON.stringify(health)
    );
}

class CdpClient {
    constructor(url) {
        this.socket = new WebSocket(url);
        this.nextId = 1;
        this.pending = new Map();
        this.events = [];
        this.waiters = [];

        this.socket.on("message", (rawMessage) => {
            const message = JSON.parse(rawMessage.toString());
            if (message.id) {
                const pending = this.pending.get(message.id);
                if (!pending) return;
                this.pending.delete(message.id);
                if (message.error) pending.reject(new Error(message.error.message));
                else pending.resolve(message.result || {});
                return;
            }

            this.events.push(message);
            const matching = this.waiters.filter((waiter) => waiter.method === message.method);
            this.waiters = this.waiters.filter((waiter) => waiter.method !== message.method);
            matching.forEach((waiter) => waiter.resolve(message.params || {}));
        });
    }

    async open() {
        if (this.socket.readyState === WebSocket.OPEN) return;
        await new Promise((resolve, reject) => {
            this.socket.once("open", resolve);
            this.socket.once("error", reject);
        });
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    waitFor(method, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
                reject(new Error("Timed out waiting for CDP event " + method));
            }, timeoutMs);
            this.waiters.push({
                method,
                resolve: (params) => {
                    clearTimeout(timeout);
                    resolve(params);
                }
            });
        });
    }

    close() {
        this.socket.close();
    }
}

function launchChrome(profileDirectory) {
    const child = spawn(CHROME, [
        "--headless=shell",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--disable-crashpad",
        "--crash-dumps-dir=/tmp",
        "--no-crash-dump",
        "--no-first-run",
        "--remote-debugging-port=0",
        "--user-data-dir=" + profileDirectory,
        "about:blank"
    ], { stdio: ["ignore", "ignore", "pipe"] });

    return new Promise((resolve, reject) => {
        let stderr = "";
        const timeout = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error("Chrome DevTools endpoint did not appear. " + stderr.slice(-1000)));
        }, 15000);

        child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
            const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (match) {
                clearTimeout(timeout);
                resolve({ child, browserWebSocketUrl: match[1] });
            }
        });
        child.once("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error("Chrome exited before verification (status " + code + "). " + stderr.slice(-1000)));
        });
    });
}

async function findPageTarget(browserWebSocketUrl) {
    const endpoint = new URL(browserWebSocketUrl);
    const listUrl = "http://" + endpoint.hostname + ":" + endpoint.port + "/json/list";
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const targets = await getJson(listUrl);
        const page = targets.find((target) => target.type === "page");
        if (page) return page;
        await delay(100);
    }
    throw new Error("Chrome did not create a page target");
}

async function evaluate(client, expression) {
    const result = await client.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
    });
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result ? result.result.value : undefined;
}

async function waitForExpression(client, expression, description, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await evaluate(client, expression)) return;
        await delay(100);
    }
    const diag = await evaluate(client, "({" +
        "currCtxt: window.framework ? framework.getCurrCtxtId() : null," +
        "currApp: window.framework ? framework.getCurrentApp() : null," +
        "initGuiCalled: window.framework ? framework.initGuiCalled : null," +
        "bodyText: document.body ? document.body.innerText.substring(0, 300) : ''" +
    "})");
    console.error("[VERIFY-UI-DIAG]", JSON.stringify(diag));
    throw new Error("Timed out waiting for " + description);
}

async function pressKey(client, key, code, virtualKeyCode, text = "") {
    await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
        text
    });
    await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode
    });
}

function pngDimensions(buffer) {
    if (buffer.toString("ascii", 1, 4) !== "PNG") {
        throw new Error("CDP screenshot was not a PNG");
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function stopChrome(chrome) {
    if (!chrome || chrome.exitCode !== null) {
        return;
    }
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGTERM");
    await Promise.race([exited, delay(2000)]);
    if (chrome.exitCode === null) {
        chrome.kill("SIGKILL");
        await Promise.race([exited, delay(2000)]);
    }
}

async function main() {
    const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mazda-ui-verify-"));
    let chrome;
    let client;

    try {
        if (!["mock", "proxy"].includes(EXPECTED_MODE)) {
            throw new Error("EMU_EXPECT_MODE must be mock or proxy");
        }
        if (EXPECT_OVERLAY_APP && EXPECTED_MODE !== "mock") {
            throw new Error("the overlay example verification requires mock mode");
        }
        const startupHealth = await getJson(new URL("/__emu/health", TARGET_URL));
        assertHealthMode(startupHealth);
        let overlayStatus = null;
        if (EXPECT_OVERLAY_APP) {
            if (!startupHealth.overlayWorkspace) {
                throw new Error("harness is not serving a validated overlay workspace");
            }
            overlayStatus = await getJson(new URL("/__emu/overlay", TARGET_URL));
            if (!overlayStatus.available || overlayStatus.managerState !== "enabled") {
                throw new Error(
                    "overlay manager is not enabled: " + JSON.stringify(overlayStatus)
                );
            }
        }
        const launched = await launchChrome(profileDirectory);
        chrome = launched.child;
        const page = await findPageTarget(launched.browserWebSocketUrl);
        client = new CdpClient(page.webSocketDebuggerUrl);
        await client.open();

        await Promise.all([
            client.send("Page.enable"),
            client.send("Runtime.enable"),
            client.send("Log.enable"),
            client.send("Network.enable"),
            client.send("Emulation.setDeviceMetricsOverride", {
                width: WIDTH,
                height: HEIGHT,
                deviceScaleFactor: 1,
                mobile: false
            })
        ]);

        const loaded = client.waitFor("Page.loadEventFired");
        await client.send("Page.navigate", { url: TARGET_URL });
        await loaded;
        let proxyHealth = EXPECTED_MODE === "proxy"
            ? await waitForNativeProxy()
            : null;
        if (EXPECTED_MODE === "proxy") {
            await waitForExpression(
                client,
                'framework.getCurrCtxtId() === "HomeScreen" && '
                    + 'document.querySelector(".MainMenuCtrlIconName") && '
                    + 'document.querySelector(".MainMenuCtrlIconName").innerText.length > 0',
                "the native MMUI HomeScreen and a visible menu icon",
                30000
            );
            proxyHealth = await getJson(new URL("/__emu/health", TARGET_URL));
        } else {
            await waitForExpression(
                client,
                'document.querySelector(".MainMenuCtrlIconName") && document.querySelector(".MainMenuCtrlIconName").innerText === "Communication"',
                "the stock HomeScreen",
                15000
            );
        }

        const initialState = await evaluate(client, "({" +
            "viewport:{width:innerWidth,height:innerHeight}," +
            "frameworkState:framework._frameworkState," +
            "currentApp:framework._currentAppUiaId," +
            "currentContext:framework.getCurrCtxtId()," +
            "queueLength:framework._msgQueue.length," +
            "sockets:{mmui:framework.websockets._mmuiWs.readyState," +
            "appsdk:framework.websockets._appWs.readyState," +
            "dbapi:framework.websockets._dbapiWs.readyState}," +
            "compatibility:window.__mazdaEmulator})");

        if (initialState.compatibility.backendMode !== EXPECTED_MODE) {
            throw new Error(
                "browser compatibility mode was "
                + initialState.compatibility.backendMode
                + ", expected " + EXPECTED_MODE
            );
        }
        if (EXPECTED_MODE === "proxy" && initialState.compatibility.syntheticBackend) {
            throw new Error("proxy verification loaded synthetic backend behavior");
        }

        if (EXPECTED_MODE === "proxy") {
            const backends = Object.values(proxyHealth.proxy.backends);
            const mmui = proxyHealth.proxy.backends.guiifm;
            if (proxyHealth.proxy.mockFallbackMessages !== 0
                    || mmui.frontendToGuestMessages < 1
                    || mmui.guestToFrontendMessages < 1
                    || backends.some((backend) => (
                        backend.frontendToGuestBinaryMessages !== 0
                        || backend.guestToFrontendBinaryMessages !== 0
                    ))) {
                throw new Error(
                    "native proxy provenance did not show bidirectional text MMUI traffic: "
                    + JSON.stringify(proxyHealth)
                );
            }
            assertNativeDisplayLifecycle(proxyHealth);

            const capture = await client.send("Page.captureScreenshot", {
                format: "png",
                captureBeyondViewport: false
            });
            const screenshot = Buffer.from(capture.data, "base64");
            const dimensions = pngDimensions(screenshot);
            if (dimensions.width !== WIDTH || dimensions.height !== HEIGHT) {
                throw new Error(
                    "unexpected screenshot size " + dimensions.width + "x" + dimensions.height
                );
            }
            if (SCREENSHOT) {
                fs.mkdirSync(path.dirname(path.resolve(SCREENSHOT)), { recursive: true });
                fs.writeFileSync(SCREENSHOT, screenshot);
            }

            const errors = client.events.filter((event) => {
                if (event.method === "Runtime.exceptionThrown") return true;
                if (event.method === "Log.entryAdded") {
                    return event.params.entry && event.params.entry.level === "error";
                }
                return event.method === "Runtime.consoleAPICalled"
                    && event.params.type === "error";
            });
            const knownNativeStartupErrors = errors.filter((event) => {
                if (event.method !== "Runtime.consoleAPICalled" || !event.params.args) {
                    return false;
                }
                return event.params.args.some((arg) => {
                    if (typeof arg.value !== "string") return false;
                    const value = arg.value;
                    return (
                        value.includes(
                            "SYS_SETTINGS app didn't set all required values before timeout"
                        )
                        && value.includes("issuing initGui with necessary default values")
                    ) || (
                        value.includes("ERROR vehsettings vehsettingsApp.js[7050]")
                        && value.includes("context/template not initialized")
                    );
                });
            });
            const unexpectedErrors = errors.filter(
                (event) => !knownNativeStartupErrors.includes(event)
            );
            if (unexpectedErrors.length) {
                throw new Error(
                    "browser reported " + unexpectedErrors.length
                    + " unexpected runtime error(s): "
                    + JSON.stringify(unexpectedErrors.slice(0, 10))
                );
            }

            console.log(JSON.stringify({
                ok: true,
                scope: "native-home-menu",
                target: TARGET_URL,
                screenshot: SCREENSHOT || null,
                screenshotDimensions: dimensions,
                initialState,
                limitation: null,
                knownNativeStartupErrors: knownNativeStartupErrors.map(
                    (event) => event.params.args.map((arg) => arg.value).filter(Boolean)
                ),
                backendProvenance: summarizeProxyHealth(proxyHealth)
            }, null, 2));
            return;
        }

        await pressKey(client, "n", "KeyN", 78, "n");
        await delay(350);
        await pressKey(client, "n", "KeyN", 78, "n");
        await waitForExpression(
            client,
            'document.querySelector(".MainMenuCtrlIconName").innerText === "Applications"',
            "commander rotation to Applications"
        );
        await pressKey(client, "Enter", "Enter", 13);
        await waitForExpression(
            client,
            'document.body.innerText.includes("Fuel Economy Monitor")',
            "the Applications screen"
        );
        await delay(1200);
        let overlayScreenshot = null;
        let overlayApplication = null;
        if (EXPECT_OVERLAY_APP) {
            await waitForExpression(
                client,
                "window.__developerDiagnosticsIntegration && "
                    + "window.__developerDiagnosticsIntegration.installed === true",
                "the Developer Diagnostics Applications entry"
            );
            overlayApplication = await evaluate(client, "(function () {" +
                "var system = framework._appInstances.system;" +
                "var list = system._buildApplicationsDataList();" +
                "var names = list.items.map(function (item) { return item.text1 || item.text1Id; });" +
                "var target = list.items.findIndex(function (item) {" +
                    "return item.appData && item.appData.appName === 'developerdiagnostics';" +
                "});" +
                "return {targetIndex:target,names:names};" +
            "}())");
            if (overlayApplication.targetIndex < 0) {
                throw new Error(
                    "Developer Diagnostics is missing from Applications: "
                    + JSON.stringify(overlayApplication.names)
                );
            }
            let focused = -1;
            for (let turn = 0; turn <= overlayApplication.names.length; turn += 1) {
                focused = await evaluate(
                    client,
                    "framework._appInstances.system._currentContextTemplate.list2Ctrl.focussedItem"
                );
                if (focused === overlayApplication.targetIndex) break;
                await pressKey(client, "m", "KeyM", 77, "m");
                await delay(150);
            }
            if (focused !== overlayApplication.targetIndex) {
                throw new Error(
                    "commander could not focus Developer Diagnostics; focused=" + focused
                );
            }
            await pressKey(client, "Enter", "Enter", 13);
            await waitForExpression(
                client,
                'framework.getCurrCtxtId() === "DeveloperDiagnostics" && '
                    + 'framework.getCurrentApp() === "developerdiagnostics" && '
                    + 'document.body.innerText.includes("Overlay manager")',
                "the Developer Diagnostics application",
                15000
            );
            await waitForExpression(
                client,
                'document.body.innerText.includes("enabled")',
                "the enabled overlay state in Developer Diagnostics"
            );
            const inputDiagnostics = await evaluate(client, "(function () {" +
                "var app = framework._appInstances.developerdiagnostics;" +
                "var labels = app._dataList.items.map(function (item) { return item.text1; });" +
                "return {" +
                    "hasVehicleInputs:labels.indexOf('Vehicle Inputs (observed by GUI)') >= 0," +
                    "hasSteeringAngle:labels.indexOf('Steering angle') >= 0," +
                    "capturedMmui:window.__developerDiagnosticsInputs.mmui.length" +
                "};" +
            "}())");
            if (!inputDiagnostics.hasVehicleInputs
                    || !inputDiagnostics.hasSteeringAngle
                    || inputDiagnostics.capturedMmui < 1) {
                throw new Error(
                    "vehicle input diagnostics are incomplete: "
                    + JSON.stringify(inputDiagnostics)
                );
            }
            overlayApplication.inputDiagnostics = inputDiagnostics;
            await delay(500);
            const overlayCapture = await client.send("Page.captureScreenshot", {
                format: "png",
                captureBeyondViewport: false
            });
            overlayScreenshot = Buffer.from(overlayCapture.data, "base64");
            await pressKey(client, "Backspace", "Backspace", 8);
            await waitForExpression(
                client,
                'framework.getCurrCtxtId() === "Applications"',
                "return from Developer Diagnostics to Applications"
            );
            await delay(1200);
        }
        await pressKey(client, "Backspace", "Backspace", 8);
        await waitForExpression(
            client,
            'framework.getCurrCtxtId() === "HomeScreen"',
            "back to HomeScreen"
        );
        await delay(1200);

        const finalState = await evaluate(client, "({" +
            "frameworkState:framework._frameworkState," +
            "currentApp:framework._currentAppUiaId," +
            "currentContext:framework.getCurrCtxtId()," +
            "label:document.querySelector('.MainMenuCtrlIconName').innerText," +
            "queueLength:framework._msgQueue.length})");
        let screenshot = overlayScreenshot;
        if (!screenshot) {
            const capture = await client.send("Page.captureScreenshot", {
                format: "png",
                captureBeyondViewport: false
            });
            screenshot = Buffer.from(capture.data, "base64");
        }
        const dimensions = pngDimensions(screenshot);
        if (dimensions.width !== WIDTH || dimensions.height !== HEIGHT) {
            throw new Error("unexpected screenshot size " + dimensions.width + "x" + dimensions.height);
        }
        if (SCREENSHOT) {
            fs.mkdirSync(path.dirname(path.resolve(SCREENSHOT)), { recursive: true });
            fs.writeFileSync(SCREENSHOT, screenshot);
        }

        const errors = client.events.filter((event) => {
            if (event.method === "Runtime.exceptionThrown") return true;
            if (event.method === "Log.entryAdded") {
                return event.params.entry && event.params.entry.level === "error";
            }
            return event.method === "Runtime.consoleAPICalled" && event.params.type === "error";
        });
        if (errors.length) {
            throw new Error(
                "browser reported " + errors.length + " runtime error(s): "
                + JSON.stringify(errors.slice(0, 10))
            );
        }

        console.log(JSON.stringify({
            ok: true,
            target: TARGET_URL,
            screenshot: SCREENSHOT || null,
            screenshotDimensions: dimensions,
            initialState,
            finalState,
            overlayApplication,
            overlayStatus,
            backendProvenance: proxyHealth
        }, null, 2));
    } finally {
        if (client) client.close();
        await stopChrome(chrome);
        fs.rmSync(profileDirectory, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100
        });
    }
}

main().catch((error) => {
    console.error("[VERIFY-UI] FAIL: " + error.message);
    process.exit(1);
});
