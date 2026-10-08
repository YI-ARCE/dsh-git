window.__ModuleLoader__.load({
	id: "dsh-git-badge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region state
		var CHIP_ATTR = "data-dsh-git-badge";
		var STATE = { rows: [] };

		function receiveState(data) {
			if (!data || !Array.isArray(data.rows)) return;
			STATE.rows = data.rows;
			scheduleSync();
		}
		//#endregion

		//#region dom sync
		// 工作区条目行的类名是 "CSS模块哈希_源类名"，用包含匹配抗哈希漂移；
		// 只取 projectRow（会话行 sessionRow、搜索结果行 searchResultRow 不挂）。
		function findRows() {
			return Array.prototype.slice.call(document.querySelectorAll('[class*="projectRow"]'));
		}

		function matchRow(el) {
			var key = el.getAttribute("data-row-key");
			if (!key || key.indexOf("workspace:") !== 0) return null;
			var id = key.slice(10);
			for (var i = 0; i < STATE.rows.length; i++) {
				if (STATE.rows[i].workspaceId === id) return STATE.rows[i];
			}
			return null;
		}

		// git 分支图标（Lucide git-branch），git 橙，行内任意主题下都可读
		var GIT_ICON_SVG =
			'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f05133" ' +
			'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
			'<line x1="6" x2="6" y1="3" y2="15"></line>' +
			'<circle cx="18" cy="6" r="3"></circle>' +
			'<circle cx="6" cy="18" r="3"></circle>' +
			'<path d="M18 9a9 9 0 0 1-9 9"></path>' +
			'</svg>';

		// Lucide file icon for a directory opened outside Git mode.
		var FILE_ICON_SVG =
			'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
			'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
			'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>' +
			'<polyline points="14 2 14 8 20 8"></polyline></svg>';

		// 徽标配色：冲突红 ! > 未提交数字 > 落后 ↓ > 领先 ↑ > 无远程灰
		var BADGE_STYLES = {
			conflict: { bg: "#7f1d1d", fg: "#fecaca" },
			dirty: { bg: "rgba(251,191,36,0.14)", fg: "#fbbf24" },
			behind: { bg: "#1e3a8a", fg: "#bfdbfe" },
			ahead: { bg: "#164e63", fg: "#a5f3fc" },
			noup: { bg: "rgba(107,114,128,0.15)", fg: "#9ca3af" },
		};

		function makeBadge(text, kind, tip) {
			var st = BADGE_STYLES[kind] || BADGE_STYLES.noup;
			var b = document.createElement("span");
			b.textContent = text;
			b.title = tip;
			b.style.cssText =
				"flex:none;display:inline-flex;align-items:center;padding:0 5px;border-radius:8px;" +
				"font:600 10px/1.7 system-ui,sans-serif;background:" + st.bg + ";color:" + st.fg + ";";
			return b;
		}

		function makeChip(row) {
			var chip = document.createElement("span");
			chip.setAttribute(CHIP_ATTR, "1");
			chip.style.cssText =
				"display:inline-flex;align-items:center;gap:4px;flex:none;cursor:pointer;opacity:0.9;";
			chip.innerHTML = row.hasGit ? GIT_ICON_SVG : FILE_ICON_SVG;
			if (!row.hasGit) {
				chip.title = "打开工作区文件";
				attachClick(chip, row);
				return chip;
			}
			var s = row.status;
			var tip = "git 仓库（点击打开 Git 窗口）";
			if (s && s.error) {
				tip = "git 状态获取失败：" + s.error;
				chip.appendChild(makeBadge("!", "conflict", tip));
			} else if (s) {
				// 并存顺序：冲突 > 未提交 > 落后 > 领先 > 无远程
				if (s.conflict) chip.appendChild(makeBadge("!", "conflict", "存在合并冲突，请打开 Git 窗口处理"));
				if (s.dirty > 0) chip.appendChild(makeBadge(String(s.dirty), "dirty", s.dirty + " 个未提交文件"));
				if (s.behind > 0) chip.appendChild(makeBadge("↓" + s.behind, "behind", "落后远程 " + s.behind + " 个提交，需要 pull"));
				if (s.ahead > 0) chip.appendChild(makeBadge("↑" + s.ahead, "ahead", "领先远程 " + s.ahead + " 个提交，未推送"));
				if (!s.hasUpstream && !s.noCommits) chip.appendChild(makeBadge("无远程", "noup", "分支没有配置上游远程"));
				if (s.branch) tip = s.branch + "（点击打开 Git 窗口）";
			}
			chip.title = tip;
			attachClick(chip, row);
			return chip;
		}

		function attachClick(chip, row) {
			chip.onclick = function (ev) {
				ev.stopPropagation();
				ev.preventDefault();
				var payload = { workspaceId: row.workspaceId, path: row.path };
				// WebView2 routes wails.localhost directly to the native event processor.
				fetch("http://wails.localhost/wails/runtime", {
					method: "POST",
					mode: "no-cors",
					headers: { "Content-Type": "text/plain" },
					body: JSON.stringify({ object: 3, method: 0, args: { name: "git:open-window", data: payload } }),
				}).catch(function (error) { console.error("Git 窗口打开失败", error); });
			};
		}

		// 挂载点：前导图标槽位（文件夹图标 + 箭头）之后、标题之前。行尾是
		// hover 才出现的「更多 / 新建对话」按钮区，徽章挂行尾会把按钮从右缘
		// 顶开、与其他行不对齐；挂前导区后面只占标题的弹性空间，按钮不动。
		//
		// 为什么必须排在箭头之后而不能插在文件夹图标和箭头之间：
		// 原生 hover 行为是「文件夹图标 display:none 隐藏、箭头显示并顶到
		// 第一槽位」。若徽章夹在两者之间，图标一隐藏徽章就抢走第一槽位，
		// 箭头被挤到徽章后面。以标题为锚插入则两个状态都正确：
		//   常态   [文件夹][徽章][标题]        （箭头 display:none 收起）
		//   hover  [箭头][徽章][标题][更多/＋]  （文件夹隐藏，箭头顶替原位）
		// 行自身 gap:6px 提供间距，无需再加 margin。
		function mountChip(row, chip) {
			var text = row.querySelector('[class*="projectText"]');
			if (text && text.parentElement === row) {
				row.insertBefore(chip, text);
				return;
			}
			// 兜底：标题找不到（结构变更）时退回行尾
			row.appendChild(chip);
		}

		// 芯片内容签名：工作区标识 + 状态语义全量进签名（makeChip 渲染的每
		// 一个字段都在内）。签名不变就复用同一个 DOM 元素，只有数据真变了才
		// 重建——元素身份稳定，click 监听不会中途失效。
		function chipSignature(row) {
			var s = row.status;
			if (!row.hasGit) return row.workspaceId + "|" + row.path + "|files";
			if (!s) return row.workspaceId + "|" + row.path + "|loading";
			return [
				row.workspaceId,
				row.path,
				s.error || "",
				s.conflict ? "c" : "-",
				s.dirty || 0,
				s.behind || 0,
				s.ahead || 0,
				s.branch || "",
				s.hasUpstream || s.noCommits ? "up" : "noup",
			].join("|");
		}

		function isRow(rows, el) {
			for (var i = 0; i < rows.length; i++) if (rows[i] === el) return true;
			return false;
		}

		// 位置校验：芯片必须仍紧跟在标题之前（React 重渲染可能重建/移动行内节点）
		function chipInPlace(row, chip) {
			var text = row.querySelector('[class*="projectText"]');
			return text !== null && chip.nextSibling === text;
		}

		function sync() {
			// 调和式同步（不要无脑全拆重挂！之前每 300ms 拆掉重建，mousedown
			// 落在旧芯片、松开前被换成新元素，click 落在已分离节点上被吞——
			// 这就是点击有概率不响应的原因）：先归类现存芯片（每行至多一个，
			// 重复/宿主失效的摘除），再逐行对表，签名与位置都命中的原样保留。
			var rows = findRows();
			var existing = [];
			var all = document.querySelectorAll("[" + CHIP_ATTR + "]");
			for (var i = 0; i < all.length; i++) {
				var host = all[i].parentElement;
				if (!host) continue;
				var dup = false;
				for (var a = 0; a < existing.length; a++) {
					if (existing[a].row === host) { dup = true; break; }
				}
				if (dup || !isRow(rows, host)) {
					host.removeChild(all[i]);
					continue;
				}
				existing.push({ row: host, chip: all[i] });
			}
			for (var r = 0; r < rows.length; r++) {
				var row = rows[r];
				var match = matchRow(row);
				var mine = null;
				for (var b = 0; b < existing.length; b++) {
					if (existing[b].row === row) { mine = existing[b].chip; break; }
				}
				// 没有 .git 的工作区完全不渲染
				if (!match || (!match.hasGit && !match.accessible) || match.error) {
					if (mine && mine.parentElement) mine.parentElement.removeChild(mine);
					continue;
				}
				var sig = chipSignature(match);
				if (mine && mine.__sig === sig && chipInPlace(row, mine)) continue;
				if (mine && mine.parentElement) mine.parentElement.removeChild(mine);
				var chip = makeChip(match);
				chip.__sig = sig;
				mountChip(row, chip);
			}
		}
		//#endregion

		var syncFrame = 0;
		function scheduleSync() {
			if (!syncFrame) syncFrame = requestAnimationFrame(function () { syncFrame = 0; sync(); });
		}

		function mount() {
			var events = new EventSource("/__git-bridge/events");
			events.onmessage = function (ev) {
				try { receiveState(JSON.parse(ev.data)); } catch (error) { console.error("Git 徽章数据无效", error); }
			};
			var observer = new MutationObserver(function (records) {
				for (var i = 0; i < records.length; i++) {
					var record = records[i];
					var target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
					if (target && target.closest('[class*="projectRow"]')) { scheduleSync(); return; }
					for (var j = 0; j < record.addedNodes.length; j++) {
						var node = record.addedNodes[j];
						if (node.nodeType === 1 && (node.matches('[class*="projectRow"]') || node.querySelector('[class*="projectRow"]'))) {
							scheduleSync(); return;
						}
					}
				}
			});
			observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
			scheduleSync();
			return function dispose() {
				events.close();
				observer.disconnect();
				cancelAnimationFrame(syncFrame);
				syncFrame = 0;
				var chips = document.querySelectorAll("[" + CHIP_ATTR + "]");
				for (var i = 0; i < chips.length; i++) {
					if (chips[i].parentElement) chips[i].parentElement.removeChild(chips[i]);
				}
			};
		}

		var inject = [];

		function apply(ctx) {
			if (ctx && typeof ctx.effect === "function") {
				ctx.effect(function () {
					return mount();
				});
			} else {
				// 防御：无 effect 上下文时按页面单次挂载
				if (!window.__dshGitBadgeMounted) {
					window.__dshGitBadgeMounted = true;
					mount();
				}
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
