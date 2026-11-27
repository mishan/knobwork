/*
 * Browser compatibility adapter for the stock CMU HMI (independent
 * implementation). Bridges only demonstrated Opera 12.10 vs. standards-browser
 * differences. It never creates HMI messages, contexts, focus, transitions, or
 * service connection results, in either backend mode.
 */
(function () {
  'use strict';

  var config = window.__mazdaEmulatorConfig || {};
  var mode = config.backendMode === 'proxy' ? 'proxy' : 'mock';
  var ports = config.ports || {};
  var query = String(window.location.search || '');
  var debugEnabled = /(?:^|[?&])emuDebug=(?:1|true)(?:&|$)/.test(query);

  function debug() {
    if (debugEnabled && window.console) {
      window.console.debug.apply(window.console, ['[emu-compat]'].concat([].slice.call(arguments)));
    }
  }

  // Public diagnostic result. backendMode, syntheticBackend, and debugEnabled
  // are stable contract fields.
  var bound = { isStack: false, delStack: false };
  var diagnostics = {
    backendMode: mode,
    syntheticBackend: mode === 'mock',
    debugEnabled: debugEnabled,
    adapterVersion: 1,
    routedSockets: [],
    boundStackHelpers: bound,
  };
  Object.defineProperty(window, '__mazdaEmulator', { value: diagnostics, configurable: false, writable: false });

  // --- window.opera subset -------------------------------------------------
  if (!window.opera) {
    var afterLoad = [];
    var opera = {
      version: function () { return '12.10'; },
      buildNumber: function () { return '1'; },
      postError: function () {
        if (window.console) window.console.error.apply(window.console, ['[opera.postError]'].concat([].slice.call(arguments)));
      },
      // Opera's script-language controls have no standards equivalent; accept
      // and ignore them.
      setOverrideHistoryNavigationMode: function () {},
      defineMagicVariable: function () {},
      defineMagicFunction: function () {},
      addEventListener: function (type, listener) {
        if (type === 'AfterEvent.load' && typeof listener === 'function') {
          var wrapped = function (event) { listener.call(window, { type: type, event: event }); };
          afterLoad.push([listener, wrapped]);
          window.addEventListener('load', wrapped, false);
        }
      },
      removeEventListener: function (type, listener) {
        if (type !== 'AfterEvent.load') return;
        for (var i = 0; i < afterLoad.length; i++) {
          if (afterLoad[i][0] === listener) {
            window.removeEventListener('load', afterLoad[i][1], false);
            afterLoad.splice(i, 1);
            return;
          }
        }
      },
    };
    Object.defineProperty(window, 'opera', { value: opera, configurable: true, writable: true });
  }

  // --- Opera-prefixed style properties --------------------------------------
  var styleNames = [
    'transform', 'transformOrigin', 'transformStyle',
    'transition', 'transitionProperty', 'transitionDuration', 'transitionTimingFunction', 'transitionDelay',
    'animation', 'animationName', 'animationDuration', 'animationTimingFunction', 'animationDelay',
    'animationIterationCount', 'animationDirection', 'animationFillMode', 'animationPlayState',
    'userSelect', 'textOverflow',
  ];
  var styleProto = window.CSSStyleDeclaration && window.CSSStyleDeclaration.prototype;
  function cssName(camel) {
    return camel.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
  }
  if (styleProto) {
    styleNames.forEach(function (name) {
      var upper = name.charAt(0).toUpperCase() + name.slice(1);
      var standard = cssName(name);
      ['O' + upper, 'o' + upper].forEach(function (prefixed) {
        if (prefixed in styleProto) return;
        Object.defineProperty(styleProto, prefixed, {
          configurable: true,
          get: function () { return this.getPropertyValue(standard); },
          set: function (value) {
            if (value === null || value === undefined || value === '') this.removeProperty(standard);
            else this.setProperty(standard, String(value).replace(/-o-(transform|transition|animation)/g, '$1'));
          },
        });
      });
    });
    var nativeSetProperty = styleProto.setProperty;
    var prefixedCss = {};
    styleNames.forEach(function (n) { prefixedCss['-o-' + cssName(n)] = cssName(n); });
    styleProto.setProperty = function (property, value, priority) {
      var key = String(property).toLowerCase();
      if (Object.prototype.hasOwnProperty.call(prefixedCss, key)) property = prefixedCss[key];
      return nativeSetProperty.call(this, property, value, priority);
    };
  }

  // --- Opera completion event names -----------------------------------------
  var eventAliases = {
    otransitionend: 'transitionend',
    oanimationend: 'animationend',
    oanimationstart: 'animationstart',
    oanimationiteration: 'animationiteration',
  };
  function standardEvent(type) {
    var key = String(type).toLowerCase();
    return Object.prototype.hasOwnProperty.call(eventAliases, key) && /^o/i.test(type) ? eventAliases[key] : type;
  }
  var targetProto = window.EventTarget && window.EventTarget.prototype;
  if (targetProto) {
    var nativeAdd = targetProto.addEventListener;
    var nativeRemove = targetProto.removeEventListener;
    targetProto.addEventListener = function (type, listener, options) {
      return nativeAdd.call(this, standardEvent(type), listener, options);
    };
    targetProto.removeEventListener = function (type, listener, options) {
      return nativeRemove.call(this, standardEvent(type), listener, options);
    };
  }

  // --- ArrayBuffer.length ----------------------------------------------------
  if (!('length' in ArrayBuffer.prototype)) {
    Object.defineProperty(ArrayBuffer.prototype, 'length', {
      configurable: true,
      get: function () { return this.byteLength; },
    });
  }

  // --- Stock WebSocket helper binding --------------------------------------
  // The stock v74 socket class calls two global helpers as methods. Bind only
  // those existing helpers to its prototype; nothing else is altered.
  function bindStackHelpers() {
    var Ctor = window.Websockets;
    if (typeof Ctor !== 'function' || !Ctor.prototype) return;
    if (typeof window._isStack === 'function' && typeof Ctor.prototype._isStack !== 'function') {
      Ctor.prototype._isStack = window._isStack;
      bound.isStack = true;
    }
    if (typeof window._delStack === 'function' && typeof Ctor.prototype._delStack !== 'function') {
      Ctor.prototype._delStack = window._delStack;
      bound.delStack = true;
    }
  }
  document.addEventListener('DOMContentLoaded', bindStackHelpers);

  // --- WebSocket routing -----------------------------------------------------
  var stockPorts = { 2700: 'mmui', 2766: 'dbapi', 2800: 'appsdk' };
  var stockProtocols = { 'ihu-guiifm-protocol': 'mmui', 'ihu-dbapi-protocol': 'dbapi', 'ihu-appsdk-protocol': 'appsdk' };
  function route(url, protocols) {
    var parsed;
    try { parsed = new URL(String(url), window.location.href); } catch (e) { return url; }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return url;
    var protocol = Array.isArray(protocols) ? protocols[0] : protocols;
    var service = stockPorts[parsed.port] || stockProtocols[protocol];
    if (!service || !ports[service]) return url;
    parsed.hostname = window.location.hostname || '127.0.0.1';
    parsed.port = String(ports[service]);
    var routed = parsed.toString();
    diagnostics.routedSockets.push({ service: service, from: String(url), to: routed });
    if (diagnostics.routedSockets.length > 20) diagnostics.routedSockets.shift();
    debug('route', url, '->', routed);
    return routed;
  }
  var NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === 'function' && typeof Proxy === 'function') {
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct: function (Target, args, newTarget) {
        bindStackHelpers();
        var copy = Array.prototype.slice.call(args);
        copy[0] = route(copy[0], copy[1]);
        return Reflect.construct(Target, copy, newTarget === window.WebSocket ? Target : newTarget);
      },
    });
  }

  debug('adapter loaded', diagnostics);
})();
