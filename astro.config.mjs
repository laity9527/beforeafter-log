// @ts-check
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	// 品牌域名；build.laity.work 与 beforeafter-log.pages.dev 服务同一构建，前者无重定向。
	site: 'https://build.laity.work',
	// 不设 trailingSlash：现有 URL 已带尾斜杠形式，改配置会让 feed guid 与外部分享链接集体换形
	// /admin 是发布后台，robots.txt 已 Disallow，这里同步排除。
	// 注意 3.x 没有 exclude 键：传未知键只会 WARN 然后整份 sitemap 不产出，得用 filter。
	// filter 拿到的是拼好 site 之后的绝对 URL（node_modules/@astrojs/sitemap/dist/index.js:67），
	// 所以必须 new URL(...).pathname 再比前缀，直接 startsWith('/admin') 永远不成立。
	integrations: [sitemap({ filter: (page) => !new URL(page).pathname.startsWith('/admin') })],
});
