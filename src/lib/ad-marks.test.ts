import { describe, expect, it } from 'vitest';
import { findGroupAt, findGroupAround, mergeRanges, isAdjacentRange, type FragLike } from './ad-marks';

/** 三组结构：cc0×3 片（0-12s）、cc1×2 片（12-20s）、cc2×3 片（20-32s） */
function frags(): FragLike[] {
  const out: FragLike[] = [];
  let t = 0;
  const push = (cc: number, dur: number) => {
    out.push({ cc, start: t, duration: dur, url: `https://cdn.example.com/g${cc}_${t}.ts` });
    t += dur;
  };
  push(0, 4); push(0, 4); push(0, 4);
  push(1, 4); push(1, 4);
  push(2, 4); push(2, 4); push(2, 4);
  return out;
}

describe('findGroupAt（按 cc 定位标记所在的 DISCONTINUITY 分组）', () => {
  it('命中各组内部时刻 → 返回所在分组的完整范围与分片', () => {
    const fs = frags();
    expect(findGroupAt(fs, 6)).toEqual({ frags: fs.slice(0, 3), start: 0, end: 12 });
    expect(findGroupAt(fs, 14)).toEqual({ frags: fs.slice(3, 5), start: 12, end: 20 });
    expect(findGroupAt(fs, 31.9)).toEqual({ frags: fs.slice(5, 8), start: 20, end: 32 });
  });

  it('组边界时刻归入后一组（t >= start 且 t < end）', () => {
    const fs = frags();
    expect(findGroupAt(fs, 12)?.frags[0].cc).toBe(1);
    expect(findGroupAt(fs, 20)?.frags[0].cc).toBe(2);
  });

  it('超出已知分片范围返回 null', () => {
    expect(findGroupAt(frags(), 100)).toBeNull();
  });

  it('整集一组（源无 DISCONTINUITY）返回 null → 触发单分片降级', () => {
    const single: FragLike[] = [
      { cc: 0, start: 0, duration: 10, url: 'a.ts' },
      { cc: 0, start: 10, duration: 10, url: 'b.ts' },
    ];
    expect(findGroupAt(single, 12)).toBeNull();
  });
});

describe('findGroupAround（指纹命中分片 → 所在分组整组跳过）', () => {
  it('命中分组内任一分片都返回整组', () => {
    const fs = frags();
    expect(findGroupAround(fs, fs[4])).toEqual({ frags: fs.slice(3, 5), start: 12, end: 20 });
  });

  it('无 DISCONTINUITY 时返回 null', () => {
    const single: FragLike[] = [
      { cc: 0, start: 0, duration: 10, url: 'a.ts' },
      { cc: 0, start: 10, duration: 10, url: 'b.ts' },
    ];
    expect(findGroupAround(single, single[1])).toBeNull();
  });
});

describe('mergeRanges（跳过区间合并）', () => {
  it('相邻（间隙 <1s）/重叠区间合并，无效区间丢弃，结果有序', () => {
    expect(mergeRanges([
      { start: 20, end: 32 },
      { start: 0, end: 12 },
      { start: 12.5, end: 20 },
      { start: 100, end: 90 },
    ])).toEqual([{ start: 0, end: 32 }]);
  });

  it('间隙 ≥1s 的区间保持独立', () => {
    expect(mergeRanges([
      { start: 0, end: 12 },
      { start: 13, end: 20 },
    ])).toEqual([
      { start: 0, end: 12 },
      { start: 13, end: 20 },
    ]);
  });
});

describe('isAdjacentRange（扩展判定）', () => {
  it('首尾相接（间隙 <2s）为相邻', () => {
    expect(isAdjacentRange({ start: 0, end: 12 }, { start: 13, end: 20 })).toBe(true);
    expect(isAdjacentRange({ start: 12, end: 20 }, { start: 0, end: 12 })).toBe(true);
  });
  it('间隙 ≥2s 不算相邻', () => {
    expect(isAdjacentRange({ start: 0, end: 12 }, { start: 15, end: 20 })).toBe(false);
  });
});
