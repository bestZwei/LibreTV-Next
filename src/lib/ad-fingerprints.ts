import { db } from './db';

/**
 * 广告分片指纹库（用户标记层的基础设施）。
 *
 * 指纹 = 分片内容前 64KB 的 SHA-256。实测同一支广告跨集 URL 全不同
 * （文件名带每集唯一 hash），但分片字节完全一致——所以指纹用内容哈希，
 * 跨集/跨片恒定，命中即可精确跳过。
 *
 * 本模块当前只有 'user' 一种来源（用户标记学到的人工 ground truth，
 * 永不过期、优先命中）；未来自动过滤层（码率探测等）学习到的指纹
 * 可扩展 origin 字段，命中策略共用本库。
 *
 * 读路径全部走内存 Set（ensureLoaded 一次 + 增量更新），分片加载时
 * 的命中判断零查询延迟；库为空时调用方完全跳过哈希计算。
 */

export const FINGERPRINT_PREFIX_BYTES = 65_536;
/** 上限：每条 64 字符 hex，2000 条远在 IndexedDB 配额之内 */
export const MAX_FINGERPRINTS = 2000;

export type FingerprintOrigin = 'user';

export async function ensureFingerprintsLoaded(): Promise<Set<string>> {
  const memory = getMemorySet();
  if (memory.loaded) return memory.set;
  memory.loaded = true;
  try {
    const rows = await db.adFingerprints.toArray();
    for (const r of rows) memory.set.add(r.hash);
    // 超限时截断（IndexedDB 本身不设限，这里保持内存/导出可控）
    if (rows.length > MAX_FINGERPRINTS) {
      const keep = new Set(rows.slice(rows.length - MAX_FINGERPRINTS).map((r) => r.hash));
      for (const h of [...memory.set]) if (!keep.has(h)) memory.set.delete(h);
      await db.adFingerprints.clear();
      await db.adFingerprints.bulkPut(rows.slice(rows.length - MAX_FINGERPRINTS));
    }
  } catch { /* 读取失败按空库处理 */ }
  return memory.set;
}

export function getKnownFingerprints(): Set<string> {
  return getMemorySet().set;
}

/** 入库（去重、持久化、同步内存缓存） */
export async function addFingerprints(hashes: string[], markId: string, origin: FingerprintOrigin = 'user'): Promise<number> {
  const fresh = [...new Set(hashes)].filter((h) => /^[0-9a-f]{64}$/.test(h) && !getKnownFingerprints().has(h));
  if (!fresh.length) return 0;
  const now = Date.now();
  try {
    await db.adFingerprints.bulkPut(fresh.map((hash) => ({ hash, origin, markId, createdAt: now })));
  } catch { /* 写失败：内存仍有，本次会话内有效 */ }
  for (const h of fresh) getMemorySet().set.add(h);
  return fresh.length;
}

/** 指纹被哪个标记引用（删除标记时判断能否连带删除） */
export async function fingerprintsOfMark(markId: string): Promise<string[]> {
  try {
    const rows = await db.adFingerprints.where('markId').equals(markId).toArray();
    return rows.map((r) => r.hash);
  } catch {
    return [];
  }
}

export async function removeFingerprints(hashes: string[]): Promise<void> {
  if (!hashes.length) return;
  try {
    await db.adFingerprints.bulkDelete(hashes);
  } catch { /* 忽略 */ }
  const set = getMemorySet().set;
  for (const h of hashes) set.delete(h);
}

/** 分片内容前缀 → SHA-256（hex 小写；与写入侧约定同一前缀长度） */
export async function sha256PrefixHex(data: ArrayBuffer | Uint8Array, prefixBytes = FINGERPRINT_PREFIX_BYTES): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const slice = bytes.byteLength > prefixBytes ? bytes.subarray(0, prefixBytes) : bytes;
  const copy = new Uint8Array(slice.byteLength);
  copy.set(slice);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 抓分片前 64KB 并算指纹。简单 GET（直连源不能带 Range 头——会触发 CORS
 * 预检，多数采集 CDN 不实现 OPTIONS），流式读够 64KB 即取消 body，
 * 不多耗流量；代理形式的同源分片 URL 同样适用。
 */
export async function fetchSegmentFingerprint(url: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { Accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        if (got >= FINGERPRINT_PREFIX_BYTES) break;
      }
    } finally {
      try { await reader.cancel(); } catch { /* 忽略 */ }
    }
    if (!got) return null;
    const merged = new Uint8Array(Math.min(got, FINGERPRINT_PREFIX_BYTES));
    let off = 0;
    for (const c of chunks) {
      const take = Math.min(c.byteLength, merged.length - off);
      merged.set(c.subarray(0, take), off);
      off += take;
      if (off >= merged.length) break;
    }
    return sha256PrefixHex(merged);
  } catch {
    return null;
  }
}

// —— 内存缓存（模块级；每页会话一次加载） ——

const memory: { set: Set<string>; loaded: boolean } = { set: new Set(), loaded: false };

function getMemorySet(): { set: Set<string>; loaded: boolean } {
  return memory;
}
