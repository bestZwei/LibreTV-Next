'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  clearAdFingerprintsByHost,
  exportAdRules,
  getAllAdFingerprints,
  removeAdFingerprint,
} from '@/lib/ad-fingerprints';
import type { AdFingerprintEntry } from '@/lib/db';
import { api } from '@/lib/client-api';
import type { AdRulesPayload } from '@/lib/types';
import { copyToClipboard } from '@/lib/clipboard';
import { useToast } from './toast';
import { Spinner } from './states';
import { ConfirmDialog } from './confirm-dialog';

/**
 * 广告指纹库管理：按源分组的规则列表（来源 / 命中次数）、单条删除、按源清空、
 * 导出与「生成分享链接」。动作分层的展示口径：
 * - user-mark / cross-episode → 删除级（从播放列表移除）；
 * - subscription / heuristic → 跳过级（播放进入区间时自动 seek，可撤销）。
 */

const ORIGIN_LABEL: Record<AdFingerprintEntry['origin'], string> = {
  'user-mark': '手动标记',
  'cross-episode': '跨集确认',
  subscription: '订阅',
  heuristic: '启发式',
};

const ORIGIN_LEVEL: Record<AdFingerprintEntry['origin'], string> = {
  'user-mark': '删除',
  'cross-episode': '删除',
  subscription: '跳过',
  heuristic: '跳过',
};

interface HostGroup {
  host: string;
  entries: AdFingerprintEntry[];
  totalHits: number;
}

export function AdFingerprintsPanel() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<HostGroup[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [clearingHost, setClearingHost] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  const refresh = useCallback(() => {
    void getAllAdFingerprints()
      .then((rows) => {
        const byHost = new Map<string, HostGroup>();
        for (const r of rows) {
          const g = byHost.get(r.host) ?? { host: r.host, entries: [], totalHits: 0 };
          g.entries.push(r);
          g.totalHits += r.hits;
          byHost.set(r.host, g);
        }
        setGroups([...byHost.values()].sort((a, b) => b.entries.length - a.entries.length));
      })
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const totalEntries = useMemo(() => groups.reduce((s, g) => s + g.entries.length, 0), [groups]);

  const downloadExport = async () => {
    const data = await exportAdRules();
    const blob = new Blob([JSON.stringify({ name: 'LibreTV-AdRules', time: new Date().toISOString(), ...data }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `libretv-ad-rules-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`已导出 ${data.entries.length} 条广告标记`);
  };

  const publishShareLink = async () => {
    setPublishing(true);
    try {
      const data = await exportAdRules();
      if (!data.entries.length) {
        toast('还没有可分享的广告标记');
        return;
      }
      const adRules: AdRulesPayload = { version: 1, entries: data.entries, skipped: 0 };
      const res = await api.publishSourceList({ name: 'LibreTV-AdRules', sources: [], liveSources: [], adRules });
      await copyToClipboard(res.url);
      toast('分享链接已复制（内容公开，请仅分享自己的标记）');
    } catch (err) {
      toast(err instanceof Error ? err.message : '发布失败');
    } finally {
      setPublishing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Spinner size="sm" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-faint">
        <span>
          共 {totalEntries} 条规则、{groups.length} 个源
        </span>
        <div className="flex gap-2">
          <button className="btn-ghost text-xs" disabled={totalEntries === 0} onClick={() => void downloadExport()}>
            导出
          </button>
          <button className="btn-ghost text-xs" disabled={totalEntries === 0 || publishing} onClick={() => void publishShareLink()}>
            {publishing ? '发布中...' : '生成分享链接'}
          </button>
        </div>
      </div>

      {groups.length === 0 && (
        <p className="text-xs text-faint">
          暂无标记。播放页的「标记广告」按钮、跨集自动比对与广告订阅都会在这里积累规则。
        </p>
      )}

      {groups.map((g) => (
        <div key={g.host} className="border rounded-lg text-sm">
          <div className="flex items-center justify-between px-3 py-2">
            <button
              className="flex-1 text-left min-w-0"
              onClick={() => setExpanded(expanded === g.host ? null : g.host)}
            >
              <span className="font-medium truncate block">{g.host}</span>
              <span className="text-xs text-faint">
                {g.entries.length} 条 · 累计命中 {g.totalHits} 次
              </span>
            </button>
            <button
              className="btn-ghost text-xs shrink-0 ml-2 text-danger"
              onClick={() => setClearingHost(g.host)}
            >
              清空
            </button>
          </div>
          {expanded === g.host && (
            <ul className="border-t divide-y">
              {g.entries.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
                  <span className="font-mono truncate text-faint" title={e.signature}>
                    {e.signature}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className={e.origin === 'user-mark' || e.origin === 'cross-episode' ? 'text-primary' : 'text-faint'}>
                      {ORIGIN_LABEL[e.origin]}·{ORIGIN_LEVEL[e.origin]}
                    </span>
                    <span className="text-faint">×{e.hits}</span>
                    <button
                      className="text-danger hover:underline"
                      onClick={() => {
                        void removeAdFingerprint(e.id).then(refresh);
                      }}
                    >
                      删除
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      <ConfirmDialog
        open={!!clearingHost}
        title="清空该源的广告标记"
        message={`将删除 ${clearingHost ?? ''} 的全部广告指纹（含手动标记，不可恢复），确认继续？`}
        confirmLabel="清空"
        danger
        onConfirm={() => {
          if (clearingHost) {
            void clearAdFingerprintsByHost(clearingHost).then(() => {
              setClearingHost(null);
              refresh();
            });
          }
        }}
        onCancel={() => setClearingHost(null)}
      />
    </div>
  );
}
