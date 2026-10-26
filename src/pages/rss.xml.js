// @ts-check
import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
	// link 与 guid 都由 site 派生，订阅端靠 guid 去重，所以站点地址必须配在 astro.config.mjs
	if (!context.site) {
		throw new Error('缺少 site 配置，RSS 的 link/guid 无法生成绝对地址');
	}

	const logs = (await getCollection('log')).sort(
		(a, b) => b.data.before_written_at.getTime() - a.data.before_written_at.getTime()
	);

	return rss({
		title: '前后志',
		description: '不囤想法，直接上线。每个作品，都有做之前和做之后。',
		site: context.site,
		language: 'zh-CN',
		items: logs.slice(0, 20).map((log) => {
			// 正文取 eager-render 结果，与详情页同一份；deferRender 一旦被打开这里就是 undefined
			const content = log.rendered?.html;
			if (content === undefined) {
				throw new Error(`日志 ${log.id} 没有渲染结果，检查 src/content.config.ts 的 deferRender`);
			}

			return {
				title: log.data.title,
				description: log.data.lesson_learned ?? '',
				pubDate: log.data.before_written_at,
				// 详情页 getStaticPaths 用 params.slug = log.id，链接必须同源
				link: `/log/${log.id}`,
				categories: log.data.tags,
				content,
			};
		}),
	});
}
