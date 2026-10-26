const OWNER = 'laity9527';
const REPO = 'beforeafter-log';
const BRANCH = 'main';

const projectPath = (slug: string) => `src/content/logs/${slug}.md`;

export const commitsUrl = (slug: string) =>
	`https://github.com/${OWNER}/${REPO}/commits/${BRANCH}/${projectPath(slug)}`;

export const commitUrl = (sha: string) => `https://github.com/${OWNER}/${REPO}/commit/${sha}`;

export const blobUrl = (sha: string, slug: string) =>
	`https://github.com/${OWNER}/${REPO}/blob/${sha}/${projectPath(slug)}`;

// GitHub 提供的是仓库内 blob 的原始字节（LF），所以读者本地一行命令就能复算整文件哈希
export const rawUrl = (slug: string) =>
	`https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${projectPath(slug)}`;

export const verifyCommand = (slug: string) => `curl -sL ${rawUrl(slug)} | sha256sum`;
