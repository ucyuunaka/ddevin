'use strict';

// Panel-side config manager: validates every mutation, serializes writes,
// validates the full model graph before committing, and exposes a secret-free
// public state for the webview.
const { randomUUID } = require('node:crypto');
const { buildCatalog, buildRoleLists, refKey, presetUid, normalizeFusionConfig, LIST_MODES, DIAGNOSTIC_TEXT } = require('../catalog.cjs');
const { discover: discoverModels, normalizeBaseUrlPath } = require('../config.cjs');
const { modelSupportsImages, modelEfforts } = require('../capabilities.cjs');
const { normalizeWarmSettings } = require('../runtime/warmer.cjs');
const { createOrderStore, OrderStoreError } = require('./order.cjs');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
class PanelInputError extends Error {}
const fail = message => { throw new PanelInputError(message); };
function text(value, label, maximum = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail(label + '无效。');
  return value.trim();
}
function baseUrl(value) {
  let url; try { url = new URL(text(value, 'API 地址', 2048)); } catch { fail('请填写完整的 http:// 或 https:// API 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('API 地址不能包含登录信息、查询参数或片段。');
  url.pathname = normalizeBaseUrlPath(url.pathname);
  return url.toString().replace(/\/$/, '');
}
function boolean(value, label) { if (typeof value !== 'boolean') fail(label + '无效。'); return value; }
function number(value, label) { if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) fail(label + '必须是正整数。'); return value; }
function providerAt(config, id) { return (Array.isArray(config.providers) ? config.providers : []).find(provider => provider.id === id) || fail('该供应商已不存在，请刷新面板。'); }
const EFFORT_VALUES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
function modelPatch(input, previous) {
  const model = { ...previous };
  if (own(input, 'label')) model.label = text(input.label, '模型名称');
  if (own(input, 'enabled')) model.enabled = boolean(input.enabled, '启用状态');
  if (own(input, 'supportsImages')) model.supportsImages = boolean(input.supportsImages, '图片支持');
  if (own(input, 'contextWindow')) { model.contextWindow = number(input.contextWindow, '上下文长度'); delete model.limitsDetected; }
  if (own(input, 'maxOutputTokens')) model.maxOutputTokens = number(input.maxOutputTokens, '最大输出长度');
  if (own(input, 'efforts')) {
    if (!Array.isArray(input.efforts) || input.efforts.some(v => v !== 'default' && !EFFORT_VALUES.includes(v))) fail('推理强度列表无效。');
    model.efforts = [...new Set(input.efforts.map(v => v === 'default' ? null : v))];
  }
  if (own(input, 'effortMode')) {
    if (!['auto', 'manual', 'none'].includes(input.effortMode)) fail('推理档位来源无效。');
    model.effortMode = input.effortMode;
  }
  if (own(input, 'defaultEffort')) {
    if (input.defaultEffort !== null && !EFFORT_VALUES.includes(input.defaultEffort)) fail('默认推理档位无效。');
    if (input.defaultEffort === null) delete model.defaultEffort;
    else model.defaultEffort = input.defaultEffort;
  }
  if (model.maxOutputTokens > model.contextWindow) fail('最大输出长度不能超过上下文长度。');
  return model;
}
const insecureHttp = provider => {
  try { const url = new URL(provider.baseUrl); return url.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname); }
  catch { return false; }
};
function publicState(config, selectedFusionUid, nativeModels = [], panelOrder = null) {
  const catalog = buildCatalog({ ...config, enabled: true }, nativeModels);
  const hidden = new Set([...(catalog.hiddenNativeModelUids || []), ...(catalog.hiddenFusionUids || [])]);
  const roleLists = buildRoleLists(config, nativeModels);
  const eligibleLeads = new Set(roleLists.lead.filter(item => item.available).map(item => item.ref.nativeUid).filter(Boolean));
  const eligibleSidekicks = new Set(roleLists.sidekick.filter(item => item.available).map(item => item.ref.nativeUid).filter(Boolean));
  const observed = new Set();
  const natives = [];
  for (const entry of nativeModels) {
    if (!entry || typeof entry.uid !== 'string' || !entry.uid) continue;
    observed.add(entry.uid);
    natives.push({ uid: entry.uid, label: typeof entry.label === 'string' && entry.label ? entry.label : entry.uid,
      disabled: entry.disabled === true, hidden: hidden.has(entry.uid),
      eligibleLead: eligibleLeads.has(entry.uid), eligibleSidekick: eligibleSidekicks.has(entry.uid),
      eligible: eligibleLeads.has(entry.uid) || eligibleSidekicks.has(entry.uid) });
  }
  for (const uid of hidden) if (!observed.has(uid) && !uid.startsWith('fusion-')) natives.push({ uid, label: uid, disabled: false, hidden: true, eligibleLead: false, eligibleSidekick: false, eligible: false });
  return {
    enabled: config.enabled !== false,
    diagnostics: catalog.diagnostics || [],
    modelListMode: LIST_MODES.includes(config.modelListMode) ? config.modelListMode : 'coexist',
    listModes: LIST_MODES,
    logLevel: config.logLevel || 'info',
    cacheWarm: normalizeWarmSettings(config),
    providers: (Array.isArray(config.providers) ? config.providers : []).map(provider => ({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl,
      apiFormat: provider.apiFormat, enabled: provider.enabled !== false, keyConfigured: !!provider.apiKey, insecure: insecureHttp(provider),
      models: (Array.isArray(provider.models) ? provider.models : []).map(model => ({ id: model.id, label: model.label || model.id, enabled: model.enabled !== false,
        efforts: model.efforts || [], effortMode: model.effortMode || (model.efforts?.length ? 'manual' : 'auto'),
        defaultEffort: model.defaultEffort ?? null,
        effortOptions: modelEfforts(model).filter(v => v !== null),
        contextWindow: model.contextWindow || 272000, maxOutputTokens: model.maxOutputTokens || Math.min(131072, model.contextWindow || 272000),
        limitsDetected: model.limitsDetected,
        supportsImages: modelSupportsImages(model) })) })),
    roleLists,
    fusionPresets: catalog.presetStates || [],
    presetCandidates: catalog.presetCandidates || { lead: [], sidekick: [] },
    migrationPending: !!catalog.migrationPending,
    selectedFusionUid: catalog.migratedFrom === selectedFusionUid ? catalog.defaultFusionUid : selectedFusionUid,
    nativeModels: natives,
    modelCount: Object.keys(catalog.routes).length,
    fusionCount: Object.values(catalog.fusions).filter(fusion => fusion.canonical).length,
    fusionChoices: (catalog.presetStates || []).filter(preset => preset.available).map(preset => ({ uid: preset.uid, label: preset.name })),
    selectedFusionPresetId: catalog.fusions?.[selectedFusionUid]?.presetId ?? null,
    effortValues: EFFORT_VALUES,
    panelOrder,
  };
}
function createManager({ read, write, discover = discoverModels, afterChange = async () => {}, selectFusion = async () => {}, selectedFusion = () => '', nativeModels = () => [], refreshNativeModels = async () => {}, nativeCatalogStatus = () => 'empty', orderStore = createOrderStore() }) {
  let queue = Promise.resolve();
  let pendingImport;
  const signature = provider => JSON.stringify([provider.id, provider.baseUrl, provider.apiFormat, provider.apiKey]);
  const makeState = (config = read()) => {
    const result = publicState(config, selectedFusion(), nativeModels(), orderStore.snapshot(config));
    result.nativeCatalogStatus = nativeCatalogStatus();
    const provider = (Array.isArray(config.providers) ? config.providers : []).find(p => p.id === pendingImport?.providerId);
    result.importCandidates = provider && signature(provider) === pendingImport.signature ? {
      providerId: provider.id, token: pendingImport.token,
      models: pendingImport.models.map(model => ({ id: model.id, label: model.label || model.id,
        imported: provider.models.some(existing => existing.id === model.id) })),
    } : null;
    return result;
  };
  const state = () => makeState();
  const asPanelError = error => {
    if (error instanceof PanelInputError) return error;
    if (error instanceof OrderStoreError) return new PanelInputError(error.message);
    return new PanelInputError('面板展示顺序保存失败：' + (error?.message || '未知错误'));
  };
  async function applyPanelOrder(type, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('操作参数无效。');
    try {
      if (type === 'reorderPanelList') {
        await orderStore.reorder({ readConfig: read, scope: payload.scope, providerId: payload.providerId, ids: payload.ids, expectedToken: payload.expectedToken });
      } else {
        await orderStore.prioritize({ readConfig: read, scope: payload.scope, providerId: payload.providerId, expectedToken: payload.expectedToken });
      }
      return state();
    } catch (error) { throw asPanelError(error); }
  }
  async function apply(type, payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('操作参数无效。');
    if (type === 'ready' || type === 'refreshNativeModels') { await refreshNativeModels(); return state(); }
    if (type === 'reorderPanelList' || type === 'prioritizeEnabledPanelList') return applyPanelOrder(type, payload);
    let config = normalizeFusionConfig(read(), nativeModels());
    if (!Array.isArray(config.providers)) config.providers = [];
    for (const provider of config.providers) if (!Array.isArray(provider.models)) provider.models = [];
    const diagnosticsBefore = new Set(buildCatalog(structuredClone(config), nativeModels()).diagnostics.map(item => JSON.stringify(item)));
    let appendPreparation = null;
    if (type === 'selectFusion') {
      if (config.enabled === false) fail('请先启用 ddevin。');
      if (!own(buildCatalog(config, nativeModels()).fusions, payload.uid)) fail('该 Fusion 组合已不可用，请重新选择。');
      await selectFusion(payload.uid); return state();
    }
    switch (type) {
      case 'saveFusionPreset': {
        if (config.enabled === false) fail('请先启用插件再编辑预设。');
        const presets = Array.isArray(config.fusionPresets) ? config.fusionPresets : [];
        const existing = payload.id ? presets.find(item => item.id === payload.id) : null;
        if (payload.id && !existing) fail('该预设已不存在，请刷新面板。');
        const name = text(payload.name, '预设名称', 80);
        if (presets.some(item => item !== existing && item.name?.trim().toLowerCase() === name.toLowerCase())) fail('预设名称不能重复。');
        const candidates = buildCatalog(config, nativeModels()).presetCandidates;
        const references = {};
        for (const role of ['lead', 'sidekick']) {
          const ref = payload[role];
          if (!refKey(ref) || ref.nativeUid && own(ref, 'effort')) fail(role + ' 模型参数无效。');
          const clean = ref.nativeUid ? { nativeUid: ref.nativeUid } : { providerId: ref.providerId, model: ref.model, effort: ref.effort ?? null };
          const match = candidates[role].find(item => refKey(item.ref) === refKey(clean) && (item.ref.effort ?? null) === (clean.effort ?? null));
          const unchanged = existing && refKey(existing[role]) === refKey(clean) && (existing[role].effort ?? null) === (clean.effort ?? null);
          if (!match && !unchanged) fail(role + ' 当前不可用，请重新选择。');
          references[role] = clean;
        }
        const preset = { id: existing?.id || randomUUID(), name, ...references };
        config.fusionPresets = existing ? presets.map(item => item === existing ? preset : item) : [...presets, preset];
        break;
      }
      case 'deleteFusionPreset': {
        const presets = Array.isArray(config.fusionPresets) ? config.fusionPresets : [];
        if (!presets.some(item => item.id === payload.id)) fail('该预设已不存在。');
        config.fusionPresets = presets.filter(item => item.id !== payload.id);
        if (config.defaultFusionUid === presetUid(payload.id)) delete config.defaultFusionUid;
        break;
      }
      case 'saveProvider': {
        const existing = payload.id ? providerAt(config, payload.id) : null;
        const name = text(payload.name, '供应商名称', 80), url = baseUrl(payload.baseUrl);
        if (!['openai-responses', 'openai', 'anthropic'].includes(payload.apiFormat)) fail('请选择 API 类型。');
        if (own(payload, 'apiKey') && (typeof payload.apiKey !== 'string' || payload.apiKey.length > 8192 || /[\r\n]/.test(payload.apiKey))) fail('API Key 无效。');
        const apiKey = payload.apiKey?.trim() || existing?.apiKey || '';
        if (existing) {
          const previousName = existing.name;
          Object.assign(existing, { name, baseUrl: url, apiFormat: payload.apiFormat, apiKey });
          if (name !== previousName) for (const model of existing.models) if (model.label?.startsWith(previousName + ' · ')) model.label = name + model.label.slice(previousName.length);
        } else {
          const provider = { id: 'provider-' + randomUUID(), name, baseUrl: url, apiFormat: payload.apiFormat, apiKey, enabled: true, models: [] };
          config.providers.push(provider);
          appendPreparation = { providerId: provider.id, modelIds: [], allowMissingProvider: true };
        }
        break;
      }
      case 'deleteProvider': providerAt(config, payload.id); config.providers = config.providers.filter(p => p.id !== payload.id); break;
      case 'setProviderEnabled': providerAt(config, payload.id).enabled = boolean(payload.enabled, '启用状态'); break;
      case 'refreshModels': {
        const original = providerAt(config, payload.providerId), fetched = structuredClone(original);
        pendingImport = undefined;
        await discover(fetched);
        // Read again after the network request so another window's edits survive.
        config = read(); const current = providerAt(config, payload.providerId);
        if (signature(current) !== signature(original)) fail('供应商配置刚刚发生变化，请重新刷新模型。');
        // Validate a private candidate catalog, without changing saved models.
        buildCatalog({ ...config, providers: [{ ...current, enabled: true, models: fetched.models }] });
        pendingImport = { providerId: current.id, signature: signature(current), token: randomUUID(), models: fetched.models };
        return state();
      }
      case 'importModels': {
        const provider = providerAt(config, payload.providerId);
        if (!pendingImport || pendingImport.providerId !== provider.id || pendingImport.token !== payload.token ||
            pendingImport.signature !== signature(provider)) fail('模型列表已失效，请重新获取后选择。');
        if (!Array.isArray(payload.ids) || !payload.ids.length || payload.ids.some(id => typeof id !== 'string') ||
            new Set(payload.ids).size !== payload.ids.length) fail('请选择要导入的模型。');
        const candidates = new Map(pendingImport.models.map(model => [model.id, model]));
        if (payload.ids.some(id => !candidates.has(id))) fail('所选模型不在获取的列表中，请重新选择。');
        const selected = new Set(payload.ids), existing = new Set(provider.models.map(model => model.id));
        const additions = pendingImport.models.filter(model => selected.has(model.id) && !existing.has(model.id));
        for (const candidate of additions) {
          provider.models.push({ ...candidate, label: provider.name + ' · ' + candidate.id, enabled: true });
        }
        if (additions.length) appendPreparation = { providerId: provider.id, modelIds: additions.map(model => model.id) };
        break;
      }
      case 'updateModels': {
        const provider = providerAt(config, payload.providerId);
        if (!Array.isArray(payload.changes || []) || !Array.isArray(payload.removeIds || [])) fail('模型修改列表无效。');
        for (const change of payload.changes || []) {
          const index = provider.models.findIndex(m => m.id === change?.id);
          if (index < 0) fail('该模型已不存在，请刷新面板。');
          provider.models[index] = modelPatch(change, provider.models[index]);
        }
        provider.models = provider.models.filter(m => !(payload.removeIds || []).includes(m.id));
        break;
      }
      case 'addModel': {
        const provider = providerAt(config, payload.providerId), input = payload.model;
        const id = text(input?.id, '模型 ID');
        if (provider.models.some(m => m.id === id)) fail('该模型已经在列表中。');
        provider.models.push(modelPatch(input, { id, label: id, enabled: true, efforts: [], contextWindow: 272000, maxOutputTokens: 131072 }));
        appendPreparation = { providerId: provider.id, modelIds: [id] };
        break;
      }
      case 'setNativeModelHidden': {
        const uid = payload.uid;
        if (typeof uid !== 'string' || !uid || uid.length > 256 || /^(?:fusion-)?ddevin-/.test(uid)) fail('模型标识无效。');
        const hidden = boolean(payload.hidden, '显示状态');
        if (hidden && !nativeModels().some(entry => entry?.uid === uid)) fail('该官方模型当前未出现在列表中，请刷新后重试。');
        // Fusion router uids live in hiddenFusionUids; normal entries in
        // hiddenNativeModelUids. Unhiding clears the uid from both lists so a
        // legacy misplaced entry cannot keep it hidden.
        const clean = (list, fusion) => {
          const seen = new Set(), out = [];
          for (const value of Array.isArray(list) ? list : []) {
            if (typeof value !== 'string' || !value || value.length > 256 || /^(?:fusion-)?ddevin-/.test(value) ||
                value.startsWith('fusion-') !== fusion || seen.has(value)) continue;
            seen.add(value); out.push(value);
          }
          return out;
        };
        const fusion = uid.startsWith('fusion-');
        config.hiddenNativeModelUids = clean(config.hiddenNativeModelUids, false).filter(value => value !== uid);
        config.hiddenFusionUids = clean(config.hiddenFusionUids, true).filter(value => value !== uid);
        if (hidden) (fusion ? config.hiddenFusionUids : config.hiddenNativeModelUids).push(uid);
        break;
      }
      case 'setRoleModel': {
        const role = payload.role;
        if (role !== 'lead' && role !== 'sidekick') fail('角色类型无效。');
        const enabled = boolean(payload.enabled, '启用状态');
        const model = payload.model;
        if (!model || typeof model !== 'object' || Array.isArray(model)) fail('模型参数无效。');
        const hasNative = typeof model.nativeUid === 'string' && !!model.nativeUid;
        const hasProvider = typeof model.providerId === 'string' && typeof model.model === 'string' && !!model.providerId && !!model.model;
        if ((hasNative && hasProvider) || (!hasNative && !hasProvider)) fail('模型身份无效。');
        const key = refKey(model);
        if (!key) fail('模型标识无效。');

        const currentRoles = buildRoleLists(config, nativeModels());
        const candidateList = currentRoles[role] || [];
        const candidate = candidateList.find(item => refKey(item.ref) === key);
        if (enabled && (!candidate || !candidate.available)) fail('该模型当前不可用，无法添加。');

        if (!config.roleExclusions) config.roleExclusions = { lead: [], sidekick: [] };
        if (!Array.isArray(config.roleExclusions[role])) config.roleExclusions[role] = [];
        if (!config.roleInclusions) config.roleInclusions = { lead: [], sidekick: [] };
        if (!Array.isArray(config.roleInclusions[role])) config.roleInclusions[role] = [];

        const refToStore = hasNative ? { nativeUid: model.nativeUid } : { providerId: model.providerId, model: model.model };
        if (enabled) {
          config.roleExclusions[role] = config.roleExclusions[role].filter(r => refKey(r) !== key);
          if (hasNative && !config.roleInclusions[role].some(r => refKey(r) === key)) {
            config.roleInclusions[role].push(refToStore);
          }
        } else {
          config.roleInclusions[role] = config.roleInclusions[role].filter(r => refKey(r) !== key);
          if (!config.roleExclusions[role].some(r => refKey(r) === key)) {
            config.roleExclusions[role].push(refToStore);
          }
        }
        break;
      }
      case 'setEnabled': config.enabled = boolean(payload.enabled, '启用状态'); break;
      case 'setListMode': {
        if (!LIST_MODES.includes(payload.mode)) fail('模型列表模式无效。');
        config.modelListMode = payload.mode;
        break;
      }
      case 'setCacheWarm': {
        const bounds = { ttlSeconds: [60, 3600], officialTtlSeconds: [60, 3600], maxGapMinutes: [5, 240],
          minPrefixTokens: [256, 200000], maxLineages: [1, 32], pingMaxTokens: [2, 64] };
        const bools = new Set(['enabled', 'byok', 'official', 'whileStreaming']);
        const patch = {};
        for (const [key, value] of Object.entries(payload)) {
          if (bools.has(key)) patch[key] = boolean(value, '缓存保温 ' + key);
          else if (key === 'maxPingsPerGap') {
            if (value !== 'auto' && !(Number.isSafeInteger(value) && value >= 1 && value <= 60)) fail('缓存保温 maxPingsPerGap 无效。');
            patch[key] = value;
          } else if (own(bounds, key)) {
            if (!Number.isSafeInteger(value) || value < bounds[key][0] || value > bounds[key][1]) fail('缓存保温 ' + key + ' 无效。');
            patch[key] = value;
          } else fail('未知的缓存保温设置项：' + key);
        }
        const current = config.cacheWarm && typeof config.cacheWarm === 'object' && !Array.isArray(config.cacheWarm) ? config.cacheWarm : {};
        config.cacheWarm = { ...current, ...patch };
        break;
      }
      case 'setLogLevel': {
        if (!['trace', 'debug', 'info', 'warn', 'error'].includes(payload.level)) fail('日志级别无效。');
        config.logLevel = payload.level;
        break;
      }
      default: fail('不支持的操作。');
    }
    // Reject only diagnostics the mutation introduces: bad entries already in
    // the file must not block unrelated panel operations.
    const added = buildCatalog(config, nativeModels()).diagnostics.find(item => !diagnosticsBefore.has(JSON.stringify(item)));
    if (added) fail('配置无效：' + (DIAGNOSTIC_TEXT[added.code] || added.code));
    // A corrupt config file is never overwritten: mutations are refused, except
    // 'setEnabled' which still runs its enable/disable side effects in memory.
    if (config.__invalid) {
      if (type !== 'setEnabled') fail('配置文件已损坏，已阻止写入；请修复或删除 ~/.ddevin/config.json 后重试。');
    } else {
      if (appendPreparation) {
        try {
          await orderStore.prepareAppend({ readConfig: read, ...appendPreparation });
        } catch (error) {
          throw new PanelInputError('配置未更新，面板展示顺序准备失败：' + (error?.message || '未知错误') +
            ' 请修复展示顺序文件或权限后重试。');
        }
      }
      await write(config);
    }
    // The business write already committed. Preference cleanup is a second file,
    // so a failure must be reported as such instead of pretending the delete
    // rolled back. Run cleanup before afterChange so a failing runtime side
    // effect cannot skip it; afterChange still gets to refresh real state.
    let orderCleanupError;
    try {
      if (type === 'deleteProvider') await orderStore.removeProvider({ readConfig: read, providerId: payload.id });
      else if (type === 'updateModels' && Array.isArray(payload.removeIds) && payload.removeIds.length) {
        await orderStore.removeModels({ readConfig: read, providerId: payload.providerId, modelIds: payload.removeIds });
      }
    } catch (error) { orderCleanupError = error; }
    if (type === 'importModels') pendingImport = undefined;
    await afterChange(type, type === 'setEnabled' ? { enabled: config.enabled } : {});
    if (orderCleanupError) {
      throw new PanelInputError('配置已更新，但面板展示顺序清理失败：' + (orderCleanupError?.message || '未知错误') + ' 请重试或修复展示顺序文件。');
    }
    return state();
  }
  return { state, dispatch(type, payload) {
    const operation = queue.then(() => apply(type, payload));
    queue = operation.catch(() => {}); return operation;
  } };
}
module.exports = { createManager, PanelInputError };
