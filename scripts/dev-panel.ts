#!/usr/bin/env node
/**
 * 本地面板调试服务：不依赖 Vercel CLI，直接把 `api/panel.ts` 挂到 Node http 上。
 *
 * 用法（仓库根目录）：
 *   npm run dev:panel
 *   npm run dev:panel ningbojian
 *   npm run dev:panel -- ningbojian --port 3001
 *
 * 不给 userid 时自动取数据库里第一个订阅者，并列出最多 5 个可选 userid。
 * 启动后打印一条可直接点开的签名链接（版本号与库里一致）。
 *
 * ⚠️ 读写都是**真实数据库**：面板里的收藏/记忆/订阅暂停会真的落库。
 * 想练手就用自己的 userid，别拿别人的。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // 没有 .env 就按当前 shell 的变量跑。
  }
}

interface CliArgs {
  userid?: string;
  port: number;
  /** 用户显式指定了端口；此时端口冲突直接报错，不自动顺延。 */
  explicitPort: boolean;
}

/**
 * 解析位置参数与 `--port`。
 *
 * npm 11 会把 `npm run x --port 3001` 里的 `--port` 当成自己的配置吃掉，
 * 只把值 `3001` 作为普通参数传给脚本（并打一条 warning）。所以除了
 * `--port 3001` / `--port=3001`，还要兜住「末尾裸数字」这种形态。
 */
function parseArgs(argv: string[], fallbackPort: number): CliArgs {
  const args = [...argv];
  let port: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
      args.splice(index, 1);
      index -= 1;
    } else if (arg === '--port') {
      port = Number(args[index + 1]);
      args.splice(index, 2);
      index -= 1;
    }
  }

  if (
    port === undefined &&
    args.length > 1 &&
    /^\d+$/.test(args[args.length - 1] ?? '')
  ) {
    port = Number(args.pop());
  }

  const userid = args.find((arg) => !arg.startsWith('-'));
  const valid =
    port !== undefined && Number.isInteger(port) && port > 0 && port < 65536;
  return {
    userid,
    port: valid ? port! : fallbackPort,
    explicitPort: valid,
  };
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

loadDotEnv();

const argv = process.argv.slice(2);
const cli = parseArgs(argv, 3000);
const explicitUser = cli.userid;

const [{ default: handler }, { db }, { subscribers }, { getPanelVersion }, { signPanelToken }] =
  await Promise.all([
    import('../api/panel.js'),
    import('../src/db/client.js'),
    import('../src/db/schema.js'),
    import('../src/panel/version.js'),
    import('../src/panel/token.js'),
  ]);

let userid = explicitUser;
if (!userid) {
  const rows = await db()
    .select({ userid: subscribers.wecomUserid })
    .from(subscribers)
    .limit(5);
  if (rows.length === 0) {
    console.error('数据库里没有订阅者。先发一条消息给机器人，或用 userid 参数指定。');
    process.exit(1);
  }
  userid = rows[0]!.userid;
  if (rows.length > 1) {
    console.log('可用 userid：' + rows.map((row) => row.userid).join(', '));
  }
}

const version = await getPanelVersion(userid);
const token = signPanelToken(userid, version);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // 静态资源（如 /docs/assets/emoji/*.svg）：Vercel 会直接服务，本地补上。
  if (url.pathname.startsWith('/docs/')) {
    const docsRoot = join(process.cwd(), 'docs');
    const filePath = join(process.cwd(), decodeURIComponent(url.pathname));
    if (!filePath.startsWith(docsRoot)) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const types: Record<string, string> = {
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
      };
      res.statusCode = 200;
      res.setHeader(
        'content-type',
        types[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      );
      res.end(readFileSync(filePath));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  const query: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const current = query[key];
    query[key] = current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value];
  }

  let statusCode = 200;
  const adapter = {
    status(code: number) {
      statusCode = code;
      return adapter;
    },
    setHeader(name: string, value: string) {
      res.setHeader(name, value);
      return adapter;
    },
    send(body: string) {
      res.statusCode = statusCode;
      res.end(body);
      return body;
    },
  };

  try {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    await handler(
      {
        method: req.method,
        query,
        body,
        headers: req.headers,
      },
      adapter,
    );
  } catch (err) {
    console.error('panel handler failed:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('本地调试服务出错，看终端日志。');
    }
  }
});

let activePort = cli.port;

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // 没显式指定端口时自动顺延，省得每次手动杀占用的进程。
    if (!cli.explicitPort && activePort < cli.port + 10) {
      activePort += 1;
      console.warn(`端口 ${activePort - 1} 被占用，改试 ${activePort}…`);
      server.listen(activePort);
      return;
    }
    console.error(
      `端口 ${activePort} 被占用。换一个：npm run dev:panel -- ${userid} --port ${activePort + 1}`,
    );
  } else {
    console.error('本地调试服务启动失败：', err);
  }
  process.exit(1);
});

server.listen(activePort, () => {
  const link = `http://localhost:${activePort}/api/panel?t=${encodeURIComponent(token)}`;
  console.log(`面板调试服务已启动：${link}`);
  console.log(`userid=${userid} · 端口 ${activePort} · 写操作会直接落真实数据库`);
  console.log('按 Ctrl+C 停止。');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // 连接迟迟不关（keep-alive）时也别卡住。
    setTimeout(() => process.exit(0), 800).unref();
  });
}
