// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	// 品牌域名；build.laity.work 与 beforeafter-log.pages.dev 服务同一构建，前者无重定向。
	site: 'https://build.laity.work',
});
