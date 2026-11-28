import { describe, expect, it } from 'vitest';
import { decideTextRoute } from '../src/wecom/route-decision';

describe('面板命令路由', () => {
  it.each(['我的面板', '面板', '打开面板'])('%s → panel handler', (text) => {
    expect(decideTextRoute(text)).toEqual({
      kind: 'handler',
      handler: 'panel',
    });
  });

  it('带尾标点的「打开面板。」同样命中', () => {
    expect(decideTextRoute('打开面板。')).toEqual({
      kind: 'handler',
      handler: 'panel',
    });
  });

  it('不吞长句：带后缀的说法照常落搜索', () => {
    for (const text of ['打开面板的链接', '面板在哪里看', '打开面板看看']) {
      expect(decideTextRoute(text)).toEqual({ kind: 'handler', handler: 'search' });
    }
  });
});
