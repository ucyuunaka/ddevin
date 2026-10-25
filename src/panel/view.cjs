'use strict';

const { DIAGNOSTIC_TEXT } = require('../catalog.cjs');

// Webview HTML: single-page control panel. Message protocol:
//   view -> host: { id, type, payload }        (dispatched to manager)
//   host -> view: { type:'result', id, ok, error? }
//                 { type:'state', state }
//                 { type:'logs-state', result }
function renderPanel({ nonce, cspSource } = {}) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; connect-src 'none'; img-src ${cspSource ? cspSource + ' ' : ''}data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
:root{--fg:var(--vscode-foreground,#e5e5e7);--bg:var(--vscode-sideBar-background,#1c1c1e);--muted:var(--vscode-descriptionForeground,#98989f);--accent:var(--vscode-button-background,#0a84ff);--accentfg:var(--vscode-button-foreground,#fff);--link:var(--vscode-textLink-foreground,#0a84ff);--err:var(--vscode-errorForeground,#ff453a);--ok:var(--vscode-testing-iconPassed,#30d158);--warn:var(--vscode-editorWarning-foreground,#ff9f0a);
--card:color-mix(in srgb,var(--fg) 6%,var(--bg));--field:color-mix(in srgb,var(--fg) 11%,var(--bg));--seg:color-mix(in srgb,var(--fg) 9%,var(--bg));--segon:color-mix(in srgb,var(--fg) 22%,var(--bg));--sep:color-mix(in srgb,var(--fg) 12%,transparent);--knob:color-mix(in srgb,var(--fg) 24%,var(--bg));
--mono:var(--vscode-editor-font-family,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);--h:28px;--r:12px;--rc:7px;--pad:14px}
*{box-sizing:border-box}
body{margin:0;padding:0 16px 48px;font:13px/1.45 var(--vscode-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif);color:var(--fg);background:var(--bg);overflow-wrap:break-word;-webkit-font-smoothing:antialiased}
h2,h3{font-size:11px;font-weight:600;line-height:16px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin:22px var(--pad) 7px}
.sh{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:var(--h);margin:18px var(--pad) 4px}.sh h2,.sh h3{margin:0}
.foot{margin:-8px var(--pad) 16px;font-size:11.5px;color:var(--muted)}
.bar{display:flex;gap:10px;align-items:center;padding:18px 0 2px}
.title{font-size:20px;font-weight:700;letter-spacing:-.3px}
.sub{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--muted);padding:0 0 12px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:0 0 auto}.dot.on{background:var(--ok)}
.tabs{display:flex;gap:2px;padding:2px;margin:4px 0 6px;background:var(--seg);border-radius:9px;position:sticky;top:6px;z-index:5;overflow-x:auto;scrollbar-width:none;box-shadow:0 -6px 0 6px var(--bg),0 6px 0 6px var(--bg)}
#page{padding-top:14px}#page>:first-child{margin-top:0}
.tabs::-webkit-scrollbar{display:none}
.tabs button{flex:1 0 auto;height:26px;padding:0 10px;background:none;color:var(--fg);opacity:.72;border-radius:7px;font-size:12px;font-weight:500;white-space:nowrap}
.tabs button.on{background:var(--segon);opacity:1;font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.22)}
.tabs button:hover{filter:none;opacity:1}
.card{background:var(--card);border-radius:var(--r);padding:12px var(--pad);margin:0 0 16px}
.card.list{padding-top:0;padding-bottom:0}
.item{display:flex;align-items:center;gap:10px;min-height:44px;padding:7px 0}.item+.item{border-top:1px solid var(--sep)}
.item>.k{flex:1;min-width:0}.item>.v{display:flex;align-items:center;gap:6px;color:var(--muted);flex:0 1 auto;min-width:0}
.ctitle{font-weight:600;margin:0 0 8px}.divider{height:1px;background:var(--sep);margin:12px 0}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:0}
input,select{height:var(--h);background:var(--field);color:var(--fg);border:1px solid transparent;border-radius:var(--rc);padding:0 9px;font:inherit;min-width:0;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus{border-color:var(--link);box-shadow:0 0 0 3px color-mix(in srgb,var(--link) 28%,transparent)}
input::placeholder{color:var(--muted);opacity:.75}
input:disabled,select:disabled{opacity:.45}
input[type=number]{text-align:right;font-variant-numeric:tabular-nums}
select{appearance:none;padding-right:24px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238e8e93' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center;cursor:pointer}
select option{background:var(--bg);color:var(--fg)}
input[type=checkbox]{appearance:none;position:relative;flex:0 0 auto;width:36px;height:22px;margin:0;padding:0;border:none;border-radius:11px;background:var(--knob);cursor:pointer;transition:background .2s}
input[type=checkbox]::before{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .2s}
input[type=checkbox]:checked{background:var(--ok)}input[type=checkbox]:checked::before{transform:translateX(14px)}
input[type=checkbox]:focus{box-shadow:0 0 0 3px color-mix(in srgb,var(--link) 28%,transparent)}
.grid input[type=checkbox]{width:18px;height:18px;border-radius:50%;background:none;border:1.5px solid var(--muted)}
.grid input[type=checkbox]::before{display:none}
.grid input[type=checkbox]:checked{background:var(--link);border-color:var(--link)}
.grid input[type=checkbox]:checked::before{display:block;top:2px;left:5px;width:4px;height:8px;border-radius:0;background:none;box-shadow:none;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
input.grow{flex:1;min-width:140px}
label{display:inline-flex;align-items:center;gap:6px}
.row input:not([type=checkbox]){min-width:90px;flex:1 1 auto}.row select{flex:0 1 auto;max-width:100%}
button{height:var(--h);background:var(--accent);color:var(--accentfg);border:none;border-radius:var(--rc);padding:0 13px;cursor:pointer;font:inherit;font-weight:500;white-space:nowrap;transition:filter .15s,opacity .15s}
button:hover{filter:brightness(1.12)}button:active{opacity:.7}
button.sec{background:color-mix(in srgb,var(--link) 15%,transparent);color:var(--link)}
button.sec[data-a$="del"]{background:color-mix(in srgb,var(--err) 14%,transparent);color:var(--err)}
button:disabled{opacity:.4;cursor:default;filter:none}
.muted{color:var(--muted)}.err{color:var(--err)}.ok{color:var(--ok)}.fs11{font-size:11px}
table{border-collapse:collapse;width:100%}
th{padding:0 8px 7px;text-align:left;font-size:11px;font-weight:500;color:var(--muted);border-bottom:1px solid var(--sep);white-space:nowrap}
td{padding:7px 8px;text-align:left;border-bottom:1px solid var(--sep);vertical-align:middle;white-space:nowrap;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
th:first-child,td:first-child{padding-left:0}th:last-child,td:last-child{padding-right:0}
td input{width:100%;min-width:0}
.tw{overflow-x:auto}
.grp{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.grp .lab{font-size:11px;color:var(--muted)}
.eff{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;min-width:0;max-width:100%}
.eff .grp:nth-child(2){order:3;flex:1 1 100%}.eff .grp:nth-child(2) input.efflist{flex:1 1 auto;width:auto}
.phead{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pinfo{flex:1 1 200px;min-width:0}
.ordctl{display:inline-flex;gap:2px;align-items:center;flex:0 0 auto;vertical-align:middle}
button.ord{width:var(--h);height:var(--h);padding:0;background:var(--seg);color:var(--muted);font-size:13px;line-height:1;flex:0 0 auto}
button.ord:hover{filter:none;background:var(--segon);color:var(--fg)}
button.ord.drag{cursor:grab;font-size:16px;touch-action:none;user-select:none}
button.ord.drag:active{cursor:grabbing}
button.ord-priority{font-size:11px;padding:0 9px}
.plist{display:block}
.mlhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 4px}
.mlhead .ctitle{margin:0}
.modelid{display:flex;align-items:center;gap:6px;min-width:0}
.ordererr{border-left:3px solid var(--err)}
.card.dragging{opacity:.72;outline:2px solid var(--link);outline-offset:-2px;background:color-mix(in srgb,var(--link) 8%,var(--card))}
.plist.provider-order-dragging .card>.pbody,.plist.provider-order-dragging .card>[data-prov]{display:none}
.card.dragging>.pbody,.card.dragging [data-prov]{display:none}
.plist.provider-order-dragging .card>.phead,.card.dragging>.phead{margin:0}
.card.dragging.drop-invalid,tr.mrow.dragging.drop-invalid{outline-color:var(--err)}
tr.mrow.dragging{opacity:.72;outline:2px solid var(--link);outline-offset:-2px;background:color-mix(in srgb,var(--link) 8%,var(--bg))}
[data-order-list].drag-target{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--link) 55%,transparent);border-radius:var(--r)}
body.is-dragging,body.is-dragging *{cursor:grabbing!important;user-select:none!important}
body.is-dragging .card.dragging .phead{cursor:grabbing}
.pname{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:14px}
.pbtns{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-left:auto}
.purl{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;margin-top:1px}
.pbody{margin-top:10px;padding-top:10px;border-top:1px solid var(--sep)}
.effcol{width:250px}
th.lblcol{min-width:150px}
.m0{margin:0}.mt8{margin-top:10px}.nw{white-space:nowrap}
#np-name,#ep-name{width:110px;flex:0 0 auto}
#fp-name{width:160px;flex:0 0 auto}
#fp-lead,#fp-side{flex:1 1 160px}
#w-ttl,#w-ottl,#w-gap{width:64px;flex:0 0 auto}
td input.efflist{width:128px;flex:0 0 auto}
td select.selsrc,td select.selinit{width:80px;flex:0 0 auto}
td input.ctx{width:88px}
td input.out{width:80px}
.mono{font-family:var(--mono);font-size:12px;word-break:break-all}
.badge{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:9px;font-size:10.5px;font-weight:500;line-height:1;background:var(--seg);color:var(--muted);white-space:nowrap;vertical-align:middle}
.badge.on{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}
.badge.warn{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
button.caret{width:22px;height:22px;padding:0;background:none;color:var(--muted);font-size:18px;line-height:1;border-radius:6px;transition:transform .2s,background .15s}
button.caret[aria-expanded="true"]{transform:rotate(90deg)}
button.caret:hover{filter:none;color:var(--fg);background:var(--seg)}
.ops{display:flex;gap:10px;align-items:center;flex-wrap:wrap;white-space:nowrap}
.ops label{cursor:pointer}
.logbox{font:11px/1.55 var(--mono);max-height:420px;overflow:auto;background:var(--card);border-radius:var(--r);padding:10px var(--pad);white-space:pre-wrap;word-break:break-all}
.logline+.logline{margin-top:2px}.logline.warn{color:var(--warn)}.logline.error{color:var(--err)}.logline.debug,.logline.trace{color:var(--muted)}
.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:85%;padding:9px 18px;border-radius:999px;background:var(--segon);box-shadow:0 8px 28px rgba(0,0,0,.35);font-size:12px;font-weight:500;z-index:9}
.toast.err{color:var(--err)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px 12px}
.grid label{display:flex;gap:8px;align-items:flex-start;min-width:0;cursor:pointer}.grid label input{margin-top:1px}
@media (max-width:800px){
body{padding:0 10px 32px}
:root{--pad:12px}
table.rt{display:block;overflow:visible;border:none}
table.rt tbody{display:block}
table.rt tr.rh{display:none}
table.rt tr{display:block;padding:6px 0}
table.rt tr:not(.rh)+tr{border-top:1px solid var(--sep)}
table.rt td{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;border:none;padding:4px 0;white-space:normal}
table.rt td[data-th]::before{content:attr(data-th);flex:0 0 72px;font-size:11px;color:var(--muted)}
table.rt td>*{min-width:0}
table.rt td input:not([type=checkbox]){flex:1 1 0;width:auto}
table.rt td .eff{flex:1 1 0}
#fp-name,#fp-lead,#fp-side{flex:1 1 100%}
.pbtns{margin-left:0}
}
</style>
</head>
<body>
<div class="bar"><span class="title">ddevin</span><span class="grow"></span>
<label class="muted"><input type="checkbox" id="enabled"> 启用</label></div>
<div id="conn" class="sub"></div>
<div class="tabs" id="tabs"></div>
<div id="page"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let state = null, logs = {status:'unsupported',entries:[]}, tab = 'models', toastTimer;
let collapsed = new Set(), showNative = true;
try { const ui = vscode.getState() || {}; collapsed = new Set(Array.isArray(ui.collapsed) ? ui.collapsed : []); showNative = ui.showNative !== false; } catch {}
const saveUi = () => { try { vscode.setState({ collapsed: [...collapsed], showNative }); } catch {} };
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const TABS = [['models','模型'],['fusion','Fusion 预设'],['native','官方模型'],['settings','设置'],['logs','日志']];
function toast(text, err) {
  let el = document.querySelector('.toast'); if (!el) { el = document.createElement('div'); document.body.appendChild(el); }
  el.className = 'toast' + (err ? ' err' : ''); el.textContent = text;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.remove(), 4000);
}
const pending = new Map(); let seq = 0;
function req(type, payload) {
  return new Promise((resolve, reject) => {
    const id = 'm' + (++seq);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作超时')); }, 90000);
    pending.set(id, { resolve, reject, timer });
    vscode.postMessage({ id, type, payload });
  });
}
async function call(type, payload, ok, done) {
  try { await req(type, payload); done?.(); if (ok) toast(ok); }
  catch (e) { toast(e.message || '操作失败', true); }
}
/* ---------- 未提交现场 ---------- */
const drafts = new Map();
const editingProviders = new Set();
let composing = false, deferredState = null;
const orderPending = new Set(), orderPreviews = new Map();
let orderFocusIntent = null;
let dragState = null, dragRaf = 0;
document.addEventListener('compositionstart', () => { composing = true; }, true);
document.addEventListener('compositionend', () => {
  composing = false;
  setTimeout(flushDeferredState, 0);
}, true);
function fieldKey(el) {
  if (!el) return '';
  const d = el.dataset || {};
  if (d.draft) return d.draft;
  if (d.role) return 'role:' + d.role + ':' + d.ref;
  if (d.imp) return 'imp:' + (state?.importCandidates?.providerId || '') + ':' + d.imp;
  if (d.h) return 'hidden:' + d.h;
  if (d.a === 'pe') return 'provider:' + d.id + ':enabled';
  if (el.id) return 'id:' + el.id;
  if (d.add) return 'add:' + d.add;
  if (d.m) return ['model', d.p, d.mid, d.m].join(':');
  return '';
}
function isDraftField(el) {
  // #u-native only controls which role candidates are visible in this webview;
  // it is not server state, so it must not be replayed as a draft.
  return el.id !== 'u-native';
}
function rememberDraft(event) {
  const el = event.target;
  if (!el?.matches || !el.closest('#page') || !isDraftField(el)) return;
  const key = fieldKey(el);
  if (!key) return;
  drafts.set(key, { checkbox: el.type === 'checkbox' || el.type === 'radio', value: el.value, checked: el.checked });
}
document.addEventListener('input', rememberDraft, true);
document.addEventListener('change', rememberDraft, true);
const clearDrafts = (...keys) => keys.flat().forEach(key => drafts.delete(key));
function clearDraftIfUnchanged(key, el) {
  const draft = drafts.get(key);
  if (!draft || !el) return;
  if (draft.checkbox ? draft.checked === el.checked : draft.value === el.value) drafts.delete(key);
}
const clearSubmitted = values => {
  for (const [key, value] of Object.entries(values)) {
    const draft = drafts.get(key);
    if (!draft || draft.value === value) drafts.delete(key);
  }
};
function clearDraftPrefix(prefix) {
  for (const key of drafts.keys()) if (key.startsWith(prefix)) drafts.delete(key);
}
const providerDraftPrefix = id => 'edit:' + id + ':';
const clearEditDrafts = id => clearDraftPrefix(providerDraftPrefix(id));
const clearProviderDrafts = id => {
  clearEditDrafts(id);
  clearDraftPrefix('model:' + id + ':');
  clearDrafts('add:' + id, 'provider:' + id + ':enabled');
};
const DRAFT_MODEL_FIELDS = ['label', 'effortMode', 'efforts', 'defaultEffort', 'contextWindow', 'maxOutputTokens', 'enabled'];
const DRAFT_EDIT_FIELDS = ['name', 'url', 'fmt', 'key'];
function pruneDrafts() {
  if (!state) return;
  const valid = new Set(), import_ = state.importCandidates, imported = new Set((import_?.models || []).map(item => item.id));
  for (const provider of state.providers || []) {
    valid.add('add:' + provider.id);
    valid.add('provider:' + provider.id + ':enabled');
    for (const field of DRAFT_EDIT_FIELDS) valid.add('edit:' + provider.id + ':' + field);
    for (const model of provider.models || []) {
      for (const field of DRAFT_MODEL_FIELDS) valid.add('model:' + provider.id + ':' + model.id + ':' + field);
    }
  }
  for (const [role, items] of Object.entries(state.roleLists || {})) {
    for (const item of items || []) valid.add('role:' + role + ':' + JSON.stringify(item.ref));
  }
  for (const model of state.nativeModels || []) valid.add('hidden:' + model.uid);
  for (const key of [...drafts.keys()]) {
    if (key.startsWith('imp:')) {
      const prefix = import_ ? 'imp:' + import_.providerId + ':' : '';
      if (!import_ || !key.startsWith(prefix) || !imported.has(key.slice(prefix.length))) drafts.delete(key);
    } else if (/^(?:add|edit|model|provider|role|hidden):/.test(key) && !valid.has(key)) drafts.delete(key);
  }
}
function applyDrafts() {
  for (const el of document.querySelectorAll('#page input, #page select')) {
    const key = fieldKey(el), draft = drafts.get(key);
    if (!draft) continue;
    if (draft.checkbox) el.checked = draft.checked;
    else if (el.tagName === 'SELECT') {
      const previous = el.value;
      el.value = draft.value;
      if (el.value !== draft.value) { el.value = previous; drafts.delete(key); }
    } else el.value = draft.value;
  }
}
function focusKey(el) {
  if (!el?.dataset) return '';
  return el.dataset.focusKey || fieldKey(el);
}
function focusElement(key) {
  if (!key) return null;
  return [...document.querySelectorAll('#page input, #page select, #page button')].find(item => focusKey(item) === key) || null;
}
function orderItemElement(itemKey) {
  if (!itemKey) return null;
  return [...document.querySelectorAll('#page [data-order-item]')].find(item => item.dataset.orderItem === itemKey) || null;
}
function captureFocus() {
  const el = document.activeElement;
  if (!el?.closest || !el.closest('#page')) return null;
  const key = focusKey(el);
  if (!key) return null;
  const focus = { key, item: el.closest('[data-order-item]')?.dataset.orderItem || '' };
  try {
    if (typeof el.selectionStart === 'number') {
      focus.start = el.selectionStart;
      focus.end = el.selectionEnd;
      focus.direction = el.selectionDirection;
    }
  } catch {}
  return focus;
}
function focusWithFallback(focus) {
  if (!focus) return false;
  let el = focusElement(focus.key);
  if ((!el || el.disabled) && focus.item) {
    const item = orderItemElement(focus.item);
    el = item?.querySelector('[data-order-drag]') || null;
  }
  if (!el || el.disabled) return false;
  try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch { return false; } }
  if (typeof focus.start === 'number') {
    try { el.setSelectionRange(focus.start, focus.end, focus.direction); } catch {}
  }
  return true;
}
function restoreFocus(focus) { focusWithFallback(focus); }
function consumeOrderFocus() {
  const intent = orderFocusIntent;
  if (!intent || orderPending.has(intent.listKey)) return;
  orderFocusIntent = null;
  const focused = focusWithFallback(intent);
  const item = orderItemElement(intent.item);
  if (item && !item.contains(document.activeElement)) {
    const rect = item.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > (window.innerHeight || document.documentElement.clientHeight)) {
      try { item.scrollIntoView({ block: 'nearest' }); } catch {}
    }
  }
  return focused;
}
window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'result') { const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.ok ? p.resolve() : p.reject(new Error(m.error || '操作失败')); } }
  else if (m.type === 'state') receiveState(m.state);
  else if (m.type === 'logs-state') { logs = m.result || logs; if (tab === 'logs') renderLogs(); }
});
$('#enabled').addEventListener('change', e => call('setEnabled', { enabled: e.target.checked }));

function refLabel(ref) {
  if (!ref) return '';
  if (ref.nativeUid) { const n = (state.nativeModels || []).find(x => x.uid === ref.nativeUid); return (n ? n.label : ref.nativeUid) + '（官方）'; }
  const p = (state.providers || []).find(x => x.id === ref.providerId);
  return (p ? p.name : ref.providerId) + ' · ' + ref.model + (ref.effort ? ' · ' + ref.effort : '');
}
const refKey = ref => ref && (ref.nativeUid ? 'n:' + ref.nativeUid : 'p:' + ref.providerId + '/' + ref.model + '/' + (ref.effort ?? ''));

/* ---------- 面板展示顺序 ---------- */
const orderListKey = (scope, providerId) => scope === 'providers' ? 'providers' : 'models:' + providerId;
function panelOrderMeta() {
  if (state?.panelOrder) return state.panelOrder;
  const models = Object.create(null), tokens = Object.create(null), sortable = Object.create(null);
  for (const provider of state?.providers || []) {
    const id = provider.id;
    models[id] = (provider.models || []).map(model => model.id);
    tokens[id] = null; sortable[id] = false;
  }
  return { providers: (state?.providers || []).map(provider => provider.id), models, tokens: { providers: null, models: tokens },
    sortable: { providers: false, models: sortable }, error: null };
}
function orderIdsFor(scope, providerId) {
  const meta = panelOrderMeta();
  const ids = scope === 'providers' ? meta.providers : meta.models?.[providerId];
  return Array.isArray(ids) ? ids : [];
}
function orderTokenFor(scope, providerId) {
  const tokens = panelOrderMeta().tokens || {};
  const token = scope === 'providers' ? tokens.providers : tokens.models?.[providerId];
  return typeof token === 'string' && token ? token : null;
}
function orderSortableFor(scope, providerId) {
  const meta = panelOrderMeta(), value = scope === 'providers' ? meta.sortable?.providers : meta.sortable?.models?.[providerId];
  return value === true && !!orderTokenFor(scope, providerId) && !meta.error;
}
function orderPendingFor(scope, providerId) { return orderPending.has(orderListKey(scope, providerId)); }
function orderedItems(entries, ids) {
  const rank = new Map();
  (Array.isArray(ids) ? ids : []).forEach((id, index) => { if (!rank.has(id)) rank.set(id, index); });
  return entries.map((entry, index) => ({ entry, index, rank: rank.has(entry.id) ? rank.get(entry.id) : ids.length + index }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index).map(item => item.entry);
}
function displayedProviders() {
  if (!state) return [];
  const ids = orderPreviews.get('providers') || orderIdsFor('providers');
  return orderedItems(state.providers || [], ids);
}
function displayedModels(provider) {
  const ids = orderPreviews.get('models:' + provider.id) || orderIdsFor('models', provider.id);
  return orderedItems(provider.models || [], ids);
}
function isPrioritized(entries) {
  let disabled = false;
  for (const entry of entries) {
    if (entry.enabled === false) disabled = true;
    else if (disabled) return false;
  }
  return true;
}
function priorityDisabled(scope, providerId, entries) {
  return !orderSortableFor(scope, providerId) || orderPendingFor(scope, providerId) || entries.length < 2 || isPrioritized(entries);
}
const orderItemKey = (scope, providerId, id) => scope === 'providers' ? 'providers:' + id : 'models:' + providerId + ':' + id;
const orderFocusKey = (scope, providerId, id, action) => 'order:' + orderItemKey(scope, providerId, id) + ':' + action;
function orderPayload(scope, providerId, token) {
  const payload = { scope };
  if (scope === 'models') payload.providerId = providerId;
  payload.expectedToken = token;
  return payload;
}
function stateTokenFor(incoming, scope, providerId) {
  const tokens = incoming?.panelOrder?.tokens || {};
  const token = scope === 'providers' ? tokens.providers : tokens.models?.[providerId];
  return typeof token === 'string' && token ? token : null;
}
function flushDeferredState() {
  if (composing || dragState || !deferredState) return;
  state = deferredState;
  deferredState = null;
  render();
}
function receiveState(next) {
  if (dragState) {
    const token = stateTokenFor(next, dragState.scope, dragState.providerId);
    if (!dragState.started || token === dragState.token) { deferredState = next; return; }
    cancelDrag({ restore: true, notify: true, render: false, preserveFocus: true });
    state = next;
    deferredState = null;
    render();
    return;
  }
  state = next;
  if (composing) deferredState = next;
  else render();
}
async function performOrderRequest(type, scope, providerId, previewIds, token) {
  const key = orderListKey(scope, providerId), expectedToken = token || orderTokenFor(scope, providerId);
  if (!expectedToken || !orderSortableFor(scope, providerId) || orderPending.has(key)) return false;
  orderPreviews.set(key, [...previewIds]);
  orderPending.add(key);
  render();
  try {
    const payload = orderPayload(scope, providerId, expectedToken);
    if (type === 'reorderPanelList') payload.ids = [...previewIds];
    await req(type, payload);
    return true;
  } catch (error) {
    toast(error?.message || '排序保存失败', true);
    return false;
  } finally {
    orderPending.delete(key);
    orderPreviews.delete(key);
    render();
  }
}

function render() {
  if (dragState) cancelDrag({ restore: false, notify: false, render: false });
  pruneDrafts();
  const focus = captureFocus();
  if (!state) { $('#page').innerHTML = '<p class="muted">加载中…</p>'; applyDrafts(); restoreFocus(focus); consumeOrderFocus(); return; }
  $('#enabled').checked = state.enabled;
  const c = state.connection || {};
  $('#conn').innerHTML = '<span class="dot' + (c.state === 'ready' ? ' on' : '') + '"></span><span>LS ' + esc(c.state || '未连接') + '</span><span>·</span><span>' +
    state.modelCount + ' 个 BYOK 条目 · ' + state.fusionCount + ' 个 Fusion · 官方目录 ' + esc(state.nativeCatalogStatus || '-') + '</span>';
  $('#tabs').innerHTML = TABS.map(([k, n]) => '<button class="' + (k === tab ? 'on' : '') + '" data-t="' + k + '">' + n + '</button>').join('');
  $('#tabs').querySelectorAll('button').forEach(b => b.onclick = () => { tab = b.dataset.t; render(); });
  ({ models: renderModels, fusion: renderFusion, native: renderNative, settings: renderSettings, logs: renderLogs })[tab]();
  applyDrafts();
  restoreFocus(focus);
  consumeOrderFocus();
}

/* ---------- 模型 ---------- */
const DIAG_TEXT = ${JSON.stringify(DIAGNOSTIC_TEXT)};
function diagBlock() {
  const list = (state && state.diagnostics) || [];
  if (!list.length) return '';
  return '<div class="card"><div class="ctitle err">配置中有 ' + list.length + ' 个条目被跳过：</div>' +
    list.map(d => '<div class="muted">· ' + esc(DIAG_TEXT[d.code] || d.code) +
      (d.providerId ? '（' + esc([d.providerId, d.modelId, d.effort].filter(Boolean).join(' · ')) + '）' : '') + '</div>').join('') + '</div>';
}
function orderControls(scope, providerId, id, label, index, count, sortable, pending) {
  const can = sortable && !pending;
  const providerAttr = scope === 'models' ? ' data-order-provider="' + esc(providerId) + '"' : '';
  const item = orderItemKey(scope, providerId, id);
  const title = scope === 'providers' ? '供应商 ' + label : '模型 ' + label;
  const key = action => ' data-focus-key="' + esc(orderFocusKey(scope, providerId, id, action)) + '"';
  return '<span class="ordctl">' +
    '<button type="button" class="ord drag" data-a="drag" data-order-scope="' + scope + '"' + providerAttr +
      ' data-order-id="' + esc(id) + '" data-order-drag="1"' + key('drag') +
      ' title="拖动排序：' + esc(title) + '；也可使用上移/下移按钮" aria-label="拖动' + esc(title) + '排序"' +
      (can && count > 1 ? '' : ' disabled') + '>⠿</button>' +
    '<button type="button" class="ord" data-a="move" data-order-scope="' + scope + '"' + providerAttr +
      ' data-order-id="' + esc(id) + '" data-order-move="-1"' + key('up') +
      ' title="上移' + esc(title) + '" aria-label="上移' + esc(title) + '"' +
      (can && index > 0 ? '' : ' disabled') + '>↑</button>' +
    '<button type="button" class="ord" data-a="move" data-order-scope="' + scope + '"' + providerAttr +
      ' data-order-id="' + esc(id) + '" data-order-move="1"' + key('down') +
      ' title="下移' + esc(title) + '" aria-label="下移' + esc(title) + '"' +
      (can && index < count - 1 ? '' : ' disabled') + '>↓</button></span>';
}
function priorityControl(scope, providerId, label, disabled) {
  const providerAttr = scope === 'models' ? ' data-order-provider="' + esc(providerId) + '"' : '';
  const key = scope === 'providers' ? 'order:providers:priority' : 'order:models:' + providerId + ':priority';
  const what = scope === 'providers' ? '供应商' : '本供应商的模型';
  return '<button type="button" class="sec ord-priority" data-a="prioritize" data-order-scope="' + scope + '"' + providerAttr +
    ' data-focus-key="' + esc(key) + '" title="将启用的' + esc(what) + '稳定排在停用项之前" aria-label="' + esc(what) + '启用项优先"' +
    (disabled ? ' disabled' : '') + '>启用项优先</button>';
}
function renderModels() {
  const import_ = state.importCandidates;
  const providers = displayedProviders();
  const providerSortable = orderSortableFor('providers'), providerPending = orderPendingFor('providers');
  const orderError = state.panelOrder?.error;
  const providerCards = providers.map((p, providerIndex) => {
    const models = displayedModels(p);
    const modelSortable = orderSortableFor('models', p.id), modelPending = orderPendingFor('models', p.id);
    const name = p.name || p.id || '供应商';
    const table = models.length ? '<div class="tw"><table class="rt"><tr class="rh"><th>模型</th><th class="lblcol">显示名</th><th class="effcol">档位</th><th>上下文</th><th>输出</th><th>操作</th></tr>' +
      '<tbody data-mlist="' + esc(p.id) + '" data-order-list="models:' + esc(p.id) + '">' + models.map((m, index) => {
        const item = orderItemKey('models', p.id, m.id);
        return '<tr class="mrow" data-mrow="' + esc(m.id) + '" data-order-id="' + esc(m.id) + '" data-order-item="' + esc(item) + '">' +
          '<td class="mono" data-th="模型">' + esc(m.id) + '</td>' +
          '<td data-th="显示名"><input value="' + esc(m.label) + '" data-m="label" data-p="' + esc(p.id) + '" data-mid="' + esc(m.id) + '"></td>' +
          '<td data-th="档位"><div class="eff"><span class="grp"><span class="lab">来源</span><select class="selsrc" data-m="effortMode" data-p="' + esc(p.id) + '" data-mid="' + esc(m.id) + '" title="档位来源：自动=识别模型 ID；手动=用右侧列表；不指定=永不发推理参数">' +
            [['auto','自动'],['manual','手动'],['none','不指定']].map(([v, n]) => '<option value="' + v + '"' + (m.effortMode === v ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></span>' +
          '<span class="grp"><span class="lab">可选</span><input value="' + esc((m.efforts || []).map(v => v ?? 'default').join(',')) + '" placeholder="default,low,high" title="Devin 里 Effort 下拉的可选项（default=供应商默认不发参数，' + esc((state.effortValues || []).join('/')) + '）；非空时优先于来源' +
            '" data-m="efforts" data-p="' + esc(p.id) + '" data-mid="' + esc(m.id) + '" class="efflist"' + (m.effortMode === 'none' ? ' disabled' : '') + '></span>' +
          '<span class="grp"><span class="lab">初始</span><select class="selinit" data-m="defaultEffort" data-p="' + esc(p.id) + '" data-mid="' + esc(m.id) + '" title="初始档位：模型组在 Devin 里默认选中的档位">' +
            '<option value="">自动</option>' + (m.effortOptions || []).map(v => '<option value="' + v + '"' + (m.defaultEffort === v ? ' selected' : '') + '>' + v + '</option>').join('') + '</select></span></div></td>' +
          '<td data-th="上下文"><input value="' + m.contextWindow + '" type="number" data-m="contextWindow" data-p="' + esc(p.id) + '" data-mid="' + esc(m.id) + '" class="ctx">' +
            (m.limitsDetected === false ? ' <span class="badge warn" title="未从 /models 获取到上下文长度，使用默认值；请按模型实际值修改">默认</span>' : '') + '</td>' +
          '<td data-th="输出"><input value="' + m.maxOutputTokens + '" type="number" data-m="maxOutputTokens" data-p="' + esc(p.id) + '" data-mid="' + esc(m.id) + '" class="out"></td>' +
          '<td data-th="操作"><div class="ops"><label><input type="checkbox" ' + (m.enabled ? 'checked' : '') + ' data-m="enabled" data-p="' + esc(p.id) + '" data-mid="' + esc(m.id) + '"> 启用</label>' +
          '<button class="sec" data-a="mdel" data-p="' + esc(p.id) + '" data-mid="' + esc(m.id) + '" title="删除该模型">删除</button>' +
          orderControls('models', p.id, m.id, m.label || m.id, index, models.length, modelSortable, modelPending) + '</div></td></tr>';
      }).join('') + '</tbody></table></div>' : '<p class="muted m0">暂无模型。</p>';
    return '<div class="card" data-pcard="' + esc(p.id) + '" data-order-id="' + esc(p.id) + '" data-order-item="' + esc(orderItemKey('providers', null, p.id)) + '">' +
      '<div class="phead">' + orderControls('providers', null, p.id, name, providerIndex, providers.length, providerSortable, providerPending) +
      '<button class="caret" data-a="collapse" data-id="' + esc(p.id) + '" aria-expanded="' + !collapsed.has(p.id) + '" title="' + (collapsed.has(p.id) ? '展开模型列表' : '折叠模型列表') + '">›</button>' +
      '<div class="pinfo"><div class="pname"><strong>' + esc(p.name) + '</strong>' +
      '<span class="badge">' + esc(p.apiFormat) + '</span><span class="badge' + (p.keyConfigured ? '' : ' warn') + '">' + (p.keyConfigured ? '已配密钥' : '无密钥') + '</span>' +
      (p.insecure ? '<span class="badge warn" title="http:// 远程地址会以明文发送 API Key">http 明文</span>' : '') +
      '<span class="badge">' + p.models.length + ' 模型</span></div>' +
      '<span class="muted mono purl" title="' + esc(p.baseUrl) + '">' + esc(p.baseUrl) + '</span></div>' +
      '<span class="pbtns"><button class="sec" data-a="edit" data-id="' + esc(p.id) + '">编辑</button>' +
      '<button class="sec" data-a="fetch" data-id="' + esc(p.id) + '">获取模型</button>' +
      '<button class="sec" data-a="del" data-id="' + esc(p.id) + '">删除</button>' +
      '<input type="checkbox" data-a="pe" data-id="' + esc(p.id) + '"' + (p.enabled ? ' checked' : '') + ' title="' + (p.enabled ? '已启用，点击停用' : '已停用，点击启用') + '"></span></div>' +
      '<div data-prov="' + esc(p.id) + '"></div>' +
      (collapsed.has(p.id) ? '' : '<div class="pbody">' +
        '<div class="mlhead"><span class="ctitle">模型</span><span class="muted fs11">拖动手柄或使用上下移调整' + esc(name) + '内的顺序</span><span class="grow"></span>' +
        priorityControl('models', p.id, name, priorityDisabled('models', p.id, models)) + '</div>' + table +
        '<div class="row mt8"><input placeholder="手动添加模型 ID" data-add="' + esc(p.id) + '" class="grow"><button class="sec" data-a="add" data-id="' + esc(p.id) + '">添加模型</button></div></div>') +
      '</div>';
  }).join('');
  $('#page').innerHTML =
    diagBlock() +
    (orderError ? '<div class="card ordererr"><div class="ctitle err">展示顺序未加载</div><div class="muted fs11">' + esc(orderError) + '</div></div>' : '') +
    '<div class="sh"><h2>供应商</h2><span class="muted fs11">拖动手柄排序，或使用上下移</span><span class="grow"></span>' +
      (providers.length ? priorityControl('providers', null, '供应商', priorityDisabled('providers', null, providers)) : '') + '</div>' +
    (providers.length ? '' : '<div class="card muted">还没有供应商。在下方添加，填写 OpenAI/Anthropic 兼容的 API 地址与密钥。</div>') +
    '<div class="plist" data-plist="1" data-order-list="providers">' + providerCards + '</div>' +
    (import_ ? '<h3>导入模型 — ' + esc(import_.providerId) + '</h3><div class="card"><div class="grid">' +
      import_.models.map(m => '<label><input type="checkbox" data-imp="' + esc(m.id) + '" ' + (m.imported ? 'disabled checked' : '') + '> ' + esc(m.label || m.id) + '</label>').join('') +
      '</div><div class="row mt8"><span class="grow"></span><button class="sec" data-a="import-cancel">取消</button><button data-a="import">导入所选</button></div></div>' : '') +
    '<h3>添加供应商</h3><div class="card"><div class="row"><input id="np-name" placeholder="名称">' +
      '<input id="np-url" placeholder="https://api.example.com/v1" class="grow">' +
      '<select id="np-fmt"><option value="openai">OpenAI Chat</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic</option></select>' +
      '<input id="np-key" placeholder="API Key" class="grow" type="password"><button data-a="save-p">保存</button></div></div>' +
    '<div class="sh"><h2>当前选中（可用于 Fusion 的模型）</h2><span class="grow"></span>' +
      '<label class="muted nw fs11" title="在下方候选列表中显示/隐藏官方模型；隐藏不会取消已选中的官方模型">显示官方模型 <input type="checkbox" id="u-native"' + (showNative ? ' checked' : '') + '></label></div>' +
    '<div class="card">' + ['lead', 'sidekick'].map(role => {
      const items = (state.roleLists?.[role] || []).filter(i => i.available);
      const visible = showNative ? items : items.filter(i => !i.native);
      const hiddenSelected = showNative ? 0 : items.filter(i => i.native && i.selected).length;
      return '<div class="ctitle">' + (role === 'lead' ? 'Lead 候选' : 'Sidekick 候选') + '</div>' +
        (visible.length ? '<div class="grid">' + visible.map(i =>
          '<label title="' + esc(refKey(i.ref)) + '"><input type="checkbox" data-role="' + role + '" data-ref="' + esc(JSON.stringify(i.ref)) + '" ' + (i.selected ? 'checked' : '') + '> ' + esc(i.label) + (i.native ? '（官方）' : '') + '</label>').join('') + '</div>'
          : '<p class="muted m0">（暂无可用' + (showNative ? '模型' : ' BYOK 模型') + '）</p>') +
        (hiddenSelected ? '<p class="muted fs11 mt8 m0">（已隐藏 ' + hiddenSelected + ' 个已选中的官方模型）</p>' : '');
    }).join('<div class="divider"></div>') + '</div>';
  const providerSet = new Set(state.providers.map(p => p.id));
  bindModels(import_);
  for (const id of editingProviders) {
    if (!providerSet.has(id)) { editingProviders.delete(id); clearEditDrafts(id); }
    else editProvider(id);
  }
}
async function moveOrder(scope, providerId, id, delta) {
  if (!orderSortableFor(scope, providerId) || orderPendingFor(scope, providerId)) return;
  const entries = scope === 'providers' ? displayedProviders() : (() => {
    const provider = state.providers.find(item => item.id === providerId);
    return provider ? displayedModels(provider) : [];
  })();
  const ids = entries.map(entry => entry.id), index = ids.indexOf(id), target = index + delta;
  if (index < 0 || target < 0 || target >= ids.length) return;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  const action = delta < 0 ? 'up' : 'down';
  orderFocusIntent = { key: orderFocusKey(scope, providerId, id, action), item: orderItemKey(scope, providerId, id), listKey: orderListKey(scope, providerId) };
  await performOrderRequest('reorderPanelList', scope, providerId, next);
}
async function prioritizeOrder(scope, providerId) {
  if (!orderSortableFor(scope, providerId) || orderPendingFor(scope, providerId)) return;
  const entries = scope === 'providers' ? displayedProviders() : (() => {
    const provider = state.providers.find(item => item.id === providerId);
    return provider ? displayedModels(provider) : [];
  })();
  if (entries.length < 2 || isPrioritized(entries)) return;
  const next = [...entries.filter(entry => entry.enabled !== false), ...entries.filter(entry => entry.enabled === false)].map(entry => entry.id);
  const key = scope === 'providers' ? 'order:providers:priority' : 'order:models:' + providerId + ':priority';
  orderFocusIntent = { key, item: orderItemKey(scope, providerId, next[0]), listKey: orderListKey(scope, providerId) };
  await performOrderRequest('prioritizeEnabledPanelList', scope, providerId, next);
}
function bindModels(import_) {
  $('#page').querySelectorAll('[data-a]').forEach(el => el.onclick = async () => {
    const a = el.dataset.a, id = el.dataset.id, pid = el.dataset.p, mid = el.dataset.mid;
    if (a === 'drag') return;
    else if (a === 'move') { await moveOrder(el.dataset.orderScope, el.dataset.orderProvider || null, el.dataset.orderId, Number(el.dataset.orderMove)); }
    else if (a === 'prioritize') { await prioritizeOrder(el.dataset.orderScope, el.dataset.orderProvider || null); }
    else if (a === 'pe') { const p = state.providers.find(x => x.id === id); call('setProviderEnabled', { id, enabled: !p.enabled }, undefined, () => clearDraftIfUnchanged(fieldKey(el), el)); }
    else if (a === 'del') { call('deleteProvider', { id }, undefined, () => { editingProviders.delete(id); clearProviderDrafts(id); }); }
    else if (a === 'collapse') { if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id); saveUi(); render(); }
    else if (a === 'edit') { editProvider(id); }
    else if (a === 'fetch') { call('refreshModels', { providerId: id }, '模型列表已获取'); }
    else if (a === 'import') { const ids = [...document.querySelectorAll('[data-imp]:checked:not(:disabled)')].map(x => x.dataset.imp); if (ids.length) { collapsed.delete(import_.providerId); saveUi(); call('importModels', { providerId: import_.providerId, token: import_.token, ids }, '已导入', () => { for (const key of drafts.keys()) if (key.startsWith('imp:')) drafts.delete(key); render(); }); } }
    else if (a === 'import-cancel') { for (const key of drafts.keys()) if (key.startsWith('imp:')) drafts.delete(key); render(); }
    else if (a === 'add') { const input = document.querySelector('[data-add="' + id + '"]'); if (input.value.trim()) { call('addModel', { providerId: id, model: { id: input.value.trim() } }, undefined, () => { clearDrafts('add:' + id); render(); }); } }
    else if (a === 'mdel') { call('updateModels', { providerId: pid, changes: [], removeIds: [mid] }, undefined, () => clearDrafts('model:' + pid + ':' + mid + ':')); }
    else if (a === 'save-p') { const name = $('#np-name').value, baseUrl = $('#np-url').value, apiFormat = $('#np-fmt').value, apiKey = $('#np-key').value; if (name && baseUrl) call('saveProvider', { name, baseUrl, apiFormat, apiKey }, '供应商已保存', () => {
      const submitted = { 'id:np-name': name, 'id:np-url': baseUrl, 'id:np-fmt': apiFormat, 'id:np-key': apiKey };
      clearSubmitted(submitted);
      render();
    }); }
  });
  $('#page').querySelectorAll('[data-m]').forEach(el => el.onchange = () => {
    const pid = el.dataset.p, mid = el.dataset.mid, k = el.dataset.m;
    let value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    if (k === 'efforts') value = value.split(',').map(s => s.trim()).filter(Boolean);
    if (k === 'defaultEffort' && value === '') value = null;
    call('updateModels', { providerId: pid, changes: [{ id: mid, [k]: value }], removeIds: [] }, undefined, () => clearDraftIfUnchanged(fieldKey(el), el));
  });
  $('#page').querySelectorAll('[data-role]').forEach(el => el.onchange = () => {
    call('setRoleModel', { role: el.dataset.role, model: JSON.parse(el.dataset.ref), enabled: el.checked }, undefined, () => clearDraftIfUnchanged(fieldKey(el), el));
  });
  const nativeToggle = $('#u-native');
  if (nativeToggle) nativeToggle.onchange = e => { showNative = e.target.checked; saveUi(); render(); };
  $('#page').querySelectorAll('[data-order-drag]').forEach(handle => handle.onpointerdown = startDragTracking);
}
function dragNodes(drag) { return [...drag.container.querySelectorAll(drag.selector)]; }
function dragOrder(drag) { return dragNodes(drag).map(node => node.dataset.orderId); }
function sameOrder(left, right) { return left.length === right.length && left.every((id, index) => id === right[index]); }
function restoreDragOrder(drag) {
  const nodes = new Map(dragNodes(drag).map(node => [node.dataset.orderId, node]));
  for (const id of drag.originalIds) {
    const node = nodes.get(id);
    if (node) drag.container.appendChild(node);
  }
}
function stopAutoScroll() { if (dragRaf) cancelAnimationFrame(dragRaf); dragRaf = 0; }
function updateDragPosition(x, y) {
  const drag = dragState;
  if (!drag?.started) return;
  drag.lastX = x; drag.lastY = y;
  const rect = drag.container.getBoundingClientRect();
  const valid = x >= rect.left - 8 && x <= rect.right + 8 && y >= rect.top && y <= rect.bottom;
  drag.valid = valid;
  drag.container.classList.toggle('drag-target', valid);
  drag.item.classList.toggle('drop-invalid', !valid);
  if (!valid) return;
  let before = null;
  for (const node of dragNodes(drag)) {
    if (node === drag.item) continue;
    const box = node.getBoundingClientRect();
    if (y < box.top + box.height / 2) { before = node; break; }
  }
  if (before) {
    if (drag.item.nextSibling !== before) drag.container.insertBefore(drag.item, before);
  } else if (drag.item !== drag.container.lastElementChild) drag.container.appendChild(drag.item);
}
function autoScrollFrame() {
  dragRaf = 0;
  const drag = dragState;
  if (!drag?.started) return;
  const edge = 58, height = window.innerHeight || document.documentElement.clientHeight;
  let delta = 0;
  if (drag.lastY < edge) delta = -Math.max(4, Math.round((edge - drag.lastY) / 3));
  else if (drag.lastY > height - edge) delta = Math.max(4, Math.round((drag.lastY - (height - edge)) / 3));
  if (delta) {
    const scroller = document.scrollingElement || document.documentElement;
    const before = scroller.scrollTop;
    scroller.scrollTop += delta;
    if (scroller.scrollTop !== before) updateDragPosition(drag.lastX, drag.lastY);
  }
  if (dragState === drag && drag.started && (drag.lastY < edge || drag.lastY > height - edge)) dragRaf = requestAnimationFrame(autoScrollFrame);
}
function startAutoScroll() { if (!dragRaf) dragRaf = requestAnimationFrame(autoScrollFrame); }
function startDragVisual(drag, event) {
  drag.started = true;
  drag.lastX = event.clientX; drag.lastY = event.clientY;
  document.body.classList.add('is-dragging');
  drag.item.classList.add('dragging');
  drag.container.classList.add('drag-target');
  if (drag.scope === 'providers') drag.container.classList.add('provider-order-dragging');
  updateDragPosition(event.clientX, event.clientY);
  startAutoScroll();
}
function stopDragTracking(drag) {
  stopAutoScroll();
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragCancel);
  window.removeEventListener('blur', onDragBlur);
  document.removeEventListener('keydown', onDragKey, true);
  try { if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId); } catch {}
  document.body.classList.remove('is-dragging');
  drag.item.classList.remove('dragging', 'drop-invalid');
  drag.container.classList.remove('drag-target', 'provider-order-dragging');
  dragState = null;
}
function cancelDrag({ restore = true, notify = false, render: rerender = false, preserveFocus = false } = {}) {
  const drag = dragState;
  if (!drag) return;
  const focus = drag.focus;
  if (restore && drag.started) restoreDragOrder(drag);
  stopDragTracking(drag);
  if (preserveFocus) focusWithFallback(focus);
  if (notify) toast('列表已更新，请重新调整', true);
  if (rerender) flushDeferredState();
}
function startDragTracking(event) {
  if (dragState || event.button !== 0 || event.isPrimary === false) return;
  const handle = event.currentTarget;
  if (!handle || handle.disabled) return;
  const scope = handle.dataset.orderScope, providerId = scope === 'models' ? (handle.dataset.orderProvider || null) : null;
  const id = handle.dataset.orderId;
  if (!id || !orderSortableFor(scope, providerId) || orderPendingFor(scope, providerId)) return;
  const token = orderTokenFor(scope, providerId);
  if (!token) return;
  const item = scope === 'providers' ? handle.closest('[data-pcard]') : handle.closest('[data-mrow]');
  const container = scope === 'providers' ? document.querySelector('[data-plist]') : item?.closest('[data-mlist]');
  if (!item || !container) return;
  const selector = scope === 'providers' ? '[data-pcard]' : '[data-mrow]';
  const originalIds = dragNodes({ container, selector });
  if (originalIds.length < 2) return;
  // Keep focus (and its text selection) in place for pointer drags. Keyboard
  // users get the same ordering through the explicit up/down buttons.
  if (event.pointerType !== 'touch') event.preventDefault();
  const drag = { pointerId: event.pointerId, handle, item, container, selector, scope, providerId, id, token,
    started: false, valid: true, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY,
    focus: captureFocus(), originalIds: originalIds.map(node => node.dataset.orderId) };
  dragState = drag;
  try { handle.setPointerCapture(event.pointerId); } catch {}
  window.addEventListener('pointermove', onDragMove, { passive: false });
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragCancel);
  window.addEventListener('blur', onDragBlur);
  document.addEventListener('keydown', onDragKey, true);
}
function onDragMove(event) {
  const drag = dragState;
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.lastX = event.clientX; drag.lastY = event.clientY;
  if (!drag.started) {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    event.preventDefault();
    startDragVisual(drag, event);
  } else {
    event.preventDefault();
    updateDragPosition(event.clientX, event.clientY);
    const height = window.innerHeight || document.documentElement.clientHeight;
    if (!dragRaf && (drag.lastY < 58 || drag.lastY > height - 58)) startAutoScroll();
  }
}
function onDragEnd(event) {
  const drag = dragState;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.started) { stopDragTracking(drag); flushDeferredState(); return; }
  event.preventDefault();
  updateDragPosition(event.clientX, event.clientY);
  const next = dragOrder(drag), scope = drag.scope, providerId = drag.providerId, token = drag.token;
  if (!drag.valid || sameOrder(drag.originalIds, next)) {
    cancelDrag({ restore: true, notify: false, render: false, preserveFocus: true });
    flushDeferredState();
    return;
  }
  const focus = drag.focus;
  stopDragTracking(drag);
  focusWithFallback(focus);
  if (deferredState) { state = deferredState; deferredState = null; }
  void performOrderRequest('reorderPanelList', scope, providerId, next, token);
}
function onDragCancel(event) {
  if (!dragState) return;
  try { event.preventDefault(); } catch {}
  cancelDrag({ restore: true, notify: false, render: false, preserveFocus: true });
  flushDeferredState();
}
function onDragBlur() {
  if (!dragState) return;
  cancelDrag({ restore: true, notify: false, render: false, preserveFocus: true });
  flushDeferredState();
}
function onDragKey(event) {
  if (!dragState || event.key !== 'Escape') return;
  event.preventDefault(); event.stopPropagation();
  cancelDrag({ restore: true, notify: false, render: false, preserveFocus: true });
  flushDeferredState();
}
function editProvider(id) {
  const p = state.providers.find(x => x.id === id); if (!p) return;
  const div = document.querySelector('[data-prov="' + id + '"]'); if (!div) return;
  editingProviders.add(id);
  const key = name => 'edit:' + id + ':' + name;
  div.innerHTML = '<div class="row mt8"><input id="ep-name" data-draft="' + esc(key('name')) + '" data-f="name" value="' + esc(p.name) + '">' +
    '<input id="ep-url" data-draft="' + esc(key('url')) + '" data-f="url" value="' + esc(p.baseUrl) + '" class="grow">' +
    '<select id="ep-fmt" data-draft="' + esc(key('fmt')) + '" data-f="fmt">' + ['openai', 'openai-responses', 'anthropic'].map(f => '<option ' + (f === p.apiFormat ? 'selected' : '') + '>' + f + '</option>').join('') + '</select>' +
    '<input id="ep-key" data-draft="' + esc(key('key')) + '" data-f="key" placeholder="' + (p.keyConfigured ? '(留空保持不变)' : 'API Key') + '" class="grow" type="password">' +
    '<button data-a="save-e">保存</button><button class="sec" data-a="cancel-e">取消</button></div>';
  const field = name => div.querySelector('[data-f="' + name + '"]');
  div.querySelector('[data-a="save-e"]').onclick = () => {
    const submitted = {
      [key('name')]: field('name').value, [key('url')]: field('url').value,
      [key('fmt')]: field('fmt').value, [key('key')]: field('key').value,
    };
    return call('saveProvider', {
      id, name: submitted[key('name')], baseUrl: submitted[key('url')], apiFormat: submitted[key('fmt')],
      apiKey: submitted[key('key')] || undefined,
    }, '已保存', () => {
      editingProviders.delete(id);
      clearSubmitted(submitted);
      render();
    });
  };
  div.querySelector('[data-a="cancel-e"]').onclick = () => { editingProviders.delete(id); clearEditDrafts(id); div.innerHTML = ''; };
}

/* ---------- Fusion 预设 ---------- */
function renderFusion() {
  const cand = state.presetCandidates || { lead: [], sidekick: [] };
  $('#page').innerHTML =
    '<h2>预设</h2><div class="card">' +
    (state.fusionPresets.length ? '<div class="tw"><table class="rt"><tr class="rh"><th>预设</th><th>Lead</th><th>Sidekick</th><th>操作</th></tr>' +
      state.fusionPresets.map(p => '<tr><td data-th="预设"><strong>' + esc(p.name) + '</strong>' + (p.available ? '' : '<div class="err fs11">' + esc(p.reason || '不可用') + '</div>') +
        ((state.selectedFusionUid === p.uid || state.selectedFusionPresetId === p.id) ? ' <span class="badge on">当前</span>' : '') + '</td>' +
        '<td data-th="Lead">' + esc(p.leadLabel || refLabel(p.lead)) + '</td><td data-th="Sidekick">' + esc(p.sidekickLabel || refLabel(p.sidekick)) + '</td>' +
        '<td data-th="操作"><div class="ops"><button class="sec" data-a="sel" data-uid="' + p.uid + '" ' + (p.available ? '' : 'disabled') + '>设为当前</button>' +
        '<button class="sec" data-a="del" data-id="' + p.id + '">删除</button></div></td></tr>').join('') + '</table></div>' : '<span class="muted">暂无预设。</span>') + '</div>' +
    '<p class="foot">预设会出现在 Devin 模型列表的「ddevin Fusion」分组。Lead 是主模型，Sidekick 是配合模型；两者都可选 BYOK 模型或可用的官方模型。</p>' +
    '<h3>新建预设</h3><div class="card"><div class="row"><input id="fp-name" placeholder="预设名称">' +
    '<select id="fp-lead"><option value="">— Lead —</option>' + cand.lead.map(c => '<option value="' + esc(JSON.stringify(c.ref)) + '">' + esc(c.label) + '</option>').join('') + '</select>' +
    '<select id="fp-side"><option value="">— Sidekick —</option>' + cand.sidekick.map(c => '<option value="' + esc(JSON.stringify(c.ref)) + '">' + esc(c.label) + '</option>').join('') + '</select>' +
    '<button data-a="mk">创建</button></div></div>';
  $('#page').querySelectorAll('[data-a]').forEach(el => el.onclick = () => {
    const a = el.dataset.a;
    if (a === 'mk') { const name = $('#fp-name').value, lead = $('#fp-lead').value, sidekick = $('#fp-side').value; if (name && lead && sidekick) call('saveFusionPreset', { name, lead: JSON.parse(lead), sidekick: JSON.parse(sidekick) }, '预设已创建', () => {
      const submitted = { 'id:fp-name': name, 'id:fp-lead': lead, 'id:fp-side': sidekick };
      clearSubmitted(submitted);
      render();
    }); }
    else if (a === 'sel') call('selectFusion', { uid: el.dataset.uid }, '已设为当前 Fusion，请新建会话生效');
    else if (a === 'del') call('deleteFusionPreset', { id: el.dataset.id });
  });
}

/* ---------- 官方模型 ---------- */
function renderNative() {
  const list = state.nativeModels || [];
  $('#page').innerHTML =
    '<div class="sh"><h2>官方模型</h2><span class="muted fs11">' + esc(state.nativeCatalogStatus || '-') + '</span><span class="grow"></span><button class="sec" data-a="ref">刷新</button></div>' +
    '<div class="card">' + (list.length ? '<div class="tw"><table class="rt"><tr class="rh"><th>官方模型</th><th>uid</th><th>状态</th><th>Fusion 角色</th><th>隐藏</th></tr>' +
      list.map(n => '<tr><td data-th="官方模型">' + esc(n.label) + '</td><td class="mono muted" data-th="uid">' + esc(n.uid) + '</td>' +
        '<td data-th="状态">' + (n.disabled ? '<span class="badge warn">已禁用</span>' : '<span class="badge on">可用</span>') + '</td>' +
        '<td class="muted" data-th="Fusion 角色">' + (n.eligibleLead ? 'Lead ' : '') + (n.eligibleSidekick ? 'Sidekick' : '') + '</td>' +
        '<td data-th="隐藏"><input type="checkbox" ' + (n.hidden ? 'checked' : '') + ' data-h="' + esc(n.uid) + '"></td></tr>').join('') + '</table></div>'
      : '<span class="muted">尚未观测到官方模型目录（模型列表刷新后出现）。</span>') + '</div>' +
    '<p class="foot">列表模式为「只显示 BYOK」时全部官方模型自动隐藏；此处可单独隐藏个别官方条目。</p>';
  $('#page').querySelector('[data-a="ref"]')?.addEventListener('click', () => call('refreshNativeModels', {}));
  $('#page').querySelectorAll('[data-h]').forEach(el => el.onchange = () => call('setNativeModelHidden', { uid: el.dataset.h, hidden: el.checked }, undefined, () => clearDraftIfUnchanged(fieldKey(el), el)));
}

/* ---------- 设置 ---------- */
// Same formula as the backend warmer: ttl minus 20%, clamped to 30-60s.
const warmIntervalSec = ttl => ttl - Math.min(Math.max(Math.round(ttl * 0.2), 30), 60);
const warmEvery = ttl => { const i = warmIntervalSec(ttl); return i >= 60 && i % 60 === 0 ? Math.round(i / 60) + ' 分钟' : i + ' 秒'; };
function renderSettings() {
  const warm = state.cacheWarm || {};
  const item = (k, v, hint) => '<div class="item"><div class="k">' + k + (hint ? '<div class="muted fs11">' + hint + '</div>' : '') + '</div><div class="v">' + v + '</div></div>';
  $('#page').innerHTML =
    '<h3>模型列表模式</h3><div class="card list">' + item('列表模式', '<select id="s-mode">' +
    [['coexist', '共存 — BYOK 与官方模型都显示'], ['byok', '只显示 BYOK — 隐藏全部官方模型'], ['official', '只显示官方 — 不注入 BYOK 条目']].map(([v, t]) =>
      '<option value="' + v + '" ' + (state.modelListMode === v ? 'selected' : '') + '>' + t + '</option>').join('') +
    '</select>') + '</div><p class="foot">改动保存后需新开一个 Devin 会话生效（插件会自动尝试触发刷新）。</p>' +
    '<h3>日志</h3><div class="card list">' + item('日志级别', '<select id="s-level">' +
    ['trace', 'debug', 'info', 'warn', 'error'].map(l => '<option ' + (state.logLevel === l ? 'selected' : '') + '>' + l + '</option>').join('') +
    '</select>') + '</div><p class="foot">后端日志：~/.ddevin/runtime.log · 扩展日志：输出面板 ddevin</p>' +
    '<h3>缓存保温</h3><div class="card list">' +
    item('启用缓存保温', '<input type="checkbox" id="w-enabled"' + (warm.enabled === true ? ' checked' : '') + '>') +
    item('长生成期间也保温', '<input type="checkbox" id="w-stream"' + (warm.whileStreaming !== false ? ' checked' : '') + '>') +
    item('最长保温', '<input id="w-gap" type="number" min="5" max="240" value="' + esc(warm.maxGapMinutes || 45) + '"> 分钟') +
    '</div><div class="card list">' +
    item('BYOK 模型', '<input type="checkbox" id="w-byok"' + (warm.byok !== false ? ' checked' : '') + '>') +
    item('BYOK 缓存有效期', '<input id="w-ttl" type="number" min="1" max="60" value="' + esc(Math.round((warm.ttlSeconds || 300) / 60)) + '"> 分钟') +
    '</div><div class="card list">' +
    item('官方模型', '<input type="checkbox" id="w-official"' + (warm.official === true ? ' checked' : '') + '>', '实验性：官方可能按条计费，开启前先到日志页看官方请求的计费列。') +
    item('官方缓存有效期', '<input id="w-ottl" type="number" min="1" max="60" value="' + esc(Math.round((warm.officialTtlSeconds || 300) / 60)) + '"> 分钟') +
    '</div><p class="foot">保温请求不进入对话；每次按缓存读取计费。按当前有效期，约每 ' + esc(warmEvery(warm.ttlSeconds || 300)) + ' 发一次（官方约每 ' + esc(warmEvery(warm.officialTtlSeconds || 300)) + '）。</p>' +
    '<h3>配置</h3><div class="card list">' + item('配置文件', '<span class="mono">~/.ddevin/config.json</span>') + '</div><p class="foot">直接编辑会热重载生效。</p>';
  $('#s-mode').onchange = e => call('setListMode', { mode: e.target.value }, '列表模式已更新', () => clearDrafts('id:s-mode'));
  $('#s-level').onchange = e => call('setLogLevel', { level: e.target.value }, '日志级别已更新', () => clearDrafts('id:s-level'));
  const warmSet = (key, value, field) => call('setCacheWarm', { [key]: value }, undefined, () => clearDrafts('id:' + field));
  $('#w-enabled').onchange = e => warmSet('enabled', e.target.checked, 'w-enabled');
  $('#w-byok').onchange = e => warmSet('byok', e.target.checked, 'w-byok');
  $('#w-official').onchange = e => warmSet('official', e.target.checked, 'w-official');
  $('#w-stream').onchange = e => warmSet('whileStreaming', e.target.checked, 'w-stream');
  $('#w-ttl').onchange = e => { const v = Math.round(Number(e.target.value)); if (v >= 1 && v <= 60) warmSet('ttlSeconds', v * 60, 'w-ttl'); };
  $('#w-ottl').onchange = e => { const v = Math.round(Number(e.target.value)); if (v >= 1 && v <= 60) warmSet('officialTtlSeconds', v * 60, 'w-ottl'); };
  $('#w-gap').onchange = e => { const v = Math.round(Number(e.target.value)); if (v >= 5 && v <= 240) warmSet('maxGapMinutes', v, 'w-gap'); };
}

/* ---------- 日志 ---------- */
function renderLogs() {
  const entries = logs.entries || [];
  const stats = logs.metrics && logs.metrics.models ? Object.values(logs.metrics.models) : [];
  const show = v => v === undefined || v === null ? '—' : esc(String(v));
  const hitRate = m => m.inputTokens > 0 ? esc(Math.round(m.cacheReadTokens * 100 / m.inputTokens) + '%') : '—';
  const billing = m => {
    const parts = [];
    if (Number.isFinite(m.creditCost)) parts.push(m.creditCost + ' credit');
    if (Number.isFinite(m.acuCost)) parts.push((Math.round(m.acuCost * 1000) / 1000) + ' ACU');
    return parts.length ? esc(parts.join(' · ')) : '—';
  };
  const statRow = (m, label) => '<tr><td data-th="模型">' + esc(label || m.model) + '</td><td data-th="请求">' + show(m.requests) + '</td>' +
    '<td data-th="错误">' + show(m.errors) + '</td><td data-th="首字(ms)">' + show(m.avgTtftMs) + '</td>' +
    '<td data-th="p50">' + show(m.p50DurationMs) + '</td><td data-th="p95">' + show(m.p95DurationMs) + '</td>' +
    '<td data-th="输入">' + show(m.inputTokens) + '</td><td data-th="输出">' + show(m.outputTokens) + '</td>' +
    '<td data-th="缓存命中">' + hitRate(m) + '</td><td data-th="重试">' + show(m.retries) + '</td>' +
    '<td data-th="官方计费">' + billing(m) + '</td></tr>';
  const totals = logs.metrics && logs.metrics.totals;
  const metricsTable = '<div class="sh"><h3>统计</h3><span class="muted fs11">' + esc(logs.status || '') + '</span><span class="grow"></span><button class="sec" data-a="ref">刷新</button></div><div class="card">' + (stats.length ?
    '<div class="tw"><table class="rt"><tr class="rh"><th>模型</th><th>请求</th><th>错误</th><th>首字(ms)</th><th>p50</th><th>p95</th><th>输入</th><th>输出</th><th>缓存命中</th><th>重试</th><th>官方计费</th></tr>' +
    stats.map(m => statRow(m)).join('') + (totals && stats.length > 1 ? statRow(totals, '合计') : '') + '</table></div>' : '<span class="muted">暂无请求</span>') + '</div>';
  const warm = logs.warm && typeof logs.warm === 'object' ? logs.warm : null;
  const wstate = { waiting: '等待', pinging: '保温中', streaming: '生成中', stopped: '已停' };
  const wreason = r => !r ? '' : ({ superseded: '被取代', cap: '达到上限', max_gap: '超过最长保温', cache_miss: '缓存未命中',
    evicted: '内存淘汰', lapsed: '保温失效' })[r] || (r.startsWith('rejected:') ? '被拒绝：' + r.slice(9) : r);
  const wdue = l => l.nextAt == null ? '—' : (l.nextAt - (warm.now || 0)) <= 0 ? '到点'
    : (l.nextAt - (warm.now || 0)) < 60000 ? Math.ceil((l.nextAt - (warm.now || 0)) / 1000) + 's' : Math.round((l.nextAt - (warm.now || 0)) / 60000) + 'min';
  const wt = warm && warm.totals || {};
  const warmCredits = [];
  if (Number.isFinite(wt.creditCost) && wt.creditCost || Number.isFinite(wt.committedCreditCost) && wt.committedCreditCost)
    warmCredits.push((wt.creditCost || wt.committedCreditCost) + ' credit');
  if (Number.isFinite(wt.acuCost) && wt.acuCost) warmCredits.push((Math.round(wt.acuCost * 1000) / 1000) + ' ACU');
  const warmCard = !warm ? '' : '<h3>缓存保温</h3><div class="card">' +
    '<p class="muted fs11 m0">已发 ' + esc(wt.sent ?? 0) + ' · 命中 ' + esc(wt.hits ?? 0) + ' · 未中 ' + esc(wt.misses ?? 0) +
    ' · 未验证 ' + esc(wt.unknowns ?? 0) + ' · 错误 ' + esc(wt.errors ?? 0) +
    ' · 读缓存 ' + esc(wt.readTokens ?? 0) + ' tokens · 恢复命中 ' + esc(wt.resumeHits ?? 0) + '/' + esc(wt.resumeAttempts ?? 0) +
    ' · 省重写 ' + esc(wt.avoidedTokens ?? 0) + ' tokens' + (warmCredits.length ? ' · 官方计费 ' + esc(warmCredits.join(' + ')) : '') + '</p>' +
    ((warm.lineages || []).length ?
      '<div class="tw mt8"><table class="rt"><tr class="rh"><th>会话</th><th>类型</th><th>模型</th><th>状态</th><th>下次</th><th>本轮/上限</th><th>命中/未中</th><th>上次读缓存</th><th>前缀 tokens</th><th>已验证</th></tr>' +
      warm.lineages.map(l => '<tr><td class="mono" data-th="会话">' + esc(l.key) + '</td>' +
        '<td data-th="类型">' + (l.kind === 'official' ? '官方' : 'BYOK') + '</td>' +
        '<td data-th="模型">' + esc(l.model) + '</td>' +
        '<td data-th="状态">' + esc((wstate[l.state] || l.state) + (l.state === 'stopped' && l.stopReason ? '：' + wreason(l.stopReason) : '')) + '</td>' +
        '<td data-th="下次">' + esc(wdue(l)) + '</td>' +
        '<td data-th="本轮/上限">' + esc(l.gapPings + '/' + l.cap) + '</td>' +
        '<td data-th="命中/未中">' + esc(l.hits + '/' + l.misses) + '</td>' +
        '<td data-th="上次读缓存">' + show(l.lastRead) + '</td>' +
        '<td data-th="前缀 tokens">' + show(l.promptTokens) + '</td>' +
        '<td data-th="已验证">' + (l.verified ? '<span class="ok">✓</span>' : '—') + '</td></tr>').join('') + '</table></div>'
      : '<p class="muted mt8 m0">暂无会话</p>') + '</div>';
  const html = metricsTable + warmCard +
    '<h2>后端日志</h2><div class="logbox">' + (entries.length ? entries.map(e =>
      '<div class="logline ' + esc(e.level || 'info') + '">' + esc(e.time || '') + ' ' + esc((e.level || '').toUpperCase().padEnd(5)) + ' [' + esc(e.event) + '] ' +
      esc(JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['time', 'level', 'event'].includes(k))))) + '</div>').join('') : '<span class="muted">暂无日志</span>') + '</div>';
  $('#page').innerHTML = html;
  $('#page').querySelector('[data-a="ref"]').onclick = () => vscode.postMessage({ id: 'lr' + Date.now(), type: 'logs.refresh' });
  const box = $('#page').querySelector('.logbox'); if (box) box.scrollTop = box.scrollHeight;
}

render();
req('ready', {}).then(s => {}).catch(() => {});
</script>
</body>
</html>`;
  return html;
}
module.exports = { renderPanel };
