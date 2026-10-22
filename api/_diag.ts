/** 临时诊断端点（用完即删）：逐个动态 import 模块链，捕获模块加载期异常。
 * 鉴权：?token=<CRON_SECRET>，与简报端点同口令。 */
interface DiagReq {
  query: Record<string, string | string[] | undefined>;
}
interface DiagRes {
  status(code: number): DiagRes;
  setHeader(name: string, value: string): void;
  send(body: string): unknown;
}

export default async function handler(req: DiagReq, res: DiagRes): Promise<void> {
  if (req.query.token !== process.env.CRON_SECRET) {
    res.status(401).send('unauthorized');
    return;
  }
  const results: Record<string, string> = {};
  const modules: Record<string, () => Promise<unknown>> = {
    'src/config': () => import('../src/config'),
    'src/db/client': () => import('../src/db/client'),
    '@neondatabase/serverless': () => import('@neondatabase/serverless'),
    'drizzle-orm/neon-http': () => import('drizzle-orm/neon-http'),
    'ai': () => import('ai'),
    '@ai-sdk/anthropic': () => import('@ai-sdk/anthropic'),
    'src/agent/llm': () => import('../src/agent/llm'),
    'src/agent/digest': () => import('../src/agent/digest'),
    'src/wecom/api': () => import('../src/wecom/api'),
    'api/cron-push-digest': () => import('./cron-push-digest'),
    'api/wecom-callback': () => import('./wecom-callback'),
    'api/oauth-github': () => import('./oauth-github'),
  };
  for (const [name, load] of Object.entries(modules)) {
    try {
      await load();
      results[name] = 'ok';
    } catch (e) {
      results[name] = String((e as Error)?.stack ?? e).slice(0, 600);
    }
  }
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.status(200).send(JSON.stringify(results, null, 2));
}
