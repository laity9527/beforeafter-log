// 接口响应判定：浏览器端与 Node 都能用，只依赖 Response/text，不碰任何 Node 专有 API
export type ApiPayload = Record<string, unknown> | null;

export type ReadResult = { payload: ApiPayload; raw: string };

// response.body 只能读一次：先取文本再尝试 JSON，解析失败时保留原文供文案使用
export async function readApiResponse(response: Response): Promise<ReadResult> {
	const raw = await response.text();
	try {
		return { payload: JSON.parse(raw) as ApiPayload, raw };
	} catch {
		return { payload: null, raw };
	}
}

// 状态码成功 + 确实拿到我们自己的 JSON + 没被标记为失败，才算成功。
// 只看 response.ok 会被 catch-all 静态托管骗到：未知路径也回 200，但正文是首页 HTML 壳。
export function isSuccessfulResponse(response: Response, payload: ApiPayload): boolean {
	return response.ok && typeof payload === 'object' && payload !== null && payload.ok !== false;
}
