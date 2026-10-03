// Exercises the host-side snapshot endpoint in isolation (no DSH app needed).
// Usage: node server-test.mjs
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startIslandEndpoint } from '../lib/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const discoveryPath = path.join(here, 'server-test-discovery.json');

function check(label, condition, detail) {
  if (!condition) throw new Error(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  console.log(`OK  ${label}`);
}

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const call = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
      }
    );
    call.on('error', reject);
    if (payload !== undefined) call.write(payload);
    call.end();
  });
}

let collectCalls = 0;
const endpoint = await startIslandEndpoint({
  port: 19401,
  discoveryPath,
  log: (message) => console.log(`   [log] ${message}`),
  collect: () => {
    collectCalls += 1;
    return { version: 1, generatedAt: Date.now(), tasks: [{ id: 's1', title: '测试任务', running: true }] };
  }
});

check('endpoint bound on the requested port', endpoint.port === 19401, String(endpoint.port));
check('discovery file written', existsSync(discoveryPath));
const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'));
check('discovery carries the port and url', discovery.port === 19401 && discovery.url.endsWith('/island'), JSON.stringify(discovery));

const island = await request(endpoint.port, 'GET', '/island');
check('GET /island answers 200 JSON', island.status === 200 && island.headers['content-type'].includes('application/json'));
check('GET /island returns the collected snapshot', JSON.parse(island.text).tasks[0].title === '测试任务');
check('GET /island calls the collector', collectCalls === 1, String(collectCalls));
check('CORS allows the page to read it', island.headers['access-control-allow-origin'] === '*');

const health = await request(endpoint.port, 'GET', '/health');
check('GET /health answers ok', health.status === 200 && health.text === 'ok');

const preflight = await request(endpoint.port, 'OPTIONS', '/focus');
check('OPTIONS answers 204 with CORS', preflight.status === 204 && preflight.headers['access-control-allow-methods'].includes('POST'));

const emptyFocus = await request(endpoint.port, 'GET', '/focus');
check('GET /focus is empty before any request', JSON.parse(emptyFocus.text).sessionId === null);

const posted = await request(endpoint.port, 'POST', '/focus', { sessionId: 'session-abc' });
check('POST /focus accepts a session id', posted.status === 200 && JSON.parse(posted.text).queued === true);

const taken = await request(endpoint.port, 'GET', '/focus');
check('GET /focus returns the queued session', JSON.parse(taken.text).sessionId === 'session-abc');
const drained = await request(endpoint.port, 'GET', '/focus');
check('the queue clears after one read', JSON.parse(drained.text).sessionId === null);

const malformed = await request(endpoint.port, 'POST', '/focus', undefined);
check('POST /focus without a body does not queue', JSON.parse(malformed.text).queued === false);

const missing = await request(endpoint.port, 'GET', '/nope');
check('unknown routes answer 404', missing.status === 404);

// A collector that throws must not break the endpoint.
const throwing = await startIslandEndpoint({
  port: 19402,
  discoveryPath: path.join(here, 'server-test-discovery-2.json'),
  log: () => {},
  collect: () => { throw new Error('boom'); }
});
const survived = await request(throwing.port, 'GET', '/island');
check('a throwing collector still answers', survived.status === 200 && JSON.parse(survived.text).tasks.length === 0);
await throwing.stop();

// Port collisions walk to the next free port.
const collided = await startIslandEndpoint({
  port: 19401,
  discoveryPath: path.join(here, 'server-test-discovery-3.json'),
  log: () => {},
  collect: () => ({ version: 1, generatedAt: Date.now(), tasks: [] })
});
check('a busy port falls through to the next one', collided.port === 19402, String(collided.port));
await collided.stop();

await endpoint.stop();
check('stop removes the discovery file', !existsSync(discoveryPath));
check('the plugin root is untouched', existsSync(path.join(pluginRoot, 'lib', 'client.js')));

console.log('\nALL ENDPOINT CASES PASSED');
