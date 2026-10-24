'use strict';

// ddevin backend: a standalone loopback proxy process. Devin's devin-cli
// (via WINDSURF_API_SERVER_URL) and any direct caller reach it; it forwards
// every /exa.* RPC to https://server.codeium.com unchanged except:
//   - catalog RPCs (response augmented with ddevin models)
//   - AssignModel (fusion preset -> concrete model uid)
//   - GetChatMessage (ddevin model uids -> configured upstream provider)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { readConfigStamped } = require('../config.cjs');
const { buildCatalog, resolveAssignment } = require('../catalog.cjs');
const wire = require('../protocol/wire.cjs');
const { parseChat, chatLineage, lineageKey, parseChatResponseMeta } = require('../protocol/chat.cjs');
const { serveChat, warmPing } = require('../protocol/serve.cjs');
const { sendOfficialPing } = require('./official-ping.cjs');
const { createWarmer, normalizeWarmSettings } = require('./warmer.cjs');
const { forward, collect } = require('./bridge.cjs');
const { createLogger, fileSink } = require('../logger.cjs');
const { createOfficialAgent } = require('./official-agent.cjs');
const PORT = 39927;
const VERSION = require('../../package.json').version;
const API_PREFIX = '/exa.api_server_pb.ApiServerService/';
const SERVICE = 'ddevin';
const MANAGEMENT_PROTOCOL = 1;
// Every file that feeds sourceId — a changed catalog module must trigger a
// backend upgrade, so the split files are listed individually.
const SOURCE_FILES = ['../../package.json', 'backend.cjs', 'bridge.cjs', 'official-agent.cjs', 'warmer.cjs', 'official-ping.cjs', '../config.cjs', '../catalog.cjs',
  '../catalog/shared.cjs', '../catalog/roles.cjs', '../catalog/build.cjs', '../catalog/augment.cjs',
  '../capabilities.cjs', '../logger.cjs', '../protocol/wire.cjs', '../protocol/chat.cjs', '../protocol/serve.cjs', '../protocol/anthropic.cjs'];
function sourceId() {
  const hash = crypto.createHash('sha256');
  for (const name of SOURCE_FILES) hash.update(name).update('\0').update(fs.readFileSync(path.resolve(__dirname, name))).update('\0');
  return hash.digest('hex');
}
const LOADED_SOURCE_ID = sourceId();
// Rebuild a derived value only while its cache key stays the same; a falsy
// key (e.g. an unstamped config read) always rebuilds.
function createCatalogCache({ build }) {
  let key, value;
  return (cacheKey, ...args) => {
    if (cacheKey && cacheKey === key && value !== undefined) return value;
    key = cacheKey;
    value = build(...args);
    return value;
  };
}
function runtimeIdentity(root, freshSource = false) {
  return { service: SERVICE, version: VERSION, sourceId: freshSource ? sourceId() : LOADED_SOURCE_ID,
    rootId: crypto.createHash('sha256').update(path.resolve(root)).digest('hex') };
}
function controlFile(root) { return path.join(root, 'runtime-control.json'); }

const METRIC_NUMBERS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : undefined;
// Aggregate the request-metrics ring into per-model + totals stats.
function summarize(ring) {
  const fresh = model => ({ model, requests: 0, errors: 0, aborted: 0, retries: 0, durations: [], ttfts: [],
    ...Object.fromEntries(METRIC_NUMBERS.map(field => [field, 0])) });
  const models = {}, totals = fresh('total'), all = [];
  const finish = (acc, durations) => {
    const sorted = durations.slice().sort((a, b) => a - b);
    const ttfts = acc.ttfts || [];
    acc.avgTtftMs = ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : undefined;
    acc.p50DurationMs = percentile(sorted, 0.5);
    acc.p95DurationMs = percentile(sorted, 0.95);
    delete acc.durations; delete acc.ttfts;
    return acc;
  };
  for (const record of ring) {
    const name = record.model || 'unknown';
    const entry = models[name] ??= fresh(name);
    for (const acc of [entry, totals]) {
      acc.requests++;
      if (record.outcome === 'error') { acc.errors++; acc.lastError = { code: record.code, status: record.status, time: record.time }; }
      else if (record.outcome === 'aborted') acc.aborted++;
      acc.retries += record.retries || 0;
      for (const field of METRIC_NUMBERS) if (Number.isSafeInteger(record.usage?.[field])) acc[field] += record.usage[field];
      const credits = record.credits;
      if (credits && typeof credits === 'object') {
        if (Number.isFinite(credits.creditCost)) acc.creditCost = (acc.creditCost || 0) + credits.creditCost;
        const acu = Number.isFinite(credits.committedAcuCost) ? credits.committedAcuCost
          : Number.isFinite(credits.acuCost) ? credits.acuCost : undefined;
        if (acu !== undefined) acc.acuCost = (acc.acuCost || 0) + acu;
      }
    }
    if (Number.isSafeInteger(record.durationMs)) { entry.durations.push(record.durationMs); all.push(record.durationMs); }
    if (Number.isSafeInteger(record.ttftMs)) { entry.ttfts.push(record.ttftMs); totals.ttfts.push(record.ttftMs); }
  }
  for (const name of Object.keys(models)) finish(models[name], models[name].durations);
  finish(totals, all);
  return { models, totals };
}

async function startBackend({ root, port = PORT, log = () => {}, upstreamOrigin = 'https://server.codeium.com', warm = {} }) {
  const agent = new URL(upstreamOrigin).protocol === 'https:' ? createOfficialAgent({ log }) : undefined;
  const identity = runtimeIdentity(root);
  const instanceId = crypto.randomUUID();
  const controlToken = crypto.randomBytes(32).toString('hex');
  let activeRequests = 0;
  let draining = false;
  let closing;
  let resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  const configFile = path.join(root, 'config.json');
  const observedNatives = new Map();
  let nativesVersion = 0;
  const onNativeModels = entries => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry.uid !== 'string' || !entry.uid) continue;
      const dimension = entry.sidekickDimension;
      const normalized = { uid: entry.uid, label: typeof entry.label === 'string' ? entry.label : '',
        disabled: entry.disabled === true, isModelRouter: entry.isModelRouter === true,
        harnessUids: Array.isArray(entry.harnessUids) ? entry.harnessUids.filter(value => typeof value === 'string') : [],
        ...(dimension && typeof dimension === 'object'
          ? { sidekickDimension: { order: dimension.order, name: dimension.name, fastModeOrder: dimension.fastModeOrder } } : {}),
        ...(Array.isArray(entry.fusionMetadata) ? { fusionMetadata: entry.fusionMetadata } : {}),
        ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
        ...(entry.maxOutputTokens ? { maxOutputTokens: entry.maxOutputTokens } : {}),
        ...(entry.supportsImages ? { supportsImages: true } : {}) };
      if (JSON.stringify(observedNatives.get(entry.uid)) !== JSON.stringify(normalized)) {
        observedNatives.set(entry.uid, normalized);
        nativesVersion++;
      }
    }
  };
  // Exact provider keys become redactable log secrets whenever the file changes.
  let lastSecretsStamp;
  const stampedConfig = () => {
    const stamped = readConfigStamped(configFile);
    if (stamped.stamp && stamped.stamp !== lastSecretsStamp) {
      lastSecretsStamp = stamped.stamp;
      log.setSecrets?.((stamped.config.providers || []).map(provider => provider.apiKey));
    }
    return stamped;
  };
  const metricsRing = [];
  const pushMetric = data => { metricsRing.push(data); if (metricsRing.length > 200) metricsRing.splice(0, metricsRing.length - 200); };
  let lastDiagnosticsSignature;
  // The catalog is pure input -> output over (config file, observed natives);
  // cache on stamp + nativesVersion. Callers must not mutate the result —
  // augmentCatalog/resolveAssignment only read it.
  const catalogCache = createCatalogCache({ build: current => {
    const built = buildCatalog(current.enabled === false ? { ...current, providers: [] } : current, [...observedNatives.values()]);
    const signature = JSON.stringify(built.diagnostics || []);
    if (signature !== lastDiagnosticsSignature) {
      lastDiagnosticsSignature = signature;
      if (built.diagnostics.length) log('warn', 'catalog-diagnostics', { count: built.diagnostics.length, items: built.diagnostics });
    }
    return built;
  } });
  const getCatalog = (current, stamp) => {
    if (current === undefined) ({ config: current, stamp } = stampedConfig());
    return catalogCache(stamp ? `${stamp}|${nativesVersion}` : null, current);
  };
  // Official Fusion uids observed as disabled in catalog responses. Persisted
  // so a saved locked preference still redirects on a fresh session.
  const lockedFusionFile = path.join(root, 'locked-fusion.json');
  const lockedFusion = new Set();
  try {
    for (const uid of JSON.parse(fs.readFileSync(lockedFusionFile, 'utf8')))
      if (typeof uid === 'string' && uid.startsWith('fusion-')) lockedFusion.add(uid);
  } catch {}
  const onFusionStatus = (locked, seen) => {
    const keep = new Set(locked);
    let changed = false;
    for (const uid of seen) {
      if (keep.has(uid)) { if (!lockedFusion.has(uid)) { lockedFusion.add(uid); changed = true; } }
      else changed = lockedFusion.delete(uid) || changed;
    }
    if (changed) {
      try { fs.writeFileSync(lockedFusionFile, JSON.stringify([...lockedFusion]), { mode: 0o600 }); } catch {}
      log('debug', 'fusion-status', { locked: lockedFusion.size, seen: seen.length });
    }
  };
  // Cache warmer: replays each conversation's last request with a tiny output
  // cap before the upstream prompt cache TTL lapses. BYOK payloads re-resolve
  // their route at send time so provider edits take effect immediately.
  const providerTtl = provider => {
    const value = provider?.cacheWarm && typeof provider.cacheWarm === 'object' ? provider.cacheWarm.ttlSeconds : undefined;
    return Number.isSafeInteger(value) && value >= 60 && value <= 3600 ? value : undefined;
  };
  const warmer = createWarmer({
    now: warm.now, sweepMs: warm.sweepMs, autoSweep: warm.autoSweep,
    getSettings: () => {
      const { config } = stampedConfig();
      const warmSettings = normalizeWarmSettings(config);
      if (config.enabled === false) warmSettings.enabled = false;
      return warmSettings;
    },
    send: async (lineage, { signal, maxTokens }) => {
      if (lineage.kind === 'official') return sendOfficialPing({ origin: upstreamOrigin, payload: lineage.payload, maxTokens, signal });
      const request = lineage.payload?.request;
      const { config: current, stamp } = stampedConfig();
      const route = request && getCatalog(current, stamp).routes[lineage.uid];
      const provider = route && (Array.isArray(current.providers) ? current.providers : []).find(p => p.id === route.providerId);
      if (!route || !provider) return { kind: 'error', latencyMs: 0, code: 'route_gone', fatal: true, transient: false };
      return warmPing({ request, route, provider, maxOutputTokens: maxTokens, signal });
    },
    log: (level, event, data) => { try { log(level, event, data); } catch {} },
  });
  // Passive official measurement: parse the forwarded response stream for
  // usage/billing fields without touching a single forwarded byte.
  const officialTap = ({ format, request, lineage, token, startedAt }) => {
    let status = 0, firstDataAt, endError, broken = false, actualModel = '';
    const usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
    const credits = {};
    let compressed = false, compressedChunks = [];
    const merge = data => {
      const meta = parseChatResponseMeta(data);
      if (meta.usage) for (const field of ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens']) {
        if (meta.usage[field]) usage[field] = meta.usage[field];
      }
      for (const name of ['creditCost', 'committedCreditCost', 'committedAcuCost']) {
        if (meta[name]) credits[name] = meta[name];
      }
      if (meta.actualModelUid) actualModel = meta.actualModelUid;
    };
    const feed = wire.createFrameReader((flags, data) => {
      let chunk = data;
      if (flags & 1) chunk = zlib.gunzipSync(chunk);
      if (flags & 2) {
        try { endError = JSON.parse(chunk.toString('utf8'))?.error || endError; } catch {}
        return;
      }
      merge(chunk);
    });
    return {
      onResponse({ statusCode, headers }) {
        status = statusCode;
        const encoding = String(headers['content-encoding'] || '').toLowerCase();
        if (encoding === 'gzip' || encoding === 'deflate') compressed = true;
        else if (encoding && encoding !== 'identity') broken = true;
      },
      onData(chunk) {
        firstDataAt ??= Date.now();
        if (broken) return;
        try {
          if (compressed) compressedChunks.push(chunk);
          else feed(chunk);
        } catch { broken = true; }
      },
      onEnd(complete) {
        if (compressed && complete) {
          try {
            const plain = zlib.unzipSync(Buffer.concat(compressedChunks), { maxOutputLength: 64 * 1024 * 1024 });
            compressedChunks = [];
            feed(plain);
          } catch { broken = true; }
        }
        const durationMs = Date.now() - startedAt;
        const ttftMs = firstDataAt === undefined ? null : firstDataAt - startedAt;
        const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
        const outcome = !complete ? 'aborted' : (endError || status >= 400) ? 'error' : 'ok';
        const model = actualModel || lineage.modelUid;
        log('info', 'official-complete', {
          model, lineage: lineage.key, gapMs: token.gapMs,
          promptTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
          outputTokens: usage.outputTokens, ...credits, ttftMs, durationMs,
          ...(outcome === 'error' ? { error: endError?.code || 'http_' + status } : {}),
        });
        pushMetric({
          time: new Date().toISOString(), model, source: 'official', outcome, status, ttftMs, durationMs,
          usage: { inputTokens: promptTokens, outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens },
          credits,
        });
        warmer.observeEnd(lineage.key, token, { promptTokens, cacheReadTokens: usage.cacheReadTokens });
      },
    };
  };
  const handle = async (request, response) => {
    const incoming = new URL(request.url, upstreamOrigin);
    const rpc = incoming.pathname;
    const target = new URL(rpc + incoming.search, upstreamOrigin);
    if (request.method !== 'POST' || ![API_PREFIX + 'AssignModel', API_PREFIX + 'GetChatMessage'].includes(rpc)) {
      forward(request, response, target, { getCatalog, log, onFusionStatus, onNativeModels, idleTimeoutMs: 600000, retryRead: true, agent });
      return;
    }
    let body;
    try {
      body = await collect(request);
      const format = wire.decode(body, request.headers);
      const { config: current, stamp } = stampedConfig();
      const catalog = getCatalog(current, stamp);
      if (rpc.endsWith('/AssignModel')) {
        const resolved = resolveAssignment(format.data, format, catalog, lockedFusion);
        if (resolved) {
          const output = wire.encode(resolved, { ...format, gzip: false, compressed: false });
          response.writeHead(200, { 'content-type': format.type, 'content-length': output.length, 'connect-protocol-version': '1' });
          response.end(output);
          if (resolved.redirectedFrom) log('info', 'assignment-redirect', { from: resolved.redirectedFrom, bytes: output.length });
          else log('debug', 'assignment', { bytes: output.length });
          return;
        }
      } else {
        const chat = parseChat(format.data);
        const route = Object.hasOwn(catalog.routes, chat.modelUid) ? catalog.routes[chat.modelUid] : undefined;
        const lineageBase = chatLineage(format.data);
        const lineage = { key: lineageKey(route ? 'byok' : 'official', lineageBase), ...lineageBase };
        if (route) {
          const provider = current.providers.find(p => p.id === route.providerId);
          if (!provider) throw new Error('Provider missing');
          const abort = new AbortController();
          response.on('close', () => { if (!response.writableFinished) abort.abort(); });
          const settings = normalizeWarmSettings(current);
          const token = warmer.observeStart(lineage.key, {
            kind: 'byok', model: route.model, uid: chat.modelUid,
            cascadeId: lineage.cascadeId, sysHash: lineage.sysHash,
            payload: settings.enabled && settings.byok && provider.cacheWarm !== false ? { request: chat } : null,
            bytes: body.length, promptTokens: undefined,
            ttlSeconds: providerTtl(provider), apiFormat: provider.apiFormat,
            providerId: provider.id, excluded: provider.cacheWarm === false,
          });
          let observed = false;
          const observeEnd = usage => { if (!observed) { observed = true; warmer.observeEnd(lineage.key, token, usage || {}); } };
          log('info', 'inference', { model: route.model, uid: chat.modelUid, effort: route.effort, tools: chat.tools.length,
            messages: chat.messages.length, thinking: chat.messages.filter(x => x.thinking).length, signed: chat.messages.filter(x => x.signature).length });
          try {
            await serveChat({ request: chat, route, provider, res: response, signal: abort.signal,
              log: (event, data) => {
                if (event === 'chat-complete' || event === 'chat-error' || event === 'chat-aborted') {
                  pushMetric({ time: new Date().toISOString(), model: data.model, uid: data.uid,
                    outcome: event === 'chat-complete' ? 'ok' : event === 'chat-error' ? 'error' : 'aborted',
                    code: data.code, status: data.status, ttftMs: data.ttftMs, durationMs: data.durationMs,
                    usage: data.usage, retries: data.retries || 0 });
                  observeEnd(event === 'chat-complete' && data.usage
                    ? { promptTokens: data.usage.inputTokens, cacheReadTokens: data.usage.cacheReadTokens } : undefined);
                }
                log(event === 'chat-error' ? 'error' : 'info', event, data);
              },
              timeouts: { firstResponseMs: current.requestTimeoutMs, idleMs: current.requestTimeoutMs },
              retry: { max: Number.isSafeInteger(current.maxRetries) && current.maxRetries >= 0 && current.maxRetries <= 5 ? current.maxRetries : 2 } });
          } finally {
            observeEnd();
          }
          return;
        }
        // Official model: forward verbatim, with a read-only tap for the
        // passive measurement and (when enabled) a payload for warm replays.
        const settings = normalizeWarmSettings(current);
        const keepPayload = settings.enabled && settings.official && !format.json;
        if (settings.enabled && settings.official && format.json) log('debug', 'warm-json-skip', { model: lineage.modelUid });
        const token = warmer.observeStart(lineage.key, {
          kind: 'official', model: lineage.modelUid, uid: lineage.modelUid,
          cascadeId: lineage.cascadeId, sysHash: lineage.sysHash,
          payload: keepPayload ? { data: format.data, headers: { ...request.headers }, contentType: format.type } : null,
          bytes: body.length, apiFormat: 'official', excluded: false,
        });
        forward(request, response, target, { body, getCatalog, log, onFusionStatus, onNativeModels, idleTimeoutMs: 600000, agent,
          tap: format.json
            // JSON official requests aren't frame-parseable, but they still
            // hold a warmer token that must be released on completion.
            ? { onEnd: () => warmer.observeEnd(lineage.key, token, {}) }
            : officialTap({ format, request, lineage, token, startedAt: Date.now() }) });
        return;
      }
    } catch (error) {
      log('error', 'request-error', { code: 'request_failed', rpc: rpc.split('/').pop(), error: String(error?.message || error) });
      if (response.headersSent) { response.end(); return; }
      // Malformed data must never select a default provider.
    }
    if (body) forward(request, response, target, { body, getCatalog, log, onFusionStatus, onNativeModels, idleTimeoutMs: 600000, agent });
    else { response.writeHead(502); response.end(); }
  };
  const authorized = request => {
    const provided = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
    const expected = 'Bearer ' + controlToken;
    return Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  };
  const server = http.createServer((request, response) => {
    // DNS-rebinding guard: only loopback Host values for this exact port.
    const host = (request.headers.host || '').toLowerCase();
    const bound = server.address()?.port;
    if (bound && host !== `127.0.0.1:${bound}` && host !== `localhost:${bound}` && host !== `[::1]:${bound}`) {
      response.writeHead(403); response.end(); return;
    }
    if (request.headers.origin) { response.writeHead(403); response.end(); return; }
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ...identity, pid: process.pid, instanceId, managementProtocol: MANAGEMENT_PROTOCOL, nativeModelsProtocol: 1, logsProtocol: 1, activeRequests, draining })); return;
    }
    if (request.method === 'GET' && request.url === '/_runtime/native-models') {
      if (!authorized(request)) { response.writeHead(403); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ instanceId, models: [...observedNatives.values()] }));
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/_runtime/logs')) {
      if (!authorized(request)) { response.writeHead(403); response.end(); return; }
      const limit = Number(new URL(request.url, 'http://localhost').searchParams.get('limit')) || 200;
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ instanceId, entries: log.recent ? log.recent(limit) : [], metrics: summarize(metricsRing), warm: warmer.snapshot() }));
      return;
    }
    if (request.method === 'POST' && request.url === '/_runtime/shutdown') {
      if (!authorized(request)) { response.writeHead(403); response.end(); return; }
      if (activeRequests > 0) {
        response.writeHead(409, { 'content-type': 'application/json' }); response.end(JSON.stringify({ activeRequests })); return;
      }
      draining = true;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.once('finish', () => { close(); });
      response.end('{"stopping":true}');
      return;
    }
    if (draining) {
      response.writeHead(503); response.end(); return;
    }
    if (!/^\/exa\.[a-z_]+\.[A-Za-z]+Service\/[A-Za-z]+(?:\?|$)/.test(request.url)) {
      response.writeHead(404); response.end(); return;
    }
    activeRequests++;
    let settled = false;
    const settle = () => { if (!settled) { settled = true; activeRequests--; } };
    response.once('finish', settle); response.once('close', settle);
    handle(request, response).catch(error => {
      log('error', 'request-error', { code: 'request_failed', error: String(error?.message || error) });
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stateFile = controlFile(root), temporary = stateFile + '.' + instanceId;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...identity, instanceId, token: controlToken }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, stateFile);
  } catch (error) { fs.rmSync(temporary, { force: true }); server.close(); throw error; }
  function close() {
    if (closing) return closing;
    draining = true;
    warmer.dispose(); // abort in-flight warm pings before the drain
    closing = new Promise(resolve => {
      server.close(() => {
        agent?.destroy();
        try {
          if (JSON.parse(fs.readFileSync(stateFile, 'utf8')).instanceId === instanceId) fs.unlinkSync(stateFile);
        } catch { /* Another runtime may already own the control file. */ }
        resolveStopped(); resolve();
      });
      server.closeIdleConnections?.();
    });
    return closing;
  }
  log('info', 'ready', { port: server.address().port, version: VERSION });
  return { port: server.address().port, close, stopped, warmer };
}
if (require.main === module) {
  const root = process.argv[2];
  if (!root) process.exit(2);
  const port = Number(process.argv[3]) || PORT;
  const logger = createLogger({ level: process.env.DDEVIN_LOG_LEVEL || 'info', sinks: [fileSink(path.join(root, 'runtime.log'))] });
  const log = (level, event, data) => logger[level] ? logger[level](event, data) : logger.info(event, data);
  log.recent = limit => logger.recent(limit);
  log.setSecrets = values => logger.setSecrets(values);
  startBackend({ root, port, log }).then(backend => {
    backend.stopped.then(() => process.exit(0));
    for (const name of ['SIGTERM', 'SIGINT']) process.on(name, () => backend.close().then(() => process.exit(0)));
  }).catch(error => {
    log('error', 'startup-error', { code: error.code === 'EADDRINUSE' ? 'port_in_use' : 'startup_failed', error: String(error?.message || error) });
    process.exit(error.code === 'EADDRINUSE' ? 0 : 1);
  });
}
module.exports = { startBackend, runtimeIdentity, controlFile, createCatalogCache, summarize, PORT, VERSION, MANAGEMENT_PROTOCOL };
