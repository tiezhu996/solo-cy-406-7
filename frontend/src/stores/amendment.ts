import { create } from 'zustand';
import { amendmentDb } from '../api/db';
import { Amendment, AmendmentContent, CredentialAction, IssuedCredential } from '../types/amendment';
import { ContractParty } from '../types/enums';
import { AmendmentErrorCode } from '../utils/amendmentMachine';
import { Version } from '../types/version';
import { getDb, putRecord } from '../utils/db';
import { buildSeedAmendments } from '../utils/seed';
import { registerAmendmentTx, respondAmendmentTx } from '../utils/amendmentTx';
import { classifyCredentialError } from '../utils/amendmentFeedback';
import { useInstanceStore } from './instance';
import { useVersionStore } from './version';

interface RegisterOutcome {
  amendment: Amendment;
  /** 甲、乙各自的一次性凭据，明文只在此出现一次 */
  credentials: IssuedCredential[];
}

/**
 * 凭据操作的判别结果。UI 必须能区分三种情况：
 * - ok：确认 / 撤回已落库（applied 表示本次恰好促成双方确认、新版本已生成）；
 * - ignored：凭据真实有效但已使用，幂等忽略，状态没有任何变化；
 * - rejected：凭据或状态不被接受（reason 给出原因码），或落库失败（事务已回滚）。
 * 任何 rejected 都不改变持久化状态，合法凭据仍可继续完成确认或撤回。
 */
export type CredentialResponse =
  | { kind: 'ok'; amendment: Amendment; applied: boolean; party: ContractParty; version?: Version; instanceId?: string }
  | { kind: 'ignored'; amendment: Amendment; party: ContractParty }
  | { kind: 'rejected'; reason: AmendmentErrorCode; message: string; amendment: Amendment | null };

interface AmendmentState {
  amendments: Amendment[];
  loading: boolean;
  /** 正在处理的动作 key，用于禁用按钮、串行化 UI */
  pendingKey: string | null;
  loadAmendments: () => Promise<void>;
  registerAmendment: (params: {
    contractInstanceId: string;
    content: AmendmentContent;
    proposedBy: ContractParty;
  }) => Promise<RegisterOutcome>;
  /** 凭一次性凭据确认；永不向调用方抛异常，结果以判别联合返回 */
  confirm: (amendmentId: string, token: string) => Promise<CredentialResponse>;
  /** 凭一次性凭据撤回；永不向调用方抛异常，结果以判别联合返回 */
  withdraw: (amendmentId: string, token: string) => Promise<CredentialResponse>;
}

function sortAmendments(amendments: Amendment[]) {
  return [...amendments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function upsert(list: Amendment[], amendment: Amendment) {
  const exists = list.some((item) => item.id === amendment.id);
  return sortAmendments(exists ? list.map((item) => (item.id === amendment.id ? amendment : item)) : [amendment, ...list]);
}

function sortVersions(versions: Version[], version: Version) {
  return [...versions.filter((item) => item.id !== version.id), version].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const useAmendmentStore = create<AmendmentState>((set, get) => ({
  amendments: [],
  loading: false,
  pendingKey: null,

  async loadAmendments() {
    set({ loading: true });
    try {
      let amendments = await amendmentDb.list();
      if (!amendments.length) {
        const seedAmendments = await buildSeedAmendments();
        await Promise.all(seedAmendments.map((amendment) => putRecord('amendments', amendment)));
        amendments = seedAmendments;
      }
      set({ amendments: sortAmendments(amendments) });
    } finally {
      set({ loading: false });
    }
  },

  async registerAmendment(params) {
    set({ pendingKey: `register:${params.contractInstanceId}` });
    try {
      const db = await getDb();
      const result = await registerAmendmentTx(db, params);
      set((state) => ({ amendments: upsert(state.amendments, result.amendment) }));
      return result;
    } finally {
      set({ pendingKey: null });
    }
  },

  async confirm(amendmentId, token) {
    return runCredentialAction(set, get, amendmentId, token, 'confirm');
  },

  async withdraw(amendmentId, token) {
    return runCredentialAction(set, get, amendmentId, token, 'withdraw');
  }
}));

async function runCredentialAction(
  set: (partial: Partial<AmendmentState> | ((state: AmendmentState) => Partial<AmendmentState>)) => void,
  get: () => AmendmentState,
  amendmentId: string,
  token: string,
  action: CredentialAction
): Promise<CredentialResponse> {
  set({ pendingKey: `${action}:${amendmentId}` });
  try {
    const db = await getDb();
    const outcome = await respondAmendmentTx(db, { amendmentId, token: token.trim(), action });

    if (outcome.ignored) {
      // 幂等忽略：不写库、不改缓存，仅回传当前状态
      return { kind: 'ignored', amendment: outcome.amendment, party: outcome.party! };
    }

    set((state) => ({ amendments: upsert(state.amendments, outcome.amendment) }));

    // 仅在事务提交成功后同步实例 / 版本内存缓存，刷新后由 IndexedDB 回读一致结果
    if (outcome.applied && outcome.instance && outcome.version) {
      useInstanceStore.setState((state) => ({
        instances: state.instances.map((item) => (item.id === outcome.instance!.id ? outcome.instance! : item))
      }));
      useVersionStore.setState((state) => ({
        versions: sortVersions(state.versions, outcome.version!)
      }));
    }

    return {
      kind: 'ok',
      amendment: outcome.amendment,
      applied: outcome.applied,
      party: outcome.party!,
      version: outcome.version,
      instanceId: outcome.instance?.id
    };
  } catch (error) {
    // 任何拒绝（凭据问题 / 终态 / 落库失败）都不向 UI 抛出；
    // 从库内回读该变更，确保内存缓存与磁盘一致，再把原因码交给 UI 内联展示。
    let persisted: Amendment | undefined;
    try {
      const db = await getDb();
      persisted = (await db.get('amendments', amendmentId)) as Amendment | undefined;
    } catch {
      // 回读本身失败时退回内存中的最近状态，反馈链路仍然可用
      persisted = get().amendments.find((a) => a.id === amendmentId);
    }
    if (persisted) {
      set((state) => ({ amendments: upsert(state.amendments, persisted!) }));
    }

    const { reason, message } = classifyCredentialError(error);
    return { kind: 'rejected', reason, message, amendment: persisted ?? null };
  } finally {
    set({ pendingKey: null });
  }
}
