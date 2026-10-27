// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	// RSS 的 link/guid 由 site 派生，必须是访客实际使用的品牌域名。
	// 2026-10-27 复测：build.laity.work 解析到 Cloudflare（104.21.20.67 / 172.67.191.217 + 2 个 IPv6），
	// 直接 200 服务构建产物、无重定向，与 beforeafter-log.pages.dev 内容一致。
	site: 'https://build.laity.work',
});
