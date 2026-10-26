import { createHash } from 'node:crypto';

export type SealStage = 'before' | 'after';

export type SealRecord = {
	stage: SealStage;
	section_sha256: string;
	file_sha256: string;
	commit: string;
	sealed_at: string;
};

export type SealLedger = {
	slug: string;
	seals: SealRecord[];
};

const toLf = (text: string) => text.replace(/\r\n/g, '\n');

// 整文件指纹只做 CRLF→LF：它的定义就是「等于 curl 下来的 raw 字节」，
// 任何额外加工（哪怕裁一个尾随换行）都会让读者的一行复算命令对不上。
export const normalizeText = (text: string) => toLf(text);

// 段落指纹额外裁尾部空白：段落边界由下一个 `## ` 决定，中间空几行不该算造假。
const normalizeSection = (text: string) => toLf(text).replace(/\s+$/, '');

export const hashFile = (text: string) =>
	createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');

export const hashSection = (text: string) =>
	createHash('sha256').update(normalizeSection(text), 'utf8').digest('hex');

// 段落包含 `## <STAGE>` 标题行本身，到下一个 `## ` 标题行或文件末尾为止。
// 标题被删掉也算改动，所以标题行必须进指纹。
export function extractSection(text: string, stage: SealStage): string {
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

export function latestSeal(seals: SealRecord[], stage?: SealStage): SealRecord | undefined {
	for (let i = seals.length - 1; i >= 0; i--) {
		if (!stage || seals[i].stage === stage) return seals[i];
	}
	return undefined;
}

const short = (hash: string) => hash.slice(0, 12);

/**
 * 返回偏离描述，空数组表示与封存一致。
 * A 防整文件漂移，B 防某一段被单独改写。未封存的日志不参与校验。
 */
export function verifyLedger(ledger: SealLedger, rawText: string): string[] {
	const problems: string[] = [];
	const last = latestSeal(ledger.seals);
	if (!last) return problems;

	const fileHash = hashFile(rawText);
	if (fileHash !== last.file_sha256) {
		problems.push(`整文件漂移（封存之后内容又被改动）：期望 ${short(last.file_sha256)}… 实际 ${short(fileHash)}…`);
	}

	for (const stage of ['before', 'after'] as const) {
		const record = latestSeal(ledger.seals, stage);
		if (!record) continue;
		const sectionHash = hashSection(extractSection(rawText, stage));
		if (sectionHash !== record.section_sha256) {
			problems.push(`${stage.toUpperCase()} 段与封存时不一致：期望 ${short(record.section_sha256)}… 实际 ${short(sectionHash)}…`);
		}
	}

	return problems;
}
