'use strict';

// Shared catalog constants and small helpers used by the build, roles and
// augment modules. Wire field numbers follow Devin's exa.* protocol.

const crypto = require('node:crypto');

const { s, v, m } = require('../protocol/wire.cjs');

const OWN_GROUP = 'ddevin';
const FUSION_GROUP = 'ddevin Fusion';
const SIDEKICK_HARNESSES = ['swe-1p6', 'swe-1p5'];
const ownUid = uid => typeof uid === 'string' && /^(?:fusion-)?ddevin-/.test(uid);
const LIST_MODES = ['official', 'byok', 'coexist'];
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'model';
const concat = parts => Buffer.concat(parts);
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : fallback;
function refKey(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return '';
  const hasNative = typeof ref.nativeUid === 'string' && ref.nativeUid.length > 0 && ref.nativeUid.length <= 256 && !ownUid(ref.nativeUid);
  const hasProvider = typeof ref.providerId === 'string' && typeof ref.model === 'string' && ref.providerId.length > 0 && ref.model.length > 0;
  if (hasNative && !ref.providerId && !ref.model) return JSON.stringify(['native', ref.nativeUid]);
  if (hasProvider && !ref.nativeUid) return JSON.stringify(['provider', ref.providerId, ref.model]);
  return '';
}

function presetUid(id) {
  return 'fusion-ddevin-preset-' + digest(['preset', id]).slice(0, 24);
}

function effortMetadata(effort) {
  // The provider-default variant (null) shows as 'Default' at order 0. Explicit
  // levels start at 1 so 'none' stays reachable instead of colliding with it —
  // the picker dedupes dimension values by order.
  if (effort === null || effort === undefined) return { order: 0, name: 'Default', controlType: 1 };
  const names = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
  const orders = { none: 1, minimal: 2, low: 3, medium: 4, high: 5, xhigh: 6, max: 7, ultra: 8 };
  return { order: orders[effort] ?? 100 + parseInt(digest(effort).slice(0, 6), 16), name: names[effort] || effort, controlType: 1 };
}

function encodeFamily(family) {
  return concat([s(1, family.modelFamilyLabel), ...family.entries.map(entry => m(2,
    concat([s(1, entry.key), m(2, concat([v(1, entry.value.order || 0), s(2, entry.value.name || ''), v(3, entry.value.controlType || 0)]))])))]);
}

function encodeConfig(config) {
  const info = config.modelInfo;
  const features = info.modelFeatures;
  const infoRaw = concat([
    v(3, info.modelType), v(4, info.maxTokens),
    m(6, concat([v(8, 1), ...(features.supportsImages ? [v(11, 1)] : []), v(12, 1),
      ...(features.supportsThinking ? [v(15, 1)] : []), v(21, 1)])),
    v(13, info.maxOutputTokens), s(17, info.modelUid), s(18, info.inferenceServerUrl),
    ...info.harnessUids.map(uid => s(20, uid)),
    ...(info.displayOption ? [v(22, info.displayOption)] : []),
    s(23, info.modelFamilyUid), ...(info.isModelRouter ? [v(25, 1)] : []),
  ]);
  return concat([s(1, config.label), ...(config.supportsImages ? [v(5, 1)] : []),
    v(10, config.provider), v(18, config.maxTokens),
    s(22, config.modelUid), m(23, infoRaw), m(30, encodeFamily(config.modelFamilyMetadata)),
    ...(config.isDefaultModelInFamily ? [v(31, 1)] : [])]);
}

function configFor({ uid, label, family, familyUid, contextWindow, maxOutputTokens, effort, fusion, supportsImages, inferenceServerUrl, isDefault }) {
  const json = {
    label, modelUid: uid, provider: fusion ? 1 : 2,
    maxTokens: contextWindow, supportsImages: !!supportsImages,
    ...(isDefault ? { isDefaultModelInFamily: true } : {}),
    modelInfo: {
      modelUid: uid, modelType: 2, maxTokens: contextWindow,
      maxOutputTokens,
      inferenceServerUrl,
      harnessUids: fusion ? ['fusion'] : [...SIDEKICK_HARNESSES],
      displayOption: fusion ? 3 : 0, modelFamilyUid: familyUid, isModelRouter: !!fusion,
      modelFeatures: { zeroShotCapable: true, supportsImages: !!supportsImages, supportsToolCalls: true,
        supportsParallelToolCalls: true, supportsThinking: !!effort && effort !== 'none' },
    },
    modelFamilyMetadata: family,
  };
  return { uid, label, effort, kind: fusion ? 'fusion' : 'model', isDefault: !!isDefault, json, raw: encodeConfig(json) };
}

// Diagnostic code → panel-facing text; shared by validation errors and the view.
const DIAGNOSTIC_TEXT = {
  provider_id_missing: '供应商缺少 id', model_id_missing: '模型缺少 id',
  duplicate_model: '重复的模型（已保留第一个）', invalid_effort: '无效的思考档位',
  invalid_inference_url: '无效的 inferenceServerUrl，已回退默认',
};

module.exports = { OWN_GROUP, FUSION_GROUP, SIDEKICK_HARNESSES, LIST_MODES, ownUid, has, digest, slug, concat, positive,
  refKey, presetUid, effortMetadata, encodeFamily, encodeConfig, configFor, DIAGNOSTIC_TEXT };
