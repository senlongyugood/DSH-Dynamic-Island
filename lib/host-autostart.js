/**
 * Starts the desktop overlay when DSH comes up.
 *
 * The host half runs inside the DSH app, so loading this plugin is the moment to make sure the
 * overlay window exists: opening DSH is then all a user has to do. The check is deliberately
 * conservative — the overlay answers `/health` with a marker of its own, so an already running
 * island is detected (and left alone) instead of racing it for a port.
 *
 * Config (on the Loader row):
 *   autoStartOverlay  set false to never launch the overlay from here
 *   overlayPath       explicit path to DynamicIsland.exe
 *   overlayArgs       extra arguments for it
 *
 * @module dsh-plugin-dynamic-island/host-autostart
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Ports the overlay tries, matching its own probe order and the page's discovery. */
const OVERLAY_PORTS = [19391, 19392, 19393, 19394, 19395];
/** How long to wait after mounting before launching, so this plugin's own server is up first. */
const LAUNCH_DELAY_MS = 1200;

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** The packaged overlay, next to the host half's own directory. */
export function defaultOverlayPath() {
  return join(moduleDir, '..', 'overlay', 'DynamicIsland.exe');
}

/**
 * Arguments the overlay gets when this plugin launches it: the same shape start-island.cmd uses,
 * so an auto-started island behaves exactly like a manually started one (always visible, with a
 * status file and a log beside the executable).
 *
 * @param exe - Overlay executable path.
 * @returns the argument list.
 */
export function defaultOverlayArgs(exe) {
  const dir = dirname(exe);
  return [
    '--always-show',
    '--report', join(dir, 'island.state.txt'),
    '--log', join(dir, 'island.log')
  ];
}

/**
 * Ask one port whether the overlay is there. Only the overlay answers with its marker, so a
 * plain "ok" (the host endpoint) or a refused connection both mean "not the overlay".
 *
 * @param port - Loopback port to probe.
 * @param timeoutMs - How long to wait for an answer.
 * @returns the port when the overlay answered, else undefined.
 */
async function probeOverlay(port, timeoutMs = 400) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await response.text();
    return body.includes('overlay') ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find an overlay already listening on its usual ports.
 *
 * @param options - Optional settings bag.
 * @param options.ports - Ports to probe; defaults to the overlay's own probe order.
 * @returns the port it answers on, or undefined when it is not running.
 */
export async function findRunningOverlay({ ports = OVERLAY_PORTS } = {}) {
  for (const port of ports) {
    const found = await probeOverlay(port);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Ensure the desktop overlay is running, starting it detached when it is not.
 *
 * @param options - Settings bag.
 * @param options.overlayPath - Executable to launch.
 * @param options.args - Extra command line arguments.
 * @param options.ports - Ports probed for an already running overlay.
 * @param options.spawnProcess - Injection point for tests; defaults to node:child_process spawn.
 * @param options.log - Diagnostic sink.
 * @returns a short description of what happened, for tests and logs.
 */
export async function ensureOverlayRunning({
  overlayPath,
  args,
  ports,
  spawnProcess = spawn,
  log = () => {}
} = {}) {
  const running = await findRunningOverlay(ports === undefined ? {} : { ports });
  if (running !== undefined) {
    log(`overlay already running on port ${running}`);
    return { started: false, reason: 'already-running', port: running };
  }

  const exe = typeof overlayPath === 'string' && overlayPath.length > 0 ? overlayPath : defaultOverlayPath();
  if (!existsSync(exe)) {
    log(`overlay not found at ${exe}`);
    return { started: false, reason: 'missing', path: exe };
  }

  const extra = Array.isArray(args) ? args : [];
  const commandLine = extra.length > 0 ? extra : defaultOverlayArgs(exe);

  try {
    const child = spawnProcess(exe, commandLine, {
      detached: true,
      stdio: 'ignore',
      // Its own working directory keeps logs and settings beside the executable.
      cwd: dirname(exe),
      windowsHide: true
    });
    child.unref();
    log(`overlay launched (pid ${child.pid ?? 'unknown'}) with: ${commandLine.join(' ')}`);
    return { started: true, reason: 'launched', pid: child.pid };
  } catch (error) {
    log(`overlay launch failed: ${String(error)}`);
    return { started: false, reason: 'failed', error: String(error) };
  }
}

/**
 * Schedule the launch check shortly after startup and keep the timer from holding the app open.
 *
 * @param options - Settings bag; see {@link ensureOverlayRunning}.
 * @returns the timer handle (unref'ed).
 */
export function scheduleOverlayStart(options = {}) {
  const delay = Number.isFinite(options.delayMs) ? options.delayMs : LAUNCH_DELAY_MS;
  const timer = setTimeout(() => {
    void ensureOverlayRunning(options);
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
