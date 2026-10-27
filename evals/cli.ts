import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatReport } from './report.js';
import { BASELINE_PATH, runEval } from './run.js';

/**
 * 命令行外壳：只负责参数、打印与退出码。
 *
 * - 0：阈值与基线都通过
 * - 1：阈值未过或有回退
 * - 2：评测自身出错（金标读不了、fixture 缺失等）
 */

interface CliOptions {
  compare: boolean;
  updateBaseline: boolean;
  json: boolean;
  mode: 'deterministic' | 'llm';
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    compare: false,
    updateBaseline: false,
    json: false,
    mode: 'deterministic',
  };
  for (const arg of argv) {
    if (arg === '--compare') options.compare = true;
    else if (arg === '--update-baseline') options.updateBaseline = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--llm') options.mode = 'llm';
  }
  return options;
}

export function exitCodeFor(ok: boolean): number {
  return ok ? 0 : 1;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runEval({ mode: options.mode, compare: options.compare });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }

  if (options.updateBaseline) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ metrics: result.metrics }, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`已写入基线：${BASELINE_PATH}\n`);
  }

  return exitCodeFor(result.ok);
}

// 只在被直接执行时跑；被测试 import 时不得产生副作用。
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`评测自身出错：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exitCode = 2;
    });
}
