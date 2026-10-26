// 固定展示时区：frontmatter 允许写带偏移的时间戳，按 UTC 截取会串到前一天
export const formatDate = (date: Date) =>
	new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Asia/Shanghai',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(date);
