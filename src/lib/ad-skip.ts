import { normalizeSegmentUrl } from './ad-detect';

/**
 * 跳过层（纯逻辑，node 可测）。
 *
 * 跳过 = 播放进入可疑区间时自动 seek 到区间尾，可撤销——**不是**从播放列表删除。
 * 区间来源两类（动作分层：都不可信到删除的程度）：
 * - 'fuzzy'：短组跨集模糊时长确认（cross-episode.ts，容差 0.5s）；
 * - 'subscription'：订阅下发的签名（他人输入，只跳不删）。
 */

export interface PendingSkipRange {
  signature: string;
  /** 广告总时长（秒），提示用 */
  seconds: number;
  /** 组内分片地址（应已归一化为绝对地址） */
  urls: string[];
  source: 'fuzzy' | 'subscription';
}

export interface ResolvedSkipRange extends PendingSkipRange {
  /** 播放时间轴区间（秒） */
  start: number;
  end: number;
}

export interface FragmentLike {
  url: string;
  start: number;
  end: number;
}

/**
 * 把待解析区间映射到 hls fragments 的时间轴。
 * 相邻集比对可能先于 hls 加载完成返回，分片详情未就绪时该区间解析不出，
 * 调用方应保留 pending 在后续 timeupdate 里重试。
 */
export function resolveSkipRanges(
  pending: PendingSkipRange[],
  fragments: FragmentLike[]
): { resolved: ResolvedSkipRange[]; remaining: PendingSkipRange[] } {
  const resolved: ResolvedSkipRange[] = [];
  const remaining: PendingSkipRange[] = [];
  for (const p of pending) {
    const urlSet = new Set(p.urls.map((u) => normalizeSegmentUrl(u)));
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const f of fragments) {
      if (!urlSet.has(normalizeSegmentUrl(f.url))) continue;
      start = Math.min(start, f.start);
      end = Math.max(end, f.end);
    }
    if (Number.isFinite(start) && end > start) {
      resolved.push({ ...p, start, end });
    } else {
      remaining.push(p);
    }
  }
  return { resolved, remaining };
}

/** 当前播放位置命中的跳过区间 */
export function findSkipHit(time: number, ranges: ResolvedSkipRange[]): ResolvedSkipRange | undefined {
  return ranges.find((r) => time >= r.start - 0.1 && time < r.end);
}
