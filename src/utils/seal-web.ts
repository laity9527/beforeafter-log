// 浏览器侧的复算实现：/verify 页面用它，Node 侧的 src/utils/seal.ts 一个字都没改。
// 为什么是第二份实现而不是共用：seal.ts 依赖 node:crypto，属于存证协议的权威口径，
// 不能为了一个展示页去动它。两边必须逐字节等价，由 scripts/verify-web-checker.mjs 对拍保证。
export type WebStage = 'before' | 'after';

const toLf = (text: string) => text.replace(/\r\n/g, '\n');

// 与 seal.ts 的 normalizeText 同一条规则：只做 CRLF→LF，多裁一个换行就不是读者 curl 下来的那份字节
export const normalizeFile = (text: string) => toLf(text);

// 与 seal.ts 的 normalizeSection 同一条规则：额外裁尾部空白
const normalizeSection = (text: string) => toLf(text).replace(/\s+$/, '');

/** 段落含 `## <STAGE>` 标题行本身，到下一个 `## ` 标题行或文件末尾为止；找不到返回空串 */
export function extractSection(text: string, stage: WebStage): string {
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

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const fileHash = (text: string) => sha256Hex(normalizeFile(text));

export const sectionHash = (section: string) => sha256Hex(normalizeSection(section));
