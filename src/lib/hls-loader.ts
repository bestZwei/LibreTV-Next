import type HlsType from 'hls.js';
import { stripAdsDetailed, registerEpisodeGroups } from './ad-detect';
import { buildSegmentCacheKey, readCachedSegment, touchMeta } from './video-cache';

/**
 * hls.js loader 工厂：在同一个 loader 里组合「广告过滤」与「片段缓存命中」。
 *
 * - manifest / level：走基类网络加载；blockAd 开启时在 onSuccess 里剔除广告段
 *   （stripAds = 基线规则 + 指纹库匹配，见 ad-detect.ts），并登记「分片 URL → 组」
 *   反查表供手动标记广告使用；
 * - fragment：cache-first——本地缓存命中直接合成响应（不回源），未命中走基类。
 *   BYTERANGE 分片（原文件切片）不缓存、直接回源。
 *
 * 关键细节：缓存命中时用预取阶段记录的**真实耗时**（costMs）合成 hls.js 的
 * loader stats——如果让加载时长为 0，ABR 会把它当成无限带宽，错误地拉高码率。
 *
 * hls.js 对每次请求都会 new 一个 loader 实例，因此实例上的 destroyed 标记
 * 生命周期安全（abort/destroy 后不再回调，防孤儿 onSuccess）。
 */
export interface AdFilteredInfo {
  /** 被指纹命中的组数 */
  groups: number;
  /** 广告总时长（秒） */
  seconds: number;
  /** 命中的签名（调用方按源 host 累加命中计数） */
  signatures: string[];
}

interface LoaderOptions {
  blockAd?: boolean;
  /** 缓存命中探针（设置面板展示命中率用），可缺省 */
  onProbe?: (hit: boolean) => void;
  /** 指纹过滤发生时回调（loader 侧不感知 host，由调用方补齐） */
  onAdFiltered?: (info: AdFilteredInfo) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HlsLoaderCtor = new (config: any) => any;

export function createHlsLoader(
  HlsCtor: typeof HlsType,
  options: LoaderOptions = {}
): HlsLoaderCtor {
  const { blockAd = false, onProbe, onAdFiltered } = options;

  return class CacheFirstHlsLoader extends (HlsCtor.DefaultConfig.loader as HlsLoaderCtor) {
    private destroyed = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(config: any) {
      super(config);
      const load = this.load.bind(this);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.load = (context: any, config: any, callbacks: any) => {
        const isPlaylist = context.type === 'manifest' || context.type === 'level';

        // —— 播放列表：网络加载 + 可选广告过滤 ——
        if (isPlaylist) {

          if (blockAd) {

            const onSuccess = callbacks.onSuccess;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callbacks.onSuccess = function (response: any, stats: any, ctx: any, networkDetails: any) {
              if (response.data && typeof response.data === 'string') {
                const { content, fingerprintRemoved } = stripAdsDetailed(response.data);
                response.data = content;
                // 登记「分片 URL → 组」反查表：key 归一化方式与片段缓存一致，
                // 播放器侧手动标记广告时用同一构造器反查（buildSegmentCacheKey）。
                // 注意不在这里 reset：master + 多档位 level 依次加载，累积登记互不冲突，
                // 换集时由播放器负责 resetEpisodeGroups
                if (content.includes('#EXTINF')) {
                  registerEpisodeGroups(content, ctx?.url);
                }
                if (fingerprintRemoved.groups > 0) {
                  onAdFiltered?.({
                    groups: fingerprintRemoved.groups,
                    seconds: fingerprintRemoved.seconds,
                    signatures: fingerprintRemoved.signatures,
                  });
                }
              }
              onSuccess(response, stats, ctx, networkDetails);
            };
          }
          load(context, config, callbacks);
          return;
        }

        // —— BYTERANGE 分片：整文件切片，无法独立缓存，直接回源 ——
        if (context.rangeStart || context.rangeEnd) {
          load(context, config, callbacks);
          return;
        }

        // —— 片段：cache-first ——
        const key = buildSegmentCacheKey(context.url);
        readCachedSegment(key).then((hit) => {
          if (this.destroyed) return;
          if (hit) {
            void touchMeta(key);
            onProbe?.(true);
            const now = performance.now();
            Object.assign(this.stats, {
              loading: { start: now - hit.costMs, first: now - hit.costMs + 1, end: now },
              total: hit.data.byteLength,
              loaded: hit.data.byteLength,
            });
            callbacks.onSuccess({ url: context.url, data: hit.data }, this.stats, context, undefined);
            return;
          }
          onProbe?.(false);

          const onSuccess = callbacks.onSuccess;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          callbacks.onSuccess = (response: any, stats: any, ctx: any, networkDetails: any) => {
            if (!this.destroyed) onSuccess(response, stats, ctx, networkDetails);
          };
          load(context, config, callbacks);
        });
      };
    }

    abort(): void {
      this.destroyed = true;
      super.abort();
    }

    destroy(): void {
      this.destroyed = true;
      super.destroy?.();
    }
  };
}
