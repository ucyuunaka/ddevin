'use strict';

// vscode:uninstall hook. ddevin keeps its restore receipt at the fixed
// ~/.ddevin/settings-restore.json, which survives extension removal, so no
// storage-pointer file is needed. Restores only keys still owned by us.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { paths } = require('../config.cjs');
const { RECEIPT, permitted, atomicJson } = require('./owned-settings.cjs');
const { restoreJsonc } = require('./jsonc-edit.cjs');
const { controlFile, PORT } = require('../runtime/backend.cjs');

function restoreFile(receipt, { beforeCommit } = {}) {
  const settingsFile = receipt.settingsFile;
  if (typeof settingsFile !== 'string' || !path.isAbsolute(settingsFile)) throw new Error('Invalid settings path');
  const stat = fs.lstatSync(settingsFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Settings path is not a regular file');
  const source = fs.readFileSync(settingsFile, 'utf8');
  const restored = restoreJsonc(source, receipt.changes);
  if (!restored.count) return 0;
  const backup = settingsFile + '.ddevin-before-uninstall';
  try { fs.writeFileSync(backup, source, { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const temporary = settingsFile + '.' + crypto.randomUUID();
  try {
    fs.writeFileSync(temporary, restored.text, { mode: stat.mode & 0o600, flag: 'wx' });
    beforeCommit?.();
    if (fs.readFileSync(settingsFile, 'utf8') !== source) throw new Error('Settings changed during restoration');
    fs.renameSync(temporary, settingsFile);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  return restored.count;
}

// Best-effort backend shutdown so the detached proxy process does not outlive
// the extension. Retries once when the runtime reports active requests.
async function shutdownRuntime({ root, log }) {
  try {
    const control = JSON.parse(fs.readFileSync(controlFile(root), 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(control?.token || '')) return;
    const base = 'http://127.0.0.1:' + PORT;
    const healthResponse = await fetch(base + '/health', { signal: AbortSignal.timeout(1500) });
    if (!healthResponse.ok) return;
    const health = await healthResponse.json();
    if (health.service !== 'ddevin' || health.rootId !== control.rootId || health.instanceId !== control.instanceId) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(base + '/_runtime/shutdown', { method: 'POST',
        headers: { authorization: 'Bearer ' + control.token }, signal: AbortSignal.timeout(2000) });
      if (response.status !== 409) { if (response.ok) log('runtime-shutdown'); return; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    log('runtime-shutdown-busy');
  } catch { /* Shutdown stays best-effort; a busy runtime exits on next reboot. */ }
}

async function uninstall({ extensionPath = path.resolve(__dirname, '../..'), log = () => {} } = {}) {
  let restored = 0, failed = 0;
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(path.join(paths.root, RECEIPT), 'utf8')); } catch { receipt = null; }
  if (receipt && receipt.version === 1 && receipt.extensionPath === path.resolve(extensionPath) && receipt.root === paths.root &&
      Array.isArray(receipt.changes) && receipt.changes.every(change => permitted(change.path) &&
        typeof change.managed === 'string' && change.original && typeof change.original.exists === 'boolean')) {
    try { restored = restoreFile(receipt); }
    catch {
      failed = 1;
      // Keep the receipt outside the settings file when restoration was not
      // possible so a later run can retry it.
      try { atomicJson(receipt.settingsFile + '.ddevin-restore-pending.json', receipt); } catch {}
      log('settings-restore-pending');
    }
    log('settings-restored', { count: restored, failed });
  }
  await shutdownRuntime({ root: paths.root, log });
  return { restored, failed };
}
if (require.main === module) uninstall({ log: (event, data = {}) => console.log(JSON.stringify({ event, ...data })) })
  .catch(error => { console.log(JSON.stringify({ event: 'uninstall-error', error: String(error?.message || error) })); process.exitCode = 1; });
module.exports = { uninstall };
