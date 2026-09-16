import { Amendment, AmendmentAction, AmendmentStatus, CredentialState } from '../types/amendment';
import { ALL_PARTIES } from './amendmentMachine';

/**
 * v2 -> v3：旧版变更记录没有凭据槽，按终态/在途分别规范化。
 *
 * - applied：双方都曾确认，两侧槽位标记为已用于确认（占位哈希，不可再用）。
 * - withdrawn：已确认方的槽位记为「确认」，撤回方记为「撤回」，其余未使用。
 * - pending：凭据体系升级后旧在途记录无法再被确认/撤回（持票人不存在），
 *   一律作废为 withdrawn 并留迁移说明，避免永久阻塞新变更登记。
 *
 * 所有规范化记录的 tokenHash 均为占位串，不可能与任何真实 SHA-256 匹配，
 * 因此这些终态记录不可能被任何凭据操作复活。
 */
export function migrateAmendmentV2ToV3(raw: Record<string, unknown>, migratedAt: string): Amendment {
  const base = raw as unknown as Amendment & { confirmedParties?: string[] };
  const confirmed = new Set<string>(Array.isArray(base.confirmedParties) ? base.confirmedParties : []);

  if (base.status === AmendmentStatus.Applied) {
    return {
      ...stripLegacyFields(base),
      credentials: buildSlots((party) => ({ used: true, usedFor: 'confirm', usedAt: base.appliedAt ?? migratedAt })),
      status: AmendmentStatus.Applied
    };
  }

  if (base.status === AmendmentStatus.Withdrawn) {
    return {
      ...stripLegacyFields(base),
      credentials: buildSlots((party) =>
        confirmed.has(party)
          ? { used: true, usedFor: 'confirm', usedAt: base.withdrawnAt ?? migratedAt }
          : base.withdrawnBy === party
            ? { used: true, usedFor: 'withdraw', usedAt: base.withdrawnAt ?? migratedAt }
            : { used: false }
      ),
      status: AmendmentStatus.Withdrawn
    };
  }

  // 旧的待确认记录：作废
  return {
    ...stripLegacyFields(base),
    credentials: buildSlots(() => ({ used: false })),
    status: AmendmentStatus.Withdrawn,
    withdrawnAt: migratedAt,
    updatedAt: migratedAt,
    timeline: [
      ...(Array.isArray(base.timeline) ? base.timeline : []),
      {
        action: AmendmentAction.Rejected,
        at: migratedAt,
        detail: '凭据体系升级：旧待确认记录无对应一次性凭据，已作废，请重新登记'
      }
    ]
  };
}

const PLACEHOLDER_HASH = 'migration-placeholder';

function buildSlots(resolve: (party: (typeof ALL_PARTIES)[number]) => Omit<CredentialState, 'tokenHash'>): Amendment['credentials'] {
  const slots = {} as Amendment['credentials'];
  for (const party of ALL_PARTIES) {
    slots[party] = { tokenHash: PLACEHOLDER_HASH, ...resolve(party) };
  }
  return slots;
}

function stripLegacyFields(record: Amendment): Amendment {
  // 已被 credentials 取代的旧字段不再保留
  const { confirmedParties: _confirmed, ...rest } = record as Amendment & { confirmedParties?: unknown };
  return rest as Amendment;
}
