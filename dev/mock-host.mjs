/**
 * A stand-in for the host half, for testing the island's approval buttons.
 *
 * It serves the snapshot the overlay polls (with one task waiting for approval), accepts the
 * `POST /approval` the island sends when Allow / Deny is clicked, and prints what it received so a
 * test can assert the exact decision. `/health` answers `ok` — that is what the real host half
 * says, and the overlay must therefore treat this endpoint as the host, not as another overlay.
 *
 * Usage: node mock-host.mjs [port] [--not-pending]
 *
 * `--not-pending` answers every click the way a real bridge answers an approval it never saw (one
 * asked before the plugin loaded): the island must then explain itself instead of offering a button
 * that does nothing.
 */
import { createServer } from 'node:http';

const cliArgs = process.argv.slice(2);
const notPending = cliArgs.includes('--not-pending');
const port = Number(cliArgs.find((arg) => /^\d+$/.test(arg)) ?? 19441);
const received = [];

function snapshot() {
  const now = Date.now();
  return {
    version: 1,
    generatedAt: now,
    tasks: [
      {
        id: 'session-approval',
        title: '等你批准的构建任务',
        cwd: 'E:\\proj\\approval',
        running: true,
        startedAt: now - 60_000,
        updatedAt: now - 2_000,
        pending: {
          kind: 'approval',
          toolName: 'Bash',
          callId: 'call-42',
          text: 'May I run the release build outside the sandbox?'
        },
        jobs: { running: 0, items: [] },
        children: 0
      },
      {
        id: 'session-other',
        title: '另一个在跑的任务',
        cwd: 'E:\\proj\\other',
        running: true,
        startedAt: now - 30_000,
        updatedAt: now - 1_000,
        pending: null,
        jobs: { running: 0, items: [] },
        children: 0
      }
    ]
  };
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const send = (payload, type = 'application/json') => {
      response.writeHead(200, { 'content-type': type });
      response.end(type === 'application/json' ? JSON.stringify(payload) : payload);
    };

    if (request.url === '/health') return send('ok', 'text/plain');
    if (request.url === '/island') return send(snapshot());
    if (request.url === '/focus') return send({ sessionId: null });
    if (request.url === '/approval' && request.method === 'POST') {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { parsed = { parseError: body }; }
      received.push(parsed);
      // Written where the test can read it without another channel.
      console.log(`APPROVAL ${JSON.stringify(parsed)}`);
      if (notPending) return send({ ok: false, reason: 'not-pending' });
      return send({ ok: true, key: `${parsed.sessionId}|${parsed.callId ?? ''}` });
    }
    response.writeHead(404);
    response.end();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock host listening on http://127.0.0.1:${port} (receiving approvals)`);
});
