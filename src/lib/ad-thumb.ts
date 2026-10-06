import type HlsType from 'hls.js';

/**
 * 已过滤条目的画面预览缩略图。
 *
 * 原理：为条目构造一个「条目专属 mini-m3u8」（组内分片的 EXTINF/URL 行），
 * 交给一个共用的隐藏预览播放器（offscreen video + hls.js）静音播放，播到
 * 0.3s 时暂停并截帧（canvas → JPEG dataURL）。这样对两种条目都成立——
 * 包括「已从进度条移除」的分组（分片已被剔出主时间轴，但文件 URL 仍在
 * 标记里）。
 *
 * 成本：每个条目 ≈ 一个分片的加载+解码，串行队列逐个生成；结果由调用方
 * 缓存（标记写回 IndexedDB / 条目内回填），跨会话零成本显示。
 *
 * CORS：canvas 导出要求视频源干净——直连分片需 CDN 支持 CORS（video 以
 * crossOrigin=anonymous 加载），代理形式的分片 URL 同源天然干净；不满足
 * 时 toDataURL 抛错 → 返回 null，列表显示占位图，不阻塞。
 */

export interface ThumbSeg {
  u: string;
  d: number;
}

const THUMB_W = 160;
const THUMB_H = 90;
const CAPTURE_AT = 0.3;
const JOB_TIMEOUT_MS = 12_000;

/** mini-m3u8 文本（独立导出：可单测） */
export function buildMiniM3u8(segs: ThumbSeg[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10'];
  for (const s of segs) {
    lines.push(`#EXTINF:${(s.d > 0 ? s.d : 4).toFixed(3)},`, s.u);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

// —— 共用隐藏预览播放器（串行队列） ——

let hlsCtor: (typeof HlsType & { Events: typeof HlsType.Events }) | null = null;
let videoEl: HTMLVideoElement | null = null;
let hlsInstance: HlsType | null = null;
const queue: Array<{ segs: ThumbSeg[]; resolve: (dataUrl: string | null) => void }> = [];
let draining = false;

/** 由播放器注入 Hls 构造器（避免本模块静态引入 hls.js） */
export function setThumbHlsCtor(ctor: typeof HlsType): void {
  hlsCtor = ctor as typeof hlsCtor;
}

function ensurePlayer(): { video: HTMLVideoElement; hls: HlsType } | null {
  if (typeof document === 'undefined') return null;
  if (!hlsCtor) return null;
  if (!videoEl) {
    videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.crossOrigin = 'anonymous'; // canvas 导出要求源干净
    videoEl.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.appendChild(videoEl);
  }
  if (!hlsInstance) {
    hlsInstance = new hlsCtor({ enableWorker: false, autoStartLoad: true, maxBufferLength: 6 });
    hlsInstance.attachMedia(videoEl);
  }
  return { video: videoEl, hls: hlsInstance };
}

function drain(): void {
  if (draining) return;
  const job = queue.shift();
  if (!job) return;
  draining = true;
  void (async () => {
    let result: string | null = null;
    try {
      const player = ensurePlayer();
      if (player) {
        const { video, hls } = player;
        const blobUrl = URL.createObjectURL(
          new Blob([buildMiniM3u8(job.segs)], { type: 'application/vnd.apple.mpegurl' })
        );
        result = await new Promise<string | null>((resolve) => {
          const finish = (r: string | null) => {
            hls.off(hlsCtor!.Events.MANIFEST_PARSED, onManifest);
            video.removeEventListener('timeupdate', onTimeupdate);
            clearTimeout(timer);
            video.pause();
            resolve(r);
          };
          // 静音起播，播到 CAPTURE_AT 秒截帧（避免 seek 早于缓冲的时序问题）
          const onTimeupdate = () => {
            if (video.currentTime >= CAPTURE_AT) {
              try {
                const canvas = document.createElement('canvas');
                canvas.width = THUMB_W;
                canvas.height = THUMB_H;
                const ctx = canvas.getContext('2d');
                if (!ctx) return finish(null);
                ctx.drawImage(video, 0, 0, THUMB_W, THUMB_H);
                finish(canvas.toDataURL('image/jpeg', 0.6));
              } catch {
                finish(null); // 画布被跨域污染等
              }
            }
          };
          const onManifest = () => video.play().catch(() => finish(null));
          const timer = setTimeout(() => finish(null), JOB_TIMEOUT_MS);
          hls.on(hlsCtor!.Events.MANIFEST_PARSED, onManifest);
          video.addEventListener('timeupdate', onTimeupdate);
          hls.loadSource(blobUrl);
        });
        URL.revokeObjectURL(blobUrl);
      }
    } catch {
      result = null;
    }
    job.resolve(result);
    draining = false;
    drain();
  })();
}

/** 生成条目缩略图（排队串行；失败返回 null） */
export function generateThumb(segs: ThumbSeg[]): Promise<string | null> {
  if (!segs.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    queue.push({ segs, resolve });
    drain();
  });
}
