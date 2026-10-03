import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { matchAcrossEpisodes } from './cross-episode';
import { getAllAdFingerprints } from './ad-fingerprints';
import { setActiveFingerprints } from './ad-detect';
import { db } from './db';
import { PLAYLIST as EP1251 } from './__fixtures__/ep1251';
import { PLAYLIST as EP1250 } from './__fixtures__/ep1250';

const URL_1251 = 'https://vip.example.com/ep1251/index.m3u8';
const URL_1250 = 'https://vip.example.com/ep1250/index.m3u8';
const SOURCE_API = 'https://caiji.dyttzyapi.com/api.php/provide/vod/from/dyttm3u8';

function stubFetch(textByUrl: Record<string, string>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const text = textByUrl[url];
    if (text === undefined) return new Response('not found', { status: 404 });
    return new Response(text, { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('matchAcrossEpisodes（dytt 真实样本）', () => {
  beforeEach(async () => {
    setActiveFingerprints([]);
    await db.adFingerprints.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('正播方向：精确命中两个广告组入库（origin=cross-episode），正片短组 g13 不误报', async () => {
    stubFetch({ [URL_1251]: EP1251, [URL_1250]: EP1250 });
    const result = await matchAcrossEpisodes(URL_1251, URL_1250, SOURCE_API);
    expect(result.matched).toBe(true);
    expect(result.signatures.sort()).toEqual(['3.333|1.533', '5.567|2.933|5.700'].sort());
    // g13（18.1s）与 ep1250 的正片短组 g10（15.0s）差 3.1s，超出 0.5s 容差
    expect(result.suspiciousGroups).toEqual([]);

    const rows = await getAllAdFingerprints();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.host === 'caiji.dyttzyapi.com')).toBe(true);
    expect(rows.every((r) => r.origin === 'cross-episode')).toBe(true);
  });

  it('倒播方向同样零假阳性：ep1250 的正片短组 g10（15.0s）距 ep1251 g14（14.2s）差 0.8s，不误报', async () => {
    stubFetch({ [URL_1251]: EP1251, [URL_1250]: EP1250 });
    const result = await matchAcrossEpisodes(URL_1250, URL_1251, SOURCE_API);
    expect(result.matched).toBe(true);
    expect(result.suspiciousGroups).toEqual([]);
  });

  it('指纹入库后活跃表同步，再次比对仍命中（hits 累加）', async () => {
    stubFetch({ [URL_1251]: EP1251, [URL_1250]: EP1250 });
    await matchAcrossEpisodes(URL_1251, URL_1250, SOURCE_API);
    const second = await matchAcrossEpisodes(URL_1251, URL_1250, SOURCE_API);
    expect(second.matched).toBe(true);
    const rows = await getAllAdFingerprints();
    expect(rows).toHaveLength(2);
    expect(rows[0].hits).toBe(1);
  });

  it('相邻集拉取失败时静默返回未命中，不抛错', async () => {
    stubFetch({ [URL_1251]: EP1251 }); // ep1250 404
    const result = await matchAcrossEpisodes(URL_1251, URL_1250, SOURCE_API);
    expect(result.matched).toBe(false);
    expect(result.signatures).toEqual([]);
  });

  it('模糊匹配（跳过级）：短组时长差 0.01s 判可疑，且不入库不删除', async () => {
    // 两侧同一支广告各自重编码：逐分片时长有帧级微差，精确签名不同、总时长几乎一致。
    // 注意 ≥4 个分组（否则片头启发式的同构保护不生效，首组会被当片头广告剔除——基线规则的既有行为）
    const base = ['#EXTM3U', '#EXT-X-TARGETDURATION:8'];
    const eps = (durs: string[], prefix: string) =>
      [`#EXT-X-DISCONTINUITY`, ...durs.flatMap((d, i) => [`#EXTINF:${d},`, `${prefix}${i}.ts`])];
    const long = (prefix: string, tail: string) => eps(['4.171', '4.171', '4.171', '4.171', tail], prefix);
    const playlistA = [...base, ...long('a', '6.757'), ...eps(['5.51', '5.6'], 'adA'), ...long('b', '5.13'), ...long('c', '6.5'), '#EXT-X-ENDLIST'].join('\n');
    const playlistB = [...base, ...long('d', '7.2'), ...eps(['5.5', '5.6'], 'adB'), ...long('e', '6.1'), ...long('f', '5.4'), '#EXT-X-ENDLIST'].join('\n');
    stubFetch({ [URL_1251]: playlistA, [URL_1250]: playlistB });

    const result = await matchAcrossEpisodes(URL_1251, URL_1250, SOURCE_API);
    expect(result.matched).toBe(false); // 精确签名不一致 → 不入库、不删除
    expect(result.suspiciousGroups).toHaveLength(1); // 广告组模糊命中
    expect(result.suspiciousGroups[0].segmentLines).toEqual([
      'https://vip.example.com/ep1251/adA0.ts',
      'https://vip.example.com/ep1251/adA1.ts',
    ]);
  });
});
