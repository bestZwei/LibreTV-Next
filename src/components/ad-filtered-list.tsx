'use client';

import type { FilteredEntry } from '@/lib/ad-marks';

/**
 * 「本集已过滤条目」列表（渲染在播放器下方，数据由 PlayerShell 上报）。
 * 每条带画面预览缩略图（PlayerShell 后台生成，标记者持久化、指纹命中实时）。
 * 交互通过页面事件回到 PlayerShell：libretv:seek-to（跳转）、
 * libretv:undo-mark（撤销标记——整组剔除的撤销会拉回原播放列表并回原位置）。
 * 独立成轻量组件：不引入 artplayer/hls.js，播放页首屏不被拖重。
 */
export function AdFilteredList({ entries }: { entries: FilteredEntry[] }) {
  if (!entries.length) {
    return (
      <div className="mt-2 rounded-md bg-chip/40 px-3 py-2 text-xs text-faint">
        本集未过滤广告段——播放到广告时点播放器控制条的「标记广告」，本片源之后自动跳过
      </div>
    );
  }
  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };
  return (
    <div className="mt-2 rounded-md bg-chip/60 px-3 py-2 text-xs">
      <div className="text-faint mb-1.5">本集已过滤 {entries.length} 段广告</div>
      <ol className="space-y-1.5">
        {entries.map((e, i) => (
          <li key={e.id} className="flex items-center gap-2.5">
            {/* 画面预览缩略图：一眼判断是广告还是正片 */}
            {e.thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={e.thumb}
                alt="广告段画面预览"
                className="w-[72px] h-[40px] object-cover rounded shrink-0 cursor-pointer bg-black/60"
                title="点击跳到此处"
                onClick={() => window.dispatchEvent(new CustomEvent('libretv:seek-to', { detail: { time: e.start } }))}
              />
            ) : (
              <button
                type="button"
                className="w-[72px] h-[40px] rounded shrink-0 bg-black/50 text-[10px] text-faint hover:bg-black/70 transition-colors"
                title="点击跳到此处"
                onClick={() => window.dispatchEvent(new CustomEvent('libretv:seek-to', { detail: { time: e.start } }))}
              >
                {fmt(e.start)}
              </button>
            )}
            <div className="min-w-0 flex-1">
              <button
                type="button"
                className="block text-content hover:text-primary transition-colors text-left"
                title="跳到此处"
                onClick={() => window.dispatchEvent(new CustomEvent('libretv:seek-to', { detail: { time: e.start } }))}
              >
                {i + 1}. {fmt(e.start)}–{fmt(e.end)}
              </button>
              <div className="text-faint">
                {e.origin === 'mark' ? '我的标记' : '指纹命中'}
                  {` · ${e.segCount} 个分片`}
              </div>
            </div>
            {e.origin === 'mark' && e.markId && (
              <button
                type="button"
                className="text-danger hover:underline shrink-0"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent('libretv:undo-mark', { detail: { markId: e.markId } }))
                }
              >
                撤销标记
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
