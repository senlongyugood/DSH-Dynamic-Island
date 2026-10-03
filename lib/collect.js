/**
 * Host-side task snapshot for the desktop Dynamic Island overlay.
 *
 * Everything here is observation only: it reads the live Agent registry, Session
 * headers and projections, and the background-job registry, and it watches the
 * `approval/request` waterfall without consuming it (the shipped UI still answers
 * every request). No session is activated, resumed, or modified.
 *
 * The overlay only cares about work a person should notice:
 *   - every live Agent that is currently running,
 *   - every pending approval or user question,
 *   - a short "just finished" window so a completion is visible.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** How long a finished session stays on the island as "completed". */
const COMPLETED_TTL_MS = 10 * 60 * 1000;
/** Projection keys read for each interesting session. */
const PROJECTION_KEYS = ['title', 'userQuestions', 'subagentCatalog', 'sessionListMetadata'];
/** User-question states that are still waiting for the user. */
const OPEN_QUESTION_STATES = ['open'];

/** Default discovery file the overlay reads to find this endpoint. */
export function defaultDiscoveryPath() {
  return join(homedir(), '.dsh', 'dynamic-island.json');
}

/** Run a reader that may fail because an optional service or session is missing. */
function safe(read, fallback) {
  try {
    const value = read();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/** Render a text value that may be a plain string or a `{ locale: text }` descriptor. */
export function localizedText(value, preferred = ['zh', 'zh-CN', 'en']) {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return '';
  for (const key of preferred) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  for (const candidate of Object.values(value)) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return '';
}

/** First question text of one pending question batch. */
function firstQuestionText(questions) {
  if (!Array.isArray(questions)) return '';
  for (const item of questions) {
    const text = localizedText(item?.question);
    if (text.length > 0) return text;
    const header = localizedText(item?.header);
    if (header.length > 0) return header;
  }
  return '';
}

/** The active pending question of a `userQuestions` projection, if any. */
function activeQuestion(projection) {
  const active = projection?.active;
  if (!Array.isArray(active)) return null;
  for (const entry of active) {
    const state = typeof entry?.state === 'string' ? entry.state : 'open';
    if (!OPEN_QUESTION_STATES.includes(state)) continue;
    return {
      callId: entry?.callId === undefined ? undefined : String(entry.callId),
      text: firstQuestionText(entry?.questions)
    };
  }
  return null;
}

/**
 * Build the snapshot reader bound to one Host context.
 *
 * @param ctx - Host plugin context.
 * @param log - diagnostic sink.
 * @returns `{ observeApproval, recordApproval, snapshot, pendingApprovalCount }`.
 */
export function createCollector(ctx, log = () => {}) {
  /** sessionId -> pending approval record observed on the waterfall. */
  const approvals = new Map();
  /** sessionId -> { at, title, cwd } for sessions that finished recently. */
  const completed = new Map();
  /** sessionId -> turn start timestamp for the elapsed display. */
  const started = new Map();
  /** sessionId -> last known display fields, so a completion notice keeps its title. */
  const known = new Map();

  /**
   * Record one approval request so the snapshot can show it, without answering it.
   *
   * The caller owns the waterfall: `impl.js` races the island's click against the shipped
   * answerers and clears the record when either side settles.
   *
   * @param request - The `approval/request` payload.
   * @returns `{ sessionId, callId, record, clear }`, or undefined for an unusable payload.
   */
  function recordApproval(request) {
    const agentId = request?.agent?.id;
    const sessionId = agentId === undefined || agentId === null ? undefined : String(agentId);
    if (sessionId === undefined) return undefined;

    const record = {
      kind: 'approval',
      sessionId,
      toolName: typeof request?.toolName === 'string' ? request.toolName : '',
      callId: request?.callId === undefined || request.callId === null ? undefined : String(request.callId),
      text: localizedText(request?.displayReason) || localizedText(request?.reason),
      since: Date.now()
    };
    approvals.set(sessionId, record);

    const clear = () => {
      if (approvals.get(sessionId) === record) approvals.delete(sessionId);
    };
    return { sessionId, callId: record.callId, record, clear };
  }

  /**
   * Observe one approval request without answering it: record it, then pass the
   * waterfall on and clear the record when the request settles or aborts.
   */
  function observeApproval(request, next) {
    const observed = recordApproval(request);
    if (observed === undefined) return next();

    const signal = request?.signal;
    if (signal !== undefined && signal !== null) {
      if (signal.aborted === true) {
        observed.clear();
        return next();
      }
      safe(() => signal.addEventListener('abort', observed.clear, { once: true }));
    }

    // `next()` reaches the shipped UI (which answers); the record clears once the
    // whole continuation settles, whichever way it went.
    return Promise.resolve(safe(() => next(), undefined)).finally(observed.clear);
  }

  /** Read the projection values this snapshot needs for one session. */
  function projectionsFor(sessionId, sessions, projections) {
    if (sessions === undefined || projections === undefined) return {};
    const session = safe(() => sessions.get(sessionId), undefined);
    if (session === undefined) return {};
    return safe(() => projections.snapshot(session, PROJECTION_KEYS).values, {}) ?? {};
  }

  /** Count the subagents of one session that are running right now. */
  function runningChildren(catalog, agents) {
    if (!Array.isArray(catalog) || agents === undefined) return 0;
    let count = 0;
    for (const child of catalog) {
      const childId = child?.id ?? child?.sessionId;
      if (childId === undefined) continue;
      if (safe(() => agents.get(String(childId))?.status, undefined) === 'running') count += 1;
    }
    return count;
  }

  /** Read the running background jobs of one session. */
  function jobsFor(sessionId, jobs) {
    if (jobs === undefined) return { running: 0, items: [] };
    const rows = safe(() => jobs.list(sessionId), []) ?? [];
    const items = [];
    let running = 0;
    for (const job of rows) {
      const status = typeof job?.status === 'string' ? job.status : '';
      const live = status === 'running' || status === 'stopping';
      if (!live) continue;
      running += 1;
      items.push({
        id: job?.id === undefined ? '' : String(job.id),
        kind: typeof job?.kind === 'string' ? job.kind : '',
        label: localizedText(job?.label) || localizedText(job?.kind),
        status,
        progress: localizedText(job?.progress) || localizedText(job?.detail)
      });
    }
    return { running, items: items.slice(0, 5) };
  }

  /**
   * The still-visible completion notice of one session, pruning it once its window
   * has closed so an expired notice is never emitted even once.
   */
  function completionFor(sessionId, now) {
    const record = completed.get(sessionId);
    if (record === undefined) return undefined;
    if (now - record.at > COMPLETED_TTL_MS) {
      completed.delete(sessionId);
      return undefined;
    }
    return record;
  }

  /** Assemble the current snapshot. */
  function snapshot() {
    const agents = ctx.get?.('agents');
    const sessions = ctx.get?.('sessions');
    const projections = ctx.get?.('sessionProjections');
    const jobs = ctx.get?.('jobs');
    const now = Date.now();
    const tasks = [];
    const live = new Set();

    for (const agent of safe(() => agents?.roots?.() ?? agents?.list(), []) ?? []) {
      const id = agent?.id === undefined ? undefined : String(agent.id);
      if (id === undefined) continue;
      live.add(id);

      const running = agent.status === 'running';
      const approval = approvals.get(id);
      // Projections are only folded for sessions the island actually shows; the last
      // known title/cwd is remembered so a completion notice keeps its title after
      // the session stops being interesting.
      const interesting = running || approval !== undefined;
      const values = interesting ? projectionsFor(id, sessions, projections) : {};
      const question = running ? activeQuestion(values.userQuestions) : null;
      const session = safe(() => sessions?.get(id), undefined);
      const headerCwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : '';
      const previous = known.get(id);
      const title = localizedText(values.title) || (previous === undefined ? '' : previous.title);
      const cwd = headerCwd.length > 0 ? headerCwd : (previous === undefined ? '' : previous.cwd);
      if (interesting) known.set(id, { title, cwd });

      if (running && !started.has(id)) started.set(id, now);
      if (!running && started.has(id)) {
        completed.set(id, { at: now, title, cwd });
        started.delete(id);
        known.delete(id);
      }

      const pending = approval !== undefined
        ? { kind: 'approval', toolName: approval.toolName, callId: approval.callId, text: approval.text || (approval.toolName.length > 0 ? `工具 ${approval.toolName} 请求授权` : ''), since: approval.since }
        : question !== null
          ? { kind: 'question', text: question.text, since: now }
          : null;

      const finished = completionFor(id, now);
      if (!running && pending === null && finished === undefined) continue;

      const jobInfo = jobsFor(id, jobs);
      const lastPromptAt = Number(values.sessionListMetadata?.lastPromptAt);
      tasks.push({
        id,
        title: title.length > 0 ? title : (finished?.title ?? ''),
        cwd: cwd.length > 0 ? cwd : (finished?.cwd ?? ''),
        running,
        startedAt: started.get(id) ?? 0,
        updatedAt: Number.isFinite(lastPromptAt) && lastPromptAt > 0 ? lastPromptAt : (finished?.at ?? now),
        pending,
        jobs: jobInfo,
        children: runningChildren(values.subagentCatalog, agents)
      });
    }

    // Sessions that finished and are no longer live keep their completion notice
    // until the window closes.
    for (const [id, info] of [...completed]) {
      if (now - info.at > COMPLETED_TTL_MS) {
        completed.delete(id);
        continue;
      }
      if (live.has(id)) continue;
      tasks.push({
        id,
        title: info.title,
        cwd: info.cwd,
        running: false,
        startedAt: 0,
        updatedAt: info.at,
        pending: null,
        jobs: { running: 0, items: [] },
        children: 0
      });
    }

    return { version: 1, generatedAt: now, tasks };
  }

  return {
    observeApproval,
    recordApproval,
    snapshot,
    pendingApprovalCount: () => approvals.size,
    log
  };
}
