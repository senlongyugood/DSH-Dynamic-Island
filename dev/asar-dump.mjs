// Extract a filtered set of files from an Electron ASAR into a local directory.
// Usage: node asar-dump.mjs <archive> <innerPrefix> <outDir> <pathRegex>
import fs from 'node:fs';
import path from 'node:path';

const [archive, innerPrefix, outDir, pattern] = process.argv.slice(2);
if (!archive || !innerPrefix || !outDir || !pattern) {
  console.error('usage: node asar-dump.mjs <archive> <innerPrefix> <outDir> <pathRegex>');
  process.exit(2);
}
const re = new RegExp(pattern);

const fd = fs.openSync(archive, 'r');
const sizeBuf = Buffer.alloc(16);
fs.readSync(fd, sizeBuf, 0, 16, 0);
const pickleSize = sizeBuf.readUInt32LE(4);
const jsonLen = sizeBuf.readUInt32LE(12);
const headerBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, headerBuf, 0, jsonLen, 16);
const header = JSON.parse(headerBuf.toString('utf8'));
const base = 8 + pickleSize;

const files = [];
(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child, p);
    else files.push({ path: p, size: Number(child.size ?? 0), offset: Number(child.offset ?? 0) });
  }
})(header, '');

let count = 0;
let bytes = 0;
for (const f of files) {
  if (!f.path.startsWith(innerPrefix) || !re.test(f.path)) continue;
  const relative = f.path.slice(innerPrefix.length).replace(/^\/+/, '');
  const target = path.join(outDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const buf = Buffer.alloc(f.size);
  if (f.size > 0) fs.readSync(fd, buf, 0, f.size, base + f.offset);
  fs.writeFileSync(target, buf);
  count += 1;
  bytes += f.size;
}
console.log(`extracted ${count} files (${bytes} bytes) -> ${outDir}`);
