/* Developer Diagnostics proof-of-concept application for the Mazda GUI. */
log.addSrcFile("developerdiagnosticsApp.js", "developerdiagnostics");

function developerdiagnosticsApp(uiaId)
{
    baseApp.init(this, uiaId);
}

developerdiagnosticsApp.prototype.appInit = function ()
{
    this._overlayStatus = null;
    this._emulatorHealth = null;
    this._requestErrors = [];
    this._dataList = this._buildDataList();
    this._contextTable = {
        "DeveloperDiagnostics": {
            "leftBtnStyle": "goBack",
            "sbName": "Developer Diagnostics",
            "template": "List2Tmplt",
            "controlProperties": {
                "List2Ctrl": {
                    "dataList": this._dataList,
                    "titleConfiguration": "noTitle",
                    "numberedList": false,
                    "selectCallback": this._selectCallback.bind(this)
                }
            },
            "readyFunction": this._ready.bind(this)
        }
    };
    this._messageTable = {};
};

developerdiagnosticsApp.prototype._short = function (value, limit)
{
    var text = value === null || typeof value === "undefined" ? "-" : String(value);
    if (text.length > limit) {
        return text.slice(0, limit - 3) + "...";
    }
    return text;
};

developerdiagnosticsApp.prototype._statusRow = function (name, value)
{
    return {
        appData: "none",
        text1: name,
        label1: this._short(value, 42),
        labelWidth: "wide2",
        itemStyle: "style06",
        disabled: false,
        hasCaret: false
    };
};

developerdiagnosticsApp.prototype._headingRow = function (text)
{
    return {
        appData: "none",
        text1: text,
        itemStyle: "style03",
        disabled: false,
        hasCaret: false
    };
};

developerdiagnosticsApp.prototype._formatValue = function (value)
{
    if (value === null) {
        return "null";
    }
    if (typeof value === "undefined") {
        return "undefined";
    }
    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch (error) {
            return "[unserializable value]";
        }
    }
    return String(value);
};

developerdiagnosticsApp.prototype._findSteeringAngle = function (value, path, depth)
{
    if (depth > 8 || value === null || typeof value !== "object") {
        return null;
    }
    for (var key in value) {
        if (!value.hasOwnProperty(key)) {
            continue;
        }
        var nextPath = path ? path + "." + key : key;
        if (/(steer.*angle|angle.*steer|sasangle)/i.test(nextPath)) {
            return { path: nextPath, value: value[key] };
        }
        var nested = this._findSteeringAngle(value[key], nextPath, depth + 1);
        if (nested) {
            return nested;
        }
    }
    return null;
};

developerdiagnosticsApp.prototype._appendVehicleInputRows = function (items)
{
    var inputs = window.__developerDiagnosticsInputs || {
        shared: {}, mmui: [], appsdk: [], dbapi: [], maxPerChannel: 0
    };
    var steering = this._findSteeringAngle(inputs, "", 0);
    items.push(this._headingRow("Vehicle Inputs (observed by GUI)"));
    items.push(this._statusRow(
        "Steering angle",
        steering
            ? steering.value + " (" + steering.path + ")"
            : "not exposed or observed"
    ));
    items.push(this._statusRow(
        "Input capture",
        "MMUI " + inputs.mmui.length
            + " / AppSDK " + inputs.appsdk.length
            + " / DBAPI " + inputs.dbapi.length
    ));

    var sharedNames = [];
    for (var sharedName in inputs.shared) {
        if (inputs.shared.hasOwnProperty(sharedName)) {
            sharedNames.push(sharedName);
        }
    }
    sharedNames.sort();
    if (sharedNames.length === 0) {
        items.push(this._statusRow("Shared data", "none observed"));
    }
    for (var sharedIndex = 0; sharedIndex < sharedNames.length; sharedIndex += 1) {
        var shared = inputs.shared[sharedNames[sharedIndex]];
        items.push(this._statusRow(
            "Shared: " + sharedNames[sharedIndex],
            this._formatValue(shared.value)
        ));
    }

    var rawShared = framework._sharedDataAttributes || {};
    for (var rawName in rawShared) {
        if (rawShared.hasOwnProperty(rawName) && !inputs.shared.hasOwnProperty(rawName)) {
            items.push(this._statusRow(
                "Framework shared: " + rawName,
                this._formatValue(rawShared[rawName].value)
            ));
        }
    }

    var channels = [
        { name: "MMUI", records: inputs.mmui },
        { name: "AppSDK", records: inputs.appsdk },
        { name: "DBAPI", records: inputs.dbapi }
    ];
    for (var channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
        var channel = channels[channelIndex];
        items.push(this._headingRow(
            channel.name + " input (latest of " + channel.records.length + ")"
        ));
        if (channel.records.length === 0) {
            items.push(this._statusRow(channel.name, "no messages observed"));
            continue;
        }
        var first = Math.max(0, channel.records.length - 12);
        for (var recordIndex = first; recordIndex < channel.records.length; recordIndex += 1) {
            var record = channel.records[recordIndex];
            items.push({
                appData: "none",
                text1: channel.name + ": "
                    + this._short(this._formatValue(record.data), 74),
                itemStyle: "style01",
                disabled: false,
                hasCaret: false
            });
        }
    }
    items.push(this._statusRow(
        "Full capture",
        "window.__developerDiagnosticsInputs (" + inputs.maxPerChannel + "/channel)"
    ));
};

developerdiagnosticsApp.prototype._buildDataList = function ()
{
    var overlay = this._overlayStatus || {};
    var health = this._emulatorHealth || {};
    var sockets = [
        framework._mmuiWsReady ? "MMUI" : "mmui",
        framework._appSdkWsReady ? "AppSDK" : "appsdk",
        framework._dbApiWsReady ? "DBAPI" : "dbapi"
    ].join(" / ");
    var lastMessage = framework._lastMmuiMessage || {};
    var items = [
        this._statusRow("Overlay manager", overlay.managerState || "loading"),
        this._statusRow("Active transaction", overlay.activeTransaction || "none"),
        this._statusRow("Boot attempts", overlay.bootAttempts || "0"),
        this._statusRow(
            "Mount / watchdog",
            (overlay.mountState || "-") + " / " + (overlay.watchdog || "-")
        ),
        this._statusRow("Emulator backend", health.mode || "CMU / unavailable"),
        this._statusRow("WebSockets", sockets),
        this._statusRow("Loaded UI apps", Object.keys(framework._appStack || {}).length),
        this._statusRow(
            "Last MMUI message",
            lastMessage.ctxtId || lastMessage.msgId || lastMessage.msgType || "none"
        )
    ];

    this._appendVehicleInputRows(items);

    var journal = overlay.journal || [];
    var firstLog = Math.max(0, journal.length - 5);
    for (var index = firstLog; index < journal.length; index += 1) {
        items.push({
            appData: "none",
            text1: "Log: " + this._short(journal[index], 74),
            itemStyle: "style01",
            disabled: false,
            hasCaret: false
        });
    }
    for (var errorIndex = 0; errorIndex < this._requestErrors.length; errorIndex += 1) {
        items.push(this._statusRow("Data source", this._requestErrors[errorIndex]));
    }
    items.push({
        appData: "refresh",
        text1: "Refresh diagnostics",
        itemStyle: "style01",
        disabled: false,
        hasCaret: false
    });
    items.push({
        appData: "back",
        text1: "Back to Applications",
        itemStyle: "style01",
        disabled: false,
        hasCaret: true
    });
    return {
        itemCountKnown: true,
        itemCount: items.length,
        items: items
    };
};

developerdiagnosticsApp.prototype._render = function ()
{
    this._dataList = this._buildDataList();
    if (this._currentContextTemplate && this._currentContextTemplate.list2Ctrl) {
        var list = this._currentContextTemplate.list2Ctrl;
        list.setDataList(this._dataList);
        list.updateItems(0, this._dataList.items.length - 1);
    }
};

developerdiagnosticsApp.prototype._requestJson = function (url, callback)
{
    var request = new XMLHttpRequest();
    request.open("GET", url, true);
    request.onreadystatechange = function () {
        if (request.readyState !== 4) {
            return;
        }
        if (request.status >= 200 && request.status < 300) {
            try {
                callback(null, JSON.parse(request.responseText));
            } catch (error) {
                callback("invalid JSON from " + url);
            }
        } else {
            callback(url + " unavailable");
        }
    };
    request.send(null);
};

developerdiagnosticsApp.prototype._refresh = function ()
{
    var self = this;
    this._requestErrors = [];
    this._render();
    this._requestJson("/__emu/overlay", function (error, data) {
        if (error) {
            self._requestErrors.push(error);
        } else {
            self._overlayStatus = data;
        }
        self._render();
    });
    this._requestJson("/__emu/health", function (error, data) {
        if (error) {
            self._requestErrors.push(error);
        } else {
            self._emulatorHealth = data;
        }
        self._render();
    });
};

developerdiagnosticsApp.prototype._ready = function ()
{
    this._refresh();
};

developerdiagnosticsApp.prototype._selectCallback = function (listControl, appData)
{
    if (appData === "refresh") {
        this._refresh();
    } else if (appData === "back" && window.__developerDiagnosticsNavigate) {
        window.__developerDiagnosticsNavigate("applications");
    }
};

framework.registerAppLoaded("developerdiagnostics", null, false);
