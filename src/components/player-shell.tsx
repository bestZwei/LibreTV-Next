'use client';

import { useEffect, useRef, useState } from 'react';
import Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';
import { filterAdsFromM3u8 } from '@/lib/m3u8';
import { formatTime } from '@/lib/utils';

/**
 * 播放器外壳：ArtPlayer + hls.js（旧版 player.js 的 React 化）。
 * 保留：广告分片过滤、自动连播回调、进度回调、快捷键、移动端长按倍速、错误恢复。
 * 移除：DOM 手工操作、watch.html 跳转链、localStorage 状态总线。
 */

// 广告过滤 loader：拦截 manifest/level 响应文本，剔除 DISCONTINUITY 广告片段
class CustomHlsJsLoader extends Hls.DefaultConfig.loader {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(config: any) {
    super(config);
    const load = this.load.bind(this);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- hls.js loader 回调签名未导出精确类型
    this.load = function (context: any, config: any, callbacks: any) {
      if (context.type === 'manifest' || context.type === 'level') {
        const onSuccess = callbacks.onSuccess;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callbacks.onSuccess = function (response: any, stats: any, ctx: any, networkDetails: any) {
          if (response.data && typeof response.data === 'string') {
            response.data = filterAdsFromM3u8(response.data);
          }
          return onSuccess(response, stats, ctx, networkDetails);
        };
      }
      load(context, config, callbacks);
    };
  }
}

interface PlayerShellProps {
  url: string;
  title: string;
  adFilter: boolean;
  autoplayNext: boolean;
  /** 进度恢复：优先 URL position，其次查询该回调（返回 0 表示无记录） */
  getRestorePosition?: () => number | Promise<number>;
  onTimeUpdate?: (position: number, duration: number) => void;
  onEnded?: () => void;
  onPause?: (position: number, duration: number) => void;
}

export function PlayerShell({
  url,
  title,
  adFilter,
  autoplayNext,
  getRestorePosition,
  onTimeUpdate,
  onEnded,
  onPause,
}: PlayerShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  // 起播前的品牌占位图（沿用旧版 nomedia 素材），实际开始播放后隐藏
  const [showPoster, setShowPoster] = useState(true);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 用 ref 持有最新回调，避免重建播放器
  const cbs = useRef({ onTimeUpdate, onEnded, onPause, getRestorePosition });
  cbs.current = { onTimeUpdate, onEnded, onPause, getRestorePosition };
  const autoplayRef = useRef(autoplayNext);
  autoplayRef.current = autoplayNext;

  useEffect(() => {
    if (!containerRef.current || !url) return;
    setError('');
    setShowPoster(true);

    // 换集时清理函数在「新回调已挂到 ref 上」之后才执行，
    // 卸载前保存进度必须用本次挂载（本集）的回调，否则会把上一集的
    // 播放位置写进新集数的进度记录，导致换集后从上一集的时间点继续播放
    const mountCbs = { onTimeUpdate, onEnded, onPause, getRestorePosition };

    let lastSave = 0;
    let playbackStarted = false;
    let errorCount = 0;
    let ended = false;

    const showHint = (text: string) => {
      setHint(text);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      hintTimerRef.current = setTimeout(() => setHint(''), 2500);
    };

    const hlsConfig: Partial<HlsConfig> = {
      debug: false,
      enableWorker: true,
      backBufferLength: 90,
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      maxBufferSize: 30 * 1000 * 1000,
      maxBufferHole: 0.5,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 1000,
      startLevel: -1,
      abrEwmaDefaultEstimate: 500_000,
      appendErrorMaxRetry: 5,
    };
    if (adFilter) hlsConfig.loader = CustomHlsJsLoader as unknown as HlsConfig['loader'];

    /**
     * 初始化 HLS。allowProxyFallback：直连致命网络错误（CORS/防盗链/分片被拒）时，
     * 自动改走同源 cookie 鉴权的 /api/proxy 重试一次。
     */
    const setupHls = (video: HTMLVideoElement, mediaUrl: string, allowProxyFallback: boolean) => {
      hlsRef.current?.destroy();
      const hls = new Hls(hlsConfig);
      hlsRef.current = hls;

      hls.loadSource(mediaUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        errorCount++;
        if (data.fatal && !playbackStarted) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              if (
                allowProxyFallback &&
                !mediaUrl.startsWith('/api/proxy/') &&
                (errorCount >= 2 || data.details === 'manifestLoadError')
              ) {
                showHint('直连失败，改用代理重试...');
                setupHls(video, `/api/proxy/${encodeURIComponent(mediaUrl)}`, false);
                return;
              }
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              if (errorCount > 3) {
                setError('视频加载失败，可能是格式不兼容或源不可用，请尝试其他视频源');
              }
          }
        }
      });
    };

    const art = new Artplayer({
      container: containerRef.current,
      url,
      type: 'm3u8',
      volume: 0.8,
      autoplay: true,
      pip: true,
      autoMini: true,
      screenshot: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: true,
      hotkey: false,
      theme: '#2563eb',
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      moreVideoAttr: { crossOrigin: 'anonymous', playsInline: true },
      customType: {
        m3u8: (video: HTMLVideoElement, mediaUrl: string) => {
          setupHls(video, mediaUrl, true);
        },
      },
    });
    artRef.current = art;
    art.on('video:loadedmetadata', () => {
      // ArtPlayer 运行时支持 title 选项（类型定义未覆盖），用于界面标题展示
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art as any).title = title;
      } catch { /* 忽略 */ }
    });

    art.on('ready', () => {
      // 进度恢复
      const restore = async () => {
        const saved = (await cbs.current.getRestorePosition?.()) ?? 0;
        const duration = art.duration || 0;
        if (saved > 10 && duration > 0 && saved < duration - 2) {
          art.currentTime = saved;
          showHint(`已从 ${formatTime(saved)} 继续播放`);
        }
      };
      restore();
    });

    art.on('video:playing', () => {
      playbackStarted = true;
      setShowPoster(false);
      setError('');
    });
    art.on('video:error', () => {
      setError('视频播放失败，请尝试其他视频源');
    });
    art.on('video:timeupdate', () => {
      const now = Date.now();
      if (now - lastSave > 5000) {
        lastSave = now;
        cbs.current.onTimeUpdate?.(art.currentTime, art.duration);
      }
    });
    art.on('video:pause', () => {
      cbs.current.onPause?.(art.currentTime, art.duration);
    });
    art.on('video:ended', () => {
      ended = true;
      cbs.current.onEnded?.();
    });

    // —— 键盘快捷键（旧版 hotkey:false + 自定义逻辑的移植） ——
    const shortcuts = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      const current = artRef.current;
      if (!current) return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); return; } // 由父层处理集数切换
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); return; }
      switch (e.key) {
        case 'ArrowLeft':
          if (current.currentTime > 5) { current.currentTime -= 5; showHint('快退 5s'); e.preventDefault(); }
          break;
        case 'ArrowRight':
          if (current.duration - current.currentTime > 5) { current.currentTime += 5; showHint('快进 5s'); e.preventDefault(); }
          break;
        case 'ArrowUp':
          if (current.volume < 1) { current.volume = Math.min(1, current.volume + 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case 'ArrowDown':
          if (current.volume > 0) { current.volume = Math.max(0, current.volume - 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case ' ':
          current.toggle(); showHint('播放/暂停'); e.preventDefault();
          break;
        case 'f': case 'F':
          current.fullscreen = !current.fullscreen; e.preventDefault();
          break;
      }
    };
    document.addEventListener('keydown', shortcuts);

    // —— 移动端长按 3 倍速 ——
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let isLongPress = false;
    let originalRate = 1.0;
    const el = containerRef.current;

    const onTouchStart = (e: TouchEvent) => {
      if (art.video?.paused) return;
      originalRate = art.video.playbackRate;
      longPressTimer = setTimeout(() => {
        if (art.video?.paused) return;
        art.video.playbackRate = 3.0;
        isLongPress = true;
        showHint('3 倍速');
        e.preventDefault();
      }, 500);
    };
    const onTouchEnd = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (isLongPress) {
        art.video.playbackRate = originalRate;
        isLongPress = false;
        showHint(`${originalRate} 倍速`);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (isLongPress) e.preventDefault();
    };
    el?.addEventListener('touchstart', onTouchStart, { passive: false });
    el?.addEventListener('touchend', onTouchEnd);
    el?.addEventListener('touchcancel', onTouchEnd);
    el?.addEventListener('touchmove', onTouchMove, { passive: false });

    // 双击全屏由 ArtPlayer 原生 DBCLICK_FULLSCREEN 处理（video:dblclick 不在其事件代理列表中，监听无效）

    // 卸载与页面隐藏时保存进度
    const saveOnHide = () => {
      if (document.visibilityState === 'hidden') {
        cbs.current.onPause?.(art.currentTime, art.duration);
      }
    };
    document.addEventListener('visibilitychange', saveOnHide);

    return () => {
      // 卸载前刷一次最终进度，避免丢失最后几秒。
      // 注意用 mountCbs（本集回调）而非 cbs.current（已是下一集的回调）；
      // 已自然播完的集数不回写，避免覆盖 onEnded 里清除的「已看完」记录
      if (!ended) {
        try {
          mountCbs.onPause?.(art.currentTime, art.duration);
        } catch { /* 忽略 */ }
      }
      document.removeEventListener('keydown', shortcuts);
      document.removeEventListener('visibilitychange', saveOnHide);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      el?.removeEventListener('touchstart', onTouchStart);
      el?.removeEventListener('touchend', onTouchEnd);
      el?.removeEventListener('touchcancel', onTouchEnd);
      el?.removeEventListener('touchmove', onTouchMove);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      art.destroy();
      artRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, adFilter]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      {showPoster && !error && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{
            backgroundImage: 'url(/player-poster.png)',
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80">
          <p className="text-red-400 text-sm">{error}</p>
          <button className="btn-ghost text-xs" onClick={() => location.reload()}>
            重新加载
          </button>
        </div>
      )}
      {hint && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/70 text-white text-sm px-3 py-1.5 rounded-full pointer-events-none animate-fade-in">
          {hint}
        </div>
      )}
      {autoplayNext && !error && (
        <div className="absolute bottom-16 right-3 text-[10px] text-muted bg-black/50 px-2 py-0.5 rounded pointer-events-none">
          自动连播已开启
        </div>
      )}
    </div>
  );
}
