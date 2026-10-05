'use client';

import { useEffect, useRef, useState } from 'react';
import Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';

import { PlaybackRecovery, describeHlsError } from '@/lib/playback-recovery';
import { createHlsLoader } from '@/lib/hls-loader';
import {
  findGroupAt, mergeRanges, isAdjacentRange,
  addAdMark, getMarksForEpisode, getAdMark, learnMarkFingerprints, removeAdMark,
  type FragLike, type FilteredEntry,
} from '@/lib/ad-marks';
import { ensureFingerprintsLoaded } from '@/lib/ad-fingerprints';
import { registerStripForPlaylist, unregisterStripForPlaylist, fragUrlsOf } from '@/lib/ad-strip';
import { useToast } from './toast';
import {
  getVideoPrefetcher,
  getNextEpisodePrefetcher,
} from '@/lib/video-prefetcher';
import { loadCacheSettings } from '@/lib/video-cache';
import { formatTime } from '@/lib/utils';

/**
 * 播放器外壳：ArtPlayer + hls.js（旧版 player.js 的 React 化）。
 * 保留：广告分片过滤、自动连播回调、进度回调、快捷键、移动端长按倍速、错误恢复。
 * 移除：DOM 手工操作、watch.html 跳转链、localStorage 状态总线。
 *
 * 关键设计：ArtPlayer 实例只在挂载时创建一次，换集（url 变化）只「切换 HLS 源」
 * 而不销毁重建。否则在「网页全屏（页面全屏）」下整实例重建会丢失全屏上下文、
 * 重建 <video> 元素，触发「黑屏有声」的渲染竞态。
 */

interface PlayerShellProps {
  url: string;
  title: string;
  adFilter: boolean;
  autoplayNext: boolean;
  /** 剧集标识 `${source}:${vodId}:${episodeIndex}`（片段缓存按集淘汰的分组键） */
  episodeKey?: string;
  /** 下一集 m3u8 地址：当前集预取完成后预热下一集前 7 分钟 */
  nextUrl?: string;
  nextEpisodeKey?: string;
  /** 进度恢复：优先 URL position，其次查询该回调（返回 0 表示无记录） */
  getRestorePosition?: () => number | Promise<number>;
  onTimeUpdate?: (position: number, duration: number) => void;
  onEnded?: () => void;
  onPause?: (position: number, duration: number) => void;
  /** 恢复策略判源不可用（重试耗尽/格式硬失败）时回调：父级弹出换源面板 */
  onRequestSwitchSource?: (reason: string) => void;
  /** 本集已过滤条目变化（播放器下方列表的数据源） */
  onFilteredEntries?: (entries: FilteredEntry[]) => void;
}

export function PlayerShell({
  url,
  title,
  adFilter,
  autoplayNext,
  episodeKey,
  nextUrl,
  nextEpisodeKey,
  getRestorePosition,
  onTimeUpdate,
  onEnded,
  onPause,
  onRequestSwitchSource,
  onFilteredEntries,
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

  // 始终持有最新 props/回调，避免重建播放器
  const propsRef = useRef({
    url, title, adFilter, autoplayNext, episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onRequestSwitchSource,
    onFilteredEntries,
  });
  propsRef.current = {
    url, title, adFilter, autoplayNext, episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onRequestSwitchSource,
    onFilteredEntries,
  };

  // 跨集共享、每次换集重置的播放链路状态
  // 媒体健康度：音频轨可播不代表视频轨正常（「黑屏但有声」的假死态）。
  // 仅当有分片真正进入 MSE buffer 后才视为恢复，错误遮罩才能被清除。
  const mediaHealthyRef = useRef(true);
  const playbackStartedRef = useRef(false);
  // 起播阶段的 video 元素级错误允许自愈重试一次（重建 hls/MSE）
  const videoErrorRetryUsedRef = useRef(false);
  // 进度恢复每集只执行一次（MANIFEST_PARSED 可能因代理回退再次触发）
  const restoredRef = useRef(false);
  // timeupdate 续跑预取的游标：必须按集清零，否则会沿用上一集的时间戳推迟首次续跑
  const lastPrefetchEnsureRef = useRef(0);
  // setupHls 可能改走代理形式，video:error 重试要用最近一次的地址
  const currentMediaUrlRef = useRef(url);
  // 本集的恢复策略实例：跨直连/代理两级重建共享计数
  const recoveryRef = useRef<PlaybackRecovery | null>(null);
  // 自然播完标记，卸载时不回写进度（避免覆盖「已看完」记录）
  const endedRef = useRef(false);
  // —— 用户标记广告（第 4 层） ——
  // 当前集的跳过区间（由条目列表派生：非剔除条目的合并），守卫据此 seek 越过
  const adRangesRef = useRef<{ start: number; end: number }[]>([]);
  // 本集已过滤条目（UI 列表数据 + 跳过区间的来源）；变更经
  // onFilteredEntries 上报父级渲染，播放器自身不依赖其渲染输出
  const adEntriesRef = useRef<FilteredEntry[]>([]);
  const applyEntries = (next: FilteredEntry[]) => {
    // 按 id 去重（标记入库与集数加载可能竞态产生同 id 条目），按起点排序
    const uniq = [...new Map(next.map((e) => [e.id, e])).values()].sort((a, b) => a.start - b.start);
    adEntriesRef.current = uniq;
    adRangesRef.current = mergeRanges(uniq.filter((e) => !e.removed).map((e) => ({ start: e.start, end: e.end })));
    propsRef.current.onFilteredEntries?.(uniq);
  };
  // 最近一次标记（10s 内再次点击 = 扩展到相邻分组）
  const lastMarkRef = useRef<{ range: { start: number; end: number }; markId: string; at: number } | null>(null);
  // 用户 seek 落入的广告区间起点（守卫放行回看意图；离开后恢复自动跳过）
  const insideBySeekRef = useRef<number | null>(null);
  // 重建链路后的恢复位置（标记时间轴剔除/撤销时校正进度）
  const pendingResumeRef = useRef<number | null>(null);
  const { toast: showToast } = useToast();

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  /**
   * 标记当前分组为广告（第 4 层：用户主动标记）。
   * 定位：hls.js 运行时结构（latestLevelDetails.fragments 按连续相同 cc 分组），
   * 广告在源站拼接时独立成组，组边界即广告边界——用户只需在广告播放时点一下。
   * 降级：源无 DISCONTINUITY（整集一组）时只标记当前分片。
   * 生效：当集立即加入跳过区间并 seek 到组尾；组内分片指纹入库（user 级），
   * 之后任何一集命中即自动跳过所在分组。
   */
  const markCurrentAd = () => {
    const hls = hlsRef.current;
    const art = artRef.current;
    if (!hls || !art) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const details = (hls as any).latestLevelDetails;
    const frags = (details?.fragments || []) as FragLike[];
    if (!frags.length) {
      showHint('分片信息未就绪，稍后再试');
      return;
    }
    const t = art.currentTime;
    const group = findGroupAt(frags, t);
    let target: { start: number; end: number; frags: FragLike[]; whole: boolean };
    if (group) {
      target = { start: group.start, end: group.end, frags: group.frags, whole: true };
    } else {
      // 降级：整集一组（无 DISCONTINUITY），只标当前分片
      const frag = frags.find((f) => t >= f.start && t < f.start + f.duration);
      if (!frag) {
        showHint('未定位到当前分段');
        return;
      }
      target = { start: frag.start, end: frag.start + frag.duration, frags: [frag], whole: false };
    }

    // 10s 内再次点击且与上次标记相邻 → 视为扩展（各自入库，跳过区间合并）
    const last = lastMarkRef.current;
    const extending = !!(last && Date.now() - last.at < 10_000 && isAdjacentRange(last.range, target));

    const epKey = propsRef.current.episodeKey || currentMediaUrlRef.current;
    const epIndex = Number(epKey.split(':').pop());
    const episodeLabel = Number.isFinite(epIndex) ? `第 ${epIndex + 1} 集` : '';
    const scope = target.whole ? '当前分段' : '当前分片（该源无分段边界）';

    // —— 时间轴剔除：入库后注册分片文件名并重建播放链路（广告从进度条上
    // 消失）；降级形态（单分片）立即跳过本分片。
    if (!target.whole && t >= target.start && t < target.end) {
      art.currentTime = target.end;
    }

    void (async () => {
      try {
        const mark = await addAdMark({
          title: propsRef.current.title,
          episodeKey: epKey,
          episodeLabel,
          start: target.start,
          end: target.end,
          segCount: target.frags.length,
          urls: fragUrlsOf(target.frags),
          wholeGroup: target.whole ? 1 : 0,
          fingerprintCount: 0,
        });
        applyEntries([
          ...adEntriesRef.current.filter((x) => x.markId !== mark.id),
          { id: mark.id, start: target.start, end: target.end, origin: 'mark', removed: target.whole, segCount: target.frags.length, markId: mark.id },
        ]);
        if (target.whole) {
          // 入库完成后再注册剔除并重建：此时集数标记读取必然包含新标记，
          // 重建后时间轴上该分组已被移除，播放从剔除点（原区间起点）继续
          registerStripForPlaylist(currentMediaUrlRef.current, fragUrlsOf(target.frags));
          pendingResumeRef.current = t >= target.end ? t - (target.end - target.start) : t <= target.start ? t : target.start;
          setupHls(art.video, currentMediaUrlRef.current, true);
        } else {
          lastMarkRef.current = { range: { start: target.start, end: target.end }, markId: mark.id, at: Date.now() };
        }
        const learned = await learnMarkFingerprints(mark.id, target.frags);
        showToast(
          `已标记广告 ${formatTime(target.start)}–${formatTime(target.end)}（${scope}${extending ? '，已扩展' : ''}），` +
            (target.whole ? '已从播放进度条中移除' : '本片源今后自动跳过') +
            (learned ? `，已学习 ${learned} 个分片指纹` : ''),
          'success',
          {
            action: {
              label: '撤销',
              onClick: () => {
                void (async () => {
                  if (target.whole) {
                    unregisterStripForPlaylist(currentMediaUrlRef.current, fragUrlsOf(target.frags));
                    pendingResumeRef.current = target.start;
                    setupHls(artRef.current?.video, currentMediaUrlRef.current, true);
                  }
                  await removeAdMark(mark.id);
                  applyEntries(adEntriesRef.current.filter((x) => x.markId !== mark.id));
                  if (lastMarkRef.current?.markId === mark.id) lastMarkRef.current = null;
                })();
              },
            },
          }
        );
      } catch {
        showHint('标记保存失败，请重试');
      }
    })();
  };

  // 片段缓存开启时调大 hls.js 自身缓冲，缓冲之外的空窗由预取器补齐
  const buildHlsConfig = (): Partial<HlsConfig> => {
    const p = propsRef.current;
    const cacheSettings = loadCacheSettings();
    const cacheEnabled = cacheSettings.enabled && !!p.episodeKey;
    return {
      debug: false,
      enableWorker: true,
      backBufferLength: 90,
      maxBufferLength: cacheEnabled ? 120 : 30,
      maxMaxBufferLength: cacheEnabled ? 600 : 60,
      maxBufferSize: (cacheEnabled ? 90 : 30) * 1000 * 1000,
      maxBufferHole: 0.5,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 1000,
      startLevel: -1,
      abrEwmaDefaultEstimate: 500_000,
      appendErrorMaxRetry: 5,
      // 组合 loader：广告过滤（blockAd 随设置）+ 片段缓存命中（cacheEnabled）
      loader: createHlsLoader(Hls, { blockAd: p.adFilter }) as unknown as HlsConfig['loader'],
    };
  };

  // 当前集预取（episodeKey 缺省 = 关闭，见 ensure 内部 settings.enabled 判断）
  const ensurePrefetch = (mediaUrl: string, currentTime: number, horizonSeconds?: number) => {
    const p = propsRef.current;
    if (!p.episodeKey) return;
    getVideoPrefetcher().ensure({
      m3u8Url: mediaUrl,
      currentTime,
      episodeKey: p.episodeKey,
      horizonSeconds,
      onProgress: (stats) => {
        // 当前集预取完成且存在下一集：用独立预取器预热下一集前 7 分钟
        if (stats.state === 'done' && p.nextUrl && p.nextEpisodeKey) {
          getNextEpisodePrefetcher().ensure({
            m3u8Url: p.nextUrl,
            currentTime: 0,
            episodeKey: p.nextEpisodeKey,
            horizonSeconds: 420,
          });
        }
      },
    });
  };

  /**
   * 初始化/切换 HLS。allowProxyFallback：直连致命网络错误（CORS/防盗链/分片被拒）时，
   * 自动改走同源 cookie 鉴权的 /api/proxy 重试一次。
   * 注意：不销毁 ArtPlayer，只销毁并重建 hls，从而保留网页全屏等播放器状态。
   */
  const setupHls = (video: HTMLVideoElement, mediaUrl: string, allowProxyFallback: boolean) => {
    hlsRef.current?.destroy();
    currentMediaUrlRef.current = mediaUrl;
    // 跳过区间/条目按媒体时间轴计，换源（换集/重试/代理回退）后作废；
    // 本集的持久化标记在下方异步读取后恢复为条目
    applyEntries([]);
    const hls = new Hls(buildHlsConfig());
    hlsRef.current = hls;

    hls.attachMedia(video);

    // 先注册该集已标记分组的剔除指令（Dexie 读取，毫秒级）并恢复条目列表，
    // 再拉取播放列表——保证标记的分组在首次交付时就被移除；注册失败降级
    // 为指纹跳过。指纹命中条目（origin=fingerprint）保留合并。
    void (async () => {
      const kept = adEntriesRef.current.filter((e) => e.origin === 'fingerprint');
      try {
        const epKey = propsRef.current.episodeKey;
        if (epKey) {
          const marks = await getMarksForEpisode(epKey);
          const wholeUrls = marks.filter((m) => m.wholeGroup).flatMap((m) => m.urls || []);
          if (wholeUrls.length) registerStripForPlaylist(mediaUrl, wholeUrls);
          const markEntries: FilteredEntry[] = marks.map((m) => ({
            id: m.id,
            start: m.start,
            end: m.end,
            origin: 'mark',
            removed: !!m.wholeGroup,
            segCount: m.segCount,
            markId: m.id,
          }));
          applyEntries([...kept, ...markEntries]);
        } else {
          applyEntries(kept);
        }
      } catch {
        applyEntries(kept); // 注册失败降级为指纹跳过
      }
      hls.loadSource(mediaUrl);
    })();

    hls.on(Hls.Events.MANIFEST_PARSED, async () => {
      recoveryRef.current?.markHealthy();
      // 重建链路的恢复位置（标记时间轴剔除/撤销后的进度校正），优先于
      // 保存进度恢复
      if (pendingResumeRef.current != null) {
        const at = pendingResumeRef.current;
        pendingResumeRef.current = null;
        restoredRef.current = true;
        video.currentTime = at;
        // 预取锚点：恢复目标
        ensurePrefetch(mediaUrl, at);
        video.play().catch(() => {});
        return;
      }
      // 预取锚点：恢复进度时直接取恢复目标。赋值后 video.currentTime 未必立刻反映
      // （Safari 系），而 ensure 是以「锚点未变」为前提复用 parsing 中的运行的——
      // 这里读到旧值会把窗口建在片头，且白等一次纠错重建。
      let prefetchAnchor = video.currentTime;
      // 进度恢复（每集一次）：优先 URL position，其次 IndexedDB 记录
      if (!restoredRef.current) {
        restoredRef.current = true;
        try {
          const saved = (await propsRef.current.getRestorePosition?.()) ?? 0;
          const duration = artRef.current?.duration || 0;
          if (saved > 10 && duration > 0 && saved < duration - 2) {
            if (artRef.current) artRef.current.currentTime = saved;
            prefetchAnchor = saved;
            showHint(`已从 ${formatTime(saved)} 继续播放`);
          }
        } catch { /* 忽略恢复失败 */ }
      }
      // 新集立即预取（否则要等 timeupdate 的 30s 节流，起播初期无缓存）
      ensurePrefetch(mediaUrl, prefetchAnchor);
      video.play().catch(() => {});
    });
    // 播放链路恢复（FRAG_LOADED / MANIFEST_PARSED）：静默窗外清零连续失败计数
    hls.on(Hls.Events.FRAG_LOADED, () => recoveryRef.current?.markHealthy());
    // 分片真正进入 MSE buffer 才算媒体恢复：此时视频轨可渲染，错误态可解除
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      mediaHealthyRef.current = true;
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      const recovery = recoveryRef.current;
      if (!recovery) return;
      const decision = recovery.onFatal(data.type, data.details);
      switch (decision.action) {
        case 'ignore':
          break;
        case 'retry': {
          // 前两次重试保留直连；达到退避阈值或清单级错误时升级为代理形式
          // （同源 cookie 鉴权，规避 CORS/防盗链/分片被拒）
          if (
            allowProxyFallback &&
            !mediaUrl.startsWith('/api/proxy') &&
            (decision.attempt >= 2 || data.details === 'manifestLoadError')
          ) {
            showHint('直连失败，改用代理重试...');
            setupHls(video, `/api/proxy?url=${encodeURIComponent(mediaUrl)}`, false);
            return;
          }
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          recovery.schedule(decision.delayMs, () => hls.startLoad());
          break;
        }
        case 'recover-media': {
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          if (decision.swapAudio) hls.swapAudioCodec?.();
          hls.recoverMediaError();
          break;
        }
        case 'switch-source': {
          // 覆盖播放开始后的场景：起播失败走 setError 遮罩；
          // 播放中失败走回调弹换源面板（父级未提供回调时同样 setError）
          const message = `${describeHlsError(data.type, data.details)}：${decision.reason}`;
          if (playbackStartedRef.current) {
            showHint(message);
            propsRef.current.onRequestSwitchSource?.(decision.reason);
          } else {
            setError(`视频加载失败，${message}，请尝试其他视频源`);
          }
          break;
        }
      }
    });
  };

  /** 换集：重置每集状态并切换到新 HLS 源（不重建 ArtPlayer）。 */
  const loadEpisode = (targetUrl: string) => {
    if (!targetUrl) return;
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    lastPrefetchEnsureRef.current = 0;
    recoveryRef.current = new PlaybackRecovery();
    // 换集时清掉上一集的预取窗口，避免带宽被旧集占用
    getVideoPrefetcher().stop();
    setError('');
    setShowPoster(true);
    const art = artRef.current;
    if (!art) return;
    setupHls(art.video, targetUrl, true);
  };

  // —— 创建播放器（仅一次，挂载即创建） ——
  useEffect(() => {
    if (!containerRef.current || !propsRef.current.url) return;
    const initialUrl = propsRef.current.url;

    // 初始化每集状态
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    recoveryRef.current = new PlaybackRecovery();
    endedRef.current = false;

    let lastSave = 0;

    const art = new Artplayer({
      container: containerRef.current,
      url: initialUrl,
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
      // 用户标记广告（第 4 层）：控制条按钮，普通态与全屏均可见
      controls: [
        {
          name: 'mark-ad',
          position: 'right',
          index: 10,
          html: '标记广告',
          tooltip: '标记当前分段为广告，今后自动跳过',
          click: () => markCurrentAd(),
        },
      ],
      customType: {
        m3u8: (video: HTMLVideoElement, mediaUrl: string) => {
          setupHls(video, mediaUrl, true);
        },
      },
    });
    artRef.current = art;

    // 指纹库加载（用户标记学到的分片指纹，loader 命中检测用）
    void ensureFingerprintsLoaded();

    // 指纹命中（loader 广播单分片区间）→ 扩展为所在分组并入跳过列表。
    // findGroupAt 按时间定位（命中分片的 start 落在自身区间内），分组与
    // hls.js 时间轴零偏差；无 DISCONTINUITY 源返回 null 时用原始分片区间。
    const onAdFragment = (e: Event) => {
      const detail = (e as CustomEvent<{ start: number; end: number }>).detail;
      if (!detail || !(detail.end > detail.start)) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const details = (hlsRef.current as any)?.latestLevelDetails;
      const frags = (details?.fragments || []) as FragLike[];
      const group = findGroupAt(frags, detail.start);
      const range = group ? { start: group.start, end: group.end } : detail;
      // 去重：已有条目覆盖该范围（同组多分片重复命中）则跳过
      if (adEntriesRef.current.some((x) => x.start <= range.start + 0.5 && x.end >= range.end - 0.5)) return;
      applyEntries([
        ...adEntriesRef.current,
        {
          id: `fp_${range.start.toFixed(1)}`,
          start: range.start,
          end: range.end,
          origin: 'fingerprint',
          removed: false,
          segCount: group?.frags.length || 1,
        },
      ]);
      // 晚到命中补偿：分片加载+哈希是异步的，区间加入时播放可能刚越过起点
      // （几秒内且非主动 seek）→ 补跳到组尾；越过多或刚 seek 过则视为回看
      const cur = artRef.current;
      const now = cur?.currentTime;
      // 晚到命中补偿：分片加载+哈希异步，区间入列时播放可能刚越过起点——
      // 非「seek 落入」且未越过多（<3s）则补跳到组尾
      if (!cur?.paused && typeof now === 'number' &&
          now >= range.start && now < range.end - 0.25 &&
          now - range.start < 3 && insideBySeekRef.current !== range.start) {
        cur.currentTime = range.end;
      }
    };
    window.addEventListener('libretv:ad-fragment', onAdFragment);

    // 「本集已过滤条目」列表的交互（watch 页渲染，事件回传播放器）：
    // 跳到条目起点；撤销标记（整组剔除的撤销会拉回原播放列表并回原位置）
    const onSeekTo = (e: Event) => {
      const time = (e as CustomEvent<{ time: number }>).detail?.time;
      if (typeof time === 'number' && artRef.current) artRef.current.currentTime = time;
    };
    const onUndoMark = (e: Event) => {
      const markId = (e as CustomEvent<{ markId: string }>).detail?.markId;
      if (!markId) return;
      const entry = adEntriesRef.current.find((x) => x.markId === markId);
      void (async () => {
        const mark = await getAdMark(markId);
        await removeAdMark(markId);
        if (entry?.removed && mark?.urls?.length) {
          unregisterStripForPlaylist(currentMediaUrlRef.current, mark.urls);
          pendingResumeRef.current = entry.start; // 回到被剔除区间的起点
          const art = artRef.current;
          if (art) setupHls(art.video, currentMediaUrlRef.current, true);
        }
        applyEntries(adEntriesRef.current.filter((x) => x.markId !== markId));
      })();
    };
    window.addEventListener('libretv:seek-to', onSeekTo);
    window.addEventListener('libretv:undo-mark', onUndoMark);

    // 兜底跳过守卫（双通道）：rAF 在页面可见时逐帧检查（反应 ≤1 帧）；
    // video:timeupdate 在后台标签页仍以 ~250ms 触发，兜底 rAF 停转的场景。
    // 语义：播放位置处于广告区间内且不是「用户 seek 落入」→ seek 到区间
    // 末尾。seek 落入视为回看意图不弹（否则 ← 回退会被守卫卡死）；
    // 离开该区间后恢复自动跳过。
    const skipAdAt = () => {
      const cur = artRef.current;
      const t = cur?.currentTime;
      if (typeof t !== 'number') return;
      const ranges = adRangesRef.current;
      const flagged = insideBySeekRef.current;
      if (flagged !== null) {
        const fr = ranges.find((r) => r.start === flagged);
        if (!fr || t < fr.start || t >= fr.end - 0.25) insideBySeekRef.current = null; // 已离开，恢复自动跳过
      }
      if (cur.paused) return;
      for (const r of ranges) {
        if (t >= r.start && t < r.end - 0.25) {
          if (insideBySeekRef.current === r.start) return; // 用户 seek 落入，回看意图
          cur.currentTime = r.end;
          return;
        }
      }
    };
    const adGuard = () => {
      skipAdAt();
      requestAnimationFrame(adGuard);
    };
    requestAnimationFrame(adGuard);
    art.on('video:timeupdate', () => skipAdAt());
    art.on('video:seeked', () => {
      // seek 落点在广告区间内 → 标记「seek 落入」，守卫放行（回看意图）
      const t = artRef.current?.currentTime;
      if (typeof t !== 'number') return;
      const r = adRangesRef.current.find((r) => t >= r.start && t < r.end);
      insideBySeekRef.current = r ? r.start : null;
    });

    art.on('video:loadedmetadata', () => {
      // ArtPlayer 运行时支持 title 选项（类型定义未覆盖），用于界面标题展示
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art as any).title = propsRef.current.title;
      } catch { /* 忽略 */ }
    });

    art.on('video:playing', () => {
      playbackStartedRef.current = true;
      setShowPoster(false);
      // 仅在媒体真正恢复（有分片进入 buffer）后清错误遮罩：
      // 否则「视频轨挂了、音频轨先播出来」时会清掉遮罩，留下黑屏假死态
      if (mediaHealthyRef.current) setError('');
    });
    art.on('video:error', () => {
      mediaHealthyRef.current = false;
      // 起播阶段的 video 元素级错误（MSE/解码偶发失败）：重建一次播放链路自愈，
      // 而不是直接钉死错误遮罩——重建后视频轨重新 append，黑屏有声即可解除
      if (!playbackStartedRef.current && !videoErrorRetryUsedRef.current) {
        videoErrorRetryUsedRef.current = true;
        showHint('播放异常，正在重试...');
        setupHls(art.video, currentMediaUrlRef.current, true);
        return;
      }
      setError('视频播放失败，请尝试其他视频源');
    });
    art.on('video:timeupdate', () => {
      const now = Date.now();
      if (now - lastSave > 5000) {
        lastSave = now;
        propsRef.current.onTimeUpdate?.(art.currentTime, art.duration);
      }
      // 每 30s 续跑一次前向预取窗口（ensure 幂等，窗口未覆盖足够余量才会重建）
      if (now - lastPrefetchEnsureRef.current > 30_000) {
        lastPrefetchEnsureRef.current = now;
        // 用 currentMediaUrlRef（代理回退后的实际地址）：否则预取的 key 与
        // loader 读取的 key 不一致，缓存永不命中且直连 fetch 白耗流量
        ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
      }
    });
    art.on('video:seeked', () => {
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
    });
    art.on('video:pause', () => {
      propsRef.current.onPause?.(art.currentTime, art.duration);
      // 暂停 = 预取黄金窗口：解除限速并无限铺满整集（用户主动行为，带宽占用可接受）
      // waiting 触发的限速在此解除，否则黄金窗口会被 500ms 轮询冻结
      getVideoPrefetcher().setThrottled(false);
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime, 0);
    });
    art.on('video:waiting', () => {
      // 卡顿：预取临时让出带宽给播放
      getVideoPrefetcher().setThrottled(true);
    });
    art.on('video:playing', () => {
      getVideoPrefetcher().setThrottled(false);
    });
    art.on('video:ended', () => {
      endedRef.current = true;
      propsRef.current.onEnded?.();
    });

    // —— 键盘快捷键（旧版 hotkey:false + 自定义逻辑的移植） ——
    const shortcuts = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // e.target 可能是 document 等非元素对象（程序化派发事件/无聚焦元素），
      // 其上没有 closest，直接短路放行
      if (!target || typeof target.closest !== 'function') return;
      // 输入框或按钮获得焦点时不劫持按键：否则空格会吞掉按钮的默认激活
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('button')) return;
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
      // 已有触控在处理时忽略新手指：否则第二指会把 originalRate 捕获成 3.0，
      // 松手后倍速永久卡在 3x；旧定时器句柄也会被覆盖成无法清除的幽灵触发
      if (isLongPress || longPressTimer) return;
      // 控制栏 / 设置面板上的长按不触发倍速（按住进度条拖动、长按倍速菜单项会误触）
      if ((e.target as HTMLElement).closest?.('.art-controls, .art-settings')) return;
      originalRate = art.video.playbackRate;
      longPressTimer = setTimeout(() => {
        if (art.video?.paused) return;
        art.video.playbackRate = 3.0;
        isLongPress = true;
        showHint('3 倍速');
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
    // ArtPlayer 的 contextmenu 组件只在桌面端初始化（移动端构造函数里跳过 init），
    // 长按倍速因而会连带呼出系统原生菜单/气泡。播放器表面没有可用的原生菜单，统一抑制
    const onContextMenu = (e: Event) => e.preventDefault();
    el?.addEventListener('touchstart', onTouchStart, { passive: false });
    el?.addEventListener('touchend', onTouchEnd);
    el?.addEventListener('touchcancel', onTouchEnd);
    el?.addEventListener('touchmove', onTouchMove, { passive: false });
    el?.addEventListener('contextmenu', onContextMenu);

    // 卸载与页面隐藏时保存进度
    const saveOnHide = () => {
      if (document.visibilityState === 'hidden') {
        propsRef.current.onPause?.(art.currentTime, art.duration);
      }
    };
    document.addEventListener('visibilitychange', saveOnHide);

    return () => {
      // 卸载前刷一次最终进度，避免丢失最后几秒。
      // 已自然播完的集数不回写，避免覆盖 onEnded 里清除的「已看完」记录
      if (!endedRef.current) {
        try {
          propsRef.current.onPause?.(art.currentTime, art.duration);
        } catch { /* 忽略 */ }
      }
      document.removeEventListener('keydown', shortcuts);
      document.removeEventListener('visibilitychange', saveOnHide);
      window.removeEventListener('libretv:ad-fragment', onAdFragment);
      window.removeEventListener('libretv:seek-to', onSeekTo);
      window.removeEventListener('libretv:undo-mark', onUndoMark);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      el?.removeEventListener('touchstart', onTouchStart);
      el?.removeEventListener('touchend', onTouchEnd);
      el?.removeEventListener('touchcancel', onTouchEnd);
      el?.removeEventListener('touchmove', onTouchMove);
      el?.removeEventListener('contextmenu', onContextMenu);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      recoveryRef.current?.dispose();
      getVideoPrefetcher().stop();
      art.destroy();
      artRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 换集：仅切换 HLS 源，不重建播放器（保留网页全屏等状态） ——
  const firstUrlRef = useRef(true);
  useEffect(() => {
    // 挂载时的首次由创建 effect 的 customType 触发，跳过避免重复加载
    if (firstUrlRef.current) { firstUrlRef.current = false; return; }
    loadEpisode(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // —— 广告过滤开关变化：重建 HLS loader（无需重建整个播放器） ——
  const firstAdFilterRef = useRef(true);
  useEffect(() => {
    if (firstAdFilterRef.current) { firstAdFilterRef.current = false; return; }
    if (artRef.current && hlsRef.current) {
      // 用当前实际媒体地址：代理回退生效时切广告过滤不应跳回直连形式
      loadEpisode(currentMediaUrlRef.current || propsRef.current.url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adFilter]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" style={{ WebkitTouchCallout: 'none' }} />
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
          <p className="text-danger text-sm">{error}</p>
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
