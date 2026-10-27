import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	extractSection as nodeExtract,
	hashFile as nodeFileHash,
	hashSection as nodeSectionHash,
} from '../src/utils/seal.ts';
import { extractSection as webExtract, fileHash as webFileHash, sectionHash as webSectionHash } from '../src/utils/seal-web.ts';

// /verify 页面用的是一套独立实现。这个对拍保证它对同一份输入产出和协议实现一样的指纹，
// 否则「网页校验器」会变成一个把真内容判成假的按钮。
const results = [];
const check = async (name, fn) => {
	try {
		const detail = await fn();
		results.push(`PASS ${name}${detail ? ' :: ' + detail : ''}`);
	} catch (e) {
		results.push(`FAIL ${name} :: ${String(e.message).split('\n')[0]}`);
	}
};

const REAL = readFileSync('src/content/logs/why-this-site.md', 'utf8');
const LEDGER = JSON.parse(readFileSync('src/content/logs/why-this-site.seal.json', 'utf8'));
const BEFORE_SEAL = LEDGER.seals.find((s) => s.stage === 'before');

async function pair(text) {
	const node = {
		file: nodeFileHash(text),
		before: nodeSectionHash(nodeExtract(text, 'before')),
		after: nodeSectionHash(nodeExtract(text, 'after')),
	};
	const web = {
		file: await webFileHash(text),
		before: await webSectionHash(webExtract(text, 'before')),
		after: await webSectionHash(webExtract(text, 'after')),
	};
	assert.deepEqual(web, node, `两边不一致\nnode=${JSON.stringify(node)}\nweb =${JSON.stringify(web)}`);
	return node;
}

const cases = [
	['真实日志原文', REAL],
	['CRLF 版本', REAL.replace(/\n/g, '\r\n')],
	['尾部多个空行', REAL + '\n\n\n\n'],
	['尾部空白与制表', REAL + '  \t\n \n'],
	['没有结尾换行', REAL.replace(/\n$/, '')],
	['小写段落标题', REAL.replace('## BEFORE', '## before')],
	['段落标题带尾随空格', REAL.replace('## BEFORE', '## BEFORE   ')],
	['整段缺失', REAL.replace(/## AFTER[\s\S]*$/, '')],
	['段落之间空几行', REAL.replace('## AFTER', '\n\n\n## AFTER')],
	['只有标题没有正文', '## BEFORE\n## AFTER\n'],
	['空串', ''],
	['单行', '就一句话'],
	['单独的 \\r 不算换行', '## BEFORE\r中间一个裸回车\r\n第二行\n'],
	['中日韩与 emoji', '## BEFORE\n判断：上线 🚀 之前\n\n## AFTER\n之后 ✅\n'],
	['标题里含 BEFORE 字样不误判', '正文里提到 ## BEFORENOTES 的行\n## BEFORE\n真段落\n'],
];

for (const [name, text] of cases) {
	await check(`双实现一致：${name}`, async () => {
		const out = await pair(text);
		return `file=${out.file.slice(0, 8)}…`;
	});
}

// 真实账本这一条最关键：/verify 页面展示的指纹就是它，算错就说明校验器本身在骗人
await check('与线上账本记录的指纹逐字节相符', async () => {
	const out = await pair(REAL);
	assert.equal(out.file, BEFORE_SEAL.file_sha256);
	assert.equal(out.before, BEFORE_SEAL.section_sha256);
	return `整文件 ${out.file.slice(0, 12)}… / BEFORE 段 ${out.before.slice(0, 12)}…`;
});

const skipped = [];

await check('远端 raw 字节复算等于账本（协议口径不看本地工作区）', async () => {
	let res;
	try {
		res = await fetch(
			'https://raw.githubusercontent.com/laity9527/beforeafter-log/main/src/content/logs/why-this-site.md'
		);
	} catch (error) {
		skipped.push(`远端对拍跳过：${error.message}`);
		return '跳过（网络不可达，不影响本地等价性结论）';
	}
	if (!res.ok) {
		skipped.push(`远端对拍跳过：HTTP ${res.status}`);
		return `跳过（远端返回 ${res.status}）`;
	}
	const remote = await res.text();
	const out = await pair(remote);
	assert.equal(out.file, BEFORE_SEAL.file_sha256);
	assert.equal(out.before, BEFORE_SEAL.section_sha256);
	return '远端与本地工作区算出的指纹相同';
});

const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(results.join('\n'));
for (const line of skipped) console.log(`SKIP ${line}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
