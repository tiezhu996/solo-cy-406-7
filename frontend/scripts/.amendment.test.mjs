// scripts/amendment.test.ts
import "fake-indexeddb/auto";
import test, { after } from "node:test";
import assert from "node:assert/strict";

// src/utils/db.ts
import { openDB } from "idb";
var DB_NAME = "contract-template-editor";
var DB_VERSION = 2;
var STORE_NAMES = ["templates", "clauses", "instances", "versions", "amendments"];
var dbPromise;
function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function openAppDb() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      for (const storeName of STORE_NAMES) {
        if (!db.objectStoreNames.contains(storeName)) {
          const store = db.createObjectStore(storeName, { keyPath: "id" });
          if (storeName === "versions" || storeName === "amendments") {
            store.createIndex("byInstance", "contractInstanceId");
          }
        }
      }
      if (oldVersion > 0 && oldVersion < 2) {
        const versions = transaction.objectStore("versions");
        if (!versions.indexNames.contains("byInstance")) {
          versions.createIndex("byInstance", "contractInstanceId");
        }
      }
    }
  });
}
function getDb() {
  if (!dbPromise) {
    dbPromise = openAppDb();
  }
  return dbPromise;
}

// src/utils/amendmentMachine.ts
var ALL_PARTIES = ["partyA" /* PartyA */, "partyB" /* PartyB */];
var AmendmentError = class extends Error {
};
function isTerminal(status) {
  return status === "applied" /* Applied */ || status === "withdrawn" /* Withdrawn */;
}
function hasConfirmed(amendment, party) {
  return amendment.confirmedParties.includes(party);
}
function bothConfirmed(amendment) {
  return ALL_PARTIES.every((party) => amendment.confirmedParties.includes(party));
}
function pushTimeline(amendment, entry) {
  return [...amendment.timeline, entry];
}
function createAmendment(input) {
  const amendment = {
    id: input.id,
    contractInstanceId: input.contractInstanceId,
    ...input.content,
    status: "pending" /* Pending */,
    confirmedParties: [],
    proposedBy: input.proposedBy,
    proposedAt: input.now,
    updatedAt: input.now,
    timeline: [
      {
        action: "created" /* Created */,
        party: input.proposedBy,
        at: input.now,
        detail: input.content.title
      }
    ]
  };
  return amendment;
}
function confirmAmendment(amendment, party, now) {
  if (isTerminal(amendment.status)) {
    throw new AmendmentError(`\u53D8\u66F4\u5DF2\u5904\u4E8E\u300C${amendment.status}\u300D\u72B6\u6001\uFF0C\u4E0D\u80FD\u518D\u786E\u8BA4`);
  }
  if (hasConfirmed(amendment, party)) {
    return {
      amendment: {
        ...amendment,
        timeline: pushTimeline(amendment, {
          action: "confirm_ignored" /* ConfirmIgnored */,
          party,
          at: now,
          detail: "\u91CD\u590D\u786E\u8BA4\uFF0C\u5DF2\u5FFD\u7565"
        })
      },
      ready: false,
      ignored: true
    };
  }
  const confirmedParties = [...amendment.confirmedParties, party];
  const ready = ALL_PARTIES.every((candidate) => confirmedParties.includes(candidate));
  return {
    amendment: {
      ...amendment,
      confirmedParties,
      updatedAt: now,
      timeline: pushTimeline(amendment, { action: "confirmed" /* Confirmed */, party, at: now })
    },
    ready,
    ignored: false
  };
}
function withdrawAmendment(amendment, party, now) {
  if (amendment.status === "withdrawn" /* Withdrawn */) {
    return amendment;
  }
  if (amendment.status === "applied" /* Applied */) {
    throw new AmendmentError("\u53D8\u66F4\u5DF2\u751F\u6548\uFF0C\u4E0D\u80FD\u64A4\u56DE\uFF1B\u5982\u9700\u56DE\u9000\u8BF7\u767B\u8BB0\u65B0\u7684\u53D8\u66F4");
  }
  return {
    ...amendment,
    status: "withdrawn" /* Withdrawn */,
    withdrawnBy: party,
    withdrawnAt: now,
    updatedAt: now,
    timeline: pushTimeline(amendment, { action: "withdrawn" /* Withdrawn */, party, at: now })
  };
}
function markApplied(amendment, versionId, baseVersionNo, now) {
  if (amendment.status !== "pending" /* Pending */ || !bothConfirmed(amendment)) {
    throw new AmendmentError("\u53EA\u6709\u53CC\u65B9\u5747\u5DF2\u786E\u8BA4\u7684\u5F85\u786E\u8BA4\u53D8\u66F4\u624D\u80FD\u6807\u8BB0\u751F\u6548");
  }
  return {
    ...amendment,
    status: "applied" /* Applied */,
    appliedVersionId: versionId,
    baseVersionNo,
    appliedAt: now,
    updatedAt: now,
    timeline: pushTimeline(amendment, {
      action: "applied" /* Applied */,
      at: now,
      detail: `\u751F\u6210\u65B0\u7248\u672C\uFF0C\u539F\u7248\u672C ${baseVersionNo} \u88AB\u66FF\u6362`
    })
  };
}

// src/utils/amendmentTx.ts
var locks = /* @__PURE__ */ new Map();
function serializeForInstance(contractInstanceId, task) {
  const previous = locks.get(contractInstanceId) ?? Promise.resolve();
  const current = previous.then(task, task);
  const tracked = current.catch(() => void 0).then(() => {
    if (locks.get(contractInstanceId) === tracked) {
      locks.delete(contractInstanceId);
    }
  });
  locks.set(contractInstanceId, tracked);
  return current;
}
function assertSigned(instance, contractInstanceId) {
  if (!instance) {
    throw new AmendmentError("\u5408\u540C\u5B9E\u4F8B\u4E0D\u5B58\u5728\uFF0C\u65E0\u6CD5\u767B\u8BB0\u53D8\u66F4");
  }
  if (instance.status !== "signed" /* Signed */) {
    throw new AmendmentError("\u4EC5\u5DF2\u7B7E\u7F72\u5408\u540C\u53EF\u4EE5\u63D0\u51FA\u53D8\u66F4");
  }
}
async function registerAmendmentTx(db, params) {
  if (!params.content.proposedHtml.trim()) {
    throw new AmendmentError("\u53D8\u66F4\u540E\u6B63\u6587\u4E0D\u80FD\u4E3A\u7A7A");
  }
  if (!params.content.title.trim()) {
    throw new AmendmentError("\u53D8\u66F4\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A");
  }
  return serializeForInstance(params.contractInstanceId, async () => {
    const tx = db.transaction(["instances", "amendments"], "readwrite");
    tx.done.catch(() => void 0);
    try {
      const instanceStore = tx.objectStore("instances");
      const amendmentStore = tx.objectStore("amendments");
      const instance = await instanceStore.get(params.contractInstanceId);
      assertSigned(instance, params.contractInstanceId);
      const existing = await amendmentStore.index("byInstance").getAll(params.contractInstanceId);
      if (existing.some((item) => item.status === "pending")) {
        throw new AmendmentError("\u8BE5\u5408\u540C\u5DF2\u6709\u5F85\u53CC\u65B9\u786E\u8BA4\u7684\u53D8\u66F4\uFF0C\u8BF7\u5148\u5B8C\u6210\u786E\u8BA4\u6216\u64A4\u56DE");
      }
      const amendment = createAmendment({
        id: makeId("amd"),
        contractInstanceId: params.contractInstanceId,
        content: {
          title: params.content.title.trim(),
          reason: params.content.reason.trim(),
          proposedHtml: params.content.proposedHtml
        },
        proposedBy: params.proposedBy,
        now: nowIso()
      });
      await amendmentStore.put(amendment);
      await tx.done;
      return amendment;
    } catch (error) {
      tx.abort();
      throw error;
    }
  });
}
async function respondAmendmentTx(db, params) {
  const preamble = db.transaction("amendments", "readonly");
  const amendmentRef = await preamble.objectStore("amendments").get(params.amendmentId);
  if (!amendmentRef) {
    throw new AmendmentError("\u53D8\u66F4\u8BB0\u5F55\u4E0D\u5B58\u5728");
  }
  const contractInstanceId = amendmentRef.contractInstanceId;
  return serializeForInstance(contractInstanceId, async () => {
    const tx = db.transaction(["amendments", "instances", "versions"], "readwrite");
    tx.done.catch(() => void 0);
    try {
      const amendmentStore = tx.objectStore("amendments");
      const instanceStore = tx.objectStore("instances");
      const versionStore = tx.objectStore("versions");
      const amendment = await amendmentStore.get(params.amendmentId);
      if (!amendment) {
        throw new AmendmentError("\u53D8\u66F4\u8BB0\u5F55\u4E0D\u5B58\u5728");
      }
      if (isTerminal(amendment.status)) {
        throw new AmendmentError(`\u53D8\u66F4\u5DF2${amendment.status === "applied" ? "\u751F\u6548" : "\u64A4\u56DE"}\uFF0C\u64CD\u4F5C\u65E0\u6548`);
      }
      const now = nowIso();
      if (params.action === "withdraw") {
        const next = withdrawAmendment(amendment, params.party, now);
        await amendmentStore.put(next);
        await tx.done;
        return { amendment: next, applied: false };
      }
      const result = confirmAmendment(amendment, params.party, now);
      if (result.ignored || !result.ready) {
        await amendmentStore.put(result.amendment);
        await tx.done;
        return { amendment: result.amendment, applied: false };
      }
      const instance = await instanceStore.get(contractInstanceId);
      assertSigned(instance, contractInstanceId);
      const related = await versionStore.index("byInstance").getAll(contractInstanceId);
      const baseVersionNo = related.reduce((max, version2) => Math.max(max, version2.versionNo), 0);
      const nextVersionNo = baseVersionNo + 1;
      const version = {
        id: makeId("ver"),
        contractInstanceId,
        versionNo: nextVersionNo,
        contentSnapshot: result.amendment.proposedHtml,
        variableSnapshot: { ...instance.variableValues },
        createdAt: now,
        remark: `\u5408\u540C\u53D8\u66F4\u751F\u6548\uFF1A${result.amendment.title}`
      };
      await versionStore.put(version);
      const nextInstance = {
        ...instance,
        finalHtml: result.amendment.proposedHtml,
        versionIds: Array.from(/* @__PURE__ */ new Set([...instance.versionIds, version.id])),
        updatedAt: now
      };
      await instanceStore.put(nextInstance);
      const applied = markApplied(result.amendment, version.id, baseVersionNo, now);
      await amendmentStore.put(applied);
      await tx.done;
      return { amendment: applied, applied: true, version, instance: nextInstance };
    } catch (error) {
      tx.abort();
      throw error;
    }
  });
}

// scripts/amendment.test.ts
var NOW = "2026-09-16T08:00:00.000Z";
var V1_HTML = "<p>v1 \u6B63\u6587</p>";
var V2_HTML = "<p>v2 \u6B63\u6587\uFF08\u53D8\u66F4\u540E\uFF09</p>";
after(async () => {
  for (const db2 of openDbs.splice(0)) {
    db2.close();
  }
  const db = await getDb();
  db.close();
});
function signedInstance(id = makeId("inst")) {
  return {
    id,
    templateId: "tpl_x",
    title: "\u6D4B\u8BD5\u5408\u540C",
    variableValues: { a: "1" },
    finalHtml: V1_HTML,
    status: "signed" /* Signed */,
    versionIds: [],
    createdAt: NOW,
    updatedAt: NOW
  };
}
async function resetDb() {
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase("contract-template-editor");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("deleteDatabase \u88AB\u963B\u585E"));
  });
}
var openDbs = [];
async function openFreshDb(version) {
  const { openDB: openDB2 } = await import("idb");
  const db = await openDB2("contract-template-editor", version ?? DB_VERSION, {
    upgrade(db2, oldVersion, _n, transaction) {
      for (const name of STORE_NAMES) {
        if (!db2.objectStoreNames.contains(name)) {
          const store = db2.createObjectStore(name, { keyPath: "id" });
          if (name === "versions" || name === "amendments") {
            store.createIndex("byInstance", "contractInstanceId");
          }
        }
      }
      if (oldVersion > 0 && oldVersion < 2 && db2.objectStoreNames.contains("versions")) {
        const versions = transaction.objectStore("versions");
        if (!versions.indexNames.contains("byInstance")) {
          versions.createIndex("byInstance", "contractInstanceId");
        }
      }
    }
  });
  openDbs.push(db);
  return db;
}
async function seedSignedContract(db, instance) {
  const inst = instance ?? signedInstance();
  await db.put("instances", inst);
  return inst;
}
test("\u72B6\u6001\u673A\uFF1A\u767B\u8BB0\u540E\u505C\u5728\u5F85\u786E\u8BA4\uFF0C\u539F\u5408\u540C\u4E0D\u53D7\u5F71\u54CD", () => {
  const amd = createAmendment({
    id: "amd_1",
    contractInstanceId: "inst_1",
    content: { title: "t", reason: "r", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */,
    now: NOW
  });
  assert.equal(amd.status, "pending" /* Pending */);
  assert.deepEqual(amd.confirmedParties, []);
  assert.equal(bothConfirmed(amd), false);
});
test("\u72B6\u6001\u673A\uFF1A\u540C\u4E00\u65B9\u91CD\u590D\u786E\u8BA4\u5E42\u7B49\uFF0C\u4E0D\u4EA7\u751F\u65B0\u6548\u679C", () => {
  let amd = createAmendment({
    id: "amd_1",
    contractInstanceId: "inst_1",
    content: { title: "t", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */,
    now: NOW
  });
  const first = confirmAmendment(amd, "partyA" /* PartyA */, NOW);
  assert.equal(first.ready, false);
  assert.deepEqual(first.amendment.confirmedParties, ["partyA" /* PartyA */]);
  const second = confirmAmendment(first.amendment, "partyA" /* PartyA */, NOW);
  assert.equal(second.ignored, true);
  assert.equal(second.ready, false);
  assert.deepEqual(second.amendment.confirmedParties, ["partyA" /* PartyA */]);
  amd = second.amendment;
  const third = confirmAmendment(amd, "partyB" /* PartyB */, NOW);
  assert.equal(third.ready, true);
  assert.equal(third.ignored, false);
});
test("\u72B6\u6001\u673A\uFF1A\u4EFB\u4E00\u65B9\u64A4\u56DE\u6574\u6761\u5931\u6548\uFF0C\u7EC8\u6001\u540E\u786E\u8BA4/\u64A4\u56DE\u88AB\u62D2\u7EDD", () => {
  let amd = createAmendment({
    id: "amd_1",
    contractInstanceId: "inst_1",
    content: { title: "t", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */,
    now: NOW
  });
  amd = confirmAmendment(amd, "partyA" /* PartyA */, NOW).amendment;
  amd = withdrawAmendment(amd, "partyB" /* PartyB */, NOW);
  assert.equal(amd.status, "withdrawn" /* Withdrawn */);
  assert.equal(amd.withdrawnBy, "partyB" /* PartyB */);
  assert.throws(() => confirmAmendment(amd, "partyB" /* PartyB */, NOW), AmendmentError);
  assert.equal(withdrawAmendment(amd, "partyA" /* PartyA */, NOW).status, "withdrawn" /* Withdrawn */);
});
test("\u72B6\u6001\u673A\uFF1A\u5DF2\u751F\u6548\u53D8\u66F4\u4E0D\u80FD\u64A4\u56DE", () => {
  let amd = createAmendment({
    id: "amd_1",
    contractInstanceId: "inst_1",
    content: { title: "t", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */,
    now: NOW
  });
  amd = confirmAmendment(amd, "partyA" /* PartyA */, NOW).amendment;
  amd = confirmAmendment(amd, "partyB" /* PartyB */, NOW).amendment;
  amd = markApplied(amd, "ver_2", 1, NOW);
  assert.equal(amd.status, "applied" /* Applied */);
  assert.throws(() => withdrawAmendment(amd, "partyA" /* PartyA */, NOW), AmendmentError);
});
test("\u4E8B\u52A1\uFF1A\u767B\u8BB0\u4EC5\u5DF2\u7B7E\u7F72\u5408\u540C\u5141\u8BB8\uFF0C\u767B\u8BB0\u65F6\u4E0D\u52A8\u6B63\u6587/\u7248\u672C", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const amd = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: "\u53D8\u66F41", reason: "\u534F\u5546", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */
  });
  assert.equal(amd.status, "pending" /* Pending */);
  const instAfter = await db.get("instances", inst.id);
  assert.equal(instAfter.finalHtml, V1_HTML);
  assert.deepEqual(await db.getAll("versions"), []);
  const draft = signedInstance();
  draft.status = "draft" /* Draft */;
  await db.put("instances", draft);
  await assert.rejects(
    registerAmendmentTx(db, {
      contractInstanceId: draft.id,
      content: { title: "x", reason: "", proposedHtml: V2_HTML },
      proposedBy: "partyA" /* PartyA */
    }),
    AmendmentError
  );
  await assert.rejects(
    registerAmendmentTx(db, {
      contractInstanceId: inst.id,
      content: { title: "\u53D8\u66F42", reason: "", proposedHtml: V2_HTML },
      proposedBy: "partyB" /* PartyB */
    }),
    AmendmentError
  );
});
test("\u4E8B\u52A1\uFF1A\u53CC\u65B9\u786E\u8BA4\u540C\u4E8B\u52A1\u751F\u6210\u65B0\u7248\u672C\u3001\u66FF\u6362\u6B63\u6587\u3001\u63A8\u8FDB\u53D8\u66F4\u8BB0\u5F55", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const amd = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: "\u53D8\u66F41", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */
  });
  const afterA = await respondAmendmentTx(db, { amendmentId: amd.id, party: "partyA" /* PartyA */, action: "confirm" });
  assert.equal(afterA.applied, false);
  assert.equal((await db.get("instances", inst.id)).finalHtml, V1_HTML, "\u5355\u65B9\u786E\u8BA4\u540E\u6B63\u6587\u4E0D\u53D8");
  assert.deepEqual(await db.getAll("versions"), [], "\u5355\u65B9\u786E\u8BA4\u4E0D\u751F\u6210\u7248\u672C");
  const afterB = await respondAmendmentTx(db, { amendmentId: amd.id, party: "partyB" /* PartyB */, action: "confirm" });
  assert.equal(afterB.applied, true);
  const instAfter = await db.get("instances", inst.id);
  const versions = await db.getAll("versions");
  const amdAfter = await db.get("amendments", amd.id);
  assert.equal(instAfter.finalHtml, V2_HTML, "\u6B63\u6587\u66FF\u6362");
  assert.equal(versions.length, 1);
  assert.equal(versions[0].versionNo, 1);
  assert.equal(versions[0].contentSnapshot, V2_HTML);
  assert.equal(instAfter.versionIds.includes(versions[0].id), true);
  assert.equal(amdAfter.status, "applied" /* Applied */);
  assert.equal(amdAfter.appliedVersionId, versions[0].id);
});
test("\u4E8B\u52A1\uFF1A\u540C\u4E00\u65B9\u91CD\u590D\u786E\u8BA4\u4E0D\u91CD\u590D\u751F\u6548\uFF08\u4E0D\u4EA7\u751F\u7248\u672C\uFF09", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const amd = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: "\u53D8\u66F41", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */
  });
  await respondAmendmentTx(db, { amendmentId: amd.id, party: "partyA" /* PartyA */, action: "confirm" });
  const repeat = await respondAmendmentTx(db, { amendmentId: amd.id, party: "partyA" /* PartyA */, action: "confirm" });
  assert.equal(repeat.applied, false);
  assert.equal(repeat.amendment.confirmedParties.length, 1);
  assert.deepEqual(await db.getAll("versions"), []);
  assert.equal((await db.get("instances", inst.id)).finalHtml, V1_HTML);
  await respondAmendmentTx(db, { amendmentId: amd.id, party: "partyB" /* PartyB */, action: "confirm" });
  await assert.rejects(
    respondAmendmentTx(db, { amendmentId: amd.id, party: "partyA" /* PartyA */, action: "confirm" }),
    AmendmentError
  );
});
test("\u4E8B\u52A1\uFF1A\u4EFB\u4E00\u65B9\u64A4\u56DE\u6574\u6761\u5931\u6548\uFF0C\u6B63\u6587\u4E0E\u7248\u672C\u4E0D\u53D8", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const amd = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: "\u53D8\u66F41", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */
  });
  await respondAmendmentTx(db, { amendmentId: amd.id, party: "partyA" /* PartyA */, action: "confirm" });
  const withdrawn = await respondAmendmentTx(db, { amendmentId: amd.id, party: "partyB" /* PartyB */, action: "withdraw" });
  assert.equal(withdrawn.amendment.status, "withdrawn" /* Withdrawn */);
  assert.equal((await db.get("instances", inst.id)).finalHtml, V1_HTML);
  assert.deepEqual(await db.getAll("versions"), []);
  const amdAfter = await db.get("amendments", amd.id);
  assert.equal(amdAfter.status, "withdrawn");
  await assert.rejects(
    respondAmendmentTx(db, { amendmentId: amd.id, party: "partyB" /* PartyB */, action: "confirm" }),
    AmendmentError
  );
});
test("\u5E76\u53D1\uFF1A\u786E\u8BA4\u4E0E\u64A4\u56DE\u540C\u65F6\u5230\u8FBE\uFF0C\u53EA\u843D\u5730\u4E00\u4E2A\uFF0C\u72B6\u6001\u4E00\u81F4", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const amd = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: "\u53D8\u66F41", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */
  });
  const [confirmResult, withdrawResult] = await Promise.allSettled([
    respondAmendmentTx(db, { amendmentId: amd.id, party: "partyA" /* PartyA */, action: "confirm" }),
    respondAmendmentTx(db, { amendmentId: amd.id, party: "partyB" /* PartyB */, action: "withdraw" })
  ]);
  const amdAfter = await db.get("amendments", amd.id);
  const versions = await db.getAll("versions");
  const instAfter = await db.get("instances", inst.id);
  if (amdAfter.status === "withdrawn" /* Withdrawn */) {
    if (confirmResult.status === "rejected") {
      assert.equal(withdrawResult.status, "fulfilled");
    }
  }
  assert.equal(versions.length, 0);
  assert.equal(instAfter.finalHtml, V1_HTML);
  assert.equal(amdAfter.status, "withdrawn" /* Withdrawn */);
});
test("\u5E76\u53D1\uFF1A\u53CC\u65B9\u786E\u8BA4\u4E0E\u64A4\u56DE\u8D5B\u8DD1\uFF0C\u6C38\u8FDC\u4E0D\u4F1A\u51FA\u73B0\u5DF2\u64A4\u56DE\u5374\u5DF2\u751F\u6548", async () => {
  await resetDb();
  const db = await openFreshDb();
  for (let round = 0; round < 8; round++) {
    const inst = await seedSignedContract(db, signedInstance(`inst_race_${round}`));
    const amd = await registerAmendmentTx(db, {
      contractInstanceId: inst.id,
      content: { title: "t", reason: "", proposedHtml: V2_HTML },
      proposedBy: "partyA" /* PartyA */
    });
    await Promise.allSettled([
      respondAmendmentTx(db, { amendmentId: amd.id, party: "partyA" /* PartyA */, action: "confirm" }),
      respondAmendmentTx(db, { amendmentId: amd.id, party: "partyB" /* PartyB */, action: "confirm" }),
      respondAmendmentTx(db, { amendmentId: amd.id, party: "partyA" /* PartyA */, action: "withdraw" })
    ]);
    const amdAfter = await db.get("amendments", amd.id);
    const versions = await db.getAllFromIndex("versions", "byInstance", inst.id);
    const instAfter = await db.get("instances", inst.id);
    if (amdAfter.status === "applied" /* Applied */) {
      assert.equal(versions.length, 1, "\u751F\u6548\u5FC5\u987B\u6070\u597D\u4F34\u968F\u4E00\u4E2A\u65B0\u7248\u672C");
      assert.equal(instAfter.finalHtml, V2_HTML);
      assert.equal(amdAfter.appliedVersionId, versions[0].id);
    } else {
      assert.equal(amdAfter.status, "withdrawn" /* Withdrawn */);
      assert.equal(versions.length, 0, "\u64A4\u56DE\u540E\u4E0D\u5F97\u6709\u7248\u672C");
      assert.equal(instAfter.finalHtml, V1_HTML, "\u64A4\u56DE\u540E\u6B63\u6587\u5FC5\u987B\u4FDD\u6301\u539F\u6837");
    }
  }
});
test("\u56DE\u6EDA\uFF1A\u751F\u6210\u65B0\u7248\u672C\u9014\u4E2D\u5931\u8D25\u65F6\uFF0C\u6B63\u6587/\u53D8\u66F4\u8BB0\u5F55/\u7248\u672C\u53F7\u4E00\u8D77\u4E0D\u53D8", async () => {
  await resetDb();
  const base = await openFreshDb();
  const inst = await seedSignedContract(base);
  const amd = await registerAmendmentTx(base, {
    contractInstanceId: inst.id,
    content: { title: "\u53D8\u66F41", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */
  });
  await respondAmendmentTx(base, { amendmentId: amd.id, party: "partyA" /* PartyA */, action: "confirm" });
  await base.delete("instances", inst.id);
  await assert.rejects(
    respondAmendmentTx(base, { amendmentId: amd.id, party: "partyB" /* PartyB */, action: "confirm" }),
    AmendmentError
  );
  const amdAfter = await base.get("amendments", amd.id);
  const versions = await base.getAll("versions");
  assert.equal(amdAfter.status, "pending" /* Pending */, "\u53D8\u66F4\u8BB0\u5F55\u56DE\u6EDA\u4E3A\u5F85\u786E\u8BA4");
  assert.deepEqual(amdAfter.confirmedParties, ["partyA" /* PartyA */], "\u7B2C\u4E8C\u65B9\u786E\u8BA4\u4E0D\u843D\u5E93");
  assert.deepEqual(versions, [], "\u4E0D\u5141\u8BB8\u6B8B\u7559\u7248\u672C\uFF08\u7248\u672C\u53F7\u4E0D\u53D8\uFF09");
});
test("\u56DE\u8BFB\uFF1A\u4E8B\u52A1\u63D0\u4EA4\u540E\u91CD\u65B0\u6253\u5F00\u6570\u636E\u5E93\uFF0C\u7ED3\u679C\u4E00\u81F4", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const amd = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: "\u53D8\u66F41", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */
  });
  await respondAmendmentTx(db, { amendmentId: amd.id, party: "partyA" /* PartyA */, action: "confirm" });
  await respondAmendmentTx(db, { amendmentId: amd.id, party: "partyB" /* PartyB */, action: "confirm" });
  db.close();
  const reopened = await openFreshDb();
  const instAfter = await reopened.get("instances", inst.id);
  const versions = await reopened.getAllFromIndex("versions", "byInstance", inst.id);
  const amdAfter = await reopened.get("amendments", amd.id);
  assert.equal(instAfter.finalHtml, V2_HTML);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].versionNo, 1);
  assert.equal(amdAfter.status, "applied" /* Applied */);
  assert.equal(instAfter.versionIds[0], versions[0].id);
});
test("\u7248\u672C\u53F7\uFF1A\u5728\u5DF2\u6709 v1 \u57FA\u7840\u4E0A\u751F\u6548\uFF0C\u65B0\u7248\u672C\u53F7\u4E25\u683C\u9012\u589E\u4E14\u540C\u4E8B\u52A1", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = signedInstance();
  inst.versionIds = ["ver_existing"];
  await db.put("instances", inst);
  await db.put("versions", {
    id: "ver_existing",
    contractInstanceId: inst.id,
    versionNo: 1,
    contentSnapshot: V1_HTML,
    variableSnapshot: {},
    createdAt: NOW,
    remark: "v1"
  });
  const amd = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: "\u53D8\u66F41", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */
  });
  await respondAmendmentTx(db, { amendmentId: amd.id, party: "partyA" /* PartyA */, action: "confirm" });
  const outcome = await respondAmendmentTx(db, { amendmentId: amd.id, party: "partyB" /* PartyB */, action: "confirm" });
  assert.equal(outcome.version?.versionNo, 2);
  const versions = await db.getAllFromIndex("versions", "byInstance", inst.id);
  assert.deepEqual(versions.map((v) => v.versionNo).sort(), [1, 2]);
});
test("\u4E32\u884C\u9501\uFF1A\u540C\u5408\u540C\u52A8\u4F5C\u6309\u63D0\u4EA4\u987A\u5E8F\u6267\u884C\u4E14\u9501\u81EA\u52A8\u91CA\u653E", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const order = [];
  const tasks = Array.from(
    { length: 6 },
    (_, i) => serializeForInstance(inst.id, async () => {
      order.push(i);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return i;
    })
  );
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
});
test("\u8FC1\u79FB\uFF1Av1 \u8001\u5E93\u5347\u7EA7\u5230 v2 \u540E\u65E7\u6570\u636E\u4FDD\u7559\u3001\u7D22\u5F15\u4E0E amendments \u53EF\u7528", async () => {
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("deleteDatabase \u88AB\u963B\u585E"));
  });
  const { openDB: openDB2 } = await import("idb");
  const oldDb = await openDB2(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore("templates", { keyPath: "id" });
      db.createObjectStore("clauses", { keyPath: "id" });
      db.createObjectStore("instances", { keyPath: "id" });
      db.createObjectStore("versions", { keyPath: "id" });
    }
  });
  await oldDb.put("instances", signedInstance("inst_legacy"));
  await oldDb.put("versions", {
    id: "ver_legacy",
    contractInstanceId: "inst_legacy",
    versionNo: 1,
    contentSnapshot: V1_HTML,
    variableSnapshot: {},
    createdAt: NOW,
    remark: "\u8001\u7248\u672C"
  });
  oldDb.close();
  const migrated = await openAppDb();
  openDbs.push(migrated);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.objectStoreNames.contains("amendments"), true);
  const inspectTx = migrated.transaction("versions", "readonly");
  assert.equal(inspectTx.objectStore("versions").indexNames.contains("byInstance"), true);
  await inspectTx.done;
  const legacyInst = await migrated.get("instances", "inst_legacy");
  assert.equal(legacyInst.finalHtml, V1_HTML);
  const legacyVersions = await migrated.getAllFromIndex("versions", "byInstance", "inst_legacy");
  assert.equal(legacyVersions.length, 1);
  const amd = await registerAmendmentTx(migrated, {
    contractInstanceId: "inst_legacy",
    content: { title: "\u8FC1\u79FB\u540E\u53D8\u66F4", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */
  });
  await respondAmendmentTx(migrated, { amendmentId: amd.id, party: "partyA" /* PartyA */, action: "confirm" });
  const outcome = await respondAmendmentTx(migrated, { amendmentId: amd.id, party: "partyB" /* PartyB */, action: "confirm" });
  assert.equal(outcome.applied, true);
  assert.equal(outcome.version?.versionNo, 2);
});
test("getDb \u5355\u4F8B\uFF1Av2 schema \u5347\u7EA7\u540E\u53EF\u76F4\u63A5\u8BFB\u5230 amendments \u4E0E\u7D22\u5F15", async () => {
  await resetDb();
  const db = await getDb();
  assert.equal(db.version, DB_VERSION);
  assert.equal(db.objectStoreNames.contains("amendments"), true);
  const tx = db.transaction("versions", "readonly");
  assert.equal(tx.objectStore("versions").indexNames.contains("byInstance"), true);
  await tx.done;
});
