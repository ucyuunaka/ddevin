'use strict';

function loopbackProxyBypass(current = {}, inherited = process.env) {
  const entries = ['NO_PROXY', 'no_proxy'].flatMap(key => {
    const value = current[key] ?? inherited[key];
    return typeof value === 'string' ? value.split(',').map(entry => entry.trim()).filter(Boolean) : [];
  });
  const seen = new Set();
  const bypass = [...entries, '127.0.0.1', 'localhost', '::1'].filter(entry => {
    const key = entry.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(',');
  // The CLI and its HTTP dependencies may prefer different casing. Both must
  // bypass the loopback API while keeping the user's existing exclusions.
  return { NO_PROXY: bypass, no_proxy: bypass };
}

module.exports = { loopbackProxyBypass };
