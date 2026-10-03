/**
 * Local snapshot endpoint for the desktop Dynamic Island overlay.
 *
 * The overlay is a separate always-on-top window with no access to DSH internals,
 * so the host plugin publishes the task snapshot here over loopback HTTP and
 * receives click-to-open requests back. Nothing is exposed beyond 127.0.0.1.
 *
 * Routes
 *   GET  /island   current snapshot as JSON
 *   GET  /health   "ok"
 *   GET  /focus    take the queued session id (cleared by reading it), or null
 *   POST /focus    queue a session id for the open page to navigate to
 *
 * Every response carries permissive CORS headers: the Harness page itself polls
 * /focus from a different origin.
 */
import http from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** How many consecutive ports to try before giving up. */
const PORT_ATTEMPTS = 8;

/** CORS headers shared by every route so the Harness page can read /focus. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Cache-Control': 'no-store'
};

/**
 * Start the loopback snapshot endpoint.
 *
 * @param options - port candidates, discovery file path, snapshot reader, logger.
 * @returns the running endpoint: `port`, `publish`, and an async `stop`.
 */
export async function startIslandEndpoint(options) {
  const { discoveryPath, collect, log = () => {} } = options;
  const firstPort = Number.isInteger(options.port) && options.port > 0 ? options.port : 19391;

  let snapshot = { version: 1, generatedAt: Date.now(), tasks: [] };
  let focusRequest = null;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS);
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/island') {
      try {
        snapshot = collect();
      } catch (error) {
        log(`snapshot collection failed: ${String(error)}`);
      }
      sendJson(response, 200, snapshot);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      response.writeHead(200, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('ok');
      return;
    }

    if (url.pathname === '/focus' && request.method === 'GET') {
      const sessionId = focusRequest;
      focusRequest = null;
      sendJson(response, 200, { sessionId });
      return;
    }

    if (url.pathname === '/focus' && request.method === 'POST') {
      readBody(request, (body) => {
        const sessionId = typeof body?.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : null;
        if (sessionId !== null) focusRequest = sessionId;
        sendJson(response, 200, { ok: true, queued: sessionId !== null });
      });
      return;
    }

    response.writeHead(404, CORS);
    response.end();
  });

  let port = firstPort;
  let bound = false;
  for (let attempt = 0; attempt < PORT_ATTEMPTS && !bound; attempt += 1) {
    port = firstPort + attempt;
    bound = await tryListen(server, port);
  }
  if (!bound) throw new Error(`dynamic-island: no free port in ${firstPort}..${firstPort + PORT_ATTEMPTS - 1}`);

  writeDiscovery(discoveryPath, port, log);

  return {
    port,
    publish(next) {
      snapshot = next;
    },
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()));
      try {
        rmSync(discoveryPath, { force: true });
      } catch {
        /* the discovery file is advisory: a failed removal must not break shutdown */
      }
    }
  };
}

/** Attempt one bind; a busy port resolves false instead of throwing. */
function tryListen(server, port) {
  return new Promise((resolve) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') resolve(false);
      else resolve(false);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/** Announce the endpoint so the overlay can find it without configuration. */
function writeDiscovery(discoveryPath, port, log) {
  if (typeof discoveryPath !== 'string' || discoveryPath.length === 0) return;
  try {
    mkdirSync(dirname(discoveryPath), { recursive: true });
    writeFileSync(
      discoveryPath,
      `${JSON.stringify({ port, url: `http://127.0.0.1:${port}/island`, pid: process.pid, updatedAt: Date.now() }, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    log(`could not write the discovery file ${discoveryPath}: ${String(error)}`);
  }
}

/** Read and parse a small JSON request body, tolerating an empty or malformed one. */
function readBody(request, done) {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 64 * 1024) request.destroy();
  });
  request.on('end', () => {
    try {
      done(body.length === 0 ? {} : JSON.parse(body));
    } catch {
      done(undefined);
    }
  });
  request.on('error', () => done(undefined));
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value ?? null);
  response.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  response.end(body);
}
