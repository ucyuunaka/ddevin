'use strict';

// GetChatMessage request parsing and StreamedChatMessage chunk encoding.
// Field numbers follow Devin's exa.api_server_pb protocol.
const { createHash, randomUUID } = require('node:crypto');
const { fields, str, num, s, v, m, parseFields } = require('./wire.cjs');
const SOURCE_ROLE = { 0: 'user', 1: 'user', 2: 'assistant', 3: 'assistant', 4: 'tool', 5: 'system' };

function schema(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value ?? {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid native tool schema');
  return parsed;
}

function protoMessage(data) {
  const source = Number(num(data, 2));
  if (!Object.hasOwn(SOURCE_ROLE, source)) throw new Error('Unsupported native message source');
  return {
    role: SOURCE_ROLE[source], source,
    messageId: str(data, 1), content: str(data, 3),
    toolCalls: fields(data, 6).map(({ value }) => ({ id: str(value, 1), name: str(value, 2), arguments: str(value, 3) })),
    toolCallId: str(data, 7), toolResultIsError: Boolean(num(data, 9)),
    images: fields(data, 10).map(({ value }) => ({ base64: str(value, 1), mimeType: str(value, 2) || 'image/png', caption: str(value, 3) })),
    thinking: str(data, 11), signature: str(data, 12),
  };
}

function camel(object, camelName, snakeName) { return object?.[camelName] ?? object?.[snakeName]; }
function jsonToolChoice(choice) {
  if (!choice || typeof choice !== 'object') return choice;
  const name = camel(choice, 'toolName', 'tool_name');
  const type = camel(choice, 'optionName', 'option_name');
  if (name === undefined && type === undefined) return choice;
  return { type: name ? 'tool' : type || '', name: name || '' };
}
function jsonMessage(message) {
  let source = message.source ?? 0;
  if (typeof source === 'string') source = { CHAT_MESSAGE_SOURCE_UNSPECIFIED: 0, CHAT_MESSAGE_SOURCE_USER: 1, CHAT_MESSAGE_SOURCE_SYSTEM: 2, CHAT_MESSAGE_SOURCE_UNKNOWN: 3, CHAT_MESSAGE_SOURCE_TOOL: 4, CHAT_MESSAGE_SOURCE_SYSTEM_PROMPT: 5, USER: 1, SYSTEM: 2, UNKNOWN: 3, TOOL: 4, SYSTEM_PROMPT: 5 }[source];
  const role = message.role || SOURCE_ROLE[source];
  if (!role) throw new Error('Unsupported native message source');
  return {
    role, source, messageId: camel(message, 'messageId', 'message_id') || '',
    content: message.prompt ?? message.content ?? '',
    toolCalls: (camel(message, 'toolCalls', 'tool_calls') || []).map(call => ({ id: call.id || '', name: call.name || '', arguments: camel(call, 'argumentsJson', 'arguments_json') ?? call.arguments ?? '' })),
    toolCallId: camel(message, 'toolCallId', 'tool_call_id') || '',
    toolResultIsError: Boolean(camel(message, 'toolResultIsError', 'tool_result_is_error')),
    images: (message.images || []).map(image => ({ base64: camel(image, 'base64Data', 'base64_data') || image.base64 || '', mimeType: camel(image, 'mimeType', 'mime_type') || 'image/png', caption: image.caption || '' })),
    thinking: message.thinking || '', signature: message.signature || '',
  };
}

// -> { modelUid, modelEnum, systemPrompt, messages[], tools[], toolChoice, maxTokens }
function parseChat(data) {
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    if (!data || typeof data !== 'object') throw new Error('Invalid native chat request');
    return {
      modelUid: camel(data, 'chatModelUid', 'chat_model_uid') ?? camel(data, 'modelUid', 'model_uid') ?? '',
      modelEnum: camel(data, 'internalChatModel', 'internal_chat_model') ?? data.model ?? 0,
      systemPrompt: data.prompt ?? camel(data, 'systemPrompt', 'system_prompt') ?? '',
      messages: (camel(data, 'chatMessagePrompts', 'chat_message_prompts') ?? data.messages ?? data.prompts ?? []).map(jsonMessage),
      tools: (data.tools || []).map(tool => ({ name: tool.name, description: tool.description || '', parameters: schema(camel(tool, 'jsonSchemaString', 'json_schema_string') ?? camel(tool, 'parametersJson', 'parameters_json') ?? camel(tool, 'inputSchema', 'input_schema') ?? tool.parameters) })),
      toolChoice: jsonToolChoice(camel(data, 'toolChoice', 'tool_choice')),
      maxTokens: camel(data, 'maxTokens', 'max_tokens'),
    };
  }
  const choice = fields(data, 12).find(field => field.wire === 2)?.value;
  return {
    modelUid: str(data, 21), modelEnum: num(data, 6), systemPrompt: str(data, 2),
    messages: fields(data, 3).map(field => protoMessage(field.value)),
    tools: fields(data, 10).map(({ value }) => ({ name: str(value, 1), description: str(value, 2), parameters: schema(str(value, 3)) })),
    toolChoice: choice ? { type: str(choice, 1), name: str(choice, 2) } : undefined,
    maxTokens: undefined,
  };
}

// StreamedChatMessage chunks: f1=id, f2=timestamp{sec,nanos}, f3=text,
// f5=stopReason, f6=toolCall, f7=usage, f9=thinking, f23=modelUid.
function prefix(id) {
  const now = Date.now();
  return [s(1, id), m(2, Buffer.concat([v(1, Math.floor(now / 1000)), v(2, now % 1000 * 1000000)]))];
}
function textChunk(id, text) { return Buffer.concat([...prefix(id), s(3, text)]); }
function thinkingChunk(id, text) { return Buffer.concat([...prefix(id), s(9, text)]); }
function signatureChunk(id, signature) { return Buffer.concat([...prefix(id), s(10, signature)]); }
function toolChunk(id, tools) {
  return Buffer.concat([...prefix(id), ...tools.map(tool => m(6, Buffer.concat([s(1, tool.id), s(2, tool.name), s(3, tool.arguments ?? tool.arguments_json ?? '')])))]);
}
// stop reasons: 2=end, 3=max_tokens, 10=tool_call, 11=content_filter, 13=error
function stopChunk(id, reason = 2, modelUid = '') { return Buffer.concat([...prefix(id), v(5, reason), ...(modelUid ? [s(23, modelUid)] : [])]); }
function usageChunk(id, modelUid, usage) {
  return Buffer.concat([...prefix(id),
    m(7, Buffer.concat([v(2, usage.inputTokens), v(3, usage.outputTokens), s(7, id), s(9, modelUid)]))]);
}

// Conversation identity for cache warming: which session (cascade), which
// model, and which prompt prefix the upstream cache would key on.
// -> { cascadeId, modelUid, systemPrompt, firstHead, sysHash }
function chatLineage(data) {
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    if (!data || typeof data !== 'object') return { cascadeId: '', modelUid: '', systemPrompt: '', firstHead: '', sysHash: '' };
    const prompts = camel(data, 'chatMessagePrompts', 'chat_message_prompts') ?? data.messages ?? data.prompts;
    const first = Array.isArray(prompts) ? prompts[0] : undefined;
    const systemPrompt = String(data.prompt ?? camel(data, 'systemPrompt', 'system_prompt') ?? '');
    return {
      cascadeId: String(camel(data, 'cascadeId', 'cascade_id') ?? ''),
      modelUid: String(camel(data, 'chatModelUid', 'chat_model_uid') ?? camel(data, 'modelUid', 'model_uid') ?? ''),
      systemPrompt,
      firstHead: String(first?.prompt ?? first?.content ?? '').slice(0, 1024),
      sysHash: createHash('sha256').update(systemPrompt, 'utf8').digest('hex'),
    };
  }
  const first = fields(data, 3)[0]?.value;
  const systemPrompt = str(data, 2);
  return {
    cascadeId: str(data, 16), modelUid: str(data, 21), systemPrompt,
    firstHead: (first ? str(first, 3) : '').slice(0, 1024),
    sysHash: createHash('sha256').update(systemPrompt, 'utf8').digest('hex'),
  };
}

// sha256(kind \0 cascadeId \0 modelUid \0 sha256(systemPrompt) \0 head),
// 16 hex chars. head is only mixed in when the request has no cascade id so
// unrelated sessions cannot collide. modelUid keeps Fusion lead/sidekick —
// same cascade and system prompt, different models — on separate lineages.
function lineageKey(kind, lineage) {
  const hash = createHash('sha256');
  hash.update(String(kind), 'utf8'); hash.update('\u0000');
  hash.update(String(lineage?.cascadeId || ''), 'utf8'); hash.update('\u0000');
  hash.update(String(lineage?.modelUid || ''), 'utf8'); hash.update('\u0000');
  hash.update(lineage?.sysHash || createHash('sha256').update(String(lineage?.systemPrompt || ''), 'utf8').digest('hex'), 'utf8');
  hash.update('\u0000');
  if (!lineage?.cascadeId) hash.update(String(lineage?.firstHead || ''), 'utf8');
  return hash.digest('hex').slice(0, 16);
}

// Rewrites a GetChatMessage proto for a cache-warming replay: max_tokens
// drops to the floor and execution_id is fresh. Every other byte (session
// token, history, tools, prompt_cache_key, model_assignment_jwt) is verbatim —
// the cache key lives in the shared prefix.
function patchChatRequestForWarm(data, maxTokens) {
  const out = [];
  let configured = false;
  for (const field of parseFields(data)) {
    if (field.number === 8 && field.wire === 2) {
      configured = true;
      const inner = parseFields(field.value).filter(item => item.number !== 2).map(item => item.raw);
      out.push(m(8, Buffer.concat([...inner, v(2, maxTokens)])));
    } else if (field.number === 22 && field.wire === 2) {
      out.push(s(22, randomUUID()));
    } else out.push(field.raw);
  }
  if (!configured) out.push(m(8, v(2, maxTokens)));
  return Buffer.concat(out);
}

// StreamedChatMessage metadata for the official tap: usage f7
// {2 input, 3 output, 4 cache_write, 5 cache_read, 9 model_uid},
// billing f14/f18/f22 (double) and actual model f23.
function parseChatResponseMeta(data) {
  const usageField = fields(data, 7).find(field => field.wire === 2)?.value;
  const acu = fields(data, 22).find(field => field.wire === 1)?.value;
  return {
    usage: usageField ? {
      inputTokens: num(usageField, 2), outputTokens: num(usageField, 3),
      cacheWriteTokens: num(usageField, 4), cacheReadTokens: num(usageField, 5),
      modelUid: str(usageField, 9),
    } : null,
    creditCost: num(data, 14), committedCreditCost: num(data, 18),
    committedAcuCost: acu ? acu.readDoubleLE(0) : 0,
    actualModelUid: str(data, 23),
  };
}

module.exports = { parseChat, textChunk, thinkingChunk, signatureChunk, toolChunk, stopChunk, usageChunk,
  chatLineage, lineageKey, patchChatRequestForWarm, parseChatResponseMeta };
