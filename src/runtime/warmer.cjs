'use strict';

// Cache warmer: replays each conversation lineage's last real request with a
// tiny output cap before the upstream prompt cache TTL lapses, keeping the
// prefix cache hot. Pure scheduling logic — clock, timers, settings and the
// actual send are injected; payloads stay in memory and never enter the
// conversation (nothing is inserted, only re-sent with a smaller cap).
const WARM_DEFAULTS = {
  enabled: false, byok: true, official: false,
  ttlSeconds: 300, officialTtlSeconds: 300,
  whileStreaming: true, maxGapMinutes: 45, maxPingsPerGap: 'auto',
  minPrefixTokens: 4096, maxLineages: 6, pingMaxTokens: 4,
};
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_TRACKED = 20;
const MAX_INFLIGHT_PINGS = 2;
const OFFICIAL_COOLDOWN_MS = 10 * 60 * 1000;
const TRANSIENT_RETRY_MS = 15000;
const MIN_REASONABLE_CAP = 16;

// config.cacheWarm is free-form user input — every field validates against
// its bounds and falls back individually, so panel and backend share one
// interpretation even though readConfig is a shallow merge.
function normalizeWarmSettings(config = {}) {
  const source = config && typeof config.cacheWarm === 'object' && config.cacheWarm !== null && !Array.isArray(config.cacheWarm)
    ? config.cacheWarm : {};
  const bool = (key, fallback) => typeof source[key] === 'boolean' ? source[key] : fallback;
  const int = (key, fallback, low, high) =>
    Number.isSafeInteger(source[key]) && source[key] >= low && source[key] <= high ? source[key] : fallback;
  return {
    enabled: bool('enabled', WARM_DEFAULTS.enabled),
    byok: bool('byok', WARM_DEFAULTS.byok),
    official: bool('official', WARM_DEFAULTS.official),
    ttlSeconds: int('ttlSeconds', WARM_DEFAULTS.ttlSeconds, 60, 3600),
    officialTtlSeconds: int('officialTtlSeconds', WARM_DEFAULTS.officialTtlSeconds, 60, 3600),
    whileStreaming: bool('whileStreaming', WARM_DEFAULTS.whileStreaming),
    maxGapMinutes: int('maxGapMinutes', WARM_DEFAULTS.maxGapMinutes, 5, 240),
    maxPingsPerGap: source.maxPingsPerGap === undefined || source.maxPingsPerGap === 'auto' ? 'auto'
      : int('maxPingsPerGap', 'auto', 1, 60),
    minPrefixTokens: int('minPrefixTokens', WARM_DEFAULTS.minPrefixTokens, 256, 200000),
    maxLineages: int('maxLineages', WARM_DEFAULTS.maxLineages, 1, 32),
    pingMaxTokens: int('pingMaxTokens', WARM_DEFAULTS.pingMaxTokens, 2, 64),
  };
}

// Fire early enough to renew before expiry: ttl minus 20% clamped to 30–60s.
function intervalSeconds(ttlSeconds) {
  return ttlSeconds - Math.min(Math.max(Math.round(ttlSeconds * 0.2), 30), 60);
}

// info = { kind, model, uid, cascadeId, sysHash, payload, bytes, promptTokens,
//          ttlSeconds, apiFormat, providerId, excluded }
// send(lineage, { signal, maxTokens }) resolves to one of:
//   { kind:'ok', latencyMs, usage:{promptTokens,cacheReadTokens,cacheWriteTokens,outputTokens}|null, credits? }
//   { kind:'error', latencyMs, code, status?, fatal, transient, capRejected?, cooldown? }
//   { kind:'cancelled' }
function createWarmer({ now = Date.now, setInterval: arm = setInterval, clearInterval: disarm = clearInterval,
  sweepMs = 15000, autoSweep = true, getSettings, send, log = () => {} } = {}) {
  const lineages = new Map();
  let inFlightPings = 0, officialInFlightPings = 0, officialCooldownUntil = 0;
  const totals = { sent: 0, hits: 0, misses: 0, unknowns: 0, errors: 0,
    readTokens: 0, avoidedTokens: 0, resumeHits: 0, resumeAttempts: 0,
    creditCost: 0, committedCreditCost: 0, acuCost: 0 };
  const settings = () => ({ ...WARM_DEFAULTS, ...(getSettings?.() || {}) });
  const ttlOf = (lineage, s) => lineage.providerTtl ?? (lineage.kind === 'official' ? s.officialTtlSeconds : s.ttlSeconds);
  const promptTokensOf = lineage => Number.isSafeInteger(lineage.promptTokens) && lineage.promptTokens > 0
    ? lineage.promptTokens : Math.floor((lineage.bytes || 0) / 4);
  const capFor = (lineage, s) => {
    const configured = s.maxPingsPerGap === 'auto'
      ? (lineage.kind === 'official' ? 6 : lineage.apiFormat === 'anthropic' ? 11 : 9)
      : s.maxPingsPerGap;
    return Math.max(1, Math.min(configured, Math.floor(s.maxGapMinutes * 60 / intervalSeconds(ttlOf(lineage, s)))));
  };
  const skip = (lineage, reason) => {
    if (lineage.skipReason === reason) return;
    lineage.skipReason = reason;
    log('debug', 'warm-skip', { lineage: lineage.key.slice(0, 8), reason });
  };

  function stop(lineage, reason) {
    lineage.pingController?.abort();
    if (lineage.stopped) { lineage.stopReason = reason; return; }
    lineage.stopped = true;
    lineage.stopReason = reason;
    lineage.payload = null; // release memory; metadata stays for the panel
    log('info', 'warm-stop', { lineage: lineage.key.slice(0, 8), kind: lineage.kind, model: lineage.model, reason });
  }

  function applyInfo(lineage, info) {
    if (typeof info.model === 'string') lineage.model = info.model;
    if (typeof info.uid === 'string') lineage.uid = info.uid;
    if (typeof info.cascadeId === 'string') lineage.cascadeId = info.cascadeId;
    if (typeof info.sysHash === 'string') lineage.sysHash = info.sysHash;
    if (typeof info.providerId === 'string') lineage.providerId = info.providerId;
    if (typeof info.apiFormat === 'string') lineage.apiFormat = info.apiFormat;
    lineage.excluded = info.excluded === true;
    lineage.providerTtl = Number.isSafeInteger(info.ttlSeconds) && info.ttlSeconds > 0 ? info.ttlSeconds : undefined;
    lineage.payload = info.payload ?? null;
    lineage.bytes = Number.isSafeInteger(info.bytes) && info.bytes > 0 ? info.bytes : 0;
    if (Number.isSafeInteger(info.promptTokens) && info.promptTokens > 0) lineage.promptTokens = info.promptTokens;
  }

  // A real request started: abort any in-flight ping (the response would be
  // stale), refresh the stored payload, and arm the resume check when pings
  // already renewed the cache this gap.
  function observeStart(key, info = {}) {
    const t = now();
    let lineage = lineages.get(key);
    const prevRealAt = lineage && lineage.requestToken > 0 ? lineage.lastRealAt : undefined;
    if (lineage) {
      lineage.pingController?.abort();
      if (lineage.gapPings > 0) {
        lineage.pendingResume = { pings: lineage.gapPings, prevPrompt: promptTokensOf(lineage), pingReadTokens: lineage.lastPing?.cacheReadTokens };
      }
      lineage.stopped = false;
      lineage.stopReason = '';
      lineage.gapPings = 0;
      lineage.missStreak = 0;
      lineage.transientRetryAt = 0;
      lineage.transientRetried = false;
      lineage.skipReason = '';
      applyInfo(lineage, info);
    } else {
      // Switching model/effort inside one cascade supersedes the sibling
      // lineage (same kind + session + system prompt, different uid).
      if (info.cascadeId) {
        for (const other of lineages.values()) {
          if (!other.stopped && other.kind === info.kind && other.cascadeId === info.cascadeId &&
              other.sysHash === info.sysHash && other.uid !== info.uid) stop(other, 'superseded');
        }
      }
      lineage = {
        key, kind: info.kind === 'official' ? 'official' : 'byok',
        model: '', uid: '', cascadeId: '', sysHash: '', providerId: '', apiFormat: '',
        payload: null, bytes: 0, promptTokens: undefined, providerTtl: undefined, excluded: false,
        createdAt: t, lastRealAt: t, lastSentAt: t,
        inFlightReal: 0, requestToken: 0,
        pingController: null, transientRetryAt: 0, transientRetried: false, capOverride: 0,
        gapPings: 0, missStreak: 0, verified: false,
        stopped: false, stopReason: '', skipReason: '',
        hits: 0, misses: 0, unknowns: 0, errors: 0,
        lastPing: null, pendingResume: null,
      };
      applyInfo(lineage, info);
      lineages.set(key, lineage);
    }
    lineage.inFlightReal++;
    lineage.requestToken++;
    lineage.lastRealAt = t;
    lineage.lastSentAt = t; // the cache refreshes while the request is served
    evict();
    return { seq: lineage.requestToken, gapMs: prevRealAt === undefined ? null : t - prevRealAt };
  }

  // Overlapping real requests on one lineage each hold a token; every token
  // decrements inFlightReal exactly once, but only the newest token's end
  // carries the usage/pending-resume signal.
  function observeEnd(key, token, usage = {}) {
    const lineage = lineages.get(key);
    if (!lineage || !token || token.ended) return;
    token.ended = true;
    lineage.inFlightReal = Math.max(0, lineage.inFlightReal - 1);
    if (lineage.requestToken !== token.seq) return;
    if (Number.isSafeInteger(usage.promptTokens) && usage.promptTokens > 0) lineage.promptTokens = usage.promptTokens;
    if (!lineage.pendingResume) return;
    const pending = lineage.pendingResume;
    lineage.pendingResume = null;
    // Without a cache-read figure the resume is inconclusive, not a miss.
    if (!Number.isSafeInteger(usage.cacheReadTokens)) return;
    const hit = usage.cacheReadTokens >= 0.8 * pending.prevPrompt;
    totals.resumeAttempts++;
    if (hit) { totals.resumeHits++; totals.avoidedTokens += pending.prevPrompt; }
    log('info', 'warm-resume', { lineage: key.slice(0, 8), hit, read: usage.cacheReadTokens, prev: pending.prevPrompt, pings: pending.pings });
  }

  function settlePing(lineage, result, s) {
    const t = now();
    if (!result || result.kind === 'cancelled') return;
    if (result.kind === 'ok') {
      const usage = result.usage && typeof result.usage === 'object' ? result.usage : {};
      const read = Number.isSafeInteger(usage.cacheReadTokens) && usage.cacheReadTokens >= 0 ? usage.cacheReadTokens : undefined;
      let outcome;
      if (read === undefined) { outcome = 'unknown'; lineage.unknowns++; totals.unknowns++; }
      else if (read > 0) { outcome = 'hit'; lineage.hits++; totals.hits++; lineage.verified = true; lineage.missStreak = 0; }
      else { outcome = 'miss'; lineage.misses++; totals.misses++; lineage.missStreak++; }
      if (read !== undefined) totals.readTokens += read;
      const credits = result.credits && typeof result.credits === 'object' ? result.credits : undefined;
      if (credits) {
        if (Number.isFinite(credits.creditCost)) totals.creditCost += credits.creditCost;
        if (Number.isFinite(credits.committedCreditCost)) totals.committedCreditCost += credits.committedCreditCost;
        if (Number.isFinite(credits.committedAcuCost)) totals.acuCost += credits.committedAcuCost;
      }
      lineage.transientRetried = false;
      lineage.gapPings++;
      lineage.lastPing = { at: t, outcome, cacheReadTokens: read, promptTokens: usage.promptTokens,
        outputTokens: usage.outputTokens, latencyMs: result.latencyMs, credits };
      if (Number.isSafeInteger(usage.promptTokens) && usage.promptTokens > 0) lineage.promptTokens = usage.promptTokens;
      log('info', 'warm-ping', { lineage: lineage.key.slice(0, 8), kind: lineage.kind, model: lineage.model, outcome,
        cacheReadTokens: read, promptTokens: usage.promptTokens, outputTokens: usage.outputTokens,
        latencyMs: result.latencyMs, ...(credits ? { credits } : {}) });
      if (lineage.missStreak >= 2) { stop(lineage, 'cache_miss'); return; }
      if (lineage.gapPings >= capFor(lineage, s)) stop(lineage, 'cap');
      return;
    }
    lineage.errors++;
    totals.errors++;
    lineage.lastPing = { at: t, outcome: 'error', code: result.code, status: result.status, latencyMs: result.latencyMs };
    if (result.cooldown) officialCooldownUntil = Math.max(officialCooldownUntil, t + OFFICIAL_COOLDOWN_MS);
    log('info', 'warm-ping', { lineage: lineage.key.slice(0, 8), kind: lineage.kind, model: lineage.model, outcome: 'error',
      code: result.code, status: result.status, latencyMs: result.latencyMs });
    if (result.capRejected && (lineage.capOverride || s.pingMaxTokens) < MIN_REASONABLE_CAP) {
      lineage.capOverride = MIN_REASONABLE_CAP;
      lineage.transientRetryAt = t; // eligible again on the next sweep
      return;
    }
    if (result.transient === true && result.fatal !== true) {
      if (lineage.transientRetried) { lineage.transientRetried = false; stop(lineage, 'lapsed'); }
      else { lineage.transientRetried = true; lineage.transientRetryAt = t + TRANSIENT_RETRY_MS; }
      return;
    }
    stop(lineage, 'rejected:' + (result.code || 'error'));
  }

  function sendPing(lineage, s, t) {
    const controller = new AbortController();
    lineage.pingController = controller;
    lineage.skipReason = '';
    lineage.transientRetryAt = 0;
    lineage.lastSentAt = t;
    inFlightPings++;
    if (lineage.kind === 'official') officialInFlightPings++;
    totals.sent++;
    const maxTokens = lineage.capOverride || s.pingMaxTokens;
    let settled = false;
    const settle = result => {
      if (settled || lineage.pingController !== controller) return;
      settled = true;
      lineage.pingController = null;
      inFlightPings--;
      if (lineage.kind === 'official') officialInFlightPings--;
      try { settlePing(lineage, result, s); } catch {}
    };
    try {
      Promise.resolve(send(lineage, { signal: controller.signal, maxTokens }))
        .then(settle, () => settle({ kind: 'error', code: 'send_failed', fatal: false, transient: true }));
    } catch {
      settle({ kind: 'error', code: 'send_failed', fatal: false, transient: true });
    }
  }

  function tick() {
    const t = now();
    const s = settings();
    for (const lineage of [...lineages.values()]) {
      const kindOn = lineage.kind === 'official' ? s.official : s.byok;
      if (!s.enabled || !kindOn || lineage.excluded) {
        if (lineage.payload || lineage.pingController) { lineage.pingController?.abort(); lineage.payload = null; }
        continue;
      }
      if (lineage.stopped || !lineage.payload || lineage.pingController) continue;
      if (t - lineage.lastRealAt > s.maxGapMinutes * 60000) { stop(lineage, 'max_gap'); continue; }
      if (!(promptTokensOf(lineage) >= s.minPrefixTokens)) { skip(lineage, 'too_small'); continue; }
      if (lineage.inFlightReal > 0 && !(lineage.kind === 'byok' && s.whileStreaming)) { skip(lineage, 'in_flight'); continue; }
      const due = (lineage.transientRetryAt > 0 && t >= lineage.transientRetryAt) ||
        t >= lineage.lastSentAt + intervalSeconds(ttlOf(lineage, s)) * 1000;
      if (!due) { skip(lineage, 'not_due'); continue; }
      if (inFlightPings >= MAX_INFLIGHT_PINGS) { skip(lineage, 'global_busy'); continue; }
      if (lineage.kind === 'official' && (officialInFlightPings > 0 || t < officialCooldownUntil)) { skip(lineage, 'official_busy'); continue; }
      sendPing(lineage, s, t);
    }
  }

  // Live lineages cap at maxLineages (LRU by last real request); stopped
  // metadata is retained until the panel list itself exceeds MAX_TRACKED.
  function evict() {
    const s = settings();
    const live = [...lineages.values()].filter(l => !l.stopped).sort((a, b) => a.lastRealAt - b.lastRealAt);
    for (const victim of live.slice(0, Math.max(0, live.length - s.maxLineages))) {
      victim.pingController?.abort();
      lineages.delete(victim.key);
    }
    let bytes = 0;
    for (const lineage of lineages.values()) if (lineage.payload) bytes += lineage.bytes || 0;
    if (bytes > MAX_PAYLOAD_BYTES) {
      const candidates = [...lineages.values()].filter(l => l.payload).sort((a, b) => a.lastRealAt - b.lastRealAt);
      for (const victim of candidates) {
        if (bytes <= MAX_PAYLOAD_BYTES) break;
        bytes -= victim.bytes || 0;
        stop(victim, 'evicted');
      }
    }
    const tracked = [...lineages.values()].sort((a, b) => a.lastRealAt - b.lastRealAt);
    for (const victim of tracked.slice(0, Math.max(0, tracked.length - MAX_TRACKED))) {
      victim.pingController?.abort();
      lineages.delete(victim.key);
    }
  }

  function snapshot() {
    const t = now();
    const s = settings();
    return {
      now: t,
      totals: { ...totals },
      officialCooldownUntil: officialCooldownUntil || undefined,
      lineages: [...lineages.values()].map(lineage => {
        const interval = intervalSeconds(ttlOf(lineage, s)) * 1000;
        return {
          key: lineage.key.slice(0, 8), kind: lineage.kind, model: lineage.model, uid: lineage.uid,
          cascadeId: lineage.cascadeId || undefined,
          state: lineage.stopped ? 'stopped' : lineage.inFlightReal > 0 ? 'streaming' : lineage.pingController ? 'pinging' : 'waiting',
          stopReason: lineage.stopReason || undefined, verified: lineage.verified, hasPayload: !!lineage.payload,
          nextAt: lineage.stopped || !lineage.payload ? null
            : Math.max(lineage.lastSentAt + interval, lineage.transientRetryAt || 0),
          gapPings: lineage.gapPings, cap: capFor(lineage, s),
          hits: lineage.hits, misses: lineage.misses, unknowns: lineage.unknowns, errors: lineage.errors,
          lastRead: lineage.lastPing?.cacheReadTokens, promptTokens: promptTokensOf(lineage),
        };
      }),
    };
  }

  function dispose() {
    if (timer) { disarm(timer); timer = undefined; }
    for (const lineage of lineages.values()) lineage.pingController?.abort();
  }

  let timer;
  if (autoSweep !== false && typeof arm === 'function') {
    timer = arm(tick, sweepMs);
    timer?.unref?.();
  }
  return { observeStart, observeEnd, tick, snapshot, dispose };
}

module.exports = { createWarmer, normalizeWarmSettings, intervalSeconds, WARM_DEFAULTS };
