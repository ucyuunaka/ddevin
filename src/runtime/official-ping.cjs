'use strict';

// Official cache-warming ping: replays a real GetChatMessage verbatim (session
// tokens, history, prompt_cache_key, model_assignment_jwt all untouched) with
// only max_tokens floored and execution_id refreshed. Reads the Connect stream
// to EOF for usage and billing fields — the warmer's evidence that the prefix
// cache is still hot.
const zlib = require('node:zlib');
const wire = require('../protocol/wire.cjs');
const { patchChatRequestForWarm, parseChatResponseMeta } = require('../protocol/chat.cjs');
const { stripHop, REQ_HOP } = require('./bridge.cjs');
const RPC = '/exa.api_server_pb.ApiServerService/GetChatMessage';
const MAX_OUTPUT_BYTES = 8192;
const FATAL_CONNECT = new Set(['invalid_argument', 'unauthenticated', 'permission_denied', 'failed_precondition', 'not_found']);
const TRANSIENT_CONNECT = new Set(['unavailable', 'deadline_exceeded', 'internal', 'unknown']);

// payload = { data (inner proto Buffer), headers, contentType } captured when
// the real request was forwarded. Returns the warmer sender contract.
async function sendOfficialPing({ origin, payload, maxTokens, signal, timeoutMs = 60000, request = fetch } = {}) {
  const startedAt = Date.now();
  const failure = (code, extra = {}) => ({ kind: 'error', latencyMs: Date.now() - startedAt, code, fatal: false, transient: true, ...extra });
  if (!payload || !Buffer.isBuffer(payload.data)) return failure('no_payload', { fatal: true, transient: false });
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000);
  timer.unref?.();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) return { kind: 'cancelled' };
    const patched = patchChatRequestForWarm(payload.data, maxTokens);
    const connect = String(payload.contentType || '').startsWith('application/connect+');
    // A Connect request body is the single data frame — unlike wire.encode,
    // which appends the response-side end-of-stream marker.
    const body = connect ? wire.frame(patched, 0) : patched;
    const headers = stripHop({ ...payload.headers }, REQ_HOP);
    for (const name of ['host', 'content-length', 'origin', 'content-encoding', 'connect-content-encoding']) delete headers[name];
    headers['content-type'] = payload.contentType || 'application/proto';
    headers['accept-encoding'] = 'identity';
    const response = await request(String(origin).replace(/\/$/, '') + RPC, {
      method: 'POST', headers, body, signal: controller.signal, redirect: 'error',
    });
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel().catch(() => {});
      if ([400, 401, 403, 404, 422].includes(status)) return failure('http_' + status, { status, fatal: true, transient: false });
      if (status === 429) return failure('http_429', { status, cooldown: true });
      if (status >= 500) return failure('http_' + status, { status });
      return failure('http_' + status, { status, fatal: true, transient: false });
    }
    const usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
    const credits = { creditCost: 0, committedCreditCost: 0, committedAcuCost: 0 };
    const seen = { usage: false, credits: false };
    let endError, textBytes = 0;
    const merge = data => {
      const meta = parseChatResponseMeta(data);
      if (meta.usage) {
        seen.usage = true;
        for (const key of ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens']) {
          if (meta.usage[key]) usage[key] = meta.usage[key];
        }
      }
      for (const name of ['creditCost', 'committedCreditCost', 'committedAcuCost']) {
        if (meta[name]) { seen.credits = true; credits[name] = meta[name]; }
      }
      for (const field of wire.fields(data, 3)) textBytes += field.value.length;
      for (const field of wire.fields(data, 9)) textBytes += field.value.length;
      if (textBytes > MAX_OUTPUT_BYTES) {
        const err = new Error('Warm ping output overflow');
        err.code = 'output_overflow';
        throw err;
      }
    };
    const read = wire.createFrameReader((flags, data) => {
      let chunk = data;
      if (flags & 1) chunk = zlib.gunzipSync(chunk);
      if (flags & 2) {
        try { endError = JSON.parse(chunk.toString('utf8'))?.error; } catch {}
        return;
      }
      merge(chunk);
    });
    if (String(response.headers.get('content-type') || '').startsWith('application/connect+')) {
      for await (const chunk of response.body) read(chunk);
    } else if (response.body) {
      const chunks = [];
      for await (const chunk of response.body) chunks.push(chunk);
      if (chunks.length) merge(Buffer.concat(chunks));
    }
    if (endError) {
      const code = String(endError.code || 'unknown');
      if (FATAL_CONNECT.has(code)) return failure(code, { fatal: true, transient: false });
      if (code === 'resource_exhausted') return failure(code, { fatal: true, transient: false, cooldown: true });
      return failure(code, { transient: TRANSIENT_CONNECT.has(code) || !FATAL_CONNECT.has(code) });
    }
    return {
      kind: 'ok', latencyMs: Date.now() - startedAt,
      usage: seen.usage ? {
        promptTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
        cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, outputTokens: usage.outputTokens,
      } : null,
      ...(seen.credits ? { credits } : {}),
    };
  } catch (error) {
    if (signal?.aborted) return { kind: 'cancelled' };
    if (timedOut) return failure('timeout');
    return failure(error?.code === 'output_overflow' ? 'output_overflow' : 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

module.exports = { sendOfficialPing };
