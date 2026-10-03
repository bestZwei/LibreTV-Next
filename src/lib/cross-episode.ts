import { computeGroupInfos, isShortGroupCandidate, type AdGroupInfo } from './ad-detect';
import { upsertAdFingerprints } from './ad-fingerprints';
import { fetchMediaPlaylistText } from './m3u8-parse';
import { makeAbsolute, stripAdGroups } from './m3u8';
import { hostnameOf } from './source-list';

/**
 * 跨集广告确认：拉相邻集播放列表原文，一次比对产出两级结论。
 *
 * 依据（dytt 源实测）：同一支广告逐集换名注入，分片字节级相同 →
 * - 组的 EXTINF 签名跨集精确一致 → 删除级（入库 origin='cross-episode'）；
 * - 正片每集独立编码，跨集签名必不相同（含 OP/ED）→ 零误杀。
 *
 * 删除级之外的兜底：短组候选（≤4 片且 ≤20s，指纹门控内）做跨集**组时长模糊比对**
 * （容差 0.5s）→ 跳过级。覆盖「同支广告重编码、逐分片切分点微移」的演进
 * 手法；正片短组（如 ep1251 group 13：4 片/18.1s）跨集时长必不同，不会命中
 * （实测 ep1251 g13=18.1s vs ep1250 同位置 g10=15.0s，Δ3.1s 超出容差）。
 *
 * 网络开销 = 相邻集播放列表文本（~30-60KB），零媒体请求。
 */

export interface CrossEpisodeMatchResult {
  /** 精确签名命中（已入库，删除级） */
  matched: boolean;
  signatures: string[];
  /** 模糊确认的短组（跳过级，调用方映射成播放时间区间） */
  suspiciousGroups: AdGroupInfo[];
}

/** 同一对地址的去重护栏：MANIFEST_PARSED / timeupdate 多处触发时只跑一次 */
const inflight = new Map<string, Promise<CrossEpisodeMatchResult>>();

/**
 * 模糊比对容差。取值依据实测推演：字节级相同的注入组完全一致（Δ=0）；
 * 重编码的同支广告按帧对齐，组总时长偏移 <0.2s；正片短组跨集独立编码，
 * 实测差 >0.8s（ep1250 g10=15.0s vs ep1251 g14=14.2s——差 0.8s 的两个
 * 正片/广告组必须判为不同，0.5s 是同时满足两者的分界值）。
 */
const FUZZY_TOLERANCE_SECONDS = 0.5;

function groupSecondsClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= FUZZY_TOLERANCE_SECONDS;
}

/**
 * 精确 + 模糊两级比对。任一侧拉取失败静默返回未命中（不影响播放）。
 * @param currentUrl 当前集 m3u8（直连或代理形式）
 * @param nextUrl    相邻集 m3u8
 * @param sourceUrl  源 API 地址（指纹库按其 host 归档）
 */
export function matchAcrossEpisodes(currentUrl: string, nextUrl: string, sourceUrl?: string): Promise<CrossEpisodeMatchResult> {
  const key = `${currentUrl}|${nextUrl}`;
  const running = inflight.get(key);
  if (running) return running;
  const task = (async (): Promise<CrossEpisodeMatchResult> => {
    try {
      const host = sourceUrl ? hostnameOf(sourceUrl) : hostnameOf(currentUrl);
      const [ea, eb] = await Promise.all([fetchMediaPlaylistText(currentUrl), fetchMediaPlaylistText(nextUrl)]);
      // 签名规范化基准：stripAdGroups 基线规则之后的文本（与匹配侧 applyKnownFingerprints 的输入一致）
      const ga = computeGroupInfos(stripAdGroups(ea.text));
      const gb = computeGroupInfos(stripAdGroups(eb.text));

      // —— 精确：双方门控内签名一致 → 删除级 ——
      const bSigs = new Set(gb.filter((g) => g.eligible && g.signature).map((g) => g.signature));
      const secondsBy = new Map(ga.map((g) => [g.signature, g.seconds]));
      const hits = [...new Set(ga.filter((g) => g.eligible && g.signature && bSigs.has(g.signature)).map((g) => g.signature))];
      if (hits.length) {
        await upsertAdFingerprints(
          hits.map((signature) => ({ host, signature, groupSeconds: secondsBy.get(signature) ?? 0, origin: 'cross-episode' }))
        );
      }

      // —— 模糊：短组候选跨集时长吻合 → 跳过级（已精确命中的不再重复报） ——
      // segmentLines 归一化为绝对地址：播放器把组内分片映射到播放时间区间时直接可用
      const hitSet = new Set(hits);
      const shortB = gb.filter((g) => isShortGroupCandidate(g));
      const suspiciousGroups = ga
        .filter((g) => isShortGroupCandidate(g) && !hitSet.has(g.signature) && shortB.some((o) => groupSecondsClose(g.seconds, o.seconds)))
        .map((g) => ({ ...g, segmentLines: g.segmentLines.map((l) => makeAbsolute(l, ea.baseUrl)) }));
      return { matched: hits.length > 0, signatures: hits, suspiciousGroups };
    } catch {
      return { matched: false, signatures: [], suspiciousGroups: [] };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}
