'use client';

import type { FilteredEntry } from '@/lib/ad-marks';

/**
 * 「本集已过滤条目」列表（渲染在播放器下方，数据由 PlayerShell 上报）。
 * 交互通过页面事件回到 PlayerShell：libretv:seek-to（跳转）、
 * libretv:undo-mark（撤销标记——整组剔除的撤销会拉回原播放列表并回原位置）。
 * 独立成轻量组件：不引入 artplayer/hls.js，播放页首屏不被拖重。
 */
export function AdFilteredList({ entries }: { entries: FilteredEntry[] }) {
  if (!entries.length) return null;
  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };
  return (
    <div className="mt-2 rounded-md bg-chip/60 px-3 py-2 text-xs">
      <div className="text-faint mb-1.5">本集已过滤 {entries.length} 段广告</div>
      <ol className="space-y-1">
        {entries.map((e, i) => (
          <li key={e.id} className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className="text-content hover:text-primary transition-colors"
              title={e.removed ? '该分段已从进度条移除，跳到移除点' : '跳到此处'}
              onClick={() =>
                window.dispatchEvent(new CustomEvent('libretv:seek-to', { detail: { time: e.start } }))
              }
            >
              {i + 1}. {fmt(e.start)}–{fmt(e.end)}
            </button>
            <span className="text-faint">
              {e.origin === 'mark' ? '我的标记' : '指纹命中'}
              {e.removed ? ' · 已从进度条移除' : ''}
              {` · ${e.segCount} 个分片`}
            </span>
            {e.origin === 'mark' && e.markId && (
              <button
                type="button"
                className="text-danger hover:underline"
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
