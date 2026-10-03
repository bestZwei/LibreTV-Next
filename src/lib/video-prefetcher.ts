import { parseM3u8Playlist, type ParsedPlaylist } from './m3u8-parse';
import { refreshActiveFingerprints } from './ad-fingerprints';
import {
  buildSegmentCacheKey,
  loadCacheSettings,
  putCachedSegmentResilient,
  enforceQuota,
  ensurePersistentStorage,
  type CacheSettings,
} from './video-cache';

/**
 * 前向片段预取器。
 *
 * 设计要点（这是「视频暂停也继续缓存」的全部秘密）：
 *   预取循环体内**不读取任何播放状态**——不判断 paused、不判断 document.hidden、
 *   不听播放器事件。循环体只有 fetch 与 cache 写入，因此视频暂停、页面切到
 *   后台标签页时，队列仍会继续推进。
 *
 *   `setThrottled()` 是「临时让出带宽」（播放卡顿时由调用方触发），与
 *   「暂停视频就停缓存」是两件事，不要混用。
 *
 * 窗口语义：
 *   - horizonSeconds > 0：从当前播放位置向前铺 horizonSeconds 秒，另回看 30s；
 *   - horizonSeconds = 0：无限模式，铺满到片尾（配额交给字节上限 + LRU）。
 */

export type PrefetchState = 'idle' | 'parsing' | 'running' | 'done' | 'error' | 'disabled';

export interface PrefetchStats {
  state: PrefetchState;
  cached: number;
  total: number;
  bytes: number;
  message?: string;
}

export interface PrefetchOptions {
  /** 当前集 m3u8 地址（与播放器 loadSource 一致，直接直连或代理改写形式均可） */
  m3u8Url: string;
  currentTime: number;
  /** 剧集标识 `${source}:${vodId}:${episodeIndex}`（LRU 按集淘汰的分组键） */
  episodeKey: string;
  /** 覆盖 CacheSettings.horizonSeconds；0 = 无限铺满（暂停黄金窗口使用） */
  horizonSeconds?: number;
  lookBehindSeconds?: number;
  concurrency?: number;
  onProgress?: (stats: PrefetchStats) => void;
}

interface RunDescriptor {
  m3u8Url: string;
  episodeKey: string;
  horizonSeconds: number;
}

/** 前向余量：正在跑的窗口距播放位置还有 60s 以上时，ensure 不重建 */
const FORWARD_MARGIN_SECONDS = 60;
/** parsing 期间视为「锚点未变」的容差：恢复进度等场景下 seek 目标与读到的播放头会差一点 */
const ANCHOR_EPSILON_SECONDS = 1;
const LOOK_BEHIND_SECONDS_DEFAULT = 30;
/** 时长缺失时的兜底窗口（分片数） */
const FALLBACK_MAX_SEGMENTS = 200;
const PROGRESS_EMIT_INTERVAL_MS = 250;
const EVICT_INTERVAL_MS = 15_000;

/** 纯函数：按累计时长定位时间点对应的分片下标（第一个「累计结束 ≥ t」的分片） */
export function indexAtTime(durations: number[], time: number): number {
  let acc = 0;
  for (let i = 0; i < durations.length; i++) {
    acc += durations[i];
    if (acc >= time) return i;
  }
  return Math.max(0, durations.length - 1);
}

/**
 * 纯函数：计算预取窗口 [fromIdx, toIdx)（左闭右开）。
 * horizonSeconds = 0 表示无限（铺到片尾）；时长全缺失时按 FALLBACK_MAX_SEGMENTS 兜底。
 */
export function computeWindow(
  durations: number[],
  currentTime: number,
  horizonSeconds: number,
  lookBehindSeconds = LOOK_BEHIND_SECONDS_DEFAULT
): { fromIdx: number; toIdx: number } {
  const total = durations.reduce((s, d) => s + d, 0);
  const cur = Math.max(0, Math.min(currentTime, total));
  const fromIdx = indexAtTime(durations, Math.max(0, cur - lookBehindSeconds));
  // 时长数据不可信（全 0，累计时长恒为 0）时按数量兜底，避免无限窗口
  if (total === 0) {
    return { fromIdx, toIdx: Math.min(durations.length, fromIdx + FALLBACK_MAX_SEGMENTS) };
  }
  if (horizonSeconds <= 0) return { fromIdx, toIdx: durations.length };
  const toTime = Math.min(total, cur + horizonSeconds);
  const toIdx = Math.min(durations.length, indexAtTime(durations, toTime) + 1);
  return { fromIdx, toIdx };
}

export function shouldPrefetch(): boolean {
  const conn = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!conn) return true;
  if (conn.saveData) return false;
  if (conn.effectiveType && /^(slow-)?2g$/.test(conn.effectiveType)) return false;
  return true;
}

export class VideoPrefetcher {
  private generation = 0;
  private abort = new AbortController();
  private throttled = false;
  private waiters: Array<() => void> = [];
  private stats: PrefetchStats = { state: 'idle', cached: 0, total: 0, bytes: 0 };
  private onProgress?: (stats: PrefetchStats) => void;
  private lastEmit = 0;

  /** 幂等入口：窗口已覆盖请求时不重建，否则中止当前运行并重开 */
  ensure(options: PrefetchOptions): void {
    const settings = loadCacheSettings();
    if (!settings.enabled || !shouldPrefetch()) {
      this.setState({ state: 'disabled', cached: 0, total: 0, bytes: 0 });
      return;
    }
    const horizon = options.horizonSeconds ?? settings.horizonSeconds;
    const descriptor: RunDescriptor = { m3u8Url: options.m3u8Url, episodeKey: options.episodeKey, horizonSeconds: horizon };

    // 幂等判断：先确认是同一个运行（同集、同清单、同窗口长度），再看窗口罩不罩得住新锚点。
    // - parsing：窗口还没算出来，无从判断覆盖——只在锚点基本没变时复用，省掉「刚起跑
    //   就被第二次 ensure abort」那次白扔的拉取与解析；锚点变了必须重建，否则会一直
    //   把窗口算在旧位置上，直到队列耗尽才有机会纠正；
    // - running：窗口已知，按**本次传入**的播放头判断前向余量。这里不能用
    //   this.currentTime——它只在 run() 里赋过一次值，播放头跑出去后仍按建窗时的
    //   位置判定，会一路误判「还够用」而不再重建。
    const sameRun =
      !!this.descriptor &&
      this.descriptor.m3u8Url === descriptor.m3u8Url &&
      this.descriptor.episodeKey === descriptor.episodeKey &&
      this.descriptor.horizonSeconds === descriptor.horizonSeconds;
    if (sameRun) {
      if (
        this.stats.state === 'parsing' &&
        Math.abs(options.currentTime - this.currentTime) < ANCHOR_EPSILON_SECONDS
      ) {
        return;
      }
      if (
        this.stats.state === 'running' &&
        options.currentTime + FORWARD_MARGIN_SECONDS < this.windowToTime &&
        options.currentTime >= this.windowFromTime
      ) {
        return;
      }
    }

    void this.run(options, settings, descriptor);
  }

  stop(): void {
    this.generation += 1;
    this.abort.abort();
    this.setState({ state: 'idle', cached: 0, total: 0, bytes: 0 });
  }

  /** 播放卡顿（video:waiting）时临时让出带宽；playing / 暂停黄金窗口时解除 */
  setThrottled(value: boolean): void {
    this.throttled = value;
    if (!value) {
      const waiters = this.waiters.splice(0);
      for (const w of waiters) w();
    }
  }

  getStats(): PrefetchStats {
    return this.stats;
  }

  // —— 内部运行时状态 ——
  private descriptor?: RunDescriptor;
  private currentTime = 0;
  private windowFromTime = 0;
  private windowToTime = 0;

  private setState(next: PrefetchStats): void {
    this.stats = next;
    const now = Date.now();
    if (now - this.lastEmit >= PROGRESS_EMIT_INTERVAL_MS || next.state !== 'running') {
      this.lastEmit = now;
      this.onProgress?.(next);
    }
  }

  private waitForResume(generation: number): Promise<void> {
    if (!this.throttled || generation !== this.generation) return Promise.resolve();
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (!this.throttled || generation !== this.generation) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
  }

  private async run(options: PrefetchOptions, settings: CacheSettings, descriptor: RunDescriptor): Promise<void> {
    const generation = ++this.generation;
    this.abort.abort();
    this.abort = new AbortController();
    this.onProgress = options.onProgress;
    this.descriptor = descriptor;
    this.currentTime = options.currentTime;
    this.setState({ state: 'parsing', cached: 0, total: 0, bytes: 0 });

    void ensurePersistentStorage();

    let parsed: ParsedPlaylist;
    try {
      // 解析前兜底刷新指纹活跃表（parseM3u8Playlist 内的 stripAds 是同步查表）。
      // 不 await：播放路径上 setupHls 已先行刷新过，这里只是兜底（如独立预取场景），
      // 且 run() 必须同步发出 m3u8 fetch（ensure 幂等的时序前提）
      void refreshActiveFingerprints().catch(() => undefined);
      parsed = await parseM3u8Playlist(options.m3u8Url);
    } catch (err) {
      if (generation !== this.generation) return;
      this.setState({
        state: 'error',
        cached: 0,
        total: 0,
        bytes: 0,
        message: err instanceof Error ? err.message : 'm3u8 解析失败',
      });
      return;
    }
    if (generation !== this.generation) return;
    if (parsed.byterange) {
      this.setState({ state: 'error', cached: 0, total: 0, bytes: 0, message: '该集使用 BYTERANGE 分片，不支持本地缓存' });
      return;
    }

    const durations = parsed.segments.map((s) => s.duration);
    const horizon = descriptor.horizonSeconds;
    const { fromIdx, toIdx } = computeWindow(durations, options.currentTime, horizon, options.lookBehindSeconds);
    this.windowFromTime = durations.slice(0, fromIdx).reduce((s, d) => s + d, 0);
    this.windowToTime = durations.slice(0, toIdx).reduce((s, d) => s + d, 0);
    this.currentTime = options.currentTime;

    // 队列：先前向，再回看（已在窗口内的跳过）
    const queue: Array<{ url: string; index: number }> = [];
    for (let i = fromIdx; i < toIdx; i++) queue.push({ url: parsed.segments[i].url, index: i + 1 });
    for (let i = Math.max(0, fromIdx - 1); i >= 0; i--) {
      const behindStart = durations.slice(0, i).reduce((s, d) => s + d, 0);
      if (options.currentTime - behindStart > (options.lookBehindSeconds ?? 30)) break;
      queue.push({ url: parsed.segments[i].url, index: i + 1 });
    }
    // 去重（回看与前向窗口重叠的片段）
    const seen = new Set<string>();
    const taskQueue = queue.filter((t) => {
      const key = buildSegmentCacheKey(t.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    this.setState({ state: 'running', cached: 0, total: taskQueue.length, bytes: 0 });
    let cursor = 0;
    let cached = 0;
    let bytes = 0;
    let lastEvict = Date.now();
    const concurrency = Math.min(options.concurrency ?? 3, 4);

    const worker = async (): Promise<void> => {
      while (cursor < taskQueue.length) {
        if (generation !== this.generation) return;
        await this.waitForResume(generation);
        const task = taskQueue[cursor++];
        if (!task) return;
        const key = buildSegmentCacheKey(task.url);
        const started = performance.now();
        try {
          const res = await fetch(task.url, { signal: this.abort.signal, headers: { Accept: '*/*' } });
          if (!res.ok) continue;
          const buffer = await res.arrayBuffer();
          if (generation !== this.generation) return;
          const costMs = performance.now() - started;
          const result = await putCachedSegmentResilient(key, buffer, {
            episodeKey: options.episodeKey,
            index: task.index,
            costMs,
            settings,
          });
          if (result === 'ok') {
            cached += 1;
            bytes += buffer.byteLength;
            this.setState({ state: 'running', cached, total: taskQueue.length, bytes });
          } else if (result === 'quota') {
            this.setState({ state: 'done', cached, total: taskQueue.length, bytes, message: '存储空间已满，已停止预取' });
            this.generation += 1; // 终止其他 worker
            return;
          }
        } catch {
          // 单分片失败不中断队列（网络抖动/源限流），播放侧有自己的重试
          if (generation !== this.generation) return;
        }
        // 周期性触发 LRU 淘汰（写放大与配额的双保险）
        if (Date.now() - lastEvict > EVICT_INTERVAL_MS) {
          lastEvict = Date.now();
          void enforceQuota(settings);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    if (generation !== this.generation) return;
    this.setState({
      state: 'done',
      cached,
      total: taskQueue.length,
      bytes,
      message: cached < taskQueue.length ? '部分分片未缓存（源不可达或存储受限）' : undefined,
    });
  }
}

/** 全站单例：当前集的预取器 */
let currentPrefetcher: VideoPrefetcher | undefined;
export function getVideoPrefetcher(): VideoPrefetcher {
  currentPrefetcher ??= new VideoPrefetcher();
  return currentPrefetcher;
}

/** 独立单例：下一集预热（避免打断当前集的预取队列） */
let nextEpisodePrefetcher: VideoPrefetcher | undefined;
export function getNextEpisodePrefetcher(): VideoPrefetcher {
  nextEpisodePrefetcher ??= new VideoPrefetcher();
  return nextEpisodePrefetcher;
}
