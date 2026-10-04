import { describe, expect, it } from 'vitest';
import { basenameOf, fragUrlsOf, stripSegments } from './ad-strip';

/** dytt 实测结构：正片 3 组 + 广告 2 组（n=3/n=2）+ 正片 2 组 */
function playlist(): string {
  return [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:8',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:4.171,',
    'aa11.ts?hash=h1',
    '#EXTINF:4.171,',
    'aa22.ts?hash=h2',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:5.570,',
    'bb11.ts?hash=h3',
    '#EXTINF:2.930,',
    'bb22.ts?hash=h4',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:5.700,',
    'cc11.ts?hash=h5',
    '#EXTINF:3.330,',
    'cc22.ts?hash=h6',
    '#EXTINF:1.530,',
    'cc33.ts?hash=h7',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:3.920,',
    'dd11.ts?hash=h8',
    '#EXTINF:3.440,',
    'dd22.ts?hash=h9',
    '#EXT-X-ENDLIST',
  ].join('\n');
}

describe('basenameOf', () => {
  it('从绝对/相对/带查询串的 URL 提取文件名', () => {
    expect(basenameOf('https://cdn.example.com/3000k/hls/cf33b9304cda.ts?hash=x')).toBe('cf33b9304cda.ts');
    expect(basenameOf('/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Fcf33b9304cda.ts')).toBe('cf33b9304cda.ts');
    expect(basenameOf('bb11.ts?hash=h3')).toBe('bb11.ts');
    expect(basenameOf('')).toBe('');
  });
});

describe('stripSegments（时间轴剔除）', () => {
  it('命中文件名的组整组移除，保留组前一个分段边界', () => {
    const out = stripSegments(playlist(), new Set(['bb11.ts', 'bb22.ts']));
    expect(out.changed).toBe(true);
    expect(out.text).not.toContain('bb11.ts');
    expect(out.text).not.toContain('bb22.ts');
    // 正片完整
    expect(out.text).toContain('aa11.ts');
    expect(out.text).toContain('cc11.ts');
    expect(out.text).toContain('dd22.ts');
    // 组前 DISCONTINUITY 随组删除：4 个边界剩 3 个
    expect(out.text.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(3);
  });

  it('组内 KEY/MAP 保留（正片可能复用解密配置）', () => {
    const lines = playlist().split('\n');
    lines.splice(7, 0, '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"');
    const out = stripSegments(lines.join('\n'), new Set(['bb11.ts']));
    expect(out.text).toContain('#EXT-X-KEY:METHOD=AES-128,URI="key.bin"');
    expect(out.text).not.toContain('bb11.ts');
  });

  it('无命中原样返回；空集合直接返回', () => {
    expect(stripSegments(playlist(), new Set(['nope.ts'])).changed).toBe(false);
    expect(stripSegments(playlist(), new Set()).changed).toBe(false);
  });
});

describe('fragUrlsOf', () => {
  it('收集分片地址', () => {
    expect(fragUrlsOf([
      { cc: 0, start: 0, duration: 4, url: 'https://c.example.com/x.ts' },
      { cc: 0, start: 4, duration: 4, url: 'https://c.example.com/y.ts' },
    ])).toEqual(['https://c.example.com/x.ts', 'https://c.example.com/y.ts']);
  });
});
