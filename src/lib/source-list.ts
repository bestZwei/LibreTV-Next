import type { AdRuleEntry, AdRulesPayload, SourceListPayload } from './types';

/**
 * 数据源订阅（LibreTV-SourceList JSON）的纯解析层：只做字段裁剪、去重与上限，
 * 不涉及网络与 SSRF 判定（点播/直播的地址放行策略不同，由调用方按类型分别校验）。
 *
 * 支持四种形态：
 * 1. 完整格式：{ name?, sources: [...点播源], liveSources: [...直播源], adRules?: {...} }
 * 2. 老格式：只有 sources（或裸数组），直播源为空 —— 保持向后兼容
 * 3. 纯直播订阅：只有 liveSources
 * 4. 纯广告订阅：只有 adRules（用户分享的「已标记广告」指纹列表）
 */

export const MAX_VOD_SOURCES = 100;
export const MAX_LIVE_SOURCES = 50;
/** 单订阅广告规则条数上限（订阅是不可信输入，防垃圾数据塞爆指纹库） */
export const MAX_AD_RULES = 2000;

/**
 * 订阅地址统一形态：trim 并去掉尾部斜杠。
 * 手动输入与预置订阅（DEFAULT_SUBSCRIPTIONS）都必须走这一步——
 * 否则同一地址带不带尾斜杠会被存成两条订阅（不同 key 前缀、重复同步、重复拉取）。
 */
export function normalizeSubscriptionUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

interface RawItem {
  name?: unknown;
  url?: unknown;
  detail?: unknown;
  isAdult?: unknown;
  epg?: unknown;
}

/**
 * 规范化为 http(s) 地址；trimTrailingSlash 控制是否去掉尾部斜杠（点播去、直播保留）。
 * 导出供 tvbox-parser 复用，保证两种订阅格式的归一化规则完全一致。
 */
export function normalizeUrl(raw: unknown, trimTrailingSlash: boolean): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  try {
    new URL(trimmed);
  } catch {
    return undefined;
  }
  return trimTrailingSlash ? trimmed.replace(/\/+$/, '') : trimmed;
}

export function optionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// —— 广告规则（adRules）解析：与 m3u8 侧 ad-detect.ts 的门控保持同一套安全约束 ——

const AD_SIGNATURE_TOKEN_RE = /^\d{1,3}(\.\d{1,3})?$/;
const AD_SIGNATURE_MAX_TOKENS = 64;
const AD_SIGNATURE_MAX_LENGTH = 512;
const AD_HOST_RE = /^[a-z0-9.-]+$/;

/**
 * 校验一条外部输入的广告规则（订阅 / 导入共用）。
 * 等长签名（如 "4.171×5"）是封装节奏、单 token 签名（GOP 整数值）有跨集巧合风险，
 * 两者与 m3u8 侧指纹门控一致地拒绝。不合法返回 undefined。
 */
export function validateAdRuleEntry(raw: unknown): AdRuleEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const host = typeof r.host === 'string' ? r.host.trim().toLowerCase() : '';
  if (!host || host.length > 253 || !AD_HOST_RE.test(host)) return undefined;
  if (typeof r.signature !== 'string') return undefined;
  const signature = r.signature.trim();
  const tokens = signature.split('|');
  if (
    !signature ||
    signature.length > AD_SIGNATURE_MAX_LENGTH ||
    tokens.length < 2 ||
    tokens.length > AD_SIGNATURE_MAX_TOKENS ||
    !tokens.every((t) => AD_SIGNATURE_TOKEN_RE.test(t))
  ) {
    return undefined;
  }
  // 等长签名 = 封装节奏（如 "4.171|4.171|…"），不是广告
  if (tokens.every((t) => t === tokens[0])) return undefined;
  const groupSeconds =
    typeof r.groupSeconds === 'number' && r.groupSeconds >= 0 && r.groupSeconds <= 600 ? r.groupSeconds : 0;
  const contentHash = typeof r.contentHash === 'string' && r.contentHash.length <= 128 ? r.contentHash : undefined;
  const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim().slice(0, 100) : undefined;
  const addedAt = typeof r.addedAt === 'number' && r.addedAt > 0 ? r.addedAt : undefined;
  return { host, signature, contentHash, groupSeconds, addedAt, note };
}

/** 解析订阅 payload 的 adRules 块：逐条校验、去重、截断 */
export function parseAdRulesPayload(raw: unknown): AdRulesPayload {
  const entries: AdRuleEntry[] = [];
  let skipped = 0;
  const rawEntries =
    typeof raw === 'object' && raw !== null && Array.isArray((raw as { entries?: unknown }).entries)
      ? (raw as { entries: unknown[] }).entries
      : [];
  const seen = new Set<string>();
  for (const item of rawEntries) {
    if (entries.length >= MAX_AD_RULES) {
      skipped += 1;
      continue;
    }
    const v = validateAdRuleEntry(item);
    if (!v) {
      skipped += 1;
      continue;
    }
    const id = `${v.host}:${v.signature}`;
    if (seen.has(id)) {
      skipped += 1;
      continue;
    }
    seen.add(id);
    entries.push({
      host: v.host,
      signature: v.signature,
      contentHash: v.contentHash,
      groupSeconds: v.groupSeconds,
      addedAt: v.addedAt,
      note: v.note,
    });
  }
  return { version: 1, entries, skipped };
}

/**
 * 解析订阅 JSON。
 * @throws 内容既无点播源也无直播源也无广告规则时抛错（提示格式问题）
 */
export function parseSourceListPayload(json: unknown): SourceListPayload {
  const asArray = Array.isArray(json) ? json : null;
  const asObject = asArray
    ? null
    : (json as { name?: unknown; sources?: unknown; liveSources?: unknown; adRules?: unknown } | null);

  const rawVod: RawItem[] = asArray
    ? asArray
    : Array.isArray(asObject?.sources)
      ? (asObject?.sources as RawItem[])
      : [];
  const rawLive: RawItem[] = Array.isArray(asObject?.liveSources) ? (asObject?.liveSources as RawItem[]) : [];
  const adRules = asObject?.adRules ? parseAdRulesPayload(asObject.adRules) : undefined;

  if (rawVod.length === 0 && rawLive.length === 0 && (!adRules || adRules.entries.length === 0)) {
    throw new Error('订阅内容格式不正确（缺少 sources / liveSources / adRules 数组）');
  }

  // 先去重再截断：上限按去重后的有效条目计，前段重复不挤占名额
  const seenVod = new Set<string>();
  const sources: SourceListPayload['sources'] = [];
  for (const s of rawVod) {
    if (sources.length >= MAX_VOD_SOURCES) break;
    const url = normalizeUrl(s?.url, true);
    if (!url || seenVod.has(url)) continue;
    seenVod.add(url);
    sources.push({
      name: optionalString(s?.name) || hostnameOf(url),
      url,
      detail: optionalString(s?.detail),
      isAdult: s?.isAdult === true,
    });
  }

  const seenLive = new Set<string>();
  const liveSources: SourceListPayload['liveSources'] = [];
  for (const s of rawLive) {
    if (liveSources.length >= MAX_LIVE_SOURCES) break;
    const url = normalizeUrl(s?.url, false);
    if (!url || seenLive.has(url)) continue;
    seenLive.add(url);
    const epg = normalizeUrl(s?.epg, false);
    liveSources.push({
      name: optionalString(s?.name) || hostnameOf(url),
      url,
      epg,
    });
  }

  const name = asObject ? optionalString(asObject.name) : undefined;

  return { name, sources, liveSources, ...(adRules ? { adRules } : {}) };
}
