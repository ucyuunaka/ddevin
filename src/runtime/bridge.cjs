'use strict';

// HTTP forwarding shared by the backend (devin-cli -> server.codeium.com)
// and the per-window LS bridge (renderer -> language server).
const http = require('node:http');
const https = require('node:https');
const wire = require('../protocol/wire.cjs');
const { augmentCatalog, collectNativeModels, ownUid } = require('../catalog.cjs');
function countOwn(value, depth = 0) {
  if (depth > 7) return 0;
  if (Buffer.isBuffer(value)) {
    if (ownUid(value.toString('utf8'))) return 1;
    try { return wire.parseFields(value).filter(f => f.wire === 2).reduce((n, f) => n + countOwn(f.value, depth + 1), 0); } catch { return 0; }
  }
  if (typeof value === 'string') return ownUid(value) ? 1 : 0;
  if (value && typeof value === 'object') return Object.values(value).reduce((n, v) => n + countOwn(v, depth + 1), 0);
  return 0;
}
const CATALOG = /^\/exa\.(?:language_server_pb\.LanguageServerService|api_server_pb\.ApiServerService|seat_management_pb\.SeatManagementService)\/(?:GetUserStatus|GetCliModelConfigs|GetCascadeModelConfigs|GetCommandModelConfigs)$|^\/exa\.seat_management_pb\.SeatManagementService\/GetCliTeamSettings$/;
// Replay only known reads. Inference and assignment must never be retried here.
const READ_RPC = /^\/exa\.(?:api_server_pb\.ApiServerService\/(?:GetCliModelConfigs|GetCascadeModelConfigs|GetCommandModelConfigs|GetPlanStatus)|seat_management_pb\.SeatManagementService\/(?:GetCliTeamSettings|GetUserStatus|GetPlanStatus))$/;
const RETRY_STATUS = new Set([502, 503, 504]);
const RETRY_ERROR = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN']);
function cors(request) {
  const origin = request.headers.origin;
  return origin && /^(?:vscode-file:\/\/vscode-app|vscode-webview:\/\/[^/]+|https?:\/\/(?:[a-z0-9.-]+\.)?localhost(?::\d+)?)$/.test(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {};
}
async function collect(stream, limit = 64 * 1024 * 1024) {
  const chunks = []; let length = 0;
  for await (const chunk of stream) { length += chunk.length; if (length > limit) throw new Error('Message too large'); chunks.push(chunk); }
  return Buffer.concat(chunks, length);
}
// Hop-by-hop headers must not survive a relay (RFC 9110 7.6.1): the fixed
// set plus whatever the sender's own `connection` header lists.
const REQ_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade', 'transfer-encoding']);
const RES_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade']);
function stripHop(headers, names) {
  for (const listed of String(headers.connection || '').split(',')) delete headers[listed.trim().toLowerCase()];
  for (const name of names) delete headers[name];
  return headers;
}
function forward(request, response, target, options = {}) {
  const { body, retryRead = false, log = () => {} } = options;
  if (!retryRead || request.method !== 'POST' || !READ_RPC.test(target.pathname)) {
    forwardOnce(request, response, target, options);
    return;
  }
  let attempt = 0, timer;
  const cancelled = () => request.aborted || response.destroyed || response.writableEnded;
  response.once('close', () => clearTimeout(timer));
  const send = payload => {
    if (cancelled()) return;
    attempt++;
    forwardOnce(request, response, target, { ...options, body: payload,
      // Bound all three attempts to fit the host's authentication deadline.
      headerTimeoutMs: 2500,
      onFailure: failure => {
        if (cancelled() || attempt >= 3 ||
            !(RETRY_STATUS.has(failure.status) || RETRY_ERROR.has(failure.code))) return false;
        log('warn', 'official-read-retry', { rpc: target.pathname.split('/').pop(),
          upstreamHost: target.hostname, attempt, ...failure });
        timer = setTimeout(() => send(payload), attempt * 150);
        return true;
      } });
  };
  if (body !== undefined) send(body);
  else collect(request).then(send, () => {
    if (!cancelled()) { response.writeHead(400); response.end(); }
  });
}

function forwardOnce(request, response, target, { body, getCatalog, log = () => {}, onFusionStatus, onNativeModels, idleTimeoutMs, tap, headerTimeoutMs, onFailure, agent } = {}) {
  let incoming;
  let failed = false, headerTimer;
  // The tap contract promises onEnd exactly once, on whichever terminal event
  // (upstream end, close, or any failure path below) arrives first.
  let ended = false;
  const end = complete => { if (!ended) { ended = true; try { tap?.onEnd?.(complete); } catch {} } };
  const fail = (error = {}) => {
    if (failed) return;
    failed = true;
    clearTimeout(headerTimer);
    incoming?.destroy();
    outbound.destroy();
    cleanup();
    if (response.destroyed || response.writableEnded) { end(false); return; }
    // Log codes only: error messages and request data can contain credentials.
    const failure = { ...(typeof error.code === 'string' ? { code: error.code } : {}),
      ...(Number.isInteger(error.status) ? { status: error.status } : {}) };
    if (!response.headersSent && onFailure?.(failure)) return;
    end(false);
    log('error', 'forward-failed', { rpc: target.pathname.split('/').pop(), upstreamHost: target.hostname,
      code: failure.code || 'upstream_incomplete', ...(failure.status ? { status: failure.status } : {}) });
    if (response.headersSent) response.destroy();
    else { response.writeHead(502); response.end(); }
  };
  const headers = stripHop({ ...request.headers, host: target.host }, REQ_HOP);
  if (body !== undefined) headers['content-length'] = String(body.length);
  const outbound = (target.protocol === 'https:' ? https : http).request(target, {
    method: request.method, headers, ...(target.protocol === 'https:' && agent ? { agent } : {}),
  }, async upstream => {
    clearTimeout(headerTimer);
    incoming = upstream;
    if (onFailure && RETRY_STATUS.has(upstream.statusCode) && onFailure({ status: upstream.statusCode })) {
      failed = true;
      upstream.destroy(); outbound.destroy(); cleanup();
      return;
    }
    if (upstream.statusCode >= 500) log('warn', 'forward-upstream-error', {
      rpc: target.pathname.split('/').pop(), upstreamHost: target.hostname, status: upstream.statusCode });
    upstream.on('error', fail);
    upstream.on('aborted', fail);
    upstream.on('close', () => { if (!upstream.complete) fail(); });
    if (!CATALOG.test(target.pathname) || upstream.statusCode !== 200 || !getCatalog) {
      response.writeHead(upstream.statusCode, stripHop({ ...upstream.headers, ...cors(request) }, RES_HOP));
      // Passive response observer (official usage/billing measurement): the
      // taps are invoked next to the pipe and never alter the forwarded bytes.
      if (tap) {
        try { tap.onResponse?.({ statusCode: upstream.statusCode, headers: upstream.headers }); } catch {}
        upstream.on('data', chunk => { try { tap.onData?.(chunk); } catch {} });
        upstream.once('end', () => end(true));
        upstream.once('close', () => end(false));
      }
      upstream.pipe(response); return;
    }
    try {
      const original = await collect(upstream); let outgoing = original;
      const outgoingHeaders = stripHop({ ...upstream.headers, ...cors(request) }, RES_HOP);
      try {
        const format = wire.decode(original, upstream.headers);
        const observed = collectNativeModels(format.data, { rpc: target.pathname, format });
        if (observed.length) try { onNativeModels?.(observed); } catch {}
        const catalog = getCatalog();
        const augmented = augmentCatalog(format.data, { rpc: target.pathname, format, catalog, onFusionStatus });
        outgoing = wire.encode(augmented, { ...format, gzip: false, compressed: false });
        delete outgoingHeaders['content-encoding']; delete outgoingHeaders['connect-content-encoding'];
        delete outgoingHeaders['transfer-encoding']; outgoingHeaders['content-length'] = String(outgoing.length);
        log('debug', 'catalog', () => ({ rpc: target.pathname.split('/').pop(), models: catalog.models.length, format: format.type, changed: !original.equals(outgoing), before: original.length, after: outgoing.length, beforeOwn: countOwn(format.data), afterOwn: countOwn(augmented) }));
      } catch (error) { log('warn', 'catalog-error', { code: 'catalog_transform_failed', error: String(error?.message || error) }); }
      response.writeHead(upstream.statusCode, outgoingHeaders); response.end(outgoing);
    } catch (error) { fail(error); }
  });
  outbound.on('error', fail);
  outbound.on('close', () => { clearTimeout(headerTimer); if (!failed) end(false); });
  if (headerTimeoutMs > 0) headerTimer = setTimeout(() => fail({ code: 'ETIMEDOUT' }), headerTimeoutMs);
  if (idleTimeoutMs > 0) outbound.setTimeout(idleTimeoutMs, () => fail({ code: 'ETIMEDOUT' }));
  const abort = () => { clearTimeout(headerTimer); incoming?.destroy(); outbound.destroy(); cleanup(); };
  const closed = () => { if (!response.writableFinished) abort(); else cleanup(); };
  const cleanup = () => {
    // Aborted streams can emit their error after close/aborted; keep their
    // handler until the stream is collected to avoid an unhandled reset.
    if (!request.aborted) request.removeListener('error', fail);
    request.removeListener('aborted', abort);
    if (!response.destroyed) response.removeListener('error', fail);
    response.removeListener('close', closed);
  };
  request.on('error', fail);
  request.on('aborted', abort);
  response.on('error', fail);
  response.on('close', closed);
  if (body !== undefined) outbound.end(body); else request.pipe(outbound);
}
async function createLsBridge(originalPort, options) {
  const server = http.createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { ...cors(request), 'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-allow-headers': request.headers['access-control-request-headers'] || 'content-type,x-codeium-csrf-token,connect-protocol-version', 'access-control-max-age': '600' });
      response.end(); return;
    }
    // The renderer uses origin-form RPC paths. Never let an absolute URL turn
    // this per-window LS bridge into a proxy for another host.
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
      response.writeHead(400); response.end(); return;
    }
    forward(request, response, new URL('http://127.0.0.1:' + originalPort + request.url), options);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
module.exports = { createLsBridge, forward, collect, stripHop, REQ_HOP, RES_HOP };
