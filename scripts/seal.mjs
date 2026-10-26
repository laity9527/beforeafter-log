import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extractSection, hashFile, hashSection } from '../src/utils/seal.ts';

const STAGES = ['before', 'after'];

function fail(message) {
	console.error(`✗ ${message}`);
	process.exit(1);
}

const [slug, stage] = process.argv.slice(2);
if (!slug || !stage) fail('用法: npm run seal -- <slug> <before|after>');
if (!STAGES.includes(stage)) fail(`stage 只能是 ${STAGES.join(' 或 ')}`);

const mdPath = `src/content/logs/${slug}.md`;
const ledgerPath = `src/content/logs/${slug}.seal.json`;
if (!existsSync(mdPath)) fail(`找不到 ${mdPath}`);

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

// 封存对象必须已经在仓库里，否则记录里的 commit 会指向不含该内容的那次提交
if (git(['status', '--porcelain', '--', mdPath]).trim()) {
	fail(`${mdPath} 有未提交改动。先提交这份内容，再封存。`);
}

const commit = git(['log', '-1', '--format=%H', '--', mdPath]).trim();
if (!commit) fail(`${mdPath} 还没有任何提交，无法封存`);

const committed = git(['show', `${commit}:${mdPath}`]);
const section = extractSection(committed, stage);
if (!section) fail(`${mdPath}@${commit.slice(0, 7)} 里找不到 ## ${stage.toUpperCase()} 段落`);

const sectionSha = hashSection(section);
const fileSha = hashFile(committed);

let ledger;
if (existsSync(ledgerPath)) {
	try {
		ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
	} catch (error) {
		fail(`${ledgerPath} 不是合法 JSON：${error.message}`);
	}
	if (ledger.slug !== slug) fail(`${ledgerPath} 记的 slug 是 ${ledger.slug}，与 ${slug} 不一致`);
} else {
	ledger = { slug, seals: [] };
}

const previous = ledger.seals.filter((seal) => seal.stage === stage).at(-1);
if (previous && previous.file_sha256 === fileSha && previous.section_sha256 === sectionSha) {
	console.log(`= ${slug} 的 ${stage} 段与最近一次封存完全一致，没有追加`);
	process.exit(0);
}

ledger.seals.push({
	stage,
	section_sha256: sectionSha,
	file_sha256: fileSha,
	commit,
	sealed_at: new Date().toISOString(),
});

writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');

console.log(`✓ 已封存 ${slug} 的 ${stage.toUpperCase()} 段 -> ${ledgerPath}`);
console.log(`  段落 SHA-256 ${sectionSha.slice(0, 12)}…`);
console.log(`  整文件 SHA-256 ${fileSha.slice(0, 12)}…`);
console.log(`  锚定提交 ${commit.slice(0, 7)}（封存记录本身要单独提交一次，读者靠它看 diff）`);
