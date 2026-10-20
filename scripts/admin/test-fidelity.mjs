/**
 * frontmatter 保真度回归测试（只读，不会修改任何文章）
 *
 * 目的：确认「读入 -> 原样序列化」后，文章文件逐字节不变。
 * 运行：pnpm admin:test:fidelity
 */

import fs from "fs";
import path from "path";

import { FIELD_MAP, FIELD_ORDER, normalizeValue } from "./lib/fields.js";
import {
	buildFile,
	entriesToObject,
	parseFrontmatter,
	serializeFrontmatter,
	splitFrontmatter,
} from "./lib/frontmatter.js";
import { POSTS_DIR } from "./lib/store.js";

function walk(dir, out = []) {
	let entries = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name.startsWith(".")) continue;
			walk(abs, out);
		} else if (/\.(md|mdx)$/i.test(entry.name)) {
			out.push(abs);
		}
	}
	return out;
}

const files = walk(POSTS_DIR);
if (!files.length) {
	console.log(`没有找到文章：${POSTS_DIR}`);
	process.exit(0);
}

let pass = 0;
const failures = [];

for (const abs of files) {
	const raw = fs.readFileSync(abs, "utf8");
	const parts = splitFrontmatter(raw);
	const entries = parseFrontmatter(parts.frontmatter);
	const data = entriesToObject(entries);

	// 模拟「一个字都不改」的保存
	const values = {};
	for (const key of FIELD_ORDER) {
		if (data[key] === undefined) continue;
		const normalized = normalizeValue(FIELD_MAP[key], data[key]);
		if (normalized === undefined || normalized === "") continue;
		values[key] = normalized;
	}
	for (const [key, value] of Object.entries(data)) {
		if (!FIELD_MAP[key]) values[key] = value;
	}

	const frontmatterText = serializeFrontmatter({
		originalEntries: entries,
		values,
		order: FIELD_ORDER,
		fields: FIELD_MAP,
		eol: parts.eol,
	});
	const out = buildFile({
		frontmatterText,
		body: parts.body,
		sep: parts.sep,
		eol: parts.eol,
	});

	if (out === raw) {
		pass += 1;
	} else {
		let i = 0;
		while (i < Math.min(raw.length, out.length) && raw[i] === out[i]) i += 1;
		failures.push({
			file: path.relative(POSTS_DIR, abs),
			index: i,
			orig: JSON.stringify(raw.slice(Math.max(0, i - 20), i + 30)),
			out: JSON.stringify(out.slice(Math.max(0, i - 20), i + 30)),
		});
	}
}

for (const f of failures) {
	console.error(`\n❌ ${f.file}`);
	console.error(`   首个差异位置 ${f.index}`);
	console.error(`   原始: ${f.orig}`);
	console.error(`   重写: ${f.out}`);
}

console.log(
	`\n${failures.length === 0 ? "✅" : "❌"} frontmatter 往返保真：${pass} 篇通过，${failures.length} 篇失败（共 ${files.length} 篇）`,
);
process.exit(failures.length ? 1 : 0);

