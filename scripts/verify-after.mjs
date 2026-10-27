import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	extractSection as nodeExtract,
	hashFile as nodeFileHash,
	hashSection as nodeSectionHash,
	verifyLedger,
} from '../src/utils/seal.ts';

// functions/api/after.ts 会往真实仓库写东西。这里用一套假 GitHub 把每条分支走一遍，
// 重点验三件事：BEFORE 一个字节没动、ref 只更新一次且绝不强推、
// 失败时不留下「正文已提交而账本没跟上」的半截状态。
const { applyAfter, appendSeal, extractSection, fileHash, sectionHash, onRequestPost, crossSiteOrigin } =
	await import('../functions/api/after.ts');

const results = [];
const check = async (name, fn) => {
	try {
		const detail = await fn();
		results.push(`PASS ${name}${detail ? ' :: ' + detail : ''}`);
	} catch (e) {
		results.push(`FAIL ${name} :: ${String(e.message).split('\n')[0]}`);
	}
};

const MD = readFileSync('src/content/logs/why-this-site.md', 'utf8');
const LEDGER = readFileSync('src/content/logs/why-this-site.seal.json', 'utf8');
const BASE = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const AFTER_TEXT = '上线一周：日均 12 个访客，其中 3 个来自搜「前后志」。判断成立，但冷启动比我预计的慢。';
const DATE = '2026-10-26';
const BELL = String.fromCharCode(7);

const b64enc = (t) => Buffer.from(t, 'utf8').toString('base64');
const b64dec = (v) => Buffer.from(v, 'base64').toString('utf8');

// ---------- 纯函数：改写正文 ----------
await check('applyAfter 只动 after_written_at 与 AFTER 段，BEFORE 逐字节不变', () => {
	const out = applyAfter(MD, { after: AFTER_TEXT, afterWrittenAt: DATE });
	assert.equal(nodeExtract(out, 'before'), nodeExtract(MD, 'before'), 'BEFORE 段被改动了');
	assert.ok(out.includes(`after_written_at: ${DATE}`), '没写进日期');
	assert.ok(out.includes(AFTER_TEXT), '没写进正文');
	assert.ok(!out.includes('_开发完成后补上'), '旧占位句还在');
	assert.equal((out.match(/^after_written_at:/gm) ?? []).length, 1, '日期行不止一条');
	return `BEFORE 指纹 ${nodeSectionHash(nodeExtract(out, 'before')).slice(0, 12)}… 未变`;
});

await check('已有 after_written_at 时是替换而不是插第二行', () => {
	const once = applyAfter(MD, { after: AFTER_TEXT, afterWrittenAt: DATE });
	const twice = applyAfter(once, { after: '换成另一句结论。', afterWrittenAt: '2026-10-27' });
	assert.equal((twice.match(/^after_written_at:/gm) ?? []).length, 1);
	assert.ok(twice.includes('after_written_at: 2026-10-27'));
	assert.ok(!twice.includes(DATE));
	return '单行、日期已更新';
});

await check('重复提交同一份内容完全等价（不幂等则 unchanged 分支永不触发）', () => {
	const a = applyAfter(MD, { after: AFTER_TEXT, afterWrittenAt: DATE });
	const b = applyAfter(a, { after: AFTER_TEXT, afterWrittenAt: DATE });
	assert.equal(a, b, `不幂等：${JSON.stringify(a.slice(-120))} vs ${JSON.stringify(b.slice(-120))}`);
	return `${a.length} 字符，两次一致`;
});

await check('没有 ## AFTER 段时追加到末尾，且仍不动 BEFORE', () => {
	const noAfter = MD.replace(/## AFTER[\s\S]*$/, '');
	const out = applyAfter(noAfter, { after: AFTER_TEXT, afterWrittenAt: DATE });
	assert.equal(nodeExtract(out, 'before'), nodeExtract(noAfter, 'before'));
	assert.equal(nodeSectionHash(nodeExtract(out, 'after')), nodeSectionHash(`## AFTER\n\n${AFTER_TEXT}`));
	return '追加成功';
});

await check('缺 frontmatter / 缺 BEFORE 段一律拒绝改写', () => {
	assert.throws(() => applyAfter('## BEFORE\n内容\n', { after: 'x', afterWrittenAt: DATE }), /frontmatter/);
	assert.throws(
		() => applyAfter('---\ntitle: x\n---\n\n## AFTER\n\n内容\n', { after: 'x', afterWrittenAt: DATE }),
		/BEFORE/
	);
	return '两条都拒';
});

await check('补 AFTER 必然让旧账本漂移，所以要接一条 after 记录闭环', () => {
	const out = applyAfter(MD, { after: AFTER_TEXT, afterWrittenAt: DATE });
	const ledger = JSON.parse(LEDGER);
	const drifted = verifyLedger(ledger, out);
	assert.equal(drifted.length, 1, `应当只剩整文件漂移一条：${drifted.join(' / ')}`);
	assert.ok(drifted[0].includes('整文件漂移'));
	const withAfter = {
		slug: ledger.slug,
		seals: [
			...ledger.seals,
			{
				stage: 'after',
				section_sha256: nodeSectionHash(nodeExtract(out, 'after')),
				file_sha256: nodeFileHash(out),
				commit: BASE,
				sealed_at: new Date().toISOString(),
			},
		],
	};
	assert.deepEqual(verifyLedger(withAfter, out), [], '补完 after 记录后门禁仍红');
	return '旧记录不作废 + 新记录闭环';
});

// ---------- 纯函数：哈希口径与协议实现一致 ----------
const corpus = [
	MD,
	MD.replace(/\n/g, '\r\n'),
	`${MD}\n\n\n`,
	'## BEFORE\n\n只有前\n',
	'## before\n\n小写\n\n## After\n\n也算\n',
	'',
	'就一句话',
];
await check('after.ts 自带的哈希副本与 seal.ts 逐字节等价', async () => {
	for (const text of corpus) {
		assert.equal(await fileHash(text), nodeFileHash(text), '整文件不一致');
		for (const stage of ['before', 'after']) {
			assert.equal(extractSection(text, stage), nodeExtract(text, stage), `${stage} 切段不一致`);
			assert.equal(
				await sectionHash(extractSection(text, stage)),
				nodeSectionHash(nodeExtract(text, stage)),
				`${stage} 段落指纹不一致`
			);
		}
	}
	return `${corpus.length} 组输入全等`;
});

// ---------- 纯函数：账本只追加 ----------
await check('appendSeal 追加、去重、拒绝错 slug、拒绝坏 JSON', () => {
	const rec = { stage: 'after', section_sha256: '1'.repeat(64), file_sha256: '2'.repeat(64), commit: BASE, sealed_at: 't' };
	const created = appendSeal(null, 'demo', rec);
	assert.equal(created.added, true);
	assert.equal(created.ledger.seals.length, 1);
	const existing = appendSeal(LEDGER, 'why-this-site', rec);
	assert.equal(existing.ledger.seals.length, 2);
	const dupe = appendSeal(JSON.stringify(existing.ledger), 'why-this-site', rec);
	assert.equal(dupe.added, false, '重复记录又加了一遍');
	assert.equal(dupe.ledger.seals.length, 2, '重复记录被加了两条');
	assert.throws(() => appendSeal(LEDGER, 'other-slug', rec), /不一致/);
	assert.throws(() => appendSeal('{坏 JSON', 'demo', rec), /合法 JSON/);
	return '追加 1 条、重复不加倍';
});
// ---------- 端点整流程（假 GitHub）----------
function makeGitHub(options = {}) {
	const calls = [];
	const blobs = [];
	let blobN = 0;
	let commitN = 0;
	let treeN = 0;
	// 桩必须返回真 Response：端点走的是 res.json()，返回普通对象会让成功分支永远进不去
	const ok = (status, body) =>
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
	const router = async (url, init) => {
		const method = init?.method ?? 'GET';
		const path = url.replace('https://api.github.com/repos/laity9527/beforeafter-log', '');
		const reqBody = init?.body ? JSON.parse(init.body) : null;
		calls.push({ method, path, reqBody });

		if (options.throwAt && calls.length === options.throwAt) throw new Error('模拟网络中断');
		if (path === '/git/ref/heads/main' && method === 'GET') return ok(200, { object: { sha: BASE } });
		// GitHub 读用 /git/ref/…、改用 /git/refs/…，两条路径都得单独接
		if (path === '/git/refs/heads/main' && method === 'PATCH') {
			return options.refConflict ? ok(422, { message: 'non-fast-forward' }) : ok(200, {});
		}
		if (path.startsWith('/contents/')) {
			if (options.forbidRead) return ok(403, { message: 'Forbidden' });
			if (path.includes('.seal.json')) {
				if (options.ledgerBad) return ok(200, { content: b64enc('{坏 JSON'), sha: 'ledger-blob' });
				if (options.noLedger) return ok(404, { message: 'Not Found' });
				return ok(200, { content: b64enc(LEDGER), sha: 'ledger-blob' });
			}
			if (options.noMd) return ok(404, { message: 'Not Found' });
			return ok(200, { content: b64enc(options.md ?? MD), sha: 'md-blob' });
		}
		if (path.startsWith(`/git/commits/${BASE}`)) {
			return options.treeMissing ? ok(404, { message: 'No commit found' }) : ok(200, { tree: { sha: TREE } });
		}
		if (path === '/git/blobs') {
			if (options.blobFails) return ok(422, { message: 'blob creation failed' });
			blobs.push(b64dec(reqBody.content));
			return ok(201, { sha: `blob-${++blobN}` });
		}
		if (path === '/git/trees') {
			if (options.treeFails) return ok(500, { message: 'tree failed' });
			return ok(201, { sha: `tree-${++treeN}` });
		}
		if (path === '/git/commits') return ok(201, { sha: `commit-${++commitN}` });
		throw new Error(`假 GitHub 没覆盖的调用：${method} ${path}`);
	};
	return { calls, blobs, router };
}

const invoke = async (gh, body, extra = {}) => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (url, init) => gh.router(url, init);
	try {
		const request = new Request('https://build.laity.work/api/after', {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) },
			body: JSON.stringify(body),
		});
		const response = await onRequestPost({
			request,
			env: extra.env ?? { ADMIN_PASSWORD: 'right', GITHUB_TOKEN: 'tk' },
			waitUntil: () => {},
			passThroughOnException: () => {},
		});
		return { response, payload: await response.json().catch(() => null) };
	} finally {
		globalThis.fetch = realFetch;
	}
};

const validBody = { password: 'right', slug: 'why-this-site', after: AFTER_TEXT, after_written_at: DATE };
const writes = (gh) => gh.calls.filter((c) => c.method === 'POST' || c.method === 'PATCH');

await check('成功路径：两条提交 + 一次 ref 更新，且绝不强推', async () => {
	const gh = makeGitHub();
	const { response, payload } = await invoke(gh, validBody);
	assert.equal(response.status, 200, JSON.stringify(payload));
	assert.equal(payload.ok, true);
	assert.equal(payload.data.content_commit, 'commit-1');
	assert.equal(payload.data.seal_commit, 'commit-2');

	const patches = gh.calls.filter((c) => c.method === 'PATCH');
	assert.equal(patches.length, 1, 'ref 被更新了不止一次');
	assert.equal(patches[0].reqBody.force, false, '启用了强推');
	assert.equal(patches[0].reqBody.sha, 'commit-2');

	const trees = gh.calls.filter((c) => c.path === '/git/trees').map((c) => c.reqBody.tree.map((e) => e.path));
	assert.deepEqual(trees[0], ['src/content/logs/why-this-site.md']);
	assert.deepEqual(trees[1], ['src/content/logs/why-this-site.seal.json'], '第二棵树把正文又带上了一次');

	const parents = gh.calls.filter((c) => c.path === '/git/commits').map((c) => c.reqBody.parents);
	assert.deepEqual(parents[0], [BASE]);
	assert.deepEqual(parents[1], ['commit-1'], '封存提交没接在正文提交之后，分支会丢内容');
	return `正文 ${gh.blobs[0].length} 字符 / 账本 ${gh.blobs[1].length} 字符`;
});

await check('写进去的正文里 BEFORE 与远端原文逐字节相同', async () => {
	const gh = makeGitHub();
	await invoke(gh, validBody);
	const newMd = gh.blobs[0];
	assert.ok(newMd, '没有正文 blob');
	assert.equal(nodeExtract(newMd, 'before'), nodeExtract(MD, 'before'));
	assert.equal(nodeSectionHash(nodeExtract(newMd, 'before')), JSON.parse(LEDGER).seals[0].section_sha256);
	return '已封存的 BEFORE 指纹仍自洽';
});

await check('账本记录由真实返回的 commit 锚定，按它构建门禁能过', async () => {
	const gh = makeGitHub();
	const { payload } = await invoke(gh, validBody);
	const ledger = JSON.parse(gh.blobs[1]);
	assert.equal(ledger.seals.length, 2, '账本没保住原来那条 before');
	assert.deepEqual(ledger.seals[0], JSON.parse(LEDGER).seals[0], '历史记录被改写');
	const rec = ledger.seals[1];
	assert.equal(rec.stage, 'after');
	assert.equal(rec.commit, payload.data.content_commit, '锚定 commit 不是正文那次提交');
	assert.equal(rec.file_sha256, nodeFileHash(gh.blobs[0]));
	assert.equal(rec.section_sha256, nodeSectionHash(nodeExtract(gh.blobs[0], 'after')));
	assert.deepEqual(verifyLedger(ledger, gh.blobs[0]), [], '按这份账本构建会红');
	return `after 段 ${rec.section_sha256.slice(0, 12)}… 锚 ${rec.commit}`;
});

await check('原本没有账本时新建一份，只含 after 这一条', async () => {
	const gh = makeGitHub({ noLedger: true });
	const { response, payload } = await invoke(gh, validBody);
	assert.equal(response.status, 200, JSON.stringify(payload));
	const ledger = JSON.parse(gh.blobs[1]);
	assert.equal(ledger.slug, 'why-this-site');
	assert.equal(ledger.seals.length, 1);
	assert.equal(ledger.seals[0].stage, 'after');
	return '新建账本';
});

await check('内容与仓库一致时不产生任何提交', async () => {
	const once = applyAfter(MD, { after: AFTER_TEXT, afterWrittenAt: DATE });
	const gh = makeGitHub({ md: once });
	const { payload } = await invoke(gh, validBody);
	assert.equal(payload.data.unchanged, true);
	assert.deepEqual(writes(gh), [], '本该只读却写了');
	return '零写调用';
});

await check('字段校验：坏日期 / 二级标题 / 控制字符 / 坏 slug / 空正文全部 400 且不碰仓库', async () => {
	const cases = [
		[{ ...validBody, after_written_at: '2026-13-01' }, /有效日期|YYYY-MM-DD/],
		[{ ...validBody, after_written_at: '昨天' }, /YYYY-MM-DD/],
		[{ ...validBody, after: '结论\n## 小标题\n' }, /二级标题/],
		[{ ...validBody, after: `带${BELL}铃` }, /控制字符/],
		[{ ...validBody, slug: 'Bad_Slug' }, /slug/],
		[{ ...validBody, slug: 'why--this-site' }, /slug/],
		[{ ...validBody, after: '   ' }, /不能为空/],
		[{ ...validBody, after: 'x'.repeat(20001) }, /超过/],
	];
	for (const [body, pattern] of cases) {
		const gh = makeGitHub();
		const { response, payload } = await invoke(gh, body);
		assert.equal(response.status, 400, `${JSON.stringify(body).slice(0, 60)} 期望 400，实得 ${response.status}`);
		assert.match(String(payload.error), pattern, `错误文案对不上：${payload.error}`);
		assert.deepEqual(gh.calls, [], '校验阶段就碰了仓库');
	}
	return `${cases.length} 种输入都拒，且零 GitHub 调用`;
});

await check('密码不对：401 且一个 GitHub 请求都不发', async () => {
	const gh = makeGitHub();
	const { response } = await invoke(gh, { ...validBody, password: 'wrong' });
	assert.equal(response.status, 401);
	assert.deepEqual(gh.calls, []);
	return '鉴权在读写之前';
});

await check('缺环境变量：500 fail-closed，只报变量名不报值', async () => {
	const gh = makeGitHub();
	const { response, payload } = await invoke(gh, validBody, { env: {} });
	assert.equal(response.status, 500);
	assert.match(payload.error, /ADMIN_PASSWORD/);
	assert.ok(!JSON.stringify(payload).includes('right'), '响应里漏出了密码');
	assert.deepEqual(gh.calls, []);
	return payload.error;
});

await check('跨站 Origin：403 且不读仓库；本站与无 Origin 照旧放行', async () => {
	const gh = makeGitHub();
	const { response } = await invoke(gh, validBody, { headers: { origin: 'https://evil.example' } });
	assert.equal(response.status, 403);
	assert.deepEqual(gh.calls, []);
	assert.equal(crossSiteOrigin(new Request('https://build.laity.work/api/after', { headers: { origin: 'https://x.dev' } })), 'https://x.dev');
	assert.equal(crossSiteOrigin(new Request('https://build.laity.work/api/after', { headers: { origin: 'https://build.laity.work' } })), null);
	return '403 + 同源判定不误伤';
});

await check('日志不在仓库：404，不产生提交', async () => {
	const gh = makeGitHub({ noMd: true });
	const { response, payload } = await invoke(gh, validBody);
	assert.equal(response.status, 404);
	assert.match(payload.error, /不在仓库/);
	assert.deepEqual(writes(gh), []);
	return payload.error;
});

await check('token 只读权限：GitHub 403 时报 502 且不写', async () => {
	const gh = makeGitHub({ forbidRead: true });
	const { response, payload } = await invoke(gh, validBody);
	assert.equal(response.status, 502);
	assert.match(payload.error, /读取仓库文件失败|读不到/);
	assert.deepEqual(writes(gh), []);
	return `502 ${payload.error}`;
});

await check('建树失败：正文 blob 写了但分支没动，等于没发布', async () => {
	const gh = makeGitHub({ treeFails: true });
	const { response, payload } = await invoke(gh, validBody);
	assert.equal(response.status, 502);
	assert.match(payload.error, /正文提交失败/);
	assert.ok(payload.detail, '没带出 GitHub 的原因');
	assert.equal(gh.calls.filter((c) => c.method === 'PATCH').length, 0, 'ref 被动过');
	return `502 ${payload.error}`;
});

await check('分支被推进：ref 更新被拒时回 409，且不重试不强推', async () => {
	const gh = makeGitHub({ refConflict: true });
	const { response, payload } = await invoke(gh, validBody);
	assert.equal(response.status, 409);
	assert.match(payload.error, /未强推/);
	assert.equal(gh.calls.filter((c) => c.method === 'PATCH').length, 1, '不该重试第二次');
	return payload.error;
});

await check('账本坏掉时不写任何东西', async () => {
	const gh = makeGitHub({ ledgerBad: true });
	const { response, payload } = await invoke(gh, validBody);
	assert.equal(response.status, 400);
	assert.match(payload.error, /合法 JSON|封存记录无法生成/);
	assert.deepEqual(writes(gh), []);
	return `400 ${payload.error}`;
});

await check('接近上限的中文正文（2 万字符）走完流程且字节无损', async () => {
	const big = '上'.repeat(20000);
	const gh = makeGitHub();
	const { response, payload } = await invoke(gh, { ...validBody, after: big });
	assert.equal(response.status, 200, JSON.stringify(payload));
	const written = gh.blobs[0];
	assert.ok(written.includes(big), '大块 base64 转出去正文缺字');
	assert.equal(nodeExtract(written, 'before'), nodeExtract(MD, 'before'), '大正文把 BEFORE 动了');
	const ledger = JSON.parse(gh.blobs[1]);
	assert.deepEqual(verifyLedger(ledger, written), [], '按写进去的内容构建会红');
	return `正文 ${written.length} 字符，blob ${gh.blobs.length} 个`;
});

const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(results.join('\n'));
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
