/* Reversible overlay integration for the Developer Diagnostics example app. */
(function () {
    "use strict";

    var APP_ID = "developerdiagnostics";
    var APP_CONTEXT = "DeveloperDiagnostics";
    var integrationTimer = null;
    var attempts = 0;
    var contextSequence = 200;
    var inputCaptureLimit = 80;

    window.__developerDiagnosticsInputs = {
        maxPerChannel: inputCaptureLimit,
        shared: {},
        mmui: [],
        appsdk: [],
        dbapi: []
    };

    function copyInput(value) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return { captureError: String(error) };
        }
    }

    function recordInput(channel, value) {
        var inputs = window.__developerDiagnosticsInputs;
        inputs[channel].push({
            observedAt: new Date().toISOString(),
            data: copyInput(value)
        });
        if (inputs[channel].length > inputCaptureLimit) {
            inputs[channel].shift();
        }
    }

    function routeContext(uiaId, contextId) {
        if (!window.framework) {
            return;
        }
        contextSequence = (contextSequence % 250) + 1;
        var route = typeof framework.routeMmuiMsg === "function"
            ? framework.routeMmuiMsg.bind(framework)
            : framework._doRouteMmuiMsg.bind(framework);
        route({
            msgType: "ctxtChg",
            ctxtId: contextId,
            uiaId: uiaId,
            params: {},
            contextSeq: contextSequence
        });
        route({
            msgType: "focusStack",
            appIdList: [{ id: uiaId }]
        });
        route({ msgType: "transition", enabled: false });
    }

    window.__developerDiagnosticsNavigate = function (destination) {
        if (destination === "applications") {
            routeContext("system", "Applications");
        } else {
            routeContext(APP_ID, APP_CONTEXT);
        }
    };

    function installAppLoader() {
        if (!window.GuiFramework || !GuiFramework.prototype) {
            return false;
        }
        if (GuiFramework.prototype.__developerDiagnosticsLoaderInstalled) {
            return true;
        }

        var originalAddAppFiles = GuiFramework.prototype._addAppFiles;
        GuiFramework.prototype._addAppFiles = function (uiaId, mmuiMessage) {
            if (uiaId !== APP_ID) {
                return originalAddAppFiles.apply(this, arguments);
            }

            var appName = APP_ID + "App";
            this._frameworkState = this._FWK_STATE_LOADING_APP;
            this._lastAppLoaded = APP_ID;
            this._loadingAppJsObj = mmuiMessage;
            this._filesToLoad = {};
            this._filesToLoad[appName] = false;
            utility.loadCss("apps/system/css/developerdiagnosticsApp.css");
            utility.loadScript("apps/system/js/developerdiagnosticsApp.js");
        };
        GuiFramework.prototype.__developerDiagnosticsLoaderInstalled = true;
        return true;
    }

    function installBackNavigation() {
        if (!window.GuiFramework || !GuiFramework.prototype) {
            return false;
        }
        if (GuiFramework.prototype.__developerDiagnosticsBackInstalled) {
            return true;
        }

        var originalSendEvent = GuiFramework.prototype.sendEventToMmui;
        GuiFramework.prototype.sendEventToMmui = function (uiaId, eventId) {
            if (eventId === "Global.GoBack" && this._currentAppUiaId === APP_ID) {
                window.__developerDiagnosticsNavigate("applications");
                return;
            }
            return originalSendEvent.apply(this, arguments);
        };
        GuiFramework.prototype.__developerDiagnosticsBackInstalled = true;
        return true;
    }

    function installInputMonitor() {
        if (!window.GuiFramework || !GuiFramework.prototype) {
            return false;
        }
        if (GuiFramework.prototype.__developerDiagnosticsInputMonitorInstalled) {
            return true;
        }

        var methods = [
            { name: "routeMmuiMsg", channel: "mmui" },
            { name: "routeAppsdkMsg", channel: "appsdk" },
            { name: "routeDbapiMsg", channel: "dbapi" }
        ];
        for (var index = 0; index < methods.length; index += 1) {
            (function (method) {
                var original = GuiFramework.prototype[method.name];
                GuiFramework.prototype[method.name] = function (message) {
                    recordInput(method.channel, message);
                    return original.apply(this, arguments);
                };
            }(methods[index]));
        }

        var originalSetSharedData = GuiFramework.prototype.setSharedData;
        GuiFramework.prototype.setSharedData = function (uiaId, name, value) {
            window.__developerDiagnosticsInputs.shared[uiaId + "." + name] = {
                owner: uiaId,
                name: name,
                value: copyInput(value),
                observedAt: new Date().toISOString()
            };
            return originalSetSharedData.apply(this, arguments);
        };
        GuiFramework.prototype.__developerDiagnosticsInputMonitorInstalled = true;
        return true;
    }

    function addApplicationName(system) {
        var names = system._applicationsCtxtWiseAppNames;
        if (!names || !names.Applications) {
            return;
        }
        if (names.Applications.indexOf(APP_ID) === -1) {
            names.Applications.push(APP_ID);
        }
    }

    function installApplicationsEntry() {
        if (!window.framework || !framework._appInstances) {
            return false;
        }
        var system = framework._appInstances.system;
        if (!system || !system._masterApplicationDataList || !system._contextTable) {
            return false;
        }
        if (system.__developerDiagnosticsEntryInstalled) {
            return true;
        }

        var items = system._masterApplicationDataList.items;
        var found = false;
        for (var index = 0; index < items.length; index += 1) {
            if (items[index].appData && items[index].appData.appName === APP_ID) {
                found = true;
                break;
            }
        }
        if (!found) {
            items.push({
                appData: {
                    appName: APP_ID,
                    isVisible: true,
                    audioSourceId: "None",
                    mmuiEvent: ""
                },
                text1: "Developer Diagnostics",
                disabled: false,
                itemStyle: "style01",
                hasCaret: true
            });
        }

        var originalUpdateStructure = system._updateApplicationStructure;
        system._updateApplicationStructure = function () {
            originalUpdateStructure.apply(this, arguments);
            addApplicationName(this);
        };
        addApplicationName(system);

        var originalSelect = system._menuItemSelectCallback;
        var select = function (listControl, appData, params) {
            if (appData && appData.appName === APP_ID) {
                window.__developerDiagnosticsNavigate("diagnostics");
                return;
            }
            return originalSelect.call(system, listControl, appData, params);
        };
        system._contextTable.Applications.controlProperties.List2Ctrl.selectCallback = select;
        system.__developerDiagnosticsEntryInstalled = true;
        window.__developerDiagnosticsIntegration = {
            installed: true,
            appId: APP_ID,
            contextId: APP_CONTEXT
        };

        if (system._currentContext && system._currentContext.ctxtId === "Applications") {
            system._readyApplications();
        }
        return true;
    }

    function integrate() {
        attempts += 1;
        var loaderReady = installAppLoader();
        var backReady = installBackNavigation();
        var inputMonitorReady = installInputMonitor();
        var entryReady = installApplicationsEntry();
        if (loaderReady && backReady && inputMonitorReady && entryReady) {
            clearInterval(integrationTimer);
            integrationTimer = null;
            return;
        }
        if (attempts >= 2400) {
            clearInterval(integrationTimer);
            integrationTimer = null;
            window.__developerDiagnosticsIntegration = {
                installed: false,
                error: "Timed out waiting for the stock system application"
            };
        }
    }

    integrationTimer = setInterval(integrate, 25);
    integrate();
}());
