/**
 * 北京时间工具（Vercel 运行时为 UTC，直接 toISOString 会在早上 8 点前错一天）。
 * digest / digest-snapshot / email push 共用，避免循环依赖。
 */

const shanghaiDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 北京时间日期（YYYY-MM-DD）。 */
export function shanghaiToday(now: Date = new Date()): string {
  return shanghaiDateFormatter.format(now);
}

// hourCycle: 'h23' —— h24 会在午夜输出 "24:00"，门控分钟数与回执都会算错。
const shanghaiTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 北京时间「HH:MM」（补零，h23：午夜为 00:00）。 */
export function shanghaiHHMM(now: Date = new Date()): string {
  const parts = shanghaiTimeFormatter.formatToParts(now);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return `${hour}:${minute}`;
}

/** 北京时间当日分钟数（0–1439），与 preferences.pushTime 的分钟数同刻度比较。 */
export function shanghaiMinutes(now: Date = new Date()): number {
  const [hour, minute] = shanghaiHHMM(now).split(':');
  return Number(hour) * 60 + Number(minute);
}

/** 'YYYY-MM-DD' → 该日 UTC 零点毫秒数（只用于日期减法，与时区无关）。 */
function utcDay(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date);
}

/**
 * 两个北京日期（`YYYY-MM-DD`）之间的天数差：`to - from`。
 *
 * 为什么不用时间戳相减：推送门控的语义是「每天在用户选的时刻收到」，
 * 不是「距上次满 24 小时」。按毫秒差判断时，任何一次 tick 延迟（GitHub
 * Actions 的每小时 cron 实测会晚十几分钟）都会让次日同一时刻的 tick 差
 * 几分钟被跳过，实际发送时间于是永久后移——只会越推越晚，回不去。
 * 按日历日判断时，用户永远在「自己选的时刻之后的第一个 tick」收到。
 */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / 86_400_000);
}
