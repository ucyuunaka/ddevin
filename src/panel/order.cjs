'use strict';

// Display-order preferences for the model management page. This is deliberately
// a sidecar file: reordering cards must never touch config.json, the catalog, or
// the model picker. A short-lived cross-process lock protects read/merge/write
// cycles, because two VS Code windows may sort different lists at the same time.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const UPDATED_MESSAGE = '列表已更新，请重新调整。';
const REPAIR_MESSAGE = '该列表包含重复或缺失的 ID，请先修复配置后再排序。';
const BUSY_MESSAGE = '面板展示顺序正被其他窗口更新，请稍后重试。';

class OrderStoreError extends Error {
  constructor(message, code = 'order_error') {
    super(message);
    this.name = 'OrderStoreError';
    this.code = code;
  }
}

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const emptySaved = () => ({ providerIds: [], modelIdsByProvider: new Map() });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function cloneSaved(value) {
  return {
    providerIds: [...value.providerIds],
    modelIdsByProvider: new Map([...value.modelIdsByProvider].map(([key, list]) => [key, [...list]])),
  };
}

// A sidecar entry is usable only if it is a string. Duplicate entries are
// ignored when the list is aligned with the live configuration.
function alignList(preferred, current) {
  const available = new Set(current), seen = new Set(), out = [];
  for (const id of Array.isArray(preferred) ? preferred : []) {
    if (!validId(id) || !available.has(id) || seen.has(id)) continue;
    seen.add(id); out.push(id);
  }
  for (const id of current) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

function parseSavedText(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return { error: 'JSON 无法解析' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: '顶层不是对象' };
  if (parsed.version !== VERSION) return { error: '版本 ' + String(parsed.version) + ' 不受支持' };
  if (!Array.isArray(parsed.providerIds) || parsed.providerIds.some(id => typeof id !== 'string')) {
    return { error: 'providerIds 不是字符串数组' };
  }
  if (!parsed.modelIdsByProvider || typeof parsed.modelIdsByProvider !== 'object' || Array.isArray(parsed.modelIdsByProvider)) {
    return { error: 'modelIdsByProvider 不是对象' };
  }
  const modelIdsByProvider = new Map();
  for (const [providerId, list] of Object.entries(parsed.modelIdsByProvider)) {
    if (!Array.isArray(list) || list.some(id => typeof id !== 'string')) return { error: '模型顺序不是字符串数组' };
    modelIdsByProvider.set(providerId, [...list]);
  }
  return { value: { providerIds: [...parsed.providerIds], modelIdsByProvider } };
}

function readSaved(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, exists: false, value: emptySaved() };
    return { ok: false, error: new OrderStoreError('无法读取面板展示顺序文件（' + (error?.code || '读取失败') + '）。', 'order_read') };
  }
  const parsed = parseSavedText(text);
  if (parsed.error) {
    return { ok: false, error: new OrderStoreError(
      '面板展示顺序文件无法使用（' + parsed.error + '），已回退到当前配置顺序；请修复或删除 ' + file + ' 后重试。',
      'order_corrupt') };
  }
  return { ok: true, exists: true, value: parsed.value };
}

function writeSaved(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  const disk = {
    version: VERSION,
    providerIds: [...value.providerIds],
    modelIdsByProvider: Object.fromEntries([...value.modelIdsByProvider].map(([key, list]) => [key, [...list]])),
  };
  try {
    fs.writeFileSync(tmp, JSON.stringify(disk, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (error) {
    throw new OrderStoreError('无法保存面板展示顺序（' + (error?.code || '写入失败') + '），请检查 ~/.ddevin 目录权限。', 'order_write');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Three-state process probing is intentionally conservative: only ESRCH proves
// that an owner is gone. Permission errors and every unknown result are treated
// as possibly-live so an old lock can never be stolen by age.
function processState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

function lockStamp(owner) {
  return JSON.stringify({ pid: process.pid, owner, createdAt: Date.now() });
}

function inspectMainLock(lockFile, staleMs, now, probe) {
  let text;
  try { text = fs.readFileSync(lockFile, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'free' };
    return { kind: 'busy', reason: 'unreadable' };
  }
  let info = null;
  try { info = JSON.parse(text); } catch {}
  if (info && typeof info === 'object' && !Array.isArray(info) &&
      Number.isSafeInteger(info.pid) && info.pid > 0) {
    let state;
    try { state = probe(info.pid); } catch { state = 'unknown'; }
    if (state === 'dead') return { kind: 'stale', reason: 'dead', info };
    return { kind: 'busy', reason: state === 'alive' ? 'alive' : 'unknown', info };
  }
  // A malformed lock may be an interrupted initialization. Age is only used as
  // a grace period for this no-owner case, never to overtake a valid live PID.
  let stat;
  try { stat = fs.statSync(lockFile); }
  catch { return { kind: 'busy', reason: 'unreadable' }; }
  if (now - Number(stat.mtimeMs) > staleMs) return { kind: 'stale', reason: 'malformed' };
  return { kind: 'busy', reason: 'initializing' };
}

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameSaved(left, right) {
  if (!sameIds(left.providerIds, right.providerIds)) return false;
  if (left.modelIdsByProvider.size !== right.modelIdsByProvider.size) return false;
  for (const [providerId, ids] of left.modelIdsByProvider) {
    const other = right.modelIdsByProvider.get(providerId);
    if (!other || !sameIds(ids, other)) return false;
  }
  return true;
}

function savedIsEmpty(value) {
  return value.providerIds.length === 0 && value.modelIdsByProvider.size === 0;
}

function makeStore(options = {}) {
  const file = options.file ? path.resolve(options.file) : null;
  const lockTimeoutMs = Number.isSafeInteger(options.lockTimeoutMs) && options.lockTimeoutMs >= 0 ? options.lockTimeoutMs : 3000;
  const staleMs = Number.isSafeInteger(options.staleMs) && options.staleMs > 0 ? options.staleMs : 15000;
  const pollMs = Number.isSafeInteger(options.pollMs) && options.pollMs >= 1 ? options.pollMs : 20;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const beforeWrite = options.beforeWrite;
  const beforeLockCreate = options.beforeLockCreate;
  const beforeLockOwnerWrite = options.beforeLockOwnerWrite;
  const beforeReleaseMainLock = options.beforeReleaseMainLock;
  const onLockEvent = typeof options.onLockEvent === 'function' ? options.onLockEvent : null;
  const probeProcess = typeof options.processState === 'function' ? options.processState : processState;
  const lockFile = file ? file + '.lock' : null;
  const guardFile = lockFile ? lockFile + '.guard' : null;
  const token = crypto.randomBytes(16).toString('hex');
  let memory = emptySaved();
  let queue = Promise.resolve();

  const emit = (event, detail = {}) => {
    if (!onLockEvent) return;
    try { onLockEvent(event, detail); } catch {}
  };

  function guardError(reason) {
    return new OrderStoreError(
      '排序锁异常，需确认相关窗口已退出后清理指定锁文件：' + guardFile + '（' + reason + '）。',
      'order_lock_guard');
  }

  function removeMainLock(context) {
    try { fs.unlinkSync(lockFile); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new OrderStoreError(
        '无法清理面板展示顺序排序锁（' + (error?.code || '清理失败') + '）：' + lockFile + '（' + context + '）。',
        'order_lock');
    }
  }

  function releaseGuard(guardToken) {
    let text;
    try { text = fs.readFileSync(guardFile, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw guardError('读取协调文件失败 ' + (error?.code || '未知错误'));
    }
    let info = null;
    try { info = JSON.parse(text); } catch {}
    if (!info || info.owner !== guardToken) throw guardError('协调文件 owner 不匹配，未删除');
    try { fs.unlinkSync(guardFile); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw guardError('删除协调文件失败 ' + (error?.code || '未知错误'));
    }
  }

  async function acquireGuard(deadline) {
    const guardToken = crypto.randomBytes(16).toString('hex');
    for (;;) {
      let fd, created = false;
      try {
        fd = fs.openSync(guardFile, 'wx', 0o600);
        created = true;
        fs.writeFileSync(fd, lockStamp(guardToken));
        fs.closeSync(fd); fd = undefined;
        return guardToken;
      } catch (error) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
        if (created) {
          let cleanup = '已清理本次创建的协调文件。';
          try { fs.unlinkSync(guardFile); }
          catch { cleanup = '且无法清理本次创建的协调文件，请在确认相关窗口退出后删除 ' + guardFile + '。'; }
          throw new OrderStoreError(
            '无法初始化面板展示顺序排序锁协调文件（' + (error?.code || '写入失败') + '）：' + guardFile + '，' + cleanup,
            'order_lock');
        }
        if (error?.code !== 'EEXIST') {
          throw new OrderStoreError(
            '无法获取面板展示顺序排序锁协调文件（' + (error?.code || '锁定失败') + '）：' + guardFile,
            'order_lock');
        }
        if (Date.now() >= deadline) throw guardError('等待协调文件超时');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw guardError('等待协调文件超时');
      await sleep(Math.min(pollMs, remaining));
    }
  }

  async function withGuard(deadline, operation) {
    const guardToken = await acquireGuard(deadline);
    emit('guard-enter', { pid: process.pid });
    let value, failure;
    try { value = operation(); }
    catch (error) { failure = error; }
    let releaseFailure;
    try { releaseGuard(guardToken); }
    catch (error) { releaseFailure = error; }
    emit('guard-leave', { pid: process.pid });
    if (failure) {
      if (releaseFailure) {
        throw new OrderStoreError(failure.message + '；此外清理排序锁协调文件失败：' + releaseFailure.message,
          failure.code || 'order_lock');
      }
      throw failure;
    }
    if (releaseFailure) throw releaseFailure;
    return value;
  }

  // The caller holds guardFile while this function runs. Every mutation of the
  // main lock therefore observes a single serialized lifecycle; there is no
  // check/unlink window in which another reaper can delete a freshly made lock.
  function createMainLock(lockToken) {
    let fd, opened = false;
    try {
      if (beforeLockCreate) beforeLockCreate();
      fd = fs.openSync(lockFile, 'wx', 0o600);
      opened = true;
      if (beforeLockOwnerWrite) beforeLockOwnerWrite();
      fs.writeFileSync(fd, lockStamp(lockToken));
      fs.closeSync(fd); fd = undefined;
      emit('main-created', { pid: process.pid });
      return true;
    } catch (error) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      if (!opened && error?.code === 'EEXIST') return false;
      let cleanup = '';
      if (opened) {
        try { fs.unlinkSync(lockFile); cleanup = '已清理本次创建的锁文件。'; }
        catch { cleanup = '且无法清理本次创建的锁文件，请在确认相关窗口退出后删除 ' + lockFile + '。'; }
      }
      throw new OrderStoreError(
        '无法创建或初始化面板展示顺序排序锁（' + (error?.code || '创建失败') + '）：' + lockFile + '，' + cleanup,
        'order_lock');
    }
  }

  async function acquire() {
    const deadline = Date.now() + lockTimeoutMs;
    try { fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 }); }
    catch (error) {
      throw new OrderStoreError(
        '无法准备面板展示顺序排序锁目录（' + (error?.code || '创建失败') + '）：' + path.dirname(lockFile),
        'order_lock');
    }
    for (;;) {
      const outcome = await withGuard(deadline, () => {
        const inspected = inspectMainLock(lockFile, staleMs, Date.now(), probeProcess);
        if (inspected.kind === 'busy') return { acquired: false, reason: inspected.reason };
        if (inspected.kind === 'stale') {
          emit('reap', { pid: process.pid, reason: inspected.reason });
          removeMainLock('回收' + (inspected.reason === 'dead' ? '已退出进程' : '无 owner 旧锁'));
        }
        return { acquired: createMainLock(token) };
      });
      if (outcome.acquired) return token;
      if (Date.now() >= deadline) throw new OrderStoreError(BUSY_MESSAGE, 'order_busy');
      await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
    }
  }

  async function release(lockToken) {
    const deadline = Date.now() + lockTimeoutMs;
    await withGuard(deadline, () => {
      let text;
      try { text = fs.readFileSync(lockFile, 'utf8'); }
      catch (error) {
        if (error?.code === 'ENOENT') return;
        throw new OrderStoreError(
          '无法读取面板展示顺序排序锁以释放（' + (error?.code || '读取失败') + '）：' + lockFile,
          'order_unlock');
      }
      let info = null;
      try { info = JSON.parse(text); } catch {}
      if (!info || info.owner !== lockToken) {
        throw new OrderStoreError(
          '面板展示顺序排序锁释放失败：owner 不匹配，未删除 ' + lockFile + '。请确认相关窗口已退出后手动清理该文件。',
          'order_unlock');
      }
      if (beforeReleaseMainLock) beforeReleaseMainLock();
      try { fs.unlinkSync(lockFile); }
      catch (error) {
        if (error?.code === 'ENOENT') return;
        throw new OrderStoreError(
          '面板展示顺序排序锁释放失败（' + (error?.code || '删除失败') + '）：' + lockFile + '。请确认相关窗口已退出后手动清理该文件。',
          'order_unlock');
      }
    });
  }

  async function locked(operation) {
    const lockToken = await acquire();
    emit('main-enter', { pid: process.pid });
    let value, operationFailure;
    try { value = await operation(); }
    catch (error) { operationFailure = error; }
    emit('main-leave', { pid: process.pid });
    let releaseFailure;
    try { await release(lockToken); }
    catch (error) { releaseFailure = error; }
    if (operationFailure) {
      if (releaseFailure) {
        throw new OrderStoreError(operationFailure.message + '；此外排序锁释放失败：' + releaseFailure.message,
          operationFailure.code || 'order_error');
      }
      throw operationFailure;
    }
    if (releaseFailure) {
      throw new OrderStoreError('面板展示顺序操作已完成，但' + releaseFailure.message, 'order_unlock');
    }
    return value;
  }

  function serial(operation) {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  }

  function snapshot(config, saved = memory, error = null) {
    return buildSnapshot(config, saved, error);
  }

  function readForMutation(config) {
    if (!file) return { exists: true, value: memory };
    const loaded = readSaved(file);
    if (!loaded.ok) throw loaded.error;
    return loaded;
  }

  function persist(config, saved) {
    if (file) writeSaved(file, saved);
    else memory = cloneSaved(saved);
  }

  function canonical(config, effective) {
    const modelIdsByProvider = new Map();
    for (const [providerId, ids] of effective.modelIdsByProvider) modelIdsByProvider.set(providerId, [...ids]);
    return { providerIds: [...effective.providerIds], modelIdsByProvider };
  }

  // The manager passes readConfig so business membership is re-read inside the
  // lock, after any earlier writer has finished. Direct store tests can still
  // pass a fixed config snapshot.
  function resolveConfig(request) {
    return typeof request?.readConfig === 'function' ? request.readConfig() : request?.config;
  }

  async function mutate(request, fn) {
    const operation = async () => {
      const config = resolveConfig(request);
      // Snapshot reads are intentionally not locked. Mutations re-read under
      // the file lock so another window's unrelated list survives our write.
      const loaded = readForMutation(config);
      const effective = effectiveOrder(config, loaded.value);
      if (!fn(effective, loaded)) return snapshot(config, loaded.value, null);
      const next = canonical(config, effective);
      if (beforeWrite) await beforeWrite();
      persist(config, next);
      return buildSnapshot(config, next, null);
    };
    return file ? locked(operation) : serial(operation);
  }

  function targetFor(effective, scope, providerId) {
    if (scope === 'providers') return {
      ids: effective.providerIds,
      sortable: effective.providerSortable,
      token: effective.tokens.providers,
      replace: ids => { effective.providerIds = ids; },
    };
    if (scope !== 'models') throw new OrderStoreError('排序范围无效。', 'order_input');
    if (typeof providerId !== 'string' || !effective.modelIdsByProvider.has(providerId)) {
      throw new OrderStoreError('该供应商已不存在，请刷新面板。', 'order_input');
    }
    return {
      ids: effective.modelIdsByProvider.get(providerId),
      sortable: effective.providerSortable && effective.modelSortable.get(providerId),
      token: effective.tokens.models[providerId],
      replace: ids => effective.modelIdsByProvider.set(providerId, ids),
    };
  }

  function validateTarget(effective, scope, providerId, expectedToken) {
    if (typeof expectedToken !== 'string' || !expectedToken) throw new OrderStoreError(UPDATED_MESSAGE, 'order_conflict');
    const target = targetFor(effective, scope, providerId);
    if (!target.sortable) throw new OrderStoreError(REPAIR_MESSAGE, 'order_unsortable');
    if (target.token !== expectedToken) throw new OrderStoreError(UPDATED_MESSAGE, 'order_conflict');
    return target;
  }

  async function reorder(request = {}) {
    const { scope, providerId, ids, expectedToken } = request;
    return mutate(request, effective => {
      const target = validateTarget(effective, scope, providerId, expectedToken);
      if (!Array.isArray(ids) || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length) {
        throw new OrderStoreError(UPDATED_MESSAGE, 'order_conflict');
      }
      if (ids.length !== target.ids.length) throw new OrderStoreError(UPDATED_MESSAGE, 'order_conflict');
      const expected = new Set(target.ids);
      if (ids.some(id => !expected.has(id))) throw new OrderStoreError(UPDATED_MESSAGE, 'order_conflict');
      if (sameIds(target.ids, ids)) return false;
      target.replace([...ids]);
      return true;
    });
  }

  async function prioritize(request = {}) {
    const { scope, providerId, expectedToken } = request;
    return mutate(request, effective => {
      const target = validateTarget(effective, scope, providerId, expectedToken);
      const enabled = new Set(effective.enabledIds(scope, providerId));
      const next = [...target.ids.filter(id => enabled.has(id)), ...target.ids.filter(id => !enabled.has(id))];
      if (sameIds(target.ids, next)) return false;
      target.replace(next);
      return true;
    });
  }

  // Called immediately before a business config write that appends members.
  // Existing sidecar entries are aligned to the current membership so a stale
  // reference cannot be resurrected when the same ID is added again. When the
  // sidecar does not exist, ordinary additions must leave it absent.
  async function prepareAppend(request = {}) {
    const operation = async () => {
      const config = resolveConfig(request);
      const providerId = request.providerId;
      const modelIds = request.modelIds ?? [];
      if (typeof providerId !== 'string' || !validId(providerId)) {
        throw new OrderStoreError('该供应商已不存在，请刷新面板。', 'order_conflict');
      }
      if (!Array.isArray(modelIds) || modelIds.some(id => !validId(id)) || new Set(modelIds).size !== modelIds.length) {
        throw new OrderStoreError(UPDATED_MESSAGE, 'order_conflict');
      }
      const providers = Array.isArray(config?.providers) ? config.providers : [];
      const provider = providers.find(item => item?.id === providerId);
      if (!provider && !request.allowMissingProvider) {
        throw new OrderStoreError('该供应商已不存在，请刷新面板。', 'order_conflict');
      }
      if (provider) {
        const existing = new Set((Array.isArray(provider.models) ? provider.models : [])
          .map(model => model?.id).filter(validId));
        if (modelIds.some(id => existing.has(id))) throw new OrderStoreError(UPDATED_MESSAGE, 'order_conflict');
      } else if (modelIds.length) {
        throw new OrderStoreError('该供应商已不存在，请刷新面板。', 'order_conflict');
      }
      const loaded = readForMutation(config);
      if (file ? !loaded.exists : savedIsEmpty(loaded.value)) return snapshot(config, loaded.value, null);
      const effective = effectiveOrder(config, loaded.value);
      const next = canonical(config, effective);
      if (sameSaved(loaded.value, next)) return snapshot(config, loaded.value, null);
      if (beforeWrite) await beforeWrite();
      persist(config, next);
      return buildSnapshot(config, next, null);
    };
    return file ? locked(operation) : serial(operation);
  }

  async function removeFromSaved(request, change) {
    const operation = async () => {
      const config = resolveConfig(request);
      const loaded = readForMutation(config);
      if (!loaded.exists) return snapshot(config, loaded.value, null);
      const saved = cloneSaved(loaded.value);
      if (!change(saved)) return snapshot(config, loaded.value, null);
      const effective = effectiveOrder(config, saved);
      const next = canonical(config, effective);
      if (beforeWrite) await beforeWrite();
      persist(config, next);
      return buildSnapshot(config, next, null);
    };
    return file ? locked(operation) : serial(operation);
  }

  return {
    file,
    snapshot: config => file ? (() => {
      const loaded = readSaved(file);
      return loaded.ok ? buildSnapshot(config, loaded.value, null) : buildSnapshot(config, emptySaved(), loaded.error);
    })() : buildSnapshot(config, memory, null),
    reorder,
    prioritize,
    prepareAppend,
    removeProvider(request = {}) {
      const { providerId } = request;
      return removeFromSaved(request, saved => {
        let changed = false;
        const next = saved.providerIds.filter(id => id !== providerId);
        if (next.length !== saved.providerIds.length) changed = true;
        saved.providerIds = next;
        if (saved.modelIdsByProvider.delete(providerId)) changed = true;
        return changed;
      });
    },
    removeModels(request = {}) {
      const { providerId, modelIds } = request;
      return removeFromSaved(request, saved => {
        const list = saved.modelIdsByProvider.get(providerId);
        if (!Array.isArray(list) || !Array.isArray(modelIds) || !modelIds.length) return false;
        const remove = new Set(modelIds), next = list.filter(id => !remove.has(id));
        if (next.length === list.length) return false;
        saved.modelIdsByProvider.set(providerId, next);
        return true;
      });
    },
  };
}

function effectiveOrder(config, saved) {
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  const providerSeen = new Set(), providerIds = [];
  let providerSortable = true;
  for (const provider of providers) {
    const id = provider?.id;
    if (!validId(id) || providerSeen.has(id)) { providerSortable = false; continue; }
    providerSeen.add(id); providerIds.push(id);
  }
  const orderedProviderIds = alignList(saved.providerIds, providerIds);
  const providerEnabled = new Map();
  const providerIndex = new Map();
  for (const provider of providers) {
    if (!validId(provider?.id) || providerIndex.has(provider.id)) continue;
    providerIndex.set(provider.id, provider);
    providerEnabled.set(provider.id, provider.enabled !== false);
  }

  const modelIdsByProvider = new Map(), modelSortable = new Map(), modelEnabled = new Map();
  for (const providerId of providerIds) {
    const provider = providerIndex.get(providerId), models = Array.isArray(provider?.models) ? provider.models : [];
    const seen = new Set(), current = [];
    let sortable = providerSortable;
    for (const model of models) {
      const id = model?.id;
      if (!validId(id) || seen.has(id)) { sortable = false; continue; }
      seen.add(id); current.push(id);
    }
    const preferred = saved.modelIdsByProvider.get(providerId) || [];
    const aligned = alignList(preferred, current);
    modelIdsByProvider.set(providerId, aligned);
    modelSortable.set(providerId, sortable);
    const enabled = new Set();
    for (const model of models) if (validId(model?.id) && model.enabled !== false) enabled.add(model.id);
    modelEnabled.set(providerId, enabled);
  }

  const token = (scope, providerId, ids, enabled) =>
    crypto.createHash('sha256').update(JSON.stringify([VERSION, scope, providerId ?? null,
      ids.map(id => [id, enabled.has(id)])])).digest('hex');
  const tokens = { providers: providerSortable ? token('providers', null, orderedProviderIds, new Set(
    [...providerEnabled].filter(([, value]) => value).map(([id]) => id))) : null, models: Object.create(null) };
  const models = Object.create(null);
  const sortableModels = Object.create(null);
  for (const providerId of providerIds) {
    const ids = modelIdsByProvider.get(providerId);
    models[providerId] = ids;
    sortableModels[providerId] = modelSortable.get(providerId) === true;
    tokens.models[providerId] = sortableModels[providerId]
      ? token('models', providerId, ids, modelEnabled.get(providerId)) : null;
  }
  return {
    providerIds: orderedProviderIds,
    modelIdsByProvider,
    providerSortable,
    modelSortable,
    tokens,
    enabledIds(scope, providerId) {
      if (scope === 'providers') return [...providerEnabled].filter(([, enabled]) => enabled).map(([id]) => id);
      return [...(modelEnabled.get(providerId) || [])];
    },
    models,
    sortableModels,
  };
}

function buildSnapshot(config, saved, error) {
  const effective = effectiveOrder(config, saved);
  const models = Object.create(null), tokens = { providers: error ? null : effective.tokens.providers, models: Object.create(null) };
  const sortable = { providers: !error && effective.providerSortable, models: Object.create(null) };
  for (const [providerId, ids] of effective.modelIdsByProvider) {
    models[providerId] = ids;
    tokens.models[providerId] = error ? null : effective.tokens.models[providerId];
    sortable.models[providerId] = !error && effective.providerSortable && effective.modelSortable.get(providerId) === true;
  }
  return {
    providers: [...effective.providerIds],
    models,
    tokens,
    sortable,
    error: error ? error.message : null,
  };
}

function createOrderStore(options) { return makeStore(options); }

module.exports = {
  VERSION,
  UPDATED_MESSAGE,
  REPAIR_MESSAGE,
  BUSY_MESSAGE,
  OrderStoreError,
  createOrderStore,
  processState,
  // Exported for focused tests and for the manager's in-memory token checks.
  alignList,
  parseSavedText,
  effectiveOrder,
  buildSnapshot,
};
