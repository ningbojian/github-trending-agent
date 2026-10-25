/** Vercel 按 content-type 预解析 body：端点必须同时接受 string / Buffer / 已解析对象。 */

function fromStringAll(text: string): Record<string, string[]> {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return fromObjectAll(JSON.parse(trimmed) as unknown);
    } catch {
      // 非法 JSON → 继续按 urlencoded 解析。
    }
  }
  const out: Record<string, string[]> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    (out[key] ??= []).push(value);
  }
  return out;
}

function fromObjectAll(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(raw)) {
      out[key] = raw.map((item) => String(item));
    } else if (raw !== null && raw !== undefined) {
      out[key] = [String(raw)];
    }
  }
  return out;
}

/** 与 readBodyFields 相同，但保留多值字段（复选框等）。 */
export function readBodyFieldsAll(body: unknown): Record<string, string[]> {
  if (body === null || body === undefined) return {};
  if (typeof body === 'string') return fromStringAll(body);
  if (Buffer.isBuffer(body)) return fromStringAll(body.toString('utf8'));
  if (typeof body === 'object') return fromObjectAll(body);
  return {};
}

/** 把任意形态的请求体归一为「字段名 → 首个字符串值」。 */
export function readBodyFields(body: unknown): Record<string, string> {
  const all = readBodyFieldsAll(body);
  const out: Record<string, string> = {};
  for (const [key, values] of Object.entries(all)) {
    out[key] = values[0] ?? '';
  }
  return out;
}
