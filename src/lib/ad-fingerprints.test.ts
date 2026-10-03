import { describe, expect, it, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  upsertAdFingerprints,
  getAdFingerprintsByHost,
  getAllAdFingerprints,
  removeAdFingerprint,
  clearAdFingerprintsByHost,
  touchAdFingerprints,
  exportAdRules,
  validateAdRuleEntry,
  type AdFingerprintInput,
} from './ad-fingerprints';
import { getActiveFingerprintCount } from './ad-detect';

// db.ts 顶层 new Dexie('libretv')：fake-indexeddb/auto 必须先于本模块链加载，
// import 顺序由上方 `import 'fake-indexeddb/auto'` 保证

function entry(overrides: Partial<AdFingerprintInput> & { host: string; signature: string }): AdFingerprintInput {
  return { groupSeconds: 19.1, origin: 'user-mark', ...overrides };
}

describe('ad-fingerprints（Dexie 指纹库）', () => {
  beforeEach(async () => {
    await dbClear();
  });

  async function dbClear() {
    await (await import('./db')).db.adFingerprints.clear();
  }

  it('入库后按 host 查询，id 为 host:signature', async () => {
    await upsertAdFingerprints([
      entry({ host: 'api.example.com', signature: '5.567|2.933|5.700' }),
      entry({ host: 'api.example.com', signature: '3.333|1.533' }),
      entry({ host: 'other.example.com', signature: '5.567|2.933|5.700' }),
    ]);
    const rows = await getAdFingerprintsByHost('api.example.com');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['api.example.com:3.333|1.533', 'api.example.com:5.567|2.933|5.700']);
  });

  it('合并优先级：高优先级 origin 可升级，低优先级不降级不覆盖', async () => {
    await upsertAdFingerprints([entry({ host: 'h', signature: 'a|b', origin: 'user-mark' })]);
    await upsertAdFingerprints([entry({ host: 'h', signature: 'a|b', origin: 'subscription' })]);
    let rows = await getAllAdFingerprints();
    expect(rows[0].origin).toBe('user-mark');

    await upsertAdFingerprints([entry({ host: 'h', signature: 'a|b', origin: 'cross-episode' })]);
    rows = await getAllAdFingerprints();
    // user-mark 优先级高于 cross-episode，不降级
    expect(rows[0].origin).toBe('user-mark');
    expect(rows[0].hits).toBe(2);
  });

  it('heuristic 可被 cross-episode 升级', async () => {
    await upsertAdFingerprints([entry({ host: 'h', signature: 'a|b', origin: 'heuristic' })]);
    await upsertAdFingerprints([entry({ host: 'h', signature: 'a|b', origin: 'cross-episode' })]);
    const rows = await getAllAdFingerprints();
    expect(rows[0].origin).toBe('cross-episode');
  });

  it('refreshActiveFingerprints 把库中签名同步进内存活跃表；删除后同步移除', async () => {
    await upsertAdFingerprints([entry({ host: 'h', signature: 'x|y' })]);
    expect(getActiveFingerprintCount()).toBe(1);
    const rows = await getAllAdFingerprints();
    await removeAdFingerprint(rows[0].id);
    expect(getActiveFingerprintCount()).toBe(0);
  });

  it('touch 命中计数；单条删除与按源清空', async () => {
    await upsertAdFingerprints([entry({ host: 'h', signature: 'x|y' })]);
    await touchAdFingerprints('h', ['x|y']);
    await touchAdFingerprints('h', ['not-exist']); // 静默忽略
    let rows = await getAllAdFingerprints();
    expect(rows[0].hits).toBe(1); // 入库 hits=0，touch 一次 → 1
    await removeAdFingerprint(rows[0].id);
    expect(await getAllAdFingerprints()).toHaveLength(0);

    await upsertAdFingerprints([entry({ host: 'h', signature: 'x|y' }), entry({ host: 'h2', signature: 'x|y' })]);
    await clearAdFingerprintsByHost('h');
    rows = await getAllAdFingerprints();
    expect(rows.map((r) => r.host)).toEqual(['h2']);
  });

  it('导出只含确定性来源（user-mark / cross-episode），subscription 不转传', async () => {
    await upsertAdFingerprints([
      entry({ host: 'h', signature: 'a|b', origin: 'user-mark' }),
      entry({ host: 'h', signature: 'c|d', origin: 'cross-episode' }),
      entry({ host: 'h', signature: 'e|f', origin: 'subscription' }),
      entry({ host: 'h', signature: 'g|h', origin: 'heuristic' }),
    ]);
    const exported = await exportAdRules();
    expect(exported.version).toBe(1);
    expect(exported.entries.map((e) => e.signature).sort()).toEqual(['a|b', 'c|d']);
  });

  it('validateAdRuleEntry：合法条目通过；等长签名 / 非法 token / 超长 / 坏 host 拒绝', () => {
    // 校验器只做线格式校验（origin 由入库层强制为 subscription）
    expect(validateAdRuleEntry({ host: 'caiji.dyttzyapi.com', signature: '5.567|2.933|5.700', groupSeconds: 19.1 })).toMatchObject({
      host: 'caiji.dyttzyapi.com',
      signature: '5.567|2.933|5.700',
    });
    // 等长签名 = 封装节奏
    expect(validateAdRuleEntry({ host: 'h.com', signature: '4.171|4.171|4.171|4.171|4.171' })).toBeUndefined();
    // 单 token（GOP 整数值巧合风险）
    expect(validateAdRuleEntry({ host: 'h.com', signature: '4.004' })).toBeUndefined();
    // 非法 token
    expect(validateAdRuleEntry({ host: 'h.com', signature: 'abc|def' })).toBeUndefined();
    expect(validateAdRuleEntry({ host: 'h.com', signature: '1|2|<script>' })).toBeUndefined();
    // 超长
    expect(validateAdRuleEntry({ host: 'h.com', signature: '1.5|'.repeat(100) })).toBeUndefined();
    // 坏 host
    expect(validateAdRuleEntry({ host: '', signature: '1.5|2.5' })).toBeUndefined();
    expect(validateAdRuleEntry({ host: 'http://x.com', signature: '1.5|2.5' })).toBeUndefined();
    expect(validateAdRuleEntry(null)).toBeUndefined();
    expect(validateAdRuleEntry('string')).toBeUndefined();
  });
});
