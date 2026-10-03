// Minimal Electron ASAR reader: list entries, or extract one file to stdout / a path.
// Usage:
//   node asar-read.mjs <archive> list [prefix]
//   node asar-read.mjs <archive> read <innerPath>
//   node asar-read.mjs <archive> extract <innerPath> <outPath>
import fs from 'node:fs';
import path from 'node:path';

const [archive, cmd, arg1, arg2] = process.argv.slice(2);
if (!archive || !cmd) {
  console.error('usage: node asar-read.mjs <archive> list|read|extract [args]');
  process.exit(2);
}

const fd = fs.openSync(archive, 'r');
const sizeBuf = Buffer.alloc(16);
fs.readSync(fd, sizeBuf, 0, 16, 0);
const pickleSize = sizeBuf.readUInt32LE(4); // pickle payload size
const jsonLen = sizeBuf.readUInt32LE(12); // header JSON byte length
const headerBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, headerBuf, 0, jsonLen, 16);
const header = JSON.parse(headerBuf.toString('utf8'));
const base = 8 + pickleSize; // first byte of file content

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child, p, out);
    else out.push({ path: p, size: Number(child.size ?? 0), offset: Number(child.offset ?? 0) });
  }
}

function findNode(inner) {
  const parts = inner.split('/').filter(Boolean);
  let node = header;
  for (const part of parts) {
    node = node.files?.[part];
    if (!node) return undefined;
  }
  return node;
}

if (cmd === 'list') {
  const out = [];
  const root = arg1 ? (() => {
    const n = findNode(arg1);
    return n ?? null;
  })() : header;
  if (!root) {
    console.error(`not found: ${arg1}`);
    process.exit(1);
  }
  walk(root, arg1 ?? '', out);
  for (const e of out) console.log(`${String(e.size).padStart(10)}  ${e.path}`);
} else if (cmd === 'read' || cmd === 'extract') {
  const node = findNode(arg1);
  if (!node || node.files) {
    console.error(`not a file: ${arg1}`);
    process.exit(1);
  }
  const size = Number(node.size);
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, base + Number(node.offset));
  if (cmd === 'read') process.stdout.write(buf);
  else {
    fs.mkdirSync(path.dirname(arg2), { recursive: true });
    fs.writeFileSync(arg2, buf);
    console.error(`extracted ${size} bytes -> ${arg2}`);
  }
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}
