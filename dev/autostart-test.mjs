/**
 * Checks the host half's "opening DSH starts the island" logic.
 *
 * Everything here is exercised without touching a real overlay: the port probe runs against a
 * throwaway HTTP server, and the launch path is given an injected spawn. The rule under test is
 * the one that matters in practice — an island that already answers with its own marker must never
 * be started a second time, while a port that answers something else (the host's own endpoint says
 * "ok") must not be mistaken for it.
 */
import { createServer } from 'node:http';
import {
  defaultOverlayArgs,
  defaultOverlayPath,
  ensureOverlayRunning,
  findRunningOverlay
} from '../lib/host-autostart.js';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`OK  ${label}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

/** Serve one canned /health body until stopped. */
function serve(body) {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const overlayServer = await serve('dynamic-island-overlay');
const otherServer = await serve('ok');

try {
  // ---- packaged paths ------------------------------------------------------
  const exe = defaultOverlayPath();
  check('the packaged overlay path points at overlay/DynamicIsland.exe',
    /overlay[\\/]DynamicIsland\.exe$/.test(exe), exe);
  const args = defaultOverlayArgs(exe);
  check('launch arguments keep the island always visible', args.includes('--always-show'), args.join(' '));
  check('launch arguments write a status file and a log',
    args.includes('--report') && args.includes('--log'), args.join(' '));

  // ---- probing -------------------------------------------------------------
  const found = await findRunningOverlay({ ports: [otherServer.port, overlayServer.port] });
  check('an island is found by its own health marker', found === overlayServer.port, String(found));
  const notFound = await findRunningOverlay({ ports: [otherServer.port] });
  check('a host endpoint answering "ok" is not mistaken for the island', notFound === undefined, String(notFound));
  const nothing = await findRunningOverlay({ ports: [] });
  check('probing no port reports nothing running', nothing === undefined, String(nothing));

  // ---- already running is left alone ---------------------------------------
  const already = await ensureOverlayRunning({
    ports: [overlayServer.port],
    overlayPath: exe,
    spawnProcess: () => { throw new Error('should not spawn'); }
  });
  check('an island that is already up is not started twice',
    already.started === false && already.reason === 'already-running' && already.port === overlayServer.port,
    JSON.stringify(already));

  // ---- missing executable is reported, not thrown --------------------------
  const missing = await ensureOverlayRunning({ ports: [], overlayPath: 'E:/definitely/not/here.exe' });
  check('a missing overlay executable is reported', missing.started === false && missing.reason === 'missing',
    JSON.stringify(missing));

  // ---- launching uses the always-show argument set -------------------------
  const launches = [];
  const launched = await ensureOverlayRunning({
    ports: [],
    overlayPath: exe,
    spawnProcess: (file, argv, options) => {
      launches.push({ file, argv, options });
      return { pid: 4321, unref() {} };
    }
  });
  check('a missing island is launched detached so it outlives DSH',
    launched.started === true && launched.pid === 4321, JSON.stringify(launched));
  check('the launch is detached and silent',
    launches.length === 1 && launches[0].options.detached === true && launches[0].options.stdio === 'ignore',
    JSON.stringify(launches[0]?.options));
  check('the launched island runs beside its own executable',
    launches.length === 1 && launches[0].options.cwd === exe.replace(/[\\/][^\\/]+$/, ''),
    launches[0]?.options?.cwd);
  check('the launch carries the always-show argument set',
    launches.length === 1 && launches[0].argv.includes('--always-show'), (launches[0]?.argv ?? []).join(' '));
} finally {
  overlayServer.server.close();
  otherServer.server.close();
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nALL OVERLAY AUTOSTART CASES PASSED');
