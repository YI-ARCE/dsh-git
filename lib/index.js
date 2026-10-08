// dsh-git-badge — Node 侧数据面（本包与 ./client 一条 patch 行双半齐载，
// 模式同 dsh-better-sidebar）：工作区探测 + git 状态语义 + 桥路由。
//
// 路由（全部同源 127.0.0.1:<dsh port>）：
//   GET /__git-bridge/events → 工作区和状态快照的事件流
//   GET /__git-bridge/state  → 手动读取当前徽章快照
//
// B4 状态语义（规格书 §1.3，并存顺序 冲突 > 未提交 > 落后 > 领先 > 无远程；
// 前端按此顺序渲染，全部可并存）：
//   conflict   红 !            — porcelain 中存在 UU/AA/DD/AU/UD/DU/UA 任一
//   dirty      数字            — 变更文件数（含未跟踪）
//   behind     ↓N              — 落后上游
//   ahead      ↑N              — 领先上游
//   无远程     灰「无远程」      — 分支没有 upstream
//
// 认证保险丝：GIT_TERMINAL_PROMPT=0 + 10s 超时，与基座 GitService 同规。

import { execFile } from "node:child_process";
import * as gitAI from './ai.js';

const state = { statuses: {} };

function missingPath(error) {
	return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isDirectory(info) {
	if (typeof info.isDirectory === 'function') return info.isDirectory();
	if (typeof info.type === 'string') return info.type === 'directory' || info.type === 'dir';
	return true;
}

function gitRoot(cwd) {
	return new Promise(resolve => {
		execFile('git', ['rev-parse', '--show-toplevel'], {
			cwd, timeout: 10000, windowsHide: true,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
		}, (error, stdout, stderr) => {
			if (!error) return resolve(String(stdout).trim() ? { hasGit: true } : { error: 'git 仓库探测未返回根路径' });
			if (/fatal: not a git repository\b/i.test(String(stderr))) return resolve({ hasGit: false });
			if (error.code === 'ENOENT') return resolve({ hasGit: false });
			resolve({ error: error.killed ? 'git 仓库探测超时（10s）' : String(stderr).trim() || error.message });
		});
	});
}
/** 解析 `git status --porcelain=v1 -b` 输出为六态语义。 */
function parsePorcelain(out) {
	const st = {
		branch: "",
		upstream: "",
		hasUpstream: false,
		ahead: 0,
		behind: 0,
		dirty: 0,
		conflict: false,
		noCommits: false,
	};
	for (const raw of out.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (!line) continue;
		if (line.startsWith("## ")) {
			let head = line.slice(3);
			if (head.startsWith("No commits yet on ")) {
				st.branch = head.slice("No commits yet on ".length);
				st.noCommits = true;
				continue;
			}
			const bi = head.indexOf(" [");
			if (bi >= 0) {
				const tracking = head.slice(bi + 2).replace(/\]$/, "");
				head = head.slice(0, bi);
				for (const part of tracking.split(",")) {
					const p = part.trim();
					if (p.startsWith("ahead ")) st.ahead = parseInt(p.slice(6), 10) || 0;
					else if (p.startsWith("behind ")) st.behind = parseInt(p.slice(7), 10) || 0;
				}
			}
			if (head === "HEAD (no branch)") {
				st.branch = "HEAD（游离）";
				continue;
			}
			const d = head.indexOf("...");
			if (d >= 0) {
				st.branch = head.slice(0, d);
				st.upstream = head.slice(d + 3);
				st.hasUpstream = true;
			} else {
				st.branch = head;
			}
			continue;
		}
		if (line.length < 3) continue;
		const x = line[0];
		const y = line[1];
		st.dirty += 1;
		if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
			st.conflict = true;
		}
	}
	return st;
}

/** 在 cwd 跑 git status；保险丝 + 超时；错误以 {error} 返回（不抛）。 */
function gitStatus(cwd) {
	return new Promise((resolve) => {
		execFile(
			"git",
			["status", "--porcelain=v1", "-b"],
			{
				cwd: cwd,
				timeout: 10000,
				maxBuffer: 4 * 1024 * 1024,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
				windowsHide: true,
			},
			(err, stdout) => {
				if (err) {
					const msg = err.killed
						? "git status 超时（10s）"
						: String((stdout && String(stdout).trim()) || err.message || err);
					resolve({ error: msg });
					return;
				}
				resolve(parsePorcelain(String(stdout)));
			},
		);
	});
}

async function detect(ctx) {
	const registry = ctx.get('workspaceRegistry');
	const fs = ctx.get('fs');
	const diag = {
		registry: registry !== undefined,
		fs: fs !== undefined,
		listError: '',
		count: 0,
	};
	const rows = [];
	let list = [];
	if (registry !== undefined) {
		try {
			list = registry.list();
		} catch (e) {
			diag.listError = String(e && e.message ? e.message : e);
		}
	}
	diag.count = list.length;
	if (fs === undefined) {
		diag.listError = diag.listError || 'fs 服务不可用';
	}
	const detected = await Promise.all(list.map(async (ws) => {
		const row = {
			workspaceId: String(ws.id),
			path: String(ws.path),
			title: String(ws.title),
			hasGit: false,
			accessible: false,
			error: '',
			status: null,
		};
		if (fs !== undefined) {
			try {
				const root = await fs.resolve(row.path);
				const rootInfo = await fs.stat(root);
				if (!rootInfo || !isDirectory(rootInfo)) {
					row.error = '工作区目录不可访问';
					return row;
				}
				let info;
				try {
					const target = await fs.resolve(row.path + '/.git');
					info = await fs.stat(target);
				} catch (e) {
					if (!missingPath(e)) throw e;
				}
				const probe = await gitRoot(row.path);
				if (probe.error || (info && !probe.hasGit)) {
					row.error = probe.error || '.git 不是有效的 Git 仓库';
					return row;
				}
				row.hasGit = Boolean(probe.hasGit);
				row.accessible = true;
			} catch (e) {
				row.error = String(e && e.message ? e.message : e);
			}
		}
		if (row.hasGit) row.status = state.statuses[row.workspaceId] || null;
		return row;
	}));
	rows.push(...detected);
	return { diag: diag, rows: rows };
}

/** Push snapshots immediately; filesystem notifications refresh promptly, while the
 * original 5s reconciliation still catches changes in nested worktree entries. */
function startStatusLoop(ctx, publish) {
	const fs = ctx.get('fs');
	const watchers = new Map();
	const pending = new Set();
	let all = false;
	let busy = false;
	let stopped = false;
	let debounce;
	const controller = new AbortController();
	const schedule = (id) => {
		if (stopped) return;
		if (id === undefined) all = true;
		else pending.add(id);
		clearTimeout(debounce);
		debounce = setTimeout(run, 120);
	};
	async function watchRow(row) {
		if (!fs || typeof fs.watch !== 'function') return;
		const old = watchers.get(row.workspaceId);
		if (old && old.path === row.path && old.hasGit === row.hasGit) return;
		const record = { path: row.path, hasGit: row.hasGit, close: [] };
		watchers.set(row.workspaceId, record);
		if (old) for (const close of old.close) await close();
		// Watching all of .git would react to index writes caused by git status itself.
		for (const path of [row.path, ...(row.hasGit ? [
			row.path + '/.git/HEAD',
			row.path + '/.git/refs/heads',
			row.path + '/.git/refs/remotes',
		] : [])]) {
			try {
				const target = await fs.resolve(path);
				const close = await fs.watch(target, () => schedule(row.workspaceId), controller.signal);
				if (stopped || watchers.get(row.workspaceId) !== record) await close();
				else record.close.push(close);
			} catch (_) { /* Not all filesystem providers support watching. */ }
		}
	}
	async function run() {
		if (busy || stopped) return;
		busy = true;
		try {
			while ((all || pending.size) && !stopped) {
				const full = all;
				const ids = new Set(pending);
				all = false;
				pending.clear();
				const snapshot = await detect(ctx);
				if (stopped) break;
				const live = new Set(snapshot.rows.map(r => r.workspaceId));
				for (const [id, record] of watchers) {
					if (live.has(id)) continue;
					watchers.delete(id);
					delete state.statuses[id];
					for (const close of record.close) await close();
				}
				for (const row of snapshot.rows) {
					if (!row.hasGit) delete state.statuses[row.workspaceId];
					void watchRow(row).catch(() => {});
				}
				publish(snapshot);
				const selected = snapshot.rows.filter(r => r.hasGit && (full || ids.has(r.workspaceId)));
				let cursor = 0;
				await Promise.all(Array.from({ length: Math.min(3, selected.length) }, async () => {
					while (cursor < selected.length && !stopped) {
						const row = selected[cursor++];
						const status = await gitStatus(row.path);
						if (!stopped) {
							state.statuses[row.workspaceId] = status;
							row.status = status;
							publish(snapshot);
						}
					}
				}));
			}
		} catch (_) { /* A later notification or reconciliation retries. */ }
		finally { busy = false; if ((all || pending.size) && !stopped) debounce = setTimeout(run, 120); }
	}
	ctx.on('domain/changed', change => { if (change.domain === 'workspace') schedule(); });
	const timer = setInterval(() => schedule(), 5000);
	schedule();
	return () => {
		stopped = true;
		controller.abort();
		clearInterval(timer);
		clearTimeout(debounce);
		for (const record of watchers.values()) for (const close of record.close) void Promise.resolve(close()).catch(() => {});
		watchers.clear();
	};
}

export const name = 'dsh-git-badge';
export const Config = gitAI.Config;
// webServer 是硬依赖：声明后 cordis 会等它激活再挂本行（否则 ctx.get 在
// 本行早于 webServer 挂载的时刻拿到 undefined，桥路由整段不注册）。
export const inject = ['webServer', 'workspaceRegistry', 'fs'];

export async function apply(ctx) {
	const webServer = ctx.get('webServer');
	if (webServer === undefined) {
		console.error('[dsh-git-badge] webServer 服务不可用，桥路由未注册');
		return;
	}

	const disposers = [gitAI.apply(ctx)];

	// 徽章数据源（含六态语义缓存）
	disposers.push(
		webServer.register({
			kind: 'exact',
			path: '/__git-bridge/state',
			handler: (req, res) => {
				detect(ctx)
					.then((d) => {
						res.statusCode = 200;
						res.setHeader('Content-Type', 'application/json');
						res.end(JSON.stringify(d));
					})
					.catch((e) => {
						res.statusCode = 500;
						res.end(String(e && e.message ? e.message : e));
					});
			},
		}),
	);

	const clients = new Set();
	let latest = { diag: {}, rows: [] };
	function publish(snapshot) {
		latest = snapshot;
		const frame = 'data: ' + JSON.stringify(snapshot) + '\n\n';
		for (const client of clients) client.write(frame);
	}
	disposers.push(webServer.register({
		kind: 'exact',
		path: '/__git-bridge/events',
		handler: (req, res) => {
			res.writeHead(200, {
				'Content-Type': 'text/event-stream; charset=utf-8',
				'Cache-Control': 'no-cache, no-transform',
				'Connection': 'keep-alive',
			});
			res.write('data: ' + JSON.stringify(latest) + '\n\n');
			clients.add(res);
			res.on('close', () => clients.delete(res));
		},
	}));
	const heartbeat = setInterval(() => {
		for (const client of clients) client.write(': keepalive\n\n');
	}, 20000);
	disposers.push(() => {
		clearInterval(heartbeat);
		for (const client of clients) client.end();
		clients.clear();
	});
	disposers.push(startStatusLoop(ctx, publish));

	ctx.effect(() => {
		return () => {
			for (const d of disposers) d();
		};
	});
}
