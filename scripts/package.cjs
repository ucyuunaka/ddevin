'use strict';

// Build ddevin-<version>.vsix (a plain ZIP, store method — no dependencies).
// Stages package.json + src/ + docs under extension/, plus the two manifest
// files VS Code expects at the archive root.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // UTF-8 flag
    local.writeUInt16LE(0, 8);            // store
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(0, 12); entry.writeUInt16LE(0, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);      // local header offset
    central.push(Buffer.concat([entry, nameBytes]));
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

function walk(dir, prefix, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, prefix + entry.name + '/', out);
    else if (entry.isFile()) out.push({ name: prefix + entry.name, data: fs.readFileSync(full) });
  }
}

const entries = [];
entries.push({ name: '[Content_Types].xml', data: Buffer.from(
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/>' +
  '<Default Extension="md" ContentType="text/markdown"/><Default Extension="svg" ContentType="image/svg+xml"/>' +
  '<Default Extension="png" ContentType="image/png"/>' +
  '<Default Extension="vsixmanifest" ContentType="text/xml"/>' +
  '<Default Extension="" ContentType="text/plain"/></Types>') });
entries.push({ name: 'extension.vsixmanifest', data: Buffer.from(
  `<?xml version="1.0"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">` +
  `<Metadata><Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}"/>` +
  `<DisplayName>${pkg.displayName}</DisplayName><Description xml:space="preserve">${pkg.description}</Description>` +
  `<Tags>byok,devin</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags>` +
  `<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}"/>` +
  `<Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>` +
  `<Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>` +
  `<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/></Properties></Metadata>` +
  `<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>` +
  `<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>` +
  `</PackageManifest>`) });
entries.push({ name: 'extension/package.json', data: fs.readFileSync(path.join(root, 'package.json')) });
walk(path.join(root, 'src'), 'extension/src/', entries);
if (fs.existsSync(path.join(root, 'media'))) walk(path.join(root, 'media'), 'extension/media/', entries);
// extension/README.md is what the IDE shows on the extension details page.
// publish/README.md is the single source of truth for that text; the public
// tree has no publish/ directory, where README.md already is that file.
const readme = path.join(root, 'publish/README.md');
const readmeFile = fs.existsSync(readme) ? readme : path.join(root, 'README.md');
if (fs.existsSync(readmeFile)) {
  entries.push({ name: 'extension/README.md', data: fs.readFileSync(readmeFile) });
}
if (fs.existsSync(path.join(root, 'LICENSE'))) {
  entries.push({ name: 'extension/LICENSE', data: fs.readFileSync(path.join(root, 'LICENSE')) });
}

const output = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
fs.writeFileSync(output, zip(entries));
const { size } = fs.statSync(output);
console.log(`${output} (${entries.length} files, ${size} bytes)`);
