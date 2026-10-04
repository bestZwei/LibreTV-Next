import type HlsType from 'hls.js';
import { stripAdGroups } from './m3u8';
import { getStripForPlaylist, stripSegments } from './ad-strip';
import { getKnownFingerprints, sha256PrefixHex, FINGERPRINT_PREFIX_BYTES } from './ad-fingerprints';
import { buildSegmentCacheKey, readCachedSegment, touchMeta } from './video-cache';

/**
 * hls.js loader 工厂：在同一个 loader 里组合「广告过滤」与「片段缓存命中」。
 *
 * - manifest / level：走基类网络加载；blockAd 开启时在 onSuccess 里剔除
 *   片头插入的广告段（整段移除，保留 DISCONTINUITY 时间轴标记）；
 * - fragment：cache-first——本地缓存命中直接合成响应（不回源），未命中走基类。
 *   BYTERANGE 分片（原文件切片）不缓存、直接回源。
 *   网络分片加载成功后对内容前 64KB 做 SHA-256，命中用户标记的广告指纹
 *   （ad-fingerprints.ts，user 信任级）时广播区间事件，播放器据此跳过所在
 *   分组——用户标记始终生效，不受 blockAd 开关限制。
 *
 * 关键细节：缓存命中时用预取阶段记录的**真实耗时**（costMs）合成 hls.js 的
 * loader stats——如果让加载时长为 0，ABR 会把它当成无限带宽，错误地拉高码率。
 *
 * hls.js 对每次请求都会 new 一个 loader 实例，因此实例上的 destroyed 标记
 * 生命周期安全（abort/destroy 后不再回调，防孤儿 onSuccess）。
 */
interface LoaderOptions {
  blockAd?: boolean;
  /** 缓存命中探针（设置面板展示命中率用），可缺省 */
  onProbe?: (hit: boolean) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HlsLoaderCtor = new (config: any) => any;

export function createHlsLoader(
  HlsCtor: typeof HlsType,
  options: LoaderOptions = {}
): HlsLoaderCtor {
  const { blockAd = false, onProbe } = options;

  /**
   * 用户标记指纹命中检测（异步、不阻塞交付）：命中的分片广播单分片区间
   * 事件，播放器端扩展为所在分组跳过。网络分片与本地缓存分片都要检测——
   * 预取器可能早已把广告分片缓存（跨集命中时缓存命中是常态）。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const checkFingerprintHit = (destroyed: () => boolean, response: any, ctx: any) => {
    if (destroyed() || !(response.data instanceof ArrayBuffer)) return;
    const known = getKnownFingerprints();
    if (!known.size) return;
    const frag = ctx?.frag;
    if (typeof frag?.start !== 'number' || typeof frag?.duration !== 'number') return;
    void sha256PrefixHex(response.data, FINGERPRINT_PREFIX_BYTES).then((hash) => {
      // 注意：此处不再校验 loader 实例的 destroyed——hls.js 在 onSuccess 交付后
      // 即可能销毁实例，而指纹比对用的是已到手的字节，与实例生命周期无关；
      // 事件是全局广播，销毁后完成依然有效（首个 bug 修复点）。
      if (!known.has(hash)) return;
      window.dispatchEvent(
        new CustomEvent('libretv:ad-fragment', {
          detail: { start: frag.start, end: frag.start + frag.duration },
        })
      );
    });
  };

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

          // 用户标记的时间轴剔除（user 信任级，不受 blockAd 开关限制）：
          // 该播放列表有已标记分组的注册时，交付前整组移除——广告从时间轴
          // 上消失，进度条/seek/回退行为与普通视频一致
          const stripNames = getStripForPlaylist(context.url);

          if (blockAd) {

            const onSuccess = callbacks.onSuccess;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callbacks.onSuccess = function (response: any, stats: any, ctx: any, networkDetails: any) {
              if (response.data && typeof response.data === 'string') {
                let data = stripAdGroups(response.data);
                if (stripNames.size) data = stripSegments(data, stripNames).text;
                response.data = data;
              }
              onSuccess(response, stats, ctx, networkDetails);
            };
          } else {
            if (stripNames.size) {
              const onSuccess = callbacks.onSuccess;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              callbacks.onSuccess = function (response: any, stats: any, ctx: any, networkDetails: any) {
                if (response.data && typeof response.data === 'string') {
                  response.data = stripSegments(response.data, stripNames).text;
                }
                onSuccess(response, stats, ctx, networkDetails);
              };
            }
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
            checkFingerprintHit(() => this.destroyed, { data: hit.data }, context);
            callbacks.onSuccess({ url: context.url, data: hit.data }, this.stats, context, undefined);
            return;
          }
          onProbe?.(false);
           
          const onSuccess = callbacks.onSuccess;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          callbacks.onSuccess = (response: any, stats: any, ctx: any, networkDetails: any) => {
            if (!this.destroyed) {
              onSuccess(response, stats, ctx, networkDetails);
              checkFingerprintHit(() => this.destroyed, response, ctx);
            }
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
