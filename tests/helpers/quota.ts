import {
  registerDigestCatchUp,
  registerQuotaChecker,
} from '../../src/wecom/router';

/**
 * 测试默认放行限流、并跳过「漏跑自愈」。
 *
 * 路由器现在每条文本都会先问一次配额（生产读 kv_cache），还会检查今天是否
 * 该补发简报（读 subscribers）。绝大多数用例关心的是分发逻辑，不该为此连库。
 * 需要验证限流/自愈的用例在测试内部再 register 覆盖即可。
 */
export function allowAllQuota(): void {
  registerQuotaChecker(async () => ({
    allowed: true,
    reason: null,
    retryAfterSeconds: 0,
  }));
  registerDigestCatchUp(async () => false);
}
