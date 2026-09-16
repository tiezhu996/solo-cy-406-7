import type { IDBPDatabase } from 'idb';
import { Amendment, AmendmentContent } from '../types/amendment';
import { ContractInstance } from '../types/contract-instance';
import { ContractParty, ContractStatus } from '../types/enums';
import { Version } from '../types/version';
import { makeId, nowIso } from './db';
import {
  AmendmentError,
  confirmAmendment,
  createAmendment,
  isTerminal,
  markApplied,
  withdrawAmendment
} from './amendmentMachine';

/**
 * 每份合同一条串行队列。
 *
 * IndexedDB 的读事务之间不互斥，「确认」与「撤回」若并发读到同一条 pending
 * 记录，会各自产生一个终态。用 per-instance 的 Promise 链把同一份合同的
 * 登记 / 确认 / 撤回全部串行化：后到的请求一定能看到先到请求的提交结果，
 * 然后被状态机以终态规则拒绝，因此确认与撤回同时到达时只会落地其中一个，
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

export interface RegisterParams {
  contractInstanceId: string;
  content: AmendmentContent;
  proposedBy: ContractParty;
}

export interface RespondOutcome {
  amendment: Amendment;
  /** 本次动作是否促成生效（双方确认齐备并成功生成新版本） */
  applied: boolean;
  /** 生效时同事务产出的新版本与替换后的合同实例 */
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

/** 登记变更（单一入口，仅校验通过后写入 amendments；合同正文不动） */
export async function registerAmendmentTx(db: IDBPDatabase, params: RegisterParams): Promise<Amendment> {
  if (!params.content.proposedHtml.trim()) {
    throw new AmendmentError('变更后正文不能为空');
  }
  if (!params.content.title.trim()) {
    throw new AmendmentError('变更标题不能为空');
  }

  return serializeForInstance(params.contractInstanceId, async () => {
    const tx = db.transaction(['instances', 'amendments'], 'readwrite');
    // abort 时 tx.done 会以 AbortError reject；业务错误已通过下方 throw 传播，
    // 这里吞掉 abort 自身的 rejection，避免出现无人消费的 unhandledRejection
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

      const amendment = createAmendment({
        id: makeId('amd'),
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

/**
 * 确认 / 撤回的统一事务入口。
 *
 * 关键不变量：当第二个确认使双方齐备时，新版本生成、正文替换、变更记录
 * 推进到 applied 必须发生在【同一个 readwrite 事务】内。任一步失败都会
 * abort，三者一起回到事务前状态。
 */
export async function respondAmendmentTx(
  db: IDBPDatabase,
  params: { amendmentId: string; party: ContractParty; action: 'confirm' | 'withdraw' }
): Promise<RespondOutcome> {
  // 先读出所属合同用于加锁；这一步只读，不改变任何数据
  const preamble = db.transaction('amendments', 'readonly');
  const amendmentRef = (await preamble.objectStore('amendments').get(params.amendmentId)) as Amendment | undefined;
  if (!amendmentRef) {
    throw new AmendmentError('变更记录不存在');
  }
  const contractInstanceId = amendmentRef.contractInstanceId;

  return serializeForInstance(contractInstanceId, async () => {
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

      const now = nowIso();

      if (params.action === 'withdraw') {
        const next = withdrawAmendment(amendment, params.party, now);
        await amendmentStore.put(next);
        await tx.done;
        return { amendment: next, applied: false };
      }

      const result = confirmAmendment(amendment, params.party, now);

      // 同一方重复确认：幂等，仅留审计轨迹，绝不触碰正文与版本
      if (result.ignored || !result.ready) {
        await amendmentStore.put(result.amendment);
        await tx.done;
        return { amendment: result.amendment, applied: false };
      }

      // —— 双方确认齐备：以下所有写入同生共死 ——
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
      return { amendment: applied, applied: true, version, instance: nextInstance };
    } catch (error) {
      // 任何失败（含生成新版本失败）：整体回滚，正文 / 变更记录 / 版本号均不变
      tx.abort();
      throw error;
    }
  });
}
