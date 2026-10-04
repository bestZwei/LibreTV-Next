import { db, type AdMarkEntry } from './db';
import { addFingerprints, fetchSegmentFingerprint, fingerprintsOfMark, removeFingerprints } from './ad-fingerprints';

/**
 * 用户标记广告分段。
 *
 * 标记单位 = 当前 DISCONTINUITY 分组：广告在源站拼接时就是独立成组插入的
 * （组边界即广告边界，实测 dytt/bfzy/ffzy 三类源全部吻合），因此用户只需
 * 在广告播放时按一下「标记广告」，系统用 hls.js 的运行时结构（fragments
 * 按连续相同 cc 分组）把"现在"翻译成精确范围——无需掐秒表。
 *
 * 降级：该 cc 覆盖全片（源没有 DISCONTINUITY，整集一组）时组标记不可用，
 * 退化为只标记当前分片。
 *
 * 每个标记做两件事：① 当集立即加入跳过列表；② 组内分片取前 64KB 算
 * SHA-256 指纹入库（origin='user' 人工 ground truth）——之后任何一集
 * 分片命中即跳过所在分组，跨集/跨片永久生效。
 */

/** hls.js 运行时分片的最小形状（避免引 hls.js 类型依赖到纯函数层） */
export interface FragLike {
  cc: number;
  start: number;
  duration: number;
  url: string;
}

export interface FragGroup {
  /** 组内分片（同一连续 cc 段） */
  frags: FragLike[];
  /** 起止秒数（媒体时间轴） */
  start: number;
  end: number;
}

/**
 * 定位时刻 t 所在的 DISCONTINUITY 分组（按连续相同 cc 切分）。
 * 返回 null 表示该 cc 覆盖全部已知分片（源无 DISCONTINUITY），组标记不可用。
 */
export function findGroupAt(fragments: FragLike[], t: number): FragGroup | null {
  const hit = fragments.find((f) => t >= f.start && t < f.start + f.duration);
  if (!hit) return null;
  return findGroupAround(fragments, hit);
}

/** 定位某分片所在的分组（指纹命中时用：跳过命中分片所在的整组） */
export function findGroupAround(fragments: FragLike[], frag: FragLike): FragGroup | null {
  let lo = frag;
  for (const f of fragments) {
    if (f.cc === frag.cc && f.start < lo.start) lo = f;
  }
  let hi = frag;
  for (const f of fragments) {
    if (f.cc === frag.cc && f.start + f.duration > hi.start + hi.duration) hi = f;
  }
  const frags = fragments.filter((f) => f.cc === frag.cc && f.start >= lo.start && f.start <= hi.start);
  if (!frags.length) return null;
  // 该 cc 覆盖全部已知分片 ⇒ 源没有 DISCONTINUITY，组边界无意义
  if (frags.length === fragments.length) return null;
  return {
    frags,
    start: frags[0].start,
    end: frags[frags.length - 1].start + frags[frags.length - 1].duration,
  };
}

/** 合并相邻/重叠的跳过区间（间隙 <1s 视为连续，如广告跨两组） */
export function mergeRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const r of sorted) {
    if (!(r.end > r.start)) continue;
    const last = out[out.length - 1];
    if (last && r.start - last.end < 1) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** 与已有标记相邻（用于「再按一次扩展一段」判定：间隙 <2s 视为相邻） */
export function isAdjacentRange(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return Math.abs(a.start - b.end) < 2 || Math.abs(b.start - a.end) < 2;
}

// —— Dexie 存取封装 ——

export function adMarkId(episodeKey: string, start: number): string {
  return `${episodeKey}_${Math.round(start * 10)}`;
}

export async function addAdMark(entry: Omit<AdMarkEntry, 'id' | 'createdAt'>): Promise<AdMarkEntry> {
  const mark: AdMarkEntry = { ...entry, id: adMarkId(entry.episodeKey, entry.start), createdAt: Date.now() };
  await db.adMarks.put(mark);
  return mark;
}

export async function listAdMarks(): Promise<AdMarkEntry[]> {
  try {
    const rows = await db.adMarks.toArray();
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/** 某剧集的全部标记（时间轴剔除注册用） */
export async function getMarksForEpisode(episodeKey: string): Promise<AdMarkEntry[]> {
  try {
    return await db.adMarks.where('episodeKey').equals(episodeKey).toArray();
  } catch {
    return [];
  }
}

/** 删除标记；连带删除其指纹（除非同一指纹被其他标记共享），并顺带清理孤儿指纹 */
export async function removeAdMark(markId: string): Promise<void> {
  const hashes = await fingerprintsOfMark(markId);
  await db.adMarks.delete(markId);
  const remainingMarks = await db.adMarks.toArray();
  const shared = new Set<string>();
  for (const m of remainingMarks) {
    for (const h of await fingerprintsOfMark(m.id)) shared.add(h);
  }
  await removeFingerprints(hashes.filter((h) => !shared.has(h)));
  // 孤儿清理：markId 对应的标记已不存在的指纹（历史 bug/导入残留）
  const markIds = new Set(remainingMarks.map((m) => m.id));
  const all = await db.adFingerprints.toArray();
  await removeFingerprints(all.filter((f) => !markIds.has(f.markId)).map((f) => f.hash));
}

/** 标记生效：入库 + 学指纹（组内分片前 64KB，并行抓取），返回学到的指纹数 */
export async function learnMarkFingerprints(
  markId: string,
  frags: FragLike[],
  concurrency = 4
): Promise<number> {
  const hashes: string[] = [];
  const queue = [...frags];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const frag = queue.shift();
      if (!frag) return;
      const h = await fetchSegmentFingerprint(frag.url);
      if (h) hashes.push(h);
    }
  });
  await Promise.all(workers);
  const added = await addFingerprints(hashes, markId, 'user');
  // 回写指纹数量（管理列表展示用；重复指纹时计数为实际新增数）
  try {
    const known = await fingerprintsOfMark(markId);
    await db.adMarks.update(markId, { fingerprintCount: known.length });
  } catch { /* 忽略 */ }
  return added;
}
