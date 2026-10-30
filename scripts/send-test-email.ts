import {
  renderConfirmEmail,
  renderDigestEmail,
} from '../src/email/render.js';
import { emailConfigured, sendEmail } from '../src/email/send.js';
import type { DigestSnapshotItem } from '../src/agent/digest-snapshot.js';

/**
 * 真发一封测试邮件（走 Resend），用来验证域名、发件人和模板。
 *
 * 用法：
 *   npm run email:test -- you@example.com
 *   npm run email:test -- you@example.com --confirm
 *
 * 运行前在 .env 里设置：
 *   RESEND_API_KEY=re_...
 *   EMAIL_FROM=GitHub 热榜 <digest@your-verified-domain>
 *
 * 不要把 Key 发到聊天里；只写进 .env 或 Vercel 环境变量。
 */

try {
  process.loadEnvFile('.env');
} catch {
  // 没有 .env 就按 shell 环境变量跑。
}

const argv = process.argv.slice(2);
const to = argv.find((item) => !item.startsWith('-'));
const kind = argv.includes('--confirm') ? 'confirm' : 'digest';

if (!to) {
  console.error('用法：npm run email:test -- you@example.com [--confirm]');
  process.exit(1);
}

if (!emailConfigured()) {
  console.error(
    [
      '邮件通道未配置，发不出去。',
      '请在 .env 里设置：',
      '  RESEND_API_KEY=re_...',
      '  EMAIL_FROM=GitHub 热榜 <digest@你已验证的域名>',
      '发件人必须是 Resend 后台已验证的域名；测试阶段也可以用 onboarding@resend.dev，但只能发到 Resend 账号自己的邮箱。',
    ].join('\n'),
  );
  process.exit(1);
}

const base = process.env.PUBLIC_BASE_URL?.trim() || 'https://example.com';
const item = (fullName: string, stars: number, delta: number): DigestSnapshotItem => ({
  fullName,
  description: null,
  topics: [],
  language: 'typescript',
  stars,
  starsDelta: delta,
  isNew: delta > 0,
  htmlUrl: `https://github.com/${fullName}`,
  summary: '示例简介：这里会放模型生成的一句中文短句。',
});

let subject: string;
let text: string;
let html: string;

if (kind === 'confirm') {
  subject = '确认订阅 GitHub 热榜简报（测试）';
  text = `你好，这是一封测试确认信。\n\n${base}/api/email-confirm?t=preview-token\n\n链接 48 小时内有效。`;
  html = renderConfirmEmail({
    subject,
    lead: '你好，这是一封测试确认信。点击下面的按钮确认订阅 GitHub 热榜简报。',
    confirmUrl: `${base}/api/email-confirm?t=preview-token`,
    actionLabel: '确认订阅',
  });
} else {
  const digest = renderDigestEmail({
    date: new Date().toISOString().slice(0, 10),
    pushTime: '09:00',
    abstract: '今天的榜单集中在 Agent 工具与开发效率上。',
    items: [
      item('vercel/next.js', 128000, 321),
      item('astral-sh/ruff', 42000, 180),
      item('obra/superpowers', 1095, 1095),
    ],
    baseUrl: base,
    unsubToken: 'preview-token',
  });
  subject = `${digest.subject}（测试）`;
  text = digest.text;
  html = digest.html;
}

try {
  await sendEmail({ to, subject, text, html });
  console.log(`已提交给 Resend：${to}`);
  console.log('没收到时先看垃圾箱；再用 Resend 后台的 Logs 看投递状态。');
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`发送失败：${message}`);
  if (message.includes('401')) {
    console.error('401：API Key 无效。');
  } else if (message.includes('403')) {
    console.error('403：发件域名未验证，或 EMAIL_FROM 与已验证域名不一致。');
  } else if (message.includes('422')) {
    console.error('422：收件人/发件人格式被 Resend 拒绝。');
  } else if (message.includes('429')) {
    console.error('429：触发限流，稍后再试。');
  }
  process.exit(1);
}
