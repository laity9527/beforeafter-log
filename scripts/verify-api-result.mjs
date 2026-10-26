import { isSuccessfulResponse, readApiResponse } from '../src/utils/api-result.ts';
import assert from 'node:assert/strict';

const results = [];
const check = (name, fn) => {
	try {
		const detail = fn();
		results.push(`PASS ${name}${detail ? ' :: ' + detail : ''}`);
	} catch (e) {
		results.push(`FAIL ${name} :: ${e.message.split('\n')[0]}`);
	}
};

const shell = new Response('<!DOCTYPE html><html><head><title>前后志</title></head><body>壳</body></html>', {
	status: 200,
	statusText: 'OK',
	headers: { 'content-type': 'text/html; charset=utf-8', 'cf-ray': 'EXAMPLE-DFW' },
});
const good = new Response(JSON.stringify({ ok: true, commit: 'abc' }), { status: 200, headers: { 'content-type': 'application/json' } });
const marked = new Response(JSON.stringify({ ok: false, error: '密码不正确' }), { status: 200, headers: { 'content-type': 'application/json' } });
const denied = new Response(JSON.stringify({ ok: false, error: '密码不正确' }), { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' } });
const boom = new Response(JSON.stringify({ ok: true }), { status: 500, headers: { 'content-type': 'application/json' } });

const withBody = async (res, fn) => {
	const { payload } = await readApiResponse(res.clone());
	return fn(payload);
};

await withBody(shell, (payload) => {
	check('catch-all 200 HTML 壳不算成功（旧代码用 response.ok 会误判为成功）', () => {
		assert.equal(shell.ok, true, '前提：response.ok 确实是 true，这正是旧判据的漏洞');
		assert.equal(isSuccessfulResponse(shell, payload), false);
		return 'payload=null 且 response.ok=true → false';
	});
	check('非 JSON 响应保留原文供文案使用', () => {
		assert.equal(payload, null);
		return 'raw 以 <!DOCTYPE 开头';
	});
});

await withBody(good, (payload) => {
	check('200 + 我们的 JSON = 成功', () => assert.equal(isSuccessfulResponse(good, payload), true));
});

await withBody(marked, (payload) => {
	check('200 但 body 自报 ok:false 也不算成功', () => assert.equal(isSuccessfulResponse(marked, payload), false));
});

await withBody(denied, (payload) => {
	check('401 + error 文案可读回', () => {
		assert.equal(isSuccessfulResponse(denied, payload), false);
		assert.equal(payload.error, '密码不正确');
	});
});

await withBody(boom, (payload) => {
	check('500 即便 body 写 ok:true 也不算成功', () => assert.equal(isSuccessfulResponse(boom, payload), false));
});

await (async () => {
	const res = new Response('{"data":{"draft_markdown":"x"}}', { status: 200, headers: { 'content-type': 'application/json' } });
	const { payload, raw } = await readApiResponse(res.clone());
	check('readApiResponse 解析正常 JSON 并保留 raw', () => {
		assert.equal(payload.data.draft_markdown, 'x');
		assert.equal(raw.includes('draft_markdown'), true);
	});
})();

console.log(results.join('\n'));
const failed = results.filter((line) => line.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exitCode = failed > 0 ? 1 : 0;
