/// <reference types="@cloudflare/workers-types" />

type AfterEnv = {
	ADMIN_PASSWORD?: string;
	GITHUB_TOKEN?: string;
};

const OWNER = 'laity9527';
const REPO = 'beforeafter-log';
const BRANCH = 'main';
const CONTENT_DIR = 'src/content/logs';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIMITS = { slug: 80, body: 20000 };

class Reject extends Error {}

const json = (status: number, body: Record<string, unknown>) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const gha = (path: string) => `https://api.github.com/repos/${OWNER}/${REPO}${path}`;

const ghHeaders = (token: string) => ({
	Authorization: `Bearer ${token}`,
	Accept: 'application/vnd.github+json',
	'X-GitHub-Api-Version': '2026-03-10',
	'User-Agent': 'beforeafter-log-after',
});

// 与 seal.ts / seal-web.ts 同一条口径，独立一份：Pages Functions 保持自包含是有意的，
// 不跨目录 import，避免把没证实过的打包假设变成运行时风险。等价性由 scripts/verify-after.mjs 对拍。
const toLf = (text: string) => text.replace(/\r\n/g, '\n');
const normalizeFile = (text: string) => toLf(text);
const normalizeSection = (text: string) => toLf(text).replace(/\s+$/, '');

export function extractSection(text: string, stage: 'before' | 'after'): string {
	const lines = toLf(text).split('\n');
	const stageRe = new RegExp(`^##\\s+${stage}\\b`, 'i');
	const h2Re = /^##\s/;
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (stageRe.test(lines[i])) {
			start = i;
			break;
		}
	}
	if (start === -1) return '';
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (h2Re.test(lines[i])) {
			end = i;
			break;
		}
	}
	return normalizeSection(lines.slice(start, end).join('\n'));
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const fileHash = (text: string) => sha256Hex(normalizeFile(text));
const sectionHash = (section: string) => sha256Hex(normalizeSection(section));
export { fileHash, sectionHash };

async function passwordsMatch(candidate: string, expected: string): Promise<boolean> {
	const digest = async (value: string) =>
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
	const a = await digest(candidate);
	const b = await digest(expected);
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

export const crossSiteOrigin = (request: Request): string | null => {
	const origin = request.headers.get('origin');
	if (!origin || origin === new URL(request.url).origin) return null;
	return origin;
};

const hasControlInBody = (value: string) =>
	[...value].some((ch) => {
		const code = ch.charCodeAt(0);
		return code < 0x20 && ch !== '\n' && ch !== '\t';
	});

/**
 * 只动两处：frontmatter 的 after_written_at，和 ## AFTER 段的内容。
 * ## BEFORE 一个字节都不许变——它已经封存了，改它就是造假，所以这里直接抛。
 */
export function applyAfter(mdText: string, input: { after: string; afterWrittenAt: string }): string {
	const text = toLf(mdText);
	if (!text.startsWith('---\n')) throw new Reject('正文缺少 frontmatter，不敢自动改写');
	const close = text.indexOf('\n---\n', 3);
	if (close === -1) throw new Reject('frontmatter 没有结束标记');

	// close 指向结束标记前那个换行；分隔线之间的内容从下标 4 起（跳过开头的 `---\n`），
	// 取错一位每次都会多插一个空行，第二次改写就不再幂等
	const fmBlock = text.slice(4, close);
	const body = text.slice(close + 5);

	if (extractSection(body, 'before') === '') throw new Reject('原文里找不到 ## BEFORE 段');

	// 1) frontmatter 里的日期：有就换那行，没有就插在 before_written_at 之后
	const fmLines = fmBlock.split('\n');
	const dateLine = `after_written_at: ${input.afterWrittenAt}`;
	const existing = fmLines.findIndex((line) => /^after_written_at\s*:/.test(line));
	if (existing >= 0) {
		fmLines[existing] = dateLine;
	} else {
		const anchor = fmLines.findIndex((line) => /^before_written_at\s*:/.test(line));
		fmLines.splice(anchor >= 0 ? anchor + 1 : fmLines.length, 0, dateLine);
	}

	// 2) 段落：只替换 ## AFTER 标题行以下、下一个二级标题以上的内容
	const lines = body.split('\n');
	const stageRe = /^##\s+after\b/i;
	const start = lines.findIndex((line) => stageRe.test(line));
	let nextBody: string;
	if (start === -1) {
		nextBody = `${body.replace(/\s+$/, '')}\n\n## AFTER\n\n${input.after}\n`;
	} else {
		let end = lines.length;
		for (let i = start + 1; i < lines.length; i++) {
			if (/^##\s/.test(lines[i])) {
				end = i;
				break;
			}
		}
		nextBody = [...lines.slice(0, start + 1), '', input.after, ...lines.slice(end)].join('\n');
	}

	// 结尾固定成一个换行：否则「补一次」和「再补一次」会差在空行数上，unchanged 分支永远不会命中
	const joined = `---\n${fmLines.join('\n')}\n---\n${nextBody}`;
	let tail = joined.length;
	while (tail > 0 && joined.charAt(tail - 1) === '\n') tail -= 1;
	const result = `${joined.slice(0, tail)}\n`;

	// 前后对比：BEFORE 必须逐字节不变，AFTER 必须等于提交进来的正文
	if (extractSection(result, 'before') !== extractSection(text, 'before')) {
		throw new Reject('改写会动到已封存的 BEFORE 段，已中止');
	}
	if (normalizeSection(extractSection(result, 'after')) !== normalizeSection(`## AFTER\n\n${input.after}`)) {
		throw new Reject('改写后的 AFTER 段与提交内容不一致，已中止');
	}
	return result;
}

/** 账本只追加：历史上有的记录一条都不能少，新记录排在最后 */
export function appendSeal(ledgerText: string | null, slug: string, record: Record<string, unknown>) {
	let ledger: { slug: string; seals: Record<string, unknown>[] };
	if (ledgerText === null) {
		ledger = { slug, seals: [] };
	} else {
		let parsed: unknown;
		try {
			parsed = JSON.parse(ledgerText);
		} catch {
			throw new Reject(`${slug}.seal.json 不是合法 JSON，先本地修好再补 AFTER`);
		}
		const doc = parsed as { slug?: unknown; seals?: unknown };
		if (doc.slug !== slug) throw new Reject(`账本里记的 slug 是 ${String(doc.slug)}，与 ${slug} 不一致`);
		if (!Array.isArray(doc.seals)) throw new Reject('账本里没有 seals 数组');
		ledger = { slug, seals: doc.seals as Record<string, unknown>[] };
	}
	const tuple = (s: Record<string, unknown>) =>
		`${s.stage}/${s.section_sha256}/${s.file_sha256}/${s.commit}`;
	if (ledger.seals.some((seal) => tuple(seal) === tuple(record))) {
		return { ledger, added: false };
	}
	return { ledger: { ...ledger, seals: [...ledger.seals, record] }, added: true };
}

const b64 = {
	// 分块转：整串一次 spread 进 String.fromCharCode，正文接近 20000 字（UTF-8 约 6 万字节）时会 RangeError
	encode: (text: string) => {
		const bytes = new TextEncoder().encode(text);
		let binary = '';
		for (let start = 0; start < bytes.length; start += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
		}
		return btoa(binary);
	},
	decode: (value: string) =>
		new TextDecoder().decode(Uint8Array.from(atob(value.replace(/\n/g, '')), (ch) => ch.charCodeAt(0))),
};

async function ghJson(token: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
	const res = await fetch(gha(path), { ...init, headers: { ...ghHeaders(token), ...(init?.headers ?? {}) } });
	const body = await res.json().catch(() => null);
	return { status: res.status, body };
}

async function getFileAt(token: string, path: string, ref: string): Promise<{ text: string; sha: string } | null> {
	const { status, body } = await ghJson(token, `/contents/${path}?ref=${ref}`);
	if (status === 404) return null;
	if (status !== 200 || typeof body?.content !== 'string') {
		throw new Reject(`读取 ${path} 失败（GitHub ${status}）`);
	}
	return { text: b64.decode(body.content), sha: String(body.sha) };
}

async function handleAfter(context: Parameters<PagesFunction<AfterEnv>>[0]): Promise<Response> {
	const { GITHUB_TOKEN, ADMIN_PASSWORD } = context.env;
	const hostile = crossSiteOrigin(context.request);
	if (hostile) return json(403, { ok: false, error: '请求来源与本站不一致，已拒绝', detail: `Origin: ${hostile}` });
	if (!ADMIN_PASSWORD || !GITHUB_TOKEN) {
		return json(500, { ok: false, error: '服务端未配置 ADMIN_PASSWORD / GITHUB_TOKEN，补齐不可用' });
	}

	let body: Record<string, unknown>;
	try {
		const parsed = await context.request.json();
		if (typeof parsed !== 'object' || parsed === null) throw new Reject('请求体必须是 JSON 对象');
		body = parsed as Record<string, unknown>;
	} catch (error) {
		return json(400, { ok: false, error: error instanceof Reject ? error.message : '请求体无法解析为 JSON' });
	}

	const pick = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '');
	const password = pick('password');
	if (!password || !(await passwordsMatch(password, ADMIN_PASSWORD))) {
		return json(401, { ok: false, error: '密码不正确' });
	}

	const slug = pick('slug').trim();
	const after = pick('after').trim();
	const afterWrittenAt = pick('after_written_at').trim();

	try {
		if (!SLUG_RE.test(slug)) throw new Reject('slug 只能是小写字母、数字与单个短横线分隔');
		if (slug.length > LIMITS.slug) throw new Reject(`slug 超过 ${LIMITS.slug} 字符`);
		if (!DATE_RE.test(afterWrittenAt)) throw new Reject('after_written_at 必须是 YYYY-MM-DD');
		const asDate = new Date(`${afterWrittenAt}T00:00:00Z`);
		if (Number.isNaN(asDate.getTime())) throw new Reject('after_written_at 不是有效日期');
		if (!after) throw new Reject('AFTER 正文不能为空');
		if (after.length > LIMITS.body) throw new Reject(`AFTER 正文超过 ${LIMITS.body} 字符`);
		if (hasControlInBody(after)) throw new Reject('AFTER 正文含控制字符');
		if (/^##\s/m.test(after)) throw new Reject('AFTER 正文不能包含二级标题（## 开头）；段落标题由接口自己写入');
	} catch (error) {
		return json(400, { ok: false, error: error instanceof Reject ? error.message : '字段校验失败' });
	}

	const mdPath = `${CONTENT_DIR}/${slug}.md`;
	const ledgerPath = `${CONTENT_DIR}/${slug}.seal.json`;

	// 先读 ref，再用同一个 ref 读文件：避免读到「写之后」的内容却按「写之前」的父提交去改
	const refRes = await ghJson(GITHUB_TOKEN, `/git/ref/heads/${BRANCH}`);
	if (refRes.status !== 200 || typeof refRes.body?.object?.sha !== 'string') {
		return json(502, { ok: false, error: '读不到分支当前提交', detail: `GitHub ${refRes.status}` });
	}
	const baseSha = String(refRes.body.object.sha);

	let current;
	let ledger;
	try {
		current = await getFileAt(GITHUB_TOKEN, mdPath, baseSha);
		if (current === null) {
			return json(404, { ok: false, error: `${slug}.md 不在仓库里`, detail: `先在 ${BRANCH} 上找到这条日志再补齐` });
		}
		const foundLedger = await getFileAt(GITHUB_TOKEN, ledgerPath, baseSha);
		ledger = foundLedger?.text ?? null;
	} catch (error) {
		return json(502, { ok: false, error: '读取仓库文件失败', detail: error instanceof Error ? error.message : String(error) });
	}

	let nextMd: string;
	try {
		nextMd = applyAfter(current.text, { after, afterWrittenAt });
	} catch (error) {
		return json(400, { ok: false, error: error instanceof Reject ? error.message : '改写失败' });
	}

	if (nextMd === current.text) {
		return json(200, { ok: true, data: { unchanged: true, message: '内容与日期已经一致，没有产生提交' } });
	}

	const section = extractSection(nextMd, 'after');
	if (!section) return json(500, { ok: false, error: '改写后找不到 AFTER 段，已中止' });

	const record = {
		stage: 'after',
		section_sha256: await sectionHash(section),
		// 这一步先算不出 commit（要等提交返回），占位后再补；下面用真实 sha 重建记录
		file_sha256: await fileHash(nextMd),
		commit: '',
		sealed_at: new Date().toISOString(),
	};

	// 先在「一个字节都还没写」的时候试一遍账本追加：账本坏了或 slug 对不上要当场拒绝，
	// 不能等正文提交完再发现——那时分支已经动了，门禁会红着等到人工收尾
	try {
		appendSeal(ledger, slug, record);
	} catch (error) {
		return json(400, { ok: false, error: error instanceof Reject ? error.message : '账本无法追加封存记录' });
	}

	const treeRes = await ghJson(GITHUB_TOKEN, `/git/commits/${baseSha}`);
	const treeSha = treeRes.body?.tree?.sha;
	if (treeRes.status !== 200 || typeof treeSha !== 'string') {
		return json(502, { ok: false, error: '读不到基础树', detail: `GitHub ${treeRes.status}` });
	}

	const newBlob = async (text: string) => {
		const res = await ghJson(GITHUB_TOKEN, '/git/blobs', {
			method: 'POST',
			body: JSON.stringify({ content: b64.encode(text), encoding: 'base64' }),
		});
		if (res.status !== 201 || typeof res.body?.sha !== 'string') {
			throw new Reject(`创建 blob 失败（GitHub ${res.status}）`);
		}
		return String(res.body.sha);
	};

	let mdBlobSha: string;
	try {
		mdBlobSha = await newBlob(nextMd);
	} catch (error) {
		return json(502, { ok: false, error: '写入对象失败，仓库未改动', detail: error instanceof Error ? error.message : String(error) });
	}

	const title = /^title:\s*(.+)$/m.exec(current.text)?.[1]?.trim().replace(/^"|"$/g, '') ?? slug;

	const makeCommit = async (treeEntries: unknown[], message: string, parents: string[]) => {
		const tree = await ghJson(GITHUB_TOKEN, '/git/trees', {
			method: 'POST',
			body: JSON.stringify({ base_tree: treeSha, tree: treeEntries }),
		});
		if (tree.status !== 201 || typeof tree.body?.sha !== 'string') {
			throw new Reject(`建树失败（GitHub ${tree.status}）`);
		}
		const commit = await ghJson(GITHUB_TOKEN, '/git/commits', {
			method: 'POST',
			body: JSON.stringify({ message, tree: tree.body.sha, parents }),
		});
		if (commit.status !== 201 || typeof commit.body?.sha !== 'string') {
			throw new Reject(`建提交失败（GitHub ${commit.status}）`);
		}
		return { commitSha: String(commit.body.sha), treeSha: String(tree.body.sha) };
	};

	let contentCommit: { commitSha: string };
	try {
		contentCommit = await makeCommit(
			[{ path: mdPath, mode: '100644', type: 'blob', sha: mdBlobSha }],
			`log: add after for ${title}`,
			[baseSha]
		);
	} catch (error) {
		return json(502, { ok: false, error: '正文提交失败，仓库未改动', detail: error instanceof Error ? error.message : String(error) });
	}

	// 第二条提交带上真实锚定 commit 的封存记录；两条都不强推，父提交固定，竞态由 ref 更新兜住
	const finalRecord = { ...record, commit: contentCommit.commitSha };
	let finalLedgerText: string;
	try {
		const appended = appendSeal(ledger, slug, finalRecord);
		finalLedgerText = JSON.stringify(appended.ledger, null, 2) + '\n';
	} catch (error) {
		return json(500, {
			ok: false,
			error: '正文已提交，但封存记录无法生成，必须立刻本地补封存',
			detail: `${error instanceof Error ? error.message : String(error)}；跑 npm run seal -- ${slug} after`,
			data: { content_commit: contentCommit.commitSha },
		});
	}

	let ledgerBlobSha2: string;
	try {
		ledgerBlobSha2 = await newBlob(finalLedgerText);
	} catch (error) {
		return json(502, { ok: false, error: '封存记录写入失败，正文已提交，请本地补封存', detail: String(error) });
	}

	let sealCommit: { commitSha: string };
	let refUpdated: { status: number; body: any };
	try {
		sealCommit = await makeCommit(
			[{ path: ledgerPath, mode: '100644', type: 'blob', sha: ledgerBlobSha2 }],
			`seal: anchor after for ${slug}`,
			[contentCommit.commitSha]
		);
		refUpdated = await ghJson(GITHUB_TOKEN, `/git/refs/heads/${BRANCH}`, {
			method: 'PATCH',
			body: JSON.stringify({ sha: sealCommit.commitSha, force: false }),
		});
	} catch (error) {
		return json(502, {
			ok: false,
			error: '封存提交未完成，正文已提交但门禁会红，请本地补封存后重试',
			detail: error instanceof Error ? error.message : String(error),
			data: { content_commit: contentCommit.commitSha },
		});
	}

	if (refUpdated.status !== 200) {
		return json(409, {
			ok: false,
			error: '分支在这期间被推进过，未强推',
			detail: `GitHub ${refUpdated.status}；正文提交 ${contentCommit.commitSha.slice(0, 7)} 还在对象库里，请本地补封存`,
		});
	}

	return json(200, {
		ok: true,
		data: {
			slug,
			content_commit: contentCommit.commitSha,
			seal_commit: sealCommit.commitSha,
			after_written_at: afterWrittenAt,
			after_section_sha256: finalRecord.section_sha256,
			file_sha256: finalRecord.file_sha256,
			next: 'Pages 会用这两次提交重新构建；门禁若红，跑 npm run verify:seals 看具体哪一条',
		},
	});
}

export const onRequestPost: PagesFunction<AfterEnv> = async (context) => {
	try {
		return await handleAfter(context);
	} catch (error) {
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.error('/api/after 未捕获异常', detail, error instanceof Error ? error.stack : '');
		return json(500, { ok: false, error: '补齐流程出现未预期异常', detail: detail.slice(0, 200) });
	}
};
