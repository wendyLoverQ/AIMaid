"use strict";
const electron = require("electron");
const MODULE_REQUESTS = [
  "window.open",
  "window.show",
  "window.hide",
  "window.close",
  "window.quit",
  "window.focus",
  "window.minimize",
  "window.toggleMaximize",
  "dialog.openFile",
  "dialog.openDirectory",
  "dialog.saveFile",
  "core.invoke",
  "core.status"
];
const moduleCapabilities = (events = true) => ({ requests: MODULE_REQUESTS, events });
const WINDOW_CAPABILITIES = {
  main: {
    requests: [
      "window.open",
      "window.show",
      "window.hide",
      "window.close",
      "window.quit",
      "window.focus",
      "window.minimize",
      "window.toggleMaximize",
      "dialog.openFile",
      "dialog.openDirectory",
      "dialog.saveFile",
      "core.invoke",
      "core.status",
      "core.restart"
    ],
    events: true
  },
  pet: {
    requests: [
      "window.open",
      "window.show",
      "window.hide",
      "window.close",
      "window.quit",
      "window.focus",
      "core.invoke",
      "core.status",
      "pet.ready",
      "pet.getAssetManifest",
      "pet.setIgnoreMouseEvents",
      "pet.dragStart",
      "pet.dragMove",
      "pet.dragEnd",
      "pet.updateWindow",
      "pet.reportMetrics",
      "pet.presentation.get",
      "pet.presentation.execute",
      "media.registerLocalFile"
    ],
    events: true
  },
  chat: {
    requests: [...MODULE_REQUESTS, "media.registerLocalFile", "speech.audio.importData"],
    events: true
  },
  settings: {
    requests: [
      "window.open",
      "window.show",
      "window.hide",
      "window.close",
      "window.quit",
      "window.focus",
      "window.minimize",
      "window.toggleMaximize",
      "core.invoke",
      "core.status",
      "pet.presentation.get",
      "pet.presentation.execute",
      "system.settings.get",
      "system.settings.setAutoStart",
      "system.settings.setHotkey",
      "system.settings.setBubbleStyle"
    ],
    events: false
  },
  status: { requests: [...MODULE_REQUESTS, "media.registerLocalFile", "pet.runtime.get"], events: true },
  appearance: moduleCapabilities(false),
  bitcoin: moduleCapabilities(),
  timer: moduleCapabilities(),
  video: { requests: [...MODULE_REQUESTS, "shell.showItemInFolder"], events: true },
  "remote-video": { requests: [...MODULE_REQUESTS, "shell.showItemInFolder", "shell.openExternal"], events: true },
  reminders: moduleCapabilities(),
  notebook: { requests: [...MODULE_REQUESTS, "notebook.attachment.importFile", "notebook.attachment.importData", "notebook.attachment.action"], events: true },
  vault: moduleCapabilities(),
  scripts: moduleCapabilities(),
  "voice-conversation": { requests: [...MODULE_REQUESTS, "media.registerLocalFile", "speech.audio.importData"], events: true },
  characters: { requests: [...MODULE_REQUESTS, "media.registerLocalFile", "pet.presentation.get"], events: true },
  "crypto-events": moduleCapabilities(),
  "crypto-provider": moduleCapabilities(false),
  "crypto-chart": moduleCapabilities(),
  "video-player": { requests: [...MODULE_REQUESTS, "media.registerLocalFile"], events: false },
  "video-subtitles": moduleCapabilities(false),
  "remote-site-config": { requests: [...MODULE_REQUESTS, "douyin.session.inspect", "douyin.session.clear"], events: false },
  "template-card": moduleCapabilities(false),
  "character-editor": { requests: [...MODULE_REQUESTS, "media.registerLocalFile"], events: false },
  "agent-confirm": { requests: ["window.close", "agent.confirmation.get", "agent.confirmation.resolve"], events: false },
  "tray-menu": { requests: ["window.open", "window.close", "tray.action", "tray.resize", "core.invoke", "core.status"], events: true },
  "douyin-login": { requests: ["window.close", "window.minimize", "window.toggleMaximize", "douyin.session.save"], events: false },
  "ui-showcase": moduleCapabilities(false)
};
function canRequest(kind, type) {
  return WINDOW_CAPABILITIES[kind].requests.some((allowed) => allowed === type);
}
const CORE_DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
const CORE_LONG_REQUEST_TIMEOUT_MS = 12e4;
const LONG_RUNNING_CORE_REQUEST_TYPES = /* @__PURE__ */ new Set([
  "chat.send",
  "tts.speak",
  "pet.voice_cache.ensure",
  "pet.voice_cache.clear",
  "pet.voice_intimacy.cycle",
  "asr.transcribe",
  "agent.execute",
  "agent.decide",
  "character.template.generate",
  "remote_video.resolve",
  "remote_video.thumbnail",
  "remote_video.formats",
  "remote_video.play",
  "remote_video.play.replay",
  "remote_video.download.play",
  "vault.export",
  "crypto_provider.check"
]);
function coreRequestTimeoutMs(type) {
  return LONG_RUNNING_CORE_REQUEST_TYPES.has(type) ? CORE_LONG_REQUEST_TIMEOUT_MS : CORE_DEFAULT_REQUEST_TIMEOUT_MS;
}
const CORE_EVENT_TYPES = [
  "core.ready",
  "core.status-changed",
  "system.stream.progress",
  "system.stream.completed",
  "system.protocol.error",
  "request.cancelled",
  "settings.changed",
  "chat.delta",
  "chat.completed",
  "reminder.due",
  "character.changed",
  "agent.approval_requested",
  "agent.tool_call_completed",
  "music.playback.requested",
  "music.playback.state_changed",
  "music.playback.stopped",
  "core.stderr",
  "core.exit"
];
function isCoreEventType(value) {
  return typeof value === "string" && CORE_EVENT_TYPES.some((type) => type === value);
}
const IPC_CHANNELS = {
  invoke: "aimaid:invoke",
  send: "aimaid:send",
  event: "aimaid:event",
  petLifecycle: "aimaid:pet-lifecycle",
  petLipSync: "aimaid:pet-lip-sync"
};
const WINDOW_KINDS = [
  "main",
  "pet",
  "chat",
  "settings",
  "status",
  "appearance",
  "bitcoin",
  "timer",
  "video",
  "remote-video",
  "reminders",
  "notebook",
  "vault",
  "scripts",
  "voice-conversation",
  "characters",
  "crypto-events",
  "crypto-provider",
  "crypto-chart",
  "video-player",
  "video-subtitles",
  "remote-site-config",
  "template-card",
  "character-editor",
  "agent-confirm",
  "tray-menu",
  "douyin-login",
  "ui-showcase"
];
function isWindowKind(value) {
  return typeof value === "string" && WINDOW_KINDS.some((kind) => kind === value);
}
const windowKind = readWindowKind(process.argv);
const appVersion = readArgument(process.argv, "--aimaid-version=") ?? "0.0.0";
const subscriptions = /* @__PURE__ */ new Set();
function invoke(type, payload, timeoutMs = 1e4, providedRequestId) {
  if (!canRequest(windowKind, type)) return Promise.resolve(forbiddenResponse(type));
  const request = { requestId: providedRequestId ?? createRequestId(), type, payload, timestamp: Date.now() };
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cancel(request.requestId);
      resolve({
        requestId: request.requestId,
        type,
        payload: null,
        success: false,
        error: { code: "IPC_TIMEOUT", message: `Request timed out after ${timeoutMs}ms`, retryable: true },
        timestamp: Date.now()
      });
    }, clampTimeout(timeoutMs));
    void electron.ipcRenderer.invoke(IPC_CHANNELS.invoke, request).then(
      (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          requestId: request.requestId,
          type,
          payload: null,
          success: false,
          error: { code: "IPC_TRANSPORT_ERROR", message: error instanceof Error ? error.message : String(error), retryable: true },
          timestamp: Date.now()
        });
      }
    );
  });
}
function cancel(requestId) {
  sendNotification(requestId, "request.cancel", null);
}
function sendNotification(requestId, type, payload) {
  const notification = { requestId, type, payload, timestamp: Date.now() };
  electron.ipcRenderer.send(IPC_CHANNELS.send, notification);
}
function subscribe(types, listener) {
  if (!WINDOW_CAPABILITIES[windowKind].events) return () => void 0;
  if (types.length === 0 || types.length > 20 || !types.every(isCoreEventType)) throw new TypeError("Invalid event subscription");
  const subscriptionId = createRequestId();
  const allowed = new Set(types);
  const handler = (_electronEvent, event) => {
    if (allowed.has(event.type)) listener(event);
  };
  electron.ipcRenderer.on(IPC_CHANNELS.event, handler);
  sendNotification(subscriptionId, "event.subscribe", { types });
  const unsubscribe = () => {
    electron.ipcRenderer.off(IPC_CHANNELS.event, handler);
    sendNotification(subscriptionId, "event.unsubscribe", {});
    subscriptions.delete(unsubscribe);
  };
  subscriptions.add(unsubscribe);
  return unsubscribe;
}
const windowApi = {};
if (canRequest(windowKind, "window.open")) windowApi.open = (target) => invoke("window.open", { target });
if (canRequest(windowKind, "window.show")) windowApi.show = () => invoke("window.show", {});
if (canRequest(windowKind, "window.hide")) windowApi.hide = () => invoke("window.hide", {});
if (canRequest(windowKind, "window.close")) windowApi.close = () => invoke("window.close", {});
if (canRequest(windowKind, "window.quit")) windowApi.quit = () => invoke("window.quit", {});
if (canRequest(windowKind, "window.focus")) windowApi.focus = () => invoke("window.focus", {});
if (canRequest(windowKind, "window.minimize")) windowApi.minimize = () => invoke("window.minimize", {});
if (canRequest(windowKind, "window.toggleMaximize")) {
  windowApi.toggleMaximize = () => invoke("window.toggleMaximize", {});
}
const coreApi = {};
if (canRequest(windowKind, "core.invoke")) coreApi.invoke = (request, timeoutMs, requestId) => invoke("core.invoke", request, timeoutMs ?? coreRequestTimeoutMs(request.type), requestId);
if (canRequest(windowKind, "core.status")) coreApi.status = () => invoke("core.status", {});
if (canRequest(windowKind, "core.restart")) coreApi.restart = () => invoke("core.restart", {}, 3e4);
if (WINDOW_CAPABILITIES[windowKind].events) coreApi.subscribe = subscribe;
if (canRequest(windowKind, "core.invoke")) coreApi.cancel = cancel;
const systemSettingsApi = canRequest(windowKind, "system.settings.get") ? Object.freeze({
  get: () => invoke("system.settings.get", {}),
  setAutoStart: (enabled) => invoke("system.settings.setAutoStart", { enabled }),
  setHotkey: (action, gesture) => invoke("system.settings.setHotkey", { action, gesture }),
  setBubbleStyle: (style) => invoke("system.settings.setBubbleStyle", { style })
}) : void 0;
const dialogApi = canRequest(windowKind, "dialog.openFile") || canRequest(windowKind, "dialog.openDirectory") || canRequest(windowKind, "dialog.saveFile") ? Object.freeze({
  openFile: (filters = [], multiSelect = false) => invoke("dialog.openFile", { filters, multiSelect }),
  openDirectory: () => invoke("dialog.openDirectory", {}),
  saveFile: (defaultPath, filters = []) => invoke("dialog.saveFile", { defaultPath, filters })
}) : void 0;
const shellApi = canRequest(windowKind, "shell.showItemInFolder") || canRequest(windowKind, "shell.openExternal") ? Object.freeze({
  showItemInFolder: (filePath) => invoke("shell.showItemInFolder", { filePath }),
  openExternal: (url) => invoke("shell.openExternal", { url })
}) : void 0;
const mediaApi = canRequest(windowKind, "media.registerLocalFile") ? Object.freeze({ registerLocalFile: (filePath) => invoke("media.registerLocalFile", { filePath }) }) : void 0;
const notebookApi = canRequest(windowKind, "notebook.attachment.importFile") ? Object.freeze({
  importFile: (filePath) => invoke("notebook.attachment.importFile", { filePath }),
  importData: (name, dataUrl) => invoke("notebook.attachment.importData", { name, dataUrl }, 3e4),
  imageAction: (action, path) => invoke("notebook.attachment.action", { action, path })
}) : void 0;
const speechApi = canRequest(windowKind, "speech.audio.importData") ? Object.freeze({ importAudioData: (dataUrl) => invoke("speech.audio.importData", { dataUrl }, 3e4) }) : void 0;
const trayApi = canRequest(windowKind, "tray.action") ? Object.freeze({
  action: (action) => invoke("tray.action", { action }),
  resize: (height) => invoke("tray.resize", { height })
}) : void 0;
const douyinApi = canRequest(windowKind, "douyin.session.save") || canRequest(windowKind, "douyin.session.inspect") || canRequest(windowKind, "douyin.session.clear") ? Object.freeze({
  saveSession: () => invoke("douyin.session.save", {}),
  inspectSession: () => invoke("douyin.session.inspect", {}),
  clearSession: () => invoke("douyin.session.clear", {})
}) : void 0;
const agentConfirmationApi = canRequest(windowKind, "agent.confirmation.get") ? Object.freeze({
  get: () => invoke("agent.confirmation.get", {}),
  resolve: (requestId, approved) => invoke("agent.confirmation.resolve", { requestId, approved })
}) : void 0;
const petApi = windowKind === "pet" || windowKind === "chat" || windowKind === "voice-conversation" || canRequest(windowKind, "pet.presentation.get") || canRequest(windowKind, "pet.runtime.get") ? Object.freeze({
  ready: () => invoke("pet.ready", {}),
  getAssetManifest: (modelId) => invoke("pet.getAssetManifest", { modelId }),
  setIgnoreMouseEvents: (ignore) => invoke("pet.setIgnoreMouseEvents", { ignore }),
  dragStart: () => invoke("pet.dragStart", {}),
  dragMove: () => invoke("pet.dragMove", {}),
  dragEnd: () => invoke("pet.dragEnd", {}),
  updateWindow: (update) => invoke("pet.updateWindow", update),
  reportMetrics: (metrics) => invoke("pet.reportMetrics", metrics),
  runtimeStatus: () => invoke("pet.runtime.get", {}),
  publishLipSync: (frame) => sendNotification(createRequestId(), "pet.lipSync.sample", frame),
  onLipSync: (listener) => {
    const handler = (_event, frame) => listener(frame);
    electron.ipcRenderer.on(IPC_CHANNELS.petLipSync, handler);
    const unsubscribe = () => {
      electron.ipcRenderer.off(IPC_CHANNELS.petLipSync, handler);
      subscriptions.delete(unsubscribe);
    };
    subscriptions.add(unsubscribe);
    return unsubscribe;
  },
  presentation: Object.freeze({
    get: () => invoke("pet.presentation.get", {}),
    execute: (action) => invoke("pet.presentation.execute", { action })
  }),
  onLifecycle: (listener) => {
    const handler = (_event, payload) => listener(payload);
    electron.ipcRenderer.on(IPC_CHANNELS.petLifecycle, handler);
    const unsubscribe = () => {
      electron.ipcRenderer.off(IPC_CHANNELS.petLifecycle, handler);
      subscriptions.delete(unsubscribe);
    };
    subscriptions.add(unsubscribe);
    return unsubscribe;
  }
}) : void 0;
const api = {
  appVersion,
  windowKind,
  window: Object.freeze(windowApi),
  core: Object.freeze(coreApi),
  ...systemSettingsApi === void 0 ? {} : { systemSettings: systemSettingsApi },
  ...dialogApi === void 0 ? {} : { dialog: dialogApi },
  ...shellApi === void 0 ? {} : { shell: shellApi },
  ...mediaApi === void 0 ? {} : { media: mediaApi },
  ...notebookApi === void 0 ? {} : { notebook: notebookApi },
  ...speechApi === void 0 ? {} : { speech: speechApi },
  ...trayApi === void 0 ? {} : { tray: trayApi },
  ...douyinApi === void 0 ? {} : { douyin: douyinApi },
  ...agentConfirmationApi === void 0 ? {} : { agentConfirmation: agentConfirmationApi },
  ...petApi === void 0 ? {} : { pet: petApi }
};
process.once("exit", () => {
  for (const unsubscribe of [...subscriptions]) unsubscribe();
});
electron.contextBridge.exposeInMainWorld("aimaid", Object.freeze(api));
function readWindowKind(args) {
  const raw = args.find((argument) => argument.startsWith("--aimaid-window="))?.split("=", 2)[1];
  if (!isWindowKind(raw)) throw new Error("Missing or invalid window capability scope");
  return raw;
}
function readArgument(args, prefix) {
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
function createRequestId() {
  return globalThis.crypto.randomUUID();
}
function clampTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs)) return 1e4;
  return Math.min(6e5, Math.max(100, Math.trunc(timeoutMs)));
}
function forbiddenResponse(type) {
  return {
    requestId: createRequestId(),
    type,
    payload: null,
    success: false,
    error: { code: "IPC_FORBIDDEN", message: "This API is not available to the current window", retryable: false },
    timestamp: Date.now()
  };
}
