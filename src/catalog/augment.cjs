'use strict';

// Response augmentation: inject ddevin catalog entries into Devin's native
// catalog RPC payloads and resolve AssignModel for fusion routers.

const { parseFields, str, num, s, m } = require('../protocol/wire.cjs');

const { OWN_GROUP, FUSION_GROUP, SIDEKICK_HARNESSES, ownUid, has, concat } = require('./shared.cjs');

function rpcShape(rpc) {
  let value = typeof rpc === 'string' ? rpc : rpc?.path || rpc?.name || '';
  try { if (value.includes('://')) value = new URL(value).pathname; } catch { return null; }
  value = value.split('?')[0];
  const method = value.slice(value.lastIndexOf('/') + 1);
  if (method === 'GetUserStatus') return { status: true, field: 1, sorts: true };
  if (['GetCliModelConfigs', 'GetCascadeModelConfigs', 'GetCommandModelConfigs'].includes(method)) return { status: false, sorts: method === 'GetCascadeModelConfigs' };
  return null;
}

function rewriteMessage(data, number, transform, create = false) {
  const parsed = parseFields(data), matches = parsed.filter(field => field.number === number);
  if (matches.length > 1 || matches.some(field => field.wire !== 2)) throw new Error('Ambiguous catalog message');
  if (!matches.length) return create ? concat([data, m(number, transform(Buffer.alloc(0)))]) : data;
  return concat(parsed.map(field => field.number === number ? m(number, transform(field.value)) : field.raw));
}

// The server marks Fusion combinations the account cannot use as disabled.
// Report every native `fusion-` router uid and which are locked so assignment
// interception can fall back to the configured combination.
function reportFusionStatus(entries, isJson, report) {
  if (typeof report !== 'function') return;
  try {
    const seen = [], locked = [];
    for (const entry of entries) {
      const uid = isJson ? entry?.modelUid ?? entry?.model_uid : str(entry, 22);
      if (typeof uid !== 'string' || !uid.startsWith('fusion-') || ownUid(uid)) continue;
      seen.push(uid);
      if (isJson ? entry.disabled === true : num(entry, 4) === 1) locked.push(uid);
    }
    if (seen.length) report(locked, seen);
  } catch {}
}

function protoUid(entry) {
  const uids = parseFields(entry).filter(field => field.number === 22);
  if (uids.length !== 1 || uids[0].wire !== 2) return '';
  return uids[0].value.toString('utf8');
}

function protoDisabled(entry) {
  const flags = parseFields(entry).filter(field => field.number === 4);
  if (!flags.length) return false;
  if (flags.length !== 1 || flags[0].wire !== 0) return true;
  return Number(flags[0].value) !== 0;
}

function protoMetadata(entry) {
  const infos = parseFields(entry).filter(field => field.number === 23);
  if (infos.length !== 1 || infos[0].wire !== 2) return { harnessUids: [], isModelRouter: false };
  try {
    const inner = parseFields(infos[0].value);
    const harnesses = inner.filter(field => field.number === 20);
    if (harnesses.some(field => field.wire !== 2)) return { harnessUids: [], isModelRouter: false };
    const routers = inner.filter(field => field.number === 25);
    if (routers.length > 1 || routers.some(field => field.wire !== 0)) return { harnessUids: [], isModelRouter: false };
    const maxTokensFields = inner.filter(field => field.number === 4);
    const maxOutputFields = inner.filter(field => field.number === 13);
    const featuresFields = inner.filter(field => field.number === 6);
    let maxTokens, maxOutputTokens, supportsImages = false;
    if (maxTokensFields.length === 1 && maxTokensFields[0].wire === 0) {
      const val = Number(maxTokensFields[0].value);
      if (Number.isSafeInteger(val) && val > 0) maxTokens = val;
    }
    if (maxOutputFields.length === 1 && maxOutputFields[0].wire === 0) {
      const val = Number(maxOutputFields[0].value);
      if (Number.isSafeInteger(val) && val > 0) maxOutputTokens = val;
    }
    if (featuresFields.length === 1 && featuresFields[0].wire === 2) {
      const featInner = parseFields(featuresFields[0].value);
      const imgFields = featInner.filter(f => f.number === 11);
      if (imgFields.length === 1 && imgFields[0].wire === 0 && Number(imgFields[0].value) === 1) {
        supportsImages = true;
      }
    }
    return {
      harnessUids: harnesses.map(field => field.value.toString('utf8')),
      isModelRouter: routers.length === 1 && Number(routers[0].value) !== 0,
      ...(maxTokens ? { maxTokens } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(supportsImages ? { supportsImages: true } : {}),
    };
  } catch { return { harnessUids: [], isModelRouter: false }; }
}

const CANONICAL_FAMILY_KEYS = new Set(['Lead', 'Effort', 'Sidekick', 'Fast Mode', 'Recommended Sidekick']);

function protoFusionMetadata(entry) {
  const families = parseFields(entry).filter(field => field.number === 30);
  if (!families.length) return null;
  if (families.length !== 1 || families[0].wire !== 2) return null;
  try {
    const parts = parseFields(families[0].value);
    if (parts.some(field => field.number === 2 && field.wire !== 2)) return null;
    const entries = [];
    const keys = new Set();
    for (const field of parts.filter(field => field.number === 2)) {
      const item = parseFields(field.value);
      const keyFields = item.filter(part => part.number === 1);
      if (keyFields.length !== 1 || keyFields[0].wire !== 2) return null;
      const key = keyFields[0].value.toString('utf8');
      if (!CANONICAL_FAMILY_KEYS.has(key)) continue;
      if (keys.has(key)) return null;
      keys.add(key);
      const valFields = item.filter(part => part.number === 2);
      if (valFields.length !== 1 || valFields[0].wire !== 2) return null;
      const dims = parseFields(valFields[0].value);
      const orders = dims.filter(part => part.number === 1);
      const names = dims.filter(part => part.number === 2);
      const controls = dims.filter(part => part.number === 3);
      if (orders.length !== 1 || orders[0].wire !== 0) return null;
      if (names.length > 1 || names.some(part => part.wire !== 2)) return null;
      if (controls.length > 1 || controls.some(part => part.wire !== 0)) return null;
      const order = Number(orders[0].value);
      const name = names.length ? names[0].value.toString('utf8') : '';
      const controlType = controls.length ? Number(controls[0].value) : 0;
      if (!Number.isSafeInteger(order) || order < 0 || order > 0x7fffffff) return null;
      if (!Number.isSafeInteger(controlType) || controlType < 0 || controlType > 0x7fffffff) return null;
      if (key !== 'Fast Mode' && !name) return null;
      entries.push({ key, order, name, controlType });
    }
    return entries.length ? entries : null;
  } catch { return null; }
}

function extractSidekickDimension(entries) {
  if (!Array.isArray(entries)) return null;
  const sidekick = entries.find(e => e.key === 'Sidekick');
  if (!sidekick || !sidekick.name) return null;
  const fastMode = entries.find(e => e.key === 'Fast Mode');
  return { order: sidekick.order, name: sidekick.name, fastModeOrder: fastMode ? fastMode.order : 0 };
}

function protoSidekick(entry) {
  return extractSidekickDimension(protoFusionMetadata(entry));
}

function jsonAliasValue(object, camel, snake) {
  const hasCamel = has(object, camel), hasSnake = has(object, snake);
  if (hasCamel && hasSnake && JSON.stringify(object[camel]) !== JSON.stringify(object[snake])) return { conflict: true };
  return { value: hasCamel ? object[camel] : object[snake], present: hasCamel || hasSnake };
}

function jsonMetadata(entry) {
  const empty = { harnessUids: [], isModelRouter: false };
  const info = jsonAliasValue(entry, 'modelInfo', 'model_info');
  if (info.conflict || !info.present || !info.value || typeof info.value !== 'object' || Array.isArray(info.value)) return empty;
  const harness = jsonAliasValue(info.value, 'harnessUids', 'harness_uids');
  const router = jsonAliasValue(info.value, 'isModelRouter', 'is_model_router');
  if (harness.conflict || router.conflict) return empty;
  if (harness.present && (!Array.isArray(harness.value) || harness.value.some(value => typeof value !== 'string'))) return empty;
  if (router.present && typeof router.value !== 'boolean') return empty;
  const maxTokens = jsonAliasValue(info.value, 'maxTokens', 'max_tokens');
  const maxOutputTokens = jsonAliasValue(info.value, 'maxOutputTokens', 'max_output_tokens');
  const features = jsonAliasValue(info.value, 'modelFeatures', 'model_features');
  let supportsImages = false;
  if (!features.conflict && features.present && features.value && typeof features.value === 'object' && !Array.isArray(features.value)) {
    const img = jsonAliasValue(features.value, 'supportsImages', 'supports_images');
    if (!img.conflict && img.present && img.value === true) supportsImages = true;
  }
  return {
    harnessUids: harness.present ? harness.value : [],
    isModelRouter: router.value === true,
    ...(!maxTokens.conflict && maxTokens.present && Number.isSafeInteger(maxTokens.value) && maxTokens.value > 0 ? { maxTokens: maxTokens.value } : {}),
    ...(!maxOutputTokens.conflict && maxOutputTokens.present && Number.isSafeInteger(maxOutputTokens.value) && maxOutputTokens.value > 0 ? { maxOutputTokens: maxOutputTokens.value } : {}),
    ...(supportsImages ? { supportsImages: true } : {}),
  };
}

function jsonFusionMetadata(entry) {
  const meta = jsonAliasValue(entry, 'modelFamilyMetadata', 'model_family_metadata');
  if (meta.conflict || !meta.present || !meta.value || typeof meta.value !== 'object' || Array.isArray(meta.value)) return null;
  const list = meta.value.entries;
  if (!Array.isArray(list)) return null;
  const entries = [];
  const keys = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.key !== 'string') return null;
    const key = item.key;
    if (!CANONICAL_FAMILY_KEYS.has(key)) continue;
    if (keys.has(key)) return null;
    keys.add(key);
    const value = item.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const control = jsonAliasValue(value, 'controlType', 'control_type');
    if (control.conflict || (control.present && (!Number.isSafeInteger(control.value) || control.value < 0 || control.value > 0x7fffffff))) return null;
    if (!Number.isSafeInteger(value.order) || value.order < 0 || value.order > 0x7fffffff) return null;
    if (value.name !== undefined && typeof value.name !== 'string') return null;
    const name = typeof value.name === 'string' ? value.name : '';
    const controlType = control.present ? control.value : 0;
    if (key !== 'Fast Mode' && !name) return null;
    entries.push({ key, order: value.order, name, controlType });
  }
  return entries.length ? entries : null;
}

function jsonSidekick(entry) {
  return extractSidekickDimension(jsonFusionMetadata(entry));
}

function nativeEntries(entries, isJson) {
  const seen = [];
  for (const entry of entries) {
    let uid, label, disabled, meta, dimension, fusionMeta;
    if (isJson) {
      uid = nativeUid(entry);
      label = typeof entry?.label === 'string' ? entry.label : '';
      disabled = has(entry, 'disabled') ? entry.disabled !== false : false;
      meta = jsonMetadata(entry);
      fusionMeta = jsonFusionMetadata(entry);
      dimension = extractSidekickDimension(fusionMeta);
    } else {
      uid = protoUid(entry);
      label = str(entry, 1);
      disabled = protoDisabled(entry);
      meta = protoMetadata(entry);
      fusionMeta = protoFusionMetadata(entry);
      dimension = extractSidekickDimension(fusionMeta);
    }
    if (typeof uid !== 'string' || !uid || uid.length > 256 || ownUid(uid)) continue;
    seen.push({
      uid, label, disabled, harnessUids: meta.harnessUids, isModelRouter: meta.isModelRouter,
      ...(dimension ? { sidekickDimension: dimension } : {}),
      ...(fusionMeta ? { fusionMetadata: fusionMeta } : {}),
      ...(meta.maxTokens ? { maxTokens: meta.maxTokens } : {}),
      ...(meta.maxOutputTokens ? { maxOutputTokens: meta.maxOutputTokens } : {}),
      ...(meta.supportsImages ? { supportsImages: true } : {}),
    });
  }
  return seen;
}

function reportNativeModels(entries, isJson, report) {
  if (typeof report !== 'function') return;
  try { const seen = nativeEntries(entries, isJson); if (seen.length) report(seen); } catch {}
}

function defaultFusion(catalog) {
  const uid = catalog?.defaultFusionUid;
  if (typeof uid !== 'string' || !has(catalog?.fusions, uid)) return null;
  const fusion = catalog.fusions[uid];
  return fusion?.sidekickNative === false && fusion?.leadNative !== true && has(catalog?.routes, fusion.leadUid) && has(catalog?.routes, fusion.sidekickUid) ? fusion : null;
}

function augmentProtoList(data, catalog, hasSorts = true, onFusionStatus, onNativeModels) {
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const parsed = parseFields(data), existingLabels = new Set(models.map(model => model.label));
  const entries = parsed.filter(field => field.number === 1 && field.wire === 2).map(field => field.value);
  reportFusionStatus(entries, false, onFusionStatus);
  reportNativeModels(entries, false, onNativeModels);
  const hiddenNative = new Set(catalog.hiddenNativeModelUids || []);
  const hiddenFusion = new Set(catalog.hiddenFusionUids || []);
  const retainedLabels = new Set(models.map(model => model.label));
  const hiddenLabels = new Set();
  const preserved = [];
  for (const field of parsed) {
    if (field.number === 1 && field.wire === 2) {
      const uid = protoUid(field.value), label = str(field.value, 1);
      if (ownUid(uid)) { existingLabels.add(label); continue; }
      if (hiddenNative.has(uid)) { if (label) hiddenLabels.add(label); continue; }
      if (hiddenFusion.has(uid)) { if (label) hiddenLabels.add(label); continue; }
      retainedLabels.add(label);
    }
    preserved.push(field);
  }
  for (const label of hiddenLabels) if (retainedLabels.has(label)) hiddenLabels.delete(label);
  const labels = models.map(model => model.label);
  const groups = [{ name: FUSION_GROUP, items: models.filter(model => model.kind === 'fusion') },
    { name: OWN_GROUP, items: models.filter(model => model.kind !== 'fusion') }]
    .filter(group => group.items.length).map(group => concat([s(1, group.name), ...group.items.map(model => s(2, model.label))]));
  let sorts = 0;
  const result = preserved.map(field => {
    if (!hasSorts || field.number !== 2 || field.wire !== 2) return field.raw;
    sorts++;
    const parts = parseFields(field.value).filter(part => {
      if (part.number !== 2 || part.wire !== 2 || ![OWN_GROUP, FUSION_GROUP].includes(str(part.value, 1))) return true;
      return !parseFields(part.value).filter(value => value.number === 2 && value.wire === 2)
        .every(value => existingLabels.has(value.value.toString('utf8')));
    });
    const position = parts.findIndex(part => part.number === 2 && part.wire === 2);
    const rewritten = parts.map(part => {
      if (!hiddenLabels.size || part.number !== 2 || part.wire !== 2) return part;
      const inner = parseFields(part.value);
      const kept = inner.filter(value => !(value.number === 2 && value.wire === 2 && hiddenLabels.has(value.value.toString('utf8'))));
      return kept.length === inner.length ? part : { raw: m(2, concat(kept.map(value => value.raw))) };
    });
    if (labels.length) rewritten.splice(position < 0 ? rewritten.length : position, 0, ...groups.map(group => ({ raw: m(2, group) })));
    return m(2, concat(rewritten.map(part => part.raw)));
  });
  const own = models.map(model => m(1, model.raw));
  result.splice(Math.max(preserved.findIndex(field => field.number === 1 && field.wire === 2), 0), 0, ...own);
  if (hasSorts && !sorts && labels.length) result.push(m(2, concat([s(1, OWN_GROUP), ...groups.map(group => m(2, group))])));
  return concat(result);
}

function jsonKey(object, camel, snake) { return has(object, snake) && !has(object, camel) ? snake : camel; }
function nativeUid(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
  const camel = entry.modelUid, snake = entry.model_uid;
  if (has(entry, 'modelUid') && has(entry, 'model_uid') && camel !== snake) return '';
  const uid = camel ?? snake;
  return typeof uid === 'string' ? uid : '';
}
function augmentJsonList(data, catalog, hasSorts = true, onFusionStatus, onNativeModels) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid catalog JSON');
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const modelsKey = jsonKey(data, 'clientModelConfigs', 'client_model_configs');
  const sortsKey = jsonKey(data, 'clientModelSorts', 'client_model_sorts');
  const existing = data[modelsKey] || [], sorts = data[sortsKey] || [];
  if (!Array.isArray(existing) || !Array.isArray(sorts)) throw new Error('Invalid catalog list');
  reportFusionStatus(existing, true, onFusionStatus);
  reportNativeModels(existing, true, onNativeModels);
  const hiddenNative = new Set(catalog.hiddenNativeModelUids || []);
  const hiddenFusion = new Set(catalog.hiddenFusionUids || []);
  const labels = models.map(model => model.label), existingLabels = new Set(labels);
  const retainedLabels = new Set(labels);
  const hiddenLabels = new Set();
  const kept = [];
  for (const model of existing) {
    const uid = nativeUid(model);
    if (ownUid(uid)) { existingLabels.add(model?.label); continue; }
    if (hiddenNative.has(uid)) { if (typeof model.label === 'string') hiddenLabels.add(model.label); continue; }
    if (hiddenFusion.has(uid)) { if (typeof model.label === 'string') hiddenLabels.add(model.label); continue; }
    if (typeof model?.label === 'string') retainedLabels.add(model.label);
    kept.push(model);
  }
  for (const label of hiddenLabels) if (retainedLabels.has(label)) hiddenLabels.delete(label);
  const groups = [{ groupName: FUSION_GROUP, modelLabels: models.filter(model => model.kind === 'fusion').map(model => model.label) },
    { groupName: OWN_GROUP, modelLabels: models.filter(model => model.kind !== 'fusion').map(model => model.label) }].filter(group => group.modelLabels.length);
  const append = sort => ({ ...sort, groups: [...groups, ...(sort.groups || []).map(value => {
    const labelsKey = has(value, 'modelLabels') ? 'modelLabels' : has(value, 'model_labels') ? 'model_labels' : '';
    if (!labelsKey || !Array.isArray(value[labelsKey]) || !hiddenLabels.size) return value;
    const keptLabels = value[labelsKey].filter(label => !hiddenLabels.has(label));
    return keptLabels.length === value[labelsKey].length ? value : { ...value, [labelsKey]: keptLabels };
  }).filter(value =>
    ![OWN_GROUP, FUSION_GROUP].includes(value.groupName ?? value.group_name) || !(value.modelLabels ?? value.model_labels ?? []).every(label => existingLabels.has(label)))] });
  return { ...data,
    [modelsKey]: [...models.map(model => structuredClone(model.json)), ...kept],
    ...(hasSorts ? { [sortsKey]: sorts.length ? sorts.map(append) : (labels.length ? [{ name: OWN_GROUP, groups }] : sorts) } : {}),
  };
}

/** Accept decoded wire messages; framing/compression is exclusively the caller's responsibility. */
function augmentCatalog(data, { rpc, format = {}, catalog, onFusionStatus, onNativeModels } = {}) {
  if (rpc === '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings') return augmentLocalModelChoices(data, format, catalog);
  const shape = rpcShape(rpc);
  if (!shape || !catalog) return data;
  if (!catalog.models?.length && !catalog.hiddenNativeModelUids?.length && !catalog.hiddenFusionUids?.length &&
      typeof onFusionStatus !== 'function' && typeof onNativeModels !== 'function') return data;
  try {
    if (format.json === true) {
      if (!shape.status) return augmentJsonList(data, catalog, shape.sorts, onFusionStatus, onNativeModels);
      const statusKey = jsonKey(data, 'userStatus', 'user_status'), status = data?.[statusKey];
      if (!status || typeof status !== 'object' || Array.isArray(status)) return data;
      const configKey = jsonKey(status, 'cascadeModelConfigData', 'cascade_model_config_data');
      return { ...data, [statusKey]: { ...status, [configKey]: augmentJsonList(status[configKey] || {}, catalog, true, onFusionStatus, onNativeModels) } };
    }
    if (!Buffer.isBuffer(data)) return data;
    if (!shape.status) return augmentProtoList(data, catalog, shape.sorts, onFusionStatus, onNativeModels);
    return rewriteMessage(data, shape.field, status => rewriteMessage(status, 33, list => augmentProtoList(list, catalog, true, onFusionStatus, onNativeModels), true));
  } catch { return data; }
}

function collectNativeModels(data, { rpc, format = {} } = {}) {
  const shape = rpcShape(rpc);
  if (!shape) return [];
  try {
    if (format.json === true) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
      let payload = data;
      if (shape.status) {
        const status = data[jsonKey(data, 'userStatus', 'user_status')];
        if (!status || typeof status !== 'object' || Array.isArray(status)) return [];
        payload = status[jsonKey(status, 'cascadeModelConfigData', 'cascade_model_config_data')] || {};
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
      const list = payload[jsonKey(payload, 'clientModelConfigs', 'client_model_configs')];
      return Array.isArray(list) ? nativeEntries(list, true) : [];
    }
    if (!Buffer.isBuffer(data)) return [];
    if (!shape.status) return nativeEntries(parseFields(data).filter(field => field.number === 1 && field.wire === 2).map(field => field.value), false);
    const statuses = parseFields(data).filter(field => field.number === 1);
    if (statuses.length !== 1 || statuses[0].wire !== 2) return [];
    const lists = parseFields(statuses[0].value).filter(field => field.number === 33);
    if (lists.length !== 1 || lists[0].wire !== 2) return [];
    return nativeEntries(parseFields(lists[0].value).filter(field => field.number === 1 && field.wire === 2).map(field => field.value), false);
  } catch { return []; }
}

// The CLI intersects the model catalog with its configured choices. Register
// only locally routed ddevin models; native choices stay byte-identical.
function augmentLocalModelChoices(data, format, catalog) {
  if (!catalog?.models?.length) return data;
  try {
    const key = format.json ? jsonKey(data, 'allowedModelUids', 'allowed_model_uids') : null;
    const parsed = format.json ? null : parseFields(data);
    const entries = format.json ? data[key] : parsed.filter(f => f.number === 7).map(f => {
      if (f.wire !== 2) throw new Error('Invalid model choice');
      return f.value.toString('utf8');
    });
    if (entries === undefined || Array.isArray(entries) && entries.length === 0) return data;
    if (!Array.isArray(entries) || entries.some(uid => typeof uid !== 'string')) return data;
    const native = new Set(entries.filter(uid => !ownUid(uid)));
    const additions = catalog.models.filter(model => {
      if (!ownUid(model.uid)) return false;
      if (Object.hasOwn(catalog.routes, model.uid)) return true;
      const fusion = catalog.fusions[model.uid];
      if (!fusion) return false;
      if (fusion.leadNative) {
        if (!native.has(fusion.leadUid)) return false;
        return fusion.sidekickNative ? native.has(fusion.sidekickUid) : ownUid(fusion.sidekickUid) && Object.hasOwn(catalog.routes, fusion.sidekickUid);
      }
      return ownUid(fusion.leadUid) && Object.hasOwn(catalog.routes, fusion.leadUid) &&
        (fusion.sidekickNative ? native.has(fusion.sidekickUid) : ownUid(fusion.sidekickUid) && Object.hasOwn(catalog.routes, fusion.sidekickUid));
    }).map(model => model.uid);
    if (format.json) return { ...data, [key]: [...entries.filter(uid => !ownUid(uid)), ...additions] };
    return concat([...parsed.filter(f => !(f.number === 7 && ownUid(f.value.toString('utf8')))).map(f => f.raw), ...additions.map(uid => s(7, uid))]);
  } catch { return data; }
}

function assignmentUid(data, format, field, camel, snake) {
  if (format.json === true) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid assignment');
    if (has(data, camel) && has(data, snake) && data[camel] !== data[snake]) throw new Error('Ambiguous assignment');
    const value = data[camel] ?? data[snake] ?? '';
    if (typeof value !== 'string') throw new Error('Invalid assignment uid');
    return value;
  }
  const values = parseFields(data).filter(value => value.number === field);
  if (values.length > 1 || values.some(value => value.wire !== 2)) throw new Error('Ambiguous assignment');
  return values[0]?.value.toString('utf8') || '';
}

function resolveAssignment(data, format = {}, catalog, lockedFusionUids) {
  try {
    const router = assignmentUid(data, format, 2, 'modelRouterUid', 'model_router_uid');
    const leadRouter = assignmentUid(data, format, 6, 'fusionLeadRouterUid', 'fusion_lead_router_uid');
    const uid = leadRouter || router;
    let fusion = has(catalog?.fusions, uid) ? catalog.fusions[uid] : null;
    let redirected = false;
    // A locked official Fusion selection (free account) falls back to the
    // configured combination; enabled official entries keep their native path.
    if (!fusion && uid.startsWith('fusion-') && !ownUid(uid) && lockedFusionUids instanceof Set && lockedFusionUids.has(uid)) {
      fusion = defaultFusion(catalog);
      redirected = !!fusion;
    }
    if (!fusion) return null;
    const modelUid = leadRouter ? fusion.sidekickUid : fusion.leadUid;
    if (leadRouter) {
      if (fusion.sidekickNative) {
        if (!Array.isArray(fusion.sidekickHarnessUids) || !fusion.sidekickHarnessUids.length) return null;
      } else if (!has(catalog.routes, modelUid)) return null;
    } else {
      if (fusion.leadNative) {
        if (!Array.isArray(fusion.leadHarnessUids) || !fusion.leadHarnessUids.length) return null;
      } else if (!has(catalog.routes, modelUid)) return null;
    }
    let harnessUids;
    if (leadRouter) {
      harnessUids = fusion.sidekickNative ? fusion.sidekickHarnessUids : [...SIDEKICK_HARNESSES];
    } else {
      harnessUids = fusion.leadNative ? fusion.leadHarnessUids : ['fusion'];
    }
    const result = format.json === true ? { assignment: { modelUid, harnessUids } }
      : m(1, concat([s(2, modelUid), ...harnessUids.map(harness => s(3, harness))]));
    if (redirected) Object.defineProperty(result, 'redirectedFrom', { value: uid });
    return result;
  } catch { return null; }
}

module.exports = { rpcShape, augmentCatalog, collectNativeModels, resolveAssignment };
