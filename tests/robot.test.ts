import { describe, expect, it } from 'vitest';
import { renderRobotMascot } from '../src/panel/robot';

const NOW = new Date('2026-10-30T04:00:00.000Z');

describe('renderRobotMascot', () => {
  it('每个视图道具都渲染在机器人手边', () => {
    for (const prop of ['search', 'calendar', 'star', 'note', 'gear'] as const) {
      const html = renderRobotMascot(null, NOW, { prop });
      expect(html).toContain('data-robot-stage');
      expect(html.split('<path').length).toBeGreaterThan(3);
    }
  });

  it('表情随 mood 变化', () => {
    const sleepy = renderRobotMascot(null, NOW, { mood: 'sleepy' });
    const happy = renderRobotMascot(null, NOW, { mood: 'happy' });
    expect(sleepy).toContain('data-mood="sleepy"');
    expect(happy).toContain('data-mood="happy"');
    expect(sleepy).not.toBe(happy);
  });

  it('传了 say 才渲染气泡（默认隐藏，点一下才出现）', () => {
    const withSay = renderRobotMascot(null, NOW, { say: '点我试试' });
    expect(withSay).toContain('class="p-robot-say" hidden');
    expect(withSay).toContain('点我试试');
    expect(renderRobotMascot(null, NOW)).not.toContain('p-robot-say');
  });

  it('气泡文案会被转义', () => {
    const html = renderRobotMascot(null, NOW, { say: '<script>x</script>' });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
