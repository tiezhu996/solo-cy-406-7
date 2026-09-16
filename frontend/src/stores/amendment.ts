import { create } from 'zustand';
import { amendmentDb } from '../api/db';
import { Amendment, AmendmentContent, CredentialAction, IssuedCredential } from '../types/amendment';
import { ContractParty } from '../types/enums';
import { Version } from '../types/version';
import { getDb, putRecord } from '../utils/db';
import { buildSeedAmendments } from '../utils/seed';
import { registerAmendmentTx, respondAmendmentTx } from '../utils/amendmentTx';
import { useInstanceStore } from './instance';
import { useVersionStore } from './version';

interface RegisterOutcome {
  amendment: Amendment;
  /** 甲、乙各自的一次性凭据，明文只在此出现一次 */
  credentials: IssuedCredential[];
}

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
  /** 凭一次性凭据确认；同一凭据第二次提交不会产生效果 */
  confirm: (amendmentId: string, token: string) => Promise<{ applied: boolean; ignored: boolean; party?: ContractParty }>;
  /** 凭一次性凭据撤回；撤回后整条变更失效 */
  withdraw: (amendmentId: string, token: string) => Promise<{ ignored: boolean; party?: ContractParty }>;
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

export const useAmendmentStore = create<AmendmentState>((set) => ({
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
    set({ pendingKey: `confirm:${amendmentId}` });
    try {
      const db = await getDb();
      const outcome = await respondAmendmentTx(db, { amendmentId, token: token.trim(), action: 'confirm' satisfies CredentialAction });
      if (!outcome.ignored) {
        set((state) => ({ amendments: upsert(state.amendments, outcome.amendment) }));
      }

      // 仅在事务提交成功后同步实例 / 版本内存缓存，刷新后由 IndexedDB 回读一致结果
      if (outcome.applied && outcome.instance && outcome.version) {
        useInstanceStore.setState((state) => ({
          instances: state.instances.map((item) => (item.id === outcome.instance!.id ? outcome.instance! : item))
        }));
        useVersionStore.setState((state) => ({
          versions: sortVersions(state.versions, outcome.version!)
        }));
      }

      return { applied: outcome.applied, ignored: Boolean(outcome.ignored), party: outcome.party };
    } finally {
      set({ pendingKey: null });
    }
  },

  async withdraw(amendmentId, token) {
    set({ pendingKey: `withdraw:${amendmentId}` });
    try {
      const db = await getDb();
      const outcome = await respondAmendmentTx(db, { amendmentId, token: token.trim(), action: 'withdraw' satisfies CredentialAction });
      if (!outcome.ignored) {
        set((state) => ({ amendments: upsert(state.amendments, outcome.amendment) }));
      }
      return { ignored: Boolean(outcome.ignored), party: outcome.party };
    } finally {
      set({ pendingKey: null });
    }
  }
}));
