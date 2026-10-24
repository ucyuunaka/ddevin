'use strict';

// ddevin configuration: single JSON file at ~/.ddevin/config.json.
// CCursor-style store: atomic write, serialized read-modify-write, watchFile
// hot-reload. A corrupt file is never overwritten — defaults run in memory.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.join(os.homedir(), '.ddevin');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const CONTROL_FILE = path.join(ROOT, 'runtime-control.json');
const RUNTIME_LOG = path.join(ROOT, 'runtime.log');
const RECEIPT_FILE = path.join(ROOT, 'settings-restore.json');
const LOCKED_FUSION_FILE = path.join(ROOT, 'locked-fusion.json');
const paths = { root: ROOT, configFile: CONFIG_FILE, controlFile: CONTROL_FILE, runtimeLog: RUNTIME_LOG, receiptFile: RECEIPT_FILE, lockedFusionFile: LOCKED_FUSION_FILE };

const { WARM_DEFAULTS } = require('./runtime/warmer.cjs');

const DEFAULT_CONFIG = {
  enabled: true,
  modelListMode: 'coexist',        // 'official' | 'byok' | 'coexist'
  providers: [],
  fusionPresets: [],
  hiddenNativeModelUids: [],
  hiddenFusionUids: [],
  roleExclusions: { lead: [], sidekick: [] },
  roleInclusions: { lead: [], sidekick: [] },
  logLevel: 'info',                // 'trace'|'debug'|'info'|'warn'|'error'
  requestTimeoutMs: 120000,
  maxRetries: 2,
  // Cache keepalive, all off by default — see normalizeWarmSettings for the
  // per-field bounds (readConfig shallow-merges, so never read these raw).
  cacheWarm: { ...WARM_DEFAULTS },
};

function readJsonOrNull(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { value: JSON.parse(text), ok: true };
  } catch (error) {
    return { value: null, ok: error.code === 'ENOENT' };
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Serialize read-modify-write cycles per file across this process.
const writeQueues = new Map();
function withSerial(file, fn) {
  const queue = (writeQueues.get(file) || Promise.resolve()).then(fn);
  writeQueues.set(file, queue.catch(() => {}));
  return queue;
}

function readConfig(file = CONFIG_FILE) {
  const result = readJsonOrNull(file);
  if (!result.ok || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) {
    return { ...structuredClone(DEFAULT_CONFIG), __invalid: !result.ok };
  }
  const config = { ...structuredClone(DEFAULT_CONFIG), ...result.value };
  delete config.__invalid;
  return config;
}

// readConfig plus a staleness stamp for callers that cache on file contents.
// stat before and after the read; a mismatch (or unreadable file) means the
// file changed underneath us, so the stamp is null and nothing gets cached.
function readConfigStamped(file = CONFIG_FILE) {
  const stat = () => { try { const s = fs.statSync(file); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } };
  const before = stat();
  const config = readConfig(file);
  const after = stat();
  const stamp = before && after && before.mtimeMs === after.mtimeMs && before.size === after.size
    ? `${before.mtimeMs}:${before.size}` : null;
  return { config, stamp };
}

function writeConfig(config, file = CONFIG_FILE) {
  const { __invalid, ...clean } = config;
  return withSerial(file, async () => writeJsonAtomic(file, clean));
}

function updateConfig(updater, file = CONFIG_FILE) {
  return withSerial(file, async () => {
    const current = readConfig(file);
    if (current.__invalid) throw new Error('Configuration file is invalid; refusing to overwrite');
    const next = await updater(current);
    writeJsonAtomic(file, next === undefined ? current : next);
    return next === undefined ? current : next;
  });
}

// Provider model discovery: GET <baseUrl>/models (OpenAI shape; Anthropic is
// paginated). Fills provider.models while preserving per-model user settings.
async function discover(provider) {
  const anthropic = provider.apiFormat === 'anthropic';
  const headers = anthropic ? { 'anthropic-version': '2023-06-01', 'x-api-key': provider.apiKey } : { Authorization: 'Bearer ' + provider.apiKey };
  const listed = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const url = new URL(provider.baseUrl.replace(/\/$/, '') + '/models');
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址必须以 http:// 或 https:// 开头');
    if (anthropic) { url.searchParams.set('limit', '1000'); if (after) url.searchParams.set('after_id', after); }
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      const hint = (response.status === 401 || response.status === 403)
        ? '（认证被拒：请检查 API 密钥，并确认「API 类型」与服务商匹配——OpenAI 兼容端点选 OpenAI Chat/Responses）' : '';
      const err = new Error('获取模型失败：HTTP ' + response.status + hint);
      err.code = 'provider_http'; err.status = response.status;
      throw err;
    }
    const json = await response.json();
    if (!Array.isArray(json.data)) throw new Error('API 未返回模型列表');
    listed.push(...json.data);
    if (!anthropic || !json.has_more || typeof json.last_id !== 'string' || json.last_id === after) break;
    after = json.last_id;
  }
  const old = new Map((Array.isArray(provider.models) ? provider.models : []).map(m => [m.id, m]));
  const limits = new Map(listed.filter(m => m && typeof m.id === 'string').map(m => [m.id, m]));
  const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  provider.models = [...new Set(listed.map(m => m?.id).filter(id => typeof id === 'string' && id.length <= 256))].map(id => {
    if (old.has(id)) return old.get(id);
    const info = limits.get(id);
    const top = info.top_provider;
    const pick = (...values) => values.map(positive).find(value => value !== null);
    const detected = pick(info.context_length, info.context_window, info.max_context_length, info.max_model_len, info.max_input_tokens, top?.context_length);
    const contextWindow = detected ?? 272000;
    const maxOutputTokens = Math.min(pick(info.max_output_tokens, info.max_completion_tokens, top?.max_completion_tokens, info.max_tokens) ?? 131072, contextWindow);
    const entry = { id, label: provider.name + ' · ' + id, enabled: true, efforts: [], contextWindow, maxOutputTokens };
    if (detected === undefined) entry.limitsDetected = false;
    const modalities = info.architecture?.input_modalities ?? info.input_modalities ?? info.modalities;
    if (Array.isArray(modalities)) entry.supportsImages = modalities.some(value => String(value).toLowerCase() === 'image');
    else if (info.capabilities?.vision === false || info.supports_vision === false) entry.supportsImages = false;
    else if (info.capabilities?.vision === true || info.supports_vision === true) entry.supportsImages = true;
    return entry;
  });
  return provider.models.length;
}

function normalizeBaseUrlPath(pathname) {
  const path = String(pathname || '').replace(/\/(?:responses|chat\/completions|messages|models)\/?$/, '').replace(/\/+$/, '');
  return path.split('/').some(segment => /^v\d+/i.test(segment)) ? path : path + '/v1';
}

module.exports = { paths, DEFAULT_CONFIG, readConfig, readConfigStamped, writeConfig, updateConfig, writeJsonAtomic, discover, normalizeBaseUrlPath };
