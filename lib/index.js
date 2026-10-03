/**
 * Host half of the Dynamic Island plugin — the package's Loader entry.
 *
 * The Loader row points at `./boot.js`, which loads the current implementation
 * revision; this module keeps `main` honest for anyone importing the package.
 * See `boot.js` for why the indirection exists.
 *
 * @module dsh-plugin-dynamic-island
 */
export { apply } from './boot.js';
