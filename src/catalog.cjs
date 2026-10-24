'use strict';

// Model catalog: builds ddevin's own model entries (BYOK models + fusion
// presets) and augments Devin's native catalog responses with them.
// Implementation split into catalog/{shared,roles,build,augment}.cjs — this
// file is a facade re-exporting the original public surface.
const { buildCatalog, normalizeFusionConfig } = require('./catalog/build.cjs');
const { augmentCatalog, collectNativeModels, resolveAssignment } = require('./catalog/augment.cjs');
const { buildRoleLists } = require('./catalog/roles.cjs');
const { refKey, presetUid, ownUid, OWN_GROUP, FUSION_GROUP, LIST_MODES, DIAGNOSTIC_TEXT } = require('./catalog/shared.cjs');

module.exports = { buildCatalog, augmentCatalog, resolveAssignment, collectNativeModels, buildRoleLists, refKey, presetUid,
  normalizeFusionConfig, ownUid, OWN_GROUP, FUSION_GROUP, LIST_MODES, DIAGNOSTIC_TEXT };
