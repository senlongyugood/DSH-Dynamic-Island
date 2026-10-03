// Publishes a new host-half revision so a running Harness app picks up edited
// lib/impl.js without restarting: copies the implementation to a revision-named
// file and points lib/revision.json at it. Restart the Loader row afterwards
// (Plugin Manager enable/disable) so the shim re-runs apply().
//
// Usage: node reload-host.mjs [--keep <n>]
import { existsSync, readdirSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.resolve(here, '..', 'lib');
const implementation = path.join(libDir, 'impl.js');
const revisionFile = path.join(libDir, 'revision.json');

if (!existsSync(implementation)) throw new Error(`reload-host: missing ${implementation}`);

const keepArg = process.argv.indexOf('--keep');
const keep = keepArg === -1 ? 1 : Math.max(0, Number(process.argv[keepArg + 1] ?? 1));

let current = 0;
try {
  current = Number(JSON.parse(readFileSync(revisionFile, 'utf8')).revision) || 0;
} catch {
  current = 0;
}

const next = current + 1;
const target = path.join(libDir, `impl.${next}.js`);
copyFileSync(implementation, target);
writeFileSync(revisionFile, `${JSON.stringify({ revision: next, source: 'lib/impl.js', updatedAt: Date.now() }, null, 2)}\n`, 'utf8');

// Prune older revisions, keeping the requested number of previous ones.
const revisions = readdirSync(libDir)
  .map((name) => /^impl\.(\d+)\.js$/.exec(name))
  .filter(Boolean)
  .map((match) => Number(match[1]))
  .sort((left, right) => right - left);
for (const revision of revisions.slice(keep + 1)) {
  if (revision === next) continue;
  rmSync(path.join(libDir, `impl.${revision}.js`), { force: true });
}

console.log(`revision ${current} -> ${next}`);
console.log(`  published ${path.relative(process.cwd(), target)}`);
console.log(`  updated   ${path.relative(process.cwd(), revisionFile)}`);
console.log('Next: restart the "dynamic-island" Loader row (Plugin Manager enable/disable), then');
console.log('      check %USERPROFILE%\\.dsh\\dynamic-island.state.json for the new phase.');
