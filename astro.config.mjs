// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	// 部署实测在 Pages 默认域上；build.laity.work 无 A 记录，之前用它会让 feed 里每个 link/guid 都指向不存在的 host
	site: 'https://beforeafter-log.pages.dev',
});
