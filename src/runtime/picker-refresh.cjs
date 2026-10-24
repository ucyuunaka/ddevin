'use strict';

// Devin 3.10+ only lists a model when both the renderer catalog (GetUserStatus,
// fetched when a conversation view mounts) and the CLI session options
// (GetCliModelConfigs, re-fetched on session/new once its ~60s cache is stale)
// contain it. Starting a new conversation refreshes both without restarting
// the CLI or interrupting running sessions.
// The CLI also keeps that model list in a disk cache with stale-while-
// revalidate semantics: only a missing or expired entry makes it block and
// refetch, so a freshly added model stays invisible to a new session until the
// entry ages out. Whatever `prepare` does before a refresh must therefore run
// ahead of both the scheduling and the command, and the 65s debounce stays so
// our own refreshes do not pile up while a revalidate is in flight.
const COMMANDS = ['devin.newConversation', 'windsurf.triggerCascade'];
const DEBOUNCE_MS = 1500;
const CLI_CACHE_MS = 65 * 1000;

function signatureOf(models) {
  return (Array.isArray(models) ? models : []).map(model =>
    typeof model === 'string' ? model : `${model?.uid ?? ''}\u0000${model?.label ?? ''}\u0000${model?.json?.isDefaultModelInFamily ? '1' : '0'}`).sort().join('\u0001');
}

function createPickerRefresh({ executeCommand, readModels, prepare = () => {}, log = () => {}, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, debounceMs = DEBOUNCE_MS, cliCacheMs = CLI_CACHE_MS } = {}) {
  if (typeof executeCommand !== 'function' || typeof readModels !== 'function') throw new TypeError('executeCommand and readModels are required');
  let last, timer, lastRun = -Infinity, disposed = false;
  function read() {
    try { return signatureOf(readModels()); } catch { return undefined; }
  }
  async function run() {
    timer = undefined;
    if (disposed) return;
    lastRun = now();
    try { await prepare(); } catch {}
    for (const command of COMMANDS) {
      try { await executeCommand(command); log('debug', 'picker-refresh', { command }); return; }
      catch { /* Try the legacy command id before giving up. */ }
    }
    log('debug', 'picker-refresh-unavailable');
  }
  return {
    prime() { last = read(); },
    changed() {
      if (disposed) return false;
      const current = read();
      if (current === undefined || current === last) return false;
      last = current;
      try { const pending = prepare(); if (typeof pending?.catch === 'function') pending.catch(() => {}); } catch {}
      if (timer !== undefined) cancel(timer);
      // A second refresh inside the CLI cache window would not re-fetch its
      // model list, so defer it until the cache is stale again.
      const delay = Math.max(debounceMs, lastRun + cliCacheMs - now());
      timer = schedule(() => { run().catch(() => {}); }, delay);
      timer.unref?.();
      return true;
    },
    dispose() { disposed = true; if (timer !== undefined) cancel(timer); timer = undefined; },
  };
}

module.exports = { createPickerRefresh, signatureOf };
