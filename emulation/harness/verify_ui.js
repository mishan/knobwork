"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const TARGET_URL = process.env.EMU_URL || "http://127.0.0.1:8080/";
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const SCREENSHOT = process.env.EMU_SCREENSHOT || "";
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
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(error);
                }
            });
        }).on("error", reject);
    });
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
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--remote-debugging-port=0",
        "--user-data-dir=" + profileDirectory,
        TARGET_URL
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
        const page = targets.find((target) => target.type === "page" && target.url === TARGET_URL);
        if (page) return page;
        await delay(100);
    }
    throw new Error("Chrome did not create a page for " + TARGET_URL);
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

async function main() {
    const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mazda-ui-verify-"));
    let chrome;
    let client;

    try {
        await getJson(new URL("/__emu/health", TARGET_URL));
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
        await client.send("Page.reload", { ignoreCache: true });
        await loaded;
        await waitForExpression(
            client,
            'document.querySelector(".MainMenuCtrlIconName") && document.querySelector(".MainMenuCtrlIconName").innerText === "Communication"',
            "the stock HomeScreen"
        );

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
        await pressKey(client, "Backspace", "Backspace", 8);
        await waitForExpression(
            client,
            'framework.getCurrCtxtId() === "HomeScreen"',
            "return to HomeScreen"
        );
        await delay(1200);

        const finalState = await evaluate(client, "({" +
            "frameworkState:framework._frameworkState," +
            "currentApp:framework._currentAppUiaId," +
            "currentContext:framework.getCurrCtxtId()," +
            "label:document.querySelector('.MainMenuCtrlIconName').innerText," +
            "queueLength:framework._msgQueue.length})");
        const capture = await client.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false
        });
        const screenshot = Buffer.from(capture.data, "base64");
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
            finalState
        }, null, 2));
    } finally {
        if (client) client.close();
        if (chrome && chrome.exitCode === null) chrome.kill("SIGTERM");
        fs.rmSync(profileDirectory, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error("[VERIFY-UI] FAIL: " + error.message);
    process.exit(1);
});
