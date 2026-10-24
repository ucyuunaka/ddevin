'use strict';

const https = require('node:https');
const { execFileSync } = require('node:child_process');

function windowsProxy() {
  try {
    const text = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const value = name => text.match(new RegExp('^\\s*' + name + '\\s+REG_\\w+\\s+(.*)$', 'm'))?.[1].trim();
    return { enabled: Number(value('ProxyEnable')) === 1, server: value('ProxyServer') || '', bypass: value('ProxyOverride') || '' };
  } catch { return { enabled: false }; }
}

function proxyUrl(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const url = new URL(value.includes('://') ? value : 'http://' + value);
    return ['http:', 'https:'].includes(url.protocol) && url.pathname === '/' && !url.search && !url.hash ? url.href : '';
  } catch { return ''; }
}

function officialProxyEnv({ env = process.env, platform = process.platform, readWindowsProxy = windowsProxy } = {}) {
  // An explicitly empty environment setting means direct; it takes precedence
  // over the Windows setting just as an explicit proxy URL does.
  const name = ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'].find(key => Object.hasOwn(env, key));
  let proxy = '', source = 'direct', bypass = env.no_proxy ?? env.NO_PROXY ?? '';
  if (name) {
    proxy = proxyUrl(env[name]);
    source = proxy ? 'environment' : 'direct';
  } else if (platform === 'win32') {
    const settings = readWindowsProxy();
    if (settings.enabled) {
      const server = settings.server || '';
      const entry = server.includes('=') ? server.split(';').find(part => /^https=/i.test(part.trim()))?.trim().slice(6) : server;
      proxy = proxyUrl(entry);
      source = proxy ? 'windows' : 'direct';
      // Node accepts domain wildcards, but not Windows' <local> marker.
      const overrides = (settings.bypass || '').split(';').map(value => value.trim()).filter(value => value && value !== '<local>');
      bypass = [bypass, ...overrides].filter(Boolean).join(',');
    }
  }
  return { source, proxyEnv: { HTTPS_PROXY: proxy, NO_PROXY: [bypass, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',') } };
}

function createOfficialAgent({ log = () => {}, ...options } = {}) {
  const { source, proxyEnv } = officialProxyEnv(options);
  log('info', 'official-network', { mode: source });
  // Explicit agents avoid changing the extension host's global networking or
  // sending loopback language-server traffic through the system proxy.
  return new https.Agent({ keepAlive: true, proxyEnv });
}

module.exports = { officialProxyEnv, createOfficialAgent };
