import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const log = defineCollection({
	// deferRender 保持关闭：详情页直接读 entry.rendered.html 插入 BEFORE/AFTER 分隔线
	loader: glob({ base: './src/content/logs', pattern: '**/*.md', deferRender: false }),
	schema: z.object({
		title: z.string(),
		work_slug: z.string(),
		tags: z.array(z.string()),
		before_written_at: z.date(),
		after_written_at: z.date().optional(),
		lesson_learned: z.string().optional(),
	}),
});

const sealRecord = z.object({
	stage: z.enum(['before', 'after']),
	section_sha256: z.string().length(64),
	file_sha256: z.string().length(64),
	commit: z.string().length(40),
	sealed_at: z.string(),
});

// 封存账本是 sidecar，不在上面的 **/*.md 里，所以不会变成一条日志
const seal = defineCollection({
	loader: glob({ base: './src/content/logs', pattern: '**/*.seal.json' }),
	schema: z.object({
		slug: z.string(),
		seals: z.array(sealRecord),
	}),
});

export const collections = { log, seal };
