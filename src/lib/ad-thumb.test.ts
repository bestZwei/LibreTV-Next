import { describe, expect, it } from 'vitest';
import { buildMiniM3u8 } from './ad-thumb';

describe('buildMiniM3u8（条目预览清单）', () => {
  it('生成含 EXTINF/分片行与 ENDLIST 的合法 mini 清单', () => {
    const out = buildMiniM3u8([
      { u: 'https://cdn.example.com/a.ts', d: 5.57 },
      { u: '/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Fb.ts', d: 2.93 },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('#EXTM3U');
    expect(lines).toContain('#EXTINF:5.570,');
    expect(lines).toContain('https://cdn.example.com/a.ts');
    expect(lines).toContain('/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Fb.ts');
    expect(lines[lines.length - 1]).toBe('#EXT-X-ENDLIST');
  });

  it('时长缺失/非正数回退 4s', () => {
    const out = buildMiniM3u8([
      { u: 'a.ts', d: 0 },
      { u: 'b.ts', d: -1 },
    ]);
    expect(out).toContain('#EXTINF:4.000,');
    expect(out.match(/#EXTINF/g)).toHaveLength(2);
  });
});
