import type { FragLike } from './ad-marks';

/**
 * 用户标记的时间轴剔除：把已标记分组的分片从播放列表中移除，使广告从
 * 播放进度条/时间轴上彻底消失（而非播放时跳过）。
 *
 * 工作方式：标记产生时，播放器把标记分组的分片地址按「播放列表 URL →
 * 分片文件名」注册进本表；loader 在交付 level 播放列表文本前查表，命中
 * 则整组移除（stripSegments 纯函数）。hls.js 重新解析后时间轴收短，
 * 进度条上不再存在广告段，seek 行为与普通视频完全一致。
 *
 * 文件名匹配：标记分片的 URL 与播放列表文本行的书写形式可能不同
 * （相对/绝对/代理），但分片文件名（如 `cf33b930….ts`）是全局唯一的
 * 内容标识，按文件名子串匹配对三种形态都成立。
 */

/** 播放列表 URL → 需剔除的分片文件名集合（会话级；每次加载剧集时由播放器重新注册） */
const registry = new Map<string, Set<string>>();

export function registerStripForPlaylist(playlistUrl: string, fragUrls: string[]): void {
  if (!playlistUrl || !fragUrls.length) return;
  const set = registry.get(playlistUrl) || new Set<string>();
  for (const u of fragUrls) {
    const name = basenameOf(u);
    if (name) set.add(name);
  }
  registry.set(playlistUrl, set);
}

/** 撤销剔除：移除指定分片的注册；集合清空时移除该播放列表的条目 */
export function unregisterStripForPlaylist(playlistUrl: string, fragUrls: string[]): void {
  const set = registry.get(playlistUrl);
  if (!set) return;
  for (const u of fragUrls) set.delete(basenameOf(u));
  if (!set.size) registry.delete(playlistUrl);
}

export function getStripForPlaylist(playlistUrl: string): Set<string> {
  const exact = registry.get(playlistUrl);
  if (exact) return exact;
  // master → variant 的 URL 在子目录下（如 …/index.m3u8 → …/3000k/hls/mixed.m3u8），
  // 注册时只知道 loadSource 的地址：按「同源且 key 目录是 ctx 路径前缀」匹配
  try {
    const u = new URL(playlistUrl, 'https://invalid.invalid');
    for (const [key, set] of registry) {
      try {
        const k = new URL(key, 'https://invalid.invalid');
        if (k.origin !== u.origin) continue;
        const kdir = k.pathname.replace(/[^/]*$/, '');
        if (u.pathname.startsWith(kdir)) return set;
      } catch { /* 忽略非法 key */ }
    }
  } catch { /* 忽略 */ }
  return new Set();
}

/** 从分片 URL 提取文件名（路径末段；代理形式 `/api/proxy?url=` 先解出内层目标） */
export function basenameOf(url: string): string {
  try {
    const u = new URL(url, 'https://invalid.invalid');
    const inner = u.searchParams.get('url');
    if (inner) {
      const last = new URL(inner, 'https://invalid.invalid').pathname.split('/').pop();
      if (last) return last;
    }
    return u.pathname.split('/').pop() || '';
  } catch {
    return '';
  }
}

/**
 * 从播放列表文本中整组移除「组内任一分片命中待剔除文件名」的分组。
 * 与既有约定一致：随组删除组前 DISCONTINUITY（避免双标记）、保留组内
 * EXT-X-KEY / EXT-X-MAP（正片可能复用解密/初始化配置）。
 */
export function stripSegments(text: string, basenames: Set<string>): { text: string; changed: boolean } {
  if (!basenames.size || !text) return { text, changed: false };
  const lines = text.split('\n');
  const isDisc = (l: string) => l.trim() === '#EXT-X-DISCONTINUITY';
  const isSegment = (l: string) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#');
  };

  const drop = new Array<boolean>(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!isDisc(lines[i])) {
      i += 1;
      continue;
    }
    let j = i + 1;
    let hit = false;
    while (j < lines.length && !isDisc(lines[j])) {
      if (isSegment(lines[j])) {
        const name = basenameOf(lines[j].trim());
        if (name && basenames.has(name)) hit = true;
      }
      j += 1;
    }
    if (hit) {
      drop[i] = true; // 组前 DISCONTINUITY 随组删除，后续边界保留为正片分段
      for (let k = i + 1; k < j; k++) {
        const t = lines[k].trim();
        if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) continue;
        drop[k] = true;
      }
    }
    i = j;
  }
  if (!drop.some(Boolean)) return { text, changed: false };
  return { text: lines.filter((_, idx) => !drop[idx]).join('\n'), changed: true };
}

/** 收集分组的分片地址（标记时存入标记记录） */
export function fragUrlsOf(frags: FragLike[]): string[] {
  return frags.map((f) => f.url).filter(Boolean);
}
