import type { AdFingerprintEntry, AdFingerprintOrigin } from './db';
import type { AdRuleEntry } from './types';
import { db } from './db';
import { setActiveFingerprints } from './ad-detect';

/**
 * 广告指纹库（Dexie / IndexedDB）。
 *
 * - 按源 API host 归档（与订阅 sourceUrl、播放页 sourceUrl 对齐）；
 * - 运行时匹配与 host 无关：签名是内容派生的精确串（逐分片 EXTINF 文本），
 *   全量载入内存活跃表供同步的播放列表过滤使用（见 ad-detect.ts）；
 * - 合并优先级 user-mark > cross-episode > subscription > heuristic：
 *   高优先级来源永不被告优先级覆盖（订阅同步不覆盖本地标记）。
 */

export const MAX_AD_ENTRIES_PER_HOST = 500;

const ORIGIN_PRIORITY: Record<AdFingerprintOrigin, number> = {
  'user-mark': 3,
  'cross-episode': 2,
  subscription: 1,
  heuristic: 0,
};

export interface AdFingerprintInput {
  host: string;
  signature: string;
  contentHash?: string;
  groupSeconds: number;
  origin: AdFingerprintOrigin;
  note?: string;
}

/** 删除级来源：只有这两类允许从播放列表整组移除（动作分层，见 ad-detect.ts 头注） */
const DELETABLE_ORIGINS: ReadonlySet<AdFingerprintOrigin> = new Set<AdFingerprintOrigin>(['user-mark', 'cross-episode']);

/** 刷新删除级活跃表（只含 user-mark / cross-episode；subscription/heuristic 永不删除） */
export async function refreshActiveFingerprints(): Promise<number> {
  const rows = await db.adFingerprints.toArray();
  setActiveFingerprints(rows.filter((r) => DELETABLE_ORIGINS.has(r.origin)).map((r) => r.signature));
  return rows.length;
}

/** 跳过级签名（subscription 来源；启发式模糊确认不落库，见 cross-episode.ts） */
export async function getSubscriptionSignatures(): Promise<string[]> {
  const rows = await db.adFingerprints.where('origin').equals('subscription').toArray();
  return rows.map((r) => r.signature);
}

export async function getAdFingerprintsByHost(host: string): Promise<AdFingerprintEntry[]> {
  return db.adFingerprints.where('host').equals(host).toArray();
}

export async function getAllAdFingerprints(): Promise<AdFingerprintEntry[]> {
  return db.adFingerprints.toArray();
}

/**
 * 批量入库（去重合并）。同 id 已存在时：高优先级 origin 可升级，低优先级不降级不覆盖；
 * 同级合并只累加命中计数。返回实际写入条数。
 */
export async function upsertAdFingerprints(inputs: AdFingerprintInput[]): Promise<number> {
  const byHost = new Map<string, AdFingerprintInput[]>();
  for (const e of inputs) {
    const list = byHost.get(e.host) ?? [];
    list.push(e);
    byHost.set(e.host, list);
  }
  let written = 0;
  for (const [host, list] of byHost) {
    const now = Date.now();
    const rows: AdFingerprintEntry[] = [];
    for (const e of list) {
      const id = `${host}:${e.signature}`;
      const existing = await db.adFingerprints.get(id);
      if (existing) {
        const upgraded = ORIGIN_PRIORITY[e.origin] > ORIGIN_PRIORITY[existing.origin];
        rows.push({
          ...existing,
          contentHash: e.contentHash ?? existing.contentHash,
          groupSeconds: e.groupSeconds || existing.groupSeconds,
          origin: upgraded ? e.origin : existing.origin,
          hits: existing.hits + 1,
          lastHit: now,
          note: e.note ?? existing.note,
        });
      } else {
        rows.push({
          id,
          host,
          signature: e.signature,
          contentHash: e.contentHash,
          groupSeconds: e.groupSeconds,
          origin: e.origin,
          hits: 0,
          firstSeen: now,
          lastHit: now,
          note: e.note,
        });
      }
    }
    await db.adFingerprints.bulkPut(rows);
    written += rows.length;
    // 单源容量淘汰：超出上限按 lastHit 淘汰最旧（换广告素材后旧指纹自然沉底）
    const count = await db.adFingerprints.where('host').equals(host).count();
    if (count > MAX_AD_ENTRIES_PER_HOST) {
      const oldest = await db.adFingerprints
        .where('host')
        .equals(host)
        .sortBy('lastHit');
      const evict = oldest.slice(0, count - MAX_AD_ENTRIES_PER_HOST).filter((r) => r.origin !== 'user-mark');
      if (evict.length) await db.adFingerprints.bulkDelete(evict.map((r) => r.id));
    }
  }
  await refreshActiveFingerprints();
  return written;
}

export async function removeAdFingerprint(id: string): Promise<void> {
  await db.adFingerprints.delete(id);
  await refreshActiveFingerprints();
}

export async function clearAdFingerprintsByHost(host: string): Promise<void> {
  await db.adFingerprints.where('host').equals(host).delete();
  await refreshActiveFingerprints();
}

/** 命中计数（播放列表删除发生时调用；失败静默不影响播放） */
export async function touchAdFingerprints(host: string, signatures: string[]): Promise<void> {
  const now = Date.now();
  try {
    for (const signature of signatures) {
      const id = `${host}:${signature}`;
      const existing = await db.adFingerprints.get(id);
      if (!existing) continue;
      await db.adFingerprints.update(id, { hits: existing.hits + 1, lastHit: now });
    }
  } catch {
    /* 统计失败不影响播放 */
  }
}

// —— 导出 / 导入（订阅分享的数据面） ——

// 校验逻辑与订阅解析共用同一份纯实现（source-list 无任何运行时依赖，服务端路由也可安全引用）
export { validateAdRuleEntry } from './source-list';

export interface AdRuleExportEntry {
  host: string;
  signature: string;
  contentHash?: string;
  groupSeconds: number;
  addedAt: number;
  note?: string;
}

export interface AdRulesExport {
  version: 1;
  entries: AdRuleExportEntry[];
}

/** 导出可分享规则：只含确定性来源（user-mark / cross-episode），subscription 不转传防污染 */
export async function exportAdRules(): Promise<AdRulesExport> {
  const rows = await db.adFingerprints.toArray();
  return {
    version: 1,
    entries: rows
      .filter((r) => r.origin === 'user-mark' || r.origin === 'cross-episode')
      .map((r) => ({
        host: r.host,
        signature: r.signature,
        contentHash: r.contentHash,
        groupSeconds: r.groupSeconds,
        addedAt: r.firstSeen,
        note: r.note,
      })),
  };
}

/** 订阅 / 导入共用：外部输入的广告规则合并入库（强制 subscription 来源，跳过级动作） */
export async function importAdRules(entries: AdRuleEntry[]): Promise<number> {
  if (!entries.length) return 0;
  return upsertAdFingerprints(
    entries.map((e) => ({
      host: e.host,
      signature: e.signature,
      contentHash: e.contentHash,
      groupSeconds: e.groupSeconds,
      origin: 'subscription' as const,
      note: e.note,
    }))
  );
}