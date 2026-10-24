'use strict';

// Model capability defaults. /models commonly reports IDs only; keep
// provider-specific overrides in the model config (model.efforts /
// effortMode). Recognizable base IDs get standard reasoning controls.
function modelEfforts(model) {
  if (model.effortMode === 'none') return [null];
  if (Array.isArray(model.efforts) && model.efforts.length) return [...new Set(model.efforts)];
  if (model.effortMode === 'manual') return [null];
  const id = String(model.id || '').split('/').at(-1);
  if (/^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/i.test(id) &&
      !/(?:^|-)(?:none|minimal|low|medium|high|xhigh|max|ultra)(?:-|$)/i.test(id)) {
    // The null variant retains provider-default behavior.
    return [null, 'none', 'low', 'medium', 'high', 'xhigh', 'max'];
  }
  // Claude Opus/Sonnet/Fable 4.6+ accept output_config.effort; Haiku does not.
  if (/^claude-(?:opus|sonnet|fable|mythos)-(?:[5-9]|4-[6-9])(?:[-.]|$)/i.test(id)) return [null, 'none', 'low', 'medium', 'high', 'xhigh', 'max'];
  return [null];
}

function modelSupportsImages(model) {
  return model.supportsImages !== false;
}

module.exports = { modelEfforts, modelSupportsImages };
