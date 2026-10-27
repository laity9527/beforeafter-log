import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extractSection, hashFile, hashSection, verifyLedger } from '../src/utils/seal.ts';

// 构建门禁信的是工作区里的 .seal.json。账本被删掉时 ledger 直接是 undefined，
// verifyLedger 根本不会被调用，正文可以随便改还能照常发布（实测过：移走 sidecar 后 build 全绿、
// 详情页显示「未封存」）。这个脚本把账本从 git 历史里重新推出来，只追加、不回滚这条约定
// 因此第一次有机器可查的依据。
const LOG_DIR = 'src/content/logs';
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (args) => {
	try {
		return git(args);
	} catch {
		return null;
	}
};

const reds = [];
const warns = [];
const oks = [];
const short = (h) => h.slice(0, 12);

// 这三层里只有最后一层不需要 git。git 不可用或浅克隆时，锚定重算与「只追加」都无从谈起，
// 脚本必须明说「这两项没生效」而不是悄悄当成通过——否则接进 npm run build 之后，
// 在一个没有历史的构建环境里，删账本这条攻击面会重新变成绿灯。
const gitDir = tryGit(['rev-parse', '--git-dir']);
const shallow = gitDir !== null && tryGit(['rev-parse', '--is-shallow-repository'])?.trim() === 'true';
const historyOk = gitDir !== null && !shallow;
if (gitDir === null) {
	warns.push('找不到可用的 git 仓库：锚定重算、账本防删、防回滚三项全部未执行，只核对了工作区正文与账本');
} else if (shallow) {
	warns.push('浅克隆：锚定提交与账本历史不在本地，锚定重算、账本防删、防回滚三项未执行。CI 里请 fetch-depth: 0');
}

const slugOf = (file) => file.replace(/\.md$/, '');
const mdFiles = readdirSync(LOG_DIR).filter((f) => f.endsWith('.md'));

// 账本在历史上出现过的全部记录，用于「只追加」比对
function historicalRecords(ledgerPath) {
	if (!historyOk) return null;
	const commits = (tryGit(['log', '--format=%H', '--', ledgerPath]) ?? '').split('\n').filter(Boolean);
	const seen = new Set();
	for (const commit of commits) {
		const raw = tryGit(['show', `${commit}:${ledgerPath}`]);
		if (raw === null) continue;
		let doc;
		try {
			doc = JSON.parse(raw);
		} catch {
			continue; // 历史里那份坏了由它自己负责，这里只关心当前账本有没有少记
		}
		for (const seal of doc.seals ?? []) seen.add(JSON.stringify(seal));
	}
	return seen;
}

const tuple = (s) => `${s.stage}/${s.section_sha256}/${s.file_sha256}/${s.commit}`;

for (const file of mdFiles) {
	const slug = slugOf(file);
	const mdPath = `${LOG_DIR}/${file}`;
	const ledgerPath = `${LOG_DIR}/${slug}.seal.json`;
	const label = slug;

	if (!existsSync(ledgerPath)) {
		// 没有账本本身不奇怪（新发布的日志就是未封存），但历史上存过账本又消失就是造假路径
		const everCommitted = historyOk && (tryGit(['log', '--format=%H', '--', ledgerPath]) ?? '').trim() !== '';
		if (everCommitted) reds.push(`${label}: 工作区没有 ${slug}.seal.json，但 git 历史里有 —— 账本被删或被漏提交，正文现在不受任何约束`);
		else if (historyOk) oks.push(`${label}: 未封存（历史里也没有账本），不参与门禁`);
		else warns.push(`${label}: 工作区没有账本，但在没有 git 历史的环境里无法判断它是否被删过`);
		continue;
	}

	let ledger;
	try {
		ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
	} catch (error) {
		reds.push(`${label}: ${slug}.seal.json 不是合法 JSON —— ${error.message}`);
		continue;
	}

	if (ledger.slug !== slug) reds.push(`${label}: 账本里写的 slug 是 ${ledger.slug}`);
	if (!Array.isArray(ledger.seals)) {
		reds.push(`${label}: 账本里没有 seals 数组`);
		continue;
	}

	// 每条记录都要能拿锚定提交里的原文重算出来，不接受账本自说自话
	for (const seal of ledger.seals) {
		const where = `${label} @${String(seal.commit).slice(0, 7)}/${seal.stage}`;
		if (!HEX40.test(String(seal.commit))) {
			reds.push(`${where}: commit 不是 40 位十六进制`);
			continue;
		}
		if (!HEX64.test(String(seal.section_sha256)) || !HEX64.test(String(seal.file_sha256))) {
			reds.push(`${where}: 指纹不是 64 位十六进制`);
			continue;
		}
		if (!['before', 'after'].includes(seal.stage)) {
			reds.push(`${where}: stage 只能是 before 或 after`);
			continue;
		}
		if (!historyOk) continue;
		if (tryGit(['cat-file', '-e', `${seal.commit}^{commit}`]) === null) {
			reds.push(`${where}: 锚定提交在本地仓库里找不到，这条封存无法核对`);
			continue;
		}
		const committed = tryGit(['show', `${seal.commit}:${mdPath}`]);
		if (committed === null) {
			reds.push(`${where}: 锚定提交里没有 ${mdPath}`);
			continue;
		}
		const fileHash = hashFile(committed);
		if (fileHash !== seal.file_sha256) {
			reds.push(`${where}: 锚定提交的整文件指纹对不上（账本期望 ${short(seal.file_sha256)}… 实际 ${short(fileHash)}…）`);
		}
		const sectionHash = hashSectionFrom(committed, seal.stage);
		if (sectionHash !== seal.section_sha256) {
			reds.push(`${where}: ${seal.stage.toUpperCase()} 段指纹对不上（账本期望 ${short(seal.section_sha256)}… 实际 ${short(sectionHash)}…）`);
		}
	}

	// 只追加：历史上记过的每一条，今天的账本里都还得在
	const history = historicalRecords(ledgerPath);
	if (history) {
		const present = new Set(ledger.seals.map(tuple));
		for (const raw of history) {
			let seal;
			try {
				seal = JSON.parse(raw);
			} catch {
				continue;
			}
			if (!present.has(tuple(seal))) {
				reds.push(`${label}: 账本少了历史记录里有过的一条 ${seal.stage}@${String(seal.commit).slice(0, 7)} —— 封存记录只能追加`);
			}
		}
	}

	// 最后才是构建门禁同一件事：当前正文 vs 账本最新一次
	const problems = verifyLedger(ledger, readFileSync(mdPath, 'utf8'));
	for (const problem of problems) reds.push(`${label}: ${problem}`);
	if (problems.length === 0 && !reds.some((r) => r.startsWith(`${label}:`))) {
		oks.push(
			`${label}: ${ledger.seals.length} 条封存记录${historyOk ? '全部可从 git 重算' : '（无 git 历史，仅校验字段形状）'}，正文未漂移`
			);
	}
}

function hashSectionFrom(text, stage) {
	return hashSection(extractSection(text, stage));
}

for (const line of oks) console.log(`  ok   ${line}`);
for (const line of warns) console.log(`  warn ${line}`);
for (const line of reds) console.log(`  RED  ${line}`);

console.log(`\n${reds.length} 项不通过，${oks.length} 项通过${warns.length ? `，${warns.length} 条提醒` : ''}`);
if (reds.length > 0) process.exitCode = 1;
