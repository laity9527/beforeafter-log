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

export const collections = { log };
