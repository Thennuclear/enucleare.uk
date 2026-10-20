/**
 * 文章存储层：读取 / 保存 / 新建 / 回收站 / 图片上传
 * 所有操作都限定在 src/content/posts 目录内。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
	FIELD_MAP,
	FIELD_ORDER,
	normalizeValue,
	pickKnown,
} from "./fields.js";
import {
	buildFile,
	entriesToObject,
	parseFrontmatter,
	serializeFrontmatter,
	splitFrontmatter,
} from "./frontmatter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "../../..");
export const POSTS_DIR = path.join(ROOT_DIR, "src", "content", "posts");
export const TRASH_DIR = path.join(ROOT_DIR, "src", "content", ".trash");

const POST_EXT = /\.(md|mdx)$/i;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/* ------------------------------------------------------------- 路径工具 ---- */

/** 把相对路径安全地解析到 posts 目录之内 */
export function safeResolve(relPath) {
	if (typeof relPath !== "string" || !relPath.trim()) {
		throw httpError(400, "缺少文章路径");
	}
	const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
	if (normalized.split("/").includes("..")) {
		throw httpError(400, "非法路径");
	}
	const abs = path.resolve(POSTS_DIR, normalized);
	if (abs !== POSTS_DIR && !abs.startsWith(POSTS_DIR + path.sep)) {
		throw httpError(400, "路径越界");
	}
	return abs;
}

export function toRel(abs) {
	return path.relative(POSTS_DIR, abs).replace(/\\/g, "/");
}

export function httpError(status, message) {
	const err = new Error(message);
	err.status = status;
	return err;
}

/** 文章 id（相对路径，posix），也是前端使用的唯一标识 */
export function postIdOf(abs) {
	return toRel(abs);
}

/** slug：相对路径去掉扩展名，即 Astro 集合的 entry.id */
export function slugOf(relFile) {
	return relFile.replace(POST_EXT, "");
}

/** 站内访问地址 */
export function urlOf(relFile) {
	const slug = slugOf(relFile);
	const segments = slug.split("/");
	// 文件夹模式 `foo/foo.md` 与 Astro 的 entry.id 一致，保持原样
	return `/posts/${segments.map(encodeURIComponent).join("/")}/`;
}

/* --------------------------------------------------------------- 列表 ---- */

function walk(dir, out = []) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			walk(abs, out);
		} else if (entry.isFile() && POST_EXT.test(entry.name)) {
			out.push(abs);
		}
	}
	return out;
}

/** 统计中英文混排字数 */
export function countWords(text) {
	const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
	const latin = (text.match(/[A-Za-z0-9_']+/g) || []).length;
	return cjk + latin;
}

export function listPosts({ includeBody = false } = {}) {
	const files = walk(POSTS_DIR);
	const posts = files.map((abs) => {
		const rel = postIdOf(abs);
		const stat = fs.statSync(abs);
		let data = {};
		let body = "";
		let parseError = null;
		try {
			const raw = fs.readFileSync(abs, "utf8");
			const parts = splitFrontmatter(raw);
			const entries = parseFrontmatter(parts.frontmatter);
			data = entriesToObject(entries);
			body = parts.body;
		} catch (error) {
			parseError = error.message;
		}

		const tags = Array.isArray(data.tags)
			? data.tags
			: data.tags
				? [String(data.tags)]
				: [];

		const dir = path.dirname(abs);
		const assets = listAssetsInternal(abs);

		return {
			id: rel,
			file: rel,
			slug: slugOf(rel),
			url: urlOf(rel),
			title: data.title ? String(data.title) : path.basename(rel, path.extname(rel)),
			published: data.published ? String(data.published) : "",
			updated: data.updated ? String(data.updated) : "",
			description: data.description ? String(data.description) : "",
			image: data.image ? String(data.image) : "",
			tags,
			category: data.category ? String(data.category) : "",
			lang: data.lang ? String(data.lang) : "",
			draft: data.draft === true || data.draft === "true",
			pinned: data.pinned === true || data.pinned === "true",
			encrypted: data.encrypted === true || data.encrypted === "true",
			permalink: data.permalink ? String(data.permalink) : "",
			alias: data.alias ? String(data.alias) : "",
			inFolder: dir !== POSTS_DIR,
			assetCount: assets.length,
			size: stat.size,
			mtime: stat.mtimeMs,
			mtimeText: stat.mtime.toISOString(),
			wordCount: countWords(body),
			charCount: body.length,
			parseError,
			...(includeBody ? { body } : {}),
		};
	});

	posts.sort((a, b) => {
		if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
		const da = a.published || "";
		const db = b.published || "";
		if (da !== db) return db.localeCompare(da);
		return a.title.localeCompare(b.title, "zh");
	});

	return posts;
}

function listAssetsInternal(absFile) {
	const dir = path.dirname(absFile);
	const out = [];
	let entries = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (POST_EXT.test(entry.name)) continue;
		if (entry.name.startsWith(".")) continue;
		const abs = path.join(dir, entry.name);
		const stat = fs.statSync(abs);
		out.push({
			name: entry.name,
			size: stat.size,
			rel: path.relative(POSTS_DIR, abs).replace(/\\/g, "/"),
			isImage: /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(entry.name),
		});
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/* --------------------------------------------------------------- 读取 ---- */

export function readPost(relFile) {
	const abs = safeResolve(relFile);
	if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
		throw httpError(404, `文章不存在：${relFile}`);
	}
	const raw = fs.readFileSync(abs, "utf8");
	const parts = splitFrontmatter(raw);
	const entries = parseFrontmatter(parts.frontmatter);
	const data = entriesToObject(entries);
	const stat = fs.statSync(abs);

	const values = {};
	for (const key of FIELD_ORDER) {
		if (data[key] === undefined) continue;
		values[key] = normalizeValue(FIELD_MAP[key], data[key]);
	}
	// 空字符串统一为 undefined，避免表单显示空串
	for (const key of Object.keys(values)) {
		if (values[key] === "") values[key] = undefined;
	}

	const unknown = {};
	for (const [key, value] of Object.entries(data)) {
		if (!FIELD_MAP[key]) unknown[key] = value;
	}

	return {
		id: postIdOf(abs),
		file: postIdOf(abs),
		slug: slugOf(postIdOf(abs)),
		url: urlOf(postIdOf(abs)),
		values,
		unknown,
		body: parts.body,
		raw,
		hasFrontmatter: parts.hasFrontmatter,
		sep: parts.sep,
		eol: parts.eol,
		mtime: stat.mtimeMs,
		size: stat.size,
		assets: listAssetsInternal(abs),
		inFolder: path.dirname(abs) !== POSTS_DIR,
		dirRel: path.relative(POSTS_DIR, path.dirname(abs)).replace(/\\/g, "/"),
	};
}

/* --------------------------------------------------------------- 保存 ---- */

function backupBeforeWrite(abs) {
	if (!fs.existsSync(abs)) return;
	try {
		const rel = postIdOf(abs);
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const backupPath = path.join(TRASH_DIR, "versions", stamp, rel);
		fs.mkdirSync(path.dirname(backupPath), { recursive: true });
		fs.copyFileSync(abs, backupPath);
	} catch {
		/* 备份失败不应阻塞保存 */
	}
}

export function savePost(relFile, payload = {}) {
	const abs = safeResolve(relFile);
	if (!fs.existsSync(abs)) throw httpError(404, `文章不存在：${relFile}`);

	const { values = {}, body, expectedMtime, force = false } = payload;
	if (values && typeof values === "object" && Object.prototype.hasOwnProperty.call(values, "title")) {
		if (String(values.title ?? "").trim() === "") {
			throw httpError(400, "标题不能为空");
		}
	}
	const stat = fs.statSync(abs);
	if (!force && typeof expectedMtime === "number" && Math.abs(stat.mtimeMs - expectedMtime) > 1.5) {
		throw httpError(409, "文件已被其它程序修改，请刷新后再保存（或选择强制覆盖）");
	}

	const raw = fs.readFileSync(abs, "utf8");
	const parts = splitFrontmatter(raw);
	const originalEntries = parseFrontmatter(parts.frontmatter);
	const originalData = entriesToObject(originalEntries);

	// 合并：只覆盖传入的字段
	const merged = { ...originalData };
	for (const [key, value] of Object.entries(values)) {
		if (!FIELD_MAP[key]) continue;
		const normalized = normalizeValue(FIELD_MAP[key], value);
		if (normalized === undefined || normalized === "") {
			delete merged[key];
			merged[key] = undefined;
		} else {
			merged[key] = normalized;
		}
	}
	// 保留原有未知字段
	for (const [key, value] of Object.entries(originalData)) {
		if (!FIELD_MAP[key] && merged[key] === undefined) merged[key] = value;
	}
	for (const key of Object.keys(merged)) {
		if (merged[key] === undefined) delete merged[key];
	}
	if (!String(merged.title ?? "").trim()) {
		throw httpError(400, "文章必须包含 title 字段");
	}

	const eol = parts.eol;
	const frontmatterText = serializeFrontmatter({
		originalEntries,
		values: merged,
		order: FIELD_ORDER,
		fields: FIELD_MAP,
		eol,
	});

	const nextBody = body === undefined || body === null ? parts.body : String(body);
	const content = buildFile({ frontmatterText, body: nextBody, sep: parts.sep, eol });

	backupBeforeWrite(abs);
	fs.writeFileSync(abs, content, "utf8");

	return readPost(relFile);
}

/* --------------------------------------------------------------- 新建 ---- */

export function sanitizeSlug(input) {
	let slug = String(input ?? "")
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[.\-\s]+/, "")
		.replace(/[.\-\s]+$/, "")
		.trim();
	if (!slug) slug = "";
	if (slug.length > 80) slug = slug.slice(0, 80);
	return slug;
}

export function todayISO() {
	const now = new Date();
	const utc = new Date(now.getTime() + 8 * 60 * 60 * 1000); // UTC+8，与站点时区一致
	return utc.toISOString().slice(0, 10);
}

const DEFAULT_BODY = `在这里开始写正文……

`;

export function createPost(payload = {}) {
	const { title, slug: rawSlug, folder = false, values = {}, body } = payload;

	const cleanTitle = String(title ?? "").trim();
	if (!cleanTitle) throw httpError(400, "标题不能为空");

	let slug = sanitizeSlug(rawSlug || cleanTitle);
	if (!slug) throw httpError(400, "无法根据标题生成文件名，请手动填写 slug");

	const useFolder = Boolean(folder);
	const relFile = useFolder ? `${slug}/${slug}.md` : `${slug}.md`;
	const abs = safeResolve(relFile);

	if (fs.existsSync(abs)) throw httpError(409, `已存在同名文章：${relFile}`);
	if (useFolder && fs.existsSync(path.join(POSTS_DIR, slug)) && fs.readdirSync(path.join(POSTS_DIR, slug)).length) {
		throw httpError(409, `目录已存在且不为空：${slug}/`);
	}

	const finalValues = {
		title: cleanTitle,
		published: values.published || todayISO(),
		...(values.updated !== undefined ? { updated: values.updated } : {}),
		...(values.description ? { description: values.description } : {}),
		...(values.image ? { image: values.image } : {}),
		...(Array.isArray(values.tags) && values.tags.length ? { tags: values.tags } : {}),
		...(values.category ? { category: values.category } : {}),
		...(values.draft ? { draft: true } : {}),
		...(values.pinned ? { pinned: true } : {}),
		...(values.lang ? { lang: values.lang } : {}),
	};

	const frontmatterText = serializeFrontmatter({
		originalEntries: [],
		values: finalValues,
		order: FIELD_ORDER,
		fields: FIELD_MAP,
		eol: "\n",
	});

	const content = buildFile({
		frontmatterText,
		body: body === undefined ? DEFAULT_BODY : String(body),
		eol: "\n",
	});

	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, "utf8");

	return readPost(relFile);
}

/* ------------------------------------------------------------- 回收站 ---- */

function stampDir() {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(TRASH_DIR, "items", stamp);
}

export function trashPost(relFile) {
	const abs = safeResolve(relFile);
	if (!fs.existsSync(abs)) throw httpError(404, `文章不存在：${relFile}`);

	const rel = postIdOf(abs);
	const targetDir = stampDir();
	const targetAbs = path.join(targetDir, rel);

	fs.mkdirSync(targetDir, { recursive: true });

	// 文件夹模式：把整个目录一起移入回收站（含图片）
	const inFolder = path.dirname(abs) !== POSTS_DIR;
	if (inFolder) {
		const folderAbs = path.dirname(abs);
		const folderRel = path.relative(POSTS_DIR, folderAbs).replace(/\\/g, "/");
		const folderTarget = path.join(targetDir, folderRel);
		fs.mkdirSync(path.dirname(folderTarget), { recursive: true });
		moveDir(folderAbs, folderTarget);
		const meta = {
			rel,
			kind: "folder",
			folder: folderRel,
			deletedAt: new Date().toISOString(),
		};
		fs.writeFileSync(
			path.join(targetDir, "__meta__.json"),
			JSON.stringify(meta, null, 2),
			"utf8",
		);
		return { trashId: path.relative(TRASH_DIR, targetDir).replace(/\\/g, "/"), restoredTarget: folderRel };
	}

	fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
	fs.copyFileSync(abs, targetAbs);
	fs.unlinkSync(abs);
	const meta = {
		rel,
		kind: "file",
		deletedAt: new Date().toISOString(),
	};
	fs.writeFileSync(
		path.join(targetDir, "__meta__.json"),
		JSON.stringify(meta, null, 2),
		"utf8",
	);
	return { trashId: path.relative(TRASH_DIR, targetDir).replace(/\\/g, "/"), restoredTarget: rel };
}

function moveDir(from, to) {
	try {
		fs.renameSync(from, to);
	} catch {
		fs.cpSync(from, to, { recursive: true });
		fs.rmSync(from, { recursive: true, force: true });
	}
}

export function listTrash() {
	const base = path.join(TRASH_DIR, "items");
	if (!fs.existsSync(base)) return [];
	const dirs = fs
		.readdirSync(base, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort()
		.reverse();

	return dirs.map((name) => {
		const abs = path.join(base, name);
		let meta = null;
		try {
			meta = JSON.parse(fs.readFileSync(path.join(abs, "__meta__.json"), "utf8"));
		} catch {
			meta = null;
		}
		let files = [];
		try {
			files = listFilesRecursive(abs).map((f) =>
				path.relative(abs, f).replace(/\\/g, "/"),
			);
		} catch {
			files = [];
		}
		return {
			trashId: `items/${name}`,
			deletedAt: meta?.deletedAt || "",
			rel: meta?.rel || files.find((f) => POST_EXT.test(f)) || "",
			kind: meta?.kind || "file",
			files,
		};
	});
}

function listFilesRecursive(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) listFilesRecursive(abs, out);
		else out.push(abs);
	}
	return out;
}

export function restoreTrash(trashId) {
	if (!trashId || trashId.includes("..")) throw httpError(400, "非法回收站标识");
	const abs = path.resolve(TRASH_DIR, trashId);
	if (!abs.startsWith(TRASH_DIR + path.sep)) throw httpError(400, "路径越界");
	if (!fs.existsSync(abs)) throw httpError(404, "回收站条目不存在");

	let meta = null;
	try {
		meta = JSON.parse(fs.readFileSync(path.join(abs, "__meta__.json"), "utf8"));
	} catch {
		meta = null;
	}
	if (!meta?.rel) throw httpError(400, "回收站条目缺少元数据");

	const targetAbs = safeResolve(meta.rel);

	if (meta.kind === "folder") {
		const folderRel = meta.folder || path.dirname(meta.rel);
		const srcFolder = path.join(abs, folderRel);
		const destFolder = path.join(POSTS_DIR, folderRel);
		if (!fs.existsSync(srcFolder)) throw httpError(404, "回收站中的目录已丢失");
		if (fs.existsSync(destFolder)) throw httpError(409, `目标目录已存在：${folderRel}`);
		fs.mkdirSync(path.dirname(destFolder), { recursive: true });
		moveDir(srcFolder, destFolder);
		fs.rmSync(abs, { recursive: true, force: true });
		return { file: meta.rel };
	}

	const src = path.join(abs, meta.rel);
	if (!fs.existsSync(src)) throw httpError(404, "回收站中的文件已丢失");
	if (fs.existsSync(targetAbs)) throw httpError(409, `目标文件已存在：${meta.rel}`);
	fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
	fs.copyFileSync(src, targetAbs);
	fs.rmSync(abs, { recursive: true, force: true });
	return { file: meta.rel };
}

export function purgeTrash(trashId) {
	if (!trashId || trashId.includes("..")) throw httpError(400, "非法回收站标识");
	const abs = path.resolve(TRASH_DIR, trashId);
	if (!abs.startsWith(path.join(TRASH_DIR, "items") + path.sep)) {
		throw httpError(400, "只能彻底删除 items 下的条目");
	}
	if (!fs.existsSync(abs)) throw httpError(404, "回收站条目不存在");
	fs.rmSync(abs, { recursive: true, force: true });
	return { ok: true };
}

/* --------------------------------------------------------------- 图片 ---- */

function sanitizeFileName(name) {
	const ext = path.extname(name).toLowerCase();
	const base = path
		.basename(name, path.extname(name))
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[.\-\s]+|\.+$/g, "");
	const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
	return `${base || "image"}${safeExt}`;
}

/**
 * 上传图片到文章所在目录。
 * 若文章是「单文件模式」，会自动迁移为「文件夹模式」（便于 `./xxx.jpg` 相对引用）。
 */
export function uploadImage(relFile, { filename, base64, dataUrl }) {
	const abs = safeResolve(relFile);
	if (!fs.existsSync(abs)) throw httpError(404, `文章不存在：${relFile}`);

	let buffer;
	if (typeof base64 === "string" && base64) {
		buffer = Buffer.from(base64, "base64");
	} else if (typeof dataUrl === "string" && dataUrl) {
		const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
		if (!m) throw httpError(400, "图片数据格式不正确");
		buffer = Buffer.from(m[2], "base64");
	} else {
		throw httpError(400, "缺少图片数据");
	}
	if (!buffer.length) throw httpError(400, "图片为空");
	if (buffer.length > MAX_IMAGE_BYTES) {
		throw httpError(413, `图片过大（上限 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB）`);
	}

	let target = abs;
	let migrated = null;
	let baseName = sanitizeFileName(filename || "image.png");

	if (path.dirname(abs) === POSTS_DIR) {
		// 单文件模式 -> 迁移为文件夹模式
		const stem = path.basename(abs, path.extname(abs));
		const folderRel = stem;
		const folderAbs = path.join(POSTS_DIR, folderRel);
		if (fs.existsSync(folderAbs)) {
			throw httpError(
				409,
				`无法自动迁移：目录 ${folderRel}/ 已存在，请先把该目录改名或清空`,
			);
		}
		fs.mkdirSync(folderAbs, { recursive: true });
		const newAbs = path.join(folderAbs, path.basename(abs));
		fs.renameSync(abs, newAbs);
		target = newAbs;
		migrated = { from: postIdOf(abs), to: postIdOf(newAbs) };
	}

	const dir = path.dirname(target);
	let finalPath = path.join(dir, baseName);
	let counter = 1;
	while (fs.existsSync(finalPath)) {
		const ext = path.extname(baseName);
		const stem = path.basename(baseName, ext);
		finalPath = path.join(dir, `${stem}-${counter}${ext}`);
		counter += 1;
	}
	fs.writeFileSync(finalPath, buffer);

	const imageRelValue = `./${path.basename(finalPath)}`;

	return {
		post: readPost(postIdOf(target)),
		migrated,
		imageValue: imageRelValue,
		fileName: path.basename(finalPath),
		size: buffer.length,
	};
}

export function deleteAsset(relFile, assetName) {
	const abs = safeResolve(relFile);
	const dir = path.dirname(abs);
	const assets = listAssetsInternal(abs);
	if (!assets.some((a) => a.name === assetName)) {
		throw httpError(404, `附件不存在：${assetName}`);
	}
	const target = path.join(dir, path.basename(assetName));
	if (!target.startsWith(dir + path.sep)) throw httpError(400, "非法附件名");
	fs.unlinkSync(target);
	return { ok: true };
}

/** 提供附件读取（前端预览用） */
export function assetPath(relAsset) {
	const abs = safeResolve(relAsset);
	if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
		throw httpError(404, "附件不存在");
	}
	return abs;
}

/* --------------------------------------------------------------- 元信息 ---- */

export function getMeta() {
	const posts = listPosts();
	const categories = new Map();
	const tags = new Map();
	for (const p of posts) {
		if (p.category) categories.set(p.category, (categories.get(p.category) || 0) + 1);
		for (const t of p.tags) tags.set(t, (tags.get(t) || 0) + 1);
	}
	const toSorted = (map) =>
		[...map.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
			.map(([name, count]) => ({ name, count }));
	return {
		categories: toSorted(categories),
		tags: toSorted(tags),
		counts: {
			total: posts.length,
			draft: posts.filter((p) => p.draft).length,
			published: posts.filter((p) => !p.draft).length,
			pinned: posts.filter((p) => p.pinned).length,
		},
	};
}
