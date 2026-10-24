'use strict';

// Devin 3.11's Agent Window uses the native extension's auth status as its
// model catalog. This module keeps ddevin's existing GetUserStatus augmentation
// in the path without modifying the native extension or its files.
const { createRequire } = require('node:module');
const { fields, m, parseFields } = require('../protocol/wire.cjs');
const { augmentCatalog, collectNativeModels } = require('../catalog/augment.cjs');

const INSTANCE = Symbol.for('ddevin.auth-status-injection.v1');
const GET_USER_STATUS = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
const STATUS_FIELD = 'userStatusProtoBinaryBase64';
const MAX_BASE64_LENGTH = 32 * 1024 * 1024;
const REPUBLISH_DELAY_MS = 250;

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE64_LENGTH) return null;
  if (value.length % 4 !== 0) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value) return null;
  return bytes;
}

function catalogField(userStatus) {
  try {
    const matches = parseFields(userStatus).filter(field => field.number === 33);
    return matches.length === 1 && matches[0].wire === 2 ? matches[0] : null;
  } catch {
    return null;
  }
}

function statusFromResponse(response) {
  try {
    const matches = fields(response, 1).filter(field => field.wire === 2);
    return matches.length === 1 ? matches[0].value : null;
  } catch {
    return null;
  }
}

function augmentUserStatus(raw, catalog) {
  if (!catalogField(raw)) return { data: raw, reason: 'missing-catalog' };
  // Reuse the already-tested GetUserStatus f1 -> UserStatus f33 path.
  const response = m(1, raw);
  const augmented = augmentCatalog(response, { rpc: GET_USER_STATUS, format: {}, catalog });
  const status = statusFromResponse(augmented);
  return status ? { data: status, reason: '' } : { data: raw, reason: 'invalid-status' };
}

function restoreSetter(api, wrapper, descriptor, original) {
  if (api.setAuthStatus !== wrapper) return false;
  if (descriptor) Object.defineProperty(api, 'setAuthStatus', descriptor);
  else {
    delete api.setAuthStatus;
    if (api.setAuthStatus !== original) api.setAuthStatus = original;
  }
  return true;
}

function installAuthStatusInjection({ nativeMainPath, getCatalog, onNativeModels, log = () => {} } = {}) {
  if (typeof nativeMainPath !== 'string' || !nativeMainPath) throw new TypeError('nativeMainPath is required');
  if (typeof getCatalog !== 'function') throw new TypeError('getCatalog is required');

  const nativeRequire = createRequire(nativeMainPath);
  const api = nativeRequire('vscode')?.windsurfAuth;
  if (!api || typeof api.setAuthStatus !== 'function') {
    throw new Error('Native auth status API is unavailable');
  }
  if (api[INSTANCE]) return api[INSTANCE];

  const descriptor = Object.getOwnPropertyDescriptor(api, 'setAuthStatus');
  const original = api.setAuthStatus;
  let disposed = false;
  let disposePromise;
  let rawPayload;
  let rawBuffer;
  let lastInjectedBase64;
  let republishTimer;
  let state = 'waiting';
  let received = 0;
  let augmented = 0;
  let skipped = 0;
  let replayed = 0;
  let lastError = '';

  function report(event, data) {
    try { log('debug', event, data); } catch (_) { /* Diagnostics cannot affect authentication. */ }
  }

  function recordError(code) {
    lastError = code;
    state = 'error';
    report('auth-status-error', { code });
  }

  function clearRaw() {
    rawPayload = undefined;
    rawBuffer = undefined;
    lastInjectedBase64 = undefined;
  }

  function prepare(payload, raw) {
    try {
      const response = m(1, raw);
      const natives = collectNativeModels(response, { rpc: GET_USER_STATUS, format: {} });
      if (natives.length && typeof onNativeModels === 'function') {
        try { onNativeModels(natives); } catch (_) { /* A model-observer failure must not block auth. */ }
      }
      const catalog = getCatalog();
      const rewritten = augmentUserStatus(raw, catalog);
      const stateValue = rewritten.data.toString('base64');
      return {
        payload: { ...payload, [STATUS_FIELD]: stateValue },
        base64: stateValue,
        changed: !rewritten.data.equals(raw),
        reason: rewritten.reason,
      };
    } catch (_) {
      recordError('augment-failed');
      return null;
    }
  }

  function setAuthStatus(payload) {
    if (disposed) return Reflect.apply(original, this, [payload]);
    if (payload === null) {
      received++;
      clearRaw();
      state = 'signed-out';
      lastError = '';
      return Reflect.apply(original, this, [payload]);
    }
    if (!payload || typeof payload !== 'object' || typeof payload[STATUS_FIELD] !== 'string') {
      received++;
      clearRaw();
      state = 'waiting';
      lastError = 'missing-status';
      return Reflect.apply(original, this, [payload]);
    }

    received++;
    const raw = decodeBase64(payload[STATUS_FIELD]);
    if (!raw) {
      clearRaw();
      skipped++;
      recordError('invalid-base64');
      return Reflect.apply(original, this, [payload]);
    }

    rawPayload = { ...payload };
    rawBuffer = raw;
    const prepared = prepare(payload, raw);
    if (!prepared) {
      skipped++;
      return Reflect.apply(original, this, [payload]);
    }

    lastInjectedBase64 = prepared.base64;
    state = 'ready';
    lastError = prepared.reason;
    if (prepared.reason) skipped++;
    else augmented++;
    report('auth-status-injected', { changed: prepared.changed, bytes: raw.length, reason: prepared.reason || undefined });
    return Reflect.apply(original, this, [prepared.payload]);
  }

  async function republish() {
    if (disposed || !rawPayload || !rawBuffer) return false;
    const prepared = prepare(rawPayload, rawBuffer);
    if (!prepared || prepared.reason) {
      skipped++;
      return false;
    }
    if (prepared.base64 === lastInjectedBase64) {
      skipped++;
      return false;
    }
    lastInjectedBase64 = prepared.base64;
    replayed++;
    state = 'ready';
    try {
      await Reflect.apply(original, api, [prepared.payload]);
      report('auth-status-republished', { bytes: rawBuffer.length });
      return true;
    } catch (_) {
      recordError('republish-failed');
      return false;
    }
  }

  function scheduleRepublish() {
    if (disposed || !rawPayload || !rawBuffer) return;
    if (republishTimer) clearTimeout(republishTimer);
    republishTimer = setTimeout(() => {
      republishTimer = undefined;
      void republish().catch(() => {});
    }, REPUBLISH_DELAY_MS);
    republishTimer.unref?.();
  }

  const handle = {
    get status() {
      return Object.freeze({
        state,
        received,
        augmented,
        skipped,
        replayed,
        lastError,
        rawBytes: rawBuffer?.length || 0,
      });
    },
    republish,
    scheduleRepublish,
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      state = 'disposed';
      if (republishTimer) {
        clearTimeout(republishTimer);
        republishTimer = undefined;
      }
      const restored = restoreSetter(api, setAuthStatus, descriptor, original);
      if (api[INSTANCE] === handle) delete api[INSTANCE];
      const payload = rawPayload;
      clearRaw();
      if (!restored || !payload) return Promise.resolve(false);
      try {
        disposePromise = Promise.resolve(Reflect.apply(original, api, [payload]));
      } catch (_) {
        disposePromise = Promise.resolve(false);
      }
      return disposePromise;
    },
  };

  try {
    api.setAuthStatus = setAuthStatus;
    Object.defineProperty(api, INSTANCE, { value: handle, configurable: true });
  } catch (error) {
    restoreSetter(api, setAuthStatus, descriptor, original);
    throw error;
  }
  report('auth-status-injection-waiting');
  return handle;
}

module.exports = { installAuthStatusInjection };
