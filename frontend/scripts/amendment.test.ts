import 'fake-indexeddb/auto';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { IDBPDatabase } from 'idb';
import { getDb, makeId, nowIso, openAppDb, STORE_NAMES, DB_VERSION, DB_NAME } from '../src/utils/db';
import {
  AmendmentError,
  bothConfirmed,
  confirmAmendment,
  createAmendment,
  markApplied,
  withdrawAmendment
} from '../src/utils/amendmentMachine';
import { registerAmendmentTx, respondAmendmentTx, serializeForInstance } from '../src/utils/amendmentTx';
import { Amendment, AmendmentStatus } from '../src/types/amendment';
import { ContractParty, ContractStatus } from '../src/types/enums';
import { ContractInstance } from '../src/types/contract-instance';
import { Version } from '../src/types/version';

const NOW = '2026-09-16T08:00:00.000Z';
const V1_HTML = '<p>v1 正文</p>';
const V2_HTML = '<p>v2 正文（变更后）</p>';

// 测试结束后关闭所有数据库连接，避免 fake-indexeddb 句柄让事件循环挂住
after(async () => {
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  const db = await getDb();
  db.close();
});

function signedInstance(id = makeId('inst')): ContractInstance {
  return {
    id,
    templateId: 'tpl_x',
    title: '测试合同',
    variableValues: { a: '1' },
    finalHtml: V1_HTML,
    status: ContractStatus.Signed,
    versionIds: [],
    createdAt: NOW,
    updatedAt: NOW
  };
}

async function resetDb() {
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('contract-template-editor');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('deleteDatabase 被阻塞'));
  });
}

const openDbs: IDBPDatabase[] = [];

async function openFreshDb(version?: number): Promise<IDBPDatabase> {
  // 通过动态 import 重新拿一份干净模块成本高；这里直接用 openDB 复刻 schema
  const { openDB } = await import('idb');
  const db = await openDB('contract-template-editor', version ?? DB_VERSION, {
    upgrade(db, oldVersion, _n, transaction) {
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          if (name === 'versions' || name === 'amendments') {
            store.createIndex('byInstance', 'contractInstanceId');
          }
        }
      }
      if (oldVersion > 0 && oldVersion < 2 && db.objectStoreNames.contains('versions')) {
        const versions = transaction.objectStore('versions');
        if (!versions.indexNames.contains('byInstance')) {
          versions.createIndex('byInstance', 'contractInstanceId');
        }
      }
    }
  });
  openDbs.push(db);
  return db;
}

async function seedSignedContract(db: IDBPDatabase, instance?: ContractInstance) {
  const inst = instance ?? signedInstance();
  await db.put('instances', inst);
  return inst;
}

// ---------- 纯函数状态机 ----------

test('状态机：登记后停在待确认，原合同不受影响', () => {
  const amd = createAmendment({
    id: 'amd_1',
    contractInstanceId: 'inst_1',
    content: { title: 't', reason: 'r', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA,
    now: NOW
  });
  assert.equal(amd.status, AmendmentStatus.Pending);
  assert.deepEqual(amd.confirmedParties, []);
  assert.equal(bothConfirmed(amd), false);
});

test('状态机：同一方重复确认幂等，不产生新效果', () => {
  let amd = createAmendment({
    id: 'amd_1',
    contractInstanceId: 'inst_1',
    content: { title: 't', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA,
    now: NOW
  });
  const first = confirmAmendment(amd, ContractParty.PartyA, NOW);
  assert.equal(first.ready, false);
  assert.deepEqual(first.amendment.confirmedParties, [ContractParty.PartyA]);

  const second = confirmAmendment(first.amendment, ContractParty.PartyA, NOW);
  assert.equal(second.ignored, true);
  assert.equal(second.ready, false);
  assert.deepEqual(second.amendment.confirmedParties, [ContractParty.PartyA]);
  amd = second.amendment;

  // 另一方确认一次即齐备
  const third = confirmAmendment(amd, ContractParty.PartyB, NOW);
  assert.equal(third.ready, true);
  assert.equal(third.ignored, false);
});

test('状态机：任一方撤回整条失效，终态后确认/撤回被拒绝', () => {
  let amd = createAmendment({
    id: 'amd_1',
    contractInstanceId: 'inst_1',
    content: { title: 't', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA,
    now: NOW
  });
  amd = confirmAmendment(amd, ContractParty.PartyA, NOW).amendment;
  amd = withdrawAmendment(amd, ContractParty.PartyB, NOW);
  assert.equal(amd.status, AmendmentStatus.Withdrawn);
  assert.equal(amd.withdrawnBy, ContractParty.PartyB);

  assert.throws(() => confirmAmendment(amd, ContractParty.PartyB, NOW), AmendmentError);
  // 重复撤回保持幂等
  assert.equal(withdrawAmendment(amd, ContractParty.PartyA, NOW).status, AmendmentStatus.Withdrawn);
});

test('状态机：已生效变更不能撤回', () => {
  let amd = createAmendment({
    id: 'amd_1',
    contractInstanceId: 'inst_1',
    content: { title: 't', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA,
    now: NOW
  });
  amd = confirmAmendment(amd, ContractParty.PartyA, NOW).amendment;
  amd = confirmAmendment(amd, ContractParty.PartyB, NOW).amendment;
  amd = markApplied(amd, 'ver_2', 1, NOW);
  assert.equal(amd.status, AmendmentStatus.Applied);
  assert.throws(() => withdrawAmendment(amd, ContractParty.PartyA, NOW), AmendmentError);
});

// ---------- 真实 IndexedDB 事务 ----------

test('事务：登记仅已签署合同允许，登记时不动正文/版本', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);

  const amd = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: '变更1', reason: '协商', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA
  });
  assert.equal(amd.status, AmendmentStatus.Pending);

  const instAfter = (await db.get('instances', inst.id)) as ContractInstance;
  assert.equal(instAfter.finalHtml, V1_HTML);
  assert.deepEqual(await db.getAll('versions'), []);

  // 非已签署合同不能登记
  const draft = signedInstance();
  draft.status = ContractStatus.Draft;
  await db.put('instances', draft);
  await assert.rejects(
    registerAmendmentTx(db, {
      contractInstanceId: draft.id,
      content: { title: 'x', reason: '', proposedHtml: V2_HTML },
      proposedBy: ContractParty.PartyA
    }),
    AmendmentError
  );

  // 同一合同已有待确认变更时不能再登记（唯一入口 = 单条在途）
  await assert.rejects(
    registerAmendmentTx(db, {
      contractInstanceId: inst.id,
      content: { title: '变更2', reason: '', proposedHtml: V2_HTML },
      proposedBy: ContractParty.PartyB
    }),
    AmendmentError
  );
});

test('事务：双方确认同事务生成新版本、替换正文、推进变更记录', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const amd = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: '变更1', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA
  });

  const afterA = await respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyA, action: 'confirm' });
  assert.equal(afterA.applied, false);
  assert.equal((await db.get('instances', inst.id)).finalHtml, V1_HTML, '单方确认后正文不变');
  assert.deepEqual(await db.getAll('versions'), [], '单方确认不生成版本');

  const afterB = await respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyB, action: 'confirm' });
  assert.equal(afterB.applied, true);

  const instAfter = (await db.get('instances', inst.id)) as ContractInstance;
  const versions = (await db.getAll('versions')) as Version[];
  const amdAfter = (await db.get('amendments', amd.id)) as Amendment;

  assert.equal(instAfter.finalHtml, V2_HTML, '正文替换');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].versionNo, 1);
  assert.equal(versions[0].contentSnapshot, V2_HTML);
  assert.equal(instAfter.versionIds.includes(versions[0].id), true);
  assert.equal(amdAfter.status, AmendmentStatus.Applied);
  assert.equal(amdAfter.appliedVersionId, versions[0].id);
});

test('事务：同一方重复确认不重复生效（不产生版本）', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const amd = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: '变更1', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA
  });

  await respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyA, action: 'confirm' });
  const repeat = await respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyA, action: 'confirm' });
  assert.equal(repeat.applied, false);
  assert.equal(repeat.amendment.confirmedParties.length, 1);
  assert.deepEqual(await db.getAll('versions'), []);
  assert.equal((await db.get('instances', inst.id)).finalHtml, V1_HTML);

  // 终态后确认直接报错
  await respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyB, action: 'confirm' });
  await assert.rejects(
    respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyA, action: 'confirm' }),
    AmendmentError
  );
});

test('事务：任一方撤回整条失效，正文与版本不变', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const amd = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: '变更1', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA
  });
  await respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyA, action: 'confirm' });
  const withdrawn = await respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyB, action: 'withdraw' });

  assert.equal(withdrawn.amendment.status, AmendmentStatus.Withdrawn);
  assert.equal((await db.get('instances', inst.id)).finalHtml, V1_HTML);
  assert.deepEqual(await db.getAll('versions'), []);
  const amdAfter = await db.get('amendments', amd.id);
  assert.equal(amdAfter.status, 'withdrawn');

  // 撤回后再确认无效
  await assert.rejects(
    respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyB, action: 'confirm' }),
    AmendmentError
  );
});

test('并发：确认与撤回同时到达，只落地一个，状态一致', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const amd = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: '变更1', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA
  });

  // 甲方确认（已登记为甲方发起但未确认）与乙方撤回同时发出
  const [confirmResult, withdrawResult] = await Promise.allSettled([
    respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyA, action: 'confirm' }),
    respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyB, action: 'withdraw' })
  ]);

  const amdAfter = (await db.get('amendments', amd.id)) as Amendment;
  const versions = await db.getAll('versions');
  const instAfter = (await db.get('instances', inst.id)) as ContractInstance;

  if (amdAfter.status === AmendmentStatus.Withdrawn) {
    // 撤回先落地时，另一方确认必须被拒绝；确认先落地时，撤回随后仍把整条置为失效
    if (confirmResult.status === 'rejected') {
      assert.equal(withdrawResult.status, 'fulfilled');
    }
  }
  // 无论顺序如何，都不能出现「已撤回但正文被替换/版本已生成」
  assert.equal(versions.length, 0);
  assert.equal(instAfter.finalHtml, V1_HTML);
  assert.equal(amdAfter.status, AmendmentStatus.Withdrawn);
});

test('并发：双方确认与撤回赛跑，永远不会出现已撤回却已生效', async () => {
  await resetDb();
  const db = await openFreshDb();

  for (let round = 0; round < 8; round++) {
    const inst = await seedSignedContract(db, signedInstance(`inst_race_${round}`));
    const amd = await registerAmendmentTx(db, {
      contractInstanceId: inst.id,
      content: { title: 't', reason: '', proposedHtml: V2_HTML },
      proposedBy: ContractParty.PartyA
    });

    await Promise.allSettled([
      respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyA, action: 'confirm' }),
      respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyB, action: 'confirm' }),
      respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyA, action: 'withdraw' })
    ]);

    const amdAfter = (await db.get('amendments', amd.id)) as Amendment;
    const versions = (await db.getAllFromIndex('versions', 'byInstance', inst.id)) as Version[];
    const instAfter = (await db.get('instances', inst.id)) as ContractInstance;

    if (amdAfter.status === AmendmentStatus.Applied) {
      assert.equal(versions.length, 1, '生效必须恰好伴随一个新版本');
      assert.equal(instAfter.finalHtml, V2_HTML);
      assert.equal(amdAfter.appliedVersionId, versions[0].id);
    } else {
      assert.equal(amdAfter.status, AmendmentStatus.Withdrawn);
      assert.equal(versions.length, 0, '撤回后不得有版本');
      assert.equal(instAfter.finalHtml, V1_HTML, '撤回后正文必须保持原样');
    }
  }
});

test('回滚：生成新版本途中失败时，正文/变更记录/版本号一起不变', async () => {
  await resetDb();
  const base = await openFreshDb();
  const inst = await seedSignedContract(base);
  const amd = await registerAmendmentTx(base, {
    contractInstanceId: inst.id,
    content: { title: '变更1', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA
  });
  await respondAmendmentTx(base, { amendmentId: amd.id, party: ContractParty.PartyA, action: 'confirm' });

  // 故障注入：删掉合同实例，使事务内「替换正文」前置读取失败。
  // 该读发生在 versions/amendments 写入之前还是之后都无所谓——同一事务 abort 时全部回滚。
  await base.delete('instances', inst.id);

  await assert.rejects(
    respondAmendmentTx(base, { amendmentId: amd.id, party: ContractParty.PartyB, action: 'confirm' }),
    AmendmentError
  );

  const amdAfter = (await base.get('amendments', amd.id)) as Amendment;
  const versions = await base.getAll('versions');
  assert.equal(amdAfter.status, AmendmentStatus.Pending, '变更记录回滚为待确认');
  assert.deepEqual(amdAfter.confirmedParties, [ContractParty.PartyA], '第二方确认不落库');
  assert.deepEqual(versions, [], '不允许残留版本（版本号不变）');
});

test('回读：事务提交后重新打开数据库，结果一致', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const amd = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: '变更1', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA
  });
  await respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyA, action: 'confirm' });
  await respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyB, action: 'confirm' });
  db.close();

  // 模拟刷新：用全新连接回读
  const reopened = await openFreshDb();
  const instAfter = (await reopened.get('instances', inst.id)) as ContractInstance;
  const versions = (await reopened.getAllFromIndex('versions', 'byInstance', inst.id)) as Version[];
  const amdAfter = (await reopened.get('amendments', amd.id)) as Amendment;

  assert.equal(instAfter.finalHtml, V2_HTML);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].versionNo, 1);
  assert.equal(amdAfter.status, AmendmentStatus.Applied);
  assert.equal(instAfter.versionIds[0], versions[0].id);
});

test('版本号：在已有 v1 基础上生效，新版本号严格递增且同事务', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = signedInstance();
  inst.versionIds = ['ver_existing'];
  await db.put('instances', inst);
  await db.put('versions', {
    id: 'ver_existing',
    contractInstanceId: inst.id,
    versionNo: 1,
    contentSnapshot: V1_HTML,
    variableSnapshot: {},
    createdAt: NOW,
    remark: 'v1'
  } satisfies Version);

  const amd = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: '变更1', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA
  });
  await respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyA, action: 'confirm' });
  const outcome = await respondAmendmentTx(db, { amendmentId: amd.id, party: ContractParty.PartyB, action: 'confirm' });
  assert.equal(outcome.version?.versionNo, 2);
  const versions = (await db.getAllFromIndex('versions', 'byInstance', inst.id)) as Version[];
  assert.deepEqual(versions.map((v) => v.versionNo).sort(), [1, 2]);
});

test('串行锁：同合同动作按提交顺序执行且锁自动释放', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);

  const order: number[] = [];
  const tasks = Array.from({ length: 6 }, (_, i) =>
    serializeForInstance(inst.id, async () => {
      order.push(i);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return i;
    })
  );
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
});

test('迁移：v1 老库升级到 v2 后旧数据保留、索引与 amendments 可用', async () => {
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('deleteDatabase 被阻塞'));
  });

  const { openDB } = await import('idb');
  // 构造一个只含 v1 四个 store 的老库并写入数据
  const oldDb = await openDB(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore('templates', { keyPath: 'id' });
      db.createObjectStore('clauses', { keyPath: 'id' });
      db.createObjectStore('instances', { keyPath: 'id' });
      db.createObjectStore('versions', { keyPath: 'id' });
    }
  });
  await oldDb.put('instances', signedInstance('inst_legacy'));
  await oldDb.put('versions', {
    id: 'ver_legacy',
    contractInstanceId: 'inst_legacy',
    versionNo: 1,
    contentSnapshot: V1_HTML,
    variableSnapshot: {},
    createdAt: NOW,
    remark: '老版本'
  } satisfies Version);
  oldDb.close();

  // 走应用真实升级路径
  const migrated = await openAppDb();
  openDbs.push(migrated);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.objectStoreNames.contains('amendments'), true);
  const inspectTx = migrated.transaction('versions', 'readonly');
  assert.equal(inspectTx.objectStore('versions').indexNames.contains('byInstance'), true);
  await inspectTx.done;

  // 旧数据保留且新索引可用
  const legacyInst = await migrated.get('instances', 'inst_legacy');
  assert.equal((legacyInst as ContractInstance).finalHtml, V1_HTML);
  const legacyVersions = await migrated.getAllFromIndex('versions', 'byInstance', 'inst_legacy');
  assert.equal(legacyVersions.length, 1);

  // 升级后可以正常走完整变更流程
  const amd = await registerAmendmentTx(migrated, {
    contractInstanceId: 'inst_legacy',
    content: { title: '迁移后变更', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA
  });
  await respondAmendmentTx(migrated, { amendmentId: amd.id, party: ContractParty.PartyA, action: 'confirm' });
  const outcome = await respondAmendmentTx(migrated, { amendmentId: amd.id, party: ContractParty.PartyB, action: 'confirm' });
  assert.equal(outcome.applied, true);
  // 版本号在老库 v1 基础上递增为 2，而不是从 1 重新开始
  assert.equal(outcome.version?.versionNo, 2);
});

test('getDb 单例：v2 schema 升级后可直接读到 amendments 与索引', async () => {
  await resetDb();
  const db = await getDb();
  assert.equal(db.version, DB_VERSION);
  assert.equal(db.objectStoreNames.contains('amendments'), true);
  const tx = db.transaction('versions', 'readonly');
  assert.equal(tx.objectStore('versions').indexNames.contains('byInstance'), true);
  await tx.done;
});
