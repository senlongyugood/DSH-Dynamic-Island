// Deterministic component harness: a ~120-line React stand-in (createElement +
// the five hooks the island uses) that builds a host-node tree from the plugin's
// registered component, so the island's real logic can be exercised without a browser.
// Usage: node component-test.mjs
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');

//#region mini react
let current = null;
const pendingEffects = [];

function createElement(type, props, ...children) {
  const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
  return { __el: true, type, props: { ...(props ?? {}), children: flat } };
}

function slot(init) {
  const instance = current;
  const index = instance.index++;
  if (instance.hooks.length <= index) instance.hooks.push({ value: typeof init === 'function' ? init() : init });
  return instance.hooks[index];
}

function useState(init) {
  const state = slot(init);
  return [state.value, (next) => {
    state.value = typeof next === 'function' ? next(state.value) : next;
    scheduleRerender();
  }];
}
function useRef(init) {
  return slot({ current: init }).value;
}
function useMemo(factory) {
  return factory();
}
function useCallback(fn) {
  return fn;
}
function useEffect(fn) {
  slot(undefined);
  pendingEffects.push(fn);
}

const React = { createElement, useState, useRef, useMemo, useCallback, useEffect };

let rerender = () => {};
function scheduleRerender() {
  rerender();
}

/** Render one function component into a host-node tree, supporting re-renders through hooks. */
function mount(Component, props) {
  const instance = { hooks: [], index: 0 };
  let tree = null;
  const run = () => {
    current = instance;
    instance.index = 0;
    const out = Component(props);
    current = null;
    const effects = pendingEffects.splice(0, pendingEffects.length);
    for (const effect of effects) effect();
    return out;
  };
  rerender = () => { tree = run(); };
  tree = run();
  return { Component, props, get tree() { return tree; } };
}

/** Walk the tree, calling visit(node, ancestors) for every host node. */
function walk(node, visit, ancestors = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, ancestors);
    return;
  }
  if (!node.__el) throw new Error(`unexpected node: ${JSON.stringify(node)}`);
  if (typeof node.type === 'function') throw new Error('harness supports host nodes only below the root component');
  visit(node, ancestors);
  const { children } = node.props;
  if (children === undefined) return;
  for (const child of Array.isArray(children) ? children : [children]) walk(child, visit, [...ancestors, node]);
}

/** Flatten a host node's text content. */
function textOf(node) {
  let out = '';
  walk(node, (child) => {
    const { children } = child.props;
    if (typeof children === 'string' || typeof children === 'number') out += String(children);
  });
  return out;
}

/** Plain serialization used for failure messages. */
function serialize(node, depth = 0) {
  if (node === null) return `${'  '.repeat(depth)}(null)`;
  const { type, props } = node;
  const cls = props.className === undefined ? '' : ` class="${props.className}"`;
  const own = Array.isArray(props.children) ? '' : typeof props.children === 'string' || typeof props.children === 'number' ? String(props.children) : '';
  const lines = [`${'  '.repeat(depth)}<${type}${cls}>${own}`];
  const children = Array.isArray(props.children) ? props.children : [];
  for (const child of children) if (child && child.__el) lines.push(serialize(child, depth + 1));
  return lines.join('\n');
}
//#endregion

//#region load the plugin bundle
let registration;
globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value; } } };
await import(pathToFileURL(path.join(pluginRoot, 'lib', 'client.js')).href);
if (!registration || registration.id !== 'dsh-plugin-dynamic-island') throw new Error('bundle did not register');

const opened = [];
const module = registration.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});

let registered;
let dictionaries;
const effectLabels = [];
const bridgeRequests = [];
/** Fake endpoint set: the overlay answers health, island and focus. */
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  bridgeRequests.push({ url: target, method: init.method ?? "GET", body: init.body });
  if (target.endsWith("/health")) return { ok: true, status: 200, text: async () => "dynamic-island-overlay", json: async () => ({}) };
  if (target.endsWith("/island")) return { ok: true, status: 200, text: async () => "ok", json: async () => ({}) };
  if (target.endsWith("/focus")) return { ok: true, status: 200, json: async () => ({ sessionId: null }) };
  return { ok: false, status: 404, json: async () => ({}) };
};
const fakeCtx = {
  effect: (fn, label) => { effectLabels.push(label); fn(); return () => {}; },
  locale: {
    register: (ns, dicts) => { dictionaries = dicts; return () => {}; },
    resolveText: (value) => (typeof value === 'string' ? value : '')
  },
  slots: {
    inject: (key, callback) => { callback(); return () => {}; },
    register: (options, Component) => { registered = { options, Component }; return () => {}; }
  },
  uiWorkspace: { openSession: (id) => opened.push(id) }
};
module.apply(fakeCtx);
if (!registered) throw new Error('apply() registered nothing');
//#endregion

//#region environment stubs + assertions
let nextTimerId = 1;
const deferredTimers = new Map();
const liveIntervals = new Set();
globalThis.setInterval = () => {
  const id = nextTimerId++;
  liveIntervals.add(id);
  return id;
};
globalThis.clearInterval = (id) => { liveIntervals.delete(id); };
globalThis.setTimeout = (fn) => {
  const id = nextTimerId++;
  deferredTimers.set(id, fn);
  return id;
};
globalThis.clearTimeout = (id) => { deferredTimers.delete(id); };
/** Fire every deferred timeout once, as an elapsed delay would. */
function runTimers() {
  const callbacks = [...deferredTimers.values()];
  deferredTimers.clear();
  for (const callback of callbacks) callback();
}

const zhKeys = Object.keys(dictionaries.zh).sort();
const enKeys = Object.keys(dictionaries.en).sort();
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`zh/en key sets differ: zh-only=${zhKeys.filter((k) => !enKeys.includes(k))}, en-only=${enKeys.filter((k) => !zhKeys.includes(k))}`);
}
console.log(`OK  dictionaries: ${zhKeys.length} keys in both zh and en`);
console.log(`OK  registration: slot=${registered.options.name} id=${registered.options.id} order=${registered.options.order} locale=${registered.options.locale}`);
console.log(`OK  module face: inject=${JSON.stringify(module.inject)}`);
if (!effectLabels.includes("dynamic-island: dictionaries") || !effectLabels.includes("dynamic-island: desktop bridge")) {
  throw new Error(`apply() did not register the expected effects: ${JSON.stringify(effectLabels)}`);
}
console.log(`OK  effects: ${JSON.stringify(effectLabels)}`);

function translate(key, params) {
  const template = dictionaries.zh[key];
  if (template === undefined) throw new Error(`missing zh key: ${key}`);
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
}

const NOW = 1759489000000;
Date.now = () => NOW;

const list = {
  phase: 'ready',
  ids: ['s1', 's2', 's3', 's4'],
  byId: {
    s1: { id: 's1', title: '给我看看这个项目，他现在识别不到 codex 当前的任务了', cwd: 'E:\\proj\\demo', updatedAt: NOW - 42000 },
    s2: { id: 's2', title: '', cwd: 'E:\\proj\\other', updatedAt: NOW - 5000 },
    s3: { id: 's3', title: '重构插件系统', cwd: 'E:\\proj\\demo', updatedAt: NOW - 300000 },
    s4: { id: 's4', title: '已结束的会话', cwd: 'E:\\proj\\demo', updatedAt: NOW - 900000 }
  },
  // The same client-visible projections the shipped context meter reads.
  projectionsBySession: {
    s1: {
      values: {
        subagentCatalog: [{ id: 'child-1' }],
        contextPressure: { projectedTokens: 557032, contextWindow: 1000000 },
        contextBreakdown: { systemTokens: 1491, toolsTokens: 8032, messageTokens: 495062 }
      }
    },
    s2: {
      values: {
        contextPressure: { pressureTokens: 111703, contextWindow: 1000000 },
        contextBreakdown: { systemTokens: 1491, toolsTokens: 6652, messageTokens: 84580 }
      }
    }
  }
};

function mountIsland({ list: listValue = list, statuses, useSessions = true, useSessionStatus = true, jobs, watched, showInPage = true } = {}) {
  const props = {
    openSession: (id) => opened.push(id),
    resolveText: (value) => (typeof value === 'string' ? value : ''),
    // The shipped default is off (the island belongs on the desktop); these tests exercise the
    // in-page markup, so they opt in unless a case says otherwise.
    showInPage,
    t: translate
  };
  if (useSessions) props.useSessions = (selector) => selector(listValue);
  if (useSessionStatus) props.useSessionStatus = (selector) => selector(statuses);
  if (jobs !== undefined) props.useJobs = (selector) => selector(jobs);
  if (watched !== undefined) props.watchRows = (id) => { watched.push(id); return () => watched.push(`closed:${id}`); };
  return mount(registered.Component, props);
}

function findByClass(root, className) {
  let found;
  walk(root, (node) => {
    if (found === undefined && typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes(className)) found = node;
  });
  return found;
}

function findAllByClass(root, className) {
  const found = [];
  walk(root, (node) => {
    if (typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes(className)) found.push(node);
  });
  return found;
}

function check(label, condition, detail) {
  if (!condition) throw new Error(`FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  console.log(`OK  ${label}`);
}

// ---- idle: nothing running, nothing waiting, nothing recent ---------------
const staleList = {
  ...list,
  byId: {
    s1: { ...list.byId.s1, updatedAt: NOW - 3 * 3600 * 1000 },
    s2: { ...list.byId.s2, updatedAt: NOW - 4 * 3600 * 1000 },
    s3: { ...list.byId.s3, updatedAt: NOW - 5 * 3600 * 1000 },
    s4: { ...list.byId.s4, updatedAt: NOW - 6 * 3600 * 1000 }
  }
};
check('idle renders nothing', mountIsland({ list: staleList, statuses: new Map() }).tree === null);

// The island belongs on the desktop: without `showInPage` the page draws nothing at all. Checked
// here, before any other mount, because the test harness keys hook cells by mount order.
check('the shipped default draws nothing in the page', mountIsland({ statuses: new Map([['s2', { running: true }]]), showInPage: false }).tree === null);

// ---- a recently finished task is kept as history --------------------------
const history = mountIsland({ statuses: new Map() });
check('a recently finished task stays on the island', history.tree !== null);
const historyRows = findAllByClass(history.tree, 'DshIsland_row');
check('history lists the recent sessions, newest first', historyRows.length === 4, `rows=${historyRows.length}`);
check('history rows read as completed', historyRows.every((row) => findByClass(row, 'DshIsland_dotDone') !== undefined));

// ---- all states at once ---------------------------------------------------
const allStatuses = new Map([
  ['s1', { running: true, pendingInteraction: { kind: 'approval', toolName: 'Bash', displayReason: "May I send the app's existing test-only approval request outside the sandbox?" } }],
  ['s2', { running: true }],
  ['s3', { running: false, completionUnread: true }],
  ['s4', { running: false, completionUnread: false }]
]);
const island = mountIsland({ statuses: allStatuses });
check('busy renders the pill', findByClass(island.tree, 'DshIsland_pill') !== undefined);
const title = findByClass(island.tree, 'DshIsland_title');
check('collapsed label shows the pending task title', textOf(title) === '给我看看这个项目，他现在识别不到 codex 当前的任务了', textOf(title));
check('pending badge is 待批准', textOf(findByClass(island.tree, 'DshIsland_badge')) === '待批准');
check('running count chip shows 2 running tasks', textOf(findByClass(island.tree, 'DshIsland_count')) === '2');
check('collapsed pill starts closed', findByClass(island.tree, 'DshIsland_pillOpen') === undefined && findByClass(island.tree, 'DshIsland_chevronOpen') === undefined);
const rows = findAllByClass(island.tree, 'DshIsland_row');
check('actionable rows plus the recent finished one', rows.length === 4, `rows=${rows.length}`);
check('row order: pending, running, unread completion, history', rows.length === 4
  && textOf(findByClass(rows[0], 'DshIsland_rowTitle')).startsWith('给我看看')
  && textOf(findByClass(rows[1], 'DshIsland_rowTitle')) === 'other'
  && textOf(findByClass(rows[2], 'DshIsland_rowTitle')) === '重构插件系统'
  && textOf(findByClass(rows[3], 'DshIsland_rowTitle')) === '已结束的会话');
check('untitled running session falls back to its directory name', textOf(findByClass(rows[1], 'DshIsland_rowTitle')) === 'other');
check('request detail shows the approval reason', textOf(findByClass(island.tree, 'DshIsland_requestBody')).includes('test-only approval request'));
check('relative time is rendered', textOf(findByClass(rows[0], 'DshIsland_rowTime')) === '42 秒前更新', textOf(findByClass(rows[0], 'DshIsland_rowTime')));
check('danger-free idle row state text', textOf(findByClass(rows[2], 'DshIsland_rowState')) === '已完成');

// ---- hover expands --------------------------------------------------------
findByClass(island.tree, 'DshIsland_root').props.onPointerEnter();
check('pointer enter expands the pill', findByClass(island.tree, 'DshIsland_pillOpen') !== undefined);
check('expanded detail is visible', findByClass(island.tree, 'DshIsland_detailOpen') !== undefined);
check('chevron rotates', findByClass(island.tree, 'DshIsland_chevronOpen') !== undefined);
check('footer hint appears', textOf(findByClass(island.tree, 'DshIsland_footer')).includes('点击任务'));
findByClass(island.tree, 'DshIsland_root').props.onPointerLeave();
runTimers();
check('pointer leave collapses after the delay', findByClass(island.tree, 'DshIsland_pillOpen') === undefined);
findByClass(island.tree, 'DshIsland_root').props.onPointerEnter();
findByClass(island.tree, 'DshIsland_root').props.onPointerLeave();
findByClass(island.tree, 'DshIsland_root').props.onPointerEnter();
runTimers();
check('re-entering cancels the pending collapse', findByClass(island.tree, 'DshIsland_pillOpen') !== undefined);

// ---- click actions --------------------------------------------------------
const expanded = mountIsland({ statuses: allStatuses });
findByClass(expanded.tree, 'DshIsland_root').props.onPointerEnter();
findByClass(expanded.tree, 'DshIsland_row').props.onClick();
check('clicking a row opens that session', opened[opened.length - 1] === 's1', JSON.stringify(opened));
check('clicking a row collapses the pill', findByClass(expanded.tree, 'DshIsland_pillOpen') === undefined);

const escapeTest = mountIsland({ statuses: allStatuses });
escapeTest.tree && findByClass(escapeTest.tree, 'DshIsland_compact').props.onKeyDown({ key: 'Enter', preventDefault() {} });
check('Enter pins the island open', findByClass(escapeTest.tree, 'DshIsland_pillOpen') !== undefined);
findByClass(escapeTest.tree, 'DshIsland_compact').props.onKeyDown({ key: 'Escape' });
check('Escape collapses the island', findByClass(escapeTest.tree, 'DshIsland_pillOpen') === undefined);

// ---- alternate shapes -----------------------------------------------------
check('missing standard kit renders nothing', mountIsland({ list: undefined, statuses: undefined, useSessions: false, useSessionStatus: false }).tree === null);
const recordShape = mountIsland({ statuses: { s1: { running: true, pendingInteraction: { kind: 'question', questions: [{ question: '要继续吗？' }] } } } });
check('plain-record status snapshot is tolerated', textOf(findByClass(recordShape.tree, 'DshIsland_badge')) === '待回答');
check('question text reaches the request card', textOf(findByClass(recordShape.tree, 'DshIsland_requestBody')) === '要继续吗？');
const planShape = mountIsland({ statuses: new Map([['s2', { running: true, pendingInteraction: { kind: 'plan-review', questions: [{ header: '计划确认' }] } }]]) });
check('plan review badge', textOf(findByClass(planShape.tree, 'DshIsland_badge')) === '待确认');
check('untitled pending row shows its directory fallback', textOf(findByClass(planShape.tree, 'DshIsland_title')) === 'other', textOf(findByClass(planShape.tree, 'DshIsland_title')));
const doneOnly = mountIsland({ list: staleList, statuses: new Map([['s3', { running: false, completionUnread: true }]]) });
check('completion-only state shows the completed label', textOf(findByClass(doneOnly.tree, 'DshIsland_title')) === '1 个任务已完成', textOf(findByClass(doneOnly.tree, 'DshIsland_title')));
check('unknown pending kind is ignored', mountIsland({ list: staleList, statuses: new Map([['s3', { running: false, pendingInteraction: { kind: 'mystery' } }]]) }).tree === null);

console.log('\nALL COMPONENT CASES PASSED');

// ---- desktop bridge: the page pushes what it renders ----------------------
const flush = async () => { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve)); };

const watched = [];
const jobsState = { rows: { s1: [{ id: 'j1', status: 'running' }], s2: [] } };
await flush();
check('the bridge probes the overlay health endpoint', bridgeRequests.some((call) => call.url === 'http://127.0.0.1:19391/health'), JSON.stringify(bridgeRequests.map((call) => call.url)));

bridgeRequests.length = 0;
const bridged = mountIsland({ statuses: allStatuses, jobs: jobsState, watched });
await flush();
runTimers();
await flush();
const push = bridgeRequests.filter((call) => call.method === 'POST' && call.url.endsWith('/island')).pop();
check('the bridge pushes a snapshot to the overlay', push !== undefined, JSON.stringify(bridgeRequests.map((call) => `${call.method} ${call.url}`)));
const pushed = JSON.parse(push.body);
check('the pushed snapshot mirrors the rendered rows', pushed.tasks.length === 4, `tasks=${pushed.tasks.length}`);
check('the pushed history row is a finished task', pushed.tasks[3].id === 's4' && pushed.tasks[3].running === false && pushed.tasks[3].pending === null, JSON.stringify(pushed.tasks[3]));
const pushedFirst = pushed.tasks[0];
check('the pushed task carries its id and title', pushedFirst.id === 's1' && pushedFirst.title.startsWith('给我看看'), JSON.stringify(pushedFirst));
check('the pushed task carries its cwd', pushedFirst.cwd === 'E:\\proj\\demo');
check('the pushed approval keeps its kind and text', pushedFirst.pending.kind === 'approval' && pushedFirst.pending.text.includes('test-only approval request'), JSON.stringify(pushedFirst.pending));
check('the pushed task reports its running background jobs', pushedFirst.jobs.running === 1, JSON.stringify(pushedFirst.jobs));
const pushedUsage = pushedFirst.usage;
check('the pushed task carries its context usage', pushedUsage !== null && pushedUsage !== undefined, JSON.stringify(pushedUsage));
check('the usage percent matches used/window', pushedUsage.percent === 56, JSON.stringify(pushedUsage));
check('the usage carries the token breakdown', pushedUsage.systemTokens === 1491 && pushedUsage.toolsTokens === 8032 && pushedUsage.messageTokens === 495062, JSON.stringify(pushedUsage));
check('pressureTokens is accepted as a fallback numerator', pushed.tasks[1].usage.usedTokens === 111703, JSON.stringify(pushed.tasks[1].usage));
check('a session without the projection reports no usage', pushed.tasks[2].usage === null, JSON.stringify(pushed.tasks[2].usage));
check('the bridge opens a job roster per visible session', watched.includes('s1') && watched.includes('s2') && watched.includes('s3'), JSON.stringify(watched));
check('the bridge also polls the focus queue', bridgeRequests.some((call) => call.url.endsWith('/focus')));
check('the in-page pill stands down while the desktop overlay is live', bridged.tree === null);

// Losing the overlay brings the in-page pill back.
const offlineFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
for (let attempt = 0; attempt < 4; attempt += 1) { runTimers(); await flush(); }
check('losing the overlay restores the in-page pill', bridged.tree !== null);
globalThis.fetch = offlineFetch;
mountIsland({ statuses: allStatuses, jobs: jobsState, watched: [] });
await flush();
runTimers();
await flush();

// A page with nothing to report (nothing running and nothing recent) still pushes an empty task
// list, so the overlay can hide itself.
bridgeRequests.length = 0;
mountIsland({ list: staleList, statuses: new Map(), jobs: jobsState, watched: [] });
await flush();
runTimers();
await flush();
const idlePush = bridgeRequests.filter((call) => call.method === 'POST' && call.url.endsWith('/island')).pop();
check('an idle page pushes an empty task list', JSON.parse(idlePush.body).tasks.length === 0);

// A click on the overlay is turned into navigation by the page.
bridgeRequests.length = 0;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  bridgeRequests.push({ url: target, method: init.method ?? 'GET' });
  if (target.endsWith('/health')) return { ok: true, status: 200, text: async () => 'dynamic-island-overlay', json: async () => ({}) };
  if (target.endsWith('/island')) return { ok: true, status: 200, text: async () => 'ok', json: async () => ({}) };
  if (target.endsWith('/focus')) return { ok: true, status: 200, json: async () => ({ sessionId: 's3' }) };
  return { ok: false, status: 404, json: async () => ({}) };
};
opened.length = 0;
mountIsland({ statuses: allStatuses });
await flush();
runTimers();
await flush();
check('a desktop click opens the requested session', opened.includes('s3'), JSON.stringify(opened));

console.log('\nALL DESKTOP BRIDGE CASES PASSED');
