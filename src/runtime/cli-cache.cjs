'use strict';

// devin-cli keeps the catalog it fetched in a per-identity disk cache and
// revalidates it lazily: a young entry is served without asking the network,
// a stale one is served while a background refresh runs (so the session that
// is starting keeps the old list), and only a missing or expired entry forces
// a blocking fetch. A new conversation spawns a CLI process that reads this
// cache cold, so a model registered seconds ago stays invisible until the
// entry ages out. Zeroing fetched_at_secs makes the next read miss and take
// the blocking path, which our proxy answers with the augmented catalog.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const CACHE_FILE = /^(?:model_configs_v\d+|user_status|team_settings)\.[0-9a-f]{16}\.bin$/;
const FETCHED_AT = /"fetched_at_secs":\d+/;

function cliCacheDirs({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') return [path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'devin', 'cli')];
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'Caches', 'devin', 'cli'), path.join(home, 'Library', 'Application Support', 'devin', 'cli')];
  }
  return [path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'devin', 'cli'), path.join(home, '.local', 'share', 'devin', 'cli')];
}

// Rewrite in place through a sibling temp file so a CLI process reading
// concurrently never sees a truncated or half-written wrapper.
function replaceFile(file, text) {
  const temporary = file + '.' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try {
    const { mode } = fs.statSync(file);
    fs.writeFileSync(temporary, text, { mode: mode & 0o777, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function expireFile(file, counts) {
  const text = fs.readFileSync(file, 'utf8');
  const match = FETCHED_AT.exec(text);
  if (!match) { counts.skipped += 1; return; }
  if (match[0] !== '"fetched_at_secs":0') replaceFile(file, text.replace(FETCHED_AT, '"fetched_at_secs":0'));
  counts.expired += 1;
}

function expireCliModelCaches({ dirs = cliCacheDirs(), log = () => {} } = {}) {
  const totals = { expired: 0, skipped: 0, failed: 0 };
  for (const dir of dirs ?? []) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    const counts = { expired: 0, skipped: 0, failed: 0 };
    for (const name of names) {
      if (!CACHE_FILE.test(name)) continue;
      try { expireFile(path.join(dir, name), counts); } catch { counts.failed += 1; }
    }
    totals.expired += counts.expired; totals.skipped += counts.skipped; totals.failed += counts.failed;
    try { log('debug', 'cli-cache-expire', { dir, ...counts }); } catch {}
  }
  return totals;
}

module.exports = { cliCacheDirs, expireCliModelCaches, CACHE_FILE };
