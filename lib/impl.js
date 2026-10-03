/**
 * Host half of the Dynamic Island plugin.
 *
 * Publishes a live task snapshot on a loopback HTTP endpoint for the desktop
 * overlay window (`overlay/DynamicIsland.exe`), and accepts the overlay's
 * click-to-open requests, which the browser half turns back into navigation.
 *
 * The whole host half is observation plus a loopback socket:
 *   - it never activates, resumes, or mutates a session;
 *   - it watches `approval/request` without consuming it, so the shipped UI
 *     still answers every request;
 *   - it listens on 127.0.0.1 only.
 *
 * Config (all optional, set on the Loader row):
 *   port              first port to try (default 19391; the next free one wins)
 *   discoveryPath     where to announce the endpoint (default ~/.dsh/dynamic-island.json)
 *   autoStartOverlay  launch overlay/DynamicIsland.exe when DSH comes up (default true)
 *   overlayPath       explicit overlay executable, e.g. built somewhere else
 *   enabled           set false to keep the plugin mounted but silent
 *
 * @module dsh-plugin-dynamic-island
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createCollector, defaultDiscoveryPath } from './collect.js';
import { startIslandEndpoint } from './server.js';
import { scheduleOverlayStart } from './host-autostart.js';

/** First loopback port tried for the snapshot endpoint. */
const DEFAULT_PORT = 19391;

/**
 * Record where the host half got to, next to the discovery file. A running app
 * caches ES modules by URL, so this is the only way to tell "the row restarted
 * with the new code" apart from "the endpoint failed to start".
 */
function writeState(discoveryPath, state) {
  if (typeof discoveryPath !== 'string' || discoveryPath.length === 0) return;
  try {
    writeFileSync(
      join(dirname(discoveryPath), 'dynamic-island.state.json'),
      `${JSON.stringify({ ...state, pid: process.pid, at: Date.now() }, null, 2)}\n`,
      'utf8'
    );
  } catch {
    /* diagnostics are best-effort */
  }
}

/**
 * Mount the snapshot endpoint and the approval observer.
 *
 * @param ctx - Host plugin context (the profile's Cordis root or a scope of it).
 * @param config - Optional row config; see the module doc.
 */
export function apply(ctx, config) {
  const settings = config ?? {};
  if (settings.enabled === false) return;

  const discoveryPath = typeof settings.discoveryPath === 'string' && settings.discoveryPath.length > 0
    ? settings.discoveryPath
    : defaultDiscoveryPath();

  const logger = (message) => {
    try {
      ctx.logger?.('dynamic-island')?.debug?.(message);
    } catch {
      /* logging must never break the plugin */
    }
  };

  writeState(discoveryPath, { phase: 'mounted', module: 'lib/index.js' });

  const collector = createCollector(ctx, logger);

  // Approval observation only: the request is recorded for the snapshot and the waterfall is
  // passed straight on, so the shipped UI stays the one and only answerer. The island reports
  // that an approval is waiting; it never decides one.
  ctx.effect(
    () => ctx.on('approval/request', (request, next) => collector.observeApproval(request, next)),
    'dynamic-island: approval observer'
  );

  // The loopback endpoint the desktop overlay polls.
  ctx.effect(() => {
    let stopped = false;
    let endpoint;
    writeState(discoveryPath, { phase: 'starting', port: settings.port ?? DEFAULT_PORT });

    const starting = startIslandEndpoint({
      port: Number.isInteger(settings.port) ? settings.port : DEFAULT_PORT,
      discoveryPath,
      collect: () => collector.snapshot(),
      log: logger
    }).then(
      (started) => {
        if (stopped) {
          void started.stop();
          return undefined;
        }
        endpoint = started;
        writeState(discoveryPath, { phase: 'ready', port: started.port, url: `http://127.0.0.1:${started.port}/island` });
        logger(`snapshot endpoint on http://127.0.0.1:${started.port}/island`);
        return started;
      },
      (error) => {
        writeState(discoveryPath, { phase: 'error', error: String(error) });
        logger(`snapshot endpoint failed to start: ${String(error)}`);
        return undefined;
      }
    );

    return async () => {
      stopped = true;
      const started = endpoint ?? (await starting);
      await started?.stop();
      writeState(discoveryPath, { phase: 'stopped' });
    };
  }, 'dynamic-island: snapshot endpoint');

  // Opening DSH is meant to be enough: make sure the desktop overlay is up too. It runs as its
  // own detached process, so it is not tied to this app's lifetime, and an already running one
  // is detected through its own /health marker instead of being started twice.
  if (settings.autoStartOverlay !== false) {
    ctx.effect(
      () => {
        const timer = scheduleOverlayStart({
          overlayPath: settings.overlayPath,
          args: Array.isArray(settings.overlayArgs) ? settings.overlayArgs : [],
          log: logger
        });
        return () => clearTimeout(timer);
      },
      'dynamic-island: overlay autostart'
    );
  }
}
