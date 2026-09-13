'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { ToastProvider } from './toast';
import { AuthProvider } from './auth';
import { ThemeProvider } from './theme';
import { useAppStore, hydrateLiveProbeResults } from '@/lib/store';
import { syncEnvSubscriptions } from '@/lib/subscription-sync';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 60_000 },
        },
      })
  );

  // store 配置了 skipHydration：等挂载后再读 localStorage，
  // 保证 hydration 阶段客户端与服务端渲染结果一致。
  useEffect(() => {
    // 先等持久化状态恢复，再拉服务端下发数据：
    // 避免 setEnvSources/setLiveEnvSources 的勾选合并发生在 rehydrate 之前被覆盖
    Promise.resolve(useAppStore.persist.rehydrate())
      .then(() => {
        // 测活缓存从 IndexedDB 恢复（并顺带搬迁旧 localStorage 快照里的存量），
        // 与下方 /api/status 拉取互不依赖，失败静默
        void hydrateLiveProbeResults();
        // 拉取部署者通过 DEFAULT_SOURCES / DEFAULT_LIVE_SOURCES 预置的源（失败时静默忽略）
        return fetch('/api/status');
      })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.defaultSources)) {
          useAppStore.getState().setEnvSources(d.defaultSources);
        }
        if (d && Array.isArray(d.defaultLiveSources)) {
          useAppStore.getState().setLiveEnvSources(d.defaultLiveSources);
        }
        // 预置订阅（DEFAULT_SUBSCRIPTIONS）：首次自动导入，超 24h 静默刷新，失败下次重试
        if (d && Array.isArray(d.defaultSubscriptions) && d.defaultSubscriptions.length > 0) {
          void syncEnvSubscriptions(d.defaultSubscriptions);
        }
      })
      .catch(() => {});
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
