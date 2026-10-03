// Boots the real host half (lib/index.js) against a fake Cordis context, then
// exercises the live loopback endpoint it publishes.
// Usage: node host-half-test.mjs
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, readFileSync, rmSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const discoveryPath = path.join(here, 'host-half-discovery.json');

function check(label, condition, detail) {
  if (!condition) throw new Error(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  console.log(`OK  ${label}`);
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    }).on('error', reject);
  });
}

rmSync(discoveryPath, { force: true });

// ---- fake Cordis context --------------------------------------------------
const listeners = new Map();
const effects = [];
const logs = [];
const sessions = new Map([['session-live', { id: 'session-live', seq: 12, header: { id: 'session-live', cwd: 'E:\\program_prject\\demo' } }]]);
const projections = new Map([['session-live', { title: '桌面灵动岛联调', sessionListMetadata: { lastPromptAt: Date.now() - 3000 } }]]);
const agents = [{ id: 'session-live', status: 'running' }];
const services = {
  agents: { roots: () => agents, list: () => agents, get: (id) => agents.find((agent) => agent.id === id) },
  sessions: { get: (id) => sessions.get(id) },
  sessionProjections: { snapshot: (session) => ({ asOfSeq: session.seq, values: projections.get(session.id) ?? {} }) },
  jobs: { list: () => [{ id: 'job-1', kind: 'pwsh', status: 'running', progress: 'npm run build' }] }
};
const ctx = {
  get: (name) => services[name],
  on: (event, listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    return () => listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener));
  },
  effect: (callback, label) => {
    const dispose = callback();
    effects.push({ label, dispose });
    return dispose;
  },
  logger: () => ({ debug: (message) => logs.push(message), warn: (message) => logs.push(message) })
};

// ---- mount ---------------------------------------------------------------
const module = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'index.js')).href);
check('the host half exports apply()', typeof module.apply === 'function');
// The package entry re-exports the boot shim, which loads the implementation
// revision asynchronously — exactly as the Loader awaits it.
await module.apply(ctx, { port: 19411, discoveryPath, autoStartOverlay: false });
check('autoStartOverlay: false keeps the overlay out of it', effects.length === 2 && !effects.some((effect) => effect.label === 'dynamic-island: overlay autostart'),
  JSON.stringify(effects.map((effect) => effect.label)));
check('an approval listener is installed', (listeners.get('approval/request') ?? []).length === 1);

// ---- discovery + snapshot ------------------------------------------------
for (let attempt = 0; attempt < 40 && !existsSync(discoveryPath); attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
check('the endpoint announces itself', existsSync(discoveryPath));
const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'));
check('discovery carries the bound port', discovery.port === 19411, JSON.stringify(discovery));

const snapshot = JSON.parse((await get(19411, '/island')).text);
check('the snapshot lists the running session', snapshot.tasks.length === 1 && snapshot.tasks[0].id === 'session-live', JSON.stringify(snapshot));
check('the snapshot carries the live title', snapshot.tasks[0].title === '桌面灵动岛联调', snapshot.tasks[0].title);
check('the snapshot carries the cwd', snapshot.tasks[0].cwd === 'E:\\program_prject\\demo');
check('the snapshot counts running jobs', snapshot.tasks[0].jobs.running === 1, JSON.stringify(snapshot.tasks[0].jobs));

// ---- approval leg --------------------------------------------------------
const approvalListener = listeners.get('approval/request')[0];
let nextCalls = 0;
let answerApproval;
const pendingAnswer = new Promise((resolve) => { answerApproval = resolve; });
const returned = approvalListener(
  { agent: { id: 'session-live' }, toolName: 'pwsh', displayReason: { zh: '允许本次操作？', en: 'Allow this operation?' } },
  () => { nextCalls += 1; return pendingAnswer; }
);
check('the shipped continuation still runs', nextCalls === 1);
const withApproval = JSON.parse((await get(19411, '/island')).text);
check('the approval shows up in the snapshot', withApproval.tasks[0].pending?.kind === 'approval', JSON.stringify(withApproval.tasks[0].pending));
check('the approval text is localized', withApproval.tasks[0].pending.text === '允许本次操作？', withApproval.tasks[0].pending.text);
answerApproval('approved');
await returned;
const afterApproval = JSON.parse((await get(19411, '/island')).text);
check('the approval clears after settling', afterApproval.tasks[0].pending === null);

// ---- browser bridge ------------------------------------------------------
const focusPost = await new Promise((resolve, reject) => {
  const payload = JSON.stringify({ sessionId: 'session-other' });
  const request = http.request(
    { host: '127.0.0.1', port: 19411, path: '/focus', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
    (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); }
  );
  request.on('error', reject);
  request.write(payload);
  request.end();
});
check('the overlay can queue a click-to-open request', focusPost === 200, String(focusPost));
check('the page reads it back once', JSON.parse((await get(19411, '/focus')).text).sessionId === 'session-other');
check('and the queue is empty afterwards', JSON.parse((await get(19411, '/focus')).text).sessionId === null);

// ---- teardown ------------------------------------------------------------
for (const effect of effects) await effect.dispose?.();
check('disposal removes the discovery file', !existsSync(discoveryPath));

// ---- the overlay autostart can be turned off -----------------------------
// The second mount keeps the real default (launching the packaged exe would be a side effect a
// test must not have), so it points at a missing executable: the effect still registers, and the
// "missing overlay" branch is what runs.
const secondEffects = [];
const secondCtx = { ...ctx, effect: (callback, label) => { const dispose = callback(); secondEffects.push({ label, dispose }); return dispose; } };
const secondDiscovery = path.join(os.tmpdir(), `dsh-island-host-${process.pid}-b.json`);
await module.apply(secondCtx, { port: 19412, discoveryPath: secondDiscovery, overlayPath: path.join(os.tmpdir(), 'dsh-island-not-built.exe'), autoStartOverlay: true });
check('autoStartOverlay defaults to on', secondEffects.length === 3 && secondEffects.some((effect) => effect.label === 'dynamic-island: overlay autostart'),
  JSON.stringify(secondEffects.map((effect) => effect.label)));
for (const effect of secondEffects) await effect.dispose?.();

console.log('\nALL HOST-HALF CASES PASSED');
