/**
 * 多源条目的统一形状与抓取工具。
 *
 * 每个适配器只负责「把某个公开 API 映射成 SourceItemInput[]」；
 * 入库、日期、去重在 run-sources 里统一处理。测试通过 stub 全局 fetch
 * 验证映射，不触网。
 */

export interface SourceItemInput {
  source: string;
  sourceId: string;
  itemType: 'repo' | 'model' | 'space' | 'story';
  title: string;
  url: string;
  author?: string | null;
  description?: string | null;
  topics?: string[];
  metrics?: Record<string, number>;
}

export interface SourceAdapter {
  id: string;
  label: string;
  fetch(now: Date): Promise<SourceItemInput[]>;
}

/** 带超时与 UA 的 JSON 请求；非 2xx 直接抛错（由适配器/run-sources 隔离）。 */
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12_000,
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'user-agent': 'ghtrending-agent',
      accept: 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }
  return response.json();
}

/** 只保留有限数值，避免 NaN/Infinity 进 jsonb。 */
export function metric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 百分比/热度等通用排序键；缺字段时返回 0。 */
export function metricsOf(...pairs: Array<[string, unknown]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of pairs) {
    const n = metric(value);
    if (n !== undefined) out[key] = n;
  }
  return out;
}
