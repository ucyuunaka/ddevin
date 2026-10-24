'use strict';

// Role eligibility: which official and BYOK models may serve as Fusion
// lead or sidekick, plus the panel-facing role lists.

const { ownUid, refKey } = require('./shared.cjs');

function discoverOfficialRoles(nativeModels, hiddenSet, config = {}) {
  const observed = Array.isArray(nativeModels) ? nativeModels : [];
  const observedUids = new Set();
  const nativeModelsMap = new Map();
  for (const entry of observed) {
    const uid = typeof entry?.uid === 'string' ? entry.uid : '';
    if (uid && uid.length <= 256 && !ownUid(uid) && !uid.startsWith('fusion-')) {
      observedUids.add(uid);
      nativeModelsMap.set(uid, entry);
    }
  }

  const reservedOrders = new Set(), reservedLeadOrders = new Set();
  const leadNamesByOrder = new Map(), leadClaimsByTuple = new Map();
  const sidekickClaimsByUid = new Map(), sidekickClaimsByOrder = new Map();
  const officialCombos = [];

  for (const entry of observed) {
    const uid = typeof entry?.uid === 'string' ? entry.uid : '';
    if (!uid.startsWith('fusion-') || ownUid(uid)) continue;
    const marker = uid.lastIndexOf('-sidekick-');
    if (marker < 0 || marker <= 'fusion-'.length) continue;

    const fusionMeta = Array.isArray(entry.fusionMetadata) ? entry.fusionMetadata : null;
    let leadDim = fusionMeta?.find(d => d.key === 'Lead');
    let effortDim = fusionMeta?.find(d => d.key === 'Effort');
    let sidekickDim = fusionMeta?.find(d => d.key === 'Sidekick');
    let fastModeDim = fusionMeta?.find(d => d.key === 'Fast Mode');

    if (!sidekickDim && entry.sidekickDimension) {
      sidekickDim = { order: entry.sidekickDimension.order, name: entry.sidekickDimension.name, controlType: 3 };
      fastModeDim = { order: entry.sidekickDimension.fastModeOrder ?? 0 };
    }

    if (leadDim && Number.isSafeInteger(leadDim.order) && leadDim.order >= 0 && leadDim.order <= 0x7fffffff) {
      reservedLeadOrders.add(leadDim.order);
    }
    if (sidekickDim && Number.isSafeInteger(sidekickDim.order) &&
        sidekickDim.order >= 0 && sidekickDim.order <= 0x7fffffff) {
      reservedOrders.add(sidekickDim.order);
    }

    const leadCandidate = uid.slice('fusion-'.length, marker);
    const sideCandidate = uid.slice(marker + '-sidekick-'.length);
    const leadKnown = observedUids.has(leadCandidate);
    const sideKnown = observedUids.has(sideCandidate);

    officialCombos.push({
      entry, uid, leadCandidate, sideCandidate, leadKnown, sideKnown,
      disabled: entry.disabled === true,
      fastModeOrder: fastModeDim ? fastModeDim.order : 0,
      leadDim, effortDim, sidekickDim,
    });

    if (fastModeDim && fastModeDim.order !== 0) continue;
    if (entry.disabled !== false) continue;
    if (!Array.isArray(entry.harnessUids) || !entry.harnessUids.includes('fusion')) continue;

    const sideNative = sideKnown ? nativeModelsMap.get(sideCandidate) : null;
    if (sideKnown && sideNative.disabled === false && sideNative.isModelRouter === false && sideNative.harnessUids?.length && !hiddenSet.has(sideCandidate)) {
      if (sidekickDim && Number.isSafeInteger(sidekickDim.order) && sidekickDim.name) {
        if (!sidekickClaimsByUid.has(sideCandidate)) {
          sidekickClaimsByUid.set(sideCandidate, { orders: new Set(), names: new Set() });
        }
        const rec = sidekickClaimsByUid.get(sideCandidate);
        rec.orders.add(sidekickDim.order);
        rec.names.add(sidekickDim.name);
        if (!sidekickClaimsByOrder.has(sidekickDim.order)) sidekickClaimsByOrder.set(sidekickDim.order, new Set());
        sidekickClaimsByOrder.get(sidekickDim.order).add(sideCandidate);
      }
    }

    if (!leadKnown || !sideKnown) continue;
    const leadNative = nativeModelsMap.get(leadCandidate);
    if (leadNative.disabled !== false || leadNative.isModelRouter !== false || !leadNative.harnessUids?.length || hiddenSet.has(leadCandidate)) continue;
    if (sideNative.disabled !== false || sideNative.isModelRouter !== false || !sideNative.harnessUids?.length || hiddenSet.has(sideCandidate)) continue;

    if (leadDim && Number.isSafeInteger(leadDim.order) && leadDim.name &&
        effortDim && Number.isSafeInteger(effortDim.order) && effortDim.name) {
      if (!leadNamesByOrder.has(leadDim.order)) leadNamesByOrder.set(leadDim.order, new Set());
      leadNamesByOrder.get(leadDim.order).add(leadDim.name);

      if (!leadClaimsByTuple.has(leadCandidate)) {
        leadClaimsByTuple.set(leadCandidate, {
          leadOrder: leadDim.order, leadName: leadDim.name,
          effortOrder: effortDim.order, effortName: effortDim.name,
          harnesses: new Set(),
          tuples: new Set(),
        });
      }
      const rec = leadClaimsByTuple.get(leadCandidate);
      rec.tuples.add(leadDim.order + ':' + effortDim.order + ':' + leadDim.name + ':' + effortDim.name);
      rec.harnesses.add(JSON.stringify(entry.harnessUids));
    }
  }

  const inconsistentLeadOrders = new Set();
  for (const [order, names] of leadNamesByOrder) {
    if (names.size > 1) inconsistentLeadOrders.add(order);
  }

  const leadConflicts = new Set();
  const uidByTuple = new Map();
  for (const [uid, rec] of leadClaimsByTuple) {
    if (rec.tuples.size !== 1 || rec.harnesses.size !== 1 || inconsistentLeadOrders.has(rec.leadOrder)) {
      leadConflicts.add(uid);
      continue;
    }
    const tupleKey = rec.leadOrder + ':' + rec.effortOrder;
    if (uidByTuple.has(tupleKey)) {
      leadConflicts.add(uid);
      leadConflicts.add(uidByTuple.get(tupleKey));
    } else {
      uidByTuple.set(tupleKey, uid);
    }
  }

  const sidekickConflicts = new Set();
  for (const uids of sidekickClaimsByOrder.values()) if (uids.size > 1) for (const u of uids) sidekickConflicts.add(u);
  for (const [u, rec] of sidekickClaimsByUid) {
    if (rec.orders.size !== 1 || rec.names.size !== 1) sidekickConflicts.add(u);
  }

  const eligibleNativeLeads = new Map();
  for (const [uid, rec] of leadClaimsByTuple) {
    if (leadConflicts.has(uid)) continue;
    const native = nativeModelsMap.get(uid);
    const harnesses = JSON.parse([...rec.harnesses][0]);
    eligibleNativeLeads.set(uid, {
      uid, label: native.label || uid,
      leadDimension: { order: rec.leadOrder, name: rec.leadName, controlType: 3 },
      effortDimension: { order: rec.effortOrder, name: rec.effortName, controlType: 1 },
      leadHarnessUids: harnesses,
      maxTokens: native.maxTokens,
      maxOutputTokens: native.maxOutputTokens,
      supportsImages: native.supportsImages,
    });
  }

  const eligibleNativeSidekicks = new Map();
  for (const [uid, rec] of sidekickClaimsByUid) {
    if (sidekickConflicts.has(uid)) continue;
    const native = nativeModelsMap.get(uid);
    const sidekickOrder = [...rec.orders][0];
    const sidekickName = [...rec.names][0];
    eligibleNativeSidekicks.set(uid, {
      uid, label: sidekickName || native.label || uid,
      dimension: { order: sidekickOrder, name: sidekickName },
      harnessUids: native.harnessUids,
    });
  }

  const hiddenFusionUids = [];
  if (config.enabled !== false) {
    const leadExclusions = new Set((Array.isArray(config.roleExclusions?.lead) ? config.roleExclusions.lead : []).map(refKey));
    const sidekickExclusions = new Set((Array.isArray(config.roleExclusions?.sidekick) ? config.roleExclusions.sidekick : []).map(refKey));
    for (const combo of officialCombos) {
      if (combo.disabled) {
        hiddenFusionUids.push(combo.uid);
        continue;
      }
      if (combo.leadDim && Number.isSafeInteger(combo.leadDim.order) &&
          combo.effortDim && Number.isSafeInteger(combo.effortDim.order)) {
        let leadExcluded = false;
        for (const [leadUid, native] of eligibleNativeLeads) {
          if (native.leadDimension && native.leadDimension.order === combo.leadDim.order &&
              native.effortDimension && native.effortDimension.order === combo.effortDim.order) {
            if (leadExclusions.has(refKey({ nativeUid: leadUid })) || hiddenSet.has(leadUid)) {
              leadExcluded = true; break;
            }
          }
        }
        if (leadExcluded) {
          hiddenFusionUids.push(combo.uid);
          continue;
        }
      }
      if (combo.sidekickDim && Number.isSafeInteger(combo.sidekickDim.order)) {
        let sideExcluded = false;
        for (const [sideUid, native] of eligibleNativeSidekicks) {
          if (native.dimension && native.dimension.order === combo.sidekickDim.order) {
            if (sidekickExclusions.has(refKey({ nativeUid: sideUid })) || hiddenSet.has(sideUid)) {
              sideExcluded = true; break;
            }
          }
        }
        if (sideExcluded) {
          hiddenFusionUids.push(combo.uid);
          continue;
        }
      }
      if (combo.leadKnown && combo.sideKnown) {
        const leadRef = refKey({ nativeUid: combo.leadCandidate });
        const sideRef = refKey({ nativeUid: combo.sideCandidate });
        const leadNative = nativeModelsMap.get(combo.leadCandidate);
        const sideNative = nativeModelsMap.get(combo.sideCandidate);
        const leadDisabled = leadNative?.disabled === true || leadNative?.isModelRouter === true || hiddenSet.has(combo.leadCandidate);
        const sideDisabled = sideNative?.disabled === true || sideNative?.isModelRouter === true || hiddenSet.has(combo.sideCandidate);
        if (leadDisabled || sideDisabled || leadExclusions.has(leadRef) || sidekickExclusions.has(sideRef)) {
          hiddenFusionUids.push(combo.uid);
          continue;
        }
      }
    }
  }

  return { eligibleNativeLeads, eligibleNativeSidekicks, reservedOrders, reservedLeadOrders, hiddenFusionUids };
}

function discoverNamedPresetRoles(nativeModels, hiddenSet, officialRoles) {
  const records = new Map();
  const conflicts = new Set();
  for (const entry of Array.isArray(nativeModels) ? nativeModels : []) {
    const uid = typeof entry?.uid === 'string' ? entry.uid : '';
    if (!uid || uid.length > 256 || ownUid(uid) || uid.startsWith('fusion-') || hiddenSet.has(uid)) continue;
    const harnessUids = entry.harnessUids;
    const eligible = entry.disabled === false && entry.isModelRouter === false && Array.isArray(harnessUids) &&
      harnessUids.length > 0 && harnessUids.every(value => typeof value === 'string' && value.trim().length > 0);
    const record = { uid, label: typeof entry.label === 'string' && entry.label ? entry.label : uid,
      harnessUids: Array.isArray(harnessUids) ? [...harnessUids] : null, eligible,
      maxTokens: entry.maxTokens, maxOutputTokens: entry.maxOutputTokens, supportsImages: entry.supportsImages === true };
    const prior = records.get(uid);
    if (prior && (prior.eligible !== record.eligible || JSON.stringify(prior.harnessUids) !== JSON.stringify(record.harnessUids) ||
      prior.label !== record.label)) conflicts.add(uid);
    else if (!prior) records.set(uid, record);
  }
  for (const uid of conflicts) records.delete(uid);
  const leads = new Map(), sidekicks = new Map();
  for (const native of records.values()) {
    if (!native.eligible) continue;
    const officialLead = officialRoles.eligibleNativeLeads.get(native.uid);
    const officialSidekick = officialRoles.eligibleNativeSidekicks.get(native.uid);
    leads.set(native.uid, officialLead || { ...native, leadHarnessUids: [...new Set(['fusion', ...native.harnessUids])] });
    sidekicks.set(native.uid, officialSidekick || { ...native, dimension: undefined });
  }
  return { eligibleNativeLeads: leads, eligibleNativeSidekicks: sidekicks };
}

function roleRefs(config = {}, role) {
  const exclusions = new Set((Array.isArray(config.roleExclusions?.[role]) ? config.roleExclusions[role] : []).map(refKey).filter(Boolean));
  const inclusions = new Set((Array.isArray(config.roleInclusions?.[role]) ? config.roleInclusions[role] : []).map(refKey).filter(Boolean));
  const saved = new Set();
  for (const preset of Array.isArray(config.fusionPresets) ? config.fusionPresets : []) {
    const key = refKey(preset?.[role]);
    if (key) saved.add(key);
  }
  return { exclusions, inclusions, saved };
}

function roleSelected(ref, refs, defaultSelected) {
  const key = refKey(ref);
  if (!key || refs.exclusions.has(key)) return false;
  return defaultSelected || refs.inclusions.has(key) || refs.saved.has(key);
}

function buildRoleLists(config = {}, nativeModels = []) {
  const hiddenSet = new Set(Array.isArray(config.hiddenNativeModelUids) ? config.hiddenNativeModelUids : []);
  const officialRoles = discoverOfficialRoles(nativeModels, hiddenSet, config);
  const { eligibleNativeLeads, eligibleNativeSidekicks } = discoverNamedPresetRoles(nativeModels, hiddenSet, officialRoles);
  const strictLeadUids = new Set(officialRoles.eligibleNativeLeads.keys());
  const strictSidekickUids = new Set(officialRoles.eligibleNativeSidekicks.keys());
  const leadRefs = roleRefs(config, 'lead');
  const sidekickRefs = roleRefs(config, 'sidekick');

  const providers = Array.isArray(config.providers) ? config.providers : [];
  const leadList = [], sidekickList = [];
  const seenLeadKeys = new Set(), seenSidekickKeys = new Set();

  for (const provider of providers) {
    if (!provider || typeof provider.id !== 'string') continue;
    const providerEnabled = provider.enabled !== false;
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (!model || typeof model.id !== 'string') continue;
      const ref = { providerId: provider.id, model: model.id };
      const key = refKey(ref);
      const prefix = provider.name || provider.id, sourceLabel = model.label || model.id;
      const label = sourceLabel.startsWith(prefix + ' · ') ? sourceLabel : `${prefix} · ${sourceLabel}`;
      const available = providerEnabled && model.enabled !== false;

      if (!seenLeadKeys.has(key)) {
        seenLeadKeys.add(key);
        leadList.push({
          ref, label, native: false,
          available, selected: available && roleSelected(ref, leadRefs, true),
          defaultSelected: available,
          ...(available ? {} : { disabled: true, reason: '已在供应商中停用' }),
        });
      }
      if (!seenSidekickKeys.has(key)) {
        seenSidekickKeys.add(key);
        sidekickList.push({
          ref, label, native: false,
          available, selected: available && roleSelected(ref, sidekickRefs, true),
          defaultSelected: available,
          ...(available ? {} : { disabled: true, reason: '已在供应商中停用' }),
        });
      }
    }
  }

  for (const nativeLead of eligibleNativeLeads.values()) {
    const ref = { nativeUid: nativeLead.uid };
    const key = refKey(ref);
    seenLeadKeys.add(key);
    leadList.push({
      ref, label: nativeLead.label || nativeLead.uid, native: true,
      available: true, selected: roleSelected(ref, leadRefs, strictLeadUids.has(nativeLead.uid)),
      defaultSelected: strictLeadUids.has(nativeLead.uid),
      explicitIncluded: leadRefs.inclusions.has(key) || leadRefs.saved.has(key),
    });
  }

  for (const nativeSidekick of eligibleNativeSidekicks.values()) {
    const ref = { nativeUid: nativeSidekick.uid };
    const key = refKey(ref);
    seenSidekickKeys.add(key);
    sidekickList.push({
      ref, label: nativeSidekick.label || nativeSidekick.uid, native: true,
      available: true, selected: roleSelected(ref, sidekickRefs, strictSidekickUids.has(nativeSidekick.uid)),
      defaultSelected: strictSidekickUids.has(nativeSidekick.uid),
      explicitIncluded: sidekickRefs.inclusions.has(key) || sidekickRefs.saved.has(key),
    });
  }

  for (const role of ['lead', 'sidekick']) {
    const list = role === 'lead' ? leadList : sidekickList;
    const seen = role === 'lead' ? seenLeadKeys : seenSidekickKeys;
    for (const kind of ['roleExclusions', 'roleInclusions']) {
      for (const ref of Array.isArray(config[kind]?.[role]) ? config[kind][role] : []) {
        const key = refKey(ref);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        list.push({
          ref, label: ref.nativeUid || ((ref.providerId || '') + ' · ' + (ref.model || '')),
          native: !!ref.nativeUid, available: false, selected: false, defaultSelected: false,
          ...(kind === 'roleInclusions' ? { explicitIncluded: true } : {}),
          disabled: true, reason: '当前未在可用列表中',
        });
      }
    }
  }

  return { lead: leadList, sidekick: sidekickList };
}

module.exports = { discoverOfficialRoles, discoverNamedPresetRoles, roleRefs, roleSelected, buildRoleLists };
