/**
 * 轻量 frontmatter 解析 / 序列化（零依赖）
 *
 * 设计目标：
 * 1. 只支持博客 frontmatter 实际会用到的 YAML 子集（标量、行内数组、块数组、块标量）。
 * 2. 最大程度保真：未被修改的字段会原样输出原始文本行，避免重排/丢注释。
 * 3. 不引入 js-yaml 等依赖。
 */

const BOM = "\uFEFF";

/** 拆分 frontmatter 与正文 */
export function splitFrontmatter(text) {
	if (typeof text !== "string") text = "";
	if (text.startsWith(BOM)) text = text.slice(1);

	const eol = detectEol(text);
	const re = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*/;
	const m = re.exec(text);
	if (!m) {
		return { hasFrontmatter: false, frontmatter: "", body: text, sep: "", eol };
	}
	const rest = text.slice(m[0].length);
	// sep：结束分隔行之后的所有空行（原样保留，保证不改变正文前的空行数量）
	const sep = /^(?:[ \t]*\r?\n)*/.exec(rest)[0];
	return {
		hasFrontmatter: true,
		frontmatter: m[1],
		body: rest.slice(sep.length),
		sep,
		eol,
	};
}

/** 探测文本主要换行符 */
export function detectEol(text) {
	const crlf = (text.match(/\r\n/g) || []).length;
	const lf = (text.match(/(?<!\r)\n/g) || []).length;
	return crlf > lf ? "\r\n" : "\n";
}

/* ---------------------------------------------------------------- 解析 ---- */

const KEY_LINE = /^([A-Za-z_$][\w$.\-]*)[ \t]*:(?:[ \t]+(.*))?$/;

/**
 * 解析 frontmatter 文本为条目数组
 * @returns {Array<{kind:'entry'|'comment'|'blank', key?:string, value?:any,
 *   valueKind?:string, rawLines:string[]}>}
 */
export function parseFrontmatter(src) {
	const lines = src.replace(/\r\n/g, "\n").split("\n");
	const entries = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		if (!line.trim()) {
			entries.push({ kind: "blank", rawLines: [line] });
			i += 1;
			continue;
		}

		if (/^[ \t]*#/.test(line)) {
			entries.push({ kind: "comment", rawLines: [line] });
			i += 1;
			continue;
		}

		const m = KEY_LINE.exec(line);
		if (!m) {
			// 无法识别的顶层内容，原样保留
			entries.push({ kind: "raw", rawLines: [line] });
			i += 1;
			continue;
		}

		const key = m[1];
		const restRaw = m[2] ?? "";
		const rest = restRaw.trim();
		const rawLines = [line];
		let valueKind = "scalar";
		let value = "";

		// 收集属于该键的后续缩进行
		const consumed = collectIndented(lines, i + 1);
		const childLines = consumed.lines;

		if (rest.startsWith("|") || rest.startsWith(">")) {
			valueKind = "block-scalar";
			value = childLines.map((l) => l.replace(/^[ \t]{1,}/, "")).join("\n").replace(/\n+$/, "");
			rawLines.push(...childLines);
			i = consumed.next;
		} else if (rest === "") {
			if (childLines.some((l) => /^[ \t]*-[ \t]/.test(l) || /^[ \t]*-$/.test(l))) {
				valueKind = "block-array";
				value = childLines
					.filter((l) => /^[ \t]*-[ \t]/.test(l) || /^[ \t]*-$/.test(l))
					.map((l) => parseScalar(l.replace(/^[ \t]*-[ \t]?/, "")));
			} else if (childLines.length > 0) {
				valueKind = "complex";
				value = childLines.join("\n");
			} else {
				valueKind = "null";
				value = "";
			}
			rawLines.push(...childLines);
			i = consumed.next;
		} else if (isInlineArray(rest)) {
			valueKind = "inline-array";
			value = parseInlineArray(rest);
			i = consumed.next;
			rawLines.push(...childLines);
		} else {
			valueKind = "scalar";
			value = parseScalar(rest);
			i = consumed.next;
			rawLines.push(...childLines);
		}

		entries.push({
			kind: "entry",
			key,
			value,
			valueKind,
			rawLines,
		});
	}

	return entries;
}

/** 取出紧随其后的缩进行（含其中夹带的空行） */
function collectIndented(lines, start) {
	const out = [];
	let j = start;
	while (j < lines.length) {
		const line = lines[j];
		if (/^[ \t]+/.test(line)) {
			out.push(line);
			j += 1;
			continue;
		}
		// 空行：若后面仍有缩进行则归入当前键
		if (!line.trim()) {
			let k = j + 1;
			while (k < lines.length && !lines[k].trim()) k += 1;
			if (k < lines.length && /^[ \t]+/.test(lines[k])) {
				for (let n = j; n < k; n += 1) out.push(lines[n]);
				j = k;
				continue;
			}
		}
		break;
	}
	return { lines: out, next: j };
}

function isInlineArray(s) {
	return s.startsWith("[") && s.endsWith("]");
}

function parseInlineArray(s) {
	const inner = s.slice(1, -1).trim();
	if (!inner) return [];
	return splitTopLevel(inner, ",").map((part) => parseScalar(part.trim()));
}

/** 按分隔符切分，忽略引号内的分隔符 */
function splitTopLevel(s, sep) {
	const parts = [];
	let buf = "";
	let quote = null;
	for (let i = 0; i < s.length; i += 1) {
		const ch = s[i];
		if (quote) {
			buf += ch;
			if (ch === quote) {
				if (quote === "'" && s[i + 1] === "'") {
					buf += s[i + 1];
					i += 1;
				} else {
					quote = null;
				}
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			buf += ch;
			continue;
		}
		if (ch === sep) {
			parts.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	parts.push(buf);
	return parts;
}

/** 解析单个标量值 */
export function parseScalar(raw) {
	const s = String(raw ?? "").trim();
	if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
		return s.slice(1, -1).replace(/''/g, "'");
	}
	if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
		return s
			.slice(1, -1)
			.replace(/\\n/g, "\n")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
	return s;
}

/** 将条目数组转为普通对象 */
export function entriesToObject(entries) {
	const obj = {};
	for (const e of entries) {
		if (e.kind === "entry") obj[e.key] = e.value;
	}
	return obj;
}

/* -------------------------------------------------------------- 序列化 ---- */

const RESERVED_WORDS = new Set([
	"true",
	"false",
	"null",
	"~",
	"yes",
	"no",
	"on",
	"off",
	"y",
	"n",
]);

/** 判断字符串是否需要加引号输出 */
function needsQuote(s) {
	if (s === "") return true;
	if (/^[\s]|[\s]$/.test(s)) return true;
	if (/[\n\r\t]/.test(s)) return true;
	if (RESERVED_WORDS.has(s.toLowerCase())) return true;
	if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s)) return true;
	if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;
	if (/^[!&*?{}[\]|>@`"'%#,~+-]/.test(s)) return true;
	if (/:\s|\s#/.test(s)) return true;
	return false;
}

/** 渲染标量 */
export function renderScalar(value) {
	const s = value === null || value === undefined ? "" : String(value);
	if (/[\n\r]/.test(s)) {
		return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "")}"`;
	}
	if (!needsQuote(s)) return s;
	if (!s.includes("'")) return `'${s}'`;
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 渲染字段值（按字段类型决定格式） */
export function renderValue(field, value) {
	if (field?.type === "boolean") return value ? "true" : "false";
	if (field?.type === "date") {
		const s = String(value ?? "").trim();
		// 日期保持不加引号（YAML 中 2024-01-01 会被解析为日期，与 z.date() 一致）
		if (/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]*(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return s;
		return renderScalar(s);
	}
	if (field?.type === "tags" || Array.isArray(value)) {
		const arr = Array.isArray(value) ? value : value ? [String(value)] : [];
		if (arr.length === 0) return "[]";
		return `[${arr.map((v) => renderScalar(String(v))).join(", ")}]`;
	}
	if (field?.type === "number") {
		const n = Number(value);
		return Number.isFinite(n) ? String(n) : renderScalar(value);
	}
	return renderScalar(value);
}

/** 深比较（数组/标量） */
export function sameValue(a, b) {
	const norm = (v) => {
		if (v === null || v === undefined) return "";
		if (Array.isArray(v)) return v.map((x) => String(x).trim());
		if (typeof v === "boolean") return v ? "true" : "false";
		return String(v);
	};
	return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * 序列化 frontmatter
 * @param {object} options
 * @param {Array} options.originalEntries 原始条目（可空）
 * @param {object} options.values 新的字段值 {key: value}
 * @param {Array} options.order 字段输出顺序（schema 顺序）
 * @param {Map|object} options.fields 字段定义 {key: {type}}
 * @param {string} options.eol 换行符
 * @returns {{text:string, keptRaw:boolean}}
 */
export function serializeFrontmatter({
	originalEntries = [],
	values = {},
	order = [],
	fields = {},
	eol = "\n",
}) {
	const fieldMap = fields instanceof Map ? Object.fromEntries(fields) : fields;
	const originalKeys = new Set();
	for (const e of originalEntries) if (e.kind === "entry") originalKeys.add(e.key);

	const out = [];
	const isDeleted = (key) => {
		const v = values[key];
		return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
	};
	const emit = (key, original) => {
		const field = fieldMap[key];
		const value = values[key];

		if (original) {
			if (isDeleted(key)) return; // 字段被清空 -> 移除该行
			// 值未变化 -> 原样保留原始文本（保留注释/缩进/块标量）
			if (sameValue(original.value, value)) {
				out.push(...original.rawLines);
				return;
			}
			out.push(`${key}: ${renderValue(field, value)}`);
			return;
		}

		if (isDeleted(key)) return;
		if (Array.isArray(value) && value.length === 0) return;
		out.push(`${key}: ${renderValue(field, value)}`);
	};

	// 1) 按原始顺序输出（原地保序，含注释与空行）
	for (const entry of originalEntries) {
		if (entry.kind === "entry") emit(entry.key, entry);
		else out.push(...entry.rawLines);
	}

	// 2) 追加原有文件中没有的新字段（按 schema 顺序）
	for (const key of order) {
		if (originalKeys.has(key)) continue;
		emit(key, null);
	}

	// 3) 追加 schema 之外的未知新字段
	for (const key of Object.keys(values)) {
		if (originalKeys.has(key) || order.includes(key)) continue;
		emit(key, null);
	}

	// 4) 空行/注释条目只来自原文件，原样保留以获得最大保真度
	return out.join(eol) + eol;
}

/** 组装完整文件内容 */
export function buildFile({ frontmatterText, body, sep, eol = "\n" }) {
	const fm = frontmatterText.replace(/\r?\n/g, eol).replace(/\r?\n$/, "");
	const b = body ?? "";
	if (!b.trim()) return `---${eol}${fm}${eol}---${eol}`;
	const separator = sep === undefined ? eol + eol : sep.replace(/\r?\n/g, eol);
	return `---${eol}${fm}${eol}---${separator}${b.replace(/\r\n/g, eol)}`;
}
