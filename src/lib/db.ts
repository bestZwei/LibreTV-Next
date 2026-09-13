import Dexie, { type EntityTable } from 'dexie';
import type { SourceConfig } from './types';
// 仅类型引入：store.ts 运行时会引用本模块，反向只取类型不会形成运行时循环
import type { LiveProbeEntry } from './store';

/**
 * IndexedDB 持久化（替代旧版 localStorage 数据库）：
 * - 观看历史不再冗余存储全集 URL 列表（旧版长剧 × 50 条极易撑爆 5MB 配额），
 *   只存定位信息（sourceKey+vodId+index），进入播放页时按需重新拉详情，
 *   顺带免费获得「剧集更新同步」能力。
 * - v2：直播测活缓存从 localStorage（随 zustand persist 整体重写）迁入独立表，
 *   高频写入不再拖累设置快照的序列化。
 */

export interface HistoryEntry {
  /** 主键：`${sourceKey}_${vodId}` */
  id: string;
  sourceKey: string;
  sourceUrl?: string;
  vodId: string;
  title: string;
  pic?: string;
  episodeIndex: number;
  totalEpisodes: number;
  playbackPosition: number;
  duration: number;
  timestamp: number;
}

export interface ProgressEntry {
  key: string; // `${sourceKey}_${vodId}_${episodeIndex}`
  position: number;
  duration: number;
  updatedAt: number;
}

export interface SearchHistoryEntry {
  text: string;
  timestamp: number;
}

export const db = new Dexie('libretv') as Dexie & {
  history: EntityTable<HistoryEntry, 'id'>;
  progress: EntityTable<ProgressEntry, 'key'>;
  searchHistory: EntityTable<SearchHistoryEntry, 'text'>;
  liveProbe: EntityTable<LiveProbeEntry & { url: string }, 'url'>;
};

db.version(1).stores({
  history: 'id, timestamp',
  progress: 'key, updatedAt',
  searchHistory: 'text, timestamp',
});

// v2 仅新增表；Dexie 会自动继承低版本的表结构
db.version(2).stores({
  liveProbe: 'url',
});

export const MAX_HISTORY = 100;
export const MAX_SEARCH_HISTORY = 10;

export async function upsertHistory(entry: Omit<HistoryEntry, 'id'>): Promise<void> {
  const id = `${entry.sourceKey}_${entry.vodId}`;
  const existing = await db.history.get(id);
  const merged: HistoryEntry = {
    ...existing,
    ...entry,
    id,
    playbackPosition: entry.playbackPosition > 10 ? entry.playbackPosition : existing?.playbackPosition ?? 0,
    duration: entry.duration || existing?.duration || 0,
    timestamp: Date.now(),
  };
  await db.history.put(merged);
  // 淘汰最旧记录
  const count = await db.history.count();
  if (count > MAX_HISTORY) {
    const oldest = await db.history.orderBy('timestamp').limit(count - MAX_HISTORY).toArray();
    await db.history.bulkDelete(oldest.map((o) => o.id));
  }
}

export async function updateHistoryProgress(
  sourceKey: string,
  vodId: string,
  position: number,
  duration: number
): Promise<void> {
  const id = `${sourceKey}_${vodId}`;
  const existing = await db.history.get(id);
  if (!existing) return;
  if (Math.abs(existing.playbackPosition - position) < 2 && Math.abs(existing.duration - duration) < 2) return;
  await db.history.update(id, {
    playbackPosition: position,
    duration,
    timestamp: Date.now(),
  });
}

export async function removeHistory(sourceKey: string, vodId: string): Promise<void> {
  await db.history.delete(`${sourceKey}_${vodId}`);
}

export async function clearAllHistory(): Promise<void> {
  await db.history.clear();
}

export function progressKeyOf(sourceKey: string, vodId: string, episodeIndex: number): string {
  return `${sourceKey}_${vodId}_${episodeIndex}`;
}

export async function saveProgress(sourceKey: string, vodId: string, episodeIndex: number, position: number, duration: number): Promise<void> {
  if (!duration || position < 1) return;
  await db.progress.put({
    key: progressKeyOf(sourceKey, vodId, episodeIndex),
    position,
    duration,
    updatedAt: Date.now(),
  });
}

export async function clearProgress(sourceKey: string, vodId: string, episodeIndex: number): Promise<void> {
  await db.progress.delete(progressKeyOf(sourceKey, vodId, episodeIndex));
}

export async function addSearchHistory(text: string): Promise<void> {
  const t = text.trim().slice(0, 50);
  if (!t) return;
  await db.searchHistory.put({ text: t, timestamp: Date.now() });
  const count = await db.searchHistory.count();
  if (count > MAX_SEARCH_HISTORY) {
    const oldest = await db.searchHistory.orderBy('timestamp').limit(count - MAX_SEARCH_HISTORY).toArray();
    await db.searchHistory.bulkDelete(oldest.map((o) => o.text));
  }
}

export async function removeSearchHistory(text: string): Promise<void> {
  await db.searchHistory.delete(text);
}

export async function clearSearchHistory(): Promise<void> {
  await db.searchHistory.clear();
}

// —— 直播测活缓存（TTL 过滤由调用方负责，本层只管存取） ——

export async function loadLiveProbeResults(): Promise<Record<string, LiveProbeEntry>> {
  const rows = await db.liveProbe.toArray();
  const out: Record<string, LiveProbeEntry> = {};
  for (const r of rows) out[r.url] = r;
  return out;
}

export async function saveLiveProbeResults(entries: Record<string, LiveProbeEntry>): Promise<void> {
  const rows = Object.entries(entries).map(([url, e]) => ({ ...e, url }));
  if (rows.length > 0) await db.liveProbe.bulkPut(rows);
}

export async function clearLiveProbeResultsDb(): Promise<void> {
  await db.liveProbe.clear();
}

// —— 配置导入导出（兼容旧版 LibreTV-Settings JSON 结构的导出格式） ——

export async function exportConfig(): Promise<string> {
  const history = await db.history.toArray();
  const settings = localStorage.getItem('libretv-settings');

  const data: Record<string, unknown> = {
    viewingHistory: JSON.stringify(history),
  };
  if (settings) data['libretv-settings'] = settings;

  return JSON.stringify({
    name: 'LibreTV-Settings',
    time: Date.now().toString(),
    cfgVer: '2.0.0',
    data,
  });
}

export async function importConfig(content: string): Promise<void> {
  const config = JSON.parse(content) as {
    name?: string;
    data?: Record<string, string>;
  };
  if (config.name !== 'LibreTV-Settings') throw new Error('配置文件格式不正确');
  const data = config.data || {};

  if (typeof data['libretv-settings'] === 'string') {
    localStorage.setItem('libretv-settings', data['libretv-settings']);
  }

  if (typeof data['viewingHistory'] === 'string') {
    // 兼容旧版历史结构（含全集 URL 列表），只迁移定位信息
    const legacy = JSON.parse(data['viewingHistory']) as Record<string, unknown>[];
    for (const item of legacy.slice(0, MAX_HISTORY)) {
      const sourceKey = String(item.sourceCode || item.sourceName || '');
      const vodId = String(item.vod_id || '');
      const title = String(item.title || '未知视频');
      if (!sourceKey || !vodId) continue;
      const totalEpisodes = Array.isArray(item.episodes) ? item.episodes.length : 0;
      await upsertHistory({
        sourceKey,
        vodId,
        title,
        episodeIndex: typeof item.episodeIndex === 'number' ? item.episodeIndex : 0,
        totalEpisodes,
        playbackPosition: typeof item.playbackPosition === 'number' ? item.playbackPosition : 0,
        duration: typeof item.duration === 'number' ? item.duration : 0,
        timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
      });
    }
  }
}

export function saveSettingsToLocalStorage(settings: unknown): void {
  localStorage.setItem('libretv-settings', JSON.stringify(settings));
}

export function loadSettingsFromLocalStorage<T>(): T | undefined {
  try {
    const raw = localStorage.getItem('libretv-settings');
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export type { SourceConfig };
