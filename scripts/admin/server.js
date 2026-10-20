#!/usr/bin/env node
/**
 * Mizuki 文章管理台（本地 Web GUI）
 *
 * 用法：
 *   pnpm admin              # 默认 http://127.0.0.1:4399
 *   pnpm admin -- --port 4500 --no-open
 *
 * 设计：零第三方依赖（仅 Node 内置模块），只监听 127.0.0.1。
 */

import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

import { FIELDS, FIELD_ORDER } from "./lib/fields.js";
import {
	assetPath,
	createPost,
	deleteAsset,
	getMeta,
	listPosts,
	listTrash,
	POSTS_DIR,
	purgeTrash,
	readPost,
	restoreTrash,
	ROOT_DIR,
	savePost,
	TRASH_DIR,
	trashPost,
	uploadImage,
} from "./lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

/* ------------------------------------------------------------- 参数解析 ---- */

const argv = process.argv.slice(2);
function getArg(name, fallback) {
	const idx = argv.findIndex((a) => a === `--${name}` || a === name);
	if (idx === -1) return fallback;
	const next = argv[idx + 1];
	if (!next || next.startsWith("--")) return true;
	return next;
}
const PORT = Number(getArg("port", process.env.ADMIN_PORT || 4399));
const HOST = getArg("host", process.env.ADMIN_HOST || "127.0.0.1");
const SHOULD_OPEN = !argv.includes("--no-open") && process.env.ADMIN_NO_OPEN !== "1";

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".woff2": "font/woff2",
};

/* --------------------------------------------------------------- 工具 ---- */

function sendJson(res, status, data) {
	const body = JSON.stringify(data);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
	});
	res.end(body);
}

function sendError(res, error) {
	const status = error?.status && Number.isInteger(error.status) ? error.status : 500;
	if (status >= 500) console.error("[admin]", error);
	sendJson(res, status, { ok: false, error: error?.message || "服务器内部错误" });
}

function readBody(req, limit = 40 * 1024 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(new Error("请求体过大"), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (!raw) return resolve({});
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(Object.assign(new Error("请求体不是合法 JSON"), { status: 400 }));
			}
		});
		req.on("error", reject);
	});
}

function serveStatic(res, relPath) {
	const safeRel = relPath.replace(/^\/+/, "").replace(/\\/g, "/");
	if (safeRel.split("/").includes("..")) {
		sendJson(res, 400, { ok: false, error: "非法路径" });
		return;
	}
	const abs = path.join(PUBLIC_DIR, safeRel || "index.html");
	if (!abs.startsWith(PUBLIC_DIR)) {
		sendJson(res, 400, { ok: false, error: "非法路径" });
		return;
	}
	if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
		sendJson(res, 404, { ok: false, error: `未找到 ${relPath}` });
		return;
	}
	const ext = path.extname(abs).toLowerCase();
	const stat = fs.statSync(abs);
	res.writeHead(200, {
		"Content-Type": MIME[ext] || "application/octet-stream",
		"Content-Length": stat.size,
		"Cache-Control": "no-store",
	});
	fs.createReadStream(abs).pipe(res);
}

/* --------------------------------------------------------------- 路由 ---- */

async function handleApi(req, res, url) {
	const { pathname, searchParams } = url;
	const id = searchParams.get("id") || "";
	const method = req.method || "GET";

	// GET /api/ping
	if (pathname === "/api/ping" && method === "GET") {
		return sendJson(res, 200, { ok: true, root: ROOT_DIR, postsDir: POSTS_DIR });
	}

	// GET /api/schema
	if (pathname === "/api/schema" && method === "GET") {
		return sendJson(res, 200, { ok: true, fields: FIELDS, order: FIELD_ORDER });
	}

	// GET /api/posts
	if (pathname === "/api/posts" && method === "GET") {
		return sendJson(res, 200, { ok: true, posts: listPosts(), meta: getMeta() });
	}

	// /api/post
	if (pathname === "/api/post") {
		if (method === "GET") {
			return sendJson(res, 200, { ok: true, post: readPost(id) });
		}
		if (method === "PUT" || method === "PATCH") {
			const payload = await readBody(req);
			const post = savePost(id, payload);
			return sendJson(res, 200, { ok: true, post, meta: getMeta() });
		}
		if (method === "DELETE") {
			const result = trashPost(id);
			return sendJson(res, 200, { ok: true, ...result, meta: getMeta() });
		}
		if (method === "POST") {
			const payload = await readBody(req);
			const post = createPost(payload);
			return sendJson(res, 200, { ok: true, post, meta: getMeta() });
		}
	}

	// POST /api/post/upload
	if (pathname === "/api/post/upload" && method === "POST") {
		const payload = await readBody(req);
		const result = uploadImage(id || payload.id, payload);
		return sendJson(res, 200, { ok: true, ...result, meta: getMeta() });
	}

	// /api/asset
	if (pathname === "/api/asset") {
		if (method === "DELETE") {
			const result = deleteAsset(id, searchParams.get("name") || "");
			return sendJson(res, 200, { ok: true, ...result });
		}
		const rel = searchParams.get("path") || "";
		const abs = assetPath(rel);
		const ext = path.extname(abs).toLowerCase();
		const stat = fs.statSync(abs);
		res.writeHead(200, {
			"Content-Type": MIME[ext] || "application/octet-stream",
			"Content-Length": stat.size,
			"Cache-Control": "no-store",
		});
		return fs.createReadStream(abs).pipe(res);
	}

	// /api/trash
	if (pathname === "/api/trash" && method === "GET") {
		return sendJson(res, 200, { ok: true, items: listTrash() });
	}
	if (pathname === "/api/trash/restore" && method === "POST") {
		const payload = await readBody(req);
		const result = restoreTrash(payload.trashId || searchParams.get("trashId"));
		return sendJson(res, 200, { ok: true, ...result, meta: getMeta() });
	}
	if (pathname === "/api/trash/purge" && method === "POST") {
		const payload = await readBody(req);
		const result = purgeTrash(payload.trashId || searchParams.get("trashId"));
		return sendJson(res, 200, { ok: true, ...result });
	}

	// POST /api/reveal —— 在系统文件管理器中显示
	if (pathname === "/api/reveal" && method === "POST") {
		const payload = await readBody(req);
		const abs = assetPath(payload.id || id);
		revealInFileManager(abs);
		return sendJson(res, 200, { ok: true });
	}

	return sendJson(res, 404, { ok: false, error: `未知接口：${pathname}` });
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
	const { pathname } = url;

	try {
		if (pathname.startsWith("/api/")) {
			await handleApi(req, res, url);
			return;
		}
		if (req.method === "GET" || req.method === "HEAD") {
			serveStatic(res, decodeURIComponent(pathname));
			return;
		}
		sendJson(res, 405, { ok: false, error: "不支持的方法" });
	} catch (error) {
		sendError(res, error);
	}
});

server.listen(PORT, HOST, () => {
	const url = `http://${HOST}:${PORT}/`;
	console.log("");
	console.log("  📝 Mizuki 文章管理台已启动");
	console.log(`  ➜  本地地址: ${url}`);
	console.log(`  ➜  文章目录: ${path.relative(ROOT_DIR, POSTS_DIR)}`);
	console.log(`  ➜  回收站:   ${path.relative(ROOT_DIR, TRASH_DIR)}`);
	console.log("  ➜  按 Ctrl+C 退出\n");

	if (SHOULD_OPEN) openBrowser(url);
});

server.on("error", (error) => {
	if (error.code === "EADDRINUSE") {
		console.error(`\n端口 ${PORT} 已被占用，请换一个端口：pnpm admin -- --port ${PORT + 1}\n`);
		process.exit(1);
	}
	console.error(error);
	process.exit(1);
});

function openBrowser(url) {
	try {
		if (process.platform === "win32") {
			spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
		} else if (process.platform === "darwin") {
			spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		} else {
			spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
		}
	} catch {
		/* 打不开浏览器不影响服务 */
	}
}

function revealInFileManager(absPath) {
	try {
		if (process.platform === "win32") {
			spawn("explorer.exe", [`/select,${absPath}`], { detached: true, stdio: "ignore" }).unref();
		} else if (process.platform === "darwin") {
			spawn("open", ["-R", absPath], { detached: true, stdio: "ignore" }).unref();
		} else {
			spawn("xdg-open", [path.dirname(absPath)], { detached: true, stdio: "ignore" }).unref();
		}
	} catch {
		/* 忽略 */
	}
}

process.on("SIGINT", () => {
	console.log("\n已退出管理台。");
	process.exit(0);
});
