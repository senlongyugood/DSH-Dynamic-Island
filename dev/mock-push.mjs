// Mock of the page's push payload, for exercising the overlay without the browser.
// POSTs one snapshot per second to the overlay's receiver, like the Harness page does.
// Usage: node mock-push.mjs [port] [scenario]
//   scenario: usage (default) | rows | approval | empty
const port = Number(process.argv[2] ?? 19409);
const scenario = process.argv[3] ?? 'usage';
const now = () => Date.now();

function usage(used, system, tools, messages) {
  return {
    usedTokens: used,
    contextWindow: 1000000,
    percent: Math.round((used / 1000000) * 100),
    systemTokens: system,
    toolsTokens: tools,
    messageTokens: messages
  };
}

function tasks() {
  switch (scenario) {
    case 'empty':
      return [];
    case 'rows':
      return Array.from({ length: 4 }, (_, index) => ({
        id: `row-${index}`,
        title: `批量任务 ${index + 1}：跑一遍数据清洗与特征工程`,
        cwd: 'E:\\proj\\bulk',
        running: index !== 3,
        updatedAt: now() - index * 5000,
        pending: null,
        usage: null,
        jobs: { running: index % 3 },
        children: 0
      }));
    case 'approval':
      return [{
        id: 'approval-task',
        title: '给我看看这个项目，他现在识别不到 codex 当前的任务了',
        cwd: 'E:\\proj\\demo',
        running: true,
        updatedAt: now() - 4000,
        pending: {
          kind: 'approval',
          toolName: 'Bash',
          text: "May I send the app's existing test-only approval request outside the sandbox so it can reach Codex Island's local socket? The payload explicitly says no command will be executed."
        },
        usage: usage(557032, 1491, 8032, 495062),
        jobs: { running: 1 },
        children: 1
      }];
    default:
      return [
        {
          id: 'session-live',
          title: '灵动岛任务展示插件',
          cwd: 'E:\\program_prject\\vscode_python_project\\神经网络与深度学习',
          running: true,
          updatedAt: now() - 3000,
          pending: null,
          usage: usage(557032, 1491, 8032, 495062),
          jobs: { running: 1 },
          children: 1
        },
        {
          id: 'session-done',
          title: 'You are researching the internal APIs',
          cwd: 'E:\\proj\\other',
          running: false,
          updatedAt: now() - 900000,
          pending: null,
          usage: usage(111703, 1491, 6652, 84580),
          jobs: { running: 0 },
          children: 0
        }
      ];
  }
}

async function push() {
  const payload = { version: 1, source: 'mock', generatedAt: now(), tasks: tasks() };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/island`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) console.error(`push failed: HTTP ${response.status}`);
  } catch (error) {
    console.error(`push failed: ${error.message}`);
  }
}

await push();
setInterval(() => { void push(); }, 1000);
console.log(`mock pushing "${scenario}" snapshots to http://127.0.0.1:${port}/island`);
