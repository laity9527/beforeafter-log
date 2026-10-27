/// <reference types="@cloudflare/workers-types" />

type AnalyzeEnv = {
	ADMIN_PASSWORD?: string;
	GITHUB_TOKEN?: string;
	OPENAI_API_KEY?: string;
	LLM_BASE_URL?: string;
	LLM_MODEL?: string;
	ANALYZE_DAILY_LIMIT?: string;
	ANALYZE_LIMITS?: KVNamespace;
};

type GhFile = {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	patch?: string;
};

type GhCommitResponse = {
	sha: string;
	html_url?: string;
	commit?: { message?: string; author?: { date?: string; name?: string } };
	files?: GhFile[];
};

type LlmError = { kind: 'http' | 'timeout' | 'empty' | 'shape'; detail: string; status: number };

const ALLOWED_REPO = 'laity9527/beforeafter-log';
const HASH_RE = /^[0-9a-f]{7,40}$/i;
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_DAILY_LIMIT = 20;
const PER_FILE_PATCH_CHARS = 1500;
const TOTAL_DIFF_CHARS = 12000;
const LLM_TIMEOUT_MS = 45000;

// 站点的前提是 BEFORE 写于动手之前；这个接口跑在 commit 之后，反推出来的“预判”是虚构，
// 一旦进 logs 并封存就会被洗成不可篡改的历史证据，所以占位由代码强制，不靠提示词自觉。
const BEFORE_PLACEHOLDER =
	'（此段由本人在动手之前手写：当时怎么判断、明确不做什么。AI 不代写预判。）';

class Reject extends Error {}

const json = (status: number, body: Record<string, unknown>) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const llmError = (kind: LlmError['kind'], detail: string, status: number): LlmError => ({ kind, detail, status });

async function passwordsMatch(candidate: string, expected: string): Promise<boolean> {
	const digest = async (value: string) =>
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
	const a = await digest(candidate);
	const b = await digest(expected);
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

const ghHeaders = (token: string) => ({
	Authorization: `Bearer ${token}`,
	Accept: 'application/vnd.github+json',
	'X-GitHub-Api-Version': '2026-03-10',
	'User-Agent': 'beforeafter-log-analyze',
});

/** 先计数再干活：模型挂了或被客户端打断也要扣额度，否则死循环请求会把预算烧穿 */
async function consumeQuota(kv: KVNamespace, limit: number, now: Date) {
	const key = `analyze:${now.toISOString().slice(0, 10)}`;
	const used = Number((await kv.get(key)) ?? '0') || 0;
	if (used >= limit) return { allowed: false, used, limit };
	await kv.put(key, String(used + 1));
	return { allowed: true, used: used + 1, limit };
}

export function digestCommit(commit: GhCommitResponse) {
	const files = commit.files ?? [];
	const listed = files.map((f) => ({
		filename: f.filename,
		status: f.status,
		additions: f.additions,
		deletions: f.deletions,
	}));

	let budget = TOTAL_DIFF_CHARS;
	let truncated = false;
	const chunks: string[] = [];

	for (const f of files) {
		if (budget <= 0) {
			truncated = true;
			continue;
		}
		const patch = f.patch ?? '';
		if (patch.length > PER_FILE_PATCH_CHARS) truncated = true;
		const taken = patch.slice(0, PER_FILE_PATCH_CHARS);
		chunks.push(`--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n${taken}`);
		budget -= taken.length;
	}

	if (chunks.length < files.length) truncated = true;

	return {
		listed,
		diffText: chunks.join('\n\n'),
		filesIncluded: chunks.length,
		filesTotal: files.length,
		truncated,
	};
}

export function buildMessages(input: {
	repo: string;
	sha: string;
	message: string;
	authorDate: string;
	commitUrl: string;
	digest: ReturnType<typeof digestCommit>;
}) {
	const system = [
		'你是个人项目「前后志」的记录助手。该站的前提是：每条日志有一段 BEFORE（动手之前的判断，本人手写）和一段 AFTER（做完之后的总结）。',
		'规则一：只写 ## AFTER，总结这次提交实际做了什么、影响了哪些文件、留下什么结果与风险。',
		'规则二：## BEFORE 段落必须原样输出下面这一行占位文本，一个字符都不要改，也不要补充任何推测：',
		`«${BEFORE_PLACEHOLDER}»`,
		'规则三：不要输出 YAML frontmatter（不要出现 --- 分隔线），不要输出代码围栏包裹整个答案，不要编造 diff 里没有的细节。',
		'输出格式：先 ## BEFORE，再 ## AFTER，正文用中文。',
	].join('\n');

	const user = [
		`仓库：${input.repo}`,
		`提交：${input.sha}`,
		`提交信息：${input.message}`,
		`作者时间：${input.authorDate}`,
		`提交页面：${input.commitUrl}`,
		`文件清单：${input.digest.listed.map((f) => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`).join('; ')}`,
		input.digest.truncated
			? `注意：diff 已按预算截断（收录 ${input.digest.filesIncluded}/${input.digest.filesTotal} 个文件的补丁）。`
			: '以下是完整 diff：',
		'',
		input.digest.diffText,
	].join('\n');

	return [
		{ role: 'system', content: system },
		{ role: 'user', content: user },
	];
}

/** 去掉模型爱加的整段代码围栏与 frontmatter，并强制 BEFORE 段只剩占位 */
export function enforceBeforePlaceholder(rawDraft: string) {
	let draft = rawDraft.trim();
	let strippedFence = false;
	let strippedFrontmatter = false;

	if (draft.startsWith('```')) {
		const firstBreak = draft.indexOf('\n');
		if (firstBreak > 0) {
			draft = draft.slice(firstBreak + 1);
			const fenceEnd = draft.lastIndexOf('```');
			if (fenceEnd >= 0) draft = draft.slice(0, fenceEnd);
			strippedFence = true;
		}
	}

	draft = draft.trim();
	if (draft.startsWith('---\n')) {
		const end = draft.indexOf('\n---', 4);
		if (end > 0) {
			draft = draft.slice(end + 4).trim();
			strippedFrontmatter = true;
		}
	}

	const lines = draft.split('\n');
	const beforeAt = lines.findIndex((l) => /^##\s+before\b/i.test(l));
	const afterAt = lines.findIndex((l) => /^##\s+after\b/i.test(l));

	if (afterAt < 0) {
		throw new Reject('模型没有产出 ## AFTER 段');
	}

	let markdown: string;
	let beforeForced = false;

	if (beforeAt < 0) {
		markdown = ['## BEFORE', '', BEFORE_PLACEHOLDER, '', ...lines.slice(afterAt)].join('\n');
		beforeForced = true;
	} else {
		let next = lines.length;
		for (let i = beforeAt + 1; i < lines.length; i++) {
			if (/^##\s/.test(lines[i])) {
				next = i;
				break;
			}
		}
		const body = lines
			.slice(beforeAt + 1, next)
			.join('\n')
			.trim();
		if (body !== BEFORE_PLACEHOLDER) {
			beforeForced = true;
		}
		const head = lines.slice(0, beforeAt);
		const tail = lines.slice(next);
		markdown = [...head, '## BEFORE', '', BEFORE_PLACEHOLDER, '', ...tail].join('\n');
	}

	return { markdown: `${markdown.trim()}\n`, beforeForced, strippedFence, strippedFrontmatter };
}

async function callLlm(
	env: AnalyzeEnv,
	messages: { role: string; content: string }[]
): Promise<{ content: string; model: string }> {
	const baseUrl = (env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
	const model = env.LLM_MODEL ?? DEFAULT_MODEL;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.OPENAI_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ model, messages, temperature: 0.3 }),
			signal: controller.signal,
		});
	} catch (error) {
		if (controller.signal.aborted) throw llmError('timeout', `模型调用超过 ${LLM_TIMEOUT_MS}ms 未返回`, 504);
		throw llmError('shape', `模型请求失败：${String(error)}`, 502);
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) {
		const detail = (await response.text()).slice(0, 300);
		throw llmError('http', `模型服务返回 ${response.status}${detail ? ` · ${detail}` : ''}`, 502);
	}

	const payload = (await response.json().catch(() => null)) as {
		choices?: { message?: { content?: string } }[];
	} | null;
	const content = payload?.choices?.[0]?.message?.content;
	if (typeof content !== 'string' || !content.trim()) {
		throw llmError('empty', '模型返回了空内容', 502);
	}
	return { content, model };
}

async function handleAnalyze(context: Parameters<PagesFunction<AnalyzeEnv>>[0]): Promise<Response> {
	const env = context.env;
	const missing = ['ADMIN_PASSWORD', 'GITHUB_TOKEN', 'OPENAI_API_KEY'].filter((name) => !env[name as keyof AnalyzeEnv]);
	// 只判「有没有值」不够：把 ANALYZE_LIMITS 加成文本变量也会通过，然后在下一次 .get() 处抛未捕获异常
	const kv = env.ANALYZE_LIMITS;
	if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
		missing.push('ANALYZE_LIMITS（必须是 KV namespace 绑定，不是变量或 Secret）');
	}
	if (missing.length > 0) {
		return json(500, { ok: false, error: '服务端缺少配置，分析功能不可用', detail: `未设置：${missing.join('、')}` });
	}

	const now = new Date();
	const limit = Number(env.ANALYZE_DAILY_LIMIT ?? String(DEFAULT_DAILY_LIMIT)) || DEFAULT_DAILY_LIMIT;
	const quota = await consumeQuota(env.ANALYZE_LIMITS!, limit, now);
	if (!quota.allowed) {
		return json(429, {
			ok: false,
			error: `今日分析次数已用完（${quota.limit} 次/天）`,
			detail: 'UTC 零点重置；需要更多可在 Pages 项目里调大 ANALYZE_DAILY_LIMIT',
		});
	}

	let body: Record<string, unknown>;
	try {
		const parsed = await context.request.json();
		if (typeof parsed !== 'object' || parsed === null) throw new Reject('请求体必须是 JSON 对象');
		body = parsed as Record<string, unknown>;
	} catch (error) {
		const message = error instanceof Reject ? error.message : '请求体无法解析为 JSON';
		return json(400, { ok: false, error: message });
	}

	const password = typeof body.password === 'string' ? body.password : '';
	if (!password || !(await passwordsMatch(password, env.ADMIN_PASSWORD!))) {
		return json(401, { ok: false, error: '密码不正确' });
	}

	const rawHash = typeof body.commit_hash === 'string' ? body.commit_hash.trim() : '';
	if (!HASH_RE.test(rawHash)) {
		return json(400, { ok: false, error: 'commit_hash 只能是 7-40 位十六进制字符' });
	}

	// 仓库锁死在白名单：服务端 token 有账号级权限，放任前端指定 repo 等于把它做成任意仓库读取代理
	const rawRepo = typeof body.repo === 'string' && body.repo.trim() ? body.repo.trim() : ALLOWED_REPO;
	if (rawRepo.toLowerCase() !== ALLOWED_REPO) {
		return json(403, { ok: false, error: `只允许分析 ${ALLOWED_REPO}`, detail: `收到的是 ${rawRepo.slice(0, 60)}` });
	}

	const sha = rawHash.toLowerCase();
	let commit: GhCommitResponse;
	try {
		const gh = await fetch(`https://api.github.com/repos/${ALLOWED_REPO}/commits/${sha}`, {
			headers: ghHeaders(env.GITHUB_TOKEN!),
		});
		// GitHub 对「sha 不存在」给的是 422 而不是 404，两种都要当找不到 commit，否则用户只看到上游故障
		if (gh.status === 404 || gh.status === 422) {
			return json(404, {
				ok: false,
				error: `仓库里找不到 commit ${sha.slice(0, 12)}…（GitHub 返回 ${gh.status}）`,
				detail: 'sha 必须是这个仓库里真实存在的提交；从 git log --format="%H" 复制完整 40 位最稳',
			});
		}
		if (!gh.ok) {
			const detail = (await gh.text()).slice(0, 200);
			return json(502, { ok: false, error: `GitHub 读取 commit 失败（${gh.status}）`, detail });
		}
		commit = (await gh.json()) as GhCommitResponse;
	} catch (error) {
		return json(502, { ok: false, error: '调用 GitHub API 时网络失败', detail: String(error) });
	}

	const digest = digestCommit(commit);
	if (digest.filesTotal === 0) {
		return json(422, { ok: false, error: '这个提交没有可比对的文件改动', detail: commit.sha.slice(0, 12) });
	}

	const messages = buildMessages({
		repo: ALLOWED_REPO,
		sha: commit.sha,
		message: commit.commit?.message ?? '(无提交信息)',
		authorDate: commit.commit?.author?.date ?? '(未知时间)',
		commitUrl: commit.html_url ?? '',
		digest,
	});

	// dry_run 只走到「拼好 prompt」为止：用来区分被平台杀掉的是前半段（GitHub+摘要）还是模型子请求
	if (body.dry_run === true) {
		return json(200, {
			ok: true,
			data: {
				dry_run: true,
				commit: { sha: commit.sha, short: commit.sha.slice(0, 7), message: commit.commit?.message ?? '' },
				diff: { included: digest.filesIncluded, total: digest.filesTotal, truncated: digest.truncated },
				prompt: {
					system_chars: messages[0].content.length,
					user_chars: messages[1].content.length,
					user_head: messages[1].content.slice(0, 400),
				},
				quota_used_today: quota.used,
				quota_limit: quota.limit,
			},
		});
	}

	try {
		const { content, model } = await callLlm(env, messages);
		const draft = enforceBeforePlaceholder(content);
		return json(200, {
			ok: true,
			data: {
				draft_markdown: draft.markdown,
				commit: {
					sha: commit.sha,
					short: commit.sha.slice(0, 7),
					message: commit.commit?.message ?? '',
					url: commit.html_url ?? '',
				},
				files: digest.listed,
				diff: { included: digest.filesIncluded, total: digest.filesTotal, truncated: digest.truncated },
				ai: {
					model,
					before_forced: draft.beforeForced,
					stripped_code_fence: draft.strippedFence,
					stripped_frontmatter: draft.strippedFrontmatter,
					quota_used_today: quota.used,
					quota_limit: quota.limit,
				},
				next: 'BEFORE 占位必须本人补写，再放进 src/content/logs/<work_slug>.md，提交后运行 npm run seal',
			},
		});
	} catch (error) {
		if (error instanceof Reject) return json(502, { ok: false, error: error.message });
		const e = error as LlmError;
		if (e && typeof e.status === 'number' && typeof e.detail === 'string') {
			return json(e.status, { ok: false, error: '模型调用失败', detail: e.detail });
		}
		return json(500, { ok: false, error: '分析流程异常', detail: String(error) });
	}
}

// 任何逃出内层 try 的异常都会让 Cloudflare 替我们回一个 HTML 502，前端只能看到光秃秃的状态码；
// 这层兜底保证「永远是我们回答」，并把堆栈打进 Pages 的 Functions 日志
export const onRequestPost: PagesFunction<AnalyzeEnv> = async (context) => {
	try {
		return await handleAnalyze(context);
	} catch (error) {
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.error('/api/analyze 未捕获异常', detail, error instanceof Error ? error.stack : '');
		return json(500, { ok: false, error: '分析流程出现未预期异常', detail: detail.slice(0, 200) });
	}
};
