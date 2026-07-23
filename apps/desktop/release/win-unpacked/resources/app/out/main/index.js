import { app, ipcMain, screen, shell, dialog, BrowserWindow, protocol, net, powerMonitor, nativeImage, Tray, session, clipboard, globalShortcut, Notification } from "electron";
import { join, dirname, resolve, isAbsolute, relative, sep, extname, basename } from "node:path";
import { existsSync, mkdirSync, appendFileSync, realpathSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, readdir, mkdir, writeFile, rm, stat, copyFile, unlink } from "node:fs/promises";
function createCoreLaunchSpec() {
  if (app.isPackaged) {
    const executableName = process.platform === "win32" ? "AIMaid.CoreHost.exe" : "AIMaid.CoreHost";
    const executable = join(process.resourcesPath, "core", `${process.platform}-${process.arch}`, executableName);
    assertExists(executable);
    return { command: executable, args: [], workingDirectory: dirname(executable), environment: { ...process.env } };
  }
  const assembly = resolve(app.getAppPath(), "../../src/AIMaid.CoreHost/bin/Debug/net8.0/AIMaid.CoreHost.dll");
  assertExists(assembly);
  return { command: "dotnet", args: [assembly], workingDirectory: dirname(assembly), environment: { ...process.env } };
}
function assertExists(path) {
  if (!existsSync(path)) throw new Error(`Expected Core artifact is missing: ${path}`);
}
class CoreProcessManager extends EventEmitter {
  constructor(launchSpec, log, startTimeoutMs = 1e4, stopTimeoutMs = 5e3) {
    super();
    this.launchSpec = launchSpec;
    this.log = log;
    this.startTimeoutMs = startTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
  }
  launchSpec;
  log;
  startTimeoutMs;
  stopTimeoutMs;
  state = "stopped";
  child;
  startedAt;
  lastError;
  handshake;
  expectedExit = false;
  get status() {
    const status = { state: this.state, implementation: "real" };
    if (this.startedAt !== void 0) status.startedAt = this.startedAt;
    if (this.lastError !== void 0) status.lastError = this.lastError;
    if (this.handshake !== void 0) {
      status.coreVersion = this.handshake.coreVersion;
      status.protocolVersion = this.handshake.protocolVersion;
      status.capabilities = [...this.handshake.capabilities];
    }
    if (this.child?.pid !== void 0) status.processId = this.child.pid;
    return status;
  }
  async start() {
    if (this.state !== "stopped" && this.state !== "exited" && this.state !== "failed") return;
    const startRequestedAt = performance.now();
    this.setState("starting");
    this.expectedExit = false;
    this.handshake = void 0;
    this.lastError = void 0;
    this.log.info("core-process", "Core process launch started", {
      workingDirectory: this.launchSpec.workingDirectory,
      startTimeoutMs: this.startTimeoutMs
    });
    await new Promise((resolve2, reject) => {
      const child = spawn(this.launchSpec.command, this.launchSpec.args, {
        cwd: this.launchSpec.workingDirectory,
        env: this.launchSpec.environment,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Core start timed out after ${this.startTimeoutMs}ms`));
      }, this.startTimeoutMs);
      child.once("spawn", () => {
        clearTimeout(timer);
        this.startedAt = Date.now();
        this.installProcessRouting(child);
        this.setState("handshaking");
        this.log.info("core-process", "Core process spawned", {
          processId: child.pid ?? -1,
          durationMs: elapsedMs$4(startRequestedAt)
        });
        resolve2();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        this.lastError = error.message;
        this.setState("failed");
        this.log.error("core-process", "Core process launch failed", error, { durationMs: elapsedMs$4(startRequestedAt) });
        reject(error);
      });
    });
  }
  markReady(handshake) {
    if (this.state !== "handshaking") throw new Error("Core cannot become ready before process handshake");
    this.handshake = handshake;
    this.setState("ready");
    this.log.info("core-process", "Core process ready", {
      processId: this.child?.pid ?? -1,
      coreVersion: handshake.coreVersion,
      protocolVersion: handshake.protocolVersion,
      capabilitiesCount: handshake.capabilities.length,
      startupDurationMs: this.startedAt === void 0 ? void 0 : Date.now() - this.startedAt
    });
  }
  expectExit() {
    this.expectedExit = true;
  }
  writeLine(line) {
    if (this.child === void 0 || this.child.stdin.destroyed || this.state !== "handshaking" && this.state !== "ready") {
      throw new Error("Core stdin is unavailable");
    }
    this.child.stdin.write(`${line}
`, "utf8");
  }
  async stop() {
    const child = this.child;
    if (child === void 0) {
      this.setState("stopped");
      return;
    }
    this.expectedExit = true;
    this.setState("stopping");
    const exited = await waitForExit(child, this.stopTimeoutMs);
    if (!exited && child.exitCode === null) {
      this.log.warn("core-process", "Graceful stop timed out; terminating Core", { processId: child.pid ?? -1 });
      child.kill();
      await waitForExit(child, 2e3);
    }
    this.child = void 0;
    this.startedAt = void 0;
    this.handshake = void 0;
    this.setState("stopped");
  }
  async restart() {
    await this.stop();
    await this.start();
  }
  health() {
    return this.state === "ready" && this.child !== void 0 && this.child.exitCode === null;
  }
  installProcessRouting(child) {
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stdout.on("line", (line) => this.emit("line", line));
    stderr.on("line", (line) => {
      const record = parseStructuredCoreLog(line);
      if (record === void 0) this.log.warn("core-stderr", "Unstructured Core stderr", { line });
      else this.log.info("core-stderr", readCoreLogMessage(record), record);
      this.emit("stderr", line);
    });
    child.once("exit", (code, signal) => {
      stdout.close();
      stderr.close();
      const uptimeMs = this.startedAt === void 0 ? void 0 : Date.now() - this.startedAt;
      this.child = void 0;
      this.startedAt = void 0;
      this.handshake = void 0;
      if (this.expectedExit) this.setState("stopped");
      else {
        this.lastError = `Core exited unexpectedly (code=${String(code)}, signal=${String(signal)})`;
        this.setState(code === 0 ? "exited" : "failed");
      }
      this.log.info("core-process", "Core process exited", {
        processId: child.pid ?? -1,
        code,
        signal,
        expected: this.expectedExit,
        uptimeMs
      });
      this.emit("exit", { code, signal, expected: this.expectedExit });
    });
  }
  setState(state) {
    const previousState = this.state;
    this.state = state;
    this.log.info("core-process", "Core process state changed", { previousState, state, processId: this.child?.pid ?? null });
    this.emit("status", this.status);
  }
}
function parseStructuredCoreLog(line) {
  try {
    const value = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
  } catch {
    return void 0;
  }
}
function readCoreLogMessage(record) {
  if (typeof record.message === "string") return record.message;
  if (typeof record.eventName === "string") return record.eventName;
  return "Core log";
}
function elapsedMs$4(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve2) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve2(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve2(true);
    };
    child.once("exit", onExit);
  });
}
const CORE_PROTOCOL_VERSION = "1.0";
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
function isCoreRequest(value) {
  if (!isRecord$3(value) || typeof value.type !== "string" || !isRecord$3(value.payload)) return false;
  switch (value.type) {
    case "system.health":
      return Object.keys(value.payload).length === 0;
    case "system.window.fit_virtual_desktop":
      return typeof value.payload.windowHandle === "string" && /^\d{1,20}$/u.test(value.payload.windowHandle);
    case "system.window.center_on_client_rect":
      return typeof value.payload.petWindowHandle === "string" && /^\d{1,20}$/u.test(value.payload.petWindowHandle) && typeof value.payload.targetWindowHandle === "string" && /^\d{1,20}$/u.test(value.payload.targetWindowHandle) && isFiniteNumber$1(value.payload.x) && isFiniteNumber$1(value.payload.y) && isPositiveFiniteNumber$1(value.payload.width) && isPositiveFiniteNumber$1(value.payload.height) && isPositiveFiniteNumber$1(value.payload.viewportWidth) && isPositiveFiniteNumber$1(value.payload.viewportHeight);
    case "settings.get":
      return value.payload.keys === void 0 || Array.isArray(value.payload.keys) && value.payload.keys.length <= 20 && value.payload.keys.every((key) => typeof key === "string" && key.length > 0 && key.length <= 100);
    case "settings.save":
      return isRecord$3(value.payload.values) && Object.keys(value.payload.values).length > 0 && Object.keys(value.payload.values).length <= 50 && Object.entries(value.payload.values).every(([key, settingValue]) => key.length > 0 && key.length <= 100 && typeof settingValue === "string" && settingValue.length <= 4096);
    case "chat.history":
      return (value.payload.conversationId === void 0 || isNonEmptyString(value.payload.conversationId)) && (value.payload.limit === void 0 || isIntegerInRange(value.payload.limit, 1, 100));
    case "chat.send":
      return isNonEmptyString(value.payload.content) && (value.payload.conversationId === void 0 || isNonEmptyString(value.payload.conversationId)) && (value.payload.characterId === void 0 || typeof value.payload.characterId === "string") && (value.payload.modelName === void 0 || typeof value.payload.modelName === "string");
    case "chat.update_metadata":
      return Number.isSafeInteger(value.payload.messageId) && Number(value.payload.messageId) > 0 && typeof value.payload.metadataJson === "string" && value.payload.metadataJson.length <= 65536;
    case "tts.speak":
      return isNonEmptyString(value.payload.text) && value.payload.text.length <= 2e4 && (value.payload.voiceId === void 0 || typeof value.payload.voiceId === "string") && (value.payload.style === void 0 || typeof value.payload.style === "string");
    case "asr.transcribe":
      return isNonEmptyString(value.payload.audioPath) && value.payload.audioPath.length <= 32768 && (value.payload.characterId === void 0 || isNonEmptyString(value.payload.characterId) && value.payload.characterId.length <= 96) && (value.payload.sessionId === void 0 || isNonEmptyString(value.payload.sessionId)) && (value.payload.language === void 0 || isNonEmptyString(value.payload.language)) && (value.payload.requestId === void 0 || isNonEmptyString(value.payload.requestId));
    case "voice_conversation.list":
      return (value.payload.roleId === void 0 || typeof value.payload.roleId === "string") && (value.payload.search === void 0 || typeof value.payload.search === "string");
    case "voice_conversation.save":
      return isVoiceConversation(value.payload.conversation);
    case "voice_conversation.delete":
      return isNonEmptyString(value.payload.conversationId);
    case "script.list":
      return Object.keys(value.payload).length === 0;
    case "script.save":
      return isChatCommandLauncher(value.payload.launcher);
    case "script.run":
      return isNonEmptyString(value.payload.launcherId);
    case "timer_record.list":
      return Object.keys(value.payload).length === 0;
    case "timer_record.save":
      return isTimerRecord(value.payload.record);
    case "timer_record.delete":
      return isNonEmptyString(value.payload.recordId);
    case "remote_site.list":
      return value.payload.enabledOnly === void 0 || typeof value.payload.enabledOnly === "boolean";
    case "remote_site.get":
      return isNonEmptyString(value.payload.siteId) && (value.payload.includeCookie === void 0 || typeof value.payload.includeCookie === "boolean");
    case "remote_site.save":
      return isRemoteSite(value.payload.site) && (value.payload.plainCookie === null || typeof value.payload.plainCookie === "string");
    case "remote_site.delete":
      return isNonEmptyString(value.payload.siteId);
    case "remote_video.resolve":
      return isNonEmptyString(value.payload.input) && value.payload.input.length <= 2e4;
    case "remote_video.thumbnail":
    case "remote_video.formats":
      return isNonEmptyString(value.payload.itemId);
    case "remote_video.play":
      return isNonEmptyString(value.payload.itemId) && (value.payload.formatSelector === void 0 || typeof value.payload.formatSelector === "string") && (value.payload.mode === "direct" || value.payload.mode === "cache");
    case "remote_video.download.start":
      return Array.isArray(value.payload.itemIds) && value.payload.itemIds.length > 0 && value.payload.itemIds.length <= 100 && value.payload.itemIds.every(isNonEmptyString) && (value.payload.formatSelector === void 0 || typeof value.payload.formatSelector === "string");
    case "remote_video.download.cancel":
    case "remote_video.download.delete":
    case "remote_video.download.play":
      return isNonEmptyString(value.payload.taskId);
    case "remote_video.download.list":
    case "remote_video.play.list":
    case "remote_video.settings.get":
    case "remote_video.diagnostics":
      return Object.keys(value.payload).length === 0;
    case "remote_video.play.replay":
      return isNonEmptyString(value.payload.historyId);
    case "remote_video.settings.save":
      return isRemoteVideoSettings(value.payload.settings);
    case "crypto_provider.get":
    case "market.symbols":
      return Object.keys(value.payload).length === 0;
    case "crypto_provider.save":
    case "crypto_provider.check":
      return isCryptoProviderConfiguration(value.payload.configuration);
    case "market.snapshot":
      return isNonEmptyString(value.payload.symbol);
    case "market.chart_snapshot":
      return isNonEmptyString(value.payload.symbol) && typeof value.payload.interval === "string" && Array.isArray(value.payload.emaPeriods) && value.payload.emaPeriods.every((item) => Number.isInteger(item));
    case "market.list":
      return (value.payload.symbol === void 0 || typeof value.payload.symbol === "string") && (value.payload.limit === void 0 || isIntegerInRange(value.payload.limit, 1, 1e3));
    case "market.record":
      return isRecord$3(value.payload.marketEvent) && isNonEmptyString(value.payload.marketEvent.eventId) && isNonEmptyString(value.payload.marketEvent.eventType) && isNonEmptyString(value.payload.marketEvent.symbol);
    case "notebook.list":
      return Object.keys(value.payload).length === 0;
    case "notebook.save":
      return isNotebookNote(value.payload.note);
    case "notebook.delete":
      return isNonEmptyString(value.payload.noteId);
    case "video.list":
      return value.payload.favoritesOnly === void 0 || typeof value.payload.favoritesOnly === "boolean";
    case "video.import_file":
      return isNonEmptyString(value.payload.filePath) && isOptionalNullableId(value.payload.albumId);
    case "video.import_folder":
      return isNonEmptyString(value.payload.folderPath) && typeof value.payload.recursive === "boolean" && isOptionalNullableId(value.payload.albumId);
    case "video.refresh_metadata":
    case "video.remove_records":
    case "video.delete_local_files":
      return isVideoIds(value.payload.videoIds);
    case "video.play":
      return isVideoIds(value.payload.videoIds) && isNonEmptyString(value.payload.startVideoId) && value.payload.videoIds.includes(value.payload.startVideoId);
    case "video.toggle_favorite":
      return isNonEmptyString(value.payload.videoId);
    case "video.set_display_name":
      return isNonEmptyString(value.payload.videoId) && isNonEmptyString(value.payload.displayName);
    case "video.set_remark":
      return isNonEmptyString(value.payload.videoId) && typeof value.payload.remark === "string";
    case "video.update_progress":
      return isNonEmptyString(value.payload.videoId) && isNonNegativeInteger(value.payload.positionSeconds) && isNonNegativeInteger(value.payload.durationSeconds);
    case "video.album.create":
      return isNonEmptyString(value.payload.name) && (value.payload.description === void 0 || typeof value.payload.description === "string");
    case "video.album.rename":
      return isNonEmptyString(value.payload.albumId) && isNonEmptyString(value.payload.name);
    case "video.album.delete":
      return isNonEmptyString(value.payload.albumId);
    case "video.album.move":
      return isVideoIds(value.payload.videoIds) && (value.payload.albumId === null || isNonEmptyString(value.payload.albumId));
    case "video.tag.create":
    case "video.tag.delete":
      return isNonEmptyString(value.payload.tag);
    case "video.tag.rename":
      return isNonEmptyString(value.payload.oldTag) && isNonEmptyString(value.payload.newTag);
    case "video.tag.set":
      return isVideoIds(value.payload.videoIds) && typeof value.payload.tags === "string";
    case "video.dependencies":
      return Object.keys(value.payload).length === 0;
    case "subtitle.list":
      return Object.keys(value.payload).length === 0;
    case "subtitle.import":
      return isNonEmptyString(value.payload.sourcePath);
    case "subtitle.import_folder":
      return isNonEmptyString(value.payload.folderPath);
    case "subtitle.delete":
      return isNonEmptyString(value.payload.path);
    case "vault.list":
      return value.payload.itemType === void 0 || typeof value.payload.itemType === "string";
    case "vault.get":
    case "vault.secret.reveal":
      return isNonEmptyString(value.payload.itemId);
    case "vault.save":
      return isVaultItem(value.payload.item) && (value.payload.plainSecret === null || typeof value.payload.plainSecret === "string");
    case "vault.delete":
      return isNonEmptyString(value.payload.itemId);
    case "vault.history.list":
      return isNonEmptyString(value.payload.itemId);
    case "vault.history.restore":
      return isNonEmptyString(value.payload.historyId);
    case "vault.export":
      return isNonEmptyString(value.payload.outputPath) && value.payload.outputPath.toLowerCase().endsWith(".7z");
    case "reminder.list":
    case "character.list":
    case "appearance.get":
    case "disturbance_settings.get":
      return Object.keys(value.payload).length === 0;
    case "reminder.save":
      return isReminderSave(value.payload);
    case "reminder.delete":
      return isNonEmptyString(value.payload.reminderId);
    case "reminder.set_enabled":
      return isNonEmptyString(value.payload.reminderId) && typeof value.payload.enabled === "boolean";
    case "reminder.set_allow_tts":
      return isNonEmptyString(value.payload.reminderId) && typeof value.payload.allowTts === "boolean";
    case "reminder.process_due":
      return typeof value.payload.now === "string" && !Number.isNaN(Date.parse(value.payload.now)) && (value.payload.reminderIds === void 0 || Array.isArray(value.payload.reminderIds) && value.payload.reminderIds.length > 0 && value.payload.reminderIds.length <= 5 && value.payload.reminderIds.every(isNonEmptyString));
    case "character.set_current":
    case "character.delete":
      return isNonEmptyString(value.payload.roleId);
    case "character.save":
      return isCharacter(value.payload.character);
    case "character.voice_assets":
    case "pet.voice_menu.get":
    case "pet.voice_cache.clear":
    case "pet.voice_intimacy.cycle":
    case "music.current":
    case "music.toggle_pause":
    case "music.stop":
    case "status.resources":
    case "status.network":
    case "status.role":
    case "status.tts":
    case "status.server.health":
    case "status.server.summary":
    case "status.codex_quota":
      return Object.keys(value.payload).length === 0;
    case "pet.voice_cache.ensure":
      return value.payload.includeNextPeriod === void 0 || typeof value.payload.includeNextPeriod === "boolean";
    case "pet.voice.play":
      return (value.payload.triggerId === void 0 || typeof value.payload.triggerId === "string") && (value.payload.bodyPart === void 0 || typeof value.payload.bodyPart === "string") && (value.payload.source === void 0 || typeof value.payload.source === "string");
    case "pet.voice.playback.report":
      return isNonEmptyString(value.payload.triggerId) && typeof value.payload.played === "boolean" && (value.payload.bodyPart === void 0 || typeof value.payload.bodyPart === "string") && (value.payload.text === void 0 || typeof value.payload.text === "string") && (value.payload.audioPath === void 0 || typeof value.payload.audioPath === "string") && (value.payload.reason === void 0 || typeof value.payload.reason === "string") && (value.payload.source === void 0 || typeof value.payload.source === "string");
    case "music.search_and_play":
      return isNonEmptyString(value.payload.songName) && value.payload.songName.length <= 200;
    case "status.llm_latencies":
      return typeof value.payload.chatModel === "string" && typeof value.payload.cacheModel === "string" && typeof value.payload.proactiveModel === "string";
    case "tts.playback.set":
      return typeof value.payload.playing === "boolean";
    case "character.voice_asset.add":
      return isNonEmptyString(value.payload.baseName) && typeof value.payload.displayName === "string" && isNonEmptyString(value.payload.style) && isNonEmptyString(value.payload.sourceFolderPath);
    case "character.avatar.import":
      return isNonEmptyString(value.payload.sourcePath);
    case "character.voices":
      return isNonEmptyString(value.payload.roleId);
    case "character.voices.set":
      return isNonEmptyString(value.payload.roleId) && Array.isArray(value.payload.voices) && value.payload.voices.every(isRoleVoice);
    case "character.binding.get":
    case "character.binding.clear":
      return isNonEmptyString(value.payload.targetKey);
    case "character.binding.set":
      return isNonEmptyString(value.payload.targetKey) && isNonEmptyString(value.payload.roleId);
    case "character.template.generate":
      return isNonEmptyString(value.payload.roleId) && typeof value.payload.continueIteration === "boolean";
    case "agent.capabilities.list":
      return Object.keys(value.payload).length === 0;
    case "agent.capability.save":
      return isAgentCapability(value.payload.capability);
    case "agent.execute":
      return isNonEmptyString(value.payload.conversationId) && isNonEmptyString(value.payload.capabilityName) && isNonEmptyString(value.payload.argsJson) && (value.payload.approvalToken === void 0 || isNonEmptyString(value.payload.approvalToken));
    case "agent.decide":
      return isNonEmptyString(value.payload.content) && typeof value.payload.saveUserMessage === "boolean" && (value.payload.conversationId === void 0 || isNonEmptyString(value.payload.conversationId)) && (value.payload.characterId === void 0 || isNonEmptyString(value.payload.characterId)) && (value.payload.toolResultJson === void 0 || typeof value.payload.toolResultJson === "string") && (value.payload.continueConversation === void 0 || typeof value.payload.continueConversation === "boolean") && (value.payload.toolStep === void 0 || isIntegerInRange(value.payload.toolStep, 1, 20)) && (value.payload.maxSteps === void 0 || isIntegerInRange(value.payload.maxSteps, 1, 20));
    case "appearance.save":
      return isAppearanceConfiguration(value.payload.configuration);
    case "disturbance_settings.save":
      return isDisturbanceSettings(value.payload.settings);
    case "model.list":
    case "business_model.list":
    case "source_prompt.list":
      return Object.keys(value.payload).length === 0;
    case "model.save":
      return Array.isArray(value.payload.configurations) && value.payload.configurations.length > 0 && value.payload.configurations.every(isModelConfiguration);
    case "model.add":
      return isNonEmptyString(value.payload.modelKey) && (value.payload.modelType === "local" || value.payload.modelType === "api");
    case "business_model.save":
      return Array.isArray(value.payload.configurations) && value.payload.configurations.length > 0 && value.payload.configurations.every(isBusinessModelConfiguration);
    case "source_prompt.save":
      return isSourcePrompt(value.payload.prompt);
    case "system.stream":
      return isIntegerInRange(value.payload.steps, 1, 20) && isIntegerInRange(value.payload.delayMs, 20, 5e3);
    default:
      return false;
  }
}
function isAppearanceConfiguration(value) {
  return isRecord$3(value) && isNonEmptyString(value.themeId) && typeof value.contentBrightness === "string" && typeof value.fontFamily === "string" && typeof value.fontScale === "number" && typeof value.cornerRadiusStyle === "string" && typeof value.density === "string" && typeof value.headerStyle === "string" && typeof value.animationsEnabled === "boolean";
}
function isDisturbanceSettings(value) {
  return isRecord$3(value) && ["normal", "quiet", "focus", "game", "sleep"].includes(String(value.mode)) && typeof value.quietHoursEnabled === "boolean" && typeof value.quietHoursStart === "string" && typeof value.quietHoursEnd === "string" && typeof value.suppressWhenFullscreen === "boolean" && Number.isInteger(value.maxProactivePerHour) && typeof value.updatedAt === "string";
}
function isModelConfiguration(value) {
  return isRecord$3(value) && isNonEmptyString(value.modelKey) && (value.type === "local" || value.type === "api") && typeof value.endpoint === "string" && isNonEmptyString(value.model) && typeof value.apiKey === "string" && typeof value.enableWebSearch === "boolean" && typeof value.think === "boolean";
}
function isBusinessModelConfiguration(value) {
  return isRecord$3(value) && isNonEmptyString(value.businessKey) && typeof value.displayName === "string" && typeof value.description === "string" && typeof value.provider === "string" && isNonEmptyString(value.modelKey) && typeof value.isEnabled === "boolean" && typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}
function isSourcePrompt(value) {
  return isRecord$3(value) && isNonEmptyString(value.sourceKey) && typeof value.purpose === "string" && typeof value.systemPromptTemplate === "string" && typeof value.userPromptTemplate === "string" && typeof value.outputSchemaJson === "string" && typeof value.isEnabled === "boolean" && typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}
function isVoiceConversation(value) {
  return isRecord$3(value) && isNonEmptyString(value.conversationId) && isNonEmptyString(value.voiceRoleId) && typeof value.title === "string" && typeof value.preview === "string" && typeof value.createdAt === "string" && typeof value.updatedAt === "string";
}
function isRoleVoice(value) {
  return isRecord$3(value) && typeof value.roleId === "string" && isNonEmptyString(value.voiceId) && isNonEmptyString(value.style) && typeof value.isDefault === "boolean" && typeof value.isEnabled === "boolean" && typeof value.updatedAt === "string";
}
function isChatCommandLauncher(value) {
  return isRecord$3(value) && typeof value.launcherId === "string" && isNonEmptyString(value.commandText) && typeof value.displayName === "string" && typeof value.exePath === "string" && typeof value.arguments === "string" && typeof value.workingDirectory === "string" && typeof value.enabled === "boolean" && typeof value.updatedAt === "string";
}
function isTimerRecord(value) {
  return isRecord$3(value) && isNonEmptyString(value.recordId) && typeof value.savedAt === "string" && typeof value.durationSeconds === "number" && Number.isInteger(value.durationSeconds) && value.durationSeconds >= 0;
}
function isRemoteSite(value) {
  return isRecord$3(value) && isNonEmptyString(value.siteId) && typeof value.siteName === "string" && typeof value.domainPattern === "string" && typeof value.adapterKey === "string" && typeof value.qualityPreference === "string" && typeof value.isEnabled === "boolean" && typeof value.settingsJson === "string" && typeof value.updatedAt === "string" && typeof value.hasProtectedCookie === "boolean";
}
function isRemoteVideoSettings(value) {
  return isRecord$3(value) && isNonEmptyString(value.downloadRoot) && isNonEmptyString(value.cacheRoot) && isNonEmptyString(value.fileNameTemplate) && typeof value.defaultQualityPreference === "string" && typeof value.downloadThumbnail === "boolean" && typeof value.downloadInfoJson === "boolean" && typeof value.downloadSubtitles === "boolean" && typeof value.overwriteExisting === "boolean" && typeof value.autoImportToVideoLibrary === "boolean" && isIntegerInRange(value.maxConcurrentDownloads, 1, 4) && isNonEmptyString(value.ytDlpPath) && isNonEmptyString(value.ffmpegPath) && isNonEmptyString(value.potPlayerPath) && typeof value.updatedAt === "string";
}
function isCryptoProviderConfiguration(value) {
  return isRecord$3(value) && typeof value.isEnabled === "boolean" && typeof value.serviceUrl === "string" && Number.isInteger(value.timeoutSeconds) && typeof value.lastHealthStatus === "string" && (value.lastHealthLatencyMs === null || typeof value.lastHealthLatencyMs === "number") && (value.lastCheckedAt === null || typeof value.lastCheckedAt === "string");
}
function isReminderSave(value) {
  return (value.reminderId === null || typeof value.reminderId === "string") && typeof value.title === "string" && typeof value.message === "string" && typeof value.dueAt === "string" && !Number.isNaN(Date.parse(value.dueAt)) && (value.repeat === "none" || value.repeat === "daily") && typeof value.enabled === "boolean" && typeof value.allowTts === "boolean";
}
function isNotebookNote(value) {
  return isRecord$3(value) && isNonEmptyString(value.noteId) && typeof value.title === "string" && typeof value.contentMarkdown === "string" && typeof value.contentPlainText === "string" && Array.isArray(value.attachmentIds) && value.attachmentIds.every((id) => typeof id === "string") && typeof value.isPinned === "boolean" && typeof value.isDeleted === "boolean" && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) && typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt));
}
function isCharacter(value) {
  return isRecord$3(value) && isNonEmptyString(value.roleId) && typeof value.name === "string" && typeof value.voiceName === "string" && typeof value.roleTitle === "string" && typeof value.cardPath === "string" && typeof value.sourceCardJson === "string" && typeof value.templateCardJson === "string" && typeof value.preferredVoiceId === "string" && typeof value.validationStatus === "string" && typeof value.avatarPath === "string" && typeof value.isEnabled === "boolean" && typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt));
}
function isAgentCapability(value) {
  return isRecord$3(value) && isNonEmptyString(value.capabilityName) && isNonEmptyString(value.displayName) && typeof value.description === "string" && isNonEmptyString(value.executorType) && typeof value.configJson === "string" && typeof value.argsSchemaJson === "string" && typeof value.resultPolicy === "string" && typeof value.riskLevel === "string" && typeof value.requireConfirm === "boolean" && typeof value.enabled === "boolean" && Number.isInteger(value.sortOrder) && typeof value.updatedAt === "string";
}
function isVaultItem(value) {
  return isRecord$3(value) && isNonEmptyString(value.itemId) && isNonEmptyString(value.itemType) && typeof value.name === "string" && typeof value.category === "string" && typeof value.account === "string" && typeof value.url === "string" && typeof value.platform === "string" && typeof value.publicMetadataJson === "string" && typeof value.hasProtectedSecret === "boolean" && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) && typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt));
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isOptionalNullableId(value) {
  return value === void 0 || value === null || isNonEmptyString(value);
}
function isVideoIds(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 1e3 && value.every(isNonEmptyString);
}
function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function isFiniteNumber$1(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isPositiveFiniteNumber$1(value) {
  return isFiniteNumber$1(value) && value > 0;
}
function isRecord$3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isIntegerInRange(value, minimum, maximum) {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}
function createCoreRequest(id, type, payload) {
  return { protocolVersion: CORE_PROTOCOL_VERSION, id, kind: "request", type, timestamp: (/* @__PURE__ */ new Date()).toISOString(), payload };
}
function parseCoreLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new CoreProtocolViolation("PROTOCOL_INVALID_JSON", "Core stdout 包含非法 JSON。");
  }
  if (!isRecord$3(value) || value.protocolVersion !== CORE_PROTOCOL_VERSION) {
    throw new CoreProtocolViolation("PROTOCOL_VERSION_MISMATCH", "Core 协议版本不兼容。");
  }
  if (!validBase(value)) throw new CoreProtocolViolation("PROTOCOL_INVALID_ENVELOPE", "Core 消息缺少必需字段。");
  if (value.kind === "response") {
    if (typeof value.success !== "boolean" || !("payload" in value) || !validError(value.error)) {
      throw new CoreProtocolViolation("PROTOCOL_INVALID_ENVELOPE", "Core response 结构无效。");
    }
    return value;
  }
  if (value.kind === "event") {
    if (value.correlationId !== null && typeof value.correlationId !== "string" || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !("payload" in value)) {
      throw new CoreProtocolViolation("PROTOCOL_INVALID_ENVELOPE", "Core event 结构无效。");
    }
    return value;
  }
  throw new CoreProtocolViolation("PROTOCOL_INVALID_ENVELOPE", "Core 只能输出 response 或 event。");
}
class CoreProtocolViolation extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "CoreProtocolViolation";
  }
  code;
}
function validBase(value) {
  return typeof value.id === "string" && value.id.length >= 8 && value.id.length <= 100 && typeof value.type === "string" && /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/u.test(value.type) && typeof value.timestamp === "string" && !Number.isNaN(Date.parse(value.timestamp)) && (value.kind === "response" || value.kind === "event");
}
function validError(value) {
  return value === null || isRecord$3(value) && typeof value.code === "string" && typeof value.message === "string" && isRecord$3(value.details);
}
const DEFAULT_TIMEOUTS = {
  handshake: 8e3,
  request: coreRequestTimeoutMs("system.health"),
  longRequest: CORE_LONG_REQUEST_TIMEOUT_MS,
  cancel: 5e3,
  shutdown: 3e3
};
class StdioCoreClient {
  constructor(processManager, desktopVersion, log, timeouts = DEFAULT_TIMEOUTS) {
    this.processManager = processManager;
    this.desktopVersion = desktopVersion;
    this.log = log;
    this.timeouts = timeouts;
  }
  processManager;
  desktopVersion;
  log;
  timeouts;
  pending = /* @__PURE__ */ new Map();
  completedIds = /* @__PURE__ */ new Set();
  listeners = /* @__PURE__ */ new Set();
  sequences = /* @__PURE__ */ new Map();
  started = false;
  async start() {
    if (this.started) return;
    const startedAt = performance.now();
    this.log.info("core-client", "Core handshake started", {
      protocolVersion: CORE_PROTOCOL_VERSION,
      desktopVersion: this.desktopVersion,
      platform: process.platform,
      arch: process.arch
    });
    this.processManager.on("line", this.handleLine);
    this.processManager.on("exit", this.handleExit);
    try {
      const payload = await this.invokeRaw(randomUUID(), "system.handshake", {
        desktopVersion: this.desktopVersion,
        platform: process.platform,
        arch: process.arch
      }, this.timeouts.handshake);
      const handshake = readHandshake(payload);
      if (handshake.protocolVersion !== CORE_PROTOCOL_VERSION) {
        throw new CoreProtocolViolation("PROTOCOL_VERSION_MISMATCH", "Core handshake 协议版本不兼容。");
      }
      this.processManager.markReady(handshake);
      this.started = true;
      this.log.info("core-client", "Core handshake completed", {
        coreVersion: handshake.coreVersion,
        protocolVersion: handshake.protocolVersion,
        capabilities: handshake.capabilities,
        durationMs: elapsedMs$3(startedAt)
      });
    } catch (error) {
      this.detach();
      this.log.error("core-client", "Core handshake failed", error, { durationMs: elapsedMs$3(startedAt) });
      throw error;
    }
  }
  async stop() {
    if (this.started && this.processManager.health()) {
      this.processManager.expectExit();
      try {
        await this.invokeRaw(randomUUID(), "system.shutdown", {}, this.timeouts.shutdown);
      } catch (error) {
        this.log.warn("core-client", "Core graceful shutdown request failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    this.started = false;
    this.rejectAll(new CoreClientError("CORE_EXITED", "Core client stopped."));
    this.detach();
    this.sequences.clear();
  }
  invoke(requestId, request, signal) {
    if (!this.started || !this.processManager.health()) {
      return Promise.reject(new CoreClientError("CORE_NOT_READY", "Core 尚未 Ready。"));
    }
    return this.invokeRaw(requestId, request.type, request.payload, this.requestTimeoutMs(request.type), signal);
  }
  async cancel(requestId) {
    if (!this.started || !this.processManager.health()) throw new CoreClientError("CORE_NOT_READY", "Core 尚未 Ready。");
    await this.invokeRaw(randomUUID(), "system.cancel", { requestId }, this.timeouts.cancel);
    this.log.info("core-client", "Cancellation sent", { requestId });
  }
  getStatus() {
    return this.processManager.status;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  invokeRaw(id, type, payload, timeoutMs, signal) {
    if (this.pending.has(id) || this.completedIds.has(id)) {
      return Promise.reject(new CoreClientError("PROTOCOL_DUPLICATE_REQUEST", "Core requestId 已经使用。"));
    }
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        const timedOut = this.pending.get(id);
        this.pending.delete(id);
        timedOut?.removeAbort?.();
        reject(new CoreClientError("REQUEST_TIMEOUT", `${type} 请求超时。`));
        this.log.warn("core-client", "Core request timed out", { requestId: id, type, timeoutMs });
        if (this.started && type !== "system.cancel" && type !== "system.shutdown" && type !== "system.handshake") {
          void this.cancel(id).catch((error) => this.log.error("core-client", "Timed-out Core cancellation failed", error));
        }
      }, timeoutMs);
      const pending = { type, startedAt: performance.now(), resolve: resolve2, reject, timer };
      if (signal !== void 0) {
        const onAbort = () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          reject(new CoreClientError("REQUEST_CANCELLED", "请求已取消。"));
          if (this.started) void this.cancel(id).catch((error) => this.log.error("core-client", "Core cancellation failed", error));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, pending);
      this.log.info("core-client", "Core request started", { requestId: id, type, timeoutMs, pendingCount: this.pending.size });
      try {
        this.processManager.writeLine(JSON.stringify(createCoreRequest(id, type, payload)));
      } catch (error) {
        this.completePending(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  handleLine = (line) => {
    let envelope;
    try {
      envelope = parseCoreLine(line);
    } catch (error) {
      this.log.error("core-protocol", "Protocol parse failed", error);
      if (error instanceof CoreProtocolViolation && error.code === "PROTOCOL_VERSION_MISMATCH") this.rejectAll(error);
      return;
    }
    if (envelope.kind === "response") this.handleResponse(envelope);
    else this.handleEvent(envelope);
  };
  handleResponse(response) {
    const pending = this.pending.get(response.id);
    if (pending === void 0) {
      const status = this.completedIds.has(response.id) ? "duplicate response" : "unknown response id";
      this.log.warn("core-protocol", status, { requestId: response.id, type: response.type });
      return;
    }
    if (pending.type !== response.type) {
      this.completePending(response.id);
      pending.reject(new CoreProtocolViolation("PROTOCOL_INVALID_ENVELOPE", "Core response type 与请求不匹配。"));
      return;
    }
    this.completePending(response.id);
    const durationMs = elapsedMs$3(pending.startedAt);
    if (response.success) {
      pending.resolve(response.payload);
      this.log.info("core-client", "Core request completed", {
        requestId: response.id,
        type: response.type,
        success: true,
        durationMs,
        pendingCount: this.pending.size
      });
    } else {
      const error = new CoreRemoteError(
        response.error?.code ?? "INTERNAL_ERROR",
        response.error?.message ?? "Core 请求失败。",
        response.error?.details ?? {}
      );
      pending.reject(error);
      this.log.error("core-client", "Core request failed", error, {
        requestId: response.id,
        type: response.type,
        success: false,
        durationMs,
        pendingCount: this.pending.size
      });
    }
  }
  handleEvent(event) {
    if (!isCoreEventType(event.type)) {
      this.log.warn("core-protocol", "Unknown Core event type", { type: event.type });
      return;
    }
    if (event.correlationId !== null) {
      const previous = this.sequences.get(event.correlationId) ?? -1;
      if (event.sequence <= previous) {
        this.log.warn("core-protocol", "Out-of-order Core event rejected", {
          correlationId: event.correlationId,
          sequence: event.sequence,
          previous
        });
        return;
      }
      this.sequences.set(event.correlationId, event.sequence);
      if (event.type.endsWith(".completed") || event.type.endsWith(".cancelled")) this.sequences.delete(event.correlationId);
    }
    const ipcEvent = {
      requestId: event.id,
      type: event.type,
      payload: { correlationId: event.correlationId, sequence: event.sequence, data: event.payload },
      success: true,
      error: null,
      timestamp: Date.parse(event.timestamp)
    };
    this.log.debug("core-client", "Core event received", {
      eventId: event.id,
      type: event.type,
      correlationId: event.correlationId,
      sequence: event.sequence
    });
    for (const listener of this.listeners) listener(ipcEvent);
  }
  handleExit = () => {
    const pendingCount = this.pending.size;
    this.started = false;
    this.rejectAll(new CoreClientError("CORE_EXITED", "Core 进程已经退出。"));
    this.log.warn("core-client", "Core process exited", { pendingCount });
  };
  requestTimeoutMs(type) {
    return coreRequestTimeoutMs(type) === CORE_LONG_REQUEST_TIMEOUT_MS ? this.timeouts.longRequest ?? this.timeouts.request : this.timeouts.request;
  }
  completePending(id) {
    const pending = this.pending.get(id);
    if (pending === void 0) return;
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    this.pending.delete(id);
    this.completedIds.add(id);
    setTimeout(() => this.completedIds.delete(id), 6e4).unref();
  }
  rejectAll(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      pending.reject(error);
      this.pending.delete(id);
    }
  }
  detach() {
    this.processManager.off("line", this.handleLine);
    this.processManager.off("exit", this.handleExit);
  }
}
function elapsedMs$3(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
class CoreClientError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "CoreClientError";
  }
  code;
}
class CoreRemoteError extends CoreClientError {
  constructor(code, message, details) {
    super(code, message);
    this.details = details;
    this.name = "CoreRemoteError";
  }
  details;
}
function readHandshake(value) {
  if (!isRecord$3(value) || typeof value.coreVersion !== "string" || value.protocolVersion !== CORE_PROTOCOL_VERSION || !Array.isArray(value.capabilities) || !value.capabilities.every((item) => typeof item === "string") || typeof value.platform !== "string" || typeof value.arch !== "string" || typeof value.desktopVersion !== "string") {
    throw new CoreProtocolViolation("PROTOCOL_INVALID_ENVELOPE", "Core handshake payload 无效。");
  }
  return {
    coreVersion: value.coreVersion,
    protocolVersion: value.protocolVersion,
    capabilities: value.capabilities,
    platform: value.platform,
    arch: value.arch,
    desktopVersion: value.desktopVersion
  };
}
const IPC_CHANNELS = {
  invoke: "aimaid:invoke",
  send: "aimaid:send",
  event: "aimaid:event",
  petLifecycle: "aimaid:pet-lifecycle",
  petLipSync: "aimaid:pet-lip-sync"
};
const IPC_REQUEST_TYPES = [
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
  "shell.showItemInFolder",
  "shell.openExternal",
  "media.registerLocalFile",
  "notebook.attachment.importFile",
  "notebook.attachment.importData",
  "notebook.attachment.action",
  "speech.audio.importData",
  "tray.action",
  "tray.resize",
  "douyin.session.save",
  "douyin.session.inspect",
  "douyin.session.clear",
  "agent.confirmation.get",
  "agent.confirmation.resolve",
  "core.invoke",
  "core.status",
  "core.restart",
  "pet.ready",
  "pet.getAssetManifest",
  "pet.setIgnoreMouseEvents",
  "pet.dragStart",
  "pet.dragMove",
  "pet.dragEnd",
  "pet.updateWindow",
  "pet.reportMetrics",
  "pet.runtime.get",
  "pet.presentation.get",
  "pet.presentation.execute",
  "system.settings.get",
  "system.settings.setAutoStart",
  "system.settings.setHotkey",
  "system.settings.setBubbleStyle"
];
function isIpcRequestEnvelope(value) {
  if (!isRecord$2(value)) return false;
  return typeof value.requestId === "string" && value.requestId.length >= 8 && value.requestId.length <= 100 && typeof value.timestamp === "number" && Number.isFinite(value.timestamp) && typeof value.type === "string" && IPC_REQUEST_TYPES.some((type) => type === value.type) && "payload" in value;
}
function isIpcNotificationEnvelope(value) {
  return isRecord$2(value) && typeof value.requestId === "string" && (value.type === "request.cancel" || value.type === "event.subscribe" || value.type === "event.unsubscribe" || value.type === "pet.lipSync.sample") && typeof value.timestamp === "number";
}
function successResponse(request, payload) {
  return {
    requestId: request.requestId,
    type: request.type,
    payload,
    success: true,
    error: null,
    timestamp: Date.now()
  };
}
function errorResponse(request, error) {
  return {
    requestId: request.requestId,
    type: request.type,
    payload: null,
    success: false,
    error,
    timestamp: Date.now()
  };
}
function isRecord$2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
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
class EventRouter {
  constructor(windows, coreClient2, coreProcess2, log) {
    this.windows = windows;
    this.coreClient = coreClient2;
    this.coreProcess = coreProcess2;
    this.log = log;
  }
  windows;
  coreClient;
  coreProcess;
  log;
  cleanups = [];
  windowsByContents = /* @__PURE__ */ new Map();
  start() {
    this.cleanups.push(this.coreClient.subscribe((event) => this.broadcast(event)));
    const onStatus = (payload) => this.broadcast(this.createEvent("core.status-changed", payload));
    const onStderr = () => this.broadcast(this.createEvent("core.stderr", { message: "Core wrote a diagnostic entry." }));
    const onExit = (payload) => this.broadcast(this.createEvent("core.exit", payload));
    this.coreProcess.on("status", onStatus);
    this.coreProcess.on("stderr", onStderr);
    this.coreProcess.on("exit", onExit);
    this.cleanups.push(() => {
      this.coreProcess.off("status", onStatus);
      this.coreProcess.off("stderr", onStderr);
      this.coreProcess.off("exit", onExit);
    });
  }
  subscribe(contents, subscriptionId, types) {
    const kind = this.windows.kindFor(contents);
    if (kind === void 0 || !WINDOW_CAPABILITIES[kind].events || !Array.isArray(types) || types.length === 0 || types.length > 20 || !types.every(isCoreEventType)) return false;
    let entry = this.windowsByContents.get(contents.id);
    if (entry === void 0) {
      entry = { contents, subscriptions: /* @__PURE__ */ new Map() };
      this.windowsByContents.set(contents.id, entry);
      contents.once("destroyed", () => this.windowsByContents.delete(contents.id));
    }
    entry.subscriptions.set(subscriptionId, new Set(types));
    return true;
  }
  unsubscribe(contentsId, subscriptionId) {
    const entry = this.windowsByContents.get(contentsId);
    if (entry === void 0) return;
    entry.subscriptions.delete(subscriptionId);
    if (entry.subscriptions.size === 0) this.windowsByContents.delete(contentsId);
  }
  stop() {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.windowsByContents.clear();
  }
  broadcast(event) {
    for (const [contentsId, entry] of this.windowsByContents) {
      if (entry.contents.isDestroyed()) {
        this.windowsByContents.delete(contentsId);
        continue;
      }
      const interested = [...entry.subscriptions.values()].some((types) => types.has(event.type));
      if (!interested) continue;
      try {
        entry.contents.send(IPC_CHANNELS.event, event);
      } catch (error) {
        this.log.error("event-router", "Window event delivery failed", error);
      }
    }
  }
  createEvent(type, payload) {
    return { requestId: randomUUID(), type, payload, success: true, error: null, timestamp: Date.now() };
  }
}
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
function isPetPresentationAction(value) {
  return typeof value === "string" && [
    "toggle-pause",
    "cycle-mode",
    "next-image",
    "cycle-image-interval",
    "choose-image-folder",
    "cycle-image-folder",
    "cycle-png-fps",
    "cycle-png-role",
    "toggle-png-carousel",
    "switch-live2d-role"
  ].includes(value);
}
const HIGH_FREQUENCY_IPC_TYPES = /* @__PURE__ */ new Set(["pet.dragMove", "pet.reportMetrics", "pet.setIgnoreMouseEvents", "pet.updateWindow"]);
const HIGH_FREQUENCY_LOG_INTERVAL_MS = 1e4;
class IpcRouter {
  constructor(windows, coreClient2, coreProcess2, events, petAssets2, petWindows2, petPresentation2, douyinSession2, notebookAttachments2, speechAudio2, systemSettings2, agentConfirmation2, log) {
    this.windows = windows;
    this.coreClient = coreClient2;
    this.coreProcess = coreProcess2;
    this.events = events;
    this.petAssets = petAssets2;
    this.petWindows = petWindows2;
    this.petPresentation = petPresentation2;
    this.douyinSession = douyinSession2;
    this.notebookAttachments = notebookAttachments2;
    this.speechAudio = speechAudio2;
    this.systemSettings = systemSettings2;
    this.agentConfirmation = agentConfirmation2;
    this.log = log;
  }
  windows;
  coreClient;
  coreProcess;
  events;
  petAssets;
  petWindows;
  petPresentation;
  douyinSession;
  notebookAttachments;
  speechAudio;
  systemSettings;
  agentConfirmation;
  log;
  activeRequests = /* @__PURE__ */ new Map();
  recentRequestIds = /* @__PURE__ */ new Map();
  requestOwners = /* @__PURE__ */ new Map();
  highFrequencyLogStats = /* @__PURE__ */ new Map();
  restartPromise;
  installed = false;
  install() {
    if (this.installed) return;
    ipcMain.handle(IPC_CHANNELS.invoke, this.handleInvoke);
    ipcMain.on(IPC_CHANNELS.send, this.handleSend);
    this.installed = true;
  }
  dispose() {
    if (!this.installed) return;
    ipcMain.removeHandler(IPC_CHANNELS.invoke);
    ipcMain.off(IPC_CHANNELS.send, this.handleSend);
    for (const request of this.activeRequests.values()) {
      clearTimeout(request.timer);
      request.controller.abort(new Error("Application is shutting down"));
    }
    this.activeRequests.clear();
    this.agentConfirmation.cancelAll("应用正在退出。");
    this.recentRequestIds.clear();
    this.requestOwners.clear();
    this.highFrequencyLogStats.clear();
    this.installed = false;
  }
  handleInvoke = async (event, value) => {
    const startedAt = performance.now();
    if (!isIpcRequestEnvelope(value)) {
      this.log.warn("ipc", "Rejected malformed or unknown request", { senderId: event.sender.id });
      throw new Error("Malformed or unknown IPC request");
    }
    const request = value;
    const kind = this.authorize(event, request);
    if (kind === void 0) {
      this.log.warn("ipc", "Rejected unauthorized request", {
        requestId: request.requestId,
        type: request.type,
        senderId: event.sender.id,
        durationMs: elapsedMs$2(startedAt)
      });
      return errorResponse(request, ipcError("IPC_FORBIDDEN", "The sender is not authorized for this request"));
    }
    if (this.isDuplicate(request.requestId)) {
      return errorResponse(request, ipcError("IPC_DUPLICATE_REQUEST", "The requestId has already been used"));
    }
    this.remember(request.requestId);
    const isHighFrequency = HIGH_FREQUENCY_IPC_TYPES.has(request.type);
    if (!isHighFrequency) {
      this.log.info("ipc", "IPC request started", {
        requestId: request.requestId,
        type: request.type,
        sourceWindow: kind,
        senderId: event.sender.id
      });
    }
    try {
      const payload = await this.dispatch(event, kind, request);
      const durationMs = elapsedMs$2(startedAt);
      if (isHighFrequency) this.logHighFrequencySummary(request.type, kind, event.sender.id, request.requestId, durationMs);
      else {
        this.log.info("ipc", "IPC request completed", {
          requestId: request.requestId,
          type: request.type,
          sourceWindow: kind,
          senderId: event.sender.id,
          success: true,
          durationMs
        });
      }
      return successResponse(request, payload);
    } catch (error) {
      this.log.error("ipc", "IPC request failed", error, {
        requestId: request.requestId,
        type: request.type,
        sourceWindow: kind,
        senderId: event.sender.id,
        success: false,
        durationMs: elapsedMs$2(startedAt)
      });
      return errorResponse(request, toIpcError(error));
    }
  };
  logHighFrequencySummary(type, sourceWindow, senderId, requestId, durationMs) {
    const now = Date.now();
    const stats = this.highFrequencyLogStats.get(type) ?? { count: 0, lastLoggedAt: 0 };
    stats.count += 1;
    if (now - stats.lastLoggedAt < HIGH_FREQUENCY_LOG_INTERVAL_MS) {
      this.highFrequencyLogStats.set(type, stats);
      return;
    }
    this.log.debug("ipc-sampled", "High-frequency IPC activity", {
      type,
      sourceWindow,
      senderId,
      lastRequestId: requestId,
      sampleCount: stats.count,
      intervalMs: stats.lastLoggedAt === 0 ? 0 : now - stats.lastLoggedAt,
      lastDurationMs: durationMs
    });
    stats.count = 0;
    stats.lastLoggedAt = now;
    this.highFrequencyLogStats.set(type, stats);
  }
  handleSend = (event, value) => {
    if (!isIpcNotificationEnvelope(value) || !this.isTrusted(event)) return;
    if (value.type === "pet.lipSync.sample") {
      const sourceKind = this.windows.kindFor(event.sender);
      const frame = readPetLipSyncFrame(value.payload);
      if (sourceKind === void 0 || frame === null || !isAllowedLipSyncSource(sourceKind, frame.source)) {
        this.log.warn("ipc", "Rejected invalid lip sync sample", { senderId: event.sender.id, sourceWindow: sourceKind });
        return;
      }
      const pet = this.windows.get("pet");
      if (pet !== void 0 && !pet.isDestroyed()) pet.webContents.send(IPC_CHANNELS.petLipSync, frame);
      return;
    }
    if (value.type === "event.subscribe") {
      if (isRecord$1(value.payload)) this.events.subscribe(event.sender, value.requestId, value.payload.types);
      return;
    }
    if (value.type === "event.unsubscribe") {
      this.events.unsubscribe(event.sender.id, value.requestId);
      return;
    }
    if (this.requestOwners.get(value.requestId) !== event.sender.id) return;
    const active = this.activeRequests.get(value.requestId);
    if (active !== void 0 && active.senderId === event.sender.id) {
      clearTimeout(active.timer);
      active.controller.abort(abortError("Request cancelled by renderer"));
      this.activeRequests.delete(value.requestId);
    } else {
      void this.coreClient.cancel(value.requestId).catch((error) => this.log.error("ipc", "Core cancellation failed", error));
    }
  };
  authorize(event, request) {
    if (!this.isTrusted(event)) return void 0;
    const kind = this.windows.kindFor(event.sender);
    return kind !== void 0 && canRequest(kind, request.type) ? kind : void 0;
  }
  isTrusted(event) {
    const frame = event.senderFrame;
    return frame !== null && frame === event.sender.mainFrame && this.windows.isTrusted(event.sender, frame.url);
  }
  async dispatch(event, sourceKind, request) {
    switch (request.type) {
      case "window.open": {
        const target = readTarget(request.payload);
        const targetWindow = await this.windows.openAndWait(target, sourceKind, {
          requestId: request.requestId,
          sourceWindow: sourceKind,
          trigger: request.type
        });
        if (sourceKind === "pet") await this.petWindows.positionWindowAtItem(targetWindow);
        return { target };
      }
      case "window.show":
        if (sourceKind === "pet") this.petWindows.show({ requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type });
        else this.windows.show(sourceKind, { requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type });
        return { window: sourceKind };
      case "window.hide":
        if (sourceKind === "pet") this.petWindows.hide({ requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type });
        else this.windows.hide(sourceKind, { requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type });
        return { window: sourceKind };
      case "window.close":
        this.windows.close(sourceKind, { requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type });
        return { window: sourceKind };
      case "window.quit":
        setImmediate(() => app.quit());
        return { quitting: true };
      case "window.focus":
        this.windows.focus(sourceKind, { requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type });
        return { window: sourceKind };
      case "window.minimize":
        this.windows.minimize(sourceKind, { requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type });
        return { window: sourceKind };
      case "window.toggleMaximize":
        return { maximized: this.windows.toggleMaximize(sourceKind, { requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type }) };
      case "dialog.openFile": {
        const filters = readFilters(request.payload);
        const multiSelect = readOptionalBoolean(request.payload, "multiSelect");
        const parent = this.windows.get(sourceKind);
        const properties = multiSelect ? ["openFile", "multiSelections"] : ["openFile"];
        const result = parent === void 0 ? await dialog.showOpenDialog({ properties, filters }) : await dialog.showOpenDialog(parent, { properties, filters });
        return { canceled: result.canceled, filePaths: result.filePaths };
      }
      case "dialog.openDirectory": {
        const parent = this.windows.get(sourceKind);
        const options = { properties: ["openDirectory"] };
        const result = parent === void 0 ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
        return { canceled: result.canceled, filePaths: result.filePaths };
      }
      case "dialog.saveFile": {
        const values = readSaveFile(request.payload);
        const parent = this.windows.get(sourceKind);
        const options = { defaultPath: values.defaultPath, filters: values.filters };
        const result = parent === void 0 ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(parent, options);
        return { canceled: result.canceled, filePath: result.filePath };
      }
      case "shell.showItemInFolder": {
        const filePath = readString(request.payload, "filePath", 32768);
        shell.showItemInFolder(filePath);
        return { shown: true };
      }
      case "shell.openExternal": {
        const url = readString(request.payload, "url", 8192);
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TypeError("Invalid external URL");
        await shell.openExternal(parsed.toString());
        return { opened: true };
      }
      case "media.registerLocalFile":
        return { url: this.petAssets.registerExternalFile(readString(request.payload, "filePath", 32768)) };
      case "notebook.attachment.importFile":
        return this.notebookAttachments.importFile(readString(request.payload, "filePath", 32768));
      case "notebook.attachment.importData":
        return this.notebookAttachments.importData(
          readString(request.payload, "name", 260),
          readString(request.payload, "dataUrl", 36e6)
        );
      case "notebook.attachment.action": {
        const action = readNotebookAttachmentAction(request.payload);
        await this.notebookAttachments.action(action, readString(request.payload, "path", 32768), this.windows.get(sourceKind));
        return { action };
      }
      case "speech.audio.importData":
        return this.speechAudio.importData(readString(request.payload, "dataUrl", 36e6));
      case "tray.action": {
        const action = readTrayAction(request.payload);
        this.windows.hide("tray-menu");
        if (action === "show") this.petWindows.show();
        else if (action === "reset-position") this.petWindows.resetPosition();
        else if (action === "hide") this.petWindows.hide();
        else setImmediate(() => app.quit());
        return { action };
      }
      case "tray.resize": {
        const requestedHeight = readTrayHeight(request.payload);
        const window = this.windows.get("tray-menu");
        if (window === void 0) throw new Error("Tray menu window is unavailable");
        const bounds = window.getBounds();
        const workArea = screen.getDisplayMatching(bounds).workArea;
        const height = Math.min(requestedHeight, workArea.height);
        const bottom = Math.min(Math.max(bounds.y + bounds.height, workArea.y + height), workArea.y + workArea.height);
        window.setBounds({ x: bounds.x, y: bottom - height, width: bounds.width, height }, false);
        window.show();
        window.focus();
        return { height };
      }
      case "douyin.session.save":
        return this.douyinSession.saveMetadata();
      case "douyin.session.inspect":
        return this.douyinSession.inspect();
      case "douyin.session.clear":
        await this.douyinSession.clear();
        return { cleared: true };
      case "agent.confirmation.get":
        return this.agentConfirmation.current();
      case "agent.confirmation.resolve":
        return { resolved: this.agentConfirmation.resolveCurrent(readString(request.payload, "requestId", 100), readBoolean(request.payload, "approved")) };
      case "core.status":
        return this.coreClient.getStatus();
      case "core.restart":
        await this.restartCore();
        return this.coreClient.getStatus();
      case "system.settings.get":
        return this.systemSettings.getSnapshot();
      case "system.settings.setAutoStart":
        return this.systemSettings.setAutoStart(readBoolean(request.payload, "enabled"));
      case "system.settings.setHotkey":
        if (!isRecord$1(request.payload)) throw new TypeError("Invalid hotkey payload");
        return this.systemSettings.setHotkey(request.payload.action, request.payload.gesture);
      case "system.settings.setBubbleStyle":
        return this.systemSettings.setBubbleStyle(readStringAllowEmpty(request.payload, "style", 16));
      case "core.invoke":
        if (!isCoreRequest(request.payload)) throw new TypeError("Invalid Core request payload");
        return this.invokeCore(event.sender.id, request.requestId, request.payload);
      case "pet.ready":
        this.petWindows.rendererReady(event.sender);
        return { ready: true };
      case "pet.getAssetManifest":
        return this.petAssets.getManifest(readString(request.payload, "modelId", 200));
      case "pet.setIgnoreMouseEvents":
        this.petWindows.setIgnoreMouseEvents(event.sender, readBoolean(request.payload, "ignore"));
        return { updated: true };
      case "pet.dragStart":
        this.petWindows.dragStart(event.sender);
        return { started: true };
      case "pet.dragMove":
        return { bounds: this.petWindows.dragMove(event.sender) };
      case "pet.dragEnd":
        return { bounds: this.petWindows.dragEnd(event.sender) };
      case "pet.updateWindow":
        return { bounds: this.petWindows.updateWindow(event.sender, readPetWindowUpdate(request.payload)) };
      case "pet.reportMetrics":
        this.petWindows.reportMetrics(event.sender, readPetMetrics(request.payload));
        return { recorded: true };
      case "pet.runtime.get":
        return this.petWindows.runtimeStatus();
      case "pet.presentation.get":
        return this.petPresentation.snapshot();
      case "pet.presentation.execute": {
        if (!isRecord$1(request.payload) || !isPetPresentationAction(request.payload.action)) throw new TypeError("Invalid presentation action");
        const parent = this.windows.get("pet");
        if (parent === void 0) throw new Error("PetWindow is unavailable");
        return this.petPresentation.execute(request.payload.action, parent);
      }
    }
  }
  async invokeCore(senderId, requestId, payload) {
    const controller = new AbortController();
    const timeoutMs = coreRequestTimeoutMs(payload.type);
    const timer = setTimeout(() => controller.abort(abortError(`Core request timed out after ${timeoutMs}ms`)), timeoutMs);
    this.activeRequests.set(requestId, { controller, senderId, timer });
    this.requestOwners.set(requestId, senderId);
    setTimeout(() => this.requestOwners.delete(requestId), 3e5).unref();
    try {
      return payload.type === "agent.execute" ? await this.agentConfirmation.execute(payload.payload, controller.signal) : await this.coreClient.invoke(requestId, payload, controller.signal);
    } finally {
      clearTimeout(timer);
      this.activeRequests.delete(requestId);
    }
  }
  async restartCore() {
    if (this.restartPromise !== void 0) return this.restartPromise;
    this.restartPromise = (async () => {
      this.agentConfirmation.cancelAll("Core 正在重启。");
      await this.coreClient.stop();
      await this.coreProcess.stop();
      await this.coreProcess.start();
      await this.coreClient.start();
    })();
    try {
      await this.restartPromise;
    } finally {
      this.restartPromise = void 0;
    }
  }
  isDuplicate(requestId) {
    return this.activeRequests.has(requestId) || this.recentRequestIds.has(requestId);
  }
  remember(requestId) {
    const expiresAt = Date.now() + 6e4;
    this.recentRequestIds.set(requestId, expiresAt);
    setTimeout(() => {
      if ((this.recentRequestIds.get(requestId) ?? 0) <= Date.now()) this.recentRequestIds.delete(requestId);
    }, 60100).unref();
  }
}
function readNotebookAttachmentAction(payload) {
  const action = readString(payload, "action", 32);
  if (action !== "copy" && action !== "openLocation" && action !== "saveAs") throw new TypeError("Invalid notebook image action");
  return action;
}
function readTarget(payload) {
  if (!isRecord$1(payload) || !isWindowKind(payload.target)) throw new TypeError("Invalid target window");
  return payload.target;
}
function readFilters(payload) {
  if (!isRecord$1(payload) || payload.filters === void 0) return [];
  if (!Array.isArray(payload.filters) || payload.filters.length > 20) throw new TypeError("Invalid file filters");
  return payload.filters.map((filter) => {
    if (!isRecord$1(filter) || typeof filter.name !== "string" || !Array.isArray(filter.extensions)) {
      throw new TypeError("Invalid file filter");
    }
    const extensions = filter.extensions;
    if (!extensions.every((value) => typeof value === "string" && /^(?:\*|[a-z0-9]+)$/iu.test(value))) {
      throw new TypeError("Invalid file extension");
    }
    return { name: filter.name.slice(0, 80), extensions };
  });
}
function readSaveFile(payload) {
  if (!isRecord$1(payload) || typeof payload.defaultPath !== "string" || payload.defaultPath.length > 260) throw new TypeError("Invalid save path");
  return { defaultPath: payload.defaultPath, filters: readFilters({ filters: payload.filters }) };
}
function readBoolean(payload, key) {
  if (!isRecord$1(payload) || typeof payload[key] !== "boolean") throw new TypeError(`Invalid ${key}`);
  return payload[key];
}
function readOptionalBoolean(payload, key) {
  if (!isRecord$1(payload) || payload[key] === void 0) return false;
  if (typeof payload[key] !== "boolean") throw new TypeError(`Invalid ${key}`);
  return payload[key];
}
function readString(payload, key, maximumLength) {
  if (!isRecord$1(payload) || typeof payload[key] !== "string") throw new TypeError(`Invalid ${key}`);
  const value = payload[key].trim();
  if (value.length === 0 || value.length > maximumLength) throw new TypeError(`Invalid ${key}`);
  return value;
}
function readStringAllowEmpty(payload, key, maximumLength) {
  if (!isRecord$1(payload) || typeof payload[key] !== "string" || payload[key].length > maximumLength) throw new TypeError(`Invalid ${key}`);
  return payload[key].trim();
}
function readTrayAction(payload) {
  if (!isRecord$1(payload) || payload.action !== "show" && payload.action !== "reset-position" && payload.action !== "hide" && payload.action !== "quit") {
    throw new TypeError("Invalid tray action");
  }
  return payload.action;
}
function readPetMetrics(payload) {
  if (!isRecord$1(payload) || typeof payload.state !== "string") throw new TypeError("Invalid Pet metrics");
  const numberFields = [
    "fps",
    "averageFrameMs",
    "p95FrameMs",
    "maximumFrameMs",
    "loadTimeMs",
    "windowWidth",
    "windowHeight",
    "canvasWidth",
    "canvasHeight",
    "backingWidth",
    "backingHeight",
    "renderPixelRatio",
    "resizeCount"
  ];
  if (!numberFields.every((field) => typeof payload[field] === "number" && Number.isFinite(payload[field])) || typeof payload.contextLost !== "boolean") throw new TypeError("Invalid Pet metrics");
  return payload;
}
function readTrayHeight(payload) {
  if (!isRecord$1(payload) || typeof payload.height !== "number" || !Number.isSafeInteger(payload.height) || payload.height <= 0) {
    throw new TypeError("Invalid tray height");
  }
  return payload.height;
}
function readPetWindowUpdate(payload) {
  if (!isRecord$1(payload) || payload.anchor !== "top-left" && payload.anchor !== "center") {
    throw new TypeError("Invalid Pet window update");
  }
  for (const field of ["x", "y", "scale"]) {
    const value = payload[field];
    if (value !== void 0 && (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e5)) {
      throw new TypeError(`Invalid Pet window ${field}`);
    }
  }
  const scale = payload.scale;
  if (scale !== void 0 && (typeof scale !== "number" || scale <= 0)) throw new TypeError("Invalid Pet window scale");
  return payload;
}
function toIpcError(error) {
  if (error instanceof TypeError) return ipcError("IPC_INVALID_ARGUMENT", error.message);
  if (error instanceof CoreRemoteError) {
    return { code: error.code, message: error.message, retryable: false, details: error.details };
  }
  if (error instanceof CoreClientError) return ipcError(error.code, error.message, error.code === "REQUEST_TIMEOUT");
  if (error instanceof Error && error.name === "AbortError") return ipcError("IPC_CANCELLED", error.message, true);
  if (error instanceof Error) return ipcError("IPC_REQUEST_FAILED", error.message);
  return ipcError("IPC_REQUEST_FAILED", "Unknown request failure");
}
function ipcError(code, message, retryable = false) {
  return { code, message, retryable };
}
function abortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
function elapsedMs$2(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
function isRecord$1(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readPetLipSyncFrame(value) {
  if (!isRecord$1(value) || value.source !== "tts" && value.source !== "music" || typeof value.level !== "number" || !Number.isFinite(value.level) || value.level < 0 || value.level > 1 || typeof value.active !== "boolean" || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) {
    return null;
  }
  return { source: value.source, level: value.level, active: value.active, timestamp: value.timestamp };
}
function isAllowedLipSyncSource(kind, source) {
  return source === "music" ? kind === "pet" : kind === "pet" || kind === "chat" || kind === "voice-conversation";
}
class ApplicationLifecycle {
  constructor(windows, ipc, events, coreClient2, coreProcess2, petAssets2, petWindows2, tray, systemSettings2, reminders, log) {
    this.windows = windows;
    this.ipc = ipc;
    this.events = events;
    this.coreClient = coreClient2;
    this.coreProcess = coreProcess2;
    this.petAssets = petAssets2;
    this.petWindows = petWindows2;
    this.tray = tray;
    this.systemSettings = systemSettings2;
    this.reminders = reminders;
    this.log = log;
  }
  windows;
  ipc;
  events;
  coreClient;
  coreProcess;
  petAssets;
  petWindows;
  tray;
  systemSettings;
  reminders;
  log;
  cleanupStarted = false;
  cleanupComplete = false;
  async run() {
    const startupStartedAt = performance.now();
    this.log.info("startup", "Application startup began", {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      processId: process.pid
    });
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
    this.registerLifecycleHandlers();
    await app.whenReady();
    this.petAssets.register();
    this.petWindows.install();
    this.tray.install();
    this.ipc.install();
    this.events.start();
    try {
      await this.coreProcess.start();
      await this.coreClient.start();
    } catch (error) {
      this.log.error("startup", "Real Core failed to become ready", error);
    }
    if (this.coreClient.getStatus().state === "ready") {
      try {
        await this.systemSettings.initialize();
      } catch (error) {
        this.log.error("startup", "System settings initialization failed", error);
      }
      this.reminders.start();
    }
    const requestedWindow = this.readStartupWindow();
    const hidePet = process.argv.includes("--hide-pet");
    if (!hidePet) this.petWindows.open();
    await this.systemSettings.applyVisualSettings();
    if (requestedWindow !== void 0) {
      await this.windows.openAndWait(requestedWindow);
      this.log.info("startup", "Window opened from explicit startup argument", { kind: requestedWindow, hidePet });
    }
    if (process.argv.includes("--smoke-test") || process.env.AIMAID_SMOKE_TEST === "1") {
      const requested = Number(process.env.AIMAID_SMOKE_TEST_MS ?? 1e3);
      const delay = Number.isFinite(requested) ? Math.min(3e4, Math.max(1e3, requested)) : 1e3;
      if (delay >= 5e3) {
        setTimeout(() => {
          const controller = new AbortController();
          void this.coreClient.invoke(randomUUID(), { type: "system.stream", payload: { steps: 4, delayMs: 250 } }, controller.signal).catch((error) => this.log.error("smoke-test", "Core PetWindow event test failed", error));
        }, 2500).unref();
      }
      setTimeout(() => app.quit(), delay).unref();
    }
    this.log.info("startup", "Application startup completed", {
      durationMs: elapsedMs$1(startupStartedAt),
      coreState: this.coreClient.getStatus().state,
      requestedWindow: requestedWindow ?? null,
      petVisible: !hidePet
    });
  }
  readStartupWindow(argumentsList = process.argv) {
    if (argumentsList.includes("--show-workbench")) return "main";
    const argument = argumentsList.find((value2) => value2.startsWith("--show-window="));
    const value = argument?.slice("--show-window=".length);
    if (!isWindowKind(value) || value === "pet" || value === "tray-menu" || value === "agent-confirm") return void 0;
    return value;
  }
  registerLifecycleHandlers() {
    app.on("child-process-gone", (_event, details) => {
      this.log.error("process", "Electron child process gone", new Error(`${details.type} exited: ${details.reason}`), {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        serviceName: details.serviceName,
        name: details.name
      });
    });
    app.on("second-instance", (_event, argumentsList) => {
      const requested = this.readStartupWindow(argumentsList);
      if (requested !== void 0) this.windows.open(requested);
      else this.windows.focus("pet");
    });
    app.on("activate", () => {
      if (this.windows.get("pet") === void 0) this.petWindows.open();
      else this.windows.focus("pet");
    });
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });
    app.on("before-quit", (event) => {
      if (this.cleanupComplete) return;
      event.preventDefault();
      if (!this.cleanupStarted) void this.cleanupAndExit();
    });
  }
  async cleanupAndExit() {
    this.cleanupStarted = true;
    this.log.info("lifecycle", "Application cleanup started");
    await this.reminders.stop();
    this.events.stop();
    this.ipc.dispose();
    this.petWindows.dispose();
    this.tray.dispose();
    this.petAssets.dispose();
    this.systemSettings.dispose();
    this.windows.destroyAll();
    try {
      await this.coreClient.stop();
      await this.coreProcess.stop();
    } catch (error) {
      this.log.error("lifecycle", "Core cleanup failed", error);
    } finally {
      this.cleanupComplete = true;
      this.log.info("lifecycle", "Application cleanup complete");
      app.quit();
    }
  }
}
function elapsedMs$1(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
const SENSITIVE_KEY = /(?:^|[_\-.])(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|password|secret|private[_-]?key)(?:$|[_\-.])/iu;
const SENSITIVE_QUERY = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|secret|password)=)[^&#\s]*/giu;
const BEARER_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\-/=]+/giu;
const EMBEDDED_SECRET = /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|cookie|authorization)\s*[:=]\s*)([^\s,;&#]+)/giu;
const MAX_DEPTH = 8;
function write(level, scope, message, data) {
  const record = { timestamp: (/* @__PURE__ */ new Date()).toISOString(), level, scope, message, data: redact(data) };
  const output = JSON.stringify(record);
  if (logFilePath$1 !== void 0) {
    try {
      appendFileSync(logFilePath$1, `${output}
`, "utf8");
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        level: "error",
        scope: "logger",
        message: "Failed to append application log",
        data: basicError(error)
      }));
    }
  }
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}
let logFilePath$1;
function configureFileLogging(logRoot) {
  mkdirSync(logRoot, { recursive: true });
  logFilePath$1 = join(logRoot, "aimaid-desktop.jsonl");
  return logFilePath$1;
}
const logger = {
  debug: (scope, message, data) => write("debug", scope, message, data),
  info: (scope, message, data) => write("info", scope, message, data),
  warn: (scope, message, data) => write("warn", scope, message, data),
  error: (scope, message, error, context) => write("error", scope, message, {
    ...context,
    error: normalizeError(error)
  })
};
function normalizeError(error) {
  if (error instanceof Error) {
    const normalized = { name: error.name, message: error.message, stack: error.stack };
    for (const key of Object.keys(error)) normalized[key] = error[key];
    return normalized;
  }
  if (typeof error === "object" && error !== null) {
    const details = { ...error };
    return { message: typeof details.message === "string" ? details.message : "Non-Error failure details", ...details };
  }
  return { message: String(error) };
}
function redact(value, depth = 0, seen = /* @__PURE__ */ new WeakSet()) {
  if (value === void 0 || value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.description ?? "[SYMBOL]";
  if (typeof value === "function") return `[FUNCTION:${value.name || "anonymous"}]`;
  if (typeof value !== "object") return "[UNKNOWN]";
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? "[REDACTED]" : redact(item, depth + 1, seen);
  }
  return result;
}
function isSensitiveKey(key) {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SENSITIVE_KEY.test(normalized) || /^(?:token|key|secret|password|cookie)$/iu.test(normalized);
}
function redactString(value) {
  return value.replace(SENSITIVE_QUERY, "$1[REDACTED]").replace(BEARER_TOKEN, "$1 [REDACTED]").replace(EMBEDDED_SECRET, "$1[REDACTED]").replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/giu, "$1[REDACTED]@");
}
function basicError(error) {
  return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
}
function configureApplicationPaths() {
  const userRoot = absoluteOverride("AIMAID_USER_ROOT") ?? app.getPath("userData");
  const paths = Object.freeze({
    resourceRoot: absoluteOverride("AIMAID_RESOURCE_ROOT") ?? (app.isPackaged ? join(process.resourcesPath, "resources") : resolve(app.getAppPath(), "resources")),
    dataRoot: absoluteOverride("AIMAID_DATA_ROOT") ?? defaultProjectDataRoot(),
    configRoot: absoluteOverride("AIMAID_CONFIG_ROOT") ?? join(userRoot, "config"),
    cacheRoot: absoluteOverride("AIMAID_CACHE_ROOT") ?? join(userRoot, "cache"),
    logRoot: absoluteOverride("AIMAID_LOG_ROOT") ?? join(userRoot, "logs"),
    sessionRoot: absoluteOverride("AIMAID_SESSION_ROOT") ?? join(app.getPath("temp"), "AIMaid", "electron-session")
  });
  for (const directory of [paths.dataRoot, paths.configRoot, paths.cacheRoot, paths.logRoot, paths.sessionRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  app.setPath("sessionData", paths.sessionRoot);
  app.setAppLogsPath(paths.logRoot);
  process.env.AIMAID_RESOURCE_ROOT = paths.resourceRoot;
  process.env.AIMAID_DATA_ROOT = paths.dataRoot;
  process.env.AIMAID_CONFIG_ROOT = paths.configRoot;
  process.env.AIMAID_CACHE_ROOT = paths.cacheRoot;
  process.env.AIMAID_LOG_ROOT = paths.logRoot;
  return paths;
}
function defaultProjectDataRoot() {
  return app.isPackaged ? resolve(process.resourcesPath, "..", "..", "..", "..", "..", "data") : resolve(app.getAppPath(), "..", "..", "data");
}
function absoluteOverride(name) {
  const value = process.env[name]?.trim();
  if (value === void 0 || value.length === 0) return void 0;
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}
const currentDirectory = dirname(fileURLToPath(import.meta.url));
class WindowFactory {
  constructor(iconPath, log) {
    this.iconPath = iconPath;
    this.log = log;
  }
  iconPath;
  log;
  preloadPath = join(currentDirectory, "../preload/index.cjs");
  productionRendererPath = resolve(currentDirectory, "../renderer/index.html");
  create(definition) {
    const window = new BrowserWindow({
      ...definition.options,
      backgroundColor: definition.options.backgroundColor ?? "#e7e9eb",
      title: `AIMaid - ${definition.id}`,
      icon: this.iconPath,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: definition.id === "douyin-login",
        spellcheck: false,
        backgroundThrottling: false,
        additionalArguments: [`--aimaid-window=${definition.id}`, `--aimaid-version=${app.getVersion()}`]
      }
    });
    this.installNavigationGuards(window, definition.id);
    if (definition.id === "pet") {
      window.webContents.on("console-message", (details) => {
        if (details.level === "warning" || details.level === "error" || /^\[(Live2D|PetRuntime|PetInteraction|Hotkey|ActionTag|Motion|Pointer|Outfit|MusicPlayback)\]/u.test(details.message)) {
          this.log.info("pet-renderer", details.message.slice(0, 2e3), { level: details.level });
        }
      });
    }
    window.webContents.on("render-process-gone", (_event, details) => {
      this.log.error("window", "Renderer process gone", new Error(`Renderer exited: ${details.reason}`), {
        kind: definition.id,
        windowId: window.id,
        webContentsId: window.webContents.id,
        reason: details.reason,
        exitCode: details.exitCode
      });
    });
    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      this.log.error("window", "Renderer failed to load", new Error(errorDescription), {
        kind: definition.id,
        windowId: window.id,
        webContentsId: window.webContents.id,
        errorCode,
        validatedURL,
        isMainFrame
      });
    });
    window.webContents.on("unresponsive", () => this.log.warn("window", "Renderer became unresponsive", {
      kind: definition.id,
      windowId: window.id,
      webContentsId: window.webContents.id
    }));
    window.webContents.on("responsive", () => this.log.info("window", "Renderer recovered responsiveness", {
      kind: definition.id,
      windowId: window.id,
      webContentsId: window.webContents.id
    }));
    void this.load(window, definition.route);
    return window;
  }
  isTrustedPage(url, kind) {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    if (developmentUrl !== void 0) {
      try {
        const expected = new URL(developmentUrl);
        const actual = new URL(url);
        return actual.origin === expected.origin && actual.searchParams.get("window") === kind;
      } catch {
        return false;
      }
    }
    try {
      const actual = new URL(url);
      return actual.protocol === "file:" && fileURLToPath(actual).toLowerCase() === this.productionRendererPath.toLowerCase();
    } catch {
      return false;
    }
  }
  async load(window, route) {
    try {
      const developmentUrl = process.env.ELECTRON_RENDERER_URL;
      if (developmentUrl !== void 0) {
        const url = new URL(developmentUrl);
        url.searchParams.set("window", route);
        await window.loadURL(url.toString());
      } else {
        await window.loadFile(this.productionRendererPath, { query: { window: route } });
      }
    } catch (error) {
      this.log.error("window", `Failed to load ${route}`, error);
    }
  }
  installNavigationGuards(window, kind) {
    window.webContents.on("will-navigate", (event, url) => {
      if (!this.isTrustedPage(url, kind)) {
        event.preventDefault();
        this.log.warn("security", "Blocked window navigation", { kind, url });
      }
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      this.log.warn("security", "Blocked new window request", { kind, url });
      return { action: "deny" };
    });
  }
}
const WINDOW_REGISTRY = {
  main: {
    id: "main",
    route: "main",
    closeBehavior: "destroy",
    options: { width: 1280, height: 820, minWidth: 960, minHeight: 680, frame: false, resizable: true, show: false }
  },
  pet: {
    id: "pet",
    route: "pet",
    closeBehavior: "hide",
    options: {
      width: 560,
      height: 980,
      minWidth: 160,
      minHeight: 160,
      transparent: true,
      backgroundColor: "#00000000",
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      maximizable: false,
      fullscreenable: false,
      show: false
    }
  },
  chat: {
    id: "chat",
    route: "chat",
    closeBehavior: "hide",
    options: {
      width: 300,
      height: 140,
      transparent: true,
      backgroundColor: "#00000000",
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      maximizable: false,
      fullscreenable: false,
      show: false
    }
  },
  settings: {
    id: "settings",
    route: "settings",
    closeBehavior: "hide",
    options: { width: 820, height: 680, minWidth: 720, minHeight: 560, frame: false, resizable: true, show: false }
  },
  status: moduleWindow("status", 1280, 820, 960, 680),
  appearance: moduleWindow("appearance", 1040, 920, 460, 760),
  bitcoin: moduleWindow("bitcoin", 1120, 640, 840, 520),
  timer: {
    id: "timer",
    route: "timer",
    closeBehavior: "hide",
    options: {
      width: 560,
      height: 680,
      minWidth: 520,
      minHeight: 620,
      transparent: true,
      backgroundColor: "#00000000",
      frame: false,
      resizable: true,
      show: false
    }
  },
  video: moduleWindow("video", 1760, 940, 1200, 720),
  "remote-video": moduleWindow("remote-video", 1260, 840, 1040, 720),
  reminders: moduleWindow("reminders", 760, 560, 680, 500),
  notebook: moduleWindow("notebook", 980, 680, 920, 520),
  vault: moduleWindow("vault", 1220, 760, 980, 620),
  scripts: moduleWindow("scripts", 980, 680, 820, 560),
  "voice-conversation": moduleWindow("voice-conversation", 1260, 840, 1040, 720),
  characters: moduleWindow("characters", 1160, 800, 1120, 680),
  "crypto-events": moduleWindow("crypto-events", 920, 640, 720, 480),
  "crypto-provider": moduleWindow("crypto-provider", 640, 520, 520, 420),
  "crypto-chart": moduleWindow("crypto-chart", 1120, 720, 720, 480),
  "video-player": moduleWindow("video-player", 720, 480, 480, 420),
  "video-subtitles": moduleWindow("video-subtitles", 720, 520, 560, 420),
  "remote-site-config": moduleWindow("remote-site-config", 1100, 760, 980, 680),
  "template-card": moduleWindow("template-card", 820, 680, 720, 560),
  "character-editor": moduleWindow("character-editor", 920, 720, 820, 620),
  "agent-confirm": {
    id: "agent-confirm",
    route: "agent-confirm",
    closeBehavior: "hide",
    options: { width: 480, height: 420, frame: false, resizable: false, modal: false, show: false }
  },
  "tray-menu": {
    id: "tray-menu",
    route: "tray-menu",
    closeBehavior: "hide",
    options: {
      width: 240,
      height: 480,
      transparent: true,
      backgroundColor: "#00000000",
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      maximizable: false,
      fullscreenable: false,
      show: false,
      focusable: true
    }
  },
  "douyin-login": moduleWindow("douyin-login", 1180, 820, 920, 680),
  "ui-showcase": moduleWindow("ui-showcase", 1180, 820, 900, 640)
};
function moduleWindow(id, width, height, minWidth, minHeight) {
  return { id, route: id, closeBehavior: "hide", options: { width, height, minWidth, minHeight, frame: false, resizable: true, show: false } };
}
class WindowManager {
  constructor(factory, log) {
    this.factory = factory;
    this.log = log;
  }
  factory;
  log;
  windows = /* @__PURE__ */ new Map();
  destroyingAll = false;
  foreignWindowMoveHandlers;
  trayIconPointerDown = false;
  setForeignWindowMoveHandlers(handlers) {
    this.foreignWindowMoveHandlers = handlers;
  }
  setTrayIconPointerDown(pointerDown) {
    this.trayIconPointerDown = pointerDown;
  }
  open(kind, ownerKind, context = {}) {
    const existing = this.get(kind);
    if (existing !== void 0) {
      this.positionWindow(kind, existing, ownerKind);
      if (kind === "tray-menu") {
        this.log.info("window", "Existing window opened", { kind, windowId: existing.id, ...context });
        return existing;
      }
      if (kind === "pet") existing.showInactive();
      else {
        if (kind === "chat") existing.setAlwaysOnTop(true, "screen-saver");
        existing.show();
        existing.focus();
        if (kind === "chat") existing.moveTop();
      }
      this.log.info("window", "Existing window opened", { kind, windowId: existing.id, ...context });
      return existing;
    }
    const definition = WINDOW_REGISTRY[kind];
    const window = this.factory.create(definition);
    if (kind === "chat") window.setAlwaysOnTop(true, "screen-saver");
    if (kind !== "pet" && kind !== "tray-menu") {
      this.attachForeignWindowMoveGuard(window);
    }
    this.positionWindow(kind, window, ownerKind);
    this.windows.set(kind, window);
    if (kind !== "pet") {
      let shown = false;
      const showLoadedWindow = () => {
        if (shown || window.isDestroyed()) return;
        shown = true;
        window.show();
        window.focus();
        if (kind === "chat") window.moveTop();
      };
      window.once("ready-to-show", showLoadedWindow);
    }
    if (kind === "chat") window.on("blur", () => window.hide());
    if (kind === "tray-menu") window.on("blur", () => {
      if (!this.trayIconPointerDown) window.hide();
    });
    window.on("close", (event) => {
      if (!this.destroyingAll && definition.closeBehavior === "hide") {
        event.preventDefault();
        window.hide();
      }
    });
    window.on("closed", () => {
      this.windows.delete(kind);
      this.log.info("window", "Window destroyed", { kind, windowId: window.id });
    });
    window.on("show", () => this.log.info("window", "Window shown", { kind, windowId: window.id }));
    window.on("hide", () => this.log.info("window", "Window hidden", { kind, windowId: window.id }));
    window.on("focus", () => this.log.debug("window", "Window focused", { kind, windowId: window.id }));
    window.on("blur", () => this.log.debug("window", "Window blurred", { kind, windowId: window.id }));
    window.on("minimize", () => this.log.info("window", "Window minimized", { kind, windowId: window.id }));
    window.on("restore", () => this.log.info("window", "Window restored", { kind, windowId: window.id }));
    this.log.info("window", "Window created", { kind, windowId: window.id, webContentsId: window.webContents.id, ...context });
    return window;
  }
  async openAndWait(kind, ownerKind, context = {}) {
    const window = this.open(kind, ownerKind, context);
    if (kind === "pet" || kind === "tray-menu") return window;
    if (!window.isVisible()) {
      await new Promise((resolve2, reject) => {
        const cleanup = () => {
          window.off("ready-to-show", ready);
          window.webContents.off("did-fail-load", failed);
          window.off("closed", closed);
        };
        const ready = () => {
          cleanup();
          resolve2();
        };
        const failed = (_event, errorCode, errorDescription) => {
          cleanup();
          reject(new Error(`Window ${kind} failed to load (${errorCode}): ${errorDescription}`));
        };
        const closed = () => {
          cleanup();
          reject(new Error(`Window ${kind} closed before it was shown`));
        };
        window.once("ready-to-show", ready);
        window.webContents.once("did-fail-load", failed);
        window.once("closed", closed);
      });
      if (window.isDestroyed()) throw new Error(`Window ${kind} was destroyed before it was shown`);
      window.show();
    }
    if (window.isMinimized()) window.restore();
    window.focus();
    this.log.info("window", "Window open completed", { kind, windowId: window.id, ...context });
    return window;
  }
  show(kind, context = {}) {
    const window = this.open(kind, void 0, context);
    window.show();
    this.log.info("window", "Window show requested", { kind, windowId: window.id, ...context });
  }
  hide(kind, context = {}) {
    const window = this.get(kind);
    window?.hide();
    this.log.info("window", "Window hide requested", { kind, windowId: window?.id ?? null, found: window !== void 0, ...context });
  }
  toggle(kind, ownerKind, context = {}) {
    const existing = this.get(kind);
    if (existing !== void 0 && existing.isVisible()) {
      existing.hide();
      this.log.info("window", "Window toggled hidden", { kind, windowId: existing.id, ...context });
      return false;
    }
    const window = this.open(kind, ownerKind, context);
    this.log.info("window", "Window toggled visible", { kind, windowId: window.id, ...context });
    return true;
  }
  close(kind, context = {}) {
    const window = this.get(kind);
    window?.close();
    this.log.info("window", "Window close requested", { kind, windowId: window?.id ?? null, found: window !== void 0, ...context });
  }
  focus(kind, context = {}) {
    const window = this.get(kind);
    if (window === void 0) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    this.log.info("window", "Window focus requested", { kind, windowId: window.id, ...context });
  }
  minimize(kind, context = {}) {
    const window = this.get(kind);
    window?.minimize();
    this.log.info("window", "Window minimize requested", { kind, windowId: window?.id ?? null, found: window !== void 0, ...context });
  }
  toggleMaximize(kind, context = {}) {
    const window = this.get(kind);
    if (window === void 0) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    this.log.info("window", "Window maximize toggled", { kind, windowId: window.id, maximized: window.isMaximized(), ...context });
    return window.isMaximized();
  }
  get(kind) {
    const window = this.windows.get(kind);
    return window !== void 0 && !window.isDestroyed() ? window : void 0;
  }
  kindFor(contents) {
    for (const [kind, window] of this.windows) {
      if (!window.isDestroyed() && window.webContents.id === contents.id) return kind;
    }
    return void 0;
  }
  isTrusted(contents, frameUrl) {
    const kind = this.kindFor(contents);
    return kind !== void 0 && this.factory.isTrustedPage(frameUrl, kind);
  }
  forEach(callback) {
    for (const [kind, window] of this.windows) {
      if (!window.isDestroyed()) callback(kind, window);
    }
  }
  destroyAll() {
    this.destroyingAll = true;
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.windows.clear();
  }
  attachForeignWindowMoveGuard(window) {
    let moving = false;
    const begin = () => {
      if (moving) return;
      moving = true;
      this.foreignWindowMoveHandlers?.onStart();
    };
    const end = () => {
      if (!moving) return;
      moving = false;
      this.foreignWindowMoveHandlers?.onEnd();
    };
    window.on("will-move", begin);
    window.on("moved", end);
    window.once("closed", end);
  }
  positionWindow(kind, window, ownerKind) {
    if (kind === "pet" || kind === "tray-menu") return;
    const owner = ownerKind === void 0 ? void 0 : this.get(ownerKind);
    if (ownerKind === "pet" && owner !== void 0) return;
    const ownerCentered = owner !== void 0 && OWNER_CENTERED_WINDOWS.has(kind);
    const target = ownerCentered ? owner.getBounds() : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const workArea = ownerCentered ? screen.getDisplayMatching(target).workArea : target;
    const current = window.getBounds();
    const width = Math.min(current.width, workArea.width);
    const height = Math.min(current.height, workArea.height);
    const centered = centerWithin(target, width, height);
    window.setBounds({
      x: Math.max(workArea.x, Math.min(centered.x, workArea.x + workArea.width - width)),
      y: Math.max(workArea.y, Math.min(centered.y, workArea.y + workArea.height - height)),
      width,
      height
    }, false);
  }
}
const OWNER_CENTERED_WINDOWS = /* @__PURE__ */ new Set([
  "characters",
  "character-editor",
  "template-card",
  "notebook",
  "crypto-events",
  "crypto-provider",
  "crypto-chart",
  "video-player",
  "video-subtitles",
  "remote-site-config",
  "douyin-login"
]);
function centerWithin(target, width, height) {
  return {
    x: Math.round(target.x + (target.width - width) / 2),
    y: Math.round(target.y + (target.height - height) / 2)
  };
}
const SCHEME = "aimaid-asset";
const HOST = "pet";
const UI_HOST = "ui";
const NOTEBOOK_ATTACHMENT_HOST = "notebook-attachments";
const ALLOWED_EXTENSIONS = /* @__PURE__ */ new Set([
  ".json",
  ".moc3",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  ".html",
  ".css",
  ".motion3",
  ".exp3",
  ".physics3",
  ".cdi3",
  ".js",
  ".mp4",
  ".mkv",
  ".mov",
  ".avi",
  ".wmv",
  ".flv",
  ".webm",
  ".m4v",
  ".ts",
  ".m2ts",
  ".wav",
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".flac"
]);
class PetAssetService {
  constructor(resourceRoot, uiResourceRoot2, notebookAttachmentRoot, log) {
    this.log = log;
    this.root = realpathSync(resolve(resourceRoot));
    this.uiRoot = realpathSync(resolve(uiResourceRoot2));
    mkdirSync(notebookAttachmentRoot, { recursive: true });
    this.notebookAttachmentRoot = realpathSync(resolve(notebookAttachmentRoot));
  }
  log;
  root;
  uiRoot;
  notebookAttachmentRoot;
  externalFiles = /* @__PURE__ */ new Map();
  motionOutfitParameterIds = /* @__PURE__ */ new Map();
  registered = false;
  register() {
    if (this.registered) return;
    protocol.handle(SCHEME, async (request) => this.handle(request));
    this.registered = true;
  }
  dispose() {
    if (!this.registered) return;
    protocol.unhandle(SCHEME);
    this.registered = false;
  }
  listLive2dRoles() {
    const modelsRoot = join(this.root, "models");
    if (!existsSync(modelsRoot)) return [];
    return readdirSync(modelsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && this.resolveModelFile(join(modelsRoot, entry.name)) !== null).map((entry) => entry.name).sort(naturalCompare$1);
  }
  getManifest(modelId) {
    const roles = this.listLive2dRoles();
    if (!roles.includes(modelId)) throw new Error(`Unknown Live2D role: ${modelId}`);
    const modelFile = this.resolveModelFile(join(this.root, "models", modelId));
    if (modelFile === null) throw new Error(`Live2D model file is missing: ${modelId}`);
    const modelPath = relative(this.root, modelFile).split(sep).map(encodeURIComponent).join("/");
    return {
      modelId,
      modelUrl: `${SCHEME}://${HOST}/${modelPath}`,
      cubismCoreUrl: `${SCHEME}://${HOST}/vendor/live2dcubismcore.min.js`
    };
  }
  resolveModelFile(folder) {
    return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".model3.json")).map((entry) => join(folder, entry.name)).sort(naturalCompare$1)[0] ?? null;
  }
  registerExternalFile(path) {
    const real = realpathSync(resolveExternalMediaPath(path, this.uiRoot));
    if (!ALLOWED_EXTENSIONS.has(extname(real).toLowerCase())) throw new Error("Unsupported pet media file");
    const token = createHash("sha256").update(real.toLowerCase()).digest("hex");
    this.externalFiles.set(token, real);
    return `${SCHEME}://media/${token}`;
  }
  registerNotebookAttachment(path) {
    const real = realpathSync(resolve(path));
    if (!ALLOWED_EXTENSIONS.has(extname(real).toLowerCase())) throw new Error("Unsupported notebook attachment");
    const relativePath = relative(this.notebookAttachmentRoot, real);
    if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) throw new Error("Notebook attachment is outside its root");
    return `${SCHEME}://${NOTEBOOK_ATTACHMENT_HOST}/${relativePath.split(sep).map(encodeURIComponent).join("/")}`;
  }
  async handle(request) {
    try {
      const url = new URL(request.url);
      if ((url.host === "media" || url.host === NOTEBOOK_ATTACHMENT_HOST) && request.method === "GET") {
        if (url.host === NOTEBOOK_ATTACHMENT_HOST) {
          return this.serveRootFile(this.notebookAttachmentRoot, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
        }
        const token = url.pathname.replace(/^\/+/, "");
        const path = this.externalFiles.get(token);
        if (path === void 0 || !existsSync(path)) return new Response("Not found", { status: 404 });
        const range = request.headers.get("range");
        return withCors(await net.fetch(pathToFileURL(path).toString(), range === null ? {} : { headers: { Range: range } }));
      }
      if (url.host === UI_HOST && request.method === "GET") {
        return this.serveRootFile(this.uiRoot, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
      }
      if (url.host !== HOST || request.method !== "GET") return new Response("Not found", { status: 404 });
      const decoded = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      return this.serveRootFile(this.root, decoded);
    } catch (error) {
      this.log.warn("pet-assets", "Rejected asset request", {
        message: error instanceof Error ? error.message : String(error)
      });
      return new Response("Bad request", { status: 400 });
    }
  }
  async serveRootFile(root, decoded) {
    if (!isSafePetAssetPath(decoded)) return new Response("Forbidden", { status: 403 });
    const candidate = resolve(root, decoded);
    if (!existsSync(candidate)) return new Response("Not found", { status: 404 });
    const real = realpathSync(candidate);
    const relativePath = relative(root, real);
    if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
      return new Response("Forbidden", { status: 403 });
    }
    if (root === this.root && real.toLowerCase().endsWith(".model3.json")) {
      const enriched = await enrichLive2DModel(real);
      for (const [motionPath, parameterIds] of enriched.motionOutfitParameterIds) {
        this.motionOutfitParameterIds.set(motionPath, parameterIds);
      }
      this.log.info("pet-assets", "Enriched Live2D model settings", {
        modelPath: real,
        expressions: enriched.expressionCount,
        motionGroups: enriched.motionGroups
      });
      return jsonBufferResponse(enriched.data);
    }
    if (root === this.root && real.toLowerCase().endsWith(".motion3.json")) {
      const protectedParameterIds = this.motionOutfitParameterIds.get(normalizeLocalFileKey(real));
      const transformed = await readMotionWithoutOutfitCurves(real, protectedParameterIds);
      if (transformed.removedCurveCount > 0) {
        this.log.info("pet-assets", "Removed outfit-changing curves from click motion", {
          motionPath: real,
          removed: transformed.removedCurveCount
        });
      }
      return jsonBufferResponse(transformed.data);
    }
    return withCors(await net.fetch(pathToFileURL(real).toString()));
  }
}
async function enrichLive2DModel(modelPath) {
  const raw = await readFile(modelPath, "utf8");
  const model = JSON.parse(raw);
  const modelDir = dirname(modelPath);
  const files = await listFilesRecursively(modelDir);
  const references = model.FileReferences ?? (model.FileReferences = {});
  const expressions = references.Expressions ?? (references.Expressions = []);
  const knownExpressionFiles = new Set(expressions.map((item) => normalizeAssetPath(item.File).toLowerCase()));
  const usedExpressionNames = new Set(expressions.map((item) => item.Name).filter((name) => typeof name === "string"));
  for (const file of files.filter((item) => item.toLowerCase().endsWith(".exp3.json"))) {
    const relativePath = normalizeAssetPath(relative(modelDir, file));
    if (knownExpressionFiles.has(relativePath.toLowerCase())) continue;
    const baseName = basename(file).replace(/\.exp3\.json$/iu, "");
    let name = baseName;
    let suffix = 2;
    while (usedExpressionNames.has(name)) name = `${baseName}_${suffix++}`;
    expressions.push({ Name: name, File: relativePath });
    knownExpressionFiles.add(relativePath.toLowerCase());
    usedExpressionNames.add(name);
  }
  const motions = references.Motions ?? (references.Motions = {});
  const knownMotionFiles = new Set(
    Object.values(motions).flat().map((item) => normalizeAssetPath(item.File).toLowerCase())
  );
  for (const file of files.filter((item) => item.toLowerCase().endsWith(".motion3.json"))) {
    const relativePath = normalizeAssetPath(relative(modelDir, file));
    if (knownMotionFiles.has(relativePath.toLowerCase())) continue;
    const group = classifyMotionGroup(basename(file));
    (motions[group] ?? (motions[group] = [])).push({ File: relativePath });
    knownMotionFiles.add(relativePath.toLowerCase());
  }
  const protectedParameterIds = await collectOutfitParameterIds(modelDir, expressions);
  const motionOutfitParameterIds = /* @__PURE__ */ new Map();
  for (const definition of Object.values(motions).flat()) {
    const motionPath = resolveContainedModelFile(modelDir, definition.File);
    motionOutfitParameterIds.set(normalizeLocalFileKey(motionPath), protectedParameterIds);
  }
  model.AIMaidHotkeys = await readVTubeHotkeys(files);
  return {
    data: Buffer.from(JSON.stringify(model), "utf8"),
    motionOutfitParameterIds,
    expressionCount: expressions.length,
    motionGroups: Object.fromEntries(Object.entries(motions).map(([name, items]) => [name, items.length]))
  };
}
async function readVTubeHotkeys(files) {
  const vtubePath = files.filter((file) => file.toLowerCase().endsWith(".vtube.json")).sort(naturalCompare$1)[0];
  if (vtubePath === void 0) return [];
  const vtube = JSON.parse(await readFile(vtubePath, "utf8"));
  const supportedActions = /* @__PURE__ */ new Set([
    "ToggleExpression",
    "TriggerAnimation",
    "RemoveAllExpressions"
  ]);
  return (vtube.Hotkeys ?? []).flatMap((hotkey) => {
    if (hotkey.IsActive === false || typeof hotkey.Action !== "string" || !supportedActions.has(hotkey.Action)) return [];
    const triggers = [hotkey.Triggers?.Trigger1, hotkey.Triggers?.Trigger2, hotkey.Triggers?.Trigger3].filter((trigger) => typeof trigger === "string" && trigger !== "");
    if (triggers.length === 0) return [];
    return [{
      name: typeof hotkey.Name === "string" ? hotkey.Name : "",
      action: hotkey.Action,
      file: typeof hotkey.File === "string" ? normalizeAssetPath(hotkey.File) : "",
      triggers
    }];
  });
}
async function readMotionWithoutOutfitCurves(motionPath, protectedParameterIds) {
  const raw = await readFile(motionPath, "utf8");
  if (protectedParameterIds === void 0 || protectedParameterIds.size === 0) {
    return { data: Buffer.from(raw, "utf8"), removedCurveCount: 0 };
  }
  const motion = JSON.parse(raw);
  if (!Array.isArray(motion.Curves)) return { data: Buffer.from(raw, "utf8"), removedCurveCount: 0 };
  const before = motion.Curves.length;
  motion.Curves = motion.Curves.filter((curve) => !(curve.Target === "Parameter" && typeof curve.Id === "string" && protectedParameterIds.has(curve.Id)));
  const removedCurveCount = before - motion.Curves.length;
  if (removedCurveCount > 0 && motion.Meta && typeof motion.Meta.CurveCount === "number") {
    motion.Meta.CurveCount = motion.Curves.length;
  }
  return { data: Buffer.from(JSON.stringify(motion), "utf8"), removedCurveCount };
}
async function collectOutfitParameterIds(modelDir, expressions) {
  const ids = /* @__PURE__ */ new Set();
  await Promise.all(expressions.map(async (definition) => {
    if (!isOutfitExpressionName(`${definition.Name ?? ""} ${definition.File}`)) return;
    const expressionPath = resolveContainedModelFile(modelDir, definition.File);
    const expression = JSON.parse(await readFile(expressionPath, "utf8"));
    for (const parameter of expression.Parameters ?? []) {
      if (typeof parameter.Id === "string") ids.add(parameter.Id);
    }
  }));
  return ids;
}
async function listFilesRecursively(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await listFilesRecursively(fullPath));
    else if (entry.isFile()) result.push(fullPath);
  }
  return result;
}
function resolveContainedModelFile(modelDir, assetPath) {
  const resolved = resolve(modelDir, assetPath);
  const relativePath = relative(modelDir, resolved);
  if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new Error(`Live2D model reference is outside its model directory: ${assetPath}`);
  }
  return resolved;
}
function classifyMotionGroup(fileName) {
  const name = fileName.toLowerCase();
  if (/(idle|daiji|待机)/iu.test(name)) return "Idle";
  if (/(blink|eye|face|head|zhaiyan|meiyan|眨眼|美颜|头|脸)/iu.test(name)) return "TapHead";
  if (/(leg|foot|shoe|tixie|腿|脚|鞋)/iu.test(name)) return "TapLeg";
  return "TapBody";
}
function isOutfitExpressionName(label) {
  return /(outfit|costume|wardrobe|full.?set|skin|dress|clothes|clothing|hair|hairstyle|bang|fringe|ponytail|duanfa|panfa|changfa|glasses|eyeglass|yanjing|horn|hat|headwear|earring|jiao|microphone|\bmic\b|handheld|prop|huatong|paizi|shanzi|stocking|sock|shoe|boot|heisi|hexie|\bxie\b|cape|vest|coat|jacket|shirt|skirt|pijian|majia|整套|套装|套裝|衣装|衣裝|服装|服裝|换装|換裝|头发|頭髮|髮型|发型|刘海|劉海|马尾|馬尾|眼镜|眼鏡|帽|角|头饰|頭飾|耳饰|耳飾|麦克风|麥克風|话筒|話筒|扇子|牌子|手持|丝袜|絲襪|袜|襪|鞋|靴|披肩|披风|披風|马甲|馬甲|外套|上衣|裙|衣服)/iu.test(label);
}
function normalizeAssetPath(value) {
  return value.replaceAll("\\", "/");
}
function normalizeLocalFileKey(filePath) {
  return resolve(filePath).replaceAll("\\", "/").toLowerCase();
}
function jsonBufferResponse(data) {
  const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
function naturalCompare$1(a, b) {
  return a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" });
}
function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function isSafePetAssetPath(value) {
  if (value.length === 0 || value.includes("\0") || value.includes("\\") || value.includes(":")) return false;
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return false;
  return ALLOWED_EXTENSIONS.has(extname(value).toLowerCase()) && join(...parts) === value.replaceAll("/", sep);
}
function resolveExternalMediaPath(path, uiRoot) {
  if (isAbsolute(path)) return resolve(path);
  const segments = path.replaceAll("\\", "/").split("/").filter((segment) => segment !== "");
  if (segments[0]?.toLocaleLowerCase() === "assets") segments.shift();
  const candidate = resolve(uiRoot, ...segments);
  const relativePath = relative(uiRoot, candidate);
  if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    throw new Error("Relative media file is outside the UI resource root");
  }
  return candidate;
}
const PET_BASE_WINDOW_WIDTH = 560;
const PET_BASE_WINDOW_HEIGHT = 980;
class PetWindowManager {
  constructor(windows, core, log) {
    this.windows = windows;
    this.core = core;
    this.log = log;
  }
  windows;
  core;
  log;
  static MIN_SCALE = 0.25;
  static MAX_WINDOW_SIZE = 1e5;
  attachedWindowId;
  ready = false;
  ignoreMouseEvents;
  forwardMouseMoves = false;
  foreignWindowMoving = false;
  lastMetricsLogAt = 0;
  lastMetrics = null;
  lastMetricsAt = null;
  installed = false;
  dragState = null;
  install() {
    if (this.installed) return;
    this.installed = true;
    screen.on("display-added", this.handleDisplaysChanged);
    screen.on("display-removed", this.handleDisplaysChanged);
    screen.on("display-metrics-changed", this.handleDisplaysChanged);
    powerMonitor.on("suspend", this.handleSuspend);
    powerMonitor.on("lock-screen", this.handleSuspend);
    powerMonitor.on("resume", this.handleResume);
    powerMonitor.on("unlock-screen", this.handleResume);
  }
  dispose() {
    if (!this.installed) return;
    screen.off("display-added", this.handleDisplaysChanged);
    screen.off("display-removed", this.handleDisplaysChanged);
    screen.off("display-metrics-changed", this.handleDisplaysChanged);
    powerMonitor.off("suspend", this.handleSuspend);
    powerMonitor.off("lock-screen", this.handleSuspend);
    powerMonitor.off("resume", this.handleResume);
    powerMonitor.off("unlock-screen", this.handleResume);
    this.installed = false;
  }
  notifyPresentationChanged() {
    this.sendLifecycle("presentation-changed");
  }
  open(context = {}) {
    const window = this.windows.open("pet", void 0, context);
    if (this.attachedWindowId !== window.id) this.attach(window);
    return window;
  }
  rendererReady(contents) {
    const window = this.requireWindow(contents);
    this.setIgnoreMouseEvents(contents, true);
    this.ready = true;
    void this.revealReadyWindow(window).then(() => {
      this.sendLifecycle("resume");
      this.log.info("pet-window", "Pet renderer ready; virtual desktop window shown", { bounds: window.getBounds() });
    }).catch((error) => {
      this.ready = false;
      if (!window.isDestroyed()) window.hide();
      this.log.error("pet-window", "Failed to reveal the ready pet window", error);
    });
  }
  show(context = {}) {
    const window = this.open(context);
    if (!this.ready) return;
    window.showInactive();
    this.sendLifecycle("resume");
    this.log.info("pet-window", "Pet window show requested", { windowId: window.id, ...context });
  }
  hide(context = {}) {
    this.sendLifecycle("suspend");
    this.windows.hide("pet", context);
    this.ignoreMouseEvents = void 0;
    this.forwardMouseMoves = false;
    this.dragState = null;
    this.log.info("pet-window", "Pet window hide requested", { ...context });
  }
  resetPosition() {
    const window = this.open();
    void this.fitVirtualDesktop(window);
    if (this.ready) window.showInactive();
    this.sendLifecycle("reset-position");
    this.log.info("pet-window", "Pet virtual desktop bounds reset", { bounds: window.getBounds() });
  }
  setIgnoreMouseEvents(contents, ignore) {
    const window = this.requireWindow(contents);
    if (this.foreignWindowMoving) {
      this.applyMouseMode(window, true, false);
      return;
    }
    this.applyMouseMode(window, ignore, ignore);
  }
  suspendHitTestingForForeignWindowMove() {
    if (this.foreignWindowMoving) return;
    this.foreignWindowMoving = true;
    const window = this.windows.get("pet");
    if (window === void 0) return;
    this.applyMouseMode(window, true, false);
  }
  resumeHitTestingAfterForeignWindowMove() {
    if (!this.foreignWindowMoving) return;
    this.foreignWindowMoving = false;
    const window = this.windows.get("pet");
    if (window === void 0) return;
    this.applyMouseMode(window, true, true);
  }
  dragStart(contents) {
    const window = this.requireWindow(contents);
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    this.dragState = {
      startCursorX: cursor.x,
      startCursorY: cursor.y,
      startX: bounds.x,
      startY: bounds.y,
      width: bounds.width,
      height: bounds.height
    };
  }
  dragMove(contents) {
    const window = this.requireWindow(contents);
    if (this.dragState === null) return window.getBounds();
    const cursor = screen.getCursorScreenPoint();
    const bounds = {
      x: Math.round(this.dragState.startX + cursor.x - this.dragState.startCursorX),
      y: Math.round(this.dragState.startY + cursor.y - this.dragState.startCursorY),
      width: this.dragState.width,
      height: this.dragState.height
    };
    window.setBounds(bounds, false);
    return window.getBounds();
  }
  dragEnd(contents) {
    const window = this.requireWindow(contents);
    this.dragState = null;
    return window.getBounds();
  }
  updateWindow(contents, update) {
    const window = this.requireWindow(contents);
    this.dragState = null;
    const current = window.getBounds();
    const scale = update.scale === void 0 ? current.width / PET_BASE_WINDOW_WIDTH : Math.max(PetWindowManager.MIN_SCALE, update.scale);
    const width = Math.min(PetWindowManager.MAX_WINDOW_SIZE, Math.max(1, Math.round(PET_BASE_WINDOW_WIDTH * scale)));
    const height = Math.min(PetWindowManager.MAX_WINDOW_SIZE, Math.max(1, Math.round(PET_BASE_WINDOW_HEIGHT * scale)));
    const x = update.x ?? (update.anchor === "center" ? Math.round(current.x + (current.width - width) / 2) : current.x);
    const y = update.y ?? (update.anchor === "center" ? Math.round(current.y + (current.height - height) / 2) : current.y);
    const bounds = { x: Math.round(x), y: Math.round(y), width, height };
    window.setBounds(bounds, false);
    return window.getBounds();
  }
  reportMetrics(contents, metrics) {
    this.requireWindow(contents);
    const now = Date.now();
    this.lastMetrics = metrics;
    this.lastMetricsAt = now;
    if (now - this.lastMetricsLogAt < 1e4) return;
    this.lastMetricsLogAt = now;
    this.log.info("pet-performance", "Live2D metrics", { ...metrics });
  }
  runtimeStatus() {
    return { rendererReady: this.ready, metrics: this.lastMetrics, updatedAt: this.lastMetricsAt };
  }
  attach(window) {
    this.attachedWindowId = window.id;
    this.ready = false;
    this.ignoreMouseEvents = void 0;
    this.forwardMouseMoves = false;
    window.setMaximumSize(PetWindowManager.MAX_WINDOW_SIZE, PetWindowManager.MAX_WINDOW_SIZE);
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.webContents.on("render-process-gone", () => {
      this.ready = false;
      this.lastMetrics = null;
      this.lastMetricsAt = null;
      this.ignoreMouseEvents = void 0;
      this.forwardMouseMoves = false;
      if (!window.isDestroyed()) window.hide();
    });
    window.on("will-resize", (_event, newBounds) => {
      if (this.dragState === null) return;
      newBounds.width = this.dragState.width;
      newBounds.height = this.dragState.height;
    });
    window.once("closed", () => {
      this.attachedWindowId = void 0;
      this.ready = false;
      this.lastMetrics = null;
      this.lastMetricsAt = null;
      this.ignoreMouseEvents = void 0;
      this.forwardMouseMoves = false;
      this.dragState = null;
    });
  }
  applyMouseMode(window, ignore, forward) {
    const nextForward = ignore && forward;
    if (this.ignoreMouseEvents === ignore && this.forwardMouseMoves === nextForward) {
      return;
    }
    window.setIgnoreMouseEvents(
      ignore,
      nextForward ? { forward: true } : void 0
    );
    this.ignoreMouseEvents = ignore;
    this.forwardMouseMoves = nextForward;
  }
  async fitVirtualDesktop(window) {
    const windowHandle = readWindowHandle(window);
    const bounds = await this.core.invoke(randomUUID(), {
      type: "system.window.fit_virtual_desktop",
      payload: { windowHandle }
    }, new AbortController().signal);
    this.log.info("pet-window", "Pet window fitted to Windows virtual desktop", { bounds, electronBounds: window.getBounds() });
  }
  async revealReadyWindow(window) {
    window.setOpacity(0);
    await this.fitVirtualDesktop(window);
    if (window.isDestroyed()) throw new Error("Pet window was destroyed before its first visible frame");
    window.showInactive();
    await window.webContents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    );
    if (window.isDestroyed()) throw new Error("Pet window was destroyed before its first visible frame");
    window.setOpacity(1);
  }
  async positionWindowAtItem(targetWindow) {
    const window = this.windows.get("pet");
    if (window === void 0 || window.isDestroyed()) throw new Error("PetWindow is unavailable");
    if (targetWindow.isDestroyed()) throw new Error("Target window is unavailable");
    const value = await window.webContents.executeJavaScript(`(() => {
      const item = document.querySelector('.ui-pet-item');
      if (!(item instanceof HTMLElement)) throw new Error('PET item is unavailable');
      const bounds = item.getBoundingClientRect();
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      };
    })()`);
    const local = readClientAnchor(value);
    const placement = await this.core.invoke(randomUUID(), {
      type: "system.window.center_on_client_rect",
      payload: {
        petWindowHandle: readWindowHandle(window),
        targetWindowHandle: readWindowHandle(targetWindow),
        ...local
      }
    }, new AbortController().signal);
    const result = readPlacement(placement);
    this.log.info("pet-window", "Window positioned from PET item in one Win32 request", { local, ...result });
  }
  handleDisplaysChanged = () => {
    const window = this.windows.get("pet");
    if (window !== void 0 && !window.isDestroyed()) void this.fitVirtualDesktop(window);
    this.sendLifecycle("display-changed");
  };
  handleSuspend = () => this.sendLifecycle("suspend");
  handleResume = () => this.sendLifecycle("resume");
  sendLifecycle(type) {
    const window = this.windows.get("pet");
    if (window === void 0 || window.webContents.isDestroyed()) return;
    const display = screen.getDisplayMatching(window.getBounds());
    const event = { type, scaleFactor: display.scaleFactor, timestamp: Date.now() };
    window.webContents.send(IPC_CHANNELS.petLifecycle, event);
  }
  requireWindow(contents) {
    if (this.windows.kindFor(contents) !== "pet") throw new Error("Only PetWindow may perform this operation");
    const window = this.windows.get("pet");
    if (window === void 0) throw new Error("PetWindow is unavailable");
    return window;
  }
}
function readWindowHandle(window) {
  const handle = window.getNativeWindowHandle();
  return (handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
}
function readClientAnchor(value) {
  if (!isRecord(value)) throw new TypeError("Invalid PET item anchor");
  const { x, y, width, height, viewportWidth, viewportHeight } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isPositiveFiniteNumber(width) || !isPositiveFiniteNumber(height) || !isPositiveFiniteNumber(viewportWidth) || !isPositiveFiniteNumber(viewportHeight)) throw new TypeError("Invalid PET item anchor");
  return { x, y, width, height, viewportWidth, viewportHeight };
}
function readRectangle(value) {
  if (!isRecord(value)) throw new TypeError("Invalid Win32 rectangle");
  const { x, y, width, height } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isPositiveFiniteNumber(width) || !isPositiveFiniteNumber(height)) throw new TypeError("Invalid Win32 rectangle");
  return { x, y, width, height };
}
function readPlacement(value) {
  if (!isRecord(value)) throw new TypeError("Invalid Win32 window placement");
  return { anchorBounds: readRectangle(value.anchorBounds), windowBounds: readRectangle(value.windowBounds) };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isPositiveFiniteNumber(value) {
  return isFiniteNumber(value) && value > 0;
}
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);
const IMAGE_INTERVALS = [5, 10, 20, 40, 60, 180, 300, 600];
const PNG_FPS_VALUES = [30, 40, 50, 60, 70, 80];
class PetPresentationService {
  constructor(statePath, assets, log, bundledImageRoot, bundledPngRoot) {
    this.statePath = statePath;
    this.assets = assets;
    this.log = log;
    this.bundledImageRoot = bundledImageRoot;
    this.bundledPngRoot = bundledPngRoot;
    this.state = this.readState();
  }
  statePath;
  assets;
  log;
  bundledImageRoot;
  bundledPngRoot;
  state;
  snapshotLogged = false;
  mediaCache = /* @__PURE__ */ new Map();
  currentMode() {
    return this.state.mode;
  }
  snapshot() {
    if (!isDirectory(this.state.pngRoot)) this.state.pngRoot = this.bundledPngRoot;
    if (!isDirectory(this.state.imageRoot)) this.state.imageRoot = this.bundledImageRoot;
    this.state.imageFolder = this.resolveImageFolder(this.state.imageRoot, this.state.imageFolder);
    const images = this.listMedia(this.state.imageFolder);
    const roles = this.listDirectories(this.state.pngRoot);
    if (!roles.includes(this.state.pngRole)) this.state.pngRole = roles[0] ?? "";
    const roleFolder = this.state.pngRole === "" ? "" : join(this.state.pngRoot, this.state.pngRole);
    const frames = this.state.mode === "png-sequence" ? this.listMedia(roleFolder) : [];
    const live2dRoles = this.assets.listLive2dRoles();
    if (!live2dRoles.includes(this.state.live2dRole)) this.state.live2dRole = live2dRoles[0] ?? "";
    const imageIndex = images.length === 0 ? 0 : Math.min(Math.max(0, this.state.imageIndex), images.length - 1);
    this.state.imageIndex = imageIndex;
    if (!this.snapshotLogged) {
      this.snapshotLogged = true;
      this.log.info("pet-presentation", "Bundled presentation assets resolved", {
        imageFolder: this.state.imageFolder,
        imageCount: images.length,
        pngRoot: this.state.pngRoot,
        pngRole: this.state.pngRole,
        pngFrameCount: frames.length
      });
    }
    return {
      mode: this.state.mode,
      paused: this.state.paused,
      imageRoot: this.state.imageRoot,
      imageFolder: this.state.imageFolder,
      imageFolderName: this.imageFolderName(this.state.imageFolder),
      imageIntervalSeconds: IMAGE_INTERVALS[this.state.imageIntervalIndex] ?? IMAGE_INTERVALS[1],
      currentImage: images[imageIndex] ?? null,
      pngRoot: this.state.pngRoot,
      pngRole: this.state.pngRole,
      pngSourceFps: this.readPngSourceFps(roleFolder),
      pngFps: this.state.pngFps,
      pngCarousel: this.state.pngCarousel,
      pngFrames: frames,
      pngRoles: roles,
      live2dRole: this.state.live2dRole,
      live2dRoles
    };
  }
  async execute(action, parent) {
    await this.executeAction(action, parent);
    return this.snapshot();
  }
  async executeAction(action, parent) {
    switch (action) {
      case "toggle-pause":
        this.state.paused = !this.state.paused;
        break;
      case "cycle-mode":
        this.state.mode = nextMode(this.state.mode);
        break;
      case "next-image":
        this.nextImage();
        break;
      case "cycle-image-interval":
        this.state.imageIntervalIndex = (this.state.imageIntervalIndex + 1) % IMAGE_INTERVALS.length;
        break;
      case "choose-image-folder":
        await this.chooseImageFolder(parent);
        break;
      case "cycle-image-folder":
        await this.cycleImageFolder(parent);
        break;
      case "cycle-png-fps":
        this.state.pngFps = nextValue(PNG_FPS_VALUES, this.state.pngFps);
        break;
      case "cycle-png-role":
        this.cyclePngRole();
        break;
      case "toggle-png-carousel":
        this.state.pngCarousel = !this.state.pngCarousel;
        break;
      case "switch-live2d-role":
        this.cycleLive2dRole();
        break;
    }
    this.persist();
  }
  executeHotkey(action) {
    if (action === "cycle-mode-reverse") {
      this.state.mode = previousMode(this.state.mode);
    } else if (this.state.mode === "image") {
      const count = this.listFiles(this.state.imageFolder).length;
      this.state.imageIndex = count === 0 ? 0 : (this.state.imageIndex - 1 + count) % count;
    } else if (this.state.mode === "png-sequence") {
      const roles = this.listDirectories(this.state.pngRoot);
      const index = roles.indexOf(this.state.pngRole);
      this.state.pngRole = roles.length === 0 ? "" : roles[(index - 1 + roles.length) % roles.length] ?? "";
    } else {
      const roles = this.snapshot().live2dRoles;
      const index = roles.indexOf(this.state.live2dRole);
      this.state.live2dRole = roles.length === 0 ? "" : roles[(index - 1 + roles.length) % roles.length] ?? "";
    }
    this.persist();
  }
  nextImage() {
    const count = this.listFiles(this.state.imageFolder).length;
    this.state.imageIndex = count === 0 ? 0 : (this.state.imageIndex + 1) % count;
  }
  cyclePngRole() {
    const roles = this.listDirectories(this.state.pngRoot);
    if (roles.length === 0) {
      this.state.pngRole = "";
      return;
    }
    const index = roles.indexOf(this.state.pngRole);
    this.state.pngRole = roles[(index + 1 + roles.length) % roles.length] ?? "";
  }
  cycleLive2dRole() {
    const roles = this.snapshot().live2dRoles;
    if (roles.length === 0) {
      this.state.live2dRole = "";
      return;
    }
    const index = roles.indexOf(this.state.live2dRole);
    this.state.live2dRole = roles[(index + 1 + roles.length) % roles.length] ?? "";
  }
  async chooseImageFolder(parent) {
    const options = {
      title: "选择图片文件夹",
      properties: ["openDirectory"]
    };
    if (existsSync(this.state.imageRoot)) options.defaultPath = this.state.imageRoot;
    const result = await dialog.showOpenDialog(parent, options);
    if (!result.canceled && result.filePaths[0] !== void 0) {
      this.state.imageRoot = resolve(result.filePaths[0]);
      this.state.imageFolder = this.resolveImageFolder(this.state.imageRoot);
      this.state.imageIndex = 0;
    }
  }
  async cycleImageFolder(parent) {
    const folders = this.listImageFolders(this.state.imageRoot);
    if (folders.length === 0) {
      await this.chooseImageFolder(parent);
      return;
    }
    if (folders.length === 1) {
      this.nextImage();
      return;
    }
    const current = folders.findIndex((folder) => samePath(folder, this.state.imageFolder));
    this.state.imageFolder = folders[(current + 1 + folders.length) % folders.length];
    this.state.imageIndex = 0;
  }
  listMedia(folder) {
    if (folder === "" || !existsSync(folder)) return [];
    const modifiedAtMs = statSync(folder).mtimeMs;
    const cached = this.mediaCache.get(folder);
    if (cached?.modifiedAtMs === modifiedAtMs) return cached.items;
    const items = this.listFiles(folder).map((path) => ({ name: basename(path), url: this.assets.registerExternalFile(path) }));
    this.mediaCache.set(folder, { modifiedAtMs, items });
    return items;
  }
  listFiles(folder) {
    if (folder === "" || !existsSync(folder) || !statSync(folder).isDirectory()) return [];
    return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())).map((entry) => join(folder, entry.name)).sort(naturalCompare);
  }
  listDirectories(folder) {
    if (folder === "" || !existsSync(folder) || !statSync(folder).isDirectory()) return [];
    return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(naturalCompare);
  }
  listImageFolders(root) {
    if (!isDirectory(root)) return [];
    const folders = this.listDirectories(root).map((name) => join(root, name)).filter((folder) => this.listFiles(folder).length > 0);
    if (folders.length > 0) return folders;
    return this.listFiles(root).length > 0 ? [root] : [];
  }
  resolveImageFolder(root, preferredFolder) {
    const folders = this.listImageFolders(root);
    const preferred = folders.find((folder) => preferredFolder !== void 0 && samePath(folder, preferredFolder)) ?? folders.find((folder) => this.imageFolderName(folder).localeCompare("扶她", "zh-CN", { sensitivity: "base" }) === 0);
    return preferred ?? folders[0] ?? root;
  }
  imageFolderName(folder) {
    if (samePath(folder, this.bundledImageRoot)) return "扶她";
    return basename(folder) || "自定义";
  }
  readPngSourceFps(roleFolder) {
    if (roleFolder === "") return this.state.pngFps;
    try {
      const manifestPath = join(roleFolder, "manifest.json");
      if (!existsSync(manifestPath)) return this.state.pngFps;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return typeof manifest.fps === "number" && Number.isFinite(manifest.fps) ? Math.min(120, Math.max(1, manifest.fps)) : this.state.pngFps;
    } catch (error) {
      this.log.warn("pet-presentation", "Failed to read PNG sequence manifest", { roleFolder, message: String(error) });
      return this.state.pngFps;
    }
  }
  readState() {
    const defaults = {
      mode: "png-sequence",
      paused: false,
      imageRoot: process.env.AIMAID_IMAGE_TILES_ROOT?.trim() || this.bundledImageRoot,
      imageFolder: process.env.AIMAID_IMAGE_TILES_ROOT?.trim() || this.bundledImageRoot,
      imageIndex: 0,
      imageIntervalIndex: 1,
      pngRoot: process.env.AIMAID_PNG_SEQUENCE_ROOT?.trim() || this.bundledPngRoot,
      pngRole: "xinxin",
      pngFps: 30,
      pngCarousel: false,
      live2dRole: "changli"
    };
    try {
      if (!existsSync(this.statePath)) return defaults;
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
      const imageRoot = typeof parsed.imageRoot === "string" && parsed.imageRoot.trim() !== "" ? parsed.imageRoot : this.inferLegacyImageRoot(parsed.imageFolder, defaults.imageRoot);
      return { ...defaults, ...parsed, imageRoot, mode: isMode(parsed.mode) ? parsed.mode : defaults.mode };
    } catch (error) {
      this.log.warn("pet-presentation", "Failed to read presentation state", { message: String(error) });
      return defaults;
    }
  }
  persist() {
    try {
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
    } catch (error) {
      this.log.warn("pet-presentation", "Failed to persist presentation state", { message: String(error) });
    }
  }
  inferLegacyImageRoot(imageFolder, fallbackRoot) {
    if (imageFolder === void 0 || imageFolder.trim() === "") return fallbackRoot;
    const bundled = resolve(this.bundledImageRoot);
    const selected = resolve(imageFolder);
    return selected === bundled || selected.startsWith(`${bundled}\\`) ? bundled : selected;
  }
}
function nextMode(mode) {
  return mode === "image" ? "png-sequence" : mode === "png-sequence" ? "live2d" : "image";
}
function previousMode(mode) {
  return mode === "image" ? "live2d" : mode === "live2d" ? "png-sequence" : "image";
}
function nextValue(values, current) {
  const index = values.indexOf(current);
  return values[(index + 1 + values.length) % values.length];
}
function isMode(value) {
  return value === "image" || value === "png-sequence" || value === "live2d";
}
function naturalCompare(a, b) {
  return a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" });
}
function isDirectory(path) {
  return path !== "" && existsSync(path) && statSync(path).isDirectory();
}
function samePath(left, right) {
  return resolve(left).localeCompare(resolve(right), void 0, { sensitivity: "accent" }) === 0;
}
class TrayController {
  constructor(windows, iconPath, log) {
    this.windows = windows;
    this.iconPath = iconPath;
    this.log = log;
  }
  windows;
  iconPath;
  log;
  tray;
  install() {
    if (this.tray !== void 0) return;
    const image = nativeImage.createFromPath(this.iconPath);
    this.tray = new Tray(image);
    this.tray.setToolTip("AIMaid");
    this.tray.on("click", this.showMenu);
    this.tray.on("right-click", this.showMenu);
    this.tray.on("mouse-down", this.handleMouseDown);
    this.tray.on("mouse-up", this.handleMouseUp);
    this.log.info("tray", "Tray entry installed");
  }
  dispose() {
    this.tray?.off("click", this.showMenu);
    this.tray?.off("right-click", this.showMenu);
    this.tray?.off("mouse-down", this.handleMouseDown);
    this.tray?.off("mouse-up", this.handleMouseUp);
    this.windows.setTrayIconPointerDown(false);
    this.tray?.destroy();
    this.tray = void 0;
  }
  handleMouseDown = () => this.windows.setTrayIconPointerDown(true);
  handleMouseUp = () => this.windows.setTrayIconPointerDown(false);
  showMenu = () => {
    const existingMenu = this.windows.get("tray-menu");
    if (existingMenu?.isVisible()) {
      if (!existingMenu.isFocused()) existingMenu.focus();
      return;
    }
    const point = screen.getCursorScreenPoint();
    const work = screen.getDisplayNearestPoint(point).workArea;
    const menu = existingMenu ?? this.windows.open("tray-menu");
    const bounds = menu.getBounds();
    const gap = 8;
    let x = Math.min(Math.max(point.x - bounds.width + gap, work.x), work.x + work.width - bounds.width);
    let y = point.y - bounds.height - gap;
    if (y < work.y) y = Math.min(point.y + gap, work.y + work.height - bounds.height);
    x = Math.round(x);
    y = Math.round(Math.max(work.y, y));
    menu.setBounds({ ...bounds, x, y }, false);
    if (existingMenu !== void 0) {
      menu.show();
      menu.focus();
    }
  };
}
class DouyinSessionService {
  metadataPath;
  constructor(configRoot) {
    this.metadataPath = join(configRoot, "douyin-profile-metadata.json");
  }
  async saveMetadata() {
    const metadata = await this.inspect();
    await mkdir(dirname(this.metadataPath), { recursive: true });
    await writeFile(this.metadataPath, JSON.stringify(metadata, null, 2), "utf8");
    return metadata;
  }
  async inspect() {
    const cookies = await session.fromPartition("persist:aimaid-douyin").cookies.get({ url: "https://www.douyin.com/" });
    const names = new Set(cookies.map((cookie) => cookie.name.toLowerCase()));
    const metadata = {
      cookieCount: cookies.length,
      hasSession: names.has("sessionid") || names.has("sessionid_ss"),
      hasTtwid: names.has("ttwid"),
      hasMsToken: names.has("mstoken"),
      savedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return metadata;
  }
  async clear() {
    await session.fromPartition("persist:aimaid-douyin").clearStorageData();
    await rm(this.metadataPath, { force: true });
  }
}
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp"]);
class NotebookAttachmentService {
  constructor(dataRoot, assets) {
    this.assets = assets;
    this.root = resolve(dataRoot, "notebook", "attachments");
  }
  assets;
  root;
  async importFile(sourcePath) {
    const source = resolve(sourcePath);
    const extension = validateExtension(source);
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) throw new TypeError("所选路径不是文件。");
    if (sourceStat.size > MAX_IMAGE_BYTES) throw new TypeError("图片不能超过 25 MB。");
    return this.store(extension, basename(source), async (destination) => copyFile(source, destination));
  }
  async importData(name, dataUrl) {
    const match = /^data:image\/(png|jpeg|jpg|bmp|gif|webp);base64,([a-z0-9+/=]+)$/iu.exec(dataUrl);
    if (match === null) throw new TypeError("图片数据格式不受支持。");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > MAX_IMAGE_BYTES) throw new TypeError("图片不能超过 25 MB。");
    const extension = validateExtension(name.length > 0 ? name : `clipboard.${match[1]}`);
    return this.store(extension, name.length > 0 ? basename(name) : `clipboard${extension}`, async (destination) => writeFile(destination, bytes));
  }
  async action(action, storedPath, parent) {
    const fullPath = this.resolveStoredPath(storedPath);
    await stat(fullPath);
    if (action === "copy") {
      const image = nativeImage.createFromBuffer(await readFile(fullPath));
      if (image.isEmpty()) throw new TypeError("图片读取失败。");
      clipboard.writeImage(image);
      return;
    }
    if (action === "openLocation") {
      shell.showItemInFolder(fullPath);
      return;
    }
    const options = { defaultPath: basename(fullPath), filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "bmp", "gif", "webp"] }, { name: "所有文件", extensions: ["*"] }] };
    const result = parent === void 0 ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(parent, options);
    if (!result.canceled && result.filePath !== void 0) await copyFile(fullPath, result.filePath);
  }
  async store(extension, originalName, write2) {
    const now = /* @__PURE__ */ new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const fileName = `${randomUUID().replaceAll("-", "")}${extension}`;
    const directory = join(this.root, year, month);
    const destination = join(directory, fileName);
    await mkdir(directory, { recursive: true });
    await write2(destination);
    const storedPath = join("notebook", "attachments", year, month, fileName);
    return { path: storedPath, url: this.assets.registerNotebookAttachment(destination), name: originalName };
  }
  resolveStoredPath(storedPath) {
    const normalized = storedPath.replaceAll("/", sep);
    const prefix = join("notebook", "attachments") + sep;
    if (!normalized.toLowerCase().startsWith(prefix.toLowerCase())) throw new TypeError("无效的笔记附件路径。");
    const candidate = resolve(this.root, normalized.slice(prefix.length));
    const relativePath = relative(this.root, candidate);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) throw new TypeError("无效的笔记附件路径。");
    return candidate;
  }
}
function validateExtension(path) {
  const extension = extname(path).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new TypeError("图片格式不受支持。");
  return extension;
}
const HOTKEY_ACTIONS = [
  { action: "open-chat", label: "聊天输入", settingKey: "hotkey_open_chat", defaultGesture: "Ctrl+Shift+F", target: "chat" },
  { action: "open-workbench", label: "工作台", settingKey: "hotkey_open_workbench", defaultGesture: "", target: "main" },
  { action: "open-character-manager", label: "角色管理", settingKey: "hotkey_open_character_manager", defaultGesture: "", target: "characters" },
  { action: "open-notebook", label: "记事本", settingKey: "hotkey_open_notebook", defaultGesture: "Ctrl+Shift+R", target: "notebook" },
  { action: "open-status", label: "状态面板", settingKey: "hotkey_open_status", defaultGesture: "Ctrl+Shift+T", target: "status" },
  { action: "open-system-settings", label: "系统设置", settingKey: "hotkey_open_system_settings", defaultGesture: "Ctrl+Shift+G", target: "settings" },
  { action: "open-appearance-settings", label: "外观设置", settingKey: "hotkey_open_appearance_settings", defaultGesture: "", target: "appearance" },
  { action: "open-timer", label: "计时器", settingKey: "hotkey_open_timer", defaultGesture: "", target: "timer" },
  { action: "open-reminders", label: "提醒事项", settingKey: "hotkey_open_reminders", defaultGesture: "", target: "reminders" },
  { action: "open-vault", label: "密码库", settingKey: "hotkey_open_vault", defaultGesture: "Ctrl+Shift+P", target: "vault" },
  { action: "open-video-library", label: "视频库", settingKey: "hotkey_open_video_library", defaultGesture: "Ctrl+Shift+V", target: "video" },
  { action: "open-remote-video-center", label: "远程视频中心", settingKey: "hotkey_open_remote_video_center", defaultGesture: "Ctrl+Shift+Y", target: "remote-video" },
  { action: "open-voice-conversation-center", label: "角色对话中心", settingKey: "hotkey_open_voice_conversation_center", defaultGesture: "Ctrl+Shift+C", target: "voice-conversation" },
  { action: "open-command-manager", label: "快捷脚本", settingKey: "hotkey_open_command_manager", defaultGesture: "", target: "scripts" },
  { action: "open-bitcoin-market", label: "BTC 行情", settingKey: "hotkey_open_bitcoin_market", defaultGesture: "Ctrl+Shift+B", target: "bitcoin" },
  { action: "cycle-display-mode", label: "切换显示模式", settingKey: "hotkey_cycle_display_mode", defaultGesture: "Ctrl+Right" },
  { action: "cycle-display-mode-reverse", label: "反向切换显示模式", settingKey: "hotkey_cycle_display_mode_reverse", defaultGesture: "Ctrl+Left" },
  { action: "play-next", label: "播放下一个", settingKey: "hotkey_play_next", defaultGesture: "Ctrl+Down" },
  { action: "play-previous", label: "播放上一个", settingKey: "hotkey_play_previous", defaultGesture: "Ctrl+Up" }
];
function isHotkeyAction(value) {
  return typeof value === "string" && HOTKEY_ACTIONS.some((item) => item.action === value);
}
class SystemSettingsService {
  constructor(windows, petWindows2, presentation, core, log) {
    this.windows = windows;
    this.petWindows = petWindows2;
    this.presentation = presentation;
    this.core = core;
    this.log = log;
  }
  windows;
  petWindows;
  presentation;
  core;
  log;
  registered = /* @__PURE__ */ new Map();
  values = /* @__PURE__ */ new Map();
  bubbleCssKey;
  async initialize() {
    await this.reload();
    for (const definition of HOTKEY_ACTIONS) {
      const gesture = this.values.get(definition.settingKey) ?? definition.defaultGesture;
      if (gesture !== "") this.tryRegister(definition.action, gesture);
    }
  }
  async getSnapshot() {
    await this.reload();
    const login = app.getLoginItemSettings();
    return {
      autoStartEnabled: login.openAtLogin,
      hotkeys: HOTKEY_ACTIONS.map((definition) => {
        const gesture = this.values.get(definition.settingKey) ?? definition.defaultGesture;
        return {
          action: definition.action,
          label: definition.label,
          gesture,
          registered: gesture === "" || this.registered.get(definition.action) === toAccelerator(gesture)
        };
      })
    };
  }
  async setAutoStart(enabled) {
    const previous = app.getLoginItemSettings().openAtLogin;
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false });
    try {
      await this.saveCore({ start_with_windows: String(enabled) });
    } catch (error) {
      app.setLoginItemSettings({ openAtLogin: previous, openAsHidden: false });
      throw error;
    }
    return this.getSnapshot();
  }
  async setHotkey(actionValue, gestureValue) {
    if (!isHotkeyAction(actionValue) || typeof gestureValue !== "string") throw new TypeError("快捷键参数无效。");
    const gesture = normalizeGesture(gestureValue);
    const definition = HOTKEY_ACTIONS.find((item) => item.action === actionValue);
    const duplicate = HOTKEY_ACTIONS.find((item) => item.action !== actionValue && normalizeGesture(this.values.get(item.settingKey) ?? item.defaultGesture).toLocaleLowerCase() === gesture.toLocaleLowerCase() && gesture !== "");
    if (duplicate !== void 0) throw new Error(`按键组合“${gesture}”已被“${duplicate.label}”占用。`);
    const previous = this.registered.get(actionValue);
    if (previous !== void 0) globalShortcut.unregister(previous);
    this.registered.delete(actionValue);
    if (gesture !== "" && !this.tryRegister(actionValue, gesture)) {
      if (previous !== void 0) this.tryRegister(actionValue, previous);
      throw new Error(`无法注册全局快捷键“${gesture}”，它可能已被其他应用占用。`);
    }
    try {
      await this.saveCore({ [definition.settingKey]: gesture });
      this.values.set(definition.settingKey, gesture);
    } catch (error) {
      const current = this.registered.get(actionValue);
      if (current !== void 0) globalShortcut.unregister(current);
      this.registered.delete(actionValue);
      if (previous !== void 0) this.tryRegister(actionValue, previous);
      throw error;
    }
    return this.getSnapshot();
  }
  async setBubbleStyle(value) {
    if (!["", "normal", "soft", "lively", "close"].includes(value)) throw new TypeError("气泡主题值无效。");
    await this.saveCore({ comic_bubble_style: value });
    this.values.set("comic_bubble_style", value);
    await this.applyBubbleStyle(value);
    return { style: value };
  }
  async applyVisualSettings() {
    await this.applyBubbleStyle(this.values.get("comic_bubble_style") ?? "");
  }
  dispose() {
    for (const accelerator of this.registered.values()) globalShortcut.unregister(accelerator);
    this.registered.clear();
  }
  async applyBubbleStyle(style) {
    const pet = this.windows.get("pet");
    if (pet === void 0) return;
    if (this.bubbleCssKey !== void 0) {
      await pet.webContents.removeInsertedCSS(this.bubbleCssKey);
      this.bubbleCssKey = void 0;
    }
    const css = bubbleStyleCss(style);
    if (css !== "") this.bubbleCssKey = await pet.webContents.insertCSS(css, { cssOrigin: "author" });
  }
  tryRegister(action, gesture) {
    const accelerator = toAccelerator(gesture);
    const registered = globalShortcut.register(accelerator, () => {
      void this.execute(action);
    });
    if (registered) this.registered.set(action, accelerator);
    else this.log.warn("hotkey", "Failed to register configured hotkey", { action, accelerator });
    return registered;
  }
  async execute(action) {
    const definition = HOTKEY_ACTIONS.find((item) => item.action === action);
    if ("target" in definition && definition.target !== void 0) {
      const shown = this.windows.toggle(definition.target, "pet", { trigger: "global-hotkey" });
      const targetWindow = shown ? this.windows.get(definition.target) : void 0;
      if (targetWindow !== void 0) await this.petWindows.positionWindowAtItem(targetWindow);
      return;
    }
    const parent = this.windows.get("pet");
    if (parent === void 0) return;
    if (action === "cycle-display-mode") await this.presentation.executeAction("cycle-mode", parent);
    else if (action === "cycle-display-mode-reverse") this.presentation.executeHotkey("cycle-mode-reverse");
    else if (action === "play-next") {
      const mode = this.presentation.currentMode();
      await this.presentation.executeAction(mode === "image" ? "next-image" : mode === "png-sequence" ? "cycle-png-role" : "switch-live2d-role", parent);
    } else if (action === "play-previous") this.presentation.executeHotkey("play-previous");
    this.petWindows.notifyPresentationChanged();
  }
  async reload() {
    const keys = ["start_with_windows", "comic_bubble_style", ...HOTKEY_ACTIONS.map((item) => item.settingKey)];
    const payload = await this.invokeCore({ type: "settings.get", payload: { keys } });
    this.values = new Map((payload.settings ?? []).map((item) => [item.key, item.value]));
  }
  async saveCore(values) {
    await this.invokeCore({ type: "settings.save", payload: { values } });
  }
  async invokeCore(request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1e4);
    try {
      return await this.core.invoke(randomUUID(), request, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}
function normalizeGesture(value) {
  const raw = value.trim();
  if (raw === "") return "";
  const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const key = normalizeKey(parts.at(-1));
  if (["Ctrl", "Alt", "Shift", "Win"].includes(key)) throw new TypeError("快捷键必须包含一个非修饰键。");
  const modifiers = new Set(parts.slice(0, -1).map(normalizeModifier));
  return [...["Ctrl", "Alt", "Shift", "Win"].filter((item) => modifiers.has(item)), key].join("+");
}
function normalizeModifier(value) {
  const normalized = value.toLocaleLowerCase();
  if (normalized === "control" || normalized === "ctrl") return "Ctrl";
  if (normalized === "alt") return "Alt";
  if (normalized === "shift") return "Shift";
  if (normalized === "meta" || normalized === "super" || normalized === "win") return "Win";
  throw new TypeError(`不支持的快捷键修饰键：${value}`);
}
function normalizeKey(value) {
  const aliases = { ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", " ": "Space" };
  return aliases[value] ?? (value.length === 1 ? value.toUpperCase() : value);
}
function toAccelerator(gesture) {
  return normalizeGesture(gesture).split("+").map((part) => part === "Ctrl" ? "CommandOrControl" : part === "Win" ? "Super" : part).join("+");
}
function bubbleStyleCss(style) {
  const declarations = {
    normal: "background:#fffdf8;border-color:#29251f;color:#241f19;box-shadow:0 12px 34px rgba(43,35,26,.18)",
    soft: "background:#fff5f8;border-color:#d9a7b6;color:#5a3440;box-shadow:0 12px 34px rgba(190,125,147,.2)",
    lively: "background:#fff7d6;border-color:#df9d24;color:#5b3900;box-shadow:0 12px 34px rgba(223,157,36,.25)",
    close: "background:#ffe9ef;border-color:#d66382;color:#67263a;box-shadow:0 12px 34px rgba(214,99,130,.28)"
  };
  const value = declarations[style];
  return value === void 0 ? "" : `.ui-pet-bubble{${value}}`;
}
class AgentConfirmationCoordinator {
  constructor(windows, core, log) {
    this.windows = windows;
    this.core = core;
    this.log = log;
  }
  windows;
  core;
  log;
  queue = [];
  attachedWindows = /* @__PURE__ */ new WeakSet();
  active;
  async execute(payload, signal) {
    try {
      return await this.core.invoke(randomUUID(), { type: "agent.execute", payload }, signal);
    } catch (error) {
      if (!(error instanceof CoreRemoteError) || error.code !== "agent.approval_required") throw error;
      const challenge = readChallenge(error.details);
      return this.enqueue(challenge, payload, signal);
    }
  }
  current() {
    return this.active?.challenge ?? null;
  }
  resolveCurrent(requestId, approved) {
    const pending = this.active;
    if (pending === void 0 || pending.challenge.requestId !== requestId || pending.settled) return false;
    if (!approved) {
      this.finish(pending, new CoreClientError("AGENT_APPROVAL_REJECTED", "用户已取消能力执行。"));
      return true;
    }
    pending.settled = true;
    clearTimeout(pending.timer);
    pending.removeAbort();
    this.active = void 0;
    this.windows.hide("agent-confirm");
    void this.core.invoke(randomUUID(), {
      type: "agent.execute",
      payload: { ...pending.payload, approvalToken: pending.challenge.requestId }
    }, pending.signal).then(pending.resolve, pending.reject).finally(() => this.pump());
    return true;
  }
  cancelAll(message = "Agent 确认请求已取消。") {
    const error = new CoreClientError("AGENT_APPROVAL_CANCELLED", message);
    const pending = [...this.active === void 0 ? [] : [this.active], ...this.queue.splice(0)];
    this.active = void 0;
    this.windows.hide("agent-confirm");
    for (const item of pending) this.settleQueued(item, error);
  }
  enqueue(challenge, payload, signal) {
    return new Promise((resolve2, reject) => {
      const pending = {};
      const onAbort = () => this.cancel(pending, new CoreClientError("REQUEST_CANCELLED", "调用方已取消 Agent 执行。"));
      Object.assign(pending, {
        challenge,
        payload,
        signal,
        resolve: resolve2,
        reject,
        settled: false,
        timer: setTimeout(() => this.cancel(pending, new CoreClientError("AGENT_APPROVAL_TIMEOUT", "Agent 确认已超时。")), 12e4),
        removeAbort: () => signal.removeEventListener("abort", onAbort)
      });
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(pending);
      this.pump();
    });
  }
  pump() {
    if (this.active !== void 0) return;
    const pending = this.queue.shift();
    if (pending === void 0) return;
    if (pending.signal.aborted) {
      this.settleQueued(pending, new CoreClientError("REQUEST_CANCELLED", "调用方已取消 Agent 执行。"));
      this.pump();
      return;
    }
    this.active = pending;
    const window = this.windows.open("agent-confirm");
    if (!this.attachedWindows.has(window)) {
      this.attachedWindows.add(window);
      window.on("hide", () => {
        const current = this.active;
        if (current !== void 0 && window === this.windows.get("agent-confirm"))
          this.finish(current, new CoreClientError("AGENT_APPROVAL_REJECTED", "用户已关闭确认窗口。"));
      });
      window.on("closed", () => {
        const current = this.active;
        if (current !== void 0) this.finish(current, new CoreClientError("AGENT_APPROVAL_REJECTED", "用户已关闭确认窗口。"));
      });
    }
    window.show();
    window.focus();
  }
  cancel(pending, error) {
    if (pending.settled) return;
    if (this.active === pending) this.finish(pending, error);
    else {
      const index = this.queue.indexOf(pending);
      if (index >= 0) this.queue.splice(index, 1);
      this.settleQueued(pending, error);
    }
  }
  finish(pending, error) {
    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    pending.removeAbort();
    if (this.active === pending) this.active = void 0;
    this.windows.hide("agent-confirm");
    pending.reject(error);
    this.log.info("agent-confirmation", "Agent confirmation completed without execution", { requestId: pending.challenge.requestId, code: error instanceof CoreClientError ? error.code : "ERROR" });
    this.pump();
  }
  settleQueued(pending, error) {
    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    pending.removeAbort();
    pending.reject(error);
  }
}
function readChallenge(details) {
  const read = (key) => typeof details[key] === "string" ? details[key] : "";
  const approvalToken = read("approvalToken");
  const capabilityName = read("capabilityName");
  if (approvalToken === "" || capabilityName === "") throw new CoreClientError("AGENT_APPROVAL_INVALID", "Core 返回的 Agent 确认请求不完整。");
  return {
    requestId: approvalToken,
    capabilityName,
    displayName: read("displayName"),
    summary: read("description"),
    executorType: read("executorType"),
    riskLevel: read("riskLevel"),
    argsJson: read("argsJson")
  };
}
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1e3;
const AUDIO_DATA_URL = /^data:audio\/(webm|wav|x-wav|mpeg|mp4|ogg)(?:;codecs=[^;,]+)?;base64,([a-z0-9+/=]+)$/iu;
class SpeechAudioService {
  root;
  constructor(cacheRoot) {
    this.root = resolve(cacheRoot, "asr");
  }
  async importData(dataUrl) {
    const match = AUDIO_DATA_URL.exec(dataUrl);
    if (match === null) throw new TypeError("录音格式不受支持。");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length === 0) throw new TypeError("录音内容为空。");
    if (bytes.length > MAX_AUDIO_BYTES) throw new TypeError("单次录音不能超过 25 MB。");
    await mkdir(this.root, { recursive: true });
    await this.purgeExpired();
    const extension = extensionFor(match[1]);
    const path = join(this.root, `recording_${randomUUID().replaceAll("-", "")}${extension}`);
    await writeFile(path, bytes, { flag: "wx" });
    return { path };
  }
  async purgeExpired() {
    const cutoff = Date.now() - MAX_CACHE_AGE_MS;
    const entries = await readdir(this.root, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
      const path = join(this.root, entry.name);
      const file = await stat(path);
      if (file.mtimeMs < cutoff) await unlink(path);
    }));
  }
}
function extensionFor(mediaType) {
  if (mediaType === "wav" || mediaType === "x-wav") return ".wav";
  if (mediaType === "mpeg") return ".mp3";
  if (mediaType === "mp4") return ".m4a";
  if (mediaType === "ogg") return ".ogg";
  return ".webm";
}
const DEFAULT_INTERVAL_MS = 15e3;
class NativeReminderNotifier {
  async show(reminder) {
    if (!Notification.isSupported()) throw new Error("当前系统不支持 Electron 通知。");
    await new Promise((resolve2, reject) => {
      const notification = new Notification({ title: reminder.title, body: reminder.message, silent: false });
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("系统通知显示确认超时。"));
      }, 5e3);
      timeout.unref();
      const shown = () => {
        cleanup();
        resolve2();
      };
      const failed = (_event, error) => {
        cleanup();
        reject(new Error(error || "系统通知显示失败。"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        notification.off("show", shown);
        notification.off("failed", failed);
      };
      notification.once("show", shown);
      notification.once("failed", failed);
      notification.show();
    });
  }
}
class ReminderScheduler {
  constructor(core, notifier, log, options = {}) {
    this.core = core;
    this.notifier = notifier;
    this.log = log;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? (() => /* @__PURE__ */ new Date());
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelSchedule = options.cancelSchedule ?? clearTimeout;
  }
  core;
  notifier;
  log;
  intervalMs;
  now;
  schedule;
  cancelSchedule;
  timer;
  running = false;
  processing = false;
  stopping;
  resolveStopping;
  start() {
    if (this.running) return;
    this.running = true;
    this.log.info("reminder-scheduler", "Reminder scheduler started", { intervalMs: this.intervalMs });
    this.queueNext(0);
  }
  async stop() {
    if (!this.running && !this.processing) return;
    this.running = false;
    if (this.timer !== void 0) {
      this.cancelSchedule(this.timer);
      this.timer = void 0;
    }
    if (this.processing) {
      this.stopping ??= new Promise((resolve2) => {
        this.resolveStopping = resolve2;
      });
      await this.stopping;
    }
    this.log.info("reminder-scheduler", "Reminder scheduler stopped");
  }
  async runNow() {
    if (this.processing) {
      this.log.debug("reminder-scheduler", "Reminder check skipped because the previous check is still running");
      return;
    }
    this.processing = true;
    const startedAt = performance.now();
    try {
      const now = this.now();
      const payload = await this.core.invoke(randomUUID(), { type: "reminder.list", payload: {} }, new AbortController().signal);
      const due = readReminders(payload).filter((item) => item.enabled && Date.parse(item.nextDueAt ?? item.dueAt) <= now.getTime()).sort((left, right) => Date.parse(left.nextDueAt ?? left.dueAt) - Date.parse(right.nextDueAt ?? right.dueAt)).slice(0, 5);
      this.log.debug("reminder-scheduler", "Reminder check completed", {
        dueCount: due.length,
        durationMs: elapsedMs(startedAt)
      });
      for (const reminder of due) await this.consume(reminder, now);
    } catch (error) {
      this.log.error("reminder-scheduler", "Reminder check failed; due reminders will be retried", error, {
        durationMs: elapsedMs(startedAt)
      });
    } finally {
      this.processing = false;
      this.resolveStopping?.();
      this.resolveStopping = void 0;
      this.stopping = void 0;
      if (this.running) this.queueNext(this.intervalMs);
    }
  }
  async consume(reminder, now) {
    const context = {
      reminderId: reminder.reminderId,
      dueAt: reminder.nextDueAt ?? reminder.dueAt,
      repeat: reminder.repeat,
      allowTts: reminder.allowTts
    };
    try {
      await this.notifier.show(reminder);
      this.log.info("reminder-scheduler", "Due reminder system notification shown", context);
      await this.core.invoke(randomUUID(), {
        type: "reminder.process_due",
        payload: { now: now.toISOString(), reminderIds: [reminder.reminderId] }
      }, new AbortController().signal);
      this.log.info("reminder-scheduler", "Due reminder completed by Core after notification", context);
      if (reminder.allowTts) {
        this.log.info("reminder-scheduler", "Reminder TTS delegated through reminder.due to the pet renderer", {
          reminderId: reminder.reminderId
        });
      }
    } catch (error) {
      this.log.error("reminder-scheduler", "Due reminder consumption failed; reminder remains eligible for retry", error, context);
    }
  }
  queueNext(delayMs) {
    this.timer = this.schedule(() => {
      this.timer = void 0;
      void this.runNow();
    }, delayMs);
    this.timer.unref?.();
  }
}
function readReminders(value) {
  if (!Array.isArray(value)) throw new TypeError("reminder.list 返回格式无效。");
  if (!value.every(isReminderDto)) throw new TypeError("reminder.list 包含格式无效的提醒。");
  return value;
}
function isReminderDto(value) {
  if (typeof value !== "object" || value === null) return false;
  const reminder = value;
  return typeof reminder.reminderId === "string" && typeof reminder.title === "string" && typeof reminder.message === "string" && typeof reminder.dueAt === "string" && (reminder.repeat === "none" || reminder.repeat === "daily") && typeof reminder.enabled === "boolean" && typeof reminder.allowTts === "boolean" && (reminder.nextDueAt === null || typeof reminder.nextDueAt === "string");
}
function elapsedMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
protocol.registerSchemesAsPrivileged([{
  scheme: "aimaid-asset",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.setAppUserModelId("com.aimaid.desktop");
const applicationPaths = configureApplicationPaths();
const logFilePath = configureFileLogging(applicationPaths.logRoot);
logger.info("paths", "Application paths initialized", { ...applicationPaths, logFilePath });
const coreProcess = new CoreProcessManager(createCoreLaunchSpec(), logger);
const coreClient = new StdioCoreClient(coreProcess, app.getVersion(), logger);
const petResourceRoot = app.isPackaged ? join(process.resourcesPath, "live2d") : join(applicationPaths.resourceRoot, "live2d");
const uiResourceRoot = app.isPackaged ? join(process.resourcesPath, "ui") : join(applicationPaths.resourceRoot, "ui");
const applicationIconPath = join(uiResourceRoot, "maid_assistant_icon.ico");
const windowManager = new WindowManager(new WindowFactory(applicationIconPath, logger), logger);
const petAssets = new PetAssetService(petResourceRoot, uiResourceRoot, join(applicationPaths.dataRoot, "notebook", "attachments"), logger);
const notebookAttachments = new NotebookAttachmentService(applicationPaths.dataRoot, petAssets);
const speechAudio = new SpeechAudioService(applicationPaths.cacheRoot);
const petWindows = new PetWindowManager(windowManager, coreClient, logger);
windowManager.setForeignWindowMoveHandlers({
  onStart: () => petWindows.suspendHitTestingForForeignWindowMove(),
  onEnd: () => petWindows.resumeHitTestingAfterForeignWindowMove()
});
const trayController = new TrayController(windowManager, applicationIconPath, logger);
const douyinSession = new DouyinSessionService(applicationPaths.configRoot);
const petPresentation = new PetPresentationService(
  join(applicationPaths.configRoot, "pet-presentation.json"),
  petAssets,
  logger,
  join(uiResourceRoot, "image_tiles"),
  join(uiResourceRoot, "pngLine")
);
const eventRouter = new EventRouter(windowManager, coreClient, coreProcess, logger);
const systemSettings = new SystemSettingsService(windowManager, petWindows, petPresentation, coreClient, logger);
const reminderScheduler = new ReminderScheduler(coreClient, new NativeReminderNotifier(), logger);
const agentConfirmation = new AgentConfirmationCoordinator(windowManager, coreClient, logger);
const ipcRouter = new IpcRouter(windowManager, coreClient, coreProcess, eventRouter, petAssets, petWindows, petPresentation, douyinSession, notebookAttachments, speechAudio, systemSettings, agentConfirmation, logger);
const lifecycle = new ApplicationLifecycle(
  windowManager,
  ipcRouter,
  eventRouter,
  coreClient,
  coreProcess,
  petAssets,
  petWindows,
  trayController,
  systemSettings,
  reminderScheduler,
  logger
);
process.on("uncaughtException", (error) => logger.error("process", "Uncaught exception", error));
process.on("unhandledRejection", (error) => logger.error("process", "Unhandled rejection", error));
void lifecycle.run().catch((error) => {
  logger.error("startup", "Application startup failed", error);
  process.exitCode = 1;
});
