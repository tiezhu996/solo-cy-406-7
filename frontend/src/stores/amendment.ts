import { create } from 'zustand';
import { amendmentDb } from '../api/db';
import { Amendment, AmendmentContent } from '../types/amendment';
import { ContractParty } from '../types/enums';
import { Version } from '../types/version';
import { getDb, putRecord } from '../utils/db';
import { seedAmendments } from '../utils/seed';
import { registerAmendmentTx, respondAmendmentTx } from '../utils/amendmentTx';
import { useInstanceStore } from './instance';
import { useVersionStore } from './version';

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
  }) => Promise<Amendment>;
  confirm: (amendmentId: string, party: ContractParty) => Promise<void>;
  withdraw: (amendmentId: string, party: ContractParty) => Promise<void>;
}

function sortAmendments(amendments: Amendment[]) {
  return [...amendments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function upsert(list: Amendment[], amendment: Amendment) {
  const exists = list.some((item) => item.id === amendment.id);
  return sortAmendments(exists ? list.map((item) => (item.id === amendment.id ? amendment : item)) : [amendment, ...list]);
}

export const useAmendmentStore = create<AmendmentState>((set) => ({
  amendments: [],
  loading: false,
  pendingKey: null,

  async loadAmendments() {
    set({ loading: true });
    try {
      let amendments = await amendmentDb.list();
      if (!amendments.length && seedAmendments.length) {
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
      const amendment = await registerAmendmentTx(db, params);
      set((state) => ({ amendments: upsert(state.amendments, amendment) }));
      return amendment;
    } finally {
      set({ pendingKey: null });
    }
  },

  async confirm(amendmentId, party) {
    set({ pendingKey: `confirm:${amendmentId}` });
    try {
      const db = await getDb();
      const outcome = await respondAmendmentTx(db, { amendmentId, party, action: 'confirm' });
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
    } finally {
      set({ pendingKey: null });
    }
  },

  async withdraw(amendmentId, party) {
    set({ pendingKey: `withdraw:${amendmentId}` });
    try {
      const db = await getDb();
      const outcome = await respondAmendmentTx(db, { amendmentId, party, action: 'withdraw' });
      set((state) => ({ amendments: upsert(state.amendments, outcome.amendment) }));
    } finally {
      set({ pendingKey: null });
    }
  }
}));

function sortVersions(versions: Version[], version: Version) {
  return [...versions.filter((item) => item.id !== version.id), version].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
