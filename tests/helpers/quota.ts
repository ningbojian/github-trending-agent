import { registerQuotaChecker } from '../../src/wecom/router';

/**
 * 测试默认放行限流。
 *
 * 路由器现在每条文本都会先问一次配额（生产读 kv_cache）。绝大多数用例关心的是
 * 分发逻辑，不该为此连生产库、也不该被 20 条/分钟的上限误伤。
 * 需要验证限流的用例在测试内部再 registerQuotaChecker 覆盖一次即可。
 */
export function allowAllQuota(): void {
  registerQuotaChecker(async () => ({
    allowed: true,
    reason: null,
    retryAfterSeconds: 0,
  }));
}
