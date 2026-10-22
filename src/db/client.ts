import { neon } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { env } from '../config.js';
import * as schema from './schema.js';

/**
 * 创建 Drizzle Neon HTTP 客户端（无长连接，适配 serverless / Actions）。
 * env 经 zod 校验，NEON_DATABASE_URL 缺失时在此抛出明确错误。
 */
export function db(): NeonHttpDatabase<typeof schema> {
  return drizzle({ client: neon(env.NEON_DATABASE_URL), schema });
}
