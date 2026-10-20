/**
 * 文章管理台 API 端到端自测
 *
 * 会做这些事（全部可回收）：
 * 1. 新建一篇「管理台自测文章」，上传图片、移入回收站、恢复、彻底删除；
 * 2. 临时修改一篇真实文章的描述与标签，验证后**写回原始内容**；
 * 3. 在 src/content/.trash/versions/ 留下若干备份（可随时删除）。
 *
 * 运行：pnpm admin:test
 * 环境变量：ADMIN_TEST_PORT（默认 4411）
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server.js");
const PORT = Number(process.env.ADMIN_TEST_PORT || 4411);
const BASE = `http://127.0.0.1:${PORT}`;

const { POSTS_DIR, ROOT_DIR } = await import("./lib/store.js");

let failures = 0;
const cleanup = [];

function check(name, cond, extra = "") {
	console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` :: ${extra}` : ""}`);
	if (!cond) failures += 1;
}

async function api(pathname, options = {}) {
	const res = await fetch(BASE + pathname, {
		headers: { "Content-Type": "application/json" },
		...options,
	});
	const text = await res.text();
	let data;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = { raw: text };
	}
	return { status: res.status, data };
}

async function waitForServer(timeoutMs = 8000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const res = await fetch(BASE + "/api/ping");
			if (res.ok) return true;
		} catch {
			/* 还没起来 */
		}
		await new Promise((r) => setTimeout(r, 120));
	}
	return false;
}

const server = spawn(process.execPath, [SERVER, "--port", String(PORT), "--no-open"], {
	cwd: ROOT_DIR,
	stdio: "ignore",
});

try {
	const up = await waitForServer();
	check("服务器启动成功", up, `port ${PORT}`);
	if (!up) throw new Error("服务器未能在超时内启动");

	/* ---------------- 基础接口 ---------------- */
	const ping = await api("/api/ping");
	check("GET /api/ping", ping.status === 200 && ping.data.ok);

	const schema = await api("/api/schema");
	check("GET /api/schema", (schema.data.fields?.length || 0) >= 18, `${schema.data.fields?.length} 个字段`);

	const list = await api("/api/posts");
	const posts = list.data.posts || [];
	check("GET /api/posts", posts.length > 0, `${posts.length} 篇`);
	check("置顶文章排在前面", posts[0]?.pinned === true, posts[0]?.title);
	check("meta 统计存在", !!list.data.meta?.counts, JSON.stringify(list.data.meta?.counts));

	/* ---------------- 读取 + 无改动保存（必须字节不变） ---------------- */
	const sample = posts.find((p) => !p.inFolder && !p.parseError) || posts[0];
	const detail = await api(`/api/post?id=${encodeURIComponent(sample.id)}`);
	check("GET /api/post", detail.status === 200 && !!detail.data.post, sample.id);
	if (!detail.data.post) throw new Error("读取文章失败");

	const abs = path.join(POSTS_DIR, sample.id);
	const original = fs.readFileSync(abs, "utf8");
	const same = await api(`/api/post?id=${encodeURIComponent(sample.id)}`, {
		method: "PUT",
		body: JSON.stringify({
			values: detail.data.post.values,
			body: detail.data.post.body,
			expectedMtime: detail.data.post.mtime,
		}),
	});
	check("PUT 无改动保存", same.status === 200, same.data.error || "");
	check("无改动保存后文件字节不变", fs.readFileSync(abs, "utf8") === original, sample.id);

	/* ---------------- 修改属性 ---------------- */
	const changed = {
		...detail.data.post.values,
		description: "管理台自测描述（稍后会还原）",
		tags: ["自测", "临时"],
	};
	const put = await api(`/api/post?id=${encodeURIComponent(sample.id)}`, {
		method: "PUT",
		body: JSON.stringify({ values: changed, body: detail.data.post.body }),
	});
	check("PUT 修改属性", put.status === 200, put.data.error || "");
	const afterChange = fs.readFileSync(abs, "utf8");
	check("description 写入成功", afterChange.includes("管理台自测描述"));
	check("tags 写为行内数组", /tags: \[自测, 临时\]/.test(afterChange));
	check("标题等其它字段保留", afterChange.includes(String(changed.title).replace(/^'|'$/g, "").slice(0, 4)));

	const conflict = await api(`/api/post?id=${encodeURIComponent(sample.id)}`, {
		method: "PUT",
		body: JSON.stringify({ values: changed, body: "x", expectedMtime: 1 }),
	});
	check("过期 mtime 触发 409 冲突", conflict.status === 409, `${conflict.status}`);

	const emptyTitle = await api(`/api/post?id=${encodeURIComponent(sample.id)}`, {
		method: "PUT",
		body: JSON.stringify({ values: { title: "   " }, body: "" }),
	});
	check("拒绝空标题", emptyTitle.status === 400, `${emptyTitle.status}`);

	// 还原原文件
	fs.writeFileSync(abs, original, "utf8");
	check("已还原被改动的文章", fs.readFileSync(abs, "utf8") === original, sample.id);

	/* ---------------- 新建 / 重名 / 上传 ---------------- */
	const created = await api("/api/post", {
		method: "POST",
		body: JSON.stringify({
			title: "管理台自测文章",
			values: { published: "2026-01-02", category: "自测", tags: ["a", "b"], draft: true },
			body: "自测正文。\n",
		}),
	});
	check("POST 新建文章", created.status === 200 && !!created.data.post, created.data.error || "");
	const createdFile = created.data.post?.file;
	if (createdFile) cleanup.push(createdFile);
	const createdAbs = path.join(POSTS_DIR, createdFile || "");
	check("新建文件已落盘", fs.existsSync(createdAbs), createdFile);
	const createdRaw = fs.existsSync(createdAbs) ? fs.readFileSync(createdAbs, "utf8") : "";
	check("新建含 draft: true", createdRaw.includes("draft: true"));
	check("新建含行内 tags", createdRaw.includes("tags: [a, b]"));
	check("新建日期未加引号", createdRaw.includes("published: 2026-01-02"));

	const dup = await api("/api/post", {
		method: "POST",
		body: JSON.stringify({ title: "管理台自测文章", values: {} }),
	});
	check("同名新建被拒绝", dup.status === 409, `${dup.status}`);

	const png =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/2gAAAABJRU5ErkJggg==";
	const uploadRes = await api(`/api/post/upload?id=${encodeURIComponent(createdFile)}`, {
		method: "POST",
		body: JSON.stringify({ filename: "cover.png", base64: png, id: createdFile }),
	});
	check("POST 上传图片", uploadRes.status === 200, uploadRes.data.error || "");
	check("单文件自动迁移为文件夹", !!uploadRes.data.migrated, JSON.stringify(uploadRes.data.migrated));
	const migratedFile = uploadRes.data.post?.file;
	if (migratedFile && migratedFile !== createdFile) cleanup.push(migratedFile);
	check("迁移后文件存在", fs.existsSync(path.join(POSTS_DIR, migratedFile || "")), migratedFile);
	check("图片已写入文章目录", fs.existsSync(path.join(POSTS_DIR, path.dirname(migratedFile || ""), "cover.png")));
	check("返回 ./cover.png", uploadRes.data.imageValue === "./cover.png", uploadRes.data.imageValue);

	/* ---------------- 回收站 ---------------- */
	const del = await api(`/api/post?id=${encodeURIComponent(migratedFile)}`, { method: "DELETE" });
	check("DELETE 移入回收站", del.status === 200, del.data.error || "");
	check("原文件已移走", !fs.existsSync(path.join(POSTS_DIR, migratedFile || "")));
	check("原目录已移走", !fs.existsSync(path.join(POSTS_DIR, path.dirname(migratedFile || ""))));

	const trash = await api("/api/trash");
	check("GET /api/trash", (trash.data.items?.length || 0) >= 1, `${trash.data.items?.length} 项`);
	const restored = await api("/api/trash/restore", {
		method: "POST",
		body: JSON.stringify({ trashId: trash.data.items?.[0]?.trashId }),
	});
	check("回收站恢复", restored.status === 200, restored.data.error || "");
	check("恢复后文件回来", fs.existsSync(path.join(POSTS_DIR, migratedFile || "")));

	await api(`/api/post?id=${encodeURIComponent(migratedFile)}`, { method: "DELETE" });
	const trash2 = await api("/api/trash");
	const purge = await api("/api/trash/purge", {
		method: "POST",
		body: JSON.stringify({ trashId: trash2.data.items?.[0]?.trashId }),
	});
	check("彻底删除回收站条目", purge.status === 200, purge.data.error || "");
	cleanup.length = 0;

	/* ---------------- 静态资源与安全 ---------------- */
	const home = await fetch(BASE + "/");
	check("首页可访问", home.status === 200 && (await home.text()).includes("文章管理台"));
	check("app.js 可访问", (await fetch(BASE + "/app.js")).status === 200);
	check("style.css 可访问", (await fetch(BASE + "/style.css")).status === 200);

	const traversal = await api("/api/post?id=../../package.json");
	check("拒绝路径穿越（文章）", [400, 404].includes(traversal.status), `${traversal.status}`);
	const traversal2 = await api("/api/asset?path=../config.ts");
	check("拒绝路径穿越（附件）", [400, 404].includes(traversal2.status), `${traversal2.status}`);
} catch (error) {
	console.error("自测异常:", error);
	failures += 1;
} finally {
	for (const file of cleanup) {
		const absFile = path.join(POSTS_DIR, String(file));
		try {
			if (fs.existsSync(absFile)) fs.rmSync(absFile, { force: true });
			const dir = path.dirname(absFile);
			if (dir !== POSTS_DIR && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* 忽略清理失败 */
		}
	}
	server.kill();
	console.log(`\n${failures === 0 ? "全部通过 🎉" : `${failures} 项失败`}`);
	process.exit(failures ? 1 : 0);
}

