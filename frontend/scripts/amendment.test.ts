import 'fake-indexeddb/auto';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION, getDb, makeId, openAppDb, STORE_NAMES } from '../src/utils/db';
import {
  AmendmentError,
  applyCredentialAction,
  bothConfirmed,
  buildCredentialHashes,
  createAmendment,
  markApplied,
  partyConfirmed
} from '../src/utils/amendmentMachine';
import {
  CredentialVerificationError,
  registerAmendmentTx,
  respondAmendmentTx,
  serializeForInstance
} from '../src/utils/amendmentTx';
import { hashCredential, issueCredentialPair, parseCredentialParty } from '../src/utils/amendmentCredential';
import { Amendment, AmendmentStatus, IssuedCredential } from '../src/types/amendment';
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

const openDbs: IDBPDatabase[] = [];

async function resetDb() {
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('deleteDatabase 被阻塞'));
  });
}

async function openFreshDb(version?: number): Promise<IDBPDatabase> {
  const { openDB } = await import('idb');
  const db = await openDB(DB_NAME, version ?? DB_VERSION, {
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

async function registerHelper(db: IDBPDatabase, inst: ContractInstance) {
  const result = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: '变更1', reason: '协商一致', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA
  });
  const tokenA = result.credentials.find((c) => c.party === ContractParty.PartyA)!.token;
  const tokenB = result.credentials.find((c) => c.party === ContractParty.PartyB)!.token;
  return { amendment: result.amendment, tokenA, tokenB };
}

const confirmA = (db: IDBPDatabase, amendmentId: string, token: string) =>
  respondAmendmentTx(db, { amendmentId, token, action: 'confirm' });
const confirmB = (db: IDBPDatabase, amendmentId: string, token: string) =>
  respondAmendmentTx(db, { amendmentId, token, action: 'confirm' });
const withdraw = (db: IDBPDatabase, amendmentId: string, token: string) =>
  respondAmendmentTx(db, { amendmentId, token, action: 'withdraw' });

// ---------- 凭据工具与纯函数状态机 ----------

test('凭据：甲、乙凭据不同；前缀决定当事方', () => {
  const issued = issueCredentialPair();
  const a = issued.find((c) => c.party === ContractParty.PartyA)!;
  const b = issued.find((c) => c.party === ContractParty.PartyB)!;
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^amd-a_[0-9a-f]{32}$/);
  assert.match(b.token, /^amd-b_[0-9a-f]{32}$/);
  assert.equal(parseCredentialParty(a.token), ContractParty.PartyA);
  assert.equal(parseCredentialParty(b.token), ContractParty.PartyB);
  assert.equal(parseCredentialParty('amd-a_short'), null);
  assert.equal(parseCredentialParty('totally-wrong'), null);
  assert.equal(parseCredentialParty(' amd-b_' + '1'.repeat(32) + ' '), ContractParty.PartyB);
});

test('状态机：登记只落哈希槽，明文不出现在记录里', async () => {
  const issued: IssuedCredential[] = issueCredentialPair();
  const amd = createAmendment({
    id: 'amd_1',
    contractInstanceId: 'inst_1',
    content: { title: 't', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA,
    credentialHashes: await buildCredentialHashes(issued),
    now: NOW
  });

  const serialized = JSON.stringify(amd);
  for (const credential of issued) {
    assert.ok(!serialized.includes(credential.token), '明文凭据不得落库');
    const hash = await hashCredential(credential.token);
    const slot = amd.credentials[credential.party];
    assert.equal(slot.tokenHash, hash);
    assert.equal(slot.used, false);
  }
  assert.equal(bothConfirmed(amd), false);
});

test('状态机：双方各凭各的票确认一次才 ready，票互不通用', async () => {
  const issued = issueCredentialPair();
  let amd = createAmendment({
    id: 'amd_1',
    contractInstanceId: 'inst_1',
    content: { title: 't', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA,
    credentialHashes: await buildCredentialHashes(issued),
    now: NOW
  });

  const r1 = applyCredentialAction(amd, ContractParty.PartyA, 'confirm', NOW);
  assert.equal(r1.ready, false);
  assert.equal(partyConfirmed(r1.amendment, ContractParty.PartyA), true);
  assert.equal(partyConfirmed(r1.amendment, ContractParty.PartyB), false);
  amd = r1.amendment;

  // 状态机层面凭据消费一次后即终态：同方再确认会被状态迁移的一次性前提拦住
  assert.throws(() => applyCredentialAction(amd, ContractParty.PartyA, 'confirm', NOW), AmendmentError);

  const r2 = applyCredentialAction(amd, ContractParty.PartyB, 'confirm', NOW);
  assert.equal(r2.ready, true);
  assert.equal(bothConfirmed(r2.amendment), true);
});

test('状态机：任一方凭票撤回整条失效；终态动作被拒', async () => {
  const issued = issueCredentialPair();
  let amd = createAmendment({
    id: 'amd_1',
    contractInstanceId: 'inst_1',
    content: { title: 't', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA,
    credentialHashes: await buildCredentialHashes(issued),
    now: NOW
  });
  amd = applyCredentialAction(amd, ContractParty.PartyA, 'confirm', NOW).amendment;
  amd = applyCredentialAction(amd, ContractParty.PartyB, 'withdraw', NOW).amendment;
  assert.equal(amd.status, AmendmentStatus.Withdrawn);
  assert.equal(amd.withdrawnBy, ContractParty.PartyB);
  assert.equal(amd.credentials[ContractParty.PartyB].usedFor, 'withdraw');
  assert.throws(() => applyCredentialAction(amd, ContractParty.PartyB, 'confirm', NOW), AmendmentError);
});

test('状态机：双方齐备后才能 markApplied，否则拒绝', async () => {
  const issued = issueCredentialPair();
  let amd = createAmendment({
    id: 'amd_1',
    contractInstanceId: 'inst_1',
    content: { title: 't', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA,
    credentialHashes: await buildCredentialHashes(issued),
    now: NOW
  });
  amd = applyCredentialAction(amd, ContractParty.PartyA, 'confirm', NOW).amendment;

  assert.throws(() => markApplied(amd, 'ver_2', 1, NOW), AmendmentError, '单方确认不能生效');

  amd = applyCredentialAction(amd, ContractParty.PartyB, 'confirm', NOW).amendment;
  const applied = markApplied(amd, 'ver_2', 1, NOW);
  assert.equal(applied.status, AmendmentStatus.Applied);
  assert.equal(applied.appliedVersionId, 'ver_2');
  assert.throws(() => markApplied(applied, 'ver_3', 2, NOW), AmendmentError, '已生效不能重复落位');
});

// ---------- 真实 IndexedDB 事务：登记 ----------

test('事务：登记返回双方一次性凭据；正文/版本不变；明文不进库', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);

  const result = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: '变更1', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA
  });
  assert.equal(result.credentials.length, 2);
  assert.notEqual(result.credentials[0].token, result.credentials[1].token);

  const raw = (await db.get('amendments', result.amendment.id)) as Amendment;
  const rawText = JSON.stringify(raw);
  for (const credential of result.credentials) {
    assert.ok(!rawText.includes(credential.token));
  }
  assert.equal((await db.get('instances', inst.id)).finalHtml, V1_HTML);
  assert.deepEqual(await db.getAll('versions'), []);

  // 非已签署合同不能登记；同一合同在途只能有一条
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
  await assert.rejects(
    registerAmendmentTx(db, {
      contractInstanceId: inst.id,
      content: { title: '变更2', reason: '', proposedHtml: V2_HTML },
      proposedBy: ContractParty.PartyB
    }),
    AmendmentError
  );
});

// ---------- 错票 / 跨变更 / 已用 ----------

test('凭据安全：格式错误、哈希不符、跨变更复用一律拒绝，状态/正文/版本不变', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);

  // 另起一条变更（第二份合同），用于验证「跨变更复用」的独立分类
  const inst2 = await seedSignedContract(db, signedInstance());
  const second = await registerHelper(db, inst2);

  // 输入 → 预期原因码
  const badInputs: Array<[string, string]> = [
    ['not-a-token', 'CREDENTIAL_MALFORMED'],
    [`amd-a_${'0'.repeat(32)}`, 'CREDENTIAL_UNRECOGNIZED'], // 格式合法但全库无此哈希
    [tokenA.slice(0, -1) + (tokenA.endsWith('a') ? 'b' : 'a'), 'CREDENTIAL_UNRECOGNIZED'], // 末位篡改
    [second.tokenA, 'CREDENTIAL_BOUND_ELSEWHERE'], // 命中另一变更
    [tokenB.replace('amd-b_', 'amd-a_'), 'CREDENTIAL_UNRECOGNIZED'] // 换前缀：冒充方槽位无匹配，原哈希也不落在任何甲槽
  ];

  for (const [bad, expected] of badInputs) {
    try {
      await confirmA(db, amendment.id, bad);
      assert.fail(`本应拒绝: ${bad}`);
    } catch (error) {
      assert.ok(error instanceof CredentialVerificationError, `应为凭据校验错误: ${bad}`);
      assert.equal((error as AmendmentError).code, expected, `错票归类: ${bad}`);
    }
  }

  // 全部拒绝后仍停留在待确认、无确认落库
  const amdAfter = (await db.get('amendments', amendment.id)) as Amendment;
  assert.equal(amdAfter.status, AmendmentStatus.Pending);
  assert.equal(amdAfter.credentials[ContractParty.PartyA].used, false);
  assert.equal(amdAfter.credentials[ContractParty.PartyB].used, false);
  assert.equal((await db.get('instances', inst.id)).finalHtml, V1_HTML);
  assert.deepEqual(await db.getAllFromIndex('versions', 'byInstance', inst.id), []);

  // 真实凭据仍然可用，说明拒绝没有污染状态
  const ok = await confirmA(db, amendment.id, tokenA);
  assert.equal(ok.applied, false);
  assert.equal(ok.party, ContractParty.PartyA);
});

test('凭据安全：反查命中另一变更的乙方槽位也判为 BIND_ELSEWHERE，且不影响两条变更', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst1 = await seedSignedContract(db, signedInstance());
  const first = await registerHelper(db, inst1);
  const inst2 = await seedSignedContract(db, signedInstance());
  const second = await registerHelper(db, inst2);

  // 用第二条变更的乙方凭据去操作第一条变更
  const error = await confirmA(db, first.amendment.id, second.tokenB).then(() => null, (e: unknown) => e);
  assert.ok(error instanceof CredentialVerificationError);
  assert.equal((error as AmendmentError).code, 'CREDENTIAL_BOUND_ELSEWHERE');
  assert.match((error as Error).message, /另一条变更/);

  // 两条变更都仍在待确认，且都没有凭据被消耗
  for (const item of [first.amendment, second.amendment]) {
    const record = (await db.get('amendments', item.id)) as Amendment;
    assert.equal(record.status, AmendmentStatus.Pending);
    assert.equal(record.credentials[ContractParty.PartyA].used, false);
    assert.equal(record.credentials[ContractParty.PartyB].used, false);
  }

  // 凭据仍可用于其真正归属的变更，完成双方确认
  await respondAmendmentTx(db, { amendmentId: second.amendment.id, token: second.tokenA, action: 'confirm' });
  const done = await respondAmendmentTx(db, { amendmentId: second.amendment.id, token: second.tokenB, action: 'confirm' });
  assert.equal(done.applied, true);
});

test('凭据安全：反查查询失败归类 UNAVAILABLE，不改状态且凭据仍可用', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);

  // 让 readwrite 事务内 amendments.getAll（归属反查）抛错
  const failingDb = proxyAmendmentGetAllFailure(db, new Error('cursor unavailable'));
  // 用一个格式合法但与本变更不符的凭据，强制走到反查分支
  const foreign = `amd-a_${'f'.repeat(32)}`;
  const error = await respondAmendmentTx(failingDb as IDBPDatabase, {
    amendmentId: amendment.id,
    token: foreign,
    action: 'confirm'
  }).then(() => null, (e: unknown) => e);

  assert.ok(error instanceof CredentialVerificationError);
  assert.equal((error as AmendmentError).code, 'CREDENTIAL_UNAVAILABLE');

  const amdAfter = (await db.get('amendments', amendment.id)) as Amendment;
  assert.equal(amdAfter.status, AmendmentStatus.Pending);
  assert.equal((await db.get('instances', inst.id) as ContractInstance).finalHtml, V1_HTML);
  assert.deepEqual(await db.getAllFromIndex('versions', 'byInstance', inst.id), []);

  // 合法凭据仍可继续完成确认
  await respondAmendmentTx(db, { amendmentId: amendment.id, token: tokenA, action: 'confirm' });
  const done = await respondAmendmentTx(db, { amendmentId: amendment.id, token: tokenB, action: 'confirm' });
  assert.equal(done.applied, true);
});

/** 让 readwrite 事务内 amendments.getAll 抛错（模拟反查查询失败），其余透传 */
function proxyAmendmentGetAllFailure(db: IDBPDatabase, failure: Error): unknown {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'transaction') {
        return Reflect.get(target, prop, receiver);
      }
      return (...args: unknown[]) => {
        const tx = Reflect.apply(target.transaction, target, args);
        if (tx.mode !== 'readwrite') {
          return tx;
        }
        return new Proxy(tx, {
          get(txTarget: any, txProp, txReceiver) {
            if (txProp !== 'objectStore') {
              const value = Reflect.get(txTarget, txProp, txReceiver);
              return typeof value === 'function' ? value.bind(txTarget) : value;
            }
            return (name: string) => {
              const store = Reflect.apply(txTarget.objectStore, txTarget, [name]);
              if (name !== 'amendments') {
                return store;
              }
              return new Proxy(store, {
                get(storeTarget: any, storeProp) {
                  const value = Reflect.get(storeTarget, storeProp);
                  if (storeProp === 'getAll') {
                    return () => Promise.reject(failure);
                  }
                  return typeof value === 'function' ? value.bind(storeTarget) : value;
                }
              });
            };
          }
        });
      };
    }
  });
}

test('凭据安全：同一凭据第二次提交不产生任何效果（幂等忽略，无写入无版本）', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA } = await registerHelper(db, inst);

  const first = await confirmA(db, amendment.id, tokenA);
  assert.equal(first.applied, false);
  const firstRecord = (await db.get('amendments', amendment.id)) as Amendment;
  assert.equal(firstRecord.credentials[ContractParty.PartyA].used, true);

  // 第二次提交同一枚凭据：ignored，且不产生新的 updatedAt / timeline
  const repeat = await confirmA(db, amendment.id, tokenA);
  assert.equal(repeat.ignored, true);
  assert.equal(repeat.applied, false);
  const secondRecord = (await db.get('amendments', amendment.id)) as Amendment;
  assert.equal(secondRecord.updatedAt, firstRecord.updatedAt);
  assert.equal(secondRecord.timeline.length, firstRecord.timeline.length);

  // 单人仅持甲方票，无论提交多少次都不能生效
  await confirmA(db, amendment.id, tokenA);
  await confirmA(db, amendment.id, tokenA);
  assert.deepEqual(await db.getAllFromIndex('versions', 'byInstance', inst.id), []);
  assert.equal(((await db.get('amendments', amendment.id)) as Amendment).status, AmendmentStatus.Pending);
});

test('凭据安全：持票撤回一次性；撤回后凭据再用无效；另一票确认被拒', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);

  await confirmA(db, amendment.id, tokenA);
  const w = await withdraw(db, amendment.id, tokenB);
  assert.equal(w.amendment.status, AmendmentStatus.Withdrawn);
  assert.equal(w.amendment.credentials[ContractParty.PartyB].usedFor, 'withdraw');

  // 撤回后同一凭据再提交：终态拒绝（TERMINAL_STATE），状态不变
  await assertTerminalRejection(withdraw(db, amendment.id, tokenB));
  await assertTerminalRejection(confirmB(db, amendment.id, tokenB));
  // 甲方票也无法让已撤回的变更复活
  await assertTerminalRejection(confirmA(db, amendment.id, tokenA));

  assert.equal((await db.get('instances', inst.id)).finalHtml, V1_HTML);
  assert.deepEqual(await db.getAllFromIndex('versions', 'byInstance', inst.id), []);
});

async function assertTerminalRejection(promise: Promise<unknown>) {
  await assert.rejects(
    promise.then(() => {
      throw new Error('本应拒绝');
    }),
    (error: unknown) => error instanceof AmendmentError && error.code === 'TERMINAL_STATE'
  );
}

test('正常流程：双方各凭合法票确认一次后，同事务生成新版本并替换正文', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);

  const a = await confirmA(db, amendment.id, tokenA);
  assert.equal(a.applied, false);
  assert.equal((await db.get('instances', inst.id)).finalHtml, V1_HTML);

  const b = await confirmB(db, amendment.id, tokenB);
  assert.equal(b.applied, true);
  assert.equal(b.party, ContractParty.PartyB);

  const instAfter = (await db.get('instances', inst.id)) as ContractInstance;
  const versions = (await db.getAllFromIndex('versions', 'byInstance', inst.id)) as Version[];
  const amdAfter = (await db.get('amendments', amendment.id)) as Amendment;

  assert.equal(instAfter.finalHtml, V2_HTML);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].versionNo, 1);
  assert.equal(instAfter.versionIds.includes(versions[0].id), true);
  assert.equal(amdAfter.status, AmendmentStatus.Applied);
  assert.equal(amdAfter.appliedVersionId, versions[0].id);
  assert.equal(amdAfter.credentials[ContractParty.PartyA].usedFor, 'confirm');
  assert.equal(amdAfter.credentials[ContractParty.PartyB].usedFor, 'confirm');

  // 生效后任何凭据再提交都被拒绝，不会产生 v2 号段之外的版本
  await assert.rejects(confirmA(db, amendment.id, tokenA), AmendmentError);
  const versionsAfter = await db.getAllFromIndex('versions', 'byInstance', inst.id);
  assert.equal(versionsAfter.length, 1);
});

test('并发：两票确认与一票撤回赛跑，永远不会出现已撤回却已生效', async () => {
  await resetDb();
  const db = await openFreshDb();

  for (let round = 0; round < 8; round += 1) {
    const inst = await seedSignedContract(db, signedInstance(`inst_race_${round}`));
    const { amendment, tokenA, tokenB } = await registerHelper(db, inst);

    await Promise.allSettled([
      confirmA(db, amendment.id, tokenA),
      confirmB(db, amendment.id, tokenB),
      withdraw(db, amendment.id, tokenA)
    ]);

    const amdAfter = (await db.get('amendments', amendment.id)) as Amendment;
    const versions = (await db.getAllFromIndex('versions', 'byInstance', inst.id)) as Version[];
    const instAfter = (await db.get('instances', inst.id)) as ContractInstance;

    if (amdAfter.status === AmendmentStatus.Applied) {
      assert.equal(versions.length, 1);
      assert.equal(instAfter.finalHtml, V2_HTML);
      assert.equal(amdAfter.appliedVersionId, versions[0].id);
    } else {
      assert.equal(amdAfter.status, AmendmentStatus.Withdrawn);
      assert.equal(versions.length, 0);
      assert.equal(instAfter.finalHtml, V1_HTML);
    }
  }
});

test('并发：同一枚票同时提交两次，只产生一次效果', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);

  const [r1, r2] = await Promise.all([confirmA(db, amendment.id, tokenA), confirmA(db, amendment.id, tokenA)]);
  const outcomes = [r1, r2];
  assert.equal(outcomes.filter((r) => r.ignored).length, 1, '恰好一次有效，一次忽略');

  const amdAfter = (await db.get('amendments', amendment.id)) as Amendment;
  assert.equal(amdAfter.status, AmendmentStatus.Pending);
  assert.equal(amdAfter.credentials[ContractParty.PartyA].used, true);
  assert.equal(amdAfter.credentials[ContractParty.PartyB].used, false);
  assert.deepEqual(await db.getAllFromIndex('versions', 'byInstance', inst.id), []);

  // 乙方票照常可以补齐双方确认
  const done = await confirmB(db, amendment.id, tokenB);
  assert.equal(done.applied, true);
});

test('回滚：双方确认齐备但落库失败时，正文/变更记录/版本号一起不变', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);
  await confirmA(db, amendment.id, tokenA);

  // 故障注入：删掉合同实例，使事务内「替换正文」前置读取失败 → 整个事务 abort
  await db.delete('instances', inst.id);
  await assert.rejects(confirmB(db, amendment.id, tokenB), AmendmentError);

  const amdAfter = (await db.get('amendments', amendment.id)) as Amendment;
  assert.equal(amdAfter.status, AmendmentStatus.Pending);
  assert.equal(amdAfter.credentials[ContractParty.PartyA].used, true);
  assert.equal(amdAfter.credentials[ContractParty.PartyB].used, false, '乙方确认不落库');
  assert.deepEqual(await db.getAll('versions'), []);

  // 恢复实例后，乙方合法凭据仍可继续完成确认（拒绝不消耗凭据）
  await db.put('instances', inst);
  const retry = await confirmB(db, amendment.id, tokenB);
  assert.equal(retry.applied, true, '失败后合法凭据仍可完成确认');
  const amdRetry = (await db.get('amendments', amendment.id)) as Amendment;
  assert.equal(amdRetry.status, AmendmentStatus.Applied);
  assert.equal((await db.get('instances', inst.id) as ContractInstance).finalHtml, V2_HTML);
});

test('回滚：真正的写入失败归类为 PERSISTENCE_FAILED，回滚后凭据仍可用', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);
  await confirmA(db, amendment.id, tokenA);

  // 用 Proxy 让 versions store 的下一次 put 抛错，模拟「生成新版本失败」
  const failingDb = proxyNextPutFailure(db, 'versions', new Error('disk full'));
  const error = await confirmB(failingDb as IDBPDatabase, amendment.id, tokenB).then(
    () => null,
    (reason: unknown) => reason
  );
  assert.ok(error instanceof AmendmentError, '应包装为 AmendmentError');
  assert.equal((error as AmendmentError).code, 'PERSISTENCE_FAILED');

  // 三者一起保持失败前状态
  const amdAfter = (await db.get('amendments', amendment.id)) as Amendment;
  assert.equal(amdAfter.status, AmendmentStatus.Pending);
  assert.equal(amdAfter.credentials[ContractParty.PartyB].used, false);
  assert.deepEqual(await db.getAllFromIndex('versions', 'byInstance', inst.id), []);
  assert.equal((await db.get('instances', inst.id) as ContractInstance).finalHtml, V1_HTML);

  // 乙方凭据未被消耗，重试可成功
  const retry = await confirmB(db, amendment.id, tokenB);
  assert.equal(retry.applied, true);
  assert.equal((await db.get('instances', inst.id) as ContractInstance).finalHtml, V2_HTML);
});

/** 让指定 store 的下一次 put（且仅一次）抛错，其余操作透传 */
function proxyNextPutFailure(db: IDBPDatabase, storeName: string, failure: Error): unknown {
  let armed = true;
  const wrapStore = (store: IDBPObjectStoreLike) =>
    new Proxy(store, {
      get(target, prop) {
        if (prop === 'put' && armed) {
          return (..._args: unknown[]) => {
            armed = false;
            throw failure;
          };
        }
        const value = Reflect.get(target, prop);
        // index/getAll 等方法必须绑定回真实对象，否则内部 this 丢失
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'transaction') {
        return Reflect.get(target, prop, receiver);
      }
      return (...args: unknown[]) => {
        const tx = Reflect.apply(target.transaction, target, args);
        if (tx.mode !== 'readwrite') {
          return tx;
        }
        return new Proxy(tx, {
          get(txTarget, txProp, txReceiver) {
            if (txProp !== 'objectStore') {
              const value = Reflect.get(txTarget, txProp, txReceiver);
              return typeof value === 'function' ? value.bind(txTarget) : value;
            }
            return (name: string) => {
              const store: IDBPObjectStoreLike = Reflect.apply(txTarget.objectStore, txTarget, [name]);
              return name === storeName ? wrapStore(store) : store;
            };
          }
        });
      };
    }
  });
}

type IDBPObjectStoreLike = {
  put: (...args: unknown[]) => unknown;
  index: (name: string) => { getAll: (query?: unknown) => Promise<unknown[]> };
  // 其余属性以宽松索引签名兼容
  [key: string]: unknown;
};

test('反馈分类：classifyCredentialError 能区分凭据/终态/落库失败', async () => {
  const { classifyCredentialError } = await import('../src/utils/amendmentFeedback');
  assert.equal(classifyCredentialError(new CredentialVerificationError('x', 'CREDENTIAL_MALFORMED')).reason, 'CREDENTIAL_MALFORMED');
  assert.equal(classifyCredentialError(new AmendmentError('已生效', 'TERMINAL_STATE')).reason, 'TERMINAL_STATE');
  assert.equal(classifyCredentialError(new Error('boom')).reason, 'PERSISTENCE_FAILED');
  assert.equal(classifyCredentialError('string-error').reason, 'PERSISTENCE_FAILED');
});

test('回读：生效后重开数据库，凭据状态/正文/版本一致', async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);
  await confirmA(db, amendment.id, tokenA);
  await confirmB(db, amendment.id, tokenB);
  db.close();

  const reopened = await openFreshDb();
  const instAfter = (await reopened.get('instances', inst.id)) as ContractInstance;
  const versions = (await reopened.getAllFromIndex('versions', 'byInstance', inst.id)) as Version[];
  const amdAfter = (await reopened.get('amendments', amendment.id)) as Amendment;

  assert.equal(instAfter.finalHtml, V2_HTML);
  assert.equal(versions.length, 1);
  assert.equal(amdAfter.status, AmendmentStatus.Applied);
  assert.equal(instAfter.versionIds[0], versions[0].id);
});

test('版本号：在 v1 基础上双方确认，新版本号严格递增为 v2', async () => {
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

  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);
  await confirmA(db, amendment.id, tokenA);
  const outcome = await confirmB(db, amendment.id, tokenB);
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

// ---------- 迁移 ----------

test('迁移：v1→v3 全新升级路径，旧数据保留且可走凭据流程', async () => {
  await resetDb();
  const { openDB } = await import('idb');
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

  const migrated = await openAppDb();
  openDbs.push(migrated);
  assert.equal(migrated.version, DB_VERSION);
  assert.equal(migrated.objectStoreNames.contains('amendments'), true);
  const inspect = migrated.transaction('versions', 'readonly');
  assert.equal(inspect.objectStore('versions').indexNames.contains('byInstance'), true);
  await inspect.done;

  const result = await registerAmendmentTx(migrated, {
    contractInstanceId: 'inst_legacy',
    content: { title: '迁移后变更', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA
  });
  const tokenA = result.credentials.find((c) => c.party === ContractParty.PartyA)!.token;
  const tokenB = result.credentials.find((c) => c.party === ContractParty.PartyB)!.token;
  await respondAmendmentTx(migrated, { amendmentId: result.amendment.id, token: tokenA, action: 'confirm' });
  const outcome = await respondAmendmentTx(migrated, { amendmentId: result.amendment.id, token: tokenB, action: 'confirm' });
  assert.equal(outcome.applied, true);
  assert.equal(outcome.version?.versionNo, 2, '版本号在老 v1 基础上续接');
});

test('迁移：v2 自报身份记录升级到 v3 凭据模型', async () => {
  await resetDb();
  const { openDB } = await import('idb');

  const instApplied = signedInstance('inst_v2_applied');
  const instPending = signedInstance('inst_v2_pending');
  const instWithdrawn = signedInstance('inst_v2_withdrawn');

  // 手工构造 v2 schema（含 byInstance 索引）
  const v2db = await openDB(DB_NAME, 2, {
    upgrade(db) {
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          if (name === 'versions' || name === 'amendments') {
            store.createIndex('byInstance', 'contractInstanceId');
          }
        }
      }
    }
  });
  await Promise.all([instApplied, instPending, instWithdrawn].map((i) => v2db.put('instances', i)));

  const v2Amendment = (id: string, contractInstanceId: string, extra: Record<string, unknown>) => ({
    id,
    contractInstanceId,
    title: '旧版变更',
    reason: '',
    proposedHtml: V2_HTML,
    status: AmendmentStatus.Pending,
    confirmedParties: [],
    proposedBy: ContractParty.PartyA,
    proposedAt: NOW,
    updatedAt: NOW,
    timeline: [{ action: 'created', party: ContractParty.PartyA, at: NOW }],
    ...extra
  });

  await v2db.put(
    'amendments',
    v2Amendment('amd_applied', instApplied.id, {
      status: AmendmentStatus.Applied,
      confirmedParties: [ContractParty.PartyA, ContractParty.PartyB],
      appliedAt: NOW,
      appliedVersionId: 'ver_old',
      baseVersionNo: 1
    })
  );
  await v2db.put('amendments', v2Amendment('amd_pending', instPending.id, { confirmedParties: [ContractParty.PartyA] }));
  await v2db.put(
    'amendments',
    v2Amendment('amd_withdrawn', instWithdrawn.id, {
      status: AmendmentStatus.Withdrawn,
      confirmedParties: [ContractParty.PartyA],
      withdrawnBy: ContractParty.PartyB,
      withdrawnAt: NOW
    })
  );
  v2db.close();

  const migrated = await openAppDb();
  openDbs.push(migrated);
  assert.equal(migrated.version, 3);

  const applied = (await migrated.get('amendments', 'amd_applied')) as Amendment;
  assert.equal(applied.status, AmendmentStatus.Applied);
  assert.equal(applied.credentials[ContractParty.PartyA].usedFor, 'confirm');
  assert.equal(applied.credentials[ContractParty.PartyB].usedFor, 'confirm');
  assert.equal('confirmedParties' in applied, false);

  const pending = (await migrated.get('amendments', 'amd_pending')) as Amendment;
  assert.equal(pending.status, AmendmentStatus.Withdrawn, '旧在途记录无凭据可对应，必须作废');
  assert.equal(pending.credentials[ContractParty.PartyA].used, false);

  const withdrawn = (await migrated.get('amendments', 'amd_withdrawn')) as Amendment;
  assert.equal(withdrawn.status, AmendmentStatus.Withdrawn);
  assert.equal(withdrawn.credentials[ContractParty.PartyA].usedFor, 'confirm');
  assert.equal(withdrawn.credentials[ContractParty.PartyB].usedFor, 'withdraw');

  // 旧在途记录已作废为 withdrawn：任何票据都无法复活（终态检查先于哈希校验）
  const token = issueCredentialPair()[0].token;
  await assert.rejects(
    respondAmendmentTx(migrated, { amendmentId: 'amd_pending', token, action: 'confirm' }),
    AmendmentError
  );
  const pendingAfter = (await migrated.get('amendments', 'amd_pending')) as Amendment;
  assert.equal(pendingAfter.status, AmendmentStatus.Withdrawn);

  // 作废后允许重新登记
  const re = await registerAmendmentTx(migrated, {
    contractInstanceId: instPending.id,
    content: { title: '重新登记', reason: '', proposedHtml: V2_HTML },
    proposedBy: ContractParty.PartyA
  });
  assert.equal(re.amendment.status, AmendmentStatus.Pending);
});

test('getDb 单例：v3 打开后包含 amendments 与 byInstance 索引', async () => {
  await resetDb();
  const db = await getDb();
  assert.equal(db.version, DB_VERSION);
  assert.equal(db.objectStoreNames.contains('amendments'), true);
  const tx = db.transaction('versions', 'readonly');
  assert.equal(tx.objectStore('versions').indexNames.contains('byInstance'), true);
  await tx.done;
});
