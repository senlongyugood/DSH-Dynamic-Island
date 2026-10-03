// Mock of the DSH host snapshot endpoint, for exercising the overlay without the app.
// Usage: node mock-island-server.mjs [port] [scenario]
//   scenario: tasks (default) | empty | approval | many
import http from 'node:http';

const port = Number(process.argv[2] ?? 19391);
const scenario = process.argv[3] ?? 'tasks';
const now = () => Date.now();

const scenarios = {
  empty: () => ({ version: 1, generatedAt: now(), tasks: [] }),
  tasks: () => ({
    version: 1,
    generatedAt: now(),
    host: { pid: process.pid, url: 'http://127.0.0.1:19387' },
    tasks: [
      {
        id: 'session-demo-1',
        title: '给我看看这个项目，他现在识别不到 codex 当前的任务了',
        cwd: 'E:\\program_prject\\vscode_python_project\\神经网络与深度学习',
        running: true,
        startedAt: now() - 142000,
        updatedAt: now() - 1200,
        pending: {
          kind: 'approval',
          toolName: 'Bash',
          text: "May I send the app's existing test-only approval request outside the sandbox so it can reach Codex Island's local socket? The payload explicitly says no command will be executed.",
          since: now() - 32000
        },
        jobs: { running: 1 },
        children: 0
      },
      {
        id: 'session-demo-2',
        title: '',
        cwd: 'E:\\proj\\other',
        running: true,
        startedAt: now() - 9000,
        updatedAt: now() - 800,
        pending: null,
        jobs: { running: 0 },
        children: 2
      },
      {
        id: 'session-demo-3',
        title: '重构插件系统',
        cwd: 'E:\\proj\\demo',
        running: false,
        updatedAt: now() - 300000,
        pending: null,
        jobs: { running: 0 },
        children: 0
      }
    ]
  }),
  approval: () => {
    const base = scenarios.tasks();
    base.tasks = base.tasks.slice(0, 1);
    return base;
  },
  many: () => {
    const base = scenarios.tasks();
    for (let index = 0; index < 8; index += 1) {
      base.tasks.push({
        id: `session-bulk-${index}`,
        title: `批量任务 ${index + 1}：跑一遍数据清洗与特征工程`,
        cwd: 'E:\\proj\\bulk',
        running: true,
        updatedAt: now() - index * 4000,
        pending: null,
        jobs: { running: index % 3 },
        children: 0
      });
    }
    return base;
  }
};

const focusLog = [];

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type'
  };

  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors);
    response.end();
    return;
  }

  if (url.pathname === '/island' && request.method === 'GET') {
    const body = JSON.stringify((scenarios[scenario] ?? scenarios.tasks)());
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors });
    response.end(body);
    return;
  }

  if (url.pathname === '/focus' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      focusLog.push(body);
      console.log(`POST /focus ${body}`);
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
      response.end('{"ok":true}');
    });
    return;
  }

  if (url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...cors });
    response.end('ok');
    return;
  }

  response.writeHead(404, cors);
  response.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock island endpoint on http://127.0.0.1:${port}/island (scenario=${scenario})`);
});
