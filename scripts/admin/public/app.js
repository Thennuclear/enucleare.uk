/* ============================================================
   Mizuki 文章管理台 - 前端逻辑
   ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const DEV_PREVIEW_BASE = "http://localhost:4321";

const state = {
	fields: [],
	order: [],
	posts: [],
	meta: { categories: [], tags: [], counts: {} },
	selectedId: null,
	post: null,
	dirty: false,
	filter: "all",
	query: "",
	sort: "published-desc",
	view: "split",
	tagValues: [],
	saving: false,
	advancedOpen: false,
};

const ctrls = {}; // key -> { get, set }

/* ---------------------------------------------------------- 通用工具 ---- */

async function api(path, options = {}) {
	const res = await fetch(path, {
		headers: { "Content-Type": "application/json" },
		...options,
	});
	const text = await res.text();
	let data;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		throw new Error(`服务器返回了非 JSON 内容：${text.slice(0, 120)}`);
	}
	if (!res.ok || data.ok === false) {
		const err = new Error(data.error || `请求失败 (${res.status})`);
		err.status = res.status;
		err.payload = data;
		throw err;
	}
	return data;
}

function toast(message, kind = "ok", duration = 2600) {
	const stack = $("#toastStack");
	const el = document.createElement("div");
	el.className = `toast ${kind}`;
	el.textContent = message;
	stack.appendChild(el);
	setTimeout(() => {
		el.style.transition = "opacity .25s, transform .25s";
		el.style.opacity = "0";
		el.style.transform = "translateY(6px)";
		setTimeout(() => el.remove(), 260);
	}, duration);
}

function fmtDate(value) {
	if (!value) return "";
	return String(value).slice(0, 10);
}

function fmtSize(bytes) {
	if (!bytes) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function debounce(fn, wait = 150) {
	let timer = null;
	return (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), wait);
	};
}

function todayISO() {
	const now = new Date();
	const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
	return local.toISOString().slice(0, 10);
}

/** 与服务器保持一致的 slug 规则（仅用于弹窗预览） */
function sanitizeSlug(input) {
	return String(input || "")
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[.\-\s]+/, "")
		.replace(/[.\-\s]+$/, "")
		.slice(0, 80);
}

/* ============================================================= 列表 ==== */

function postMatches(post) {
	const q = state.query.trim().toLowerCase();
	if (!q) return true;
	const haystack = [post.title, post.description, post.category, post.slug, ...post.tags]
		.join("\n")
		.toLowerCase();
	return q.split(/\s+/).every((word) => haystack.includes(word));
}

function filterPosts() {
	let list = state.posts.filter(postMatches);
	if (state.filter === "draft") list = list.filter((p) => p.draft);
	else if (state.filter === "published") list = list.filter((p) => !p.draft);
	else if (state.filter === "pinned") list = list.filter((p) => p.pinned);

	const sorters = {
		"published-desc": (a, b) => (b.published || "").localeCompare(a.published || ""),
		"published-asc": (a, b) => (a.published || "").localeCompare(b.published || ""),
		"updated-desc": (a, b) => (b.mtime || 0) - (a.mtime || 0),
		"title-asc": (a, b) => a.title.localeCompare(b.title, "zh"),
		"words-desc": (a, b) => (b.wordCount || 0) - (a.wordCount || 0),
	};
	list.sort(sorters[state.sort] || sorters["published-desc"]);
	return list;
}

function renderList() {
	const list = $("#postList");
	const posts = filterPosts();
	list.innerHTML = "";

	if (!posts.length) {
		const empty = document.createElement("li");
		empty.className = "list-empty";
		empty.textContent = state.posts.length
			? "没有符合筛选条件的文章"
			: "还没有文章，点击「＋ 新建」创建第一篇吧";
		list.appendChild(empty);
	} else {
		for (const post of posts) {
			const li = document.createElement("li");
			li.className = `post-item${post.draft ? " draft" : ""}${
				post.id === state.selectedId ? " active" : ""
			}`;
			li.dataset.id = post.id;

			const titleRow = document.createElement("div");
			titleRow.className = "post-title";
			titleRow.textContent = post.title || "(无标题)";
			if (post.encrypted) {
				const lock = document.createElement("span");
				lock.className = "pill pill-lock";
				lock.textContent = "🔒";
				titleRow.appendChild(lock);
			}

			const metaRow = document.createElement("div");
			metaRow.className = "post-meta";
			if (post.draft) metaRow.appendChild(makePill("草稿", "pill-draft"));
			if (post.pinned) metaRow.appendChild(makePill("置顶", "pill-pinned"));
			const date = fmtDate(post.published) || "无日期";
			const dateSpan = document.createElement("span");
			dateSpan.textContent = date;
			metaRow.appendChild(dateSpan);
			if (post.wordCount) {
				const wc = document.createElement("span");
				wc.textContent = `· ${post.wordCount} 字`;
				metaRow.appendChild(wc);
			}
			if (post.tags.length) {
				const tag = document.createElement("span");
				tag.className = "pill pill-tag";
				tag.textContent = post.tags.slice(0, 2).join(" / ");
				if (post.tags.length > 2) tag.textContent += ` +${post.tags.length - 2}`;
				metaRow.appendChild(tag);
			}

			li.append(titleRow, metaRow);
			li.addEventListener("click", () => selectPost(post.id));
			list.appendChild(li);
		}
	}

	const counts = state.meta.counts || {};
	const shown = posts.length;
	$("#statText").textContent =
		`共 ${counts.total || 0} 篇 · 草稿 ${counts.draft || 0} · 置顶 ${counts.pinned || 0}` +
		(shown !== state.posts.length ? ` · 显示 ${shown}` : "");
}

function makePill(text, className) {
	const span = document.createElement("span");
	span.className = `pill ${className}`;
	span.textContent = text;
	return span;
}

async function loadPosts({ keepSelection = true } = {}) {
	const data = await api("/api/posts");
	state.posts = data.posts;
	state.meta = data.meta;
	refreshDatalists();
	renderList();
	if (keepSelection && state.selectedId) {
		const exists = state.posts.some((p) => p.id === state.selectedId);
		if (!exists) clearEditor();
	}
}

function refreshDatalists() {
	const catList = $("#categoryOptions");
	const tagList = $("#tagOptions");
	catList.innerHTML = state.meta.categories.map((c) => `<option value="${escapeAttr(c.name)}">`).join("");
	tagList.innerHTML = state.meta.tags.map((t) => `<option value="${escapeAttr(t.name)}">`).join("");
}

function escapeAttr(s) {
	return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/* ============================================================= 选择 ==== */

async function selectPost(id, { force = false } = {}) {
	if (!force && state.dirty && !confirm("当前文章有未保存的修改，确定要切换吗？")) return;
	try {
		const data = await api(`/api/post?id=${encodeURIComponent(id)}`);
		state.selectedId = id;
		state.post = data.post;
		renderEditor();
		renderList();
	} catch (error) {
		toast(error.message, "err");
	}
}

function clearEditor() {
	state.selectedId = null;
	state.post = null;
	state.dirty = false;
	$("#editorForm").hidden = true;
	$("#emptyState").hidden = false;
	updateDirtyIndicator();
	renderList();
}

/* ============================================================= 编辑器 == */

function buildFieldControl(field) {
	const wrap = document.createElement("div");
	wrap.className = `field${field.key === "description" ? " wide" : ""}`;
	wrap.dataset.key = field.key;

	const label = document.createElement("label");
	label.textContent = field.label;
	if (field.required) {
		const req = document.createElement("span");
		req.className = "req";
		req.textContent = "*";
		label.appendChild(req);
	}
	wrap.appendChild(label);

	let get = () => "";
	let set = () => {};

	switch (field.type) {
		case "boolean": {
			const sw = document.createElement("label");
			sw.className = "switch";
			const input = document.createElement("input");
			input.type = "checkbox";
			const track = document.createElement("span");
			track.className = "track";
			const text = document.createElement("span");
			text.textContent = field.hint || "";
			sw.append(input, track);
			if (field.hint) sw.appendChild(text);
			wrap.appendChild(sw);
			get = () => input.checked;
			set = (v) => {
				input.checked = v === true;
			};
			break;
		}
		case "textarea": {
			const ta = document.createElement("textarea");
			ta.className = "textarea";
			ta.rows = 2;
			ta.placeholder = field.placeholder || "";
			wrap.appendChild(ta);
			get = () => ta.value;
			set = (v) => {
				ta.value = v ?? "";
			};
			break;
		}
		case "tags": {
			const box = document.createElement("div");
			box.className = "tags-editor";
			const input = document.createElement("input");
			input.placeholder = field.placeholder || "输入后回车";
			input.setAttribute("list", "tagOptions");
			const sync = (values) => {
				state.tagValues = values;
				$$(".tag-pill", box).forEach((n) => n.remove());
				for (const value of values) {
					const pill = document.createElement("span");
					pill.className = "tag-pill";
					const text = document.createElement("span");
					text.textContent = value;
					const btn = document.createElement("button");
					btn.type = "button";
					btn.textContent = "✕";
					btn.addEventListener("click", (e) => {
						e.stopPropagation();
						sync(state.tagValues.filter((v) => v !== value));
					});
					pill.append(text, btn);
					box.insertBefore(pill, input);
				}
			};
			const addFromInput = () => {
				const parts = input.value
					.split(/[,，]/)
					.map((v) => v.trim())
					.filter(Boolean);
				if (!parts.length) return;
				const next = [...state.tagValues];
				for (const part of parts) if (!next.includes(part)) next.push(part);
				input.value = "";
				sync(next);
				markDirty();
			};
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === "," || e.key === "，") {
					e.preventDefault();
					addFromInput();
				} else if (e.key === "Backspace" && !input.value && state.tagValues.length) {
					sync(state.tagValues.slice(0, -1));
					markDirty();
				}
			});
			input.addEventListener("blur", addFromInput);
			box.addEventListener("click", () => input.focus());
			box.appendChild(input);
			wrap.appendChild(box);
			get = () => {
				addFromInput();
				return state.tagValues;
			};
			set = (v) => {
				const values = Array.isArray(v) ? v.map(String) : [];
				input.value = "";
				sync(values);
			};
			break;
		}
		case "image": {
			const row = document.createElement("div");
			row.className = "image-field";
			const input = document.createElement("input");
			input.className = "input";
			input.placeholder = field.placeholder || "";
			const thumb = document.createElement("img");
			thumb.className = "image-thumb";
			thumb.alt = "封面预览";
			const pick = document.createElement("button");
			pick.type = "button";
			pick.className = "btn btn-ghost btn-xs";
			pick.textContent = "上传";
			pick.title = "上传一张图片作为封面";
			pick.addEventListener("click", () => pickCoverFile(input, thumb));
			row.append(input, thumb, pick);
			wrap.appendChild(row);
			const updateThumb = () => {
				const url = resolveAssetUrl(input.value);
				if (url) {
					thumb.src = url;
					thumb.classList.add("show");
				} else {
					thumb.classList.remove("show");
					thumb.removeAttribute("src");
				}
			};
			input.addEventListener("input", () => {
				updateThumb();
				markDirty();
			});
			get = () => input.value.trim();
			set = (v) => {
				input.value = v ?? "";
				setTimeout(updateThumb, 0);
			};
			break;
		}
		case "date": {
			const input = document.createElement("input");
			input.className = "input";
			input.type = "date";
			if (field.placeholder) input.placeholder = field.placeholder;
			input.addEventListener("input", () => markDirty());
			wrap.appendChild(input);
			get = () => input.value;
			set = (v) => {
				const raw = v ? String(v) : "";
				const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
				input.value = m ? m[1] : "";
			};
			break;
		}
		case "number": {
			const input = document.createElement("input");
			input.className = "input";
			input.type = "number";
			input.addEventListener("input", () => markDirty());
			wrap.appendChild(input);
			get = () => (input.value === "" ? "" : Number(input.value));
			set = (v) => {
				input.value = v === undefined || v === null ? "" : String(v);
			};
			break;
		}
		default: {
			const input = document.createElement("input");
			input.className = "input";
			input.placeholder = field.placeholder || "";
			if (field.datalist) input.setAttribute("list", "categoryOptions");
			input.addEventListener("input", () => markDirty());
			wrap.appendChild(input);
			get = () => input.value;
			set = (v) => {
				input.value = v ?? "";
			};
			break;
		}
	}

	ctrls[field.key] = { get, set, wrap, field };
	return wrap;
}

function renderEditor() {
	if (!state.post) return;
	const post = state.post;

	$("#emptyState").hidden = true;
	$("#editorForm").hidden = false;

	const titleInput = $("#fieldTitle");
	titleInput.value = post.values.title || "";
	$("#postPath").textContent = post.file;
	const link = $("#postLink");
	link.textContent = `${post.url}`;
	link.href = `${DEV_PREVIEW_BASE}${post.url}`;
	link.title = "需要先运行 pnpm dev 才能预览站点效果";
	link.hidden = false;

	// 构建字段控件（首次或字段变更时）
	const basicBox = $("#basicFields");
	const advBox = $("#advancedFields");
	if (!basicBox.childElementCount && !advBox.childElementCount) {
		for (const field of state.fields) {
			const ctrl = buildFieldControl(field);
			(field.advanced ? advBox : basicBox).appendChild(ctrl);
		}
	}

	for (const field of state.fields) {
		const ctrl = ctrls[field.key];
		if (!ctrl) continue;
		const value = post.values[field.key];
		ctrl.set(field.type === "boolean" ? value === true : value);
	}

	const body = $("#bodyInput");
	body.value = post.body || "";
	updateBodyStats();
	renderPreview();
	renderAssets();

	state.dirty = false;
	updateDirtyIndicator();
}

function collectValues() {
	const values = {};
	const original = state.post?.values || {};
	for (const field of state.fields) {
		const ctrl = ctrls[field.key];
		if (!ctrl) continue;
		const raw = ctrl.get();
		const had = Object.prototype.hasOwnProperty.call(original, field.key);

		if (field.type === "boolean") {
			if (raw === true) values[field.key] = true;
			else if (had) values[field.key] = false;
			continue;
		}
		if (field.type === "tags") {
			if (raw.length) values[field.key] = raw;
			else if (had) values[field.key] = [];
			continue;
		}
		if (field.type === "number") {
			if (raw !== "" && raw !== null && Number.isFinite(raw)) values[field.key] = raw;
			else if (had) values[field.key] = "";
			continue;
		}
		const text = typeof raw === "string" ? raw : "";
		if (text.trim() !== "") values[field.key] = text;
		else if (had) values[field.key] = "";
	}
	return values;
}

function snapshot() {
	return JSON.stringify({ values: collectValues(), body: $("#bodyInput").value });
}

function markDirty() {
	if (!state.post) return;
	state.dirty = true;
	updateDirtyIndicator();
}

function updateDirtyIndicator() {
	$("#dirtyDot").hidden = !state.dirty;
	$("#btnSave").disabled = state.saving;
}

/* ------------------------------------------------------------- 保存 ---- */

async function savePost(force = false) {
	if (!state.post || state.saving) return;
	const values = collectValues();
	if (!String(values.title ?? "").trim()) {
		toast("标题不能为空", "err");
		$("#fieldTitle").focus();
		return;
	}
	state.saving = true;
	updateDirtyIndicator();
	try {
		const data = await api(`/api/post?id=${encodeURIComponent(state.post.id)}`, {
			method: "PUT",
			body: JSON.stringify({
				values,
				body: $("#bodyInput").value,
				expectedMtime: state.post.mtime,
				force,
			}),
		});
		state.post = data.post;
		state.meta = data.meta;
		state.dirty = false;
		refreshDatalists();
		await loadPosts();
		updateBodyStats();
		renderAssets();
		toast("已保存");
	} catch (error) {
		if (error.status === 409) {
			const ok = confirm(`${error.message}\n\n要用当前内容强制覆盖磁盘上的文件吗？`);
			state.saving = false;
			updateDirtyIndicator();
			if (ok) await savePost(true);
			return;
		}
		toast(error.message, "err");
	} finally {
		state.saving = false;
		updateDirtyIndicator();
	}
}

/* ---------------------------------------------------------- 正文统计 ---- */

function countWords(text) {
	const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
	const latin = (text.match(/[A-Za-z0-9_']+/g) || []).length;
	return cjk + latin;
}

function updateBodyStats() {
	const body = $("#bodyInput").value;
	const words = countWords(body);
	const minutes = Math.max(1, Math.round(words / 300));
	$("#bodyStats").textContent = `${words} 字 · 约 ${minutes} 分钟`;
}

/* ============================================================== 预览 ==== */

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	}[c]));
}

function resolveAssetUrl(raw) {
	const value = String(raw || "").trim();
	if (!value) return "";
	if (/^(https?:|data:|blob:|mailto:)/i.test(value)) return value;
	if (value.startsWith("/")) return value;
	// 相对路径 -> 通过后端读取
	const dir = state.post?.dirRel && state.post.dirRel !== "." ? state.post.dirRel : "";
	const rel = value.replace(/^\.\//, "").replace(/^\//, "");
	const joined = dir ? `${dir}/${rel}` : rel;
	const parts = [];
	for (const seg of joined.split("/")) {
		if (seg === "..") parts.pop();
		else if (seg && seg !== ".") parts.push(seg);
	}
	return `/api/asset?path=${encodeURIComponent(parts.join("/"))}`;
}

const IMG_PLACEHOLDER = "\u0000";

function inlineMd(text, inBlock) {
	let codes = [];
	let out = escapeHtml(text);
	out = out.replace(/`([^`]+)`/g, (_, code) => {
		codes.push(code);
		return `\u0000${codes.length - 1}\u0000`;
	});
	out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, src) => {
		const url = resolveAssetUrl(src.replace(/&amp;/g, "&"));
		return `<img src="${escapeHtml(url)}" alt="${alt}" loading="lazy">`;
	});
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, label, href) => {
		const url = href.replace(/&amp;/g, "&");
		const external = /^https?:/i.test(url);
		return `<a href="${escapeHtml(url)}"${external ? ' target="_blank" rel="noopener"' : ""}>${label}</a>`;
	});
	out = out
		.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
		.replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
		.replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
		.replace(/(^|[\s(（])\*([^*\n]+)\*/g, "$1<em>$2</em>")
		.replace(/(^|[\s(（])_([^_\n]+)_/g, "$1<em>$2</em>");
	out = out.replace(/\u0000(\d+)\u0000/g, (_, idx) => `<code>${codes[Number(idx)]}</code>`);
	if (!inBlock) out = out.replace(/\n/g, "<br>");
	return out;
}

function renderMarkdown(src) {
	if (!src || !src.trim()) {
		return '<p class="empty-preview">还没有内容，开始在左侧书写吧…</p>';
	}
	const lines = src.replace(/\r\n/g, "\n").split("\n");
	const html = [];
	let i = 0;
	const isTableSep = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(line);

	while (i < lines.length) {
		const line = lines[i];

		if (!line.trim()) {
			i += 1;
			continue;
		}

		// 代码块
		const fence = /^\s*(`{3,}|~{3,})\s*([\w+#-]*)\s*$/.exec(line);
		if (fence) {
			const marker = fence[1];
			const lang = fence[2];
			const buf = [];
			i += 1;
			while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
				buf.push(lines[i]);
				i += 1;
			}
			i += 1;
			html.push(
				`<pre${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${escapeHtml(buf.join("\n"))}</code></pre>`,
			);
			continue;
		}

		// 标题
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			const text = heading[2].replace(/\s+#+\s*$/, "");
			html.push(`<h${level}>${inlineMd(text, true)}</h${level}>`);
			i += 1;
			continue;
		}

		// 分隔线
		if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
			html.push("<hr>");
			i += 1;
			continue;
		}

		// 引用
		if (/^\s*>\s?/.test(line)) {
			const buf = [];
			while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
				buf.push(lines[i].replace(/^\s*>\s?/, ""));
				i += 1;
			}
			html.push(`<blockquote>${inlineMd(buf.join("\n"), false)}</blockquote>`);
			continue;
		}

		// 表格
		if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
			const parseRow = (l) =>
				l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
			const head = parseRow(line);
			i += 2;
			const rows = [];
			while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
				rows.push(parseRow(lines[i]));
				i += 1;
			}
			html.push(
				`<table><thead><tr>${head.map((c) => `<th>${inlineMd(c, true)}</th>`).join("")}</tr></thead>` +
					`<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c, true)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
			);
			continue;
		}

		// 列表
		const listStart = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
		if (listStart) {
			const ordered = /\d/.test(listStart[1]);
			const items = [];
			while (i < lines.length) {
				const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
				if (m) {
					items.push(m[2]);
					i += 1;
					continue;
				}
				// 列表项续行
				if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
					items[items.length - 1] += `\n${lines[i].trim()}`;
					i += 1;
					continue;
				}
				break;
			}
			const tag = ordered ? "ol" : "ul";
			html.push(
				`<${tag}>${items.map((item) => `<li>${inlineMd(item, false)}</li>`).join("")}</${tag}>`,
			);
			continue;
		}

		// 原始 HTML 块
		if (/^\s*<[a-zA-Z/]/.test(line)) {
			html.push(line);
			i += 1;
			continue;
		}

		// 段落
		const buf = [];
		while (i < lines.length) {
			const cur = lines[i];
			if (!cur.trim()) break;
			if (/^(#{1,6}\s|>|\s*([-*+]|\d+[.)])\s|```|~~~)/.test(cur)) break;
			if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(cur)) break;
			buf.push(cur);
			i += 1;
		}
		if (!buf.length) {
			buf.push(line);
			i += 1;
		}
		html.push(`<p>${inlineMd(buf.join("\n"), false)}</p>`);
	}

	return html.join("\n");
}

const renderPreview = () => {
	const body = $("#bodyInput").value;
	$("#bodyPreview").innerHTML = renderMarkdown(body);
	$("#bodyPreview").querySelectorAll("img").forEach((img) => {
		img.addEventListener("error", () => {
			img.style.opacity = "0.35";
			img.title = "图片无法预览";
		});
	});
};

/* ============================================================== 附件 ==== */

function renderAssets() {
	const box = $("#assetList");
	box.innerHTML = "";
	const assets = state.post?.assets || [];
	if (!assets.length) {
		const empty = document.createElement("span");
		empty.className = "asset-empty";
		empty.textContent = "暂无附件。上传图片后会自动把文章转为文件夹模式（如 article/article.md + cover.jpg）。";
		box.appendChild(empty);
		return;
	}
	for (const asset of assets) {
		const card = document.createElement("div");
		card.className = "asset";

		if (asset.isImage) {
			const img = document.createElement("img");
			img.src = `/api/asset?path=${encodeURIComponent(asset.rel)}`;
			img.loading = "lazy";
			img.alt = asset.name;
			card.appendChild(img);
		} else {
			const ph = document.createElement("div");
			ph.style.cssText =
				"height:68px;display:flex;align-items:center;justify-content:center;font-size:22px;background:var(--bg-deep)";
			ph.textContent = "📄";
			card.appendChild(ph);
		}

		const name = document.createElement("div");
		name.className = "asset-name";
		name.textContent = `${asset.name} · ${fmtSize(asset.size)}`;
		name.title = asset.rel;
		card.appendChild(name);

		const actions = document.createElement("div");
		actions.className = "asset-actions";

		if (asset.isImage) {
			actions.appendChild(
				makeAssetBtn("封面", () => {
					const input = ctrls.image?.wrap.querySelector("input");
					if (input) {
						input.value = `./${asset.name}`;
						input.dispatchEvent(new Event("input"));
						markDirty();
						toast("已设为封面（记得保存）");
					}
				}),
			);
			actions.appendChild(makeAssetBtn("插入", () => insertAtCursor(`![${asset.name}](./${asset.name})`)));
		}
		actions.appendChild(makeAssetBtn("路径", () => copyText(`./${asset.name}`)));
		actions.appendChild(
			makeAssetBtn("删除", async () => {
				if (!confirm(`确定删除附件 ${asset.name}？`)) return;
				try {
					await api(`/api/asset?id=${encodeURIComponent(state.post.id)}&name=${encodeURIComponent(asset.name)}`, {
						method: "DELETE",
					});
					state.post.assets = state.post.assets.filter((a) => a.name !== asset.name);
					renderAssets();
					toast("已删除附件");
				} catch (error) {
					toast(error.message, "err");
				}
			}),
		);

		card.appendChild(actions);
		box.appendChild(card);
	}
}

function makeAssetBtn(text, handler) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.textContent = text;
	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		handler();
	});
	return btn;
}

function insertAtCursor(text) {
	const ta = $("#bodyInput");
	const start = ta.selectionStart ?? ta.value.length;
	const end = ta.selectionEnd ?? ta.value.length;
	const before = ta.value.slice(0, start);
	const after = ta.value.slice(end);
	const needsBreak = before && !before.endsWith("\n") ? "\n" : "";
	ta.value = `${before}${needsBreak}${text}\n${after}`;
	ta.selectionStart = ta.selectionEnd = (before + needsBreak + text + "\n").length;
	ta.focus();
	markDirty();
	updateBodyStats();
	renderPreview();
}

async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		toast(`已复制：${text}`);
	} catch {
		toast(`复制失败，请手动复制：${text}`, "err");
	}
}

/* ---------------------------------------------------------- 上传图片 ---- */

function readFileAsDataURL(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(new Error("读取文件失败"));
		reader.readAsDataURL(file);
	});
}

async function uploadImages(files, { asCover = false } = {}) {
	if (!state.post || !files.length) return [];
	const list = [...files].filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(f.name));
	if (!list.length) {
		toast("只支持图片文件", "err");
		return [];
	}
	const uploaded = [];
	for (const file of list) {
		try {
			const dataUrl = await readFileAsDataURL(file);
			const data = await api(`/api/post/upload?id=${encodeURIComponent(state.post.id)}`, {
				method: "POST",
				body: JSON.stringify({ filename: file.name, dataUrl, id: state.post.id }),
			});
			uploaded.push(data.imageValue);
			if (data.migrated) {
				toast(`已自动转为文件夹模式：${data.migrated.to}`);
			}
			// 迁移后文件路径可能变化，重新同步
			state.selectedId = data.post.id;
			state.post = data.post;
			$("#postPath").textContent = data.post.file;
		} catch (error) {
			toast(`${file.name}: ${error.message}`, "err", 4000);
		}
	}
	if (uploaded.length) {
		renderAssets();
		await loadPosts();
		if (asCover) {
			const input = ctrls.image?.wrap.querySelector("input");
			if (input) {
				input.value = uploaded[uploaded.length - 1];
				input.dispatchEvent(new Event("input"));
				markDirty();
			}
			toast("封面已更新（记得保存）");
		} else {
			toast(`已上传 ${uploaded.length} 张图片`);
		}
	}
	return uploaded;
}

function pickCoverFile(inputEl, thumbEl) {
	const picker = document.createElement("input");
	picker.type = "file";
	picker.accept = "image/*";
	picker.addEventListener("change", async () => {
		const files = picker.files;
		if (!files?.length) return;
		const uploaded = await uploadImages(files, { asCover: false });
		if (uploaded.length) {
			inputEl.value = uploaded[uploaded.length - 1];
			markDirty();
			const url = resolveAssetUrl(inputEl.value);
			if (url && thumbEl) {
				thumbEl.src = url;
				thumbEl.classList.add("show");
			}
		}
	});
	picker.click();
}

/* ============================================================= 新建 ==== */

function openCreateModal() {
	$("#createModal").hidden = false;
	$("#newTitle").value = "";
	$("#newSlug").value = "";
	$("#newDate").value = todayISO();
	$("#newCategory").value = "";
	$("#newTags").value = "";
	$("#newDraft").checked = false;
	$("#newFolder").checked = false;
	updateCreatePreview();
	setTimeout(() => $("#newTitle").focus(), 30);
}

function updateCreatePreview() {
	const title = $("#newTitle").value.trim() || "未命名";
	const slug = sanitizeSlug($("#newSlug").value.trim() || title) || "article";
	const folder = $("#newFolder").checked;
	$("#newPreviewPath").textContent = folder
		? `src/content/posts/${slug}/${slug}.md`
		: `src/content/posts/${slug}.md`;
}

async function createPost() {
	const title = $("#newTitle").value.trim();
	if (!title) {
		toast("请填写标题", "err");
		$("#newTitle").focus();
		return;
	}
	const tags = $("#newTags")
		.value.split(/[,，]/)
		.map((v) => v.trim())
		.filter(Boolean);
	const payload = {
		title,
		slug: $("#newSlug").value.trim() || undefined,
		folder: $("#newFolder").checked,
		values: {
			published: $("#newDate").value || todayISO(),
			category: $("#newCategory").value.trim(),
			tags,
			draft: $("#newDraft").checked,
		},
	};
	try {
		const data = await api("/api/post", { method: "POST", body: JSON.stringify(payload) });
		$("#createModal").hidden = true;
		state.meta = data.meta;
		await loadPosts();
		await selectPost(data.post.id, { force: true });
		toast(`已创建：${data.post.file}`);
		$("#fieldTitle").focus();
		$("#fieldTitle").select();
	} catch (error) {
		toast(error.message, "err", 4000);
	}
}

/* =========================================================== 回收站 ==== */

async function openTrash() {
	$("#trashModal").hidden = false;
	const body = $("#trashBody");
	body.innerHTML = "<p class='asset-empty'>加载中…</p>";
	try {
		const data = await api("/api/trash");
		body.innerHTML = "";
		if (!data.items.length) {
			body.innerHTML = "<p class='asset-empty'>回收站是空的。</p>";
			return;
		}
		for (const item of data.items) {
			const row = document.createElement("div");
			row.className = "trash-item";
			const info = document.createElement("div");
			info.className = "trash-info";
			const name = document.createElement("div");
			name.className = "trash-name";
			name.textContent = item.rel || item.trashId;
			const sub = document.createElement("div");
			sub.className = "trash-sub";
			const when = item.deletedAt ? new Date(item.deletedAt).toLocaleString() : "";
			sub.textContent = `${item.kind === "folder" ? "文件夹" : "单文件"} · ${when} · ${item.files.length} 个文件`;
			info.append(name, sub);

			const actions = document.createElement("div");
			actions.style.cssText = "display:flex;gap:6px;flex-shrink:0";

			const restoreBtn = document.createElement("button");
			restoreBtn.className = "btn btn-ghost btn-xs";
			restoreBtn.textContent = "恢复";
			restoreBtn.addEventListener("click", async () => {
				try {
					await api("/api/trash/restore", {
						method: "POST",
						body: JSON.stringify({ trashId: item.trashId }),
					});
					toast("已恢复");
					await loadPosts();
					openTrash();
				} catch (error) {
					toast(error.message, "err");
				}
			});

			const purgeBtn = document.createElement("button");
			purgeBtn.className = "btn btn-ghost btn-xs";
			purgeBtn.textContent = "彻底删除";
			purgeBtn.style.color = "var(--danger)";
			purgeBtn.addEventListener("click", async () => {
				if (!confirm("彻底删除后无法恢复，确定吗？")) return;
				try {
					await api("/api/trash/purge", {
						method: "POST",
						body: JSON.stringify({ trashId: item.trashId }),
					});
					toast("已彻底删除");
					openTrash();
				} catch (error) {
					toast(error.message, "err");
				}
			});

			actions.append(restoreBtn, purgeBtn);
			row.append(info, actions);
			body.appendChild(row);
		}
	} catch (error) {
		body.innerHTML = `<p class="asset-empty">${escapeHtml(error.message)}</p>`;
	}
}

async function deleteCurrentPost() {
	if (!state.post) return;
	const ok = confirm(
		`确定把《${state.post.values.title || state.post.file}》移入回收站吗？\n\n文件：${state.post.file}\n可从「回收站」中恢复。`,
	);
	if (!ok) return;
	try {
		await api(`/api/post?id=${encodeURIComponent(state.post.id)}`, { method: "DELETE" });
		toast("已移入回收站");
		state.selectedId = null;
		state.post = null;
		state.dirty = false;
		clearEditor();
		await loadPosts();
	} catch (error) {
		toast(error.message, "err");
	}
}

/* ============================================================ 其它动作 == */

async function duplicatePost() {
	if (!state.post) return;
	const values = collectValues();
	const newTitle = `${values.title || state.post.values.title} (副本)`;
	const baseSlug = sanitizeSlug(newTitle);
	try {
		const data = await api("/api/post", {
			method: "POST",
			body: JSON.stringify({
				title: newTitle,
				slug: `${baseSlug}-${Date.now().toString(36).slice(-4)}`,
				folder: false,
				values: {
					published: todayISO(),
					description: values.description || "",
					category: values.category || "",
					tags: Array.isArray(values.tags) ? values.tags : [],
					draft: true,
				},
				body: $("#bodyInput").value,
			}),
		});
		await loadPosts();
		await selectPost(data.post.id, { force: true });
		toast("已复制为新文章（草稿）");
	} catch (error) {
		toast(error.message, "err", 4000);
	}
}

function setView(view) {
	state.view = view;
	$$("#viewTabs .tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
	const split = $("#splitView");
	split.classList.remove("view-edit", "view-preview");
	if (view === "edit") split.classList.add("view-edit");
	if (view === "preview") split.classList.add("view-preview");
}

/* ============================================================== 绑定 ==== */

function toggleModal(id, show) {
	const el = document.getElementById(id);
	if (!el) return;
	el.hidden = !show;
}

function bindEvents() {
	$("#search").addEventListener("input", debounce((e) => {
		state.query = e.target.value;
		renderList();
	}, 120));

	$("#filterChips").addEventListener("click", (e) => {
		const btn = e.target.closest(".chip");
		if (!btn) return;
		state.filter = btn.dataset.filter;
		$$("#filterChips .chip").forEach((c) => c.classList.toggle("active", c === btn));
		renderList();
	});

	$("#sort").addEventListener("change", (e) => {
		state.sort = e.target.value;
		renderList();
	});

	$("#btnReload").addEventListener("click", async () => {
		await loadPosts();
		if (state.selectedId) await selectPost(state.selectedId, { force: true });
		toast("列表已刷新");
	});

	$("#btnNew").addEventListener("click", openCreateModal);
	$("#btnNewEmpty").addEventListener("click", openCreateModal);
	$("#btnTrash").addEventListener("click", openTrash);
	$("#btnSave").addEventListener("click", () => savePost(false));

	$("#fieldTitle").addEventListener("input", () => {
		markDirty();
		const item = [...document.querySelectorAll(".post-item")].find(
			(n) => n.dataset.id === state.selectedId,
		);
		if (item) $(".post-title", item).textContent = $("#fieldTitle").value || "(无标题)";
	});

	const bodyInput = $("#bodyInput");
	const renderPreviewDebounced = debounce(renderPreview, 160);
	bodyInput.addEventListener("input", () => {
		markDirty();
		updateBodyStats();
		renderPreviewDebounced();
	});

	// Tab 键插入缩进
	bodyInput.addEventListener("keydown", (e) => {
		if (e.key === "Tab") {
			e.preventDefault();
			const start = bodyInput.selectionStart;
			const end = bodyInput.selectionEnd;
			bodyInput.value = `${bodyInput.value.slice(0, start)}\t${bodyInput.value.slice(end)}`;
			bodyInput.selectionStart = bodyInput.selectionEnd = start + 1;
			markDirty();
		}
	});

	// 拖拽/粘贴图片
	const panel = $(".body-panel");
	const dropHint = $("#dropHint");
	const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
	let dragDepth = 0;
	const resetDrag = () => {
		dragDepth = 0;
		dropHint.hidden = true;
	};

	panel.addEventListener("dragenter", (e) => {
		if (!hasFiles(e)) return;
		e.preventDefault();
		dragDepth += 1;
		dropHint.hidden = false;
	});
	panel.addEventListener("dragover", (e) => {
		if (!hasFiles(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		dropHint.hidden = false;
	});
	panel.addEventListener("dragleave", (e) => {
		// 在子元素之间移动也会触发 dragleave，用计数避免闪烁
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0 || e.relatedTarget === null) dropHint.hidden = true;
	});
	panel.addEventListener("drop", (e) => {
		resetDrag();
		if (hasFiles(e)) e.preventDefault();
	});
	// 拖拽取消 / 拖出窗口 / 失去焦点时兜底隐藏
	document.addEventListener("dragend", resetDrag);
	document.addEventListener("dragleave", (e) => {
		// relatedTarget 为 null 代表指针离开了整个窗口
		if (e.relatedTarget === null) resetDrag();
	});
	window.addEventListener("blur", resetDrag);
	document.addEventListener("drop", resetDrag);

	panel.addEventListener("drop", async (e) => {
		const files = e.dataTransfer?.files;
		if (!files?.length) return;
		const uploaded = await uploadImages(files);
		if (uploaded.length) {
			for (const name of uploaded) insertAtCursor(`![](${name})`);
		}
	});
	document.addEventListener("paste", async (e) => {
		if (!state.post) return;
		const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
		if (!files.length) return;
		e.preventDefault();
		const uploaded = await uploadImages(files);
		if (uploaded.length) {
			for (const name of uploaded) insertAtCursor(`![](${name})`);
		}
	});

	$("#fileInput").addEventListener("change", async (e) => {
		const files = e.target.files;
		if (files?.length) await uploadImages(files);
		e.target.value = "";
	});

	$("#viewTabs").addEventListener("click", (e) => {
		const tab = e.target.closest(".tab");
		if (tab) setView(tab.dataset.view);
	});

	$("#btnToggleAdvanced").addEventListener("click", () => {
		state.advancedOpen = !state.advancedOpen;
		$("#advancedFields").hidden = !state.advancedOpen;
		$("#btnToggleAdvanced").textContent = state.advancedOpen ? "高级字段 ▴" : "高级字段 ▾";
	});

	$("#btnOpenSite").addEventListener("click", () => {
		if (!state.post) return;
		window.open(`${DEV_PREVIEW_BASE}${state.post.url}`, "_blank", "noopener");
	});

	// 更多菜单
	const moreMenu = $("#moreMenu");
	$("#btnMore").addEventListener("click", (e) => {
		e.stopPropagation();
		moreMenu.hidden = !moreMenu.hidden;
	});
	document.addEventListener("click", () => {
		moreMenu.hidden = true;
	});
	moreMenu.addEventListener("click", async (e) => {
		const btn = e.target.closest("button[data-action]");
		if (!btn) return;
		moreMenu.hidden = true;
		const action = btn.dataset.action;
		if (action === "delete") return deleteCurrentPost();
		if (action === "duplicate") return duplicatePost();
		if (action === "toggle-draft") {
			const ctrl = ctrls.draft;
			const input = ctrl?.wrap.querySelector("input");
			if (input) {
				input.checked = !input.checked;
				markDirty();
				toast(input.checked ? "已切换为草稿" : "已切换为已发布");
			}
			return;
		}
		if (action === "open-folder") {
			try {
				await api("/api/reveal", {
					method: "POST",
					body: JSON.stringify({ id: state.post.id }),
				});
			} catch (error) {
				toast(error.message, "err");
			}
		}
	});

	// 弹窗关闭
	document.addEventListener("click", (e) => {
		const closeId = e.target.closest("[data-close]")?.dataset.close;
		if (closeId) toggleModal(closeId, false);
		if (e.target.classList.contains("modal-backdrop")) e.target.hidden = true;
	});

	$("#newTitle").addEventListener("input", updateCreatePreview);
	$("#newSlug").addEventListener("input", updateCreatePreview);
	$("#newFolder").addEventListener("change", updateCreatePreview);
	$("#newTitle").addEventListener("keydown", (e) => {
		if (e.key === "Enter") createPost();
	});
	$("#btnCreateConfirm").addEventListener("click", createPost);

	// 快捷键
	document.addEventListener("keydown", (e) => {
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.key.toLowerCase() === "s") {
			e.preventDefault();
			savePost(false);
		} else if (mod && e.key.toLowerCase() === "k") {
			e.preventDefault();
			$("#search").focus();
			$("#search").select();
		} else if (mod && e.key.toLowerCase() === "n" && !e.shiftKey) {
			const tag = document.activeElement?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA") return;
			e.preventDefault();
			openCreateModal();
		} else if (e.key === "Escape") {
			$$(".modal-backdrop").forEach((m) => (m.hidden = true));
		}
	});

	window.addEventListener("beforeunload", (e) => {
		if (state.dirty) {
			e.preventDefault();
			e.returnValue = "";
		}
	});
}

/* ============================================================== 启动 ==== */

async function init() {
	bindEvents();
	setView("split");
	try {
		const schema = await api("/api/schema");
		state.fields = schema.fields;
		state.order = schema.order;
		await loadPosts();
		const first = filterPosts()[0];
		if (first) await selectPost(first.id, { force: true });
	} catch (error) {
		toast(`初始化失败：${error.message}`, "err", 6000);
		console.error(error);
	}
}

init();
