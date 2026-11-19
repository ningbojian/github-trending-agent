import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderConfirmEmail,
  renderDigestEmail,
  renderManageEmail,
} from '../src/email/render.js';
import type { DigestSnapshotItem } from '../src/agent/digest-snapshot.js';
import type { OpportunityItem } from '../src/opportunities/types.js';

/**
 * 邮件模板预览：不连网、不发信，把三封邮件写成 HTML 文件，直接用浏览器打开。
 *
 * 用法：npm run email:preview
 * 输出目录是系统临时目录；终端会打印三个绝对路径。
 */

const base = 'https://example.com';
const previewItem = (fullName: string, stars: number, delta: number): DigestSnapshotItem => ({
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

const previewOpportunity: OpportunityItem = {
  id: 'contribute:astral-sh/ruff#123',
  kind: 'contribute',
  repo: 'astral-sh/ruff',
  issueNumber: 123,
  title: 'Windows 下 CUDA 检测失败',
  body: '示例 issue 正文。',
  url: 'https://github.com/astral-sh/ruff/issues/123',
  language: 'rust',
  topics: ['lint'],
  stars: 42000,
  license: 'MIT',
  archived: false,
  pushedAt: '2026-11-10T00:00:00Z',
  labels: ['good first issue'],
  comments: 4,
  reactions: 6,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-16T00:00:00Z',
  maintainerEngaged: true,
  assigned: false,
  linkedPr: false,
  score: 86,
  why: '复现路径清晰，维护者刚回复过。',
  firstStep: '按 issue 里的步骤跑一遍，贴 log 并认领。',
  effort: '小',
  confidence: '高',
  evidence: [],
};

const digest = renderDigestEmail({
  date: '2026-10-29',
  pushTime: '09:00',
  abstract: '今天的榜单集中在 Agent 工具与开发效率上。',
  items: [
    previewItem('vercel/next.js', 128000, 321),
    previewItem('astral-sh/ruff', 42000, 180),
    previewItem('obra/superpowers', 1095, 1095),
  ],
  poolSize: 20,
  opportunities: [previewOpportunity],
  baseUrl: base,
  unsubToken: 'preview-token',
});

const files: Array<[string, string]> = [
  [
    'email-confirm.html',
    renderConfirmEmail({
      subject: '确认订阅 GitHub 热榜简报',
      lead: '你好，点击下面的按钮确认订阅 GitHub 热榜简报。',
      confirmUrl: `${base}/api/email-confirm?t=preview-token`,
      actionLabel: '确认订阅',
    }),
  ],
  [
    'email-manage.html',
    renderManageEmail({
      settingsUrl: `${base}/api/email-settings?t=preview-token`,
      unsubscribeUrl: `${base}/api/email-unsubscribe?t=preview-token`,
    }),
  ],
  ['email-digest.html', digest.html],
];

for (const [name, html] of files) {
  const path = join(tmpdir(), name);
  writeFileSync(path, html, 'utf8');
  console.log(path);
}
