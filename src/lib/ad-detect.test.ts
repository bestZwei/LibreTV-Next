import { describe, expect, it, beforeEach } from 'vitest';
import {
  computeGroupInfos,
  applyKnownFingerprints,
  stripAds,
  stripAdsDetailed,
  setActiveFingerprints,
  registerEpisodeGroups,
  lookupGroupBySegmentUrl,
  resetEpisodeGroups,
  isShortGroupCandidate,
  type AdGroupInfo,
} from './ad-detect';
import { PLAYLIST as EP1251 } from './__fixtures__/ep1251';
import { PLAYLIST as EP1250 } from './__fixtures__/ep1250';

/** 造一个「N 片 × D 秒」的组（不含组前 DISCONTINUITY） */
function group(dur: number, count: number, prefix: string): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) lines.push(`#EXTINF:${dur},`, `${prefix}${i}.ts`);
  return lines;
}

/** 组间以 DISCONTINUITY 分隔（首组前不加——与「首组 = 文件头到首个标记」的定义一致） */
function buildPlaylist(groups: string[][]): string {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:8'];
  groups.forEach((g, i) => {
    if (i > 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(...g);
  });
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

describe('computeGroupInfos', () => {
  it('按 DISCONTINUITY 切组并产出逐分片时长签名', () => {
    const content = buildPlaylist([group(4, 5, 'a'), group(5.567, 2, 'b'), group(6, 5, 'c')]);
    const infos = computeGroupInfos(content);
    expect(infos).toHaveLength(3);
    expect(infos[1].signature).toBe('5.567|5.567');
    expect(infos[2].seconds).toBe(30);
    expect(infos[2].segmentLines).toEqual(['c0.ts', 'c1.ts', 'c2.ts', 'c3.ts', 'c4.ts']);
  });

  it('门控：首组/尾组不入册', () => {
    const mid = ['#EXTINF:5,', 'mid0.ts', '#EXTINF:6,', 'mid1.ts'];
    const infos = computeGroupInfos(buildPlaylist([group(4, 5, 'a'), mid, group(4, 5, 'z')]));
    expect(infos[0].eligible).toBe(false);
    expect(infos[1].eligible).toBe(true);
    expect(infos[2].eligible).toBe(false);
  });

  it('门控：全等长签名视为封装节奏（4.171×5 是真实假阳性来源）', () => {
    const infos = computeGroupInfos(
      buildPlaylist([group(4, 5, 'a'), group(4.171, 5, 'mid'), group(4, 5, 'z')])
    );
    expect(infos[1].signature).toBe('4.171|4.171|4.171|4.171|4.171');
    expect(infos[1].eligible).toBe(false);
  });

  it('门控：单片组不入册（GOP 整数值如 "4.004" 跨集可能巧合相撞，宁漏勿杀）', () => {
    const infos = computeGroupInfos(
      buildPlaylist([group(4, 5, 'a'), group(14.2, 1, 'mid'), group(4, 5, 'z')])
    );
    expect(infos[1].signature).toBe('14.2');
    expect(infos[1].eligible).toBe(false);
  });

  it('门控：超过 60s 的组不入册（OP/ED 通常为长组）', () => {
    const infos = computeGroupInfos(
      buildPlaylist([group(4, 5, 'a'), group(30, 3, 'op'), group(4, 5, 'z')])
    );
    expect(infos[1].seconds).toBe(90);
    expect(infos[1].eligible).toBe(false);
  });

  it('门控：无分片 / 零时长的组不入册', () => {
    const content = [
      '#EXTM3U',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:5,', 'a0.ts', '#EXTINF:4,', 'a1.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:5,', 'b0.ts', '#EXTINF:4,', 'b1.ts',
    ].join('\n');
    const infos = computeGroupInfos(content);
    // 连续两个 DISCONTINUITY 产生两个空组（无分片 → 不入册），其后是正常组
    expect(infos[0].eligible).toBe(false);
    expect(infos[1].eligible).toBe(false);
    expect(infos[2].eligible).toBe(true);
  });
});

describe('dytt 真实样本（ep1251 fixture）', () => {
  const infos = computeGroupInfos(EP1251);

  it('分组数与已知结构一致（69 组，首组为前导标记前的空组）', () => {
    expect(infos).toHaveLength(69);
    expect(infos[0].segmentCount).toBe(0);
  });

  it('广告组签名精确已知：group 14 = 5.567|2.933|5.700，group 15 = 3.333|1.533', () => {
    expect(infos[14].signature).toBe('5.567|2.933|5.700');
    expect(infos[14].segmentCount).toBe(3);
    expect(infos[15].signature).toBe('3.333|1.533');
    expect(infos[15].segmentCount).toBe(2);
    expect(infos[14].eligible).toBe(true);
    expect(infos[15].eligible).toBe(true);
  });

  it('group 13（4 片/18.1s）是正片短组：可作跳过候选，但结构上不可删除', () => {
    expect(infos[13].segmentCount).toBe(4);
    expect(infos[13].seconds).toBeCloseTo(18.1, 1);
    expect(infos[13].eligible).toBe(true);
  });

  it('跨集全量回归：ep1250 与 ep1251 门控内签名交集恰为两个广告组（122 组零假阳性）', () => {
    const a = new Set(computeGroupInfos(EP1250).filter((g) => g.eligible).map((g) => g.signature));
    const b = infos.filter((g) => g.eligible).map((g) => g.signature);
    const common = b.filter((s) => a.has(s));
    expect(common.sort()).toEqual(['3.333|1.533', '5.567|2.933|5.700'].sort());
  });
});

describe('applyKnownFingerprints', () => {
  beforeEach(() => setActiveFingerprints([]));

  it('活跃表为空时原样返回', () => {
    const { content, removed } = applyKnownFingerprints(EP1251);
    expect(content).toBe(EP1251);
    expect(removed.groups).toBe(0);
  });

  it('命中组整组删除（含组前 DISCONTINUITY），正片短组 group 13 完好，不留双 DISCONTINUITY', () => {
    setActiveFingerprints(['5.567|2.933|5.700', '3.333|1.533']);
    const { content, removed } = applyKnownFingerprints(EP1251);
    expect(removed.groups).toBe(2);
    expect(removed.seconds).toBeCloseTo(19.1, 1);
    // 广告分片消失
    expect(content).not.toContain('1fcd08f60e5dc52818a1484ce77aba43.ts'); // g14 首片
    expect(content).not.toContain('e2c9ad9b68af90b1c346e86c9b7356f8.ts'); // g15 首片
    // 前后正片完好
    expect(content).toContain('2a5c2b9e567749ecbc2cee64a63eb77d.ts'); // g13 尾片
    expect(content).toContain('66edfc3d67320935960bd9d490bdd62e.ts'); // g16 首片
    // 无连续 DISCONTINUITY（剔除保留前组边界，不产生双标记）
    expect(content.includes('#EXT-X-DISCONTINUITY\n#EXT-X-DISCONTINUITY')).toBe(false);
  });

  it('stripAds = 基线规则 + 指纹匹配；stripAdsDetailed 上报指纹统计', () => {
    setActiveFingerprints(['5.567|2.933|5.700', '3.333|1.533']);
    const before = EP1251.split('\n').length;
    const { content, fingerprintRemoved } = stripAdsDetailed(EP1251);
    // 基线删 1 行（前导 DISCONTINUITY）+ 广告组 12 行（3+2 片各含 EXTINF+URL，加 2 个组前标记）
    expect(before - content.split('\n').length).toBe(13);
    expect(fingerprintRemoved.groups).toBe(2);
    expect(stripAds(EP1251)).toBe(content);
  });
});

describe('分片 URL → 组反查（手动标记用）', () => {
  beforeEach(() => {
    resetEpisodeGroups();
    setActiveFingerprints([]);
  });

  it('登记后按绝对化 URL 反查组；换集 reset 后清空', () => {
    const content = buildPlaylist([group(4, 5, 'a'), group(5.5, 2, 'mid'), group(4, 5, 'z')]);
    registerEpisodeGroups(content, 'https://cdn.example.com/ep1/index.m3u8');
    const hit = lookupGroupBySegmentUrl('https://cdn.example.com/ep1/mid0.ts');
    expect(hit?.signature).toBe('5.5|5.5');
    expect(lookupGroupBySegmentUrl('https://cdn.example.com/ep1/none.ts')).toBeUndefined();
    resetEpisodeGroups();
    expect(lookupGroupBySegmentUrl('https://cdn.example.com/ep1/mid0.ts')).toBeUndefined();
  });
});

describe('isShortGroupCandidate（跳过级候选）', () => {
  function pick(infos: AdGroupInfo[], index: number): AdGroupInfo {
    return infos[index];
  }

  it('ep1251：group 13/14/15 都是短组候选；首尾组与 5 片常规组不是', () => {
    const infos = computeGroupInfos(EP1251);
    expect(isShortGroupCandidate(pick(infos, 13))).toBe(true);
    expect(isShortGroupCandidate(pick(infos, 14))).toBe(true);
    expect(isShortGroupCandidate(pick(infos, 15))).toBe(true);
    expect(isShortGroupCandidate(pick(infos, 12))).toBe(false); // 5 片常规组
    expect(isShortGroupCandidate(pick(infos, 0))).toBe(false);
    expect(isShortGroupCandidate(pick(infos, 68))).toBe(false); // 尾组
  });
});
