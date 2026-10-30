import { eq, sql } from 'drizzle-orm';
import { SETKEY_TTL_MS, verifySetKeyToken } from '../src/agent/setkey-token.js';
import {
  PRESETS,
  pingLlm,
  saveUserLlm,
  validateUserLlmInput,
  type LlmPreset,
} from '../src/agent/user-llm.js';
import { db } from '../src/db/client.js';
import { kvCache } from '../src/db/schema.js';
import { readBodyFields } from '../src/http/body.js';
import {
  escapeHtml,
  sendHtml,
  type HtmlResponse,
} from '../src/http/html.js';
import {
  renderAppPage,
  renderMessagePage,
  type MessageTone,
} from '../src/ui/page.js';

/**
 * 网页表单：填自己的 AI Key（GET 渲染 / POST 保存，凭证是 15 分钟一次性 token）。
 *
 * 安全纪律：
 * - Key 只在这个 POST 请求体里出现一次，落库前 AES-256-GCM 加密；
 * - 本文件不把请求体写进任何日志，错误页与回显一律不含 Key（重渲染时输入框清空）；
 * - 保存前用用户的 Key 试连一次，连不通就不落库；
 * - 同一 token 只能提交一次（jti 记进 kv_cache，TTL 与 token 同期）。
 *
 * 视觉：表单与回执统一走 src/ui/page.ts 与 .p-* 类；不加载第三方资源。
 */

export interface SetKeyRequest {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

function firstParam(
  query: SetKeyRequest['query'],
  name: string,
): string | undefined {
  const value = query?.[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single == null || single === '' ? undefined : single;
}

/** 一次性标记的 kv key（与 repo-zh: / digest-snapshot: 等共享同一张表）。 */
function usedKey(jti: string): string {
  return `setkey-used:${jti}`;
}

/** 该 token 是否已被消费过。查询失败按「未用过」处理（签名仍是主要防线）。 */
async function isUsed(jti: string): Promise<boolean> {
  try {
    const rows = await db()
      .select()
      .from(kvCache)
      .where(eq(kvCache.key, usedKey(jti)));
    return rows.length > 0;
  } catch (err) {
    console.error('set-key used-check failed:', err);
    return false;
  }
}

/** 记下已消费的 jti（TTL 与 token 同期，过期自动可忽略）。 */
async function markUsed(jti: string): Promise<void> {
  try {
    await db()
      .insert(kvCache)
      .values({
        key: usedKey(jti),
        value: { usedAt: new Date().toISOString() },
        expiresAt: new Date(Date.now() + SETKEY_TTL_MS),
      })
      .onConflictDoUpdate({
        target: kvCache.key,
        set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      });
  } catch (err) {
    // 标记失败最多让同一链接能再提交一次；不值得让用户重填。
    console.error('set-key mark-used failed:', err);
  }
}

function messagePage(
  title: string,
  message: string,
  extra = '',
  tone: MessageTone = 'info',
): string {
  return renderMessagePage({ title, message, extraHtml: extra, tone });
}

function input(options: {
  name: string;
  value: string;
  type?: string;
  placeholder: string;
  inputmode?: string;
}): string {
  const attrs = [
    `class="p-input"`,
    `name="${escapeHtml(options.name)}"`,
    `type="${escapeHtml(options.type ?? 'text')}"`,
    `value="${escapeHtml(options.value)}"`,
    `placeholder="${escapeHtml(options.placeholder)}"`,
    options.inputmode ? `inputmode="${escapeHtml(options.inputmode)}"` : '',
    options.name === 'apiKey'
      ? 'autocomplete="new-password"'
      : 'autocomplete="off" autocorrect="off" autocapitalize="off"',
    'spellcheck="false"',
  ]
    .filter(Boolean)
    .join(' ');
  return `<input ${attrs}>`;
}

/**
 * 表单页。`values` 只回填接口地址与模型名 —— API Key 永远不回显（连掩码也不，
 * 因为重渲染时我们根本不再持有明文）。
 */
function formPage(options: {
  token: string;
  baseUrl: string;
  model: string;
  error?: string;
}): string {
  const action = `/api/set-key?t=${encodeURIComponent(options.token)}`;
  const presets = PRESETS.map(
    (preset: LlmPreset) =>
      `<a class="p-chip" href="${escapeHtml(`${action}&p=${preset.key}`)}">${escapeHtml(preset.label)}</a>`,
  ).join('');
  const error = options.error
    ? `<div class="p-banner err" role="alert">${escapeHtml(options.error)}</div>`
    : '';

  return renderAppPage({
    title: '设置模型',
    body: `${error}
    <p class="p-lead">填写任意 OpenAI 兼容接口。Key 只用于你自己的互动请求，不会出现在聊天记录里。</p>
    <div class="p-note">
      <div><b>你的 Key 会怎么处理</b></div>
      <div class="p-row-sub">· 只通过 HTTPS 提交一次，服务端用 AES-256-GCM 加密后存库</div>
      <div class="p-row-sub">· 每次互动时才在内存里解密，请求直连你填写的接口</div>
      <div class="p-row-sub">· 明文不会进入微信聊天、日志或缓存；日志里的 Key 会自动打码</div>
      <div class="p-row-sub">· 运营方持有部署密钥，技术上可以解密。介意的话请用可随时吊销的专用 Key，并可在面板「AI Key」卡片里删除</div>
    </div>
    <div class="p-chips">${presets}</div>
    <form method="post" action="${escapeHtml(action)}" class="p-mt">
      <label class="p-field">
        <span class="p-label">接口地址（Base URL）</span>
        ${input({
          name: 'baseUrl',
          value: options.baseUrl,
          placeholder: 'https://api.deepseek.com/v1',
          inputmode: 'url',
        })}
      </label>
      <label class="p-field">
        <span class="p-label">模型名</span>
        ${input({ name: 'model', value: options.model, placeholder: 'deepseek-chat' })}
      </label>
      <label class="p-field">
        <span class="p-label">API Key</span>
        ${input({ name: 'apiKey', value: '', type: 'password', placeholder: 'sk-…' })}
      </label>
      <button class="p-btn block" type="submit">保存</button>
    </form>`,
  });
}

/** 按 ?p= 预设预填接口地址与模型名（也用于回显用户刚提交的两个值）。 */
function prefill(
  query: SetKeyRequest['query'],
  submitted?: { baseUrl?: string; model?: string },
): { baseUrl: string; model: string } {
  if (submitted) {
    return { baseUrl: submitted.baseUrl ?? '', model: submitted.model ?? '' };
  }
  const preset = PRESETS.find((p) => p.key === firstParam(query, 'p'));
  return preset
    ? { baseUrl: preset.baseUrl, model: preset.model }
    : { baseUrl: '', model: '' };
}

export default async function handler(
  req: SetKeyRequest,
  res: HtmlResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') {
    sendHtml(res, 405, messagePage('请求方式不支持', '本端点支持 GET / POST。', '', 'err'));
    return;
  }

  const token = firstParam(req.query, 't');
  if (!token) {
    sendHtml(
      res,
      400,
      messagePage('链接无效', '缺少设置参数，请回微信重新发「设置模型」。', '', 'err'),
    );
    return;
  }
  const claim = verifySetKeyToken(token);
  if (!claim) {
    sendHtml(
      res,
      400,
      messagePage('链接无效或已过期', '请回微信重新发「设置模型」获取新链接。', '', 'err'),
    );
    return;
  }
  if (await isUsed(claim.jti)) {
    sendHtml(
      res,
      400,
      messagePage('链接已使用', '这个链接已经用过了，请回微信重新发「设置模型」。', '', 'err'),
    );
    return;
  }

  if (method === 'GET') {
    const values = prefill(req.query);
    sendHtml(res, 200, formPage({ token, ...values }));
    return;
  }

  const fields = readBodyFields(req.body);
  const validated = validateUserLlmInput({
    baseUrl: fields.baseUrl,
    model: fields.model,
    apiKey: fields.apiKey,
  });
  if (!validated.ok) {
    sendHtml(
      res,
      400,
      formPage({
        token,
        ...prefill(req.query, { baseUrl: fields.baseUrl, model: fields.model }),
        error: validated.error,
      }),
    );
    return;
  }

  const ping = await pingLlm(validated.config);
  if (!ping.ok) {
    sendHtml(
      res,
      400,
      formPage({
        token,
        ...prefill(req.query, validated.config),
        error: `试连失败，配置未保存。${ping.error}`,
      }),
    );
    return;
  }

  try {
    await saveUserLlm(claim.userid, validated.config);
  } catch (err) {
    // 只记原因：err 里可能带 SQL 参数（含密文），不打印对象本身。
    console.error(
      'set-key save failed:',
      err instanceof Error ? err.message : 'unknown error',
    );
    sendHtml(
      res,
      400,
      messagePage(
        '保存失败',
        '保存时出了点问题，请稍后重试或回微信重新发「设置模型」。',
        '',
        'err',
      ),
    );
    return;
  }
  await markUsed(claim.jti);

  sendHtml(
    res,
    200,
    messagePage(
      '已保存',
      '回到微信继续提问即可 —— 之后的互动使用你自己的 Key。',
      '<p class="p-hint">想换掉或删除：回微信发「清除模型」。</p>',
      'ok',
    ),
  );
}
