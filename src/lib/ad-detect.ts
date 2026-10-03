import { scanGroups, stripAdGroups, stripLeadingDisc, type AdGroupScan } from './m3u8';

/**
 * 广告指纹检测（纯逻辑，node 可测）。
 *
 * 原理（dytt 式源实测结论，2026-10）：
 * - 采集站把同一支广告文件「换名」逐集注入，分片字节级相同 → EXTINF 时长签名
 *   跨集精确一致（如 "5.567|2.933|5.700"）；正片每集独立编码，OP/ED 画面虽同、
 *   字节必不同，签名天然不撞。
 * - 封装器按固定 GOP 节奏（~4.171s）切组，产生全等长签名（"4.171|4.171|…"），
 *   这是签名匹配唯一的天然假阳性来源——等长签名一律视为封装节奏，不入册、不匹配。
 *
 * 动作分层（误杀底线）：
 * - 确定性命中（user-mark / cross-episode）→ 从播放列表整组删除；
 * - 订阅 / 启发式来源 → 只标记跳过区间，永不删除（见 ad-skip.ts / player-shell）。
 */

/** 单组 EXTINF 签名与元信息 */
export interface AdGroupInfo {
  /** 组序号（按 DISCONTINUITY 切分；0 = 首分片前的组，通常无分片） */
  index: number;
  segmentCount: number;
  seconds: number;
  /** 逐分片 EXTINF 时长按序拼接，如 "5.567|2.933|5.700"；无分片时为空串 */
  signature: string;
  /** 通过入册/匹配门控（非首尾组、有分片、≤60s、非等长） */
  eligible: boolean;
  /** 组内分片原始行（按出现顺序），供分片 URL → 组反查 */
  segmentLines: string[];
}

/** 指纹组准入上限：OP/ED 通常 60-90s 且为长组，超限一律不入册（防误杀的保守门） */
export const FINGERPRINT_MAX_GROUP_SECONDS = 60;

const isDiscLine = (l: string): boolean => l.trim() === '#EXT-X-DISCONTINUITY';
const isSegmentLine = (l: string): boolean => {
  const t = l.trim();
  return t !== '' && !t.startsWith('#');
};

function extinfToken(line: string): string {
  // "#EXTINF:5.567," → "5.567"（保留原始文本：字节级相同的注入文件逐字一致，
  // 不做数值归一化，避免把「恰好等长」的不同内容撮合到一起）
  return line.trim().slice('#EXTINF:'.length).split(',')[0].trim();
}

/** 把播放列表切成组并计算签名。输入应先经过 stripAdGroups 基线规则（写入与匹配两侧一致） */
export function computeGroupInfos(content: string): AdGroupInfo[] {
  if (!content) return [];
  const lines = content.split('\n');
  const groups: AdGroupScan[] = scanGroups(lines, isDiscLine, isSegmentLine);
  return groups.map((g, index) => {
    const tokens: string[] = [];
    const segmentLines: string[] = [];
    for (let i = g.start; i < g.end; i++) {
      const t = lines[i].trim();
      if (t.startsWith('#EXTINF:')) {
        const v = extinfToken(t);
        if (v) tokens.push(v);
      } else if (isSegmentLine(t)) {
        segmentLines.push(t);
      }
    }
    const seconds = tokens.reduce((s, v) => s + (parseFloat(v) || 0), 0);
    const uniform = tokens.length > 0 && tokens.every((v) => v === tokens[0]);
    const eligible =
      index > 0 &&
      index < groups.length - 1 &&
      tokens.length > 0 &&
      seconds > 0 &&
      seconds <= FINGERPRINT_MAX_GROUP_SECONDS &&
      !uniform;
    return { index, segmentCount: g.count, seconds, signature: tokens.join('|'), eligible, segmentLines };
  });
}

// —— 活跃指纹表（模块级内存）：stripAdGroups 是同步纯函数，loader / 预取 / 下载
// 三条管线无法各自注入异步 DB 查询，统一在进集（或解析）前把库中签名载入内存 ——

let activeSignatures = new Set<string>();

export function setActiveFingerprints(signatures: Iterable<string>): void {
  activeSignatures = new Set(signatures);
}

export function getActiveFingerprintCount(): number {
  return activeSignatures.size;
}

/** 当前集的分片 URL → 组签名反查表（手动「标记广告」用），loader 处理播放列表时重建 */
let episodeSegmentGroups = new Map<string, AdGroupInfo>();

/** 签名 → 组反查表（跳过层：订阅签名的分片集合映射播放时间区间用） */
let episodeGroupsBySignature = new Map<string, AdGroupInfo>();

export function resetEpisodeGroups(): void {
  episodeSegmentGroups = new Map();
  episodeGroupsBySignature = new Map();
}

export interface FingerprintRemoval {
  /** 被删除的组数 */
  groups: number;
  /** 被删除的广告总时长（秒） */
  seconds: number;
  signatures: string[];
}

const EMPTY_REMOVAL: FingerprintRemoval = { groups: 0, seconds: 0, signatures: [] };

/**
 * 按活跃指纹表剔除命中组。约定（与 stripMarkedAdGroups 一致）：
 * - 组前 DISCONTINUITY 一并删除，保留前一组作分段边界，不会出现双标记；
 * - 组内 EXT-X-KEY / EXT-X-MAP 保留（正片可能复用解密/初始化配置）。
 */
export function applyKnownFingerprints(content: string): { content: string; removed: FingerprintRemoval } {
  if (!content || activeSignatures.size === 0) return { content, removed: EMPTY_REMOVAL };
  const lines = content.split('\n');
  const infos = computeGroupInfos(content);
  const drop = new Array<boolean>(lines.length).fill(false);
  const removedSignatures: string[] = [];
  let removedSeconds = 0;
  for (const g of infos) {
    if (!g.eligible || !g.signature || !activeSignatures.has(g.signature)) continue;
    const scan = scanGroups(lines, isDiscLine, isSegmentLine)[g.index];
    if (scan.discLine >= 0) drop[scan.discLine] = true;
    for (let i = scan.start; i < scan.end; i++) {
      const t = lines[i].trim();
      if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) continue;
      drop[i] = true;
    }
    removedSignatures.push(g.signature);
    removedSeconds += g.seconds;
  }
  if (removedSignatures.length === 0) return { content, removed: EMPTY_REMOVAL };
  const out = stripLeadingDisc(lines.filter((_, i) => !drop[i]).join('\n'));
  return { content: out, removed: { groups: removedSignatures.length, seconds: removedSeconds, signatures: removedSignatures } };
}

/** 广告过滤总入口（基线规则 + 指纹匹配），只关心结果文本的调用方用这个 */
export function stripAds(content: string): string {
  return stripAdsDetailed(content).content;
}

export interface StripAdsResult {
  content: string;
  /** 指纹命中的删除统计（基线规则历史悠久保持静默，不并入统计） */
  fingerprintRemoved: FingerprintRemoval;
}

export function stripAdsDetailed(content: string): StripAdsResult {
  const base = stripAdGroups(content);
  const { content: out, removed } = applyKnownFingerprints(base);
  return { content: out, fingerprintRemoved: removed };
}

/**
 * loader 处理播放列表时登记「分片 URL → 组」反查表（手动标记广告用）。
 * key 归一化成绝对地址（与 video-cache.buildSegmentCacheKey 同一构造器语义，
 * 此处本地实现以保持本模块零运行时依赖）；多档位分片地址互不相同，累积登记
 * 互不冲突；换集时调用方负责 resetEpisodeGroups。
 */
export function registerEpisodeGroups(content: string, baseUrl?: string): void {
  if (!content) return;
  for (const g of computeGroupInfos(content)) {
    if (!g.signature) continue;
    episodeGroupsBySignature.set(g.signature, g);
    for (const url of g.segmentLines) {
      episodeSegmentGroups.set(normalizeSegmentUrl(url, baseUrl), g);
    }
  }
}

/** 按签名取当前集的组（跳过层把组内分片映射成时间区间）；无登记返回 undefined */
export function getEpisodeGroup(signature: string): AdGroupInfo | undefined {
  return episodeGroupsBySignature.get(signature);
}

/** 按签名取当前集组内分片的归一化 URL（与登记 key 同一构造器），供跳过区间映射 */
export function getEpisodeGroupSegmentUrls(signature: string): string[] {
  const out: string[] = [];
  for (const [url, g] of episodeSegmentGroups) {
    if (g.signature === signature) out.push(url);
  }
  return out;
}

/** 分片地址归一化（与登记 key 同一构造器语义；ad-skip.ts 映射时间区间用同一函数） */
export function normalizeSegmentUrl(url: string, baseUrl?: string): string {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

/** 按分片 URL 反查所在组（内部按登记同款归一化，调用方传绝对或相对地址均可） */
export function lookupGroupBySegmentUrl(url: string): AdGroupInfo | undefined {
  if (!url) return undefined;
  const key = normalizeSegmentUrl(url);
  return episodeSegmentGroups.get(key) ?? episodeSegmentGroups.get(url.trim());
}

/** 当前集登记的组数（测试与排查用） */
export function getRegisteredGroupCount(): number {
  return episodeSegmentGroups.size;
}

// —— 结构可疑候选（启发式，只产生「跳过」输入，永不删除） ——

/** 短组候选上限：正片封装组几乎都是 5 片 ~20s，短组是注入广告的形态异常 */
export const SHORT_GROUP_MAX_SEGMENTS = 4;
export const SHORT_GROUP_MAX_SECONDS = 20;

/**
 * 短组候选：指纹门控（非首尾组、非等长、有分片）+ 短组形态。
 * 结构只做提名不定罪——正片也有短组（ep1251 group 13：4 片/18.1s），单集不可区分；
 * 调用方（cross-episode.ts）用「跨集组时长模糊一致」确认：广告组跨集精确一致，
 * 正片短组跨集必不同。
 */
export function isShortGroupCandidate(g: AdGroupInfo): boolean {
  return g.eligible && g.segmentCount <= SHORT_GROUP_MAX_SEGMENTS && g.seconds <= SHORT_GROUP_MAX_SECONDS;
}
