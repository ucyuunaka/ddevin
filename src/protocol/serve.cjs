'use strict';

// Serve one intercepted GetChatMessage call: translate to the configured
// upstream provider (OpenAI chat completions / OpenAI responses / Anthropic
// messages), stream SSE upstream, emit Connect frames downstream.
const { randomUUID, createHash } = require('node:crypto');
const { frame } = require('./wire.cjs');
const { sanitize } = require('../logger.cjs');
const { textChunk, thinkingChunk, signatureChunk, toolChunk, stopChunk, usageChunk } = require('./chat.cjs');
const { isAnthropicFormat, anthropicHeaders, buildAnthropicBody, createAnthropicAdapter } = require('./anthropic.cjs');
const MAX_SSE_BUFFER = 64 * 1024 * 1024;

const isChatFormat = (format = '') => /chat[-_\/]?completions|^(?:chat|openai)$/.test(format);
const isResponsesFormat = (format = '') => /responses/.test(format);
// Gateways inject this literal as placeholder reasoning when history lacks
// any; echoing it back would poison the chain again, so it never round-trips.
const REASONING_UNAVAILABLE = '[reasoning unavailable]';

function endpoint(provider) {
  const url = new URL(provider.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid provider URL');
  const anthropic = isAnthropicFormat(provider.apiFormat);
  const chat = anthropic || isChatFormat(provider.apiFormat);
  url.pathname = url.pathname.replace(/\/(responses|chat\/completions|messages)\/?$/, '').replace(/\/$/, '') +
    (anthropic ? '/messages' : chat ? '/chat/completions' : '/responses');
  url.search = '';
  url.hash = '';
  return { url, chat, anthropic };
}

function contentOf(message, chat) {
  if (!message.images?.length) return message.content;
  const parts = [];
  if (message.content !== '') parts.push(chat ? { type: 'text', text: message.content } : { type: 'input_text', text: message.content });
  for (const image of message.images) {
    const url = `data:${image.mimeType};base64,${image.base64}`;
    parts.push(chat ? { type: 'image_url', image_url: { url } } : { type: 'input_image', image_url: url });
    if (image.caption) parts.push(chat ? { type: 'text', text: image.caption } : { type: 'input_text', text: image.caption });
  }
  return parts;
}

function buildRequestBody(request, route, provider) {
  if (isAnthropicFormat(provider.apiFormat)) return buildAnthropicBody(request, route, provider);
  const chat = isChatFormat(provider.apiFormat);
  const messages = [];
  if (request.systemPrompt !== '') messages.push({ role: chat ? 'system' : 'developer', content: request.systemPrompt });
  for (const message of request.messages) {
    if (message.role === 'tool') {
      messages.push(chat ? { role: 'tool', tool_call_id: message.toolCallId, content: message.content } : { type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      continue;
    }
    const content = contentOf(message, chat);
    if (chat) {
      const item = { role: message.role, content };
      if (message.role === 'assistant' && message.thinking && message.thinking !== REASONING_UNAVAILABLE) item.reasoning_content = message.thinking;
      // The Responses branch intentionally drops message.thinking: reasoning
      // items need server-issued ids / encrypted_content; fabricated ones are rejected.
      if (message.toolCalls?.length) item.tool_calls = message.toolCalls.map(tool => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }));
      messages.push(item);
    } else {
      // A native message stores text before its repeated tool calls. Preserve
      // that sequence and keep every system message at its original position.
      if (content !== '' || !message.toolCalls?.length) messages.push({ role: message.role === 'system' ? 'developer' : message.role, content });
      for (const tool of message.toolCalls || []) messages.push({ type: 'function_call', call_id: tool.id, name: tool.name, arguments: tool.arguments });
    }
  }
  const body = { model: route.model, [chat ? 'messages' : 'input']: messages, stream: true };
  if (chat) body.stream_options = { include_usage: true };
  const maxTokens = request.maxTokens ?? route.maxOutputTokens ?? provider.maxOutputTokens;
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) {
    if (chat) setChatMaxTokens(body, route.model, maxTokens);
    else body.max_output_tokens = maxTokens;
  }
  if (route.effort) {
    if (chat) body.reasoning_effort = route.effort;
    else body.reasoning = { effort: route.effort, ...(route.effort === 'none' ? {} : { summary: 'auto' }) };
  }
  if (request.tools?.length) {
    body.tools = request.tools.map(tool => chat ? { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } } : { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters });
    const choice = request.toolChoice;
    if (choice?.name) body.tool_choice = chat ? { type: 'function', function: { name: choice.name } } : { type: 'function', name: choice.name };
    else if (choice) {
      const type = typeof choice === 'string' ? choice : choice.type;
      if (['auto', 'none', 'required', 'any'].includes(type)) body.tool_choice = type === 'any' ? 'required' : type;
    }
  }
  // Opt-in only: unknown fields break strict gateways.
  if (provider.promptCaching === true) {
    body.prompt_cache_key = 'ddevin-' + createHash('sha256').update(route.model + '\u0000' + (request.systemPrompt || '')).digest('hex').slice(0, 32);
  }
  return body;
}

// OpenAI reasoning models reject max_tokens; other endpoints may only honor
// the classic field, so send both except for those models.
function setChatMaxTokens(body, model, maxTokens) {
  body.max_completion_tokens = maxTokens;
  if (!/^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/i.test(String(model).split('/').at(-1))) body.max_tokens = maxTokens;
}

function parseEvent(raw) {
  let event = '';
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  const joined = data.join('\n');
  if (joined.trim() === '[DONE]') return { type: 'done' };
  let value;
  try {
    value = JSON.parse(joined);
  } catch {
    const err = new Error('Invalid SSE event JSON');
    err.code = 'upstream_invalid_json';
    throw err;
  }
  return { type: value.type || event, data: value };
}

async function* events(body) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > MAX_SSE_BUFFER) {
      const err = new Error('SSE frame too large');
      err.code = 'upstream_content_type';
      throw err;
    }
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const event = parseEvent(raw);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const event = parseEvent(buffer); if (event) yield event; }
}

function usageSnapshot(data, chat) {
  const usage = chat ? data?.usage : data?.response?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = chat ? usage.prompt_tokens : usage.input_tokens;
  const output = chat ? usage.completion_tokens : usage.output_tokens;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) return null;
  const int = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const snapshot = { inputTokens: input, outputTokens: output };
  const inputDetails = chat ? usage.prompt_tokens_details : usage.input_tokens_details;
  // Some gateways report chat cached tokens at usage top level, not in details.
  const cacheRead = int(inputDetails?.cached_tokens) ?? (chat ? int(usage.cached_tokens) : undefined);
  if (cacheRead !== undefined) snapshot.cacheReadTokens = cacheRead;
  const cacheWrite = int(inputDetails?.cache_creation_tokens);
  if (cacheWrite !== undefined) snapshot.cacheWriteTokens = cacheWrite;
  const reasoning = int((chat ? usage.completion_tokens_details : usage.output_tokens_details)?.reasoning_tokens);
  if (reasoning !== undefined) snapshot.reasoningTokens = reasoning;
  return snapshot;
}

function processor(id, uid, chat, emit) {
  const calls = new Map();
  const itemIndexes = new Map();
  const itemTypes = new Map();
  const itemPhases = new Map();
  const texts = new Map();
  let terminal = false;
  let reason = 2;
  let finished = false;
  let usage = null;
  const getCall = (index, itemId) => {
    const key = index ?? itemIndexes.get(itemId) ?? itemId;
    if (key === undefined) {
      const err = new Error('Tool call has no index');
      err.code = 'upstream_invalid_tool';
      throw err;
    }
    if (itemId) itemIndexes.set(itemId, key);
    if (!calls.has(key)) calls.set(key, { id: '', name: '', arguments: '', complete: undefined });
    return calls.get(key);
  };
  const text = async (key, value, complete = false, thinking = false) => {
    if (typeof value !== 'string') return;
    const previous = texts.get(key) || '';
    if (complete && !value.startsWith(previous)) {
      const err = new Error('Inconsistent completed text');
      err.code = 'upstream_invalid_json';
      throw err;
    }
    const delta = complete ? value.slice(previous.length) : value;
    texts.set(key, complete ? value : previous + value);
    if (delta) await emit(thinking ? thinkingChunk(id, delta) : textChunk(id, delta));
  };
  const item = async (value, index, done) => {
    if (value && typeof value === 'object') {
      if (typeof value.type === 'string') itemTypes.set(index, value.type);
      if (typeof value.phase === 'string') itemPhases.set(index, value.phase);
    }
    const reasoning = value.type === 'reasoning' || value.phase === 'thinking' ||
      itemTypes.get(index) === 'reasoning' || itemPhases.get(index) === 'thinking';
    if (value.type === 'function_call') {
      const call = getCall(index, value.id);
      if (value.call_id || value.id) call.id = value.call_id || value.id;
      if (value.name) call.name = value.name;
      if (typeof value.arguments === 'string' && (done || value.arguments)) {
        if (done) call.complete = value.arguments;
        else call.arguments = value.arguments;
      }
    } else if (done && value.type === 'reasoning') {
      for (const [i, summary] of (value.summary || []).entries()) {
        if (summary.type === 'summary_text') await text(`reasoning:${index}:${i}`, summary.text, true, true);
      }
      for (const [j, content] of (value.content || []).entries()) {
        if (content.type === 'reasoning_text') await text(`reasoning-text:${index}:${j}`, content.text, true, true);
      }
    } else if (done && value.type === 'message') {
      for (const [contentIndex, part] of (value.content || []).entries()) {
        if (part.type === 'output_text') await text(reasoning ? `reasoning-out:${index}:${contentIndex}` : `${index}:${contentIndex}`, part.text, true, reasoning);
      }
    }
  };
  return {
    get terminal() { return terminal; },
    get usage() { return usage; },
    async event(event) {
      if (finished) return;
      const data = event.data;
      if (event.type === 'done') {
        if (!terminal && chat) terminal = true;
        return;
      }
      if (!data || data.error) {
        const err = new Error('Upstream stream error');
        err.code = 'upstream_stream_error';
        throw err;
      }
      const container = chat ? data : data.response;
      if (container && typeof container === 'object' && Object.hasOwn(container, 'usage')) usage = usageSnapshot(data, chat);
      if (chat) {
        for (const choice of data.choices || []) {
          if ((choice.index ?? 0) !== 0) continue;
          const delta = choice.delta || choice.message || {};
          if (delta.signature) await emit(signatureChunk(id, delta.signature));
          if (delta.content) await text('chat', delta.content);
          if (delta.reasoning_content || delta.reasoning) await text('reasoning', delta.reasoning_content || delta.reasoning, false, true);
          for (const tool of delta.tool_calls || []) {
            const call = getCall(tool.index ?? 0);
            if (tool.id) call.id += tool.id;
            if (tool.function?.name) call.name += tool.function.name;
            if (typeof tool.function?.arguments === 'string') call.arguments += tool.function.arguments;
          }
          if (choice.finish_reason) {
            terminal = true;
            reason = choice.finish_reason === 'length' ? 3 : choice.finish_reason === 'content_filter' ? 11 : 2;
          }
        }
        return;
      }
      switch (event.type) {
        case 'response.output_item.added': await item(data.item, data.output_index, false); break;
        case 'response.output_item.done': await item(data.item, data.output_index, true); break;
        case 'response.function_call_arguments.delta': getCall(data.output_index, data.item_id).arguments += data.delta || ''; break;
        case 'response.function_call_arguments.done': getCall(data.output_index, data.item_id).complete = data.arguments; break;
        case 'response.output_text.delta':
        case 'response.output_text.done': {
          const index = data.output_index ?? 0;
          const done = event.type.endsWith('.done');
          const thinking = itemTypes.get(index) === 'reasoning' || itemPhases.get(index) === 'thinking';
          await text(thinking ? `reasoning-out:${index}:${data.content_index ?? 0}` : `${index}:${data.content_index ?? 0}`,
            done ? data.text : data.delta, done, thinking);
          break;
        }
        case 'response.reasoning.delta':
        case 'response.reasoning_summary_text.delta': await text(`reasoning:${data.output_index ?? 0}:${data.summary_index ?? 0}`, data.delta, false, true); break;
        case 'response.reasoning_summary_text.done': await text(`reasoning:${data.output_index ?? 0}:${data.summary_index ?? 0}`, data.text, true, true); break;
        case 'response.reasoning_text.delta':
        case 'response.reasoning_text.done': {
          const done = event.type.endsWith('.done');
          await text(`reasoning-text:${data.output_index ?? 0}:${data.content_index ?? 0}`, done ? data.text : data.delta, done, true);
          break;
        }
        case 'response.completed':
          if (data.response?.status && data.response.status !== 'completed') {
            const err = new Error('Unexpected completion status');
            err.code = 'upstream_stream_error';
            throw err;
          }
          for (const [index, value] of (data.response?.output || []).entries()) await item(value, index, true);
          terminal = true;
          break;
        case 'response.incomplete': terminal = true; reason = 3; break;
        case 'response.failed':
        case 'error': {
          const err = new Error('Upstream response failed');
          err.code = 'upstream_stream_error';
          throw err;
        }
      }
    },
    async finish() {
      if (finished) return [];
      if (!terminal) {
        const err = new Error('Upstream stream ended without completion');
        err.code = 'upstream_stream_incomplete';
        throw err;
      }
      const tools = [];
      const orderedCalls = [...calls.entries()].sort(([left], [right]) => typeof left === 'number' && typeof right === 'number' ? left - right : 0);
      if (reason === 2) for (const [, call] of orderedCalls) {
        const raw = call.complete ?? call.arguments;
        const args = typeof raw === 'string' && !raw.trim() ? '{}' : raw;
        if (!call.name || !call.id || typeof args !== 'string') {
          const err = new Error('Incomplete tool call');
          err.code = 'upstream_invalid_tool';
          throw err;
        }
        try {
          JSON.parse(args);
        } catch {
          const err = new Error('Invalid tool call JSON');
          err.code = 'upstream_invalid_tool';
          throw err;
        }
        tools.push({ id: call.id, name: call.name, arguments: args });
      }
      if (tools.length) await emit(toolChunk(id, tools));
      if (usage) await emit(usageChunk(id, uid, usage));
      await emit(stopChunk(id, tools.length ? 10 : reason, uid));
      finished = true;
      return tools.map(tool => tool.name);
    },
  };
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const IMAGE_UNSUPPORTED = /image|vision|multimodal|modalit/i;
const CAP_REJECTED = /max[_ ]?(?:output_|completion_)?tokens|too (?:small|low)|at least|minimum/i;

// Server cooldowns can have a different limit from exponential backoff.
function retryDelayMs(retryAfter, attempt, baseMs, maxDelayMs, maxRetryAfterMs) {
  if (typeof retryAfter === 'string' && retryAfter.trim()) {
    const trimmed = retryAfter.trim();
    const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - Date.now();
    if (Number.isFinite(ms)) return ms <= 0 ? 0 : ms > maxRetryAfterMs ? null : Math.ceil(ms);
  }
  const backoff = baseMs * 2 ** (attempt - 1);
  return Math.min(Math.round(backoff + backoff * 0.2 * Math.random()), maxDelayMs);
}

const requestHasImages = request => request.messages?.some(message => message.images?.length);
const stripImages = request => ({
  ...request,
  messages: request.messages.map(message => message.images?.length
    ? { ...message, images: [], content: [message.content || '', ...message.images.map(() => '[image omitted: model does not support image input]')].filter(Boolean).join('\n') }
    : message),
});

function httpErrorText(status, detail) {
  let msg = '';
  if (typeof detail === 'string' && detail) {
    let parsed;
    try { parsed = JSON.parse(detail); } catch {}
    if (parsed && typeof parsed === 'object') {
      const error = parsed.error;
      msg = (typeof error === 'object' && typeof error?.message === 'string' && error.message) ||
        (typeof parsed.message === 'string' && parsed.message) ||
        (typeof error === 'string' && error) ||
        (typeof parsed.detail === 'string' && parsed.detail) || '';
    }
    if (!msg) msg = detail;
  }
  msg = sanitize(String(msg).replace(/\s+/g, ' ').trim()).slice(0, 300);
  return `Provider returned HTTP ${status}${msg ? ': ' + msg : ''}.`;
}

// Error codes surfaced to logs and the panel:
//   upstream_http | upstream_timeout | upstream_content_type |
//   upstream_stream_error | upstream_stream_incomplete |
//   upstream_invalid_tool | upstream_invalid_json | upstream_network
async function serveChat({ request, route, provider, res, signal, log = () => {}, timeouts = {}, retry = {} }) {
  const id = randomUUID();
  const upstreamController = new AbortController();
  const abort = () => upstreamController.abort();
  const close = () => { if (!res.writableEnded) upstreamController.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  res.on('close', close);
  if (signal?.aborted) upstreamController.abort();
  const write = async chunk => {
    if (signal?.aborted || res.destroyed || res.writableEnded) throw new Error('Client closed');
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/connect+proto', 'cache-control': 'no-store' });
    firstFrameAt ??= Date.now();
    if (!res.write(frame(chunk))) await new Promise((resolve, reject) => {
      const clean = () => { res.off('drain', drained); res.off('close', closed); signal?.removeEventListener('abort', closed); };
      const drained = () => { clean(); resolve(); };
      const closed = () => { clean(); reject(new Error('Client closed')); };
      res.once('drain', drained); res.once('close', closed); signal?.addEventListener('abort', closed, { once: true });
    });
  };
  let status = 0;
  let classifiedCode = 'upstream_network';
  const record = (event, data = {}) => { try { log(event, data); } catch { /* Diagnostics cannot fail a model request. */ } };

  const firstResponseLimit = Number.isSafeInteger(timeouts?.firstResponseMs) && timeouts.firstResponseMs > 0
    ? Math.min(timeouts.firstResponseMs, 2147483647) : 120000;
  const idleLimit = Number.isSafeInteger(timeouts?.idleMs) && timeouts.idleMs > 0
    ? Math.min(timeouts.idleMs, 2147483647) : 120000;

  const startedAt = Date.now();
  let firstFrameAt;
  let timedOutMs;
  const maxRetries = Number.isSafeInteger(retry?.max) && retry.max > 0 ? retry.max : 0;
  const retryBaseMs = Number.isSafeInteger(retry?.baseMs) && retry.baseMs > 0 ? retry.baseMs : 1000;
  const retryMaxDelayMs = Number.isSafeInteger(retry?.maxDelayMs) && retry.maxDelayMs > 0 ? retry.maxDelayMs : 10000;
  const maxRetryAfterMs = Number.isSafeInteger(provider.maxRetryAfterMs) && provider.maxRetryAfterMs > 0 && provider.maxRetryAfterMs <= 300000
    ? provider.maxRetryAfterMs : retryMaxDelayMs;
  const sleep = typeof retry?.sleep === 'function' ? retry.sleep : ms => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); res.off('close', finish); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    res.once('close', finish);
    signal?.addEventListener('abort', finish, { once: true });
  });
  let retriesUsed = 0;
  let imageFallbackUsed = false;
  let fetchStarted = false;
  let currentRequest = request;

  let activeTimer = null;
  const clearTimer = () => { if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; } };
  const armTimer = (ms, code) => {
    clearTimer();
    activeTimer = setTimeout(() => {
      timedOutMs = ms;
      classifiedCode = code;
      upstreamController.abort();
    }, ms);
    activeTimer.unref?.();
  };

  try {
    for (;;) {
      try {
        const { url, chat, anthropic } = endpoint(provider);
        const body = buildRequestBody(currentRequest, route, provider);
        classifiedCode = 'upstream_network';
        fetchStarted = false;

        armTimer(firstResponseLimit, 'upstream_timeout');
        fetchStarted = true;
        const upstream = await fetch(url, {
          redirect: 'error',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...(anthropic ? anthropicHeaders(provider.apiKey) : provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {})
          },
          body: JSON.stringify(body),
          signal: upstreamController.signal
        });
        clearTimer();

        status = upstream.status;
        if (!upstream.ok) {
          classifiedCode = 'upstream_http';
          const detail = await upstream.text().catch(() => '');
          const err = new Error('Upstream HTTP error');
          err.httpDetail = detail.slice(0, 2000);
          err.retryAfter = upstream.headers.get('retry-after');
          throw err;
        }
        const contentType = upstream.headers.get('content-type') || '';
        if (!upstream.body || !contentType.toLowerCase().includes('text/event-stream')) {
          classifiedCode = 'upstream_content_type';
          await upstream.body?.cancel();
          throw new Error('Upstream did not return SSE');
        }

        async function* rawChunksWithTimeout(bodyStream) {
          const reader = bodyStream.getReader();
          try {
            for (;;) {
              armTimer(idleLimit, 'upstream_timeout');
              let result;
              try {
                result = await reader.read();
              } catch (err) {
                if (classifiedCode !== 'upstream_timeout') classifiedCode = 'upstream_stream_error';
                throw err;
              } finally {
                clearTimer();
              }
              if (result.done) break;
              yield result.value;
            }
          } finally {
            reader.releaseLock();
          }
        }

        const stream = processor(id, route.uid || request.modelUid, chat, write);
        try {
          const adapt = anthropic ? createAnthropicAdapter() : event => [event];
          upstream: for await (const raw of events(rawChunksWithTimeout(upstream.body))) {
            for (const event of adapt(raw)) {
              await stream.event(event);
              if (event.type === 'done' || (!chat && stream.terminal)) break upstream;
            }
          }
        } catch (err) {
          if (classifiedCode !== 'upstream_timeout') {
            const allowedCodes = new Set([
              'upstream_timeout', 'upstream_http', 'upstream_content_type',
              'upstream_stream_error', 'upstream_stream_incomplete',
              'upstream_invalid_tool', 'upstream_invalid_json', 'upstream_network'
            ]);
            classifiedCode = allowedCodes.has(err?.code) ? err.code : 'upstream_stream_error';
          }
          throw err;
        }

        let toolNames;
        try {
          toolNames = await stream.finish();
        } catch (err) {
          classifiedCode = err?.code === 'upstream_invalid_tool' ? 'upstream_invalid_tool' : 'upstream_stream_incomplete';
          throw err;
        }

        res.end(frame(Buffer.from('{}'), 2));
        record('chat-complete', { model: route.model, uid: route.uid || request.modelUid, status, tools: toolNames.length,
          ttftMs: firstFrameAt === undefined ? null : firstFrameAt - startedAt,
          durationMs: Date.now() - startedAt, usage: stream.usage, retries: retriesUsed + (imageFallbackUsed ? 1 : 0), requestId: id });
        return { status, toolNames, requestId: id };
      } catch (err) {
        clearTimer();
        const isClientCancel = signal?.aborted || res.destroyed || res.writableEnded;
        if (isClientCancel) {
          record('chat-aborted', { model: route.model, uid: route.uid || request.modelUid, status, retries: retriesUsed + (imageFallbackUsed ? 1 : 0) });
          if (!res.destroyed && !res.writableEnded) res.destroy();
          return { status, aborted: true };
        }

        // Retries only happen before any frame went downstream.
        const writable = !res.headersSent && !res.destroyed && !res.writableEnded;
        if (writable && classifiedCode === 'upstream_http' && status === 400 && !imageFallbackUsed &&
            requestHasImages(currentRequest) && IMAGE_UNSUPPORTED.test(err?.httpDetail || '')) {
          imageFallbackUsed = true;
          currentRequest = stripImages(currentRequest);
          record('chat-retry', { model: route.model, attempt: retriesUsed + 1, reason: 'image_unsupported', delayMs: 0, requestId: id });
          continue;
        }
        const retryReason = writable
          ? classifiedCode === 'upstream_http' && RETRYABLE_STATUS.has(status) ? `http_${status}`
            : classifiedCode === 'upstream_network' && fetchStarted ? 'network' : null
          : null;
        const delayMs = retryReason ? retryDelayMs(err?.retryAfter, retriesUsed + 1, retryBaseMs, retryMaxDelayMs, maxRetryAfterMs) : null;
        if (retryReason && retriesUsed < maxRetries && delayMs !== null) {
          retriesUsed++;
          record('chat-retry', { model: route.model, attempt: retriesUsed, reason: retryReason, delayMs, requestId: id });
          await sleep(delayMs);
          continue;
        }

        let errorText = 'Provider response could not be completed.';
        if (classifiedCode === 'upstream_http' && status >= 400) {
          errorText = httpErrorText(status, err?.httpDetail);
        } else if (classifiedCode === 'upstream_timeout') {
          errorText = `Provider timed out (no data for ${Math.round((timedOutMs ?? firstResponseLimit) / 1000)}s).`;
        } else if (classifiedCode === 'upstream_network' && fetchStarted) {
          errorText = `Could not reach provider (${err?.cause?.code || err?.code || 'network error'}).`;
        } else if (classifiedCode === 'upstream_content_type' || classifiedCode === 'upstream_invalid_json' || classifiedCode === 'upstream_invalid_tool') {
          errorText = 'Provider response format is invalid.';
        }

        try {
          await write(textChunk(id, errorText));
          await write(stopChunk(id, 13, route.uid || request.modelUid));
          res.end(frame(Buffer.from('{}'), 2));
        } catch {
          if (!res.destroyed && !res.writableEnded) res.destroy();
        }
        record('chat-error', { model: route.model, uid: route.uid || request.modelUid, status, code: classifiedCode, detail: err?.httpDetail?.slice(0, 300), durationMs: Date.now() - startedAt, retries: retriesUsed + (imageFallbackUsed ? 1 : 0), requestId: id });
        return { status, error: true, code: classifiedCode, requestId: id };
      }
    }
  } finally {
    clearTimer();
    upstreamController.abort();
    signal?.removeEventListener('abort', abort);
    res.off('close', close);
  }
}

// Cache-warming ping: the real request verbatim, only the output cap changes
// (never thinking / tools / cache-control — those participate in cache keys
// on strict upstreams). No downstream frames, no retries: the warmer owns
// scheduling and retry policy.
async function warmPing({ request, route, provider, maxOutputTokens = 4, signal, timeoutMs = 60000 }) {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000);
  timer.unref?.();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const failure = (code, extra = {}) => ({ kind: 'error', latencyMs: Date.now() - startedAt, code, fatal: false, transient: true, ...extra });
  try {
    if (signal?.aborted) return { kind: 'cancelled' };
    const { url, chat, anthropic } = endpoint(provider);
    const body = buildRequestBody(request, route, provider);
    if (anthropic) body.max_tokens = maxOutputTokens;
    else if (chat) setChatMaxTokens(body, route.model, maxOutputTokens);
    else body.max_output_tokens = Math.max(16, maxOutputTokens);
    const upstream = await fetch(url, {
      redirect: 'error', method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'text/event-stream',
        ...(anthropic ? anthropicHeaders(provider.apiKey) : provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const status = upstream.status;
      const detail = await upstream.text().catch(() => '');
      if (status === 400 && CAP_REJECTED.test(detail)) return failure('cap_rejected', { status, capRejected: true });
      if ([400, 401, 403, 404, 422].includes(status)) return failure('http_' + status, { status, fatal: true, transient: false });
      if (RETRYABLE_STATUS.has(status) || status === 408 || status >= 500) return failure('http_' + status, { status });
      return failure('http_' + status, { status, fatal: true, transient: false });
    }
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.body || !contentType.toLowerCase().includes('text/event-stream')) {
      await upstream.body?.cancel();
      return failure('content_type', { status: upstream.status });
    }
    // Content/thinking deltas past 256 emitted chunks mean the upstream is
    // ignoring the cap — cut it off instead of burning output tokens.
    let emitted = 0;
    const stream = processor('warm-' + startedAt, route.uid || request.modelUid, chat, async () => {
      if (++emitted > 256) {
        const err = new Error('Warm ping output overflow');
        err.code = 'output_overflow';
        throw err;
      }
    });
    const adapt = anthropic ? createAnthropicAdapter() : event => [event];
    upstream: for await (const raw of events(upstream.body)) {
      for (const event of adapt(raw)) {
        await stream.event(event);
        if (event.type === 'done' || (!chat && stream.terminal)) break upstream;
      }
    }
    await stream.finish();
    const usage = stream.usage;
    return {
      kind: 'ok', latencyMs: Date.now() - startedAt,
      usage: usage ? {
        promptTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens, outputTokens: usage.outputTokens,
      } : null,
    };
  } catch (error) {
    if (signal?.aborted) return { kind: 'cancelled' };
    if (timedOut) return failure('timeout');
    const code = error?.code === 'output_overflow' ? 'output_overflow'
      : typeof error?.code === 'string' && error.code.startsWith('upstream_') ? error.code.slice('upstream_'.length)
      : 'network';
    return failure(code);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.abort(); // release any half-open upstream connection
  }
}

module.exports = { serveChat, buildRequestBody, endpoint, warmPing, setChatMaxTokens, usageSnapshot };
