/// <reference types="@cloudflare/workers-types" />

type PublishEnv = {
	ADMIN_PASSWORD?: string;
	GITHUB_TOKEN?: string;
};

export type PublishInput = {
	password: string;
	title: string;
	work_slug: string;
	tags: string[];
	before: string;
	after: string | null;
};

export class FieldError extends Error {}

// 与表单 pattern="[a-z0-9]+(?:-[a-z0-9]+)*" 同一条规则：前端那个只是体验，这里是控制
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const LIMITS = { slug: 80, title: 200, tag: 40, tags: 12, body: 20000 };
const REPO = 'laity9527/beforeafter-log';
const BRANCH = 'main';
const CONTENT_DIR = 'src/content/logs';

const gha = (path: string) => `https://api.github.com/repos/${REPO}/contents/${path}`;

const json = (status: number, body: Record<string, unknown>) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});

// 先摘要再逐字节比完，不做提前返回，避免用响应时间反推密码长度/前缀
async function passwordsMatch(candidate: string, expected: string): Promise<boolean> {
	const digest = async (value: string) =>
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
	const a = await digest(candidate);
	const b = await digest(expected);
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

// 标题与标签是单行量：任何控制字符（含换行、制表）都不允许
const hasControlChars = (value: string) =>
	[...value].some((ch) => {
		const code = ch.charCodeAt(0);
		return code < 0x20 || code === 0x7f;
	});

// 正文允常规换行与制表，其余控制字符仍然拒绝
const hasControlInBody = (value: string) =>
	[...value].some((ch) => {
		const code = ch.charCodeAt(0);
		return code < 0x20 && ch !== '\n' && ch !== '\t';
	});

// 正文里出现二级标题会把 AFTER 的段落边界挪走，进而让封存指纹对不上写作意图
function rejectLevel2Heading(value: string, field: string) {
	if (/^##\s/m.test(value)) {
		throw new FieldError(`${field} 不能包含二级标题（## 开头）；段落标题由接口自己写入`);
	}
}

/** 已按 YYYY-MM-DD 校验过的串不需要再加引号，YAML 会解析成 Date，正好对上 schema 的 z.date() */
function yamlText(value: string): string {
	const escaped = value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t')
		.replace(/\u0000/g, '\\0');
	return `"${escaped}"`;
}

function normalizeTagList(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((tag) => String(tag).trim())
		.filter(Boolean)
		.slice(0, LIMITS.tags);
}

export function readInput(body: unknown): PublishInput {
	const data = (body ?? {}) as Record<string, unknown>;
	const pick = (key: keyof PublishInput) => (typeof data[key] === 'string' ? (data[key] as string) : '');
	const input: PublishInput = {
		password: pick('password'),
		title: pick('title').trim(),
		work_slug: pick('work_slug').trim(),
		tags: normalizeTagList(data.tags),
		before: pick('before').trim(),
		after: pick('after').trim() || null,
	};

	if (!input.title) throw new FieldError('title 不能为空');
	if (input.title.length > LIMITS.title) throw new FieldError(`title 超过 ${LIMITS.title} 字符`);
	if (hasControlChars(input.title)) throw new FieldError('title 不能包含换行或控制字符');

	if (!SLUG_RE.test(input.work_slug)) throw new FieldError('work_slug 只能是小写字母、数字与单个短横线分隔');
	if (input.work_slug.length > LIMITS.slug) throw new FieldError(`work_slug 超过 ${LIMITS.slug} 字符`);

	for (const tag of input.tags) {
		if (tag.length > LIMITS.tag) throw new FieldError(`标签「${tag.slice(0, 12)}」超过 ${LIMITS.tag} 字符`);
		if (hasControlChars(tag)) throw new FieldError('标签不能包含换行或控制字符');
	}

	if (!input.before) throw new FieldError('before 不能为空');
	if (input.before.length > LIMITS.body) throw new FieldError(`before 超过 ${LIMITS.body} 字符`);
	rejectLevel2Heading(input.before, 'before');
	if (hasControlInBody(input.before)) throw new FieldError('before 含有不可见的控制字符');
	if (input.after) {
		if (input.after.length > LIMITS.body) throw new FieldError(`after 超过 ${LIMITS.body} 字符`);
		rejectLevel2Heading(input.after, 'after');
		if (hasControlInBody(input.after)) throw new FieldError('after 含有不可见的控制字符');
	}

	return input;
}

/** 按东八区取「判断写下的那天」：Functions 跑在 UTC，直接用 UTC 日期会让北京时间零点前后差一天 */
export function stampDate(now: Date): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Shanghai',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(now);
}

export function buildMarkdown(input: PublishInput, writtenAt: string): string {
	const fm = [
		`title: ${yamlText(input.title)}`,
		`work_slug: ${yamlText(input.work_slug)}`,
		input.tags.length > 0
			? `tags:\n${input.tags.map((tag) => `  - ${yamlText(tag)}`).join('\n')}`
			: 'tags: []',
		`before_written_at: ${writtenAt}`,
		...(input.after ? [`after_written_at: ${writtenAt}`] : []),
	];

	const sections = ['## BEFORE', '', input.before, ''];
	if (input.after) sections.push('## AFTER', '', input.after, '');

	return `---\n${fm.join('\n')}\n---\n\n${sections.join('\n')}\n`;
}

export function toBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	const chunk = 0x8000;
	for (let start = 0; start < bytes.length; start += chunk) {
		binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
	}
	return btoa(binary);
}

const ghHeaders = (token: string) => ({
	Authorization: `Bearer ${token}`,
	Accept: 'application/vnd.github+json',
	'X-GitHub-Api-Version': '2026-03-10',
	'User-Agent': 'beforeafter-log-publish',
});

export const onRequestPost: PagesFunction<PublishEnv> = async (context) => {
	const { ADMIN_PASSWORD, GITHUB_TOKEN } = context.env;

	if (!ADMIN_PASSWORD || !GITHUB_TOKEN) {
		return json(500, { ok: false, error: '服务端未配置 ADMIN_PASSWORD / GITHUB_TOKEN，发布不可用' });
	}

	let input: PublishInput;
	try {
		const body = await context.request.json();
		if (typeof body !== 'object' || body === null) throw new FieldError('请求体必须是 JSON 对象');
		const candidate = typeof (body as Record<string, unknown>).password === 'string'
			? ((body as Record<string, unknown>).password as string)
			: '';
		if (!candidate || !(await passwordsMatch(candidate, ADMIN_PASSWORD))) {
			return json(401, { ok: false, error: '密码不正确' });
		}
		input = readInput(body);
	} catch (error) {
		const message = error instanceof FieldError ? error.message : '请求体无法解析为约定的 JSON 结构';
		return json(400, { ok: false, error: message });
	}

	const path = `${CONTENT_DIR}/${input.work_slug}.md`;
	const writtenAt = stampDate(new Date());
	const markdown = buildMarkdown(input, writtenAt);

	try {
		const found = await fetch(`${gha(path)}?ref=${BRANCH}`, { headers: ghHeaders(GITHUB_TOKEN) });
		if (found.status === 200) {
			return json(409, {
				ok: false,
				error: `${input.work_slug}.md 已存在于仓库里，接口不覆盖已有日志`,
				detail: '补写 AFTER 请在本地改完后走 git 提交，再运行 npm run seal',
			});
		}
		if (found.status !== 404) {
			const detail = (await found.text()).slice(0, 200);
			return json(502, { ok: false, error: `GitHub 读取目标路径失败（${found.status}）`, detail });
		}

		const created = await fetch(gha(path), {
			method: 'PUT',
			headers: { ...ghHeaders(GITHUB_TOKEN), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				message: `log: add new log ${input.title}`,
				content: toBase64(markdown),
				branch: BRANCH,
			}),
		});

		if (!created.ok) {
			const detail = (await created.text()).slice(0, 200);
			return json(502, { ok: false, error: `GitHub 写入失败（${created.status}）`, detail });
		}

		const result = (await created.json()) as {
			commit?: { sha?: string; html_url?: string };
			content?: { path?: string; sha?: string };
		};

		return json(200, {
			ok: true,
			data: {
				path: result.content?.path ?? path,
				slug: input.work_slug,
				title: input.title,
				before_written_at: writtenAt,
				commit_sha: result.commit?.sha ?? null,
				commit_url: result.commit?.html_url ?? null,
				file_url: `https://github.com/${REPO}/blob/${BRANCH}/${path}`,
				sealed: false,
				message: '发布成功，等待构建',
				next: '新日志尚未封存，构建前在本地跑 npm run seal -- ' + input.work_slug + ' before 生成存证',
			},
		});
	} catch (error) {
		return json(502, { ok: false, error: '调用 GitHub API 时网络失败', detail: String(error) });
	}
};
