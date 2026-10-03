'use client';

import { api } from './client-api';
import { normalizeSubscriptionUrl } from './source-list';
import { importAdRules, refreshActiveFingerprints } from './ad-fingerprints';
import { useAppStore } from './store';
import { describeParseStats } from './tvbox-parser';
import type { AuthStatusResponse, SubscriptionParseStats } from './types';

/**
 * 数据源订阅同步核心逻辑，供两处复用：
 * - source-manager：用户在设置抽屉中手动添加/重新同步（UI 层加 toast 反馈）；
 * - providers：部署者通过 DEFAULT_SUBSCRIPTIONS 预置的订阅，启动时自动导入与静默重同步。
 *
 * 订阅内容由服务端自动识别格式（LibreTV-SourceList JSON 或 TVBOX 配置 JSON），
 * applySubscriptionSources / applySubscriptionLive 均按订阅前缀整体替换且保留
 * 用户勾选状态，同步失败时不调用即无副作用——旧数据自动保留。
 * 订阅携带的 adRules（他人标记的广告指纹）合并进本地指纹库：
 * 按 host:signature 去重、本地标记优先不覆盖，动作层为「仅跳过」。
 */
export interface SubscriptionSyncResult {
  name?: string;
  vodCount: number;
  liveCount: number;
  /** 本次合并的广告规则条数（无 adRules 时为 0） */
  adRuleCount: number;
  /** 解析统计（识别格式、跳过与截断条目），用于导入结果提示 */
  stats?: SubscriptionParseStats;
}

export async function syncSourceSubscription(rawUrl: string): Promise<SubscriptionSyncResult> {
  // 统一归一化（trim + 去尾斜杠）：与 DEFAULT_SUBSCRIPTIONS 预置地址保持同一形态，
  // 避免同一订阅地址因尾斜杠差异被存成两条订阅
  const url = normalizeSubscriptionUrl(rawUrl);
  try {
    const { name, sources, liveSources, adRules, stats } = await api.fetchSourceList(url);
    let adRuleCount = 0;
    if (adRules?.entries.length) {
      // 合并前先校验过（source-list 解析层），这里强制 subscription 来源入库（跳过级）
      adRuleCount = await importAdRules(adRules.entries);
      await refreshActiveFingerprints();
    }
    if (sources.length === 0 && liveSources.length === 0) {
      if (adRuleCount === 0) throw new Error('订阅内容为空');
      // 纯广告订阅：无源可应用，仅指纹入库
      const store = useAppStore.getState();
      store.addSubscription(url, name);
      store.markSubscriptionSynced(url, name, { vod: 0, live: 0, adRules: adRuleCount });
      return { name, vodCount: 0, liveCount: 0, adRuleCount, stats };
    }
    const store = useAppStore.getState();
    const vodCount = store.applySubscriptionSources(url, sources);
    const liveCount = store.applySubscriptionLive(url, liveSources);
    // 仅对本订阅引用的直播源记录同步时间（多归属：共享源也会被标记为新鲜，
    // 但名称/EPG 由 store 的「首次导入为准、缺失补齐」语义保护，不会被本订阅覆盖）
    const importedLiveUrls = new Set(
      useAppStore.getState().liveSubscriptions
        .filter((s) => s.fromSubscriptions.includes(url))
        .map((s) => s.url)
    );
    for (const s of liveSources) {
      if (importedLiveUrls.has(s.url)) store.markLiveSynced(s.url, s.name, s.epg);
    }
    store.addSubscription(url, name);
    store.markSubscriptionSynced(url, name, { vod: vodCount, live: liveCount, adRules: adRuleCount });
    return { name, vodCount, liveCount, adRuleCount, stats };
  } catch (err) {
    // 记录失败状态供订阅列表展示（首次添加未成功时不产生条目）；已导入的旧数据保持不动
    const message = err instanceof Error ? err.message : '订阅同步失败';
    useAppStore.getState().markSubscriptionFailed(url, message);
    throw err instanceof Error ? err : new Error(message);
  }
}

/** 预置订阅超过该间隔未同步时，启动阶段静默刷新一次 */
const ENV_SUB_RESYNC_MS = 24 * 60 * 60 * 1000;

/**
 * 部署者通过 DEFAULT_SUBSCRIPTIONS 预置的订阅：启动时自动导入与静默刷新。
 *
 * seen 标记（envSubsSeen）仅在同步成功后写入：
 * - 同步成功 → 标记 seen，用户此后删除该订阅不会被自动加回；
 * - 同步失败 → 不标记，下次启动自动重试，已导入的旧数据保持不动。
 * 已存在的订阅超过 24h 未同步时静默刷新（成功过但 seen 机制上线前的旧数据也会借此补标）。
 */
export async function syncEnvSubscriptions(subs: { url: string; name?: string }[]): Promise<void> {
  for (const sub of subs) {
    const store = useAppStore.getState();
    try {
      const existing = store.subscriptions.find((s) => s.url === sub.url);
      let result: SubscriptionSyncResult | undefined;
      if (existing) {
        if (existing.lastSync && Date.now() - existing.lastSync < ENV_SUB_RESYNC_MS) {
          store.markEnvSubsSeen([sub.url]);
          continue;
        }
        result = await syncSourceSubscription(sub.url);
      } else {
        // 已成功过且被用户删除的预置订阅：尊重用户选择，不再加回
        if (store.envSubsSeen.includes(sub.url)) continue;
        result = await syncSourceSubscription(sub.url);
      }
      // 预置订阅对用户是静默的，跳过/截断情况写入控制台供部署者排查（只记计数，不打印配置内容）
      if (result?.stats && result.stats.skipped > 0) {
        console.info('[LibreTV] 预置订阅部分条目未导入：', sub.url, describeParseStats(result.stats));
      }
      useAppStore.getState().markEnvSubsSeen([sub.url]);
    } catch (err) {
      console.warn('[LibreTV] 预置订阅同步失败（下次启动将重试）：', sub.url, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * 应用 /api/status 下发的部署者预置数据（预置点播源 / 预置直播源 / 预置订阅）。
 *
 * 调用点有两处，缺一不可：
 * - Providers 首屏拿到 /api/status 后调用（此时可能尚未登录）；
 * - AuthProvider 登录成功后补调一次——预置订阅要经鉴权接口 /api/source-list 拉取，
 *   首屏那次在登录前会 401 静默失败，不补调则本次会话内不会出现预置订阅。
 *
 * 重复调用是安全的：setEnvSources / setLiveEnvSources 幂等，syncEnvSubscriptions
 * 对已同步（24h 内）的订阅会跳过，对已成功过的订阅也不会重复导入。
 */
export async function applyEnvPresets(status: AuthStatusResponse): Promise<void> {
  if (Array.isArray(status.defaultSources)) {
    useAppStore.getState().setEnvSources(status.defaultSources);
  }
  if (Array.isArray(status.defaultLiveSources)) {
    useAppStore.getState().setLiveEnvSources(status.defaultLiveSources);
  }
  if (Array.isArray(status.defaultSubscriptions) && status.defaultSubscriptions.length > 0) {
    await syncEnvSubscriptions(status.defaultSubscriptions);
  }
  // 部署者通过 DEFAULT_RECOMMEND_SOURCE 指定的推荐数据源默认值：
  // 仅对未主动选择过的用户生效（仍为出厂默认 hot-list 且无「已选择」标记），
  // 已有偏好的用户——包括清缓存前做过选择的——不被覆盖，用户的选择始终优先。
  // 直写 setState 而非 updateSettings：自动预置不算用户主动选择，不打「已选择」标记；
  // 应用后当前值 ≠ hot-list，AuthProvider 的幂等重入天然跳过。
  if (status.defaultRecommendSource) {
    const s = useAppStore.getState();
    if (!s.recommendSourceTouched && s.recommendSource === 'hot-list') {
      useAppStore.setState({ recommendSource: status.defaultRecommendSource });
    }
  }
  // 部署者通过 DEFAULT_IMAGE_MODE 指定的封面图加载方式默认值（未配置时不改动）。
  // 与推荐数据源同一套语义：仅对未主动选择过的用户生效（仍为出厂默认 direct 且无
  // 「已选择」标记），已有偏好的用户——包括 touched 标记上线前手动改过的——不被覆盖；
  // custom 需要手填模板，无论有无标记都视为明确选择，不覆盖。
  // 直写 setState 而非 updateSettings：自动预置不算用户主动选择，不打「已选择」标记。
  if (status.defaultImageMode) {
    const s = useAppStore.getState();
    if (!s.imageProxyModeTouched && s.imageProxyMode === 'direct') {
      useAppStore.setState({ imageProxyMode: status.defaultImageMode });
    }
  }
}
