import type { IDBPDatabase } from 'idb';
import { Amendment, AmendmentContent, CredentialAction, IssuedCredential } from '../types/amendment';
import { ContractInstance } from '../types/contract-instance';
import { ContractParty, ContractStatus } from '../types/enums';
import { Version } from '../types/version';
import { makeId, nowIso } from './db';
import { AmendmentError, applyCredentialAction, buildCredentialHashes, createAmendment, isTerminal, markApplied } from './amendmentMachine';
import { hashCredential, issueCredentialPair, parseCredentialParty, timingSafeEqual } from './amendmentCredential';

/**
 * 每份合同一条串行队列。
 *
 * IndexedDB 的读事务之间不互斥，「确认」与「撤回」若并发读到同一条 pending
 * 记录，会各自产生一个终态。用 per-instance 的 Promise 链把同一份合同的
 * 登记 / 确认 / 撤回全部串行化：后到的请求一定能看到先到请求的提交结果，
 * 然后被票证/状态规则拒绝，因此确认与撤回同时到达时只会落地其中一个，
 * 且合同正文、变更记录、版本号保持互相一致。
 */
const locks = new Map<string, Promise<unknown>>();

export function serializeForInstance<T>(contractInstanceId: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(contractInstanceId) ?? Promise.resolve();
  const current = previous.then(task, task);
  const tracked = current.catch(() => undefined).then(() => {
    if (locks.get(contractInstanceId) === tracked) {
      locks.delete(contractInstanceId);
    }
  });
  locks.set(contractInstanceId, tracked);
  return current;
}

/** 凭据问题（格式错误 / 跨变更复用 / 哈希不符）；已使用凭据不走异常而走 ignored */
export class CredentialVerificationError extends AmendmentError {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialVerificationError';
  }
}

export interface RegisterResult {
  amendment: Amendment;
  /**
   * 甲、乙各自的一次性明文凭据。只在登记成功时返回这一次，数据库不存明文；
   * 必须分别安全地转交给对应一方。
   */
  credentials: IssuedCredential[];
}

export interface RespondOutcome {
  amendment: Amendment;
  /** 本次动作是否促成生效（双方确认齐备并成功生成新版本） */
  applied: boolean;
  /** 持票人对应的当事方（验票通过后由票据前缀确定，调用方不能自报） */
  party?: ContractParty;
  /** 已使用凭据再次提交：业务上无任何效果 */
  ignored?: boolean;
  version?: Version;
  instance?: ContractInstance;
}

function assertSigned(instance: ContractInstance | undefined, contractInstanceId: string): asserts instance is ContractInstance {
  if (!instance) {
    throw new AmendmentError('合同实例不存在，无法登记变更');
  }
  if (instance.status !== ContractStatus.Signed) {
    throw new AmendmentError('仅已签署合同可以提出变更');
  }
}

/**
 * 登记变更（唯一入口）：
 * 为甲、乙各签发一枚不同的一次性凭据，库内仅保存其 SHA-256；合同正文不动。
 */
export async function registerAmendmentTx(
  db: IDBPDatabase,
  params: { contractInstanceId: string; content: AmendmentContent; proposedBy: ContractParty }
): Promise<RegisterResult> {
  if (!params.content.proposedHtml.replace(/<[^>]*>/g, '').trim()) {
    throw new AmendmentError('变更后正文不能为空');
  }
  if (!params.content.title.trim()) {
    throw new AmendmentError('变更标题不能为空');
  }

  // 明文凭据在事务外生成、哈希在事务外算好（异步 digest 不能放在事务内 await）
  const credentials = issueCredentialPair();
  const credentialHashes = await buildCredentialHashes(credentials);

  const amendment = await serializeForInstance(params.contractInstanceId, async () => {
    const tx = db.transaction(['instances', 'amendments'], 'readwrite');
    // abort 时 tx.done 以 AbortError reject；业务错误已通过 throw 传播
    tx.done.catch(() => undefined);
    try {
      const instanceStore = tx.objectStore('instances');
      const amendmentStore = tx.objectStore('amendments');

      const instance = (await instanceStore.get(params.contractInstanceId)) as ContractInstance | undefined;
      assertSigned(instance, params.contractInstanceId);

      const existing = (await amendmentStore.index('byInstance').getAll(params.contractInstanceId)) as Amendment[];
      if (existing.some((item) => item.status === 'pending')) {
        throw new AmendmentError('该合同已有待双方确认的变更，请先完成确认或撤回');
      }

      const created = createAmendment({
        id: makeId('amd'),
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
      throw error;
    }
  });

  return { amendment, credentials };
}

/**
 * 凭一次性凭据执行确认 / 撤回。
 *
 * 校验全部发生在串行锁内、且与后续写入处于同一个 readwrite 事务：
 * 1. 凭据格式非法               -> 抛 invalid，不做任何写入；
 * 2. 凭据与本变更任一侧哈希不符 -> 抛 invalid（含跨变更复用、他方票据改前缀）；
 * 3. 凭据已使用                 -> ignored 返回，状态/正文/版本一律不变；
 * 4. 双方确认齐备               -> 同事务生成新版本 + 替换正文 + 推进变更记录，
 *    任一步失败整体 abort，三者一起保持不变。
 */
export async function respondAmendmentTx(
  db: IDBPDatabase,
  params: { amendmentId: string; token: string; action: CredentialAction }
): Promise<RespondOutcome> {
  // 只读前导：定位变更所属合同以加锁；不改变任何数据
  const preamble = db.transaction('amendments', 'readonly');
  const amendmentRef = (await preamble.objectStore('amendments').get(params.amendmentId)) as Amendment | undefined;
  if (!amendmentRef) {
    throw new AmendmentError('变更记录不存在');
  }
  const contractInstanceId = amendmentRef.contractInstanceId;

  // 格式预检在锁外即可失败（不依赖库内状态）
  const partyFromToken = parseCredentialParty(params.token);
  if (!partyFromToken) {
    throw new CredentialVerificationError('凭据格式不正确：应为登记时分发的一次性确认凭据');
  }

  return serializeForInstance(contractInstanceId, async () => {
    // SHA-256 是异步操作，必须在开启事务前完成，否则事务会在 await 期间自动关闭
    const tokenHash = await hashCredential(params.token);

    const tx = db.transaction(['amendments', 'instances', 'versions'], 'readwrite');
    tx.done.catch(() => undefined);
    try {
      const amendmentStore = tx.objectStore('amendments');
      const instanceStore = tx.objectStore('instances');
      const versionStore = tx.objectStore('versions');

      const amendment = (await amendmentStore.get(params.amendmentId)) as Amendment | undefined;
      if (!amendment) {
        throw new AmendmentError('变更记录不存在');
      }
      if (isTerminal(amendment.status)) {
        throw new AmendmentError(`变更已${amendment.status === 'applied' ? '生效' : '撤回'}，操作无效`);
      }

      // —— 验票：当事方由票据前缀决定（锁外已解析），哈希必须与库内槽位一致 ——
      const party = partyFromToken;
      const slot = amendment.credentials[party];
      if (!slot) {
        throw new CredentialVerificationError('该凭据不属于本变更的任何一方');
      }
      if (!timingSafeEqual(tokenHash, slot.tokenHash)) {
        // 跨变更复用、他方票据、伪造票据都落在这里
        throw new CredentialVerificationError('凭据校验失败：与本变更登记时分发的凭据不匹配');
      }

      const now = nowIso();

      // —— 一次性：已用凭据再次提交，不产生第二次效果（无写入、无版本、无正文改动）——
      if (slot.used) {
        return {
          amendment,
          applied: false,
          ignored: true,
          party,
          version: undefined,
          instance: undefined
        };
      }

      const result = applyCredentialAction(amendment, party, params.action, now);

      if (params.action === 'withdraw' || !result.ready) {
        await amendmentStore.put(result.amendment);
        await tx.done;
        return { amendment: result.amendment, applied: false, party };
      }

      // —— 双方各凭合法凭据确认一次：以下所有写入同生共死 ——
      const instance = (await instanceStore.get(contractInstanceId)) as ContractInstance | undefined;
      assertSigned(instance, contractInstanceId);

      const related = (await versionStore.index('byInstance').getAll(contractInstanceId)) as Version[];
      const baseVersionNo = related.reduce((max, version) => Math.max(max, version.versionNo), 0);
      const nextVersionNo = baseVersionNo + 1;

      const version: Version = {
        id: makeId('ver'),
        contractInstanceId,
        versionNo: nextVersionNo,
        contentSnapshot: result.amendment.proposedHtml,
        variableSnapshot: { ...instance.variableValues },
        createdAt: now,
        remark: `合同变更生效：${result.amendment.title}`
      };
      await versionStore.put(version);

      const nextInstance: ContractInstance = {
        ...instance,
        finalHtml: result.amendment.proposedHtml,
        versionIds: Array.from(new Set([...instance.versionIds, version.id])),
        updatedAt: now
      };
      await instanceStore.put(nextInstance);

      const applied = markApplied(result.amendment, version.id, baseVersionNo, now);
      await amendmentStore.put(applied);

      await tx.done;
      return { amendment: applied, applied: true, party, version, instance: nextInstance };
    } catch (error) {
      // 任何失败（含生成新版本失败、落库异常）：整体回滚，正文/变更记录/版本号均不变
      tx.abort();
      throw error;
    }
  });
}
