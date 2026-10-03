/**
 * Stable Loader-row entry point for the Dynamic Island host half.
 *
 * A running Harness app caches ES modules by URL, and the Loader row's URL is
 * fixed by the profile patch — so editing the implementation would otherwise
 * need a full app restart. This shim is intentionally tiny and never changes:
 * it reads `revision.json` and imports the matching `impl.<revision>.js`, which
 * a new revision makes a brand-new URL that Node imports fresh.
 *
 * `revision: 0` (or a missing file) loads `./impl.js`, the checked-in
 * implementation, which is also what a freshly started app uses.
 *
 * @module dsh-plugin-dynamic-island/host
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The currently published implementation revision; 0 means `./impl.js`. */
function currentRevision() {
  try {
    const parsed = JSON.parse(readFileSync(join(here, 'revision.json'), 'utf8'));
    const value = Number(parsed?.revision);
    return Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Load the current implementation and run it.
 *
 * @param ctx - Host plugin context.
 * @param config - Loader row config, passed straight through.
 */
export async function apply(ctx, config) {
  const revision = currentRevision();
  const candidates = revision > 0 ? [`./impl.${revision}.js`, './impl.js'] : ['./impl.js'];
  let missing;
  for (const candidate of candidates) {
    try {
      const module = await import(new URL(candidate, import.meta.url).href);
      return await module.apply(ctx, config);
    } catch (error) {
      // Only a missing revision file falls back; a real failure inside the
      // implementation must surface instead of running twice.
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      missing = error;
    }
  }
  throw missing;
}
