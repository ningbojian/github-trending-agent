import { describe, expect, it } from 'vitest';
import { decideTextRoute } from '../src/wecom/route-decision';

describe('机会命令路由', () => {
  it.each(['机会', '下一步', '我能做什么', '有什么可以做的'])(
    '%s → opportunity handler',
    (text) => {
      expect(decideTextRoute(text)).toEqual({
        kind: 'handler',
        handler: 'opportunity',
      });
    },
  );

  it('不吞正常搜索', () => {
    expect(decideTextRoute('机会成本是什么')).not.toEqual({
      kind: 'handler',
      handler: 'opportunity',
    });
  });
});
