// Validates the host-side snapshot collector against fake DSH services.
// Usage: node collect-test.mjs
import { createCollector, localizedText } from '../lib/collect.js';

function check(label, condition, detail) {
  if (!condition) throw new Error(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  console.log(`OK  ${label}`);
}

const NOW = 1760000000000;
let clock = NOW;
Date.now = () => clock;

/** Build a fake host context out of explicit service objects. */
function makeCtx(options = {}) {
  const agents = options.agents ?? [];
  const sessions = options.sessions ?? new Map();
  const projections = options.projections ?? new Map();
  const jobs = options.jobs ?? new Map();
  const services = {
    agents: options.noAgents
      ? undefined
      : {
        list: () => agents,
        roots: () => (options.roots === undefined ? agents.filter((agent) => String(agent.id).startsWith('s')) : options.roots),
        get: (id) => agents.find((agent) => String(agent.id) === String(id))
      },
    sessions: options.noSessions ? undefined : { get: (id) => sessions.get(String(id)) },
    sessionProjections: options.noProjections
      ? undefined
      : { snapshot: (session, keys) => ({ asOfSeq: session.seq ?? 0, values: projections.get(String(session.id)) ?? {} }) },
    jobs: options.noJobs ? undefined : { list: (id) => jobs.get(String(id)) ?? [] }
  };
  return { get: (name) => services[name] };
}

function sessionOf(id, cwd, seq = 10) {
  return { id, seq, header: { id, cwd, createdAt: NOW - 60000 } };
}

// ---- 1. running agents, titles, jobs, subagents ---------------------------
{
  const sessions = new Map([['s1', sessionOf('s1', 'E:\\proj\\demo')], ['s2', sessionOf('s2', 'E:\\proj\\other')]]);
  const projections = new Map([
    ['s1', {
      title: '给我看看这个项目',
      sessionListMetadata: { lastPromptAt: NOW - 42000 },
      subagentCatalog: [{ id: 'child-1', label: 'sub' }, { id: 'child-2' }]
    }],
    ['s2', { title: '另一个任务', subagentCatalog: [] }]
  ]);
  const jobs = new Map([
    ['s1', [{ id: 'j1', kind: 'pwsh', status: 'running', progress: 'npm install' }, { id: 'j2', kind: 'bash', status: 'completed' }]],
    ['s2', []]
  ]);
  const ctx = makeCtx({
    agents: [
      { id: 's1', status: 'running' },
      { id: 's2', status: 'running' },
      { id: 'child-1', status: 'running' },
      { id: 's3', status: 'idle' }
    ],
    sessions,
    projections,
    jobs
  });
  const collector = createCollector(ctx);
  const snapshot = collector.snapshot();

  check('snapshot reports its version', snapshot.version === 1);
  check('idle sessions without a notice are omitted', snapshot.tasks.length === 2, JSON.stringify(snapshot.tasks.map((task) => task.id)));
  const first = snapshot.tasks.find((task) => task.id === 's1');
  check('running task carries its title', first.title === '给我看看这个项目', first.title);
  check('running task carries its cwd', first.cwd === 'E:\\proj\\demo');
  check('running task is marked running', first.running === true);
  check('turn start is captured', first.startedAt === NOW, String(first.startedAt));
  check('last-prompt time becomes updatedAt', first.updatedAt === NOW - 42000, String(first.updatedAt));
  check('only running jobs are reported', first.jobs.running === 1 && first.jobs.items.length === 1 && first.jobs.items[0].id === 'j1', JSON.stringify(first.jobs));
  check('running subagents are counted', first.children === 1, String(first.children));
  check('no pending interaction while merely running', first.pending === null);

  // Repeated snapshots from the same collector keep the original turn start.
  clock = NOW + 30000;
  const later = collector.snapshot();
  check('the turn clock survives repeated polling', later.tasks.find((task) => task.id === 's1').startedAt === NOW, String(later.tasks.find((task) => task.id === 's1').startedAt));
}

// ---- 2. approval observation is non-consuming and self-clearing -----------
{
  const ctx = makeCtx({
    agents: [{ id: 's1', status: 'running' }],
    sessions: new Map([['s1', sessionOf('s1', 'E:\\proj\\demo')]]),
    projections: new Map([['s1', { title: '审批演示' }]])
  });
  const collector = createCollector(ctx);

  let nextCalls = 0;
  let release;
  const continuation = new Promise((resolve) => { release = resolve; });
  const returned = collector.observeApproval(
    {
      agent: { id: 's1' },
      toolName: 'Bash',
      reason: 'escalate sandbox to danger-full-access: installer needs registry access',
      displayReason: { en: 'Allow this operation with danger-full-access permissions', zh: '允许本次操作使用 danger-full-access 权限' }
    },
    () => { nextCalls += 1; return continuation; }
  );

  check('the waterfall continuation runs (the shipped UI still answers)', nextCalls === 1, String(nextCalls));
  const pending = collector.snapshot().tasks.find((task) => task.id === 's1').pending;
  check('pending approval is reported', pending !== null && pending.kind === 'approval', JSON.stringify(pending));
  check('approval text prefers the Chinese display reason', pending.text === '允许本次操作使用 danger-full-access 权限', pending.text);
  check('approval carries the tool name', pending.toolName === 'Bash');

  release('allowed-once');
  await returned;
  check('the approval clears once the request settles', collector.snapshot().tasks.find((task) => task.id === 's1').pending === null);
  check('the collector reports no pending approvals', collector.pendingApprovalCount() === 0);
}

// ---- 3. abort signal clears an abandoned approval -------------------------
{
  const controller = new AbortController();
  const ctx = makeCtx({ agents: [{ id: 's1', status: 'running' }], sessions: new Map([['s1', sessionOf('s1', 'E:\\x')]]) });
  const collector = createCollector(ctx);
  collector.observeApproval({ agent: { id: 's1' }, toolName: 'pwsh', signal: controller.signal }, () => new Promise(() => {}));
  check('approval is pending while the signal is live', collector.pendingApprovalCount() === 1);
  controller.abort();
  check('aborting the request clears it', collector.pendingApprovalCount() === 0);
}

// ---- 4. user questions come from the session projection -------------------
{
  const ctx = makeCtx({
    agents: [{ id: 's1', status: 'running' }],
    sessions: new Map([['s1', sessionOf('s1', 'E:\\proj\\demo')]]),
    projections: new Map([['s1', {
      title: '提问演示',
      userQuestions: {
        active: [
          { callId: 'call-1', state: 'continued', questions: [{ question: '旧问题' }] },
          { callId: 'call-2', state: 'open', questions: [{ header: '请选择', question: '要继续吗？' }] }
        ],
        settled: []
      }
    }]])
  });
  const collector = createCollector(ctx);
  const pending = collector.snapshot().tasks.find((task) => task.id === 's1').pending;
  check('an open question becomes the pending interaction', pending !== null && pending.kind === 'question', JSON.stringify(pending));
  check('the question text is carried', pending.text === '要继续吗？', pending.text);
}

// ---- 5. completion window -------------------------------------------------
{
  let agents = [{ id: 's1', status: 'running' }];
  const ctx = makeCtx({
    agents,
    sessions: new Map([['s1', sessionOf('s1', 'E:\\proj\\demo')]]),
    projections: new Map([['s1', { title: '完成演示' }]])
  });
  const collector = createCollector(ctx);
  collector.snapshot();
  check('running session is listed', collector.snapshot().tasks.length === 1);

  agents = [{ id: 's1', status: 'idle' }];
  ctx.get = (name) => (name === 'agents' ? { list: () => agents, get: () => agents[0] } : { get: () => undefined }[name]);
  clock = NOW + 1000;

  const finished = collector.snapshot();
  check('a finished session stays visible as completed', finished.tasks.length === 1 && finished.tasks[0].running === false, JSON.stringify(finished.tasks));
  check('the completed row keeps its title', finished.tasks[0].title === '完成演示', finished.tasks[0].title);

  // The agent disappears entirely; the notice survives until its window closes.
  const gone = createCollector(makeCtx({ agents: [], sessions: new Map(), projections: new Map() }));
  clock = NOW + 11 * 60 * 1000;
  check('an unrelated collector has nothing to show', gone.snapshot().tasks.length === 0);
  check('the completion window has expired', collector.snapshot().tasks.length === 0, JSON.stringify(collector.snapshot().tasks));
}

// ---- 6. missing services degrade instead of throwing ----------------------
{
  const bare = createCollector(makeCtx({ noAgents: true, noSessions: true, noProjections: true, noJobs: true }));
  const snapshot = bare.snapshot();
  check('a context without services yields an empty snapshot', Array.isArray(snapshot.tasks) && snapshot.tasks.length === 0);
}

// ---- 7. text resolution ---------------------------------------------------
{
  check('plain strings pass through', localizedText('hello') === 'hello');
  check('zh wins in a locale map', localizedText({ en: 'Allow', zh: '允许' }) === '允许');
  check('en is the fallback', localizedText({ en: 'Allow' }) === 'Allow');
  check('unknown locales fall back to any string', localizedText({ fr: 'Autoriser' }) === 'Autoriser');
  check('empty values resolve to empty text', localizedText(null) === '' && localizedText(undefined) === '' && localizedText(42) === '');
}

console.log('\nALL COLLECTOR CASES PASSED');
