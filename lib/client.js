/**
 * Browser half of the Dynamic Island plugin.
 *
 * Registers one `shell.overlay` entry: a frame-wide pill pinned to the top
 * center of the window. Idle (nothing running, nothing waiting) it renders
 * nothing at all. While tasks are running - or an approval / question / plan
 * review is waiting for the user - it shows a compact Dynamic-Island style
 * pill; moving the pointer onto it expands the pill into a detail card.
 *
 * Data comes exclusively from the standard slot kit of `shell.overlay`
 * (`useSessions` for the session catalog, `useSessionStatus` for the live
 * running / pending-interaction / completion state), so the entry holds no
 * transport state of its own.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-dynamic-island",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;

		/** Locale namespace registered with the Client locale service. */
		const NS = "dynamicIsland";
		/** Pending-interaction kinds the Session status can carry. */
		const PENDING_KINDS = ["approval", "question", "plan-review"];
		/** How long a finished session stays on the island before it ages out (30 minutes). */
		const RETAIN_DONE_MS = 30 * 60 * 1000;
		/** Most finished sessions kept at once, newest first. */
		const MAX_RETAINED = 6;
		/** Stable no-op hook used when a standard source is unavailable, so hook order never changes. */
		const NO_SOURCE = () => undefined;
		/** How long the pointer may leave the island before it collapses again. */
		const COLLAPSE_DELAY_MS = 220;
		/** Longest request preview kept in the expanded card. */
		const REQUEST_PREVIEW_CHARS = 600;

		//#region styles
		const css = `
.DshIsland_root {
	position: fixed;
	top: 6px;
	left: 50%;
	transform: translateX(-50%);
	z-index: 60;
	pointer-events: auto;
	display: flex;
	justify-content: center;
	font-size: 12px;
	line-height: 1.4;
	color: #f2f3f5;
	-webkit-font-smoothing: antialiased;
}

.DshIsland_pill {
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	width: max-content;
	max-width: min(420px, calc(100vw - 24px));
	max-height: 34px;
	padding: 5px 12px;
	border-radius: 17px;
	background: rgba(12, 12, 14, 0.92);
	box-shadow:
		0 10px 30px rgba(0, 0, 0, 0.34),
		inset 0 0 0 0.5px rgba(255, 255, 255, 0.08);
	backdrop-filter: blur(18px) saturate(140%);
	-webkit-backdrop-filter: blur(18px) saturate(140%);
	transition:
		max-height 260ms cubic-bezier(0.22, 1, 0.36, 1),
		border-radius 260ms cubic-bezier(0.22, 1, 0.36, 1),
		padding 260ms cubic-bezier(0.22, 1, 0.36, 1),
		box-shadow 200ms ease;
}

.DshIsland_pillOpen {
	max-height: min(460px, calc(100vh - 40px));
	padding: 8px 10px 10px;
	border-radius: 20px;
	box-shadow:
		0 18px 44px rgba(0, 0, 0, 0.44),
		inset 0 0 0 0.5px rgba(255, 255, 255, 0.1);
}

.DshIsland_compact {
	display: flex;
	align-items: center;
	gap: 8px;
	height: 24px;
	padding: 0 2px;
	flex: none;
	cursor: pointer;
	outline: none;
}

.DshIsland_compact:focus-visible {
	box-shadow: 0 0 0 2px rgba(77, 139, 255, 0.65);
	border-radius: 8px;
}

.DshIsland_title {
	max-width: 230px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-weight: 500;
	letter-spacing: 0.1px;
}

.DshIsland_titleMuted {
	color: rgba(242, 243, 245, 0.66);
	font-weight: 400;
}

.DshIsland_count {
	flex: none;
	min-width: 16px;
	height: 16px;
	padding: 0 5px;
	border-radius: 8px;
	background: rgba(255, 255, 255, 0.14);
	color: rgba(242, 243, 245, 0.92);
	font-size: 10px;
	font-weight: 600;
	display: inline-flex;
	align-items: center;
	justify-content: center;
}

.DshIsland_badge {
	flex: none;
	display: inline-flex;
	align-items: center;
	height: 18px;
	padding: 0 7px;
	border-radius: 9px;
	font-size: 10px;
	font-weight: 600;
	letter-spacing: 0.2px;
	background: rgba(255, 159, 10, 0.18);
	color: #ffb340;
}

.DshIsland_chevron {
	flex: none;
	color: rgba(242, 243, 245, 0.45);
	transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
}

.DshIsland_chevronOpen {
	transform: rotate(180deg);
}

.DshIsland_dot {
	position: relative;
	flex: none;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: currentColor;
}

.DshIsland_dotRunning { color: #4d8bff; }
.DshIsland_dotWarning { color: #ff9f0a; }
.DshIsland_dotDone { color: #32d74b; }
.DshIsland_dotIdle { color: #8e8e93; }

.DshIsland_dotRunning::after,
.DshIsland_dotWarning::after {
	content: "";
	position: absolute;
	inset: -3px;
	border-radius: 50%;
	background: currentColor;
	opacity: 0.5;
	animation: DshIsland_pulse 1.6s cubic-bezier(0.22, 1, 0.36, 1) infinite;
}

@keyframes DshIsland_pulse {
	0% { transform: scale(0.55); opacity: 0.5; }
	70% { transform: scale(1.7); opacity: 0; }
	100% { transform: scale(1.7); opacity: 0; }
}

.DshIsland_detail {
	display: flex;
	flex-direction: column;
	width: min(400px, calc(100vw - 44px));
	min-height: 0;
	opacity: 0;
	transition: opacity 180ms ease 60ms;
}

.DshIsland_detailOpen { opacity: 1; }

.DshIsland_divider {
	height: 1px;
	margin: 6px 2px 2px;
	background: rgba(255, 255, 255, 0.09);
	flex: none;
}

.DshIsland_sectionLabel {
	padding: 6px 4px 4px;
	color: rgba(242, 243, 245, 0.45);
	font-size: 10px;
	font-weight: 600;
	letter-spacing: 0.4px;
	text-transform: uppercase;
	flex: none;
}

.DshIsland_rows {
	display: flex;
	flex-direction: column;
	gap: 1px;
	max-height: min(240px, calc(100vh - 240px));
	overflow-y: auto;
	overscroll-behavior: contain;
	flex: none;
}

.DshIsland_row {
	display: flex;
	align-items: flex-start;
	gap: 9px;
	width: 100%;
	padding: 7px 8px;
	border: 0;
	border-radius: 12px;
	background: transparent;
	color: inherit;
	text-align: left;
	font: inherit;
	cursor: pointer;
	transition: background 120ms ease;
}

.DshIsland_row:hover,
.DshIsland_row:focus-visible {
	background: rgba(255, 255, 255, 0.08);
	outline: none;
}

.DshIsland_rowDot { margin-top: 5px; }

.DshIsland_rowMain {
	display: flex;
	flex-direction: column;
	gap: 1px;
	min-width: 0;
	flex: 1;
}

.DshIsland_rowTitle {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-weight: 500;
}

.DshIsland_rowSub {
	color: rgba(242, 243, 245, 0.52);
	font-size: 11px;
	display: flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
}

.DshIsland_rowState {
	flex: none;
	color: rgba(242, 243, 245, 0.78);
}

.DshIsland_rowTime {
	flex: none;
	color: rgba(242, 243, 245, 0.4);
	font-variant-numeric: tabular-nums;
}

.DshIsland_request {
	margin: 4px 4px 0;
	padding: 8px 10px;
	border-radius: 12px;
	background: rgba(255, 159, 10, 0.1);
	box-shadow: inset 0 0 0 0.5px rgba(255, 159, 10, 0.24);
	flex: none;
}

.DshIsland_requestHead {
	display: flex;
	align-items: center;
	gap: 6px;
	color: #ffb340;
	font-size: 10px;
	font-weight: 600;
	letter-spacing: 0.4px;
	text-transform: uppercase;
}

.DshIsland_requestBody {
	margin-top: 5px;
	max-height: 108px;
	overflow-y: auto;
	overscroll-behavior: contain;
	color: rgba(242, 243, 245, 0.86);
	font-size: 11.5px;
	line-height: 1.5;
	white-space: pre-wrap;
	word-break: break-word;
}

.DshIsland_footer {
	padding: 7px 4px 0;
	color: rgba(242, 243, 245, 0.35);
	font-size: 10px;
	flex: none;
}

.DshIsland_scroll::-webkit-scrollbar { width: 6px; }

.DshIsland_scroll::-webkit-scrollbar-thumb {
	background: rgba(255, 255, 255, 0.16);
	border-radius: 3px;
}
`;
		const tagId = "dsh-plugin-dynamic-island/DynamicIsland.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-dynamic-island";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region derives
		/** Read one session status out of the status snapshot (a Map, tolerated as a plain record). */
		function statusOf(statuses, sessionId) {
			if (statuses === undefined || statuses === null) return undefined;
			if (typeof statuses.get === "function") return statuses.get(sessionId);
			return statuses[sessionId];
		}

		/** Interpret a timestamp that may arrive as a number or an ISO string. */
		function timeOf(value) {
			if (typeof value === "number" && Number.isFinite(value)) return value;
			if (typeof value === "string") {
				const parsed = Date.parse(value);
				if (Number.isFinite(parsed)) return parsed;
			}
			return undefined;
		}

		/** Last path segment of a working directory, used when a session has no title yet. */
		function baseName(cwd) {
			if (typeof cwd !== "string" || cwd.length === 0) return "";
			const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
			return parts[parts.length - 1] ?? "";
		}

		/**
		 * Project the session catalog plus its live status map onto the rows the
		 * island shows: everything running or waiting for the user, waiting first,
		 * then running, then recently finished work.
		 *
		 * Finished sessions are kept for a while (RETAIN_DONE_MS) instead of vanishing the
		 * moment the next task starts, so the island reads as a short history the user clears
		 * with each row's ×. Old sessions fall out on their own, and the list is capped so the
		 * card cannot grow without bound.
		 */
		function deriveRows(list, statuses) {
			const ids = Array.isArray(list?.ids) ? list.ids : [];
			const byId = list?.byId ?? {};
			const rows = [];
			const retained = [];
			const now = Date.now();
			for (const id of ids) {
				const status = statusOf(statuses, id);
				const summary = byId[id] ?? {};
				const running = status?.running ?? summary.running ?? false;
				const pending = status?.pendingInteraction;
				const kind = PENDING_KINDS.includes(pending?.kind) ? pending.kind : undefined;
				const done = status?.completionUnread === true;
				const updatedAt = timeOf(summary.updatedAt);
				const displayTitle = typeof summary.displayTitle === "string" ? summary.displayTitle.trim() : "";
				const rawTitle = displayTitle.length > 0 ? displayTitle : (typeof summary.title === "string" ? summary.title.trim() : "");
				if (!running && kind === undefined && !done) {
					// Kept only if the session was touched recently, so a finished task stays
					// visible until its row is removed (or it ages out).
					const fresh = updatedAt > 0 && now - updatedAt <= RETAIN_DONE_MS;
					if (fresh) {
						retained.push({
							id,
							title: rawTitle,
							fallbackTitle: baseName(summary.cwd) || String(id),
							updatedAt,
							running: false,
							done: true,
							kind: undefined,
							pending: undefined,
							rank: 3
						});
					}
					continue;
				}
				rows.push({
					id,
					title: rawTitle,
					fallbackTitle: baseName(summary.cwd) || String(id),
					updatedAt,
					running,
					done,
					kind,
					pending,
					rank: kind !== undefined ? 0 : running ? 1 : 2
				});
			}
			retained.sort((left, right) => right.updatedAt - left.updatedAt);
			rows.sort((left, right) => left.rank - right.rank);
			for (const row of retained.slice(0, MAX_RETAINED)) rows.push(row);
			return rows;
		}

		/** Stable dot class for one row state; pending outranks running outranks done. */
		function dotClass(row) {
			if (row === undefined) return "DshIsland_dot DshIsland_dotIdle";
			if (row.kind !== undefined) return "DshIsland_dot DshIsland_dotWarning";
			if (row.running) return "DshIsland_dot DshIsland_dotRunning";
			if (row.done) return "DshIsland_dot DshIsland_dotDone";
			return "DshIsland_dot DshIsland_dotIdle";
		}

		/** One-line state label for a row. */
		function stateLabel(row, t) {
			if (row.kind === "approval") return t("status.approval");
			if (row.kind === "question") return t("status.question");
			if (row.kind === "plan-review") return t("status.plan");
			if (row.running) return t("status.running");
			if (row.done) return t("status.done");
			return t("status.idle");
		}

		/** Resolve a possibly locale-descriptor text into the active language. */
		function readText(value, resolveText) {
			if (typeof value === "string") return value;
			if (value === undefined || value === null) return "";
			try {
				const resolved = typeof resolveText === "function" ? resolveText(value) : "";
				return typeof resolved === "string" ? resolved : "";
			} catch {
				return "";
			}
		}

		/** Human text of a pending request: the approval reason, or the first question. */
		function requestText(pending, resolveText, t) {
			if (pending === undefined || pending === null) return "";
			if (pending.kind === "approval") {
				const reason = readText(pending.displayReason, resolveText) || readText(pending.reason, resolveText);
				if (reason.length > 0) return reason;
				return typeof pending.toolName === "string" && pending.toolName.length > 0
					? t("detail.tool", { tool: pending.toolName })
					: "";
			}
			const questions = Array.isArray(pending.questions) ? pending.questions : [];
			for (const question of questions) {
				const text = readText(question?.question, resolveText)
					|| readText(question?.header, resolveText)
					|| readText(question?.text, resolveText);
				if (text.length > 0) return text;
			}
			return "";
		}

		/** Relative "updated N ago" text for a row. */
		function relativeText(row, t) {
			if (row.updatedAt === undefined) return "";
			const seconds = Math.max(0, Math.round((Date.now() - row.updatedAt) / 1000));
			if (seconds < 5) return t("time.now");
			if (seconds < 60) return t("time.seconds", { n: seconds });
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) return t("time.minutes", { n: minutes });
			return t("time.hours", { n: Math.floor(minutes / 60) });
		}

		/** The one request the expanded card details: the highest-priority pending row. */
		function primaryRequest(rows) {
			for (const row of rows) if (row.kind !== undefined) return row;
			return undefined;
		}

		/** Compact pill text, preferring the running task's own title. */
		function compactLabel(rows, t) {			const pending = primaryRequest(rows);
			if (pending !== undefined) {
				return { text: pending.title.length > 0 ? pending.title : pending.fallbackTitle, muted: pending.title.length === 0 };
			}
			const running = rows.filter((row) => row.running);
			if (running.length === 1) {
				return { text: running[0].title.length > 0 ? running[0].title : running[0].fallbackTitle, muted: running[0].title.length === 0 };
			}
			if (running.length > 1) return { text: t("label.running", { n: running.length }), muted: false };
			const done = rows.filter((row) => row.done);
			if (done.length > 0) return { text: t("label.done", { n: done.length }), muted: false };
			return { text: t("label.idle"), muted: true };
		}

		/** Running background jobs of one session, read from the jobs roster snapshot. */
		function runningJobs(jobsState, sessionId) {
			const roster = jobsState?.rows?.[sessionId];
			if (!Array.isArray(roster)) return 0;
			let count = 0;
			for (const job of roster) {
				const status = typeof job?.status === "string" ? job.status : "";
				if (status === "running" || status === "stopping") count += 1;
			}
			return count;
		}

		/**
		 * Context occupancy and token breakdown of one session, read from the same
		 * client-visible projections the shipped context meter uses
		 * (`contextPressure` for used/window, `contextBreakdown` for the split).
		 */
		function usageOf(list, sessionId) {
			const values = list?.projectionsBySession?.[sessionId]?.values;
			if (values === undefined || values === null) return null;
			const pressure = values.contextPressure;
			const used = typeof pressure?.projectedTokens === "number" ? pressure.projectedTokens : pressure?.pressureTokens;
			const capacity = pressure?.contextWindow;
			if (typeof used !== "number" || typeof capacity !== "number" || capacity <= 0) return null;
			const breakdown = values.contextBreakdown;
			const part = (value) => (typeof value === "number" && value > 0 ? value : 0);
			return {
				usedTokens: used,
				contextWindow: capacity,
				percent: Math.min(100, Math.round((used / capacity) * 100)),
				systemTokens: part(breakdown?.systemTokens),
				toolsTokens: part(breakdown?.toolsTokens),
				messageTokens: part(breakdown?.messageTokens)
			};
		}

		/**
		 * The payload the desktop overlay renders. It mirrors exactly what the island
		 * shows in this page, because the page is the only party that can see the live
		 * session catalog, its pending interactions, and the job rosters.
		 */
		function desktopPayload(rows, list, t, resolveText, jobCounts) {
			return {
				version: 1,
				source: "page",
				generatedAt: Date.now(),
				tasks: rows.map((row) => {
					const summary = list?.byId?.[row.id] ?? {};
					const catalog = list?.projectionsBySession?.[row.id]?.values?.subagentCatalog;
					return {
						id: String(row.id),
						title: row.title,
						cwd: typeof summary.cwd === "string" ? summary.cwd : "",
						running: row.running,
						updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
						// Whether this session is the one the main view currently shows, so the
						// overlay can mark it and a click can be verified end to end.
						main: (summary.retainedBy?.mainView ?? 0) > 0,
						pending: row.kind === undefined
							? null
							: {
								kind: row.kind,
								toolName: typeof row.pending?.toolName === "string" ? row.pending.toolName : "",
								// DSH makes the call id optional: the overlay routes an Allow/Deny
								// click through it when present, and by session id otherwise.
								callId: typeof row.pending?.callId === "string" ? row.pending.callId : undefined,
								text: requestText(row.pending, resolveText, t)
							},
						usage: usageOf(list, row.id),
						jobs: { running: jobCounts === undefined ? 0 : (jobCounts.get(row.id) ?? 0) },
						children: Array.isArray(catalog) ? catalog.length : 0
					};
				})
			};
		}

		/**
		 * Latest view published by the mounted island, read by the desktop bridge.
		 * The bridge lives outside React so the push loop always sends exactly what
		 * the island currently renders.
		 */
		const desktopBridge = {
			payload: { version: 1, source: "page", generatedAt: 0, tasks: [] },
			openSession: null,
			watch: null,
			/** Whether a desktop overlay is currently answering our pushes. */
			live: false,
			listeners: new Set(),
			publish(payload, openSession, watch) {
				this.payload = payload;
				this.openSession = openSession;
				this.watch = watch ?? this.watch;
			},
			setLive(value) {
				if (this.live === value) return;
				this.live = value;
				for (const listener of [...this.listeners]) {
					try {
						listener(value);
					} catch {
						/* one bad listener must not stop the others */
					}
				}
			},
			subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
		};

		/** Interpolate `{name}` placeholders without a locale service. */
		function interpolate(dict, key, params) {
			const template = dict[key] ?? key;
			if (params === undefined) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
		}

		/** Simplified Chinese dictionary (key-set source of truth). */
		const zh = {
			"aria.expand": "展开任务详情",
			"aria.collapse": "收起任务详情",
			"status.running": "正在执行",
			"status.approval": "等待批准",
			"status.question": "等待回答",
			"status.plan": "等待确认",
			"status.done": "已完成",
			"status.idle": "空闲",
			"badge.approval": "待批准",
			"badge.question": "待回答",
			"badge.plan-review": "待确认",
			"label.running": "{n} 个任务正在执行",
			"label.done": "{n} 个任务已完成",
			"label.idle": "没有正在执行的任务",
			"section.tasks": "任务 {n}",
			"detail.request": "请求详情",
			"detail.tool": "工具 {tool} 正在请求授权",
			"detail.footer": "点击任务可打开对应会话 · Esc 收起",
			"time.now": "刚刚更新",
			"time.seconds": "{n} 秒前更新",
			"time.minutes": "{n} 分钟前更新",
			"time.hours": "{n} 小时前更新"
		};

		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			"aria.expand": "Expand task details",
			"aria.collapse": "Collapse task details",
			"status.running": "running",
			"status.approval": "waiting for approval",
			"status.question": "waiting for an answer",
			"status.plan": "waiting for review",
			"status.done": "completed",
			"status.idle": "idle",
			"badge.approval": "Needs approval",
			"badge.question": "Needs answer",
			"badge.plan-review": "Needs review",
			"label.running": "{n} tasks running",
			"label.done": "{n} tasks completed",
			"label.idle": "No task running",
			"section.tasks": "Tasks {n}",
			"detail.request": "Request detail",
			"detail.tool": "Tool {tool} is asking for permission",
			"detail.footer": "Click a task to open its session · Esc to collapse",
			"time.now": "updated just now",
			"time.seconds": "updated {n}s ago",
			"time.minutes": "updated {n}m ago",
			"time.hours": "updated {n}h ago"
		};
		//#endregion

		//#region component
		/**
		 * The island.
		 *
		 * Standard kit: `useSessions` (session catalog) and `useSessionStatus`
		 * (running / pending-interaction / completion state). Business share:
		 * `openSession` and `resolveText` from this plugin's own `inject`.
		 */
		function DynamicIsland(props) {
			const useSessions = props.useSessions;
			const useSessionStatus = props.useSessionStatus;
			const openSession = props.openSession;
			const resolveText = props.resolveText;
			const translate = props.t;

			// Both hooks are always called (a stable fallback stands in when the
			// standard kit is absent), so the hook order never changes.
			const useList = typeof useSessions === "function" ? useSessions : NO_SOURCE;
			const useStatus = typeof useSessionStatus === "function" ? useSessionStatus : NO_SOURCE;
			const useJobs = typeof props.useJobs === "function" ? props.useJobs : NO_SOURCE;
			const list = useList((value) => value);
			const statuses = useStatus((value) => value);
			const jobsState = useJobs((value) => value);

			const t = typeof translate === "function" ? translate : (key, params) => interpolate(zh, key, params);

			const [open, setOpen] = react.useState(false);
			const [, setPinned] = react.useState(false);
			const [, setTick] = react.useState(0);
			const closeTimer = react.useRef(null);
			const pinnedRef = react.useRef(false);

			const rows = react.useMemo(() => deriveRows(list, statuses), [list, statuses]);
			const busy = rows.length > 0;

			// When the desktop overlay is running it owns the visible pill, so the in-page
			// one stands down instead of showing the same thing twice.
			const [overlayLive, setOverlayLive] = react.useState(desktopBridge.live);
			react.useEffect(() => desktopBridge.subscribe(setOverlayLive), []);

			// Job rosters only stream while someone watches them, exactly like the
			// shipped job list: open one per visible session, close the ones that left.
			const watchRows = props.watchRows;
			const watched = react.useRef(new Map());
			const rowKey = rows.map((row) => String(row.id)).join(",");
			react.useEffect(() => {
				if (typeof watchRows !== "function") return undefined;
				const wanted = new Set(rowKey.length === 0 ? [] : rowKey.split(","));
				for (const [id, close] of [...watched.current]) {
					if (wanted.has(id)) continue;
					safeCall(close);
					watched.current.delete(id);
				}
				for (const id of wanted) {
					if (watched.current.has(id)) continue;
					try {
						const close = watchRows(id);
						watched.current.set(id, typeof close === "function" ? close : () => {});
					} catch {
						/* a session that cannot stream jobs simply reports none */
					}
				}
				return undefined;
			}, [rowKey, watchRows]);
			react.useEffect(() => () => {
				for (const close of watched.current.values()) safeCall(close);
				watched.current.clear();
			}, []);

			const jobCounts = react.useMemo(() => {
				const counts = new Map();
				for (const row of rows) counts.set(row.id, runningJobs(jobsState, row.id));
				return counts;
			}, [rows, jobsState]);

			// Publish what this page sees so the desktop overlay can render it, plus the
			// navigation callback that a click on the overlay asks for.
			react.useEffect(() => {
				desktopBridge.publish(
					desktopPayload(rows, list, t, resolveText, jobCounts),
					typeof openSession === "function" ? openSession : null
				);
			}, [rows, list, jobCounts, openSession, resolveText, t]);

			react.useEffect(() => () => {
				desktopBridge.publish({ version: 1, source: "page", generatedAt: Date.now(), tasks: [] }, null);
			}, []);

			react.useEffect(() => {
				if (!busy) return undefined;
				const timer = setInterval(() => setTick((n) => n + 1), 1000);
				return () => clearInterval(timer);
			}, [busy]);

			const cancelClose = react.useCallback(() => {
				if (closeTimer.current !== null) {
					clearTimeout(closeTimer.current);
					closeTimer.current = null;
				}
			}, []);

			react.useEffect(() => cancelClose, [cancelClose]);

			const expand = react.useCallback(() => {
				cancelClose();
				setOpen(true);
			}, [cancelClose]);

			const scheduleCollapse = react.useCallback(() => {
				cancelClose();
				if (pinnedRef.current) return;
				closeTimer.current = setTimeout(() => {
					closeTimer.current = null;
					setOpen(false);
				}, COLLAPSE_DELAY_MS);
			}, [cancelClose]);

			// The desktop overlay is the only place the island is meant to appear; the in-page pill
			// is opt-in (`showInPage`) because it would sit on top of the app's own chrome.
			if (props.showInPage !== true) return null;
			if (!busy || overlayLive) return null;

			const label = compactLabel(rows, t);
			const pending = primaryRequest(rows);
			const request = requestText(pending?.pending, resolveText, t);
			const preview = request.length > REQUEST_PREVIEW_CHARS ? `${request.slice(0, REQUEST_PREVIEW_CHARS)}…` : request;
			const runningCount = rows.filter((row) => row.running).length;

			const activate = (sessionId) => {
				try {
					openSession(sessionId);
				} catch {
					/* navigation is best-effort: a failure must not break the island */
				}
				pinnedRef.current = false;
				setPinned(false);
				setOpen(false);
			};

			const togglePin = () => {
				cancelClose();
				const next = !pinnedRef.current;
				pinnedRef.current = next;
				setPinned(next);
				setOpen(next ? true : false);
			};

			const onCompactKeyDown = (event) => {
				if (event.key === "Escape") {
					pinnedRef.current = false;
					setPinned(false);
					setOpen(false);
					return;
				}
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					togglePin();
				}
			};

			const compact = h(
				"div",
				{
					className: "DshIsland_compact",
					role: "button",
					tabIndex: 0,
					"aria-expanded": open,
					"aria-label": open ? t("aria.collapse") : t("aria.expand"),
					onClick: togglePin,
					onKeyDown: onCompactKeyDown
				},
				h("span", { className: dotClass(pending ?? rows[0]), "aria-hidden": "true" }),
				h(
					"span",
					{
						className: label.muted ? "DshIsland_title DshIsland_titleMuted" : "DshIsland_title",
						title: label.text
					},
					label.text
				),
				pending !== undefined ? h("span", { className: "DshIsland_badge" }, t(`badge.${pending.kind}`)) : null,
				runningCount > 1 ? h("span", { className: "DshIsland_count" }, String(runningCount)) : null,
				h(
					"svg",
					{
						className: open ? "DshIsland_chevron DshIsland_chevronOpen" : "DshIsland_chevron",
						width: 12,
						height: 12,
						viewBox: "0 0 16 16",
						fill: "none",
						"aria-hidden": "true"
					},
					h("path", {
						d: "M4 6.5 8 10.5 12 6.5",
						stroke: "currentColor",
						strokeWidth: 1.6,
						strokeLinecap: "round",
						strokeLinejoin: "round"
					})
				)
			);

			const detail = h(
				"div",
				{
					className: open ? "DshIsland_detail DshIsland_detailOpen" : "DshIsland_detail",
					"aria-hidden": !open
				},
				h("div", { className: "DshIsland_divider" }),
				h("div", { className: "DshIsland_sectionLabel" }, t("section.tasks", { n: rows.length })),
				h(
					"div",
					{ className: "DshIsland_rows DshIsland_scroll" },
					rows.map((row) =>
						h(
							"button",
							{
								key: String(row.id),
								type: "button",
								className: "DshIsland_row",
								onClick: () => activate(row.id),
								title: row.title.length > 0 ? row.title : row.fallbackTitle
							},
							h("span", { className: `${dotClass(row)} DshIsland_rowDot`, "aria-hidden": "true" }),
							h(
								"span",
								{ className: "DshIsland_rowMain" },
								h("span", { className: "DshIsland_rowTitle" }, row.title.length > 0 ? row.title : row.fallbackTitle),
								h(
									"span",
									{ className: "DshIsland_rowSub" },
									h("span", { className: "DshIsland_rowState" }, stateLabel(row, t)),
									h("span", { className: "DshIsland_rowTime" }, relativeText(row, t))
								)
							)
						)
					)
				),
				pending !== undefined && preview.length > 0
					? h(
							"div",
							{ className: "DshIsland_request" },
							h(
								"div",
								{ className: "DshIsland_requestHead" },
								h("span", { className: dotClass(pending), "aria-hidden": "true" }),
								t("detail.request")
							),
							h("div", { className: "DshIsland_requestBody DshIsland_scroll" }, preview)
						)
					: null,
				h("div", { className: "DshIsland_footer" }, t("detail.footer"))
			);

			return h(
				"div",
				{
					className: "DshIsland_root",
					onPointerEnter: expand,
					onPointerLeave: scheduleCollapse,
					onFocusCapture: expand,
					onBlurCapture: (event) => {
						if (!event.currentTarget.contains(event.relatedTarget)) scheduleCollapse();
					}
				},
				h("div", { className: open ? "DshIsland_pill DshIsland_pillOpen" : "DshIsland_pill" }, compact, detail)
			);
		}
		//#endregion

		/** Required services: the slot registry, dictionaries, and session navigation. */
		const inject = ["slots", "locale", "uiWorkspace"];

		/**
		 * Client plugin body: register the island as one frame-wide overlay entry, and
		 * feed the desktop overlay whatever this page currently sees.
		 * @param ctx - client root context.
		 */
		function apply(ctx, config) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dynamic-island: dictionaries");
			// The island lives on the desktop, not inside the Harness window, so the in-page pill is
			// off unless a composition explicitly asks for it (`showInPage: true`).
			const showInPage = config !== undefined && config !== null && config.showInPage === true;
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dynamic-island",
				order: 50,
				locale: NS,
				inject: () => {
					const business = {
						openSession: (sessionId) => ctx.uiWorkspace.openSession(sessionId),
						resolveText: (value) => ctx.locale.resolveText(value),
						showInPage
					};
					// The job rosters are optional: a composition without the jobs service
					// still gets the island, it just never reports background jobs.
					const jobs = safeGet(ctx, "jobs");
					if (jobs !== undefined && jobs !== null) {
						if (jobs.state !== undefined) business.hooks = { jobs: jobs.state };
						if (typeof jobs.watchRows === "function") business.watchRows = (sessionId) => jobs.watchRows(sessionId);
					}
					return business;
				}
			}, DynamicIsland));
			ctx.effect(() => startDesktopBridge(ctx), "dynamic-island: desktop bridge");
		}

		/** Call a disposer that may be missing or may throw; the island never breaks on one. */
		function safeCall(fn) {
			try {
				if (typeof fn === "function") fn();
			} catch {
				/* a failed cleanup is not worth surfacing */
			}
		}

		/** Read an optional client service without failing activation when it is absent. */
		function safeGet(ctx, key) {
			try {
				return ctx.get(key);
			} catch {
				return undefined;
			}
		}

		/**
		 * Ports the desktop overlay may listen on, in probe order. The overlay binds the
		 * first free one, so the page tries each until one answers /health.
		 */
		const DESKTOP_PORTS = [19391, 19392, 19393, 19394, 19395];
		/** Push cadence while the overlay is present. */
		const DESKTOP_PUSH_MS = 1000;

		/**
		 * Push this page's task view to the desktop overlay and answer its click-to-open
		 * requests.
		 *
		 * The overlay cannot reach DSH internals and a host-side row only activates on
		 * the next app start, so the page is the live data source: it POSTs the same
		 * view it renders and polls the overlay's focus queue. While no overlay answers,
		 * the loop backs off to 15s and stays silent.
		 */
		function startDesktopBridge(ctx) {
			let port = null;
			let delay = DESKTOP_PUSH_MS;
			let stopped = false;
			let timer = null;
			let failures = 0;

			const schedule = () => {
				if (stopped) return;
				timer = setTimeout(tick, delay);
			};

			const discover = async () => {
				for (const candidate of DESKTOP_PORTS) {
					try {
						const response = await fetch(`http://127.0.0.1:${candidate}/health`, { cache: "no-store" });
						if (!response.ok) continue;
						// Distinguish the overlay from the optional host-side endpoint, which
						// answers /health too but serves a different role.
						const body = await response.text();
						if (body.includes("overlay")) {
							port = candidate;
							return true;
						}
					} catch {
						/* try the next candidate */
					}
				}
				port = null;
				return false;
			};

			const tick = async () => {
				if (stopped) return;
				try {
					if (port === null && !(await discover())) {
						failures += 1;
						if (failures >= 3) desktopBridge.setLive(false);
						delay = Math.min(delay * 2, 15000);
						schedule();
						return;
					}
					// text/plain keeps this a CORS-simple request: no preflight per push.
					// The timestamp is stamped at send time: the published payload may be
					// seconds old when the page has nothing new to render.
					const pushed = await fetch(`http://127.0.0.1:${port}/island`, {
						method: "POST",
						headers: { "content-type": "text/plain;charset=UTF-8" },
						body: JSON.stringify({ ...desktopBridge.payload, generatedAt: Date.now() })
					});
					if (!pushed.ok) throw new Error(String(pushed.status));
					delay = DESKTOP_PUSH_MS;
					failures = 0;
					desktopBridge.setLive(true);

					const focus = await fetch(`http://127.0.0.1:${port}/focus`, { cache: "no-store" });
					if (focus.ok) {
						const body = await focus.json();
						const sessionId = body?.sessionId;
						if (typeof sessionId === "string" && sessionId.length > 0) {
							const open = desktopBridge.openSession;
							if (typeof open === "function") {
								try {
									open(sessionId);
								} catch {
									/* navigation is best-effort */
								}
							}
						}
					}
				} catch {
					port = null;
					failures += 1;
					if (failures >= 3) desktopBridge.setLive(false);
					delay = Math.min(delay * 2, 15000);
				}
				schedule();
			};

			void tick();
			return () => {
				stopped = true;
				desktopBridge.setLive(false);
				if (timer !== null) clearTimeout(timer);
			};
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
