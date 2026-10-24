'use strict';

// ddevin logging: leveled, event-shaped records ({time, level, event, ...}).
// Sinks: LogOutputChannel (extension host), runtime.log JSONL (backend),
// and an in-memory ring buffer the panel can tail via /_runtime/logs.
const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const SECRET_KEY = /api[-_]?key|token(?!s)|authorization|secret|password|credential/i;

function sanitize(value, secrets, depth = 0) {
  if (depth > 4) return '[depth]';
  if (typeof value === 'string') {
    if (value.length > 2000) value = value.slice(0, 2000) + '…';
    // Exact configured secrets redact even when they do not match a key shape.
    for (const secret of secrets || []) if (secret) value = value.split(secret).join('[redacted]');
    // Redact key-shaped tokens anywhere in the string (e.g. inside upstream
    // error details), not just when the whole value is a key.
    return value.replace(/\b(?:sk|xpk)-[\w.-]{8,}|\bBearer\s+[\w.-]{8,}/gi, '[redacted]');
  }
  if (Array.isArray(value)) return depth >= 4 ? '[array]' : value.map(v => sanitize(v, secrets, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : sanitize(v, secrets, depth + 1);
    return out;
  }
  return value;
}

function createLogger({ level = 'info', sinks = [], ringSize = 400 } = {}) {
  let threshold = LEVELS[level] ?? LEVELS.info;
  const ring = [];
  let secrets = new Set();
  const write = (lvl, event, data) => {
    if ((LEVELS[lvl] ?? 30) < threshold) return;
    let value;
    if (typeof data === 'function') { try { value = data(); } catch { value = { logDataError: true }; } }
    else value = data;
    const record = { time: new Date().toISOString(), level: lvl, event, ...(value ? sanitize(value, secrets) : {}) };
    ring.push(record);
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
    for (const sink of sinks) {
      try { sink(record); } catch { /* A log sink must never break callers. */ }
    }
  };
  return {
    trace: (event, data) => write('trace', event, data),
    debug: (event, data) => write('debug', event, data),
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
    setLevel: lvl => { if (LEVELS[lvl]) threshold = LEVELS[lvl]; },
    // Exact values (e.g. configured apiKeys) redact verbatim; short strings
    // are ignored so common substrings cannot corrupt the logs.
    setSecrets: values => { secrets = new Set((values || []).filter(v => typeof v === 'string' && v.length >= 6)); },
    get level() { return Object.keys(LEVELS).find(k => LEVELS[k] === threshold) || 'info'; },
    recent: (limit = 200) => ring.slice(-Math.max(1, Math.min(limit, ringSize))),
  };
}

// Extension-host sink: forward to a vscode LogOutputChannel when available,
// falling back to a plain OutputChannel (single appendLine API).
function outputChannelSink(channel) {
  const has = name => typeof channel?.[name] === 'function';
  const line = r => `[${r.event}] ${JSON.stringify({ ...r, time: undefined, level: undefined, event: undefined })}`;
  return record => {
    const { level } = record;
    if (level === 'error' && has('error')) channel.error(line(record));
    else if (level === 'warn' && has('warn')) channel.warn(line(record));
    else if (level === 'debug' && has('debug')) channel.debug(line(record));
    else if (level === 'trace' && has('trace')) channel.trace(line(record));
    else if (has('info')) channel.info(line(record));
    else if (has('appendLine')) channel.appendLine(`[${record.time}] [${level}] ${line(record)}`);
  };
}

// Backend file sink: append JSONL, rotate at ~2 MB into <file>.previous.
function fileSink(file, maxBytes = 2 * 1024 * 1024) {
  return record => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
        try { fs.renameSync(file, file + '.previous'); } catch {}
      }
      fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
    } catch {}
  };
}

module.exports = { createLogger, outputChannelSink, fileSink, sanitize };
