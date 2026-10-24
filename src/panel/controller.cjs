'use strict';

// Webview host: renders the control UI (full panel + sidebar view), dispatches
// validated messages to the manager, pushes full state, and tails backend
// logs for the log tab. Every attached webview target shares one manager.
const crypto = require('node:crypto');
const { renderPanel } = require('./view.cjs');
const { PanelInputError } = require('./model.cjs');
function createPanelController({ vscode, context, manager, safeError, readLogs = async () => ({ status: 'unsupported', entries: [] }), connectionStatus = () => null, log = () => {} }) {
  let panel;
  let logsPending = false;
  let disposed = false;
  const targets = new Set();
  const lastState = new Map();
  const refreshLogs = async () => {
    const visible = [...targets].filter(target => target.visible !== false);
    if (!visible.length || logsPending) return;
    logsPending = true;
    try {
      let result;
      try { result = await readLogs(); } catch { result = { status: 'unavailable', entries: [] }; }
      for (const target of visible) if (targets.has(target)) await target.webview.postMessage({ type: 'logs-state', result });
    } finally { logsPending = false; }
  };
  const postState = async (target, state) => {
    if (!targets.has(target)) return false;
    state.connection = connectionStatus();
    const encoded = JSON.stringify(state);
    if (encoded === lastState.get(target)) return true;
    lastState.set(target, encoded);
    return target.webview.postMessage({ type: 'state', state });
  };
  const publish = () => { for (const target of targets) void postState(target, manager.state()); };
  const wires = new Map();
  const wire = target => {
    // A sidebar WebviewView survives hide/show while its content is killed and
    // resolveWebviewView runs again: drop the stale wiring and always repost —
    // the rebuilt page has no state until we push one.
    wires.get(target)?.();
    targets.add(target);
    lastState.delete(target);
    const messages = target.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message.id !== 'string' || message.id.length > 100 || typeof message.type !== 'string') return;
      if (message.type === 'logs.refresh') { await refreshLogs(); return; }
      try {
        const state = await manager.dispatch(message.type, message.payload);
        await postState(target, state);
        await target.webview.postMessage({ type: 'result', id: message.id, ok: true });
      } catch (error) {
        const text = error instanceof PanelInputError ? error.message : safeError(error).message;
        await target.webview.postMessage({ type: 'result', id: message.id, ok: false, error: text });
        log('warn', 'panel-op-failed', { op: message.type, error: text });
        try { await postState(target, manager.state()); } catch {}
      }
    });
    const timer = setInterval(() => { void refreshLogs().catch(() => {}); }, 3000);
    timer.unref?.();
    // Refetch the moment a hidden target re-shows instead of waiting a tick.
    const onVisible = (target.onDidChangeViewState ?? target.onDidChangeVisibility)?.bind?.(target);
    const visibilityListener = typeof onVisible === 'function'
      ? onVisible(() => { if (target.visible !== false) void refreshLogs().catch(() => {}); })
      : undefined;
    void refreshLogs().catch(() => {});
    void postState(target, manager.state());
    const unwire = () => { clearInterval(timer); visibilityListener?.dispose?.(); messages.dispose(); targets.delete(target); lastState.delete(target); wires.delete(target); };
    wires.set(target, unwire);
    return unwire;
  };
  const render = target => {
    target.webview.html = renderPanel({ nonce: crypto.randomBytes(24).toString('base64'), cspSource: target.webview.cspSource });
  };
  function open() {
    if (disposed) return;
    if (panel) { panel.reveal(); void publish(); return; }
    panel = vscode.window.createWebviewPanel('ddevin.management', 'ddevin 控制面板', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    const current = panel;
    render(panel);
    let unwire = wire(panel);
    const closing = panel.onDidDispose(() => { unwire(); unwire = undefined; closing.dispose(); if (panel === current) panel = undefined; });
  }
  // Sidebar entry: same UI bound to the view id contributed in package.json.
  // Retained so switching sidebar views restores instantly with tab and scroll
  // intact; wire() still handles the dispose/re-resolve path defensively.
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('ddevin.panel', {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: true, localResourceRoots: [] };
      render(view);
      const unwire = wire(view);
      const closing = view.onDidDispose(() => { unwire(); closing.dispose(); });
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push({ dispose() { disposed = true; panel?.dispose(); } });
  return { open, publish };
}
module.exports = { createPanelController };
