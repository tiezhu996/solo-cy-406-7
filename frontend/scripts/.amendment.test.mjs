var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/types/amendment.ts
var init_amendment = __esm({
  "src/types/amendment.ts"() {
    "use strict";
  }
});

// src/types/enums.ts
var init_enums = __esm({
  "src/types/enums.ts"() {
    "use strict";
  }
});

// src/utils/amendmentCredential.ts
function issueCredentialPair() {
  return [
    { party: "partyA" /* PartyA */, token: `${PARTY_PREFIX["partyA" /* PartyA */]}${randomSecret()}` },
    { party: "partyB" /* PartyB */, token: `${PARTY_PREFIX["partyB" /* PartyB */]}${randomSecret()}` }
  ];
}
function parseCredentialParty(token) {
  const match = TOKEN_PATTERN.exec(token.trim());
  if (!match) {
    return null;
  }
  return match[1] === "a" ? "partyA" /* PartyA */ : "partyB" /* PartyB */;
}
async function hashCredential(token) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token.trim()));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
function randomSecret() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
var PARTY_PREFIX, TOKEN_PATTERN;
var init_amendmentCredential = __esm({
  "src/utils/amendmentCredential.ts"() {
    "use strict";
    init_enums();
    PARTY_PREFIX = {
      ["partyA" /* PartyA */]: "amd-a_",
      ["partyB" /* PartyB */]: "amd-b_"
    };
    TOKEN_PATTERN = /^amd-(a|b)_([0-9a-f]{32})$/;
  }
});

// src/utils/amendmentMachine.ts
function isTerminal(status) {
  return status === "applied" /* Applied */ || status === "withdrawn" /* Withdrawn */;
}
function partyConfirmed(amendment, party) {
  const credential = amendment.credentials[party];
  return credential.used && credential.usedFor === "confirm";
}
function bothConfirmed(amendment) {
  return ALL_PARTIES.every((party) => partyConfirmed(amendment, party));
}
function pushTimeline(amendment, entry) {
  return [...amendment.timeline, entry];
}
function createAmendment(input) {
  const credentials = {};
  for (const party of ALL_PARTIES) {
    if (!input.credentialHashes[party]) {
      throw new AmendmentError("\u7532\u3001\u4E59\u53CC\u65B9\u51ED\u636E\u5FC5\u987B\u540C\u65F6\u7B7E\u53D1", "ILLEGAL_STATE");
    }
    credentials[party] = { tokenHash: input.credentialHashes[party], used: false };
  }
  return {
    id: input.id,
    contractInstanceId: input.contractInstanceId,
    ...input.content,
    credentials,
    status: "pending" /* Pending */,
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
}
async function buildCredentialHashes(issued) {
  const hashes = {};
  for (const item of issued) {
    hashes[item.party] = await hashCredential(item.token);
  }
  return hashes;
}
function applyCredentialAction(amendment, party, action, now) {
  if (isTerminal(amendment.status)) {
    throw new AmendmentError(`\u53D8\u66F4\u5DF2${amendment.status === "applied" ? "\u751F\u6548" : "\u64A4\u56DE"}\uFF0C\u64CD\u4F5C\u4E0D\u518D\u6709\u6548`, "TERMINAL_STATE");
  }
  const slot = amendment.credentials[party];
  if (!slot) {
    throw new AmendmentError("\u8BE5\u65B9\u4E0D\u5B58\u5728\u51ED\u636E\u69FD", "ILLEGAL_STATE");
  }
  if (slot.used) {
    throw new AmendmentError("\u8BE5\u51ED\u636E\u5DF2\u4F7F\u7528\u8FC7\uFF0C\u4E0D\u80FD\u518D\u6B21\u751F\u6548", "CREDENTIAL_USED");
  }
  if (action === "withdraw") {
    const withdrawn = {
      ...amendment,
      status: "withdrawn" /* Withdrawn */,
      withdrawnBy: party,
      withdrawnAt: now,
      updatedAt: now,
      credentials: consumeCredential(amendment.credentials, party, "withdraw", now),
      timeline: pushTimeline(amendment, { action: "withdrawn" /* Withdrawn */, party, at: now })
    };
    return { amendment: withdrawn, ready: false };
  }
  const credentials = consumeCredential(amendment.credentials, party, "confirm", now);
  const next = {
    ...amendment,
    credentials,
    updatedAt: now,
    timeline: pushTimeline(amendment, { action: "confirmed" /* Confirmed */, party, at: now })
  };
  const ready = ALL_PARTIES.every((candidate) => {
    const credential = credentials[candidate];
    return credential.used && credential.usedFor === "confirm";
  });
  return { amendment: next, ready };
}
function consumeCredential(credentials, party, action, now) {
  return {
    ...credentials,
    [party]: { ...credentials[party], used: true, usedAt: now, usedFor: action }
  };
}
function markApplied(amendment, versionId, baseVersionNo, now) {
  if (amendment.status !== "pending" /* Pending */ || !bothConfirmed(amendment)) {
    throw new AmendmentError("\u53EA\u6709\u53CC\u65B9\u5747\u5DF2\u51ED\u5408\u6CD5\u51ED\u636E\u786E\u8BA4\u7684\u5F85\u786E\u8BA4\u53D8\u66F4\u624D\u80FD\u6807\u8BB0\u751F\u6548", "ILLEGAL_STATE");
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
var ALL_PARTIES, AmendmentError;
var init_amendmentMachine = __esm({
  "src/utils/amendmentMachine.ts"() {
    "use strict";
    init_amendment();
    init_enums();
    init_amendmentCredential();
    ALL_PARTIES = ["partyA" /* PartyA */, "partyB" /* PartyB */];
    AmendmentError = class extends Error {
      code;
      constructor(message, code = "ILLEGAL_STATE") {
        super(message);
        this.name = "AmendmentError";
        this.code = code;
      }
    };
  }
});

// src/utils/amendmentMigrate.ts
var amendmentMigrate_exports = {};
__export(amendmentMigrate_exports, {
  migrateAmendmentV2ToV3: () => migrateAmendmentV2ToV3
});
function migrateAmendmentV2ToV3(raw, migratedAt) {
  const base = raw;
  const confirmed = new Set(Array.isArray(base.confirmedParties) ? base.confirmedParties : []);
  if (base.status === "applied" /* Applied */) {
    return {
      ...stripLegacyFields(base),
      credentials: buildSlots((party) => ({ used: true, usedFor: "confirm", usedAt: base.appliedAt ?? migratedAt })),
      status: "applied" /* Applied */
    };
  }
  if (base.status === "withdrawn" /* Withdrawn */) {
    return {
      ...stripLegacyFields(base),
      credentials: buildSlots(
        (party) => confirmed.has(party) ? { used: true, usedFor: "confirm", usedAt: base.withdrawnAt ?? migratedAt } : base.withdrawnBy === party ? { used: true, usedFor: "withdraw", usedAt: base.withdrawnAt ?? migratedAt } : { used: false }
      ),
      status: "withdrawn" /* Withdrawn */
    };
  }
  return {
    ...stripLegacyFields(base),
    credentials: buildSlots(() => ({ used: false })),
    status: "withdrawn" /* Withdrawn */,
    withdrawnAt: migratedAt,
    updatedAt: migratedAt,
    timeline: [
      ...Array.isArray(base.timeline) ? base.timeline : [],
      {
        action: "rejected" /* Rejected */,
        at: migratedAt,
        detail: "\u51ED\u636E\u4F53\u7CFB\u5347\u7EA7\uFF1A\u65E7\u5F85\u786E\u8BA4\u8BB0\u5F55\u65E0\u5BF9\u5E94\u4E00\u6B21\u6027\u51ED\u636E\uFF0C\u5DF2\u4F5C\u5E9F\uFF0C\u8BF7\u91CD\u65B0\u767B\u8BB0"
      }
    ]
  };
}
function buildSlots(resolve) {
  const slots = {};
  for (const party of ALL_PARTIES) {
    slots[party] = { tokenHash: PLACEHOLDER_HASH, ...resolve(party) };
  }
  return slots;
}
function stripLegacyFields(record) {
  const { confirmedParties: _confirmed, ...rest } = record;
  return rest;
}
var PLACEHOLDER_HASH;
var init_amendmentMigrate = __esm({
  "src/utils/amendmentMigrate.ts"() {
    "use strict";
    init_amendment();
    init_amendmentMachine();
    PLACEHOLDER_HASH = "migration-placeholder";
  }
});

// src/utils/amendmentFeedback.ts
var amendmentFeedback_exports = {};
__export(amendmentFeedback_exports, {
  classifyCredentialError: () => classifyCredentialError,
  describeRejection: () => describeRejection
});
function classifyCredentialError(error) {
  if (error && typeof error === "object" && "code" in error) {
    const reason = error.code;
    if (reason) {
      return { reason, message: error instanceof Error ? error.message : "\u64CD\u4F5C\u88AB\u62D2\u7EDD" };
    }
  }
  return {
    reason: "PERSISTENCE_FAILED",
    message: error instanceof Error ? error.message : "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5"
  };
}
function describeRejection(reason, message, action) {
  const verb = action === "confirm" ? "\u786E\u8BA4" : "\u64A4\u56DE";
  switch (reason) {
    case "CREDENTIAL_MALFORMED":
      return { tone: "error", inline: `\u51ED\u636E\u683C\u5F0F\u9519\u8BEF\uFF1A${message}\u3002\u53D8\u66F4\u4ECD\u4E3A\u5F85\u786E\u8BA4\uFF0C\u5408\u540C\u6B63\u6587\u548C\u7248\u672C\u672A\u6539\u53D8\u3002` };
    case "CREDENTIAL_BOUND_ELSEWHERE":
      return {
        tone: "error",
        inline: `${message}\u3002\u5408\u540C\u6B63\u6587\u3001\u53D8\u66F4\u8BB0\u5F55\u548C\u7248\u672C\u5747\u672A\u6539\u53D8\uFF0C\u8BF7\u6539\u7528\u672C\u53D8\u66F4\u767B\u8BB0\u65F6\u5206\u53D1\u7ED9\u672C\u65B9\u7684\u51ED\u636E\u3002`
      };
    case "CREDENTIAL_UNRECOGNIZED":
      return {
        tone: "error",
        inline: `${message}\u3002\u5408\u540C\u6B63\u6587\u3001\u53D8\u66F4\u8BB0\u5F55\u548C\u7248\u672C\u5747\u672A\u6539\u53D8\uFF0C\u8BF7\u6838\u5BF9\u51ED\u636E\u540E\u91CD\u8BD5\u3002`
      };
    case "CREDENTIAL_UNAVAILABLE":
      return {
        tone: "warning",
        inline: `${message}\u3002\u8BF7\u7A0D\u540E\u7528\u540C\u4E00\u679A\u5408\u6CD5\u51ED\u636E\u91CD\u8BD5\uFF0C\u51ED\u636E\u672A\u88AB\u6D88\u8017\u3002`
      };
    case "CREDENTIAL_MISMATCH":
      return {
        tone: "error",
        inline: `\u51ED\u636E\u4E0D\u88AB\u63A5\u53D7\uFF0C${verb}\u672A\u6267\u884C\u3002\u53D8\u66F4\u8BB0\u5F55\u3001\u6B63\u6587\u548C\u7248\u672C\u5747\u672A\u6539\u53D8\uFF0C\u8BF7\u4F7F\u7528\u672C\u53D8\u66F4\u767B\u8BB0\u65F6\u5206\u53D1\u7ED9\u672C\u65B9\u7684\u51ED\u636E\u91CD\u8BD5\u3002`
      };
    case "CREDENTIAL_USED":
      return { tone: "info", inline: "\u8BE5\u51ED\u636E\u5DF2\u4F7F\u7528\u8FC7\uFF0C\u4E0D\u80FD\u518D\u6B21\u751F\u6548\uFF1B\u72B6\u6001\u4FDD\u6301\u4E0D\u53D8\u3002" };
    case "TERMINAL_STATE":
      return { tone: "warning", inline: `${message}\u3002\u8BF7\u5728\u53D8\u66F4\u5217\u8868\u4E2D\u67E5\u770B\u5F53\u524D\u72B6\u6001\u3002` };
    case "NOT_FOUND":
      return { tone: "error", inline: "\u672A\u627E\u5230\u5BF9\u5E94\u53D8\u66F4\u8BB0\u5F55\uFF0C\u5237\u65B0\u9875\u9762\u540E\u82E5\u4ECD\u5F02\u5E38\u8BF7\u91CD\u65B0\u6253\u5F00\u5408\u540C\u3002" };
    case "PERSISTENCE_FAILED":
      return {
        tone: "error",
        inline: `\u843D\u5E93\u5931\u8D25\uFF0C\u672C\u6B21${verb}\u5DF2\u6574\u4F53\u56DE\u6EDA\u2014\u2014\u5408\u540C\u6B63\u6587\u3001\u53D8\u66F4\u8BB0\u5F55\u548C\u7248\u672C\u53F7\u4FDD\u6301\u5931\u8D25\u524D\u4E00\u81F4\u3002\u8BF7\u4F7F\u7528\u5408\u6CD5\u51ED\u636E\u91CD\u8BD5\u3002`
      };
    default:
      return { tone: "error", inline: message || `${verb}\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002` };
  }
}
var init_amendmentFeedback = __esm({
  "src/utils/amendmentFeedback.ts"() {
    "use strict";
  }
});

// scripts/amendment.test.ts
import "fake-indexeddb/auto";
import test, { after } from "node:test";
import assert from "node:assert/strict";

// src/utils/db.ts
import { openDB } from "idb";
var DB_NAME = "contract-template-editor";
var DB_VERSION = 3;
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
      if (oldVersion >= 2 && oldVersion < 3 && db.objectStoreNames.contains("amendments")) {
        return migrateAmendmentsV2ToV3(transaction.objectStore("amendments"));
      }
    }
  });
}
async function migrateAmendmentsV2ToV3(store) {
  const { migrateAmendmentV2ToV3: migrateAmendmentV2ToV32 } = await Promise.resolve().then(() => (init_amendmentMigrate(), amendmentMigrate_exports));
  let cursor = await store.openCursor();
  const migratedAt = nowIso();
  while (cursor) {
    const migrated = migrateAmendmentV2ToV32(cursor.value, migratedAt);
    cursor.update(migrated);
    cursor = await cursor.continue();
  }
}
function getDb() {
  if (!dbPromise) {
    dbPromise = openAppDb();
  }
  return dbPromise;
}

// scripts/amendment.test.ts
init_amendmentMachine();

// src/utils/amendmentTx.ts
init_enums();
init_amendmentMachine();
init_amendmentCredential();
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
var CredentialVerificationError = class extends AmendmentError {
  constructor(message, code) {
    super(message, code);
    this.name = "CredentialVerificationError";
  }
};
var PersistenceFailureError = class extends AmendmentError {
  cause;
  constructor(message, cause) {
    super(message, "PERSISTENCE_FAILED");
    this.name = "PersistenceFailureError";
    this.cause = cause;
  }
};
function asPersistenceFailure(error) {
  if (error instanceof AmendmentError) {
    return error;
  }
  return new PersistenceFailureError("\u53D8\u66F4\u843D\u5E93\u5931\u8D25\uFF0C\u4E8B\u52A1\u5DF2\u56DE\u6EDA\uFF1A\u5408\u540C\u6B63\u6587\u3001\u53D8\u66F4\u8BB0\u5F55\u548C\u7248\u672C\u53F7\u5747\u672A\u6539\u53D8", error);
}
async function resolveCredentialMismatch(amendmentStore, current, tokenHash) {
  let all;
  try {
    all = await amendmentStore.getAll();
  } catch {
    return new CredentialVerificationError(
      "\u51ED\u636E\u6682\u65F6\u65E0\u6CD5\u9A8C\u8BC1\uFF1A\u67E5\u8BE2\u53D8\u66F4\u8BB0\u5F55\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\uFF1B\u672C\u6B21\u64CD\u4F5C\u672A\u751F\u6548\uFF0C\u5408\u540C\u6B63\u6587\u3001\u8BB0\u5F55\u548C\u7248\u672C\u5747\u672A\u6539\u53D8",
      "CREDENTIAL_UNAVAILABLE"
    );
  }
  const boundElsewhere = all.find(
    (item) => item.id !== current.id && ALL_PARTIES.some((party) => {
      const slot = item.credentials?.[party];
      return slot ? timingSafeEqual(slot.tokenHash, tokenHash) : false;
    })
  );
  if (boundElsewhere) {
    return new CredentialVerificationError(
      `\u8BE5\u51ED\u636E\u5DF2\u88AB\u53E6\u4E00\u6761\u53D8\u66F4\u300C${boundElsewhere.title}\u300D\u7ED1\u5B9A\uFF0C\u4E0D\u80FD\u7528\u4E8E\u672C\u53D8\u66F4\uFF08\u51ED\u636E\u4E0D\u53EF\u8DE8\u53D8\u66F4\u590D\u7528\uFF09\uFF1B\u672C\u6B21\u64CD\u4F5C\u672A\u751F\u6548`,
      "CREDENTIAL_BOUND_ELSEWHERE"
    );
  }
  return new CredentialVerificationError(
    "\u51ED\u636E\u65E0\u6CD5\u8BC6\u522B\uFF1A\u4E0E\u4EFB\u4F55\u53D8\u66F4\u767B\u8BB0\u65F6\u5206\u53D1\u7684\u51ED\u636E\u90FD\u4E0D\u5339\u914D\uFF08\u53EF\u80FD\u8F93\u5165\u6709\u8BEF\u3001\u5C5E\u4E8E\u4ED6\u65B9\u51ED\u636E\u6216\u5DF2\u5931\u6548\uFF09\uFF0C\u672C\u6B21\u64CD\u4F5C\u672A\u751F\u6548",
    "CREDENTIAL_UNRECOGNIZED"
  );
}
function assertSigned(instance, contractInstanceId) {
  if (!instance) {
    throw new AmendmentError("\u5408\u540C\u5B9E\u4F8B\u4E0D\u5B58\u5728\uFF0C\u65E0\u6CD5\u767B\u8BB0\u53D8\u66F4", "NOT_FOUND");
  }
  if (instance.status !== "signed" /* Signed */) {
    throw new AmendmentError("\u4EC5\u5DF2\u7B7E\u7F72\u5408\u540C\u53EF\u4EE5\u63D0\u51FA\u53D8\u66F4", "NOT_SIGNED");
  }
}
async function registerAmendmentTx(db, params) {
  if (!params.content.proposedHtml.replace(/<[^>]*>/g, "").trim()) {
    throw new AmendmentError("\u53D8\u66F4\u540E\u6B63\u6587\u4E0D\u80FD\u4E3A\u7A7A", "INVALID_CONTENT");
  }
  if (!params.content.title.trim()) {
    throw new AmendmentError("\u53D8\u66F4\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A", "INVALID_CONTENT");
  }
  const credentials = issueCredentialPair();
  const credentialHashes = await buildCredentialHashes(credentials);
  const amendment = await serializeForInstance(params.contractInstanceId, async () => {
    const tx = db.transaction(["instances", "amendments"], "readwrite");
    tx.done.catch(() => void 0);
    try {
      const instanceStore = tx.objectStore("instances");
      const amendmentStore = tx.objectStore("amendments");
      const instance = await instanceStore.get(params.contractInstanceId);
      assertSigned(instance, params.contractInstanceId);
      const existing = await amendmentStore.index("byInstance").getAll(params.contractInstanceId);
      if (existing.some((item) => item.status === "pending")) {
        throw new AmendmentError("\u8BE5\u5408\u540C\u5DF2\u6709\u5F85\u53CC\u65B9\u786E\u8BA4\u7684\u53D8\u66F4\uFF0C\u8BF7\u5148\u5B8C\u6210\u786E\u8BA4\u6216\u64A4\u56DE", "PENDING_EXISTS");
      }
      const created = createAmendment({
        id: makeId("amd"),
        contractInstanceId: params.contractInstanceId,
        content: {
          title: params.content.title.trim(),
          reason: params.content.reason.trim(),
          proposedHtml: params.content.proposedHtml
        },
        proposedBy: params.proposedBy,
        credentialHashes,
        now: nowIso()
      });
      await amendmentStore.put(created);
      await tx.done;
      return created;
    } catch (error) {
      tx.abort();
      throw asPersistenceFailure(error);
    }
  });
  return { amendment, credentials };
}
async function respondAmendmentTx(db, params) {
  const preamble = db.transaction("amendments", "readonly");
  const amendmentRef = await preamble.objectStore("amendments").get(params.amendmentId);
  if (!amendmentRef) {
    throw new AmendmentError("\u53D8\u66F4\u8BB0\u5F55\u4E0D\u5B58\u5728", "NOT_FOUND");
  }
  const contractInstanceId = amendmentRef.contractInstanceId;
  const partyFromToken = parseCredentialParty(params.token);
  if (!partyFromToken) {
    throw new CredentialVerificationError(
      "\u51ED\u636E\u683C\u5F0F\u9519\u8BEF\uFF1A\u5E94\u4E3A\u767B\u8BB0\u65F6\u5206\u53D1\u7684\u4E00\u6B21\u6027\u51ED\u636E\uFF08amd-a_\u2026 \u6216 amd-b_\u2026\uFF09\uFF0C\u8BF7\u6838\u5BF9\u540E\u91CD\u8BD5",
      "CREDENTIAL_MALFORMED"
    );
  }
  return serializeForInstance(contractInstanceId, async () => {
    const tokenHash = await hashCredential(params.token);
    const tx = db.transaction(["amendments", "instances", "versions"], "readwrite");
    tx.done.catch(() => void 0);
    try {
      const amendmentStore = tx.objectStore("amendments");
      const instanceStore = tx.objectStore("instances");
      const versionStore = tx.objectStore("versions");
      const amendment = await amendmentStore.get(params.amendmentId);
      if (!amendment) {
        throw new AmendmentError("\u53D8\u66F4\u8BB0\u5F55\u4E0D\u5B58\u5728", "NOT_FOUND");
      }
      if (isTerminal(amendment.status)) {
        throw new AmendmentError(
          `\u53D8\u66F4\u5DF2${amendment.status === "applied" ? "\u751F\u6548" : "\u64A4\u56DE"}\uFF0C\u51ED\u636E\u64CD\u4F5C\u4E0D\u518D\u6709\u6548`,
          "TERMINAL_STATE"
        );
      }
      const party = partyFromToken;
      const slot = amendment.credentials[party];
      if (!slot || !timingSafeEqual(tokenHash, slot.tokenHash)) {
        throw await resolveCredentialMismatch(amendmentStore, amendment, tokenHash);
      }
      const now = nowIso();
      if (slot.used) {
        return {
          amendment,
          applied: false,
          ignored: true,
          party,
          version: void 0,
          instance: void 0
        };
      }
      const result = applyCredentialAction(amendment, party, params.action, now);
      if (params.action === "withdraw" || !result.ready) {
        await amendmentStore.put(result.amendment);
        await tx.done;
        return { amendment: result.amendment, applied: false, party };
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
      return { amendment: applied, applied: true, party, version, instance: nextInstance };
    } catch (error) {
      tx.abort();
      throw asPersistenceFailure(error);
    }
  });
}

// scripts/amendment.test.ts
init_amendmentCredential();
init_amendment();
init_enums();
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
var openDbs = [];
async function resetDb() {
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("deleteDatabase \u88AB\u963B\u585E"));
  });
}
async function openFreshDb(version) {
  const { openDB: openDB2 } = await import("idb");
  const db = await openDB2(DB_NAME, version ?? DB_VERSION, {
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
async function registerHelper(db, inst) {
  const result = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: "\u53D8\u66F41", reason: "\u534F\u5546\u4E00\u81F4", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */
  });
  const tokenA = result.credentials.find((c) => c.party === "partyA" /* PartyA */).token;
  const tokenB = result.credentials.find((c) => c.party === "partyB" /* PartyB */).token;
  return { amendment: result.amendment, tokenA, tokenB };
}
var confirmA = (db, amendmentId, token) => respondAmendmentTx(db, { amendmentId, token, action: "confirm" });
var confirmB = (db, amendmentId, token) => respondAmendmentTx(db, { amendmentId, token, action: "confirm" });
var withdraw = (db, amendmentId, token) => respondAmendmentTx(db, { amendmentId, token, action: "withdraw" });
test("\u51ED\u636E\uFF1A\u7532\u3001\u4E59\u51ED\u636E\u4E0D\u540C\uFF1B\u524D\u7F00\u51B3\u5B9A\u5F53\u4E8B\u65B9", () => {
  const issued = issueCredentialPair();
  const a = issued.find((c) => c.party === "partyA" /* PartyA */);
  const b = issued.find((c) => c.party === "partyB" /* PartyB */);
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^amd-a_[0-9a-f]{32}$/);
  assert.match(b.token, /^amd-b_[0-9a-f]{32}$/);
  assert.equal(parseCredentialParty(a.token), "partyA" /* PartyA */);
  assert.equal(parseCredentialParty(b.token), "partyB" /* PartyB */);
  assert.equal(parseCredentialParty("amd-a_short"), null);
  assert.equal(parseCredentialParty("totally-wrong"), null);
  assert.equal(parseCredentialParty(" amd-b_" + "1".repeat(32) + " "), "partyB" /* PartyB */);
});
test("\u72B6\u6001\u673A\uFF1A\u767B\u8BB0\u53EA\u843D\u54C8\u5E0C\u69FD\uFF0C\u660E\u6587\u4E0D\u51FA\u73B0\u5728\u8BB0\u5F55\u91CC", async () => {
  const issued = issueCredentialPair();
  const amd = createAmendment({
    id: "amd_1",
    contractInstanceId: "inst_1",
    content: { title: "t", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */,
    credentialHashes: await buildCredentialHashes(issued),
    now: NOW
  });
  const serialized = JSON.stringify(amd);
  for (const credential of issued) {
    assert.ok(!serialized.includes(credential.token), "\u660E\u6587\u51ED\u636E\u4E0D\u5F97\u843D\u5E93");
    const hash = await hashCredential(credential.token);
    const slot = amd.credentials[credential.party];
    assert.equal(slot.tokenHash, hash);
    assert.equal(slot.used, false);
  }
  assert.equal(bothConfirmed(amd), false);
});
test("\u72B6\u6001\u673A\uFF1A\u53CC\u65B9\u5404\u51ED\u5404\u7684\u7968\u786E\u8BA4\u4E00\u6B21\u624D ready\uFF0C\u7968\u4E92\u4E0D\u901A\u7528", async () => {
  const issued = issueCredentialPair();
  let amd = createAmendment({
    id: "amd_1",
    contractInstanceId: "inst_1",
    content: { title: "t", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */,
    credentialHashes: await buildCredentialHashes(issued),
    now: NOW
  });
  const r1 = applyCredentialAction(amd, "partyA" /* PartyA */, "confirm", NOW);
  assert.equal(r1.ready, false);
  assert.equal(partyConfirmed(r1.amendment, "partyA" /* PartyA */), true);
  assert.equal(partyConfirmed(r1.amendment, "partyB" /* PartyB */), false);
  amd = r1.amendment;
  assert.throws(() => applyCredentialAction(amd, "partyA" /* PartyA */, "confirm", NOW), AmendmentError);
  const r2 = applyCredentialAction(amd, "partyB" /* PartyB */, "confirm", NOW);
  assert.equal(r2.ready, true);
  assert.equal(bothConfirmed(r2.amendment), true);
});
test("\u72B6\u6001\u673A\uFF1A\u4EFB\u4E00\u65B9\u51ED\u7968\u64A4\u56DE\u6574\u6761\u5931\u6548\uFF1B\u7EC8\u6001\u52A8\u4F5C\u88AB\u62D2", async () => {
  const issued = issueCredentialPair();
  let amd = createAmendment({
    id: "amd_1",
    contractInstanceId: "inst_1",
    content: { title: "t", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */,
    credentialHashes: await buildCredentialHashes(issued),
    now: NOW
  });
  amd = applyCredentialAction(amd, "partyA" /* PartyA */, "confirm", NOW).amendment;
  amd = applyCredentialAction(amd, "partyB" /* PartyB */, "withdraw", NOW).amendment;
  assert.equal(amd.status, "withdrawn" /* Withdrawn */);
  assert.equal(amd.withdrawnBy, "partyB" /* PartyB */);
  assert.equal(amd.credentials["partyB" /* PartyB */].usedFor, "withdraw");
  assert.throws(() => applyCredentialAction(amd, "partyB" /* PartyB */, "confirm", NOW), AmendmentError);
});
test("\u72B6\u6001\u673A\uFF1A\u53CC\u65B9\u9F50\u5907\u540E\u624D\u80FD markApplied\uFF0C\u5426\u5219\u62D2\u7EDD", async () => {
  const issued = issueCredentialPair();
  let amd = createAmendment({
    id: "amd_1",
    contractInstanceId: "inst_1",
    content: { title: "t", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */,
    credentialHashes: await buildCredentialHashes(issued),
    now: NOW
  });
  amd = applyCredentialAction(amd, "partyA" /* PartyA */, "confirm", NOW).amendment;
  assert.throws(() => markApplied(amd, "ver_2", 1, NOW), AmendmentError, "\u5355\u65B9\u786E\u8BA4\u4E0D\u80FD\u751F\u6548");
  amd = applyCredentialAction(amd, "partyB" /* PartyB */, "confirm", NOW).amendment;
  const applied = markApplied(amd, "ver_2", 1, NOW);
  assert.equal(applied.status, "applied" /* Applied */);
  assert.equal(applied.appliedVersionId, "ver_2");
  assert.throws(() => markApplied(applied, "ver_3", 2, NOW), AmendmentError, "\u5DF2\u751F\u6548\u4E0D\u80FD\u91CD\u590D\u843D\u4F4D");
});
test("\u4E8B\u52A1\uFF1A\u767B\u8BB0\u8FD4\u56DE\u53CC\u65B9\u4E00\u6B21\u6027\u51ED\u636E\uFF1B\u6B63\u6587/\u7248\u672C\u4E0D\u53D8\uFF1B\u660E\u6587\u4E0D\u8FDB\u5E93", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const result = await registerAmendmentTx(db, {
    contractInstanceId: inst.id,
    content: { title: "\u53D8\u66F41", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */
  });
  assert.equal(result.credentials.length, 2);
  assert.notEqual(result.credentials[0].token, result.credentials[1].token);
  const raw = await db.get("amendments", result.amendment.id);
  const rawText = JSON.stringify(raw);
  for (const credential of result.credentials) {
    assert.ok(!rawText.includes(credential.token));
  }
  assert.equal((await db.get("instances", inst.id)).finalHtml, V1_HTML);
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
test("\u51ED\u636E\u5B89\u5168\uFF1A\u683C\u5F0F\u9519\u8BEF\u3001\u54C8\u5E0C\u4E0D\u7B26\u3001\u8DE8\u53D8\u66F4\u590D\u7528\u4E00\u5F8B\u62D2\u7EDD\uFF0C\u72B6\u6001/\u6B63\u6587/\u7248\u672C\u4E0D\u53D8", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);
  const inst2 = await seedSignedContract(db, signedInstance());
  const second = await registerHelper(db, inst2);
  const badInputs = [
    ["not-a-token", "CREDENTIAL_MALFORMED"],
    [`amd-a_${"0".repeat(32)}`, "CREDENTIAL_UNRECOGNIZED"],
    // 格式合法但全库无此哈希
    [tokenA.slice(0, -1) + (tokenA.endsWith("a") ? "b" : "a"), "CREDENTIAL_UNRECOGNIZED"],
    // 末位篡改
    [second.tokenA, "CREDENTIAL_BOUND_ELSEWHERE"],
    // 命中另一变更
    [tokenB.replace("amd-b_", "amd-a_"), "CREDENTIAL_UNRECOGNIZED"]
    // 换前缀：冒充方槽位无匹配，原哈希也不落在任何甲槽
  ];
  for (const [bad, expected] of badInputs) {
    try {
      await confirmA(db, amendment.id, bad);
      assert.fail(`\u672C\u5E94\u62D2\u7EDD: ${bad}`);
    } catch (error) {
      assert.ok(error instanceof CredentialVerificationError, `\u5E94\u4E3A\u51ED\u636E\u6821\u9A8C\u9519\u8BEF: ${bad}`);
      assert.equal(error.code, expected, `\u9519\u7968\u5F52\u7C7B: ${bad}`);
    }
  }
  const amdAfter = await db.get("amendments", amendment.id);
  assert.equal(amdAfter.status, "pending" /* Pending */);
  assert.equal(amdAfter.credentials["partyA" /* PartyA */].used, false);
  assert.equal(amdAfter.credentials["partyB" /* PartyB */].used, false);
  assert.equal((await db.get("instances", inst.id)).finalHtml, V1_HTML);
  assert.deepEqual(await db.getAllFromIndex("versions", "byInstance", inst.id), []);
  const ok = await confirmA(db, amendment.id, tokenA);
  assert.equal(ok.applied, false);
  assert.equal(ok.party, "partyA" /* PartyA */);
});
test("\u51ED\u636E\u5B89\u5168\uFF1A\u53CD\u67E5\u547D\u4E2D\u53E6\u4E00\u53D8\u66F4\u7684\u4E59\u65B9\u69FD\u4F4D\u4E5F\u5224\u4E3A BIND_ELSEWHERE\uFF0C\u4E14\u4E0D\u5F71\u54CD\u4E24\u6761\u53D8\u66F4", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst1 = await seedSignedContract(db, signedInstance());
  const first = await registerHelper(db, inst1);
  const inst2 = await seedSignedContract(db, signedInstance());
  const second = await registerHelper(db, inst2);
  const error = await confirmA(db, first.amendment.id, second.tokenB).then(() => null, (e) => e);
  assert.ok(error instanceof CredentialVerificationError);
  assert.equal(error.code, "CREDENTIAL_BOUND_ELSEWHERE");
  assert.match(error.message, /另一条变更/);
  for (const item of [first.amendment, second.amendment]) {
    const record = await db.get("amendments", item.id);
    assert.equal(record.status, "pending" /* Pending */);
    assert.equal(record.credentials["partyA" /* PartyA */].used, false);
    assert.equal(record.credentials["partyB" /* PartyB */].used, false);
  }
  await respondAmendmentTx(db, { amendmentId: second.amendment.id, token: second.tokenA, action: "confirm" });
  const done = await respondAmendmentTx(db, { amendmentId: second.amendment.id, token: second.tokenB, action: "confirm" });
  assert.equal(done.applied, true);
});
test("\u51ED\u636E\u5B89\u5168\uFF1A\u53CD\u67E5\u67E5\u8BE2\u5931\u8D25\u5F52\u7C7B UNAVAILABLE\uFF0C\u4E0D\u6539\u72B6\u6001\u4E14\u51ED\u636E\u4ECD\u53EF\u7528", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);
  const failingDb = proxyAmendmentGetAllFailure(db, new Error("cursor unavailable"));
  const foreign = `amd-a_${"f".repeat(32)}`;
  const error = await respondAmendmentTx(failingDb, {
    amendmentId: amendment.id,
    token: foreign,
    action: "confirm"
  }).then(() => null, (e) => e);
  assert.ok(error instanceof CredentialVerificationError);
  assert.equal(error.code, "CREDENTIAL_UNAVAILABLE");
  const amdAfter = await db.get("amendments", amendment.id);
  assert.equal(amdAfter.status, "pending" /* Pending */);
  assert.equal((await db.get("instances", inst.id)).finalHtml, V1_HTML);
  assert.deepEqual(await db.getAllFromIndex("versions", "byInstance", inst.id), []);
  await respondAmendmentTx(db, { amendmentId: amendment.id, token: tokenA, action: "confirm" });
  const done = await respondAmendmentTx(db, { amendmentId: amendment.id, token: tokenB, action: "confirm" });
  assert.equal(done.applied, true);
});
function proxyAmendmentGetAllFailure(db, failure) {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "transaction") {
        return Reflect.get(target, prop, receiver);
      }
      return (...args) => {
        const tx = Reflect.apply(target.transaction, target, args);
        if (tx.mode !== "readwrite") {
          return tx;
        }
        return new Proxy(tx, {
          get(txTarget, txProp, txReceiver) {
            if (txProp !== "objectStore") {
              const value = Reflect.get(txTarget, txProp, txReceiver);
              return typeof value === "function" ? value.bind(txTarget) : value;
            }
            return (name) => {
              const store = Reflect.apply(txTarget.objectStore, txTarget, [name]);
              if (name !== "amendments") {
                return store;
              }
              return new Proxy(store, {
                get(storeTarget, storeProp) {
                  const value = Reflect.get(storeTarget, storeProp);
                  if (storeProp === "getAll") {
                    return () => Promise.reject(failure);
                  }
                  return typeof value === "function" ? value.bind(storeTarget) : value;
                }
              });
            };
          }
        });
      };
    }
  });
}
test("\u51ED\u636E\u5B89\u5168\uFF1A\u540C\u4E00\u51ED\u636E\u7B2C\u4E8C\u6B21\u63D0\u4EA4\u4E0D\u4EA7\u751F\u4EFB\u4F55\u6548\u679C\uFF08\u5E42\u7B49\u5FFD\u7565\uFF0C\u65E0\u5199\u5165\u65E0\u7248\u672C\uFF09", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA } = await registerHelper(db, inst);
  const first = await confirmA(db, amendment.id, tokenA);
  assert.equal(first.applied, false);
  const firstRecord = await db.get("amendments", amendment.id);
  assert.equal(firstRecord.credentials["partyA" /* PartyA */].used, true);
  const repeat = await confirmA(db, amendment.id, tokenA);
  assert.equal(repeat.ignored, true);
  assert.equal(repeat.applied, false);
  const secondRecord = await db.get("amendments", amendment.id);
  assert.equal(secondRecord.updatedAt, firstRecord.updatedAt);
  assert.equal(secondRecord.timeline.length, firstRecord.timeline.length);
  await confirmA(db, amendment.id, tokenA);
  await confirmA(db, amendment.id, tokenA);
  assert.deepEqual(await db.getAllFromIndex("versions", "byInstance", inst.id), []);
  assert.equal((await db.get("amendments", amendment.id)).status, "pending" /* Pending */);
});
test("\u51ED\u636E\u5B89\u5168\uFF1A\u6301\u7968\u64A4\u56DE\u4E00\u6B21\u6027\uFF1B\u64A4\u56DE\u540E\u51ED\u636E\u518D\u7528\u65E0\u6548\uFF1B\u53E6\u4E00\u7968\u786E\u8BA4\u88AB\u62D2", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);
  await confirmA(db, amendment.id, tokenA);
  const w = await withdraw(db, amendment.id, tokenB);
  assert.equal(w.amendment.status, "withdrawn" /* Withdrawn */);
  assert.equal(w.amendment.credentials["partyB" /* PartyB */].usedFor, "withdraw");
  await assertTerminalRejection(withdraw(db, amendment.id, tokenB));
  await assertTerminalRejection(confirmB(db, amendment.id, tokenB));
  await assertTerminalRejection(confirmA(db, amendment.id, tokenA));
  assert.equal((await db.get("instances", inst.id)).finalHtml, V1_HTML);
  assert.deepEqual(await db.getAllFromIndex("versions", "byInstance", inst.id), []);
});
async function assertTerminalRejection(promise) {
  await assert.rejects(
    promise.then(() => {
      throw new Error("\u672C\u5E94\u62D2\u7EDD");
    }),
    (error) => error instanceof AmendmentError && error.code === "TERMINAL_STATE"
  );
}
test("\u6B63\u5E38\u6D41\u7A0B\uFF1A\u53CC\u65B9\u5404\u51ED\u5408\u6CD5\u7968\u786E\u8BA4\u4E00\u6B21\u540E\uFF0C\u540C\u4E8B\u52A1\u751F\u6210\u65B0\u7248\u672C\u5E76\u66FF\u6362\u6B63\u6587", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);
  const a = await confirmA(db, amendment.id, tokenA);
  assert.equal(a.applied, false);
  assert.equal((await db.get("instances", inst.id)).finalHtml, V1_HTML);
  const b = await confirmB(db, amendment.id, tokenB);
  assert.equal(b.applied, true);
  assert.equal(b.party, "partyB" /* PartyB */);
  const instAfter = await db.get("instances", inst.id);
  const versions = await db.getAllFromIndex("versions", "byInstance", inst.id);
  const amdAfter = await db.get("amendments", amendment.id);
  assert.equal(instAfter.finalHtml, V2_HTML);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].versionNo, 1);
  assert.equal(instAfter.versionIds.includes(versions[0].id), true);
  assert.equal(amdAfter.status, "applied" /* Applied */);
  assert.equal(amdAfter.appliedVersionId, versions[0].id);
  assert.equal(amdAfter.credentials["partyA" /* PartyA */].usedFor, "confirm");
  assert.equal(amdAfter.credentials["partyB" /* PartyB */].usedFor, "confirm");
  await assert.rejects(confirmA(db, amendment.id, tokenA), AmendmentError);
  const versionsAfter = await db.getAllFromIndex("versions", "byInstance", inst.id);
  assert.equal(versionsAfter.length, 1);
});
test("\u5E76\u53D1\uFF1A\u4E24\u7968\u786E\u8BA4\u4E0E\u4E00\u7968\u64A4\u56DE\u8D5B\u8DD1\uFF0C\u6C38\u8FDC\u4E0D\u4F1A\u51FA\u73B0\u5DF2\u64A4\u56DE\u5374\u5DF2\u751F\u6548", async () => {
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
    const amdAfter = await db.get("amendments", amendment.id);
    const versions = await db.getAllFromIndex("versions", "byInstance", inst.id);
    const instAfter = await db.get("instances", inst.id);
    if (amdAfter.status === "applied" /* Applied */) {
      assert.equal(versions.length, 1);
      assert.equal(instAfter.finalHtml, V2_HTML);
      assert.equal(amdAfter.appliedVersionId, versions[0].id);
    } else {
      assert.equal(amdAfter.status, "withdrawn" /* Withdrawn */);
      assert.equal(versions.length, 0);
      assert.equal(instAfter.finalHtml, V1_HTML);
    }
  }
});
test("\u5E76\u53D1\uFF1A\u540C\u4E00\u679A\u7968\u540C\u65F6\u63D0\u4EA4\u4E24\u6B21\uFF0C\u53EA\u4EA7\u751F\u4E00\u6B21\u6548\u679C", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);
  const [r1, r2] = await Promise.all([confirmA(db, amendment.id, tokenA), confirmA(db, amendment.id, tokenA)]);
  const outcomes = [r1, r2];
  assert.equal(outcomes.filter((r) => r.ignored).length, 1, "\u6070\u597D\u4E00\u6B21\u6709\u6548\uFF0C\u4E00\u6B21\u5FFD\u7565");
  const amdAfter = await db.get("amendments", amendment.id);
  assert.equal(amdAfter.status, "pending" /* Pending */);
  assert.equal(amdAfter.credentials["partyA" /* PartyA */].used, true);
  assert.equal(amdAfter.credentials["partyB" /* PartyB */].used, false);
  assert.deepEqual(await db.getAllFromIndex("versions", "byInstance", inst.id), []);
  const done = await confirmB(db, amendment.id, tokenB);
  assert.equal(done.applied, true);
});
test("\u56DE\u6EDA\uFF1A\u53CC\u65B9\u786E\u8BA4\u9F50\u5907\u4F46\u843D\u5E93\u5931\u8D25\u65F6\uFF0C\u6B63\u6587/\u53D8\u66F4\u8BB0\u5F55/\u7248\u672C\u53F7\u4E00\u8D77\u4E0D\u53D8", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);
  await confirmA(db, amendment.id, tokenA);
  await db.delete("instances", inst.id);
  await assert.rejects(confirmB(db, amendment.id, tokenB), AmendmentError);
  const amdAfter = await db.get("amendments", amendment.id);
  assert.equal(amdAfter.status, "pending" /* Pending */);
  assert.equal(amdAfter.credentials["partyA" /* PartyA */].used, true);
  assert.equal(amdAfter.credentials["partyB" /* PartyB */].used, false, "\u4E59\u65B9\u786E\u8BA4\u4E0D\u843D\u5E93");
  assert.deepEqual(await db.getAll("versions"), []);
  await db.put("instances", inst);
  const retry = await confirmB(db, amendment.id, tokenB);
  assert.equal(retry.applied, true, "\u5931\u8D25\u540E\u5408\u6CD5\u51ED\u636E\u4ECD\u53EF\u5B8C\u6210\u786E\u8BA4");
  const amdRetry = await db.get("amendments", amendment.id);
  assert.equal(amdRetry.status, "applied" /* Applied */);
  assert.equal((await db.get("instances", inst.id)).finalHtml, V2_HTML);
});
test("\u56DE\u6EDA\uFF1A\u771F\u6B63\u7684\u5199\u5165\u5931\u8D25\u5F52\u7C7B\u4E3A PERSISTENCE_FAILED\uFF0C\u56DE\u6EDA\u540E\u51ED\u636E\u4ECD\u53EF\u7528", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);
  await confirmA(db, amendment.id, tokenA);
  const failingDb = proxyNextPutFailure(db, "versions", new Error("disk full"));
  const error = await confirmB(failingDb, amendment.id, tokenB).then(
    () => null,
    (reason) => reason
  );
  assert.ok(error instanceof AmendmentError, "\u5E94\u5305\u88C5\u4E3A AmendmentError");
  assert.equal(error.code, "PERSISTENCE_FAILED");
  const amdAfter = await db.get("amendments", amendment.id);
  assert.equal(amdAfter.status, "pending" /* Pending */);
  assert.equal(amdAfter.credentials["partyB" /* PartyB */].used, false);
  assert.deepEqual(await db.getAllFromIndex("versions", "byInstance", inst.id), []);
  assert.equal((await db.get("instances", inst.id)).finalHtml, V1_HTML);
  const retry = await confirmB(db, amendment.id, tokenB);
  assert.equal(retry.applied, true);
  assert.equal((await db.get("instances", inst.id)).finalHtml, V2_HTML);
});
function proxyNextPutFailure(db, storeName, failure) {
  let armed = true;
  const wrapStore = (store) => new Proxy(store, {
    get(target, prop) {
      if (prop === "put" && armed) {
        return (..._args) => {
          armed = false;
          throw failure;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "transaction") {
        return Reflect.get(target, prop, receiver);
      }
      return (...args) => {
        const tx = Reflect.apply(target.transaction, target, args);
        if (tx.mode !== "readwrite") {
          return tx;
        }
        return new Proxy(tx, {
          get(txTarget, txProp, txReceiver) {
            if (txProp !== "objectStore") {
              const value = Reflect.get(txTarget, txProp, txReceiver);
              return typeof value === "function" ? value.bind(txTarget) : value;
            }
            return (name) => {
              const store = Reflect.apply(txTarget.objectStore, txTarget, [name]);
              return name === storeName ? wrapStore(store) : store;
            };
          }
        });
      };
    }
  });
}
test("\u53CD\u9988\u5206\u7C7B\uFF1AclassifyCredentialError \u80FD\u533A\u5206\u51ED\u636E/\u7EC8\u6001/\u843D\u5E93\u5931\u8D25", async () => {
  const { classifyCredentialError: classifyCredentialError2 } = await Promise.resolve().then(() => (init_amendmentFeedback(), amendmentFeedback_exports));
  assert.equal(classifyCredentialError2(new CredentialVerificationError("x", "CREDENTIAL_MALFORMED")).reason, "CREDENTIAL_MALFORMED");
  assert.equal(classifyCredentialError2(new AmendmentError("\u5DF2\u751F\u6548", "TERMINAL_STATE")).reason, "TERMINAL_STATE");
  assert.equal(classifyCredentialError2(new Error("boom")).reason, "PERSISTENCE_FAILED");
  assert.equal(classifyCredentialError2("string-error").reason, "PERSISTENCE_FAILED");
});
test("\u56DE\u8BFB\uFF1A\u751F\u6548\u540E\u91CD\u5F00\u6570\u636E\u5E93\uFF0C\u51ED\u636E\u72B6\u6001/\u6B63\u6587/\u7248\u672C\u4E00\u81F4", async () => {
  await resetDb();
  const db = await openFreshDb();
  const inst = await seedSignedContract(db);
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);
  await confirmA(db, amendment.id, tokenA);
  await confirmB(db, amendment.id, tokenB);
  db.close();
  const reopened = await openFreshDb();
  const instAfter = await reopened.get("instances", inst.id);
  const versions = await reopened.getAllFromIndex("versions", "byInstance", inst.id);
  const amdAfter = await reopened.get("amendments", amendment.id);
  assert.equal(instAfter.finalHtml, V2_HTML);
  assert.equal(versions.length, 1);
  assert.equal(amdAfter.status, "applied" /* Applied */);
  assert.equal(instAfter.versionIds[0], versions[0].id);
});
test("\u7248\u672C\u53F7\uFF1A\u5728 v1 \u57FA\u7840\u4E0A\u53CC\u65B9\u786E\u8BA4\uFF0C\u65B0\u7248\u672C\u53F7\u4E25\u683C\u9012\u589E\u4E3A v2", async () => {
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
  const { amendment, tokenA, tokenB } = await registerHelper(db, inst);
  await confirmA(db, amendment.id, tokenA);
  const outcome = await confirmB(db, amendment.id, tokenB);
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
test("\u8FC1\u79FB\uFF1Av1\u2192v3 \u5168\u65B0\u5347\u7EA7\u8DEF\u5F84\uFF0C\u65E7\u6570\u636E\u4FDD\u7559\u4E14\u53EF\u8D70\u51ED\u636E\u6D41\u7A0B", async () => {
  await resetDb();
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
  assert.equal(migrated.version, DB_VERSION);
  assert.equal(migrated.objectStoreNames.contains("amendments"), true);
  const inspect = migrated.transaction("versions", "readonly");
  assert.equal(inspect.objectStore("versions").indexNames.contains("byInstance"), true);
  await inspect.done;
  const result = await registerAmendmentTx(migrated, {
    contractInstanceId: "inst_legacy",
    content: { title: "\u8FC1\u79FB\u540E\u53D8\u66F4", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */
  });
  const tokenA = result.credentials.find((c) => c.party === "partyA" /* PartyA */).token;
  const tokenB = result.credentials.find((c) => c.party === "partyB" /* PartyB */).token;
  await respondAmendmentTx(migrated, { amendmentId: result.amendment.id, token: tokenA, action: "confirm" });
  const outcome = await respondAmendmentTx(migrated, { amendmentId: result.amendment.id, token: tokenB, action: "confirm" });
  assert.equal(outcome.applied, true);
  assert.equal(outcome.version?.versionNo, 2, "\u7248\u672C\u53F7\u5728\u8001 v1 \u57FA\u7840\u4E0A\u7EED\u63A5");
});
test("\u8FC1\u79FB\uFF1Av2 \u81EA\u62A5\u8EAB\u4EFD\u8BB0\u5F55\u5347\u7EA7\u5230 v3 \u51ED\u636E\u6A21\u578B", async () => {
  await resetDb();
  const { openDB: openDB2 } = await import("idb");
  const instApplied = signedInstance("inst_v2_applied");
  const instPending = signedInstance("inst_v2_pending");
  const instWithdrawn = signedInstance("inst_v2_withdrawn");
  const v2db = await openDB2(DB_NAME, 2, {
    upgrade(db) {
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: "id" });
          if (name === "versions" || name === "amendments") {
            store.createIndex("byInstance", "contractInstanceId");
          }
        }
      }
    }
  });
  await Promise.all([instApplied, instPending, instWithdrawn].map((i) => v2db.put("instances", i)));
  const v2Amendment = (id, contractInstanceId, extra) => ({
    id,
    contractInstanceId,
    title: "\u65E7\u7248\u53D8\u66F4",
    reason: "",
    proposedHtml: V2_HTML,
    status: "pending" /* Pending */,
    confirmedParties: [],
    proposedBy: "partyA" /* PartyA */,
    proposedAt: NOW,
    updatedAt: NOW,
    timeline: [{ action: "created", party: "partyA" /* PartyA */, at: NOW }],
    ...extra
  });
  await v2db.put(
    "amendments",
    v2Amendment("amd_applied", instApplied.id, {
      status: "applied" /* Applied */,
      confirmedParties: ["partyA" /* PartyA */, "partyB" /* PartyB */],
      appliedAt: NOW,
      appliedVersionId: "ver_old",
      baseVersionNo: 1
    })
  );
  await v2db.put("amendments", v2Amendment("amd_pending", instPending.id, { confirmedParties: ["partyA" /* PartyA */] }));
  await v2db.put(
    "amendments",
    v2Amendment("amd_withdrawn", instWithdrawn.id, {
      status: "withdrawn" /* Withdrawn */,
      confirmedParties: ["partyA" /* PartyA */],
      withdrawnBy: "partyB" /* PartyB */,
      withdrawnAt: NOW
    })
  );
  v2db.close();
  const migrated = await openAppDb();
  openDbs.push(migrated);
  assert.equal(migrated.version, 3);
  const applied = await migrated.get("amendments", "amd_applied");
  assert.equal(applied.status, "applied" /* Applied */);
  assert.equal(applied.credentials["partyA" /* PartyA */].usedFor, "confirm");
  assert.equal(applied.credentials["partyB" /* PartyB */].usedFor, "confirm");
  assert.equal("confirmedParties" in applied, false);
  const pending = await migrated.get("amendments", "amd_pending");
  assert.equal(pending.status, "withdrawn" /* Withdrawn */, "\u65E7\u5728\u9014\u8BB0\u5F55\u65E0\u51ED\u636E\u53EF\u5BF9\u5E94\uFF0C\u5FC5\u987B\u4F5C\u5E9F");
  assert.equal(pending.credentials["partyA" /* PartyA */].used, false);
  const withdrawn = await migrated.get("amendments", "amd_withdrawn");
  assert.equal(withdrawn.status, "withdrawn" /* Withdrawn */);
  assert.equal(withdrawn.credentials["partyA" /* PartyA */].usedFor, "confirm");
  assert.equal(withdrawn.credentials["partyB" /* PartyB */].usedFor, "withdraw");
  const token = issueCredentialPair()[0].token;
  await assert.rejects(
    respondAmendmentTx(migrated, { amendmentId: "amd_pending", token, action: "confirm" }),
    AmendmentError
  );
  const pendingAfter = await migrated.get("amendments", "amd_pending");
  assert.equal(pendingAfter.status, "withdrawn" /* Withdrawn */);
  const re = await registerAmendmentTx(migrated, {
    contractInstanceId: instPending.id,
    content: { title: "\u91CD\u65B0\u767B\u8BB0", reason: "", proposedHtml: V2_HTML },
    proposedBy: "partyA" /* PartyA */
  });
  assert.equal(re.amendment.status, "pending" /* Pending */);
});
test("getDb \u5355\u4F8B\uFF1Av3 \u6253\u5F00\u540E\u5305\u542B amendments \u4E0E byInstance \u7D22\u5F15", async () => {
  await resetDb();
  const db = await getDb();
  assert.equal(db.version, DB_VERSION);
  assert.equal(db.objectStoreNames.contains("amendments"), true);
  const tx = db.transaction("versions", "readonly");
  assert.equal(tx.objectStore("versions").indexNames.contains("byInstance"), true);
  await tx.done;
});
