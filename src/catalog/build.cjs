'use strict';

// Catalog construction: BYOK routes, picker model entries, fusion presets,
// candidate lists and lenient diagnostics.

const { LIST_MODES, ownUid, digest, slug, positive, refKey, presetUid, effortMetadata, configFor } = require('./shared.cjs');

const { discoverOfficialRoles, discoverNamedPresetRoles, buildRoleLists } = require('./roles.cjs');

const { modelEfforts, modelSupportsImages } = require('../capabilities.cjs');

function normalizeFusionConfig(config, nativeModels = []) {
  if (Object.hasOwn(config, 'fusionPresets') || config.enabled === false) return config;
  const catalog = buildCatalog(config, nativeModels);
  if (!catalog.migrationPending) {
    config.fusionPresets = catalog.savedPresets;
    if (catalog.migratedFrom) config.defaultFusionUid = catalog.defaultFusionUid;
  }
  return config;
}

/** Build a secret-free catalog. Provider credentials stay solely in caller configuration. */
function buildCatalog(config = {}, nativeModels = [], options = {}) {
  const strict = options.strict === true;
  const diagnostics = [];
  if (config.enabled === false) {
    return { models: [], routes: {}, fusions: {}, sidekicks: [], hiddenNativeModelUids: [], hiddenFusionUids: [], diagnostics };
  }
  const mode = LIST_MODES.includes(config.modelListMode) ? config.modelListMode : 'coexist';
  const models = [], routes = {}, fusions = {}, leads = [];
  let inferenceServerUrl = config.inferenceServerUrl || 'https://server.codeium.com';
  try {
    const inferenceUrl = new URL(inferenceServerUrl);
    if (!['http:', 'https:'].includes(inferenceUrl.protocol) || inferenceUrl.username || inferenceUrl.password) {
      throw new Error('Invalid inference server URL');
    }
  } catch (error) {
    if (strict) throw error;
    diagnostics.push({ code: 'invalid_inference_url' });
    inferenceServerUrl = 'https://server.codeium.com';
  }
  const providers = Array.isArray(config.providers) ? config.providers.filter(provider => provider && provider.enabled !== false) : [];
  const identities = new Set();
  for (const provider of providers) {
    if (typeof provider.id !== 'string' || !provider.id) {
      if (strict) throw new Error('Provider id is required');
      diagnostics.push({ code: 'provider_id_missing' });
      continue;
    }
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (!model || model.enabled === false) continue;
      if (typeof model.id !== 'string' || !model.id) {
        if (strict) throw new Error('Model id is required');
        diagnostics.push({ code: 'model_id_missing', providerId: provider.id });
        continue;
      }
      const key = JSON.stringify([provider.id, model.id]);
      if (identities.has(key)) {
        if (strict) throw new Error('Duplicate provider/model identity');
        diagnostics.push({ code: 'duplicate_model', providerId: provider.id, modelId: model.id });
        continue;
      }
      identities.add(key);
      const prefix = provider.name || provider.id, sourceLabel = model.label || model.id;
      const familyLabel = sourceLabel.startsWith(prefix + ' · ') ? sourceLabel : `${prefix} · ${sourceLabel}`;
      const efforts = modelEfforts(model);
      for (const effort of efforts) {
        if (effort !== null && (typeof effort !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(effort))) {
          if (strict) throw new Error('Invalid effort value');
          diagnostics.push({ code: 'invalid_effort', providerId: provider.id, modelId: model.id, effort: String(effort).slice(0, 64) });
          continue;
        }
        const uid = `ddevin-${slug(provider.id)}-${slug(model.id)}-${digest([provider.id, model.id, effort]).slice(0, 16)}`;
        const contextWindow = positive(model.contextWindow, 272000);
        const maxOutputTokens = Math.min(positive(model.maxOutputTokens, 131072), contextWindow);
        const lead = { uid, key, familyLabel, providerId: provider.id, model: model.id, effort,
          contextWindow, maxOutputTokens, supportsImages: modelSupportsImages(model), inferenceServerUrl,
          defaultEffort: typeof model.defaultEffort === 'string' ? model.defaultEffort : null };
        leads.push(lead);
        routes[uid] = { uid, providerId: provider.id, model: model.id, effort, maxOutputTokens };
      }
    }
  }
  const hiddenNativeModelUids = [];
  for (const uid of Array.isArray(config.hiddenNativeModelUids) ? config.hiddenNativeModelUids : []) {
    if (typeof uid !== 'string' || !uid || uid.length > 256 || ownUid(uid) || hiddenNativeModelUids.includes(uid)) continue;
    hiddenNativeModelUids.push(uid);
  }
  // 'byok' list mode hides every observed official model and official fusion.
  if (mode === 'byok') {
    for (const entry of Array.isArray(nativeModels) ? nativeModels : []) {
      const uid = typeof entry?.uid === 'string' ? entry.uid : '';
      if (uid && !ownUid(uid) && !hiddenNativeModelUids.includes(uid)) hiddenNativeModelUids.push(uid);
    }
  }
  const hiddenSet = new Set(hiddenNativeModelUids);
  const officialRoles = discoverOfficialRoles(nativeModels, hiddenSet, config);
  const { eligibleNativeLeads: presetNativeLeads, eligibleNativeSidekicks: presetNativeSidekicks } =
    discoverNamedPresetRoles(nativeModels, hiddenSet, officialRoles);
  const { eligibleNativeLeads, eligibleNativeSidekicks, hiddenFusionUids } = officialRoles;
  if (mode === 'byok') {
    for (const entry of Array.isArray(nativeModels) ? nativeModels : []) {
      const uid = typeof entry?.uid === 'string' ? entry.uid : '';
      if (uid.startsWith('fusion-') && !ownUid(uid) && !hiddenFusionUids.includes(uid)) hiddenFusionUids.push(uid);
    }
  }
  for (const uid of Array.isArray(config.hiddenFusionUids) ? config.hiddenFusionUids : []) {
    if (typeof uid === 'string' && uid.length <= 256 && uid.startsWith('fusion-') && !ownUid(uid) && !hiddenFusionUids.includes(uid)) hiddenFusionUids.push(uid);
  }

  // Variants of one provider model form a picker family keyed by familyUid.
  // The family's default member is the model's defaultEffort when configured,
  // else the provider-default (null) variant, else the first variant.
  const leadFamilies = new Map();
  for (const lead of leads) {
    if (!leadFamilies.has(lead.key)) leadFamilies.set(lead.key, []);
    leadFamilies.get(lead.key).push(lead);
  }
  const familyDefault = variants =>
    variants.find(variant => variant.defaultEffort !== null && (variant.effort ?? null) === variant.defaultEffort)
      ?? variants.find(variant => !variant.effort) ?? variants[0];

  // Labels also identify entries in native sort groups. Disambiguate providers
  // with equal display names without changing stable routing identities.
  const familyKeys = new Map();
  for (const lead of leads) {
    if (!familyKeys.has(lead.familyLabel)) familyKeys.set(lead.familyLabel, new Set());
    familyKeys.get(lead.familyLabel).add(lead.key);
  }
  for (const lead of leads) if (familyKeys.get(lead.familyLabel).size > 1) lead.familyLabel += ` (${lead.providerId}/${lead.model})`;
  for (const lead of leads) {
    const effort = effortMetadata(lead.effort);
    models.push(configFor({ ...lead, label: lead.familyLabel + (lead.effort ? ` ${effort.name}` : ''),
      isDefault: familyDefault(leadFamilies.get(lead.key)) === lead,
      familyUid: 'ddevin-family-' + digest(lead.key).slice(0, 16),
      family: { modelFamilyLabel: lead.familyLabel, entries: [{ key: 'Effort', value: effort }] } }));
  }

  const roleSelection = buildRoleLists(config, nativeModels);
  const selectedLeadKeys = new Set(roleSelection.lead.filter(item => item.selected).map(item => refKey(item.ref)));
  const selectedSidekickKeys = new Set(roleSelection.sidekick.filter(item => item.selected).map(item => refKey(item.ref)));

  const selectedImportedLeads = leads.filter(lead => selectedLeadKeys.has(refKey({ providerId: lead.providerId, model: lead.model })));
  const selectedPresetNativeLeads = [...presetNativeLeads.values()].filter(native => selectedLeadKeys.has(refKey({ nativeUid: native.uid })));
  const presetNativeSidekickCandidates = [...presetNativeSidekicks.values()].filter(native => selectedSidekickKeys.has(refKey({ nativeUid: native.uid })));

  const sidekicks = [], seenSidekicks = new Set();
  for (const [key, candidates] of leadFamilies) {
    const lead = candidates.find(item => !item.effort) || candidates.find(item => item.effort === 'high') || candidates[0];
    if (!lead) continue;
    const ref = { providerId: lead.providerId, model: lead.model };
    if (!seenSidekicks.has(key) && selectedSidekickKeys.has(refKey(ref))) {
      seenSidekicks.add(key);
      sidekicks.push({ uid: lead.uid, label: lead.familyLabel, native: false, providerId: lead.providerId, model: lead.model });
    }
  }
  for (const native of [...eligibleNativeSidekicks.values()].sort((a, b) => a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)) {
    const ref = { nativeUid: native.uid };
    if (!seenSidekicks.has(native.uid) && selectedSidekickKeys.has(refKey(ref))) {
      seenSidekicks.add(native.uid);
      sidekicks.push({ uid: native.uid, label: native.label, native: true, harnessUids: native.harnessUids, dimension: native.dimension });
    }
  }

  const importedCandidate = lead => ({ ...lead, native: false,
    ref: { providerId: lead.providerId, model: lead.model, effort: lead.effort },
    label: lead.familyLabel + (lead.effort ? ` · ${effortMetadata(lead.effort).name}` : ' · 默认档位') });
  const candidates = {
    lead: [...selectedImportedLeads.map(importedCandidate), ...selectedPresetNativeLeads.map(native => ({
      ...native, native: true, ref: { nativeUid: native.uid },
      contextWindow: positive(native.maxTokens, 272000),
      maxOutputTokens: Math.min(positive(native.maxOutputTokens, 16384), positive(native.maxTokens, 272000)),
      inferenceServerUrl,
    }))],
    sidekick: [...leads.filter(lead => selectedSidekickKeys.has(refKey({ providerId: lead.providerId, model: lead.model }))).map(importedCandidate),
      ...presetNativeSidekickCandidates.map(native => ({ ...native, native: true, ref: { nativeUid: native.uid } }))],
  };
  const candidateKey = ref => refKey(ref) && !(ref.nativeUid && Object.hasOwn(ref, 'effort')) && JSON.stringify([refKey(ref), ref.nativeUid ? null : ref.effort ?? null]);
  const indexes = Object.fromEntries(Object.entries(candidates).map(([role, items]) => [role, new Map(items.map(item => [candidateKey(item.ref), item]))]));
  let savedPresets = Array.isArray(config.fusionPresets) ? config.fusionPresets : [];
  let migratedFrom;
  if (!Object.hasOwn(config, 'fusionPresets') && typeof config.defaultFusionUid === 'string') {
    const oldUid = config.defaultFusionUid;
    let lead, sidekick;
    if (oldUid.startsWith('fusion-ddevin-native-')) {
      for (const native of candidates.lead.filter(item => item.native)) {
        const found = sidekicks.find(item => !item.native && oldUid === `fusion-ddevin-native-${digest([native.uid, item.uid]).slice(0, 24)}`);
        if (found) { lead = native; sidekick = candidates.sidekick.find(item => item.uid === found.uid); break; }
      }
    } else {
      lead = candidates.lead.find(item => !item.native && oldUid.startsWith(`fusion-${item.uid}-sidekick-`));
      if (lead) sidekick = candidates.sidekick.find(item => oldUid === `fusion-${lead.uid}-sidekick-${digest(item.uid).slice(0, 16)}`);
    }
    if (lead && sidekick) {
      savedPresets = [{ id: 'legacy-default', name: '原默认组合', lead: lead.ref, sidekick: sidekick.ref }];
      migratedFrom = oldUid;
    }
  }
  const nameCounts = new Map(), idCounts = new Map();
  for (const preset of savedPresets) {
    if (typeof preset?.name === 'string') nameCounts.set(preset.name.trim().toLowerCase(), (nameCounts.get(preset.name.trim().toLowerCase()) || 0) + 1);
    if (typeof preset?.id === 'string') idCounts.set(preset.id, (idCounts.get(preset.id) || 0) + 1);
  }
  const presetStates = [];
  const labels = new Set([...models.map(item => item.label), ...nativeModels.map(item => item.label)]);
  const presetModels = [];
  for (const preset of savedPresets) {
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) continue;
    const valid = typeof preset.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(preset.id) && idCounts.get(preset.id) === 1 &&
      typeof preset.name === 'string' && preset.name.trim().length > 0 && preset.name.length <= 80 && !/[\u0000-\u001f]/.test(preset.name) && nameCounts.get(preset.name.trim().toLowerCase()) === 1;
    const lead = indexes.lead.get(candidateKey(preset.lead));
    const sidekick = indexes.sidekick.get(candidateKey(preset.sidekick));
    const uid = presetUid(preset.id);
    const available = !!(valid && lead && sidekick);
    presetStates.push({ id: preset.id, name: preset.name, lead: preset.lead, sidekick: preset.sidekick, uid, available,
      leadLabel: lead?.label, sidekickLabel: sidekick?.label,
      reason: !valid ? '预设名称或标识无效或重复' : !lead ? 'Lead 当前不可用或已从角色列表移除' : !sidekick ? 'Sidekick 当前不可用或已从角色列表移除' : '' });
    if (!available) continue;
    let label = preset.name.trim();
    if (labels.has(label)) label += ` · Fusion ${digest(preset.id).slice(0, 8)}`;
    labels.add(label);
    const familyUid = `ddevin-preset-family-${digest(preset.id).slice(0, 24)}`;
    // An imported lead exposes every effort variant of its model as one picker
    // family with an Effort dimension — the same shape official Fusion rows
    // use. The preset's chosen effort keeps the canonical preset uid (saved
    // selections keep resolving); alternates get a deterministic suffix.
    const variants = !lead.native && (leadFamilies.get(lead.key)?.length ?? 0) > 1 ? leadFamilies.get(lead.key) : [lead];
    for (const variant of variants) {
      const effort = effortMetadata(variant.effort);
      const pinned = (variant.effort ?? null) === (lead.effort ?? null);
      const variantUid = pinned ? uid : `${uid}-${digest(['preset-variant', preset.id, variant.effort ?? null]).slice(0, 8)}`;
      let variantLabel = pinned ? label : `${label} · ${effort.name}`;
      if (!pinned && labels.has(variantLabel)) variantLabel += ` ${digest([preset.id, variant.effort ?? 'default']).slice(0, 8)}`;
      labels.add(variantLabel);
      const family = { modelFamilyLabel: label, entries: variants.length > 1 ? [{ key: 'Effort', value: effort }] : [] };
      presetModels.push(configFor({ ...variant, uid: variantUid, label: variantLabel, family, familyUid, fusion: true, isDefault: pinned }));
      fusions[variantUid] = { uid: variantUid, label: variantLabel, presetId: preset.id,
        leadUid: variant.uid, sidekickUid: sidekick.uid,
        leadNative: lead.native, sidekickNative: sidekick.native,
        ...(pinned ? { canonical: true } : {}),
        ...(lead.native ? { leadHarnessUids: lead.leadHarnessUids } : {}),
        ...(sidekick.native ? { sidekickHarnessUids: sidekick.harnessUids } : {}) };
    }
  }
  const result = { diagnostics, models: [...presetModels, ...models], routes, fusions, sidekicks, hiddenNativeModelUids, hiddenFusionUids,
    presetStates, savedPresets, migratedFrom,
    migrationPending: !Object.hasOwn(config, 'fusionPresets') && !!config.defaultFusionUid && !migratedFrom,
    presetCandidates: Object.fromEntries(Object.entries(candidates).map(([role, items]) => [role, items.map(item => ({ ref: item.ref, label: item.label }))])),
    defaultFusionUid: migratedFrom ? presetUid('legacy-default') : typeof config.defaultFusionUid === 'string' ? config.defaultFusionUid : undefined };
  // 'official' list mode injects nothing of ours; panel-facing preset state
  // and user-chosen native hides still apply.
  if (mode === 'official') return { ...result, models: [], routes: {}, fusions: {}, sidekicks: [] };
  return result;
}

module.exports = { buildCatalog, normalizeFusionConfig };
