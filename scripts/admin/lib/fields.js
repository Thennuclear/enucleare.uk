/**
 * 文章 frontmatter 字段定义
 * 与 src/content.config.ts 的 schema 保持一致，供服务端与前端共用（前端通过 /api/schema 获取）。
 */

export const FIELDS = [
	{
		key: "title",
		label: "标题",
		type: "text",
		required: true,
		placeholder: "文章标题",
	},
	{
		key: "published",
		label: "发布日期",
		type: "date",
		required: true,
	},
	{
		key: "updated",
		label: "更新日期",
		type: "date",
		placeholder: "可选",
	},
	{
		key: "description",
		label: "描述",
		type: "textarea",
		placeholder: "用于列表卡片与 SEO 的摘要",
	},
	{
		key: "image",
		label: "封面图",
		type: "image",
		placeholder: "./cover.jpg 或 assets/xxx.webp",
	},
	{
		key: "tags",
		label: "标签",
		type: "tags",
		placeholder: "回车或逗号分隔",
	},
	{
		key: "category",
		label: "分类",
		type: "text",
		datalist: true,
		placeholder: "例如：杂物 / 开发",
	},
	{
		key: "draft",
		label: "草稿",
		type: "boolean",
		default: false,
		hint: "草稿不会出现在正式列表中",
	},
	{
		key: "pinned",
		label: "置顶",
		type: "boolean",
		default: false,
	},
	{
		key: "comment",
		label: "允许评论",
		type: "boolean",
		default: true,
	},
	{
		key: "lang",
		label: "语言",
		type: "text",
		placeholder: "留空则使用站点默认，例如 zh_CN",
	},
	{
		key: "alias",
		label: "别名路径",
		type: "text",
		advanced: true,
		placeholder: "旧链接兼容，例如 /old-url/",
	},
	{
		key: "permalink",
		label: "自定义固定链接",
		type: "text",
		advanced: true,
		placeholder: "例如 about-me（优先级高于别名）",
	},
	{
		key: "author",
		label: "作者",
		type: "text",
		advanced: true,
	},
	{
		key: "sourceLink",
		label: "来源链接",
		type: "text",
		advanced: true,
	},
	{
		key: "licenseName",
		label: "许可协议名称",
		type: "text",
		advanced: true,
	},
	{
		key: "licenseUrl",
		label: "许可协议链接",
		type: "text",
		advanced: true,
	},
	{
		key: "priority",
		label: "排序优先级",
		type: "number",
		advanced: true,
	},
	{
		key: "encrypted",
		label: "加密文章",
		type: "boolean",
		advanced: true,
	},
	{
		key: "password",
		label: "密码",
		type: "text",
		advanced: true,
		placeholder: "加密文章时必填",
	},
	{
		key: "passwordHint",
		label: "密码提示",
		type: "text",
		advanced: true,
	},
];

export const FIELD_MAP = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

export const FIELD_ORDER = FIELDS.map((f) => f.key);

/** 只保留 schema 中已知的字段，其余交给 frontmatter 原样保留 */
export function pickKnown(values) {
	const out = {};
	for (const f of FIELDS) {
		if (Object.prototype.hasOwnProperty.call(values, f.key)) {
			out[f.key] = normalizeValue(f, values[f.key]);
		}
	}
	return out;
}

/** 按字段类型归一化 */
export function normalizeValue(field, value) {
	if (value === undefined || value === null) return undefined;
	switch (field.type) {
		case "boolean":
			if (typeof value === "boolean") return value;
			return String(value).toLowerCase() === "true";
		case "number": {
			if (value === "") return undefined;
			const n = Number(value);
			return Number.isFinite(n) ? n : undefined;
		}
		case "tags": {
			if (Array.isArray(value)) {
				return value.map((v) => String(v).trim()).filter(Boolean);
			}
			return String(value)
				.split(/[,，]/)
				.map((v) => v.trim())
				.filter(Boolean);
		}
		default:
			return String(value);
	}
}
