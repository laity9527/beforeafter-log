import assert from 'node:assert/strict';
import { consumeQuota, crossSiteOrigin as originA, shanghaiDay } from '../functions/api/analyze.ts';
import { crossSiteOrigin as originP } from '../functions/api/publish.ts';

const results = [];
const check = async (name, fn) => {
	try {
		const detail = await fn();
		results.push(`PASS ${name}${detail ? ' :: ' + detail : ''}`);
	} catch (e) {
		results.push(`FAIL ${name} :: ${String(e.message).split('\n')[0]}`);
	}
};

const fakeKv = (store = new Map()) => ({
	get: async (k) => store.get(k) ?? null,
	put: async (k, v) => void store.set(k, v),
	store,
});

const req = (url, origin) =>
	new Request(url, { method: 'POST', headers: origin ? { origin } : {} });

await check('配额键按东八区自然日，不是 UTC 日', async () => {
	// UTC 16:30 = 北京次日 00:30，这一档最容易记错
	assert.equal(shanghaiDay(new Date('2026-10-27T16:30:00Z')), '2026-10-28');
	assert.equal(shanghaiDay(new Date('2026-10-27T01:00:00Z')), '2026-10-27');
	assert.equal(shanghaiDay(new Date('2026-10-27T15:59:59Z')), '2026-10-27');
	return '2026-10-27T16:30Z → 2026-10-28';
});

await check('consumeQuota 写的是东八区那一天的键', async () => {
	const kv = fakeKv();
	const out = await consumeQuota(kv, 20, new Date('2026-10-27T16:30:00Z'));
	assert.equal(out.allowed, true);
	assert.deepEqual([...kv.store.keys()], ['analyze:2026-10-28']);
	return [...kv.store.keys()][0] + '=' + [...kv.store.values()][0];
});

await check('配额用满后拒绝，且不再往上加', async () => {
	const kv = fakeKv();
	await consumeQuota(kv, 2, new Date('2026-10-27T04:00:00Z'));
	await consumeQuota(kv, 2, new Date('2026-10-27T04:00:00Z'));
	const third = await consumeQuota(kv, 2, new Date('2026-10-27T04:00:00Z'));
	assert.equal(third.allowed, false);
	assert.equal(kv.store.get('analyze:2026-10-27'), '2');
	return `第三次 allowed=false，计数停在 ${kv.store.get('analyze:2026-10-27')}`;
});

await check('不同日期各算各的额度', async () => {
	const kv = fakeKv();
	await consumeQuota(kv, 1, new Date('2026-10-27T04:00:00Z'));
	const nextDay = await consumeQuota(kv, 1, new Date('2026-10-28T04:00:00Z'));
	assert.equal(nextDay.allowed, true);
	return '10-27 用满后 10-28 仍可 1 次';
});

for (const [label, origin] of [['analyze', originA], ['publish', originP]]) {
	await check(`${label}：本站 Origin 放行`, () => {
		assert.equal(origin(req('https://build.laity.work/api/' + label, 'https://build.laity.work')), null);
		return 'null';
	});
	await check(`${label}：pages.dev 自家 Origin 也放行`, () => {
		assert.equal(origin(req('https://beforeafter-log.pages.dev/api/' + label, 'https://beforeafter-log.pages.dev')), null);
		return 'null';
	});
	await check(`${label}：跨站 Origin 被拒并回显来源`, () => {
		assert.equal(origin(req('https://build.laity.work/api/' + label, 'https://evil.example')), 'https://evil.example');
		return 'https://evil.example';
	});
	await check(`${label}：Origin: null（不透明来源）也拒`, () => {
		const got = origin(req('https://build.laity.work/api/' + label, 'null'));
		assert.equal(got, 'null');
		return 'Origin: null 被拒';
	});
	await check(`${label}：没有 Origin 头不拒（curl / 脚本照旧）`, () => {
		assert.equal(origin(req('https://build.laity.work/api/' + label)), null);
		return 'null';
	});
	await check(`${label}：端口不同就不是同源`, () => {
		assert.equal(origin(req('https://build.laity.work/api/' + label, 'https://build.laity.work:8443')), 'https://build.laity.work:8443');
		return '拒绝带端口的异源';
	});
}

// 上面只证明 helper 本身，不证明接口真的调了它。这里从导出的 onRequestPost 打进去。
const { onRequestPost: analyzePost } = await import('../functions/api/analyze.ts');
const { onRequestPost: publishPost } = await import('../functions/api/publish.ts');

const post = (handler, path, origin, env) =>
	handler({
		request: new Request(`https://build.laity.work${path}`, {
			method: 'POST',
			headers: origin ? { origin, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
			body: JSON.stringify({ password: 'x', commit_hash: 'a'.repeat(40), repo: 'laity9527/beforeafter-log' }),
		}),
		env,
		waitUntil() {},
		passThroughOnException() {},
	});

const analyzeEnv = {
	ADMIN_PASSWORD: 'right',
	GITHUB_TOKEN: 't',
	OPENAI_API_KEY: 'k',
	ANALYZE_LIMITS: fakeKv(),
};

await check('analyze 跨站 Origin 在鉴权之前就被 403 拒掉', async () => {
	const res = await post(analyzePost, '/api/analyze', 'https://evil.example', analyzeEnv);
	assert.equal(res.status, 403);
	const body = await res.json();
	assert.equal(body.ok, false);
	return `403 ${body.error}`;
});

await check('analyze 本站 Origin 不会被误伤（走到鉴权才停）', async () => {
	const res = await post(analyzePost, '/api/analyze', 'https://build.laity.work', analyzeEnv);
	assert.notEqual(res.status, 403);
	const body = await res.json();
	assert.equal(body.error, '密码不正确');
	return `${res.status} ${body.error}`;
});

await check('analyze 无 Origin 时照旧放行（curl 排障不受影响）', async () => {
	const res = await post(analyzePost, '/api/analyze', undefined, analyzeEnv);
	assert.notEqual(res.status, 403);
	return `状态 ${res.status}`;
});

await check('analyze 跨站 Origin 不消耗配额', async () => {
	const kv = fakeKv();
	await post(analyzePost, '/api/analyze', 'https://evil.example', { ...analyzeEnv, ANALYZE_LIMITS: kv });
	assert.equal(kv.store.size, 0);
	return 'KV 里一条都没写';
});

await check('publish 跨站 Origin 被 403 拒掉', async () => {
	const res = await post(publishPost, '/api/publish', 'https://evil.example', {
		ADMIN_PASSWORD: 'right',
		GITHUB_TOKEN: 't',
	});
	assert.equal(res.status, 403);
	return `403 ${(await res.json()).error}`;
});

await check('publish 本站 Origin 走到密码校验', async () => {
	const res = await post(publishPost, '/api/publish', 'https://build.laity.work', {
		ADMIN_PASSWORD: 'right',
		GITHUB_TOKEN: 't',
	});
	assert.equal(res.status, 401);
	return `401 ${(await res.json()).error}`;
});

const failed = results.filter((r) => r.startsWith('FAIL'));console.log(results.join('\n'));
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
