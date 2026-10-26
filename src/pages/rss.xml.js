// @ts-check
import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

// astro.config.mjs 里没有配置 site，context.site 会是 undefined，所以显式兜底
const SITE = 'https://build.laity.work/';

export async function GET(context) {
	const logs = (await getCollection('log')).sort(
		(a, b) => b.data.before_written_at.getTime() - a.data.before_written_at.getTime()
	);

	return rss({
		title: '前后志',
		description: '不囤想法，直接上线。每个作品，都有做之前和做之后。',
		site: context.site ?? SITE,
		language: 'zh-CN',
		items: logs.slice(0, 20).map((log) => ({
			title: log.data.title,
			description: log.data.lesson_learned ?? '',
			pubDate: log.data.before_written_at,
			// 详情页 getStaticPaths 用 params.slug = log.id，链接必须同源
			link: `/log/${log.id}`,
			categories: log.data.tags,
		})),
	});
}
