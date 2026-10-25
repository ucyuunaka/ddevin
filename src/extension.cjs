'use strict';

// ddevin extension host: spawns the loopback backend, redirects devin-cli's
// API server to it through a settings override (receipt-tracked), injects the
// per-window LS bridge, and exposes the control panel. No Devin app files
// are modified; everything here restores cleanly on disable/uninstall.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { paths, readConfig, writeConfig } = require('./config.cjs');
const { buildCatalog, normalizeFusionConfig } = require('./catalog.cjs');
const { createManager } = require('./panel/model.cjs');
const { createOrderStore } = require('./panel/order.cjs');
const { installLsInjection } = require('./runtime/ls-injection.cjs');
const { installAcpInjection } = require('./runtime/acp-injection.cjs');
const { installAuthStatusInjection } = require('./runtime/auth-status-injection.cjs');
const { createLsBridge } = require('./runtime/bridge.cjs');
const { runtimeIdentity, controlFile, PORT, MANAGEMENT_PROTOCOL } = require('./runtime/backend.cjs');
const { readReceipt, remember, saveReceipt, valueAt, restoreObject } = require('./lifecycle/owned-settings.cjs');
const { loopbackProxyBypass } = require('./lifecycle/agent-env.cjs');
const { readNativeModels, readRuntimeLogs } = require('./runtime/native-models.cjs');
const { createPickerRefresh } = require('./runtime/picker-refresh.cjs');
const { expireCliModelCaches } = require('./runtime/cli-cache.cjs');
const { createLogger, outputChannelSink } = require('./logger.cjs');
const VERSION = require('../package.json').version;

let stopNativeSync;
let connection;
let acpInjection;
let authInjection;
let runtimeWaitAbort;
let authRefreshAbort;
let authStatusWasReceived = false;
let activationGeneration = 0;
let reconcileHalted = true;
let activationDisposed = true;

function globalSetting(settings, key) {
  return typeof settings.inspect === 'function' ? settings.inspect(key)?.globalValue || {} : settings.get(key, {});
}

const RUNTIME_ERRORS = {
  port_in_use: '本地连接端口已被其他程序占用。',
  different_storage: '该端口属于另一套插件配置，未更改它的连接服务。',
  legacy_runtime: '旧版连接服务不支持安全升级，请重新加载窗口。',
  newer_runtime: '另一窗口已加载更新版插件，请重新加载当前窗口。',
  control_unavailable: '无法验证本地连接服务的归属，请重新加载窗口后重试。',
  startup_failed: '本地连接服务启动失败，请查看状态日志。',
  cancelled: '操作已取消。',
};
class RuntimeError extends Error {
  constructor(code) { super(RUNTIME_ERRORS[code]); this.code = code; }
}
function safeError(error) {
  if (error instanceof RuntimeError) return { code: error.code, message: RUNTIME_ERRORS[error.code] };
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/^获取模型失败：HTTP [1-5]\d{2}/.test(message)) return { code: 'provider_http_error', message };
  if (['API 地址必须以 http:// 或 https:// 开头', 'API 未返回模型列表', '未找到 Devin 原生扩展'].includes(message)) return { code: 'configuration_error', message };
  return { code: 'operation_failed', message: '操作失败，请检查接口配置和连接状态。' };
}
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new RuntimeError('cancelled')); return; }
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new RuntimeError('cancelled')); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
function compareVersion(left, right) {
  const a = String(left).split('.').map(Number), b = String(right).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}

// Adopt a running backend when it matches service/version/source/root;
// otherwise wait for it to drain and replace it with our own child process.
async function ensureBackend({ root, extensionPath, signal, log = () => {}, port = PORT, onCompatibleRuntime }, dependencies = {}) {
  const request = dependencies.fetch || fetch;
  const spawnRuntime = dependencies.spawn || spawn;
  const wait = dependencies.sleep || pause;
  const base = 'http://127.0.0.1:' + port;
  let started = false, startupPolls = 0, warnedBusy = false, controlFailures = 0, compatibleNotified = false;
  const timeout = ms => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  // sourceId is a file fingerprint — computing it once instead of per poll.
  const expected = runtimeIdentity(root, true);
  for (;;) {
    if (signal?.aborted) throw new RuntimeError('cancelled');
    let response;
    try { response = await request(base + '/health', { signal: timeout(1000) }); } catch {}
    if (signal?.aborted) throw new RuntimeError('cancelled');
    if (!response) {
      if (!started) {
        let failed = false;
        try {
          const child = spawnRuntime(process.execPath, [path.join(extensionPath, 'src/runtime/backend.cjs'), root], {
            detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          });
          child.once('error', () => { failed = true; }); child.unref();
        } catch { throw new RuntimeError('startup_failed'); }
        started = true;
        await wait(100, signal);
        if (failed) throw new RuntimeError('startup_failed');
        continue;
      }
      if (++startupPolls >= 50) throw new RuntimeError('startup_failed');
      await wait(100, signal); continue;
    }
    let health;
    try { if (!response.ok) throw new Error(); health = await response.json(); }
    catch { throw new RuntimeError('port_in_use'); }
    if (health?.service !== expected.service) throw new RuntimeError('port_in_use');
    if (health.rootId && health.rootId !== expected.rootId) throw new RuntimeError('different_storage');
    if (compareVersion(health.version, expected.version) > 0) throw new RuntimeError('newer_runtime');
    if (health.version === expected.version && health.sourceId === expected.sourceId && health.rootId === expected.rootId && !health.draining) return health;
    if (health.managementProtocol !== MANAGEMENT_PROTOCOL || !health.instanceId || !health.rootId ||
        !Number.isSafeInteger(health.activeRequests) || health.activeRequests < 0) throw new RuntimeError('legacy_runtime');
    if (!compatibleNotified && !health.draining && !signal?.aborted &&
        (health.version !== expected.version || health.sourceId !== expected.sourceId)) {
      compatibleNotified = true;
      try { onCompatibleRuntime?.(health); } catch {}
    }
    if (health.activeRequests > 0 || health.draining) {
      if (!warnedBusy) { log('debug', 'runtime-update-waiting', { activeRequests: health.activeRequests }); warnedBusy = true; }
      await wait(health.draining ? 100 : 1000, signal); continue;
    }
    let control;
    try { control = JSON.parse(fs.readFileSync(controlFile(root), 'utf8')); } catch {}
    if (!control || control.instanceId !== health.instanceId || control.rootId !== health.rootId ||
        control.sourceId !== health.sourceId || !/^[a-f0-9]{64}$/.test(control.token || '')) {
      if (++controlFailures > 3) throw new RuntimeError('control_unavailable');
      await wait(100, signal); continue;
    }
    controlFailures = 0;
    try {
      const stopped = await request(base + '/_runtime/shutdown', { method: 'POST',
        headers: { authorization: 'Bearer ' + control.token }, signal: timeout(2000) });
      if (stopped.status === 403) throw new RuntimeError('control_unavailable');
      if (![200, 409, 503].includes(stopped.status)) throw new RuntimeError('legacy_runtime');
      await stopped.body?.cancel();
    } catch (error) { if (error instanceof RuntimeError) throw error; }
    started = false; startupPolls = 0;
    await wait(100, signal);
  }
}

async function activate(context) {
  activationDisposed = false;
  const output = vscode.window.createOutputChannel('ddevin', { log: true });
  context.subscriptions.push(output);
  const logger = createLogger({ level: 'info', sinks: [outputChannelSink(output)] });
  const log = logger;

  const root = paths.root;
  const configFile = paths.configFile;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(configFile)) writeConfig(readConfig(configFile), configFile).catch(() => log.warn('config-write-error'));
  const config = () => readConfig(configFile);
  const settingsFile = (() => {
    try { return path.join(path.dirname(path.dirname(context.globalStorageUri.fsPath)), 'settings.json'); }
    catch { return undefined; }
  })();

  const nativeMain = (() => {
    try {
      const native = vscode.extensions.getExtension('codeium.windsurf');
      return native?.extensionPath && native.packageJSON?.main
        ? path.resolve(native.extensionPath, native.packageJSON.main) : null;
    } catch { return null; }
  })();

  let lastDiagnosticsSignature;
  const catalog = () => {
    const current = config();
    const built = buildCatalog(current.enabled === false ? { ...current, providers: [] } : current, [...nativeModels.values()]);
    const signature = JSON.stringify(built.diagnostics || []);
    if (signature !== lastDiagnosticsSignature) {
      lastDiagnosticsSignature = signature;
      if (built.diagnostics.length) log.warn('catalog-diagnostics', { count: built.diagnostics.length, items: built.diagnostics });
    }
    return built;
  };
  let management, manager;
  const orderFile = path.join(root, 'panel-order.json');
  const orderStore = createOrderStore({ file: orderFile });
  const nativeModels = new Map(), localNativeModels = new Map();
  let nativeCatalogStatus = 'loading', syncPending, syncAbort, syncTimer;
  const nativeModelKey = entry => JSON.stringify([
    entry.label, entry.disabled, entry.isModelRouter, entry.harnessUids, entry.sidekickDimension,
    entry.fusionMetadata, entry.maxTokens, entry.maxOutputTokens, entry.supportsImages,
  ]);
  const nativeModelSignature = () => JSON.stringify(
    [...nativeModels.entries()].map(([uid, entry]) => [uid, nativeModelKey(entry)]));
  const refreshNativeModels = () => {
    if (activationDisposed || config().enabled === false) return Promise.resolve();
    if (syncPending) return syncPending;
    const generation = activationGeneration;
    const abort = new AbortController(); syncAbort = abort;
    syncPending = (async () => {
      let result;
      try { result = await readNativeModels({ root, signal: abort.signal }); }
      catch { result = { status: 'unavailable', models: [] }; }
      if (abort.signal.aborted || generation !== activationGeneration || activationDisposed || config().enabled === false) return;
      nativeCatalogStatus = result.status;
      const before = nativeModelSignature();
      nativeModels.clear();
      for (const entry of localNativeModels.values()) nativeModels.set(entry.uid, entry);
      for (const entry of result.models) nativeModels.set(entry.uid, entry);
      if (before !== nativeModelSignature()) authInjection?.scheduleRepublish();
      try { await management?.publish(); } catch {}
    })().finally(() => { if (syncAbort === abort) { syncAbort = undefined; syncPending = undefined; } });
    return syncPending;
  };
  const startNativeSync = () => {
    stopNativeSync?.();
    stopNativeSync = () => { clearInterval(syncTimer); syncAbort?.abort(); syncAbort = undefined; syncPending = undefined; };
    syncTimer = setInterval(() => { void refreshNativeModels(); }, 3000); syncTimer.unref?.();
    void refreshNativeModels();
  };
  const mergeNativeModels = (entries, local = false) => {
    if (!Array.isArray(entries)) return;
    let changed = false;
    for (const entry of entries) {
      if (!entry || typeof entry.uid !== 'string' || !entry.uid) continue;
      const dimension = entry.sidekickDimension;
      const next = { uid: entry.uid, label: typeof entry.label === 'string' ? entry.label : '', disabled: entry.disabled === true,
        isModelRouter: entry.isModelRouter === true,
        harnessUids: Array.isArray(entry.harnessUids) ? entry.harnessUids.filter(value => typeof value === 'string') : [],
        ...(dimension && typeof dimension === 'object'
          ? { sidekickDimension: { order: dimension.order, name: dimension.name, fastModeOrder: dimension.fastModeOrder } } : {}),
        ...(Array.isArray(entry.fusionMetadata) ? { fusionMetadata: entry.fusionMetadata } : {}),
        ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
        ...(entry.maxOutputTokens ? { maxOutputTokens: entry.maxOutputTokens } : {}),
        ...(entry.supportsImages ? { supportsImages: true } : {}) };
      const previous = nativeModels.get(next.uid);
      const previousKey = previous ? nativeModelKey(previous) : '';
      const nextKey = nativeModelKey(next);
      if (!previous || previousKey !== nextKey) {
        nativeModels.set(next.uid, next); changed = true;
      }
      if (local) {
        const previousLocal = localNativeModels.get(next.uid);
        if (!previousLocal || nativeModelKey(previousLocal) !== nextKey) {
          localNativeModels.set(next.uid, next); changed = true;
        }
      }
    }
    return changed;
  };
  const notifyNativeModels = (changed, republish = true) => {
    if (!changed || activationDisposed) return;
    try { void management?.publish()?.catch(() => {}); } catch {}
    if (republish) try { authInjection?.scheduleRepublish(); } catch {}
  };
  const observeNativeModels = entries => notifyNativeModels(mergeNativeModels(entries, true));
  const observeAuthNativeModels = entries => notifyNativeModels(mergeNativeModels(entries, false), false);

  let enableQueue = Promise.resolve();
  const ensureEnabled = () => {
    const operation = enableQueue.then(() => {
      if (activationDisposed || config().enabled === false || connection) return;
      return enable();
    });
    enableQueue = operation.catch(() => {});
    return operation;
  };

  async function refreshAuthStatusInjection(generation, signal) {
    const delays = authStatusWasReceived ? [0, 3000, 10000, 30000] : [60000, 90000];
    for (const delay of delays) {
      if (delay) await pause(delay, signal);
      if (activationDisposed || generation !== activationGeneration || config().enabled === false ||
          !authInjection || authInjection.status.received > 0) return;
      try {
        await vscode.commands.executeCommand('devin.refreshUserStatus');
      } catch {
        if (signal.aborted) return;
        log('debug', 'auth-status-refresh-unavailable');
      }
      if (authInjection && authInjection.status.received > 0) {
        log('debug', 'auth-status-refresh-recovered');
        return;
      }
    }
    if (!activationDisposed && generation === activationGeneration && authInjection?.status.received === 0) {
      log.warn('auth-status-refresh-timeout');
    }
  }

  async function enable() {
    const generation = ++activationGeneration;
    runtimeWaitAbort?.abort();
    authRefreshAbort?.abort();
    const waiting = new AbortController(); runtimeWaitAbort = waiting;
    const native = vscode.extensions.getExtension('codeium.windsurf');
    if (!native) throw new Error('未找到 Devin 原生扩展');
    if (nativeMain && !authInjection) {
      try {
        authInjection = installAuthStatusInjection({
          nativeMainPath: nativeMain,
          getCatalog: catalog,
          onNativeModels: observeAuthNativeModels,
          log: (level, event, data) => (log[level] || log.info).call(log, event, data),
        });
      } catch (error) {
        log.warn('auth-status-injection-unavailable', { code: error?.code || 'unavailable' });
      }
    }
    const upgrade = ensureBackend({ root, extensionPath: context.extensionPath, signal: waiting.signal,
      log: (level, event, data) => (log[level] || log.info).call(log, event, data),
      onCompatibleRuntime: health => {
        if (waiting.signal.aborted) return;
        log.info('runtime-update-pending', { version: health.version });
      } });
    void upgrade.finally(() => { if (runtimeWaitAbort === waiting) runtimeWaitAbort = undefined; })
      .catch(error => { const code = safeError(error).code; if (code !== 'cancelled') log.error('runtime-upgrade-error', { code }); });
    // Gate the native connector before activating the language-server bridge.
    // A compatible old backend can disappear while it is being upgraded.
    if (nativeMain && !acpInjection) {
      try {
        acpInjection = await installAcpInjection({ nativeMainPath: nativeMain,
          apiServerUrl: 'http://127.0.0.1:' + PORT, waitForBackend: () => upgrade,
          log: (level, event, data) => (log[level] || log.info).call(log, event, data) });
      } catch { log.warn('acp-injection-unavailable'); }
    }
    await upgrade;
    if (generation !== activationGeneration || config().enabled === false) return;
    reconcileHalted = false;

    const apiServerUrl = 'http://127.0.0.1:' + PORT;
    const settings = vscode.workspace.getConfiguration('devin.acp');
    const existing = globalSetting(settings, 'agentEnv');
    const previous = { ...(existing['devin-cli'] || {}) };
    const desired = { WINDSURF_API_SERVER_URL: apiServerUrl, ...loopbackProxyBypass(previous) };
    const receipt = readReceipt(root, context.extensionPath, settingsFile);
    for (const [key, value] of Object.entries(desired)) {
      const current = valueAt({ 'devin.acp.agentEnv': existing }, ['devin.acp.agentEnv', 'devin-cli', key]);
      remember(receipt, ['devin.acp.agentEnv', 'devin-cli', key], current, value);
    }
    // Commit recovery information before changing the user's settings.
    saveReceipt(receipt);
    const current = config();
    if (current.inferenceServerUrl !== apiServerUrl) {
      current.inferenceServerUrl = apiServerUrl;
      if (current.__invalid) log.warn('config-invalid-not-persisted');
      else await writeConfig(current, configFile);
    }
    if (Object.entries(desired).some(([k, v]) => previous[k] !== v))
      await settings.update('agentEnv', { ...existing, 'devin-cli': { ...previous, ...desired } }, vscode.ConfigurationTarget.Global);
    if (generation !== activationGeneration || config().enabled === false) return;
    await reconcilePreference();
    if (generation !== activationGeneration || config().enabled === false) return;
    const injected = await installLsInjection({ nativeMainPath: path.resolve(native.extensionPath, native.packageJSON.main),
      createBridge: port => createLsBridge(port, { getCatalog: catalog, log: (level, event, data) => (log[level] || log.info).call(log, event, data), onNativeModels: observeNativeModels }),
      log: (level, event, data) => (log[level] || log.info).call(log, event, data) });
    if (generation !== activationGeneration || config().enabled === false || activationDisposed) {
      try { await injected.dispose(); } catch {}
      return;
    }
    connection = injected;
    startNativeSync();
    if (authInjection && authInjection.status.received === 0) {
      const refreshAbort = new AbortController(); authRefreshAbort = refreshAbort;
      void refreshAuthStatusInjection(generation, refreshAbort.signal)
        .catch(error => {
          if (safeError(error).code !== 'cancelled') log('debug', 'auth-status-refresh-error');
        })
        .finally(() => { if (authRefreshAbort === refreshAbort) authRefreshAbort = undefined; });
    }
    log.info('activated', { nativeVersion: native.packageJSON.version, storage: root });
  }

  const run = fn => async () => { try { await fn(); } catch (error) {
    const safe = safeError(error);
    if (safe.code === 'cancelled') return;
    log.error('command-error', { code: safe.code }); vscode.window.showErrorMessage('ddevin：' + safe.message);
  } };
  const refresh = async () => {
    management.open();
    vscode.window.showInformationMessage('请选择供应商，点击“获取模型”，勾选后确认导入。');
  };
  context.subscriptions.push(vscode.commands.registerCommand('ddevin.refreshModels', run(refresh)));
  context.subscriptions.push(vscode.commands.registerCommand('ddevin.configure', run(async () => management.open())));
  context.subscriptions.push(vscode.commands.registerCommand('ddevin.openPanel', run(async () => management.open())));

  const saveFusionChoice = async uid => {
    const settings = vscode.workspace.getConfiguration('devin.acp'); const preferences = globalSetting(settings, 'agentPreferences');
    const receipt = readReceipt(root, context.extensionPath, settingsFile), keys = ['devin.acp.agentPreferences', 'devin-cli', 'model'];
    remember(receipt, keys, valueAt({ 'devin.acp.agentPreferences': preferences }, keys), uid);
    saveReceipt(receipt);
    await settings.update('agentPreferences', { ...preferences, 'devin-cli': { ...(preferences['devin-cli'] || {}), model: uid } }, vscode.ConfigurationTarget.Global);
    const current = normalizeFusionConfig(config(), [...nativeModels.values()]);
    if (/^fusion-ddevin-/.test(uid)) {
      if (current.__invalid) log.warn('config-invalid-not-persisted');
      else { current.defaultFusionUid = uid; await writeConfig(current, configFile); }
    }
    await management?.publish();
  };
  const rememberedFusion = () => {
    const currentCatalog = catalog(), uid = currentCatalog.defaultFusionUid || config().defaultFusionUid;
    return typeof uid === 'string' && Object.hasOwn(currentCatalog.fusions, uid) ? uid : '';
  };
  let reconcileQueue = Promise.resolve();
  const reconcilePreference = () => {
    const operation = reconcileQueue.then(async () => {
      if (reconcileHalted || config().enabled === false) return;
      const current = globalSetting(vscode.workspace.getConfiguration('devin.acp'), 'agentPreferences')['devin-cli']?.model;
      const migration = catalog();
      if (migration.migratedFrom === current && migration.defaultFusionUid) {
        await saveFusionChoice(migration.defaultFusionUid);
        return;
      }
      if (typeof current === 'string' && /^fusion-ddevin-/.test(current)) {
        if (!Object.hasOwn(catalog().fusions, current)) return;
        if (rememberedFusion() !== current) {
          const next = config();
          if (next.__invalid) log.warn('config-invalid-not-persisted');
          else { next.defaultFusionUid = current; await writeConfig(next, configFile); }
        }
        return;
      }
      // Any other explicit selection — official model or official Fusion — is
      // the user's choice; locked official Fusions still redirect via AssignModel.
      if (typeof current === 'string' && current) return;
      const remembered = rememberedFusion();
      if (remembered) await saveFusionChoice(remembered);
    }).catch(() => log.warn('preference-reconcile-error'));
    reconcileQueue = operation;
    return operation;
  };
  context.subscriptions.push(vscode.commands.registerCommand('ddevin.selectFusion', run(async () => {
    const choices = Object.values(catalog().fusions).filter(item => item.canonical)
      .map(item => ({ label: item.label || item.uid, uid: item.uid }));
    if (!choices.length) { management?.open(); vscode.window.showInformationMessage('请先在控制面板新建并命名 Fusion 预设。'); return; }
    const choice = await vscode.window.showQuickPick(choices, { title: '选择 Fusion 预设', matchOnDescription: true }); if (!choice) return;
    await saveFusionChoice(choice.uid);
    vscode.window.showInformationMessage('Fusion 模型已保存，请新建 Devin Local 会话。');
  })));
  context.subscriptions.push(vscode.commands.registerCommand('ddevin.status', () => { const providers = Array.isArray(config().providers) ? config().providers : []; log.info('status', { runtime: connection?.status, authStatusInjection: authInjection?.status, models: providers.map(p => ({ name: p.name, models: Array.isArray(p.models) ? p.models.length : 0 })) }); output.show(true); }));

  const disable = async () => {
    const current = config();
    if (current.__invalid) log.warn('config-invalid-not-persisted');
    else { current.enabled = false; try { await writeConfig(current, configFile); } catch { log.warn('config-write-error'); } }
    await teardown();
    const settings = vscode.workspace.getConfiguration('devin.acp');
    const snapshot = { 'devin.acp.agentEnv': globalSetting(settings, 'agentEnv'), 'devin.acp.agentPreferences': globalSetting(settings, 'agentPreferences') };
    const receipt = readReceipt(root, context.extensionPath, settingsFile);
    const restored = restoreObject(snapshot, receipt.changes);
    for (const key of ['agentEnv', 'agentPreferences']) if (JSON.stringify(snapshot['devin.acp.' + key]) !== JSON.stringify(restored.value['devin.acp.' + key])) {
      await settings.update(key, restored.value['devin.acp.' + key], vscode.ConfigurationTarget.Global);
    }
    receipt.changes = []; saveReceipt(receipt);
    vscode.window.showInformationMessage('ddevin 已停用，原生连接已恢复。');
  };
  context.subscriptions.push(vscode.commands.registerCommand('ddevin.disable', run(disable)));

  const reconcileSelection = async () => {
    const settings = vscode.workspace.getConfiguration('devin.acp');
    const preferences = globalSetting(settings, 'agentPreferences'), current = preferences['devin-cli']?.model;
    if (!/^(?:fusion-)?ddevin-/.test(current || '') || catalog().models.some(model => model.uid === current)) return;
    const receipt = readReceipt(root, context.extensionPath, settingsFile);
    const changes = receipt.changes.filter(change => change.path[0] === 'devin.acp.agentPreferences');
    const restored = restoreObject({ 'devin.acp.agentPreferences': preferences }, changes).value['devin.acp.agentPreferences'];
    if (/^(?:fusion-)?ddevin-/.test(restored['devin-cli']?.model || '')) delete restored['devin-cli'].model;
    await settings.update('agentPreferences', restored, vscode.ConfigurationTarget.Global);
  };

  const statusBar = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment?.Right ?? 2, 20);
  if (statusBar) {
    statusBar.text = 'ddevin'; statusBar.tooltip = '管理供应商、模型列表与 Fusion 组合';
    statusBar.command = 'ddevin.openPanel'; statusBar.show(); context.subscriptions.push(statusBar);
    // Cache-warm indicator: while the master switch is on, poll the warm
    // snapshot every 15s and show live lineage count; otherwise restore.
    const baseText = statusBar.text, baseTooltip = statusBar.tooltip;
    const restore = () => { if (statusBar.text !== baseText) { statusBar.text = baseText; statusBar.tooltip = baseTooltip; } };
    const warmTimer = setInterval(async () => {
      try {
        if (config().cacheWarm?.enabled !== true) { restore(); return; }
        const warm = (await readRuntimeLogs({ root, limit: 1 }))?.warm;
        const live = Array.isArray(warm?.lineages) ? warm.lineages.filter(l => l.state !== 'stopped' && l.hasPayload) : [];
        if (!live.length) { restore(); return; }
        statusBar.text = 'ddevin · 保温 ' + live.length;
        statusBar.tooltip = '缓存保温：' + live.length + ' 条会话 · 已发 ' + (warm.totals?.sent ?? 0) + ' · 命中 ' + (warm.totals?.hits ?? 0);
      } catch {}
    }, 15000);
    warmTimer.unref?.();
    context.subscriptions.push({ dispose: () => clearInterval(warmTimer) });
  }
  const pickerRefresh = createPickerRefresh({ log: (level, event, data) => (log[level] || log.info).call(log, event, data),
    prepare: () => expireCliModelCaches({ log: (level, event, data) => (log[level] || log.info).call(log, event, data) }),
    executeCommand: command => vscode.commands.executeCommand(command),
    readModels: () => catalog().models });
  pickerRefresh.prime();
  context.subscriptions.push(pickerRefresh);
  manager = createManager({ read: config, write: current => writeConfig(current, configFile), orderStore,
    nativeModels: () => [...nativeModels.values()], refreshNativeModels, nativeCatalogStatus: () => nativeCatalogStatus,
    selectedFusion: () => {
      const current = globalSetting(vscode.workspace.getConfiguration('devin.acp'), 'agentPreferences')['devin-cli']?.model;
      if (typeof current === 'string' && current.startsWith('fusion-')) return current;
      return rememberedFusion() || current || '';
    },
    selectFusion: saveFusionChoice,
    afterChange: async (type, override = {}) => {
      const enabled = override.enabled ?? config().enabled !== false;
      if (type === 'setEnabled' && !enabled) await disable();
      else if (type === 'setEnabled') { await ensureEnabled(); await reconcileSelection(); }
      else if (enabled) { await reconcileSelection(); }
      pickerRefresh.changed();
      if (type !== 'setLogLevel' && enabled) authInjection?.scheduleRepublish();
      if (type === 'setLogLevel') logger.setLevel(config().logLevel || 'info');
    } });
  management = require('./panel/controller.cjs').createPanelController({ vscode, context, manager, safeError,
    readLogs: () => readRuntimeLogs({ root }),
    connectionStatus: () => connection?.status || null,
    log: (level, event, data) => (log[level] || log.info).call(log, event, data) });

  const syncSecrets = currentConfig => {
    try { logger.setSecrets((currentConfig.providers || []).map(provider => provider.apiKey)); } catch {}
  };
  syncSecrets(config());
  let lastLevel = config().logLevel || 'info';
  const onConfigChanged = () => {
    try {
      const currentConfig = config();
      if ((currentConfig.logLevel || 'info') !== lastLevel) { lastLevel = currentConfig.logLevel || 'info'; logger.setLevel(lastLevel); }
      syncSecrets(currentConfig);
      if (currentConfig.enabled === false) void teardown().catch(() => log.warn('disable-cleanup-error'));
      else {
        void ensureEnabled().catch(error => { const safe = safeError(error); if (safe.code !== 'cancelled') log.error('enable-error', { code: safe.code }); });
        void reconcilePreference();
        authInjection?.scheduleRepublish();
      }
      void management.publish()?.catch(() => {});
    }
    catch { log.warn('configuration-read-error'); }
  };
  fs.watchFile(configFile, { interval: 500, persistent: false }, onConfigChanged);
  context.subscriptions.push({ dispose: () => fs.unwatchFile(configFile, onConfigChanged) });
  // Display order lives outside config.json on purpose: changing it must not
  // enter enable/picker/catalog refresh paths. Only repaint the management UI.
  const onOrderChanged = () => { try { void management?.publish()?.catch(() => {}); } catch {} };
  fs.watchFile(orderFile, { interval: 500, persistent: false }, onOrderChanged);
  context.subscriptions.push({ dispose: () => fs.unwatchFile(orderFile, onOrderChanged) });
  const preferenceSubscription = vscode.workspace.onDidChangeConfiguration?.(event => {
    if (typeof event?.affectsConfiguration === 'function' && !event.affectsConfiguration('devin.acp.agentPreferences')) return;
    return reconcilePreference();
  });
  if (preferenceSubscription) context.subscriptions.push(preferenceSubscription);
  if (config().enabled !== false) await run(ensureEnabled)();
  return { status: () => connection?.status };
}

async function teardown() {
  stopNativeSync?.(); stopNativeSync = undefined;
  activationGeneration++; runtimeWaitAbort?.abort(); authRefreshAbort?.abort(); authRefreshAbort = undefined; reconcileHalted = true;
  if (connection) { const current = connection; connection = undefined; await current.dispose(); }
  if (acpInjection) { const handle = acpInjection; acpInjection = undefined; try { handle.dispose(); } catch {} }
  if (authInjection) {
    const handle = authInjection;
    authStatusWasReceived = authStatusWasReceived || handle.status.received > 0;
    authInjection = undefined;
    try { await handle.dispose(); } catch {}
  }
}
async function deactivate() {
  activationDisposed = true;
  await teardown();
}
module.exports = { activate, deactivate };
