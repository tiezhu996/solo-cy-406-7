import { Amendment, AmendmentAction, AmendmentContent, AmendmentStatus, AmendmentTimelineEntry } from '../types/amendment';
import { ContractParty } from '../types/enums';

/** 合同当事方全集：双方都确认后变更才可生效 */
export const ALL_PARTIES: readonly ContractParty[] = [ContractParty.PartyA, ContractParty.PartyB];

export class AmendmentError extends Error {}

export function isTerminal(status: AmendmentStatus) {
  return status === AmendmentStatus.Applied || status === AmendmentStatus.Withdrawn;
}

export function hasConfirmed(amendment: Amendment, party: ContractParty) {
  return amendment.confirmedParties.includes(party);
}

/** 双方是否均已确认（不改变状态，仅做判定） */
export function bothConfirmed(amendment: Amendment) {
  return ALL_PARTIES.every((party) => amendment.confirmedParties.includes(party));
}

function pushTimeline(amendment: Amendment, entry: AmendmentTimelineEntry): AmendmentTimelineEntry[] {
  return [...amendment.timeline, entry];
}

/** 登记一条变更：状态停在「待双方确认」，原合同继续有效 */
export function createAmendment(input: {
  id: string;
  contractInstanceId: string;
  content: AmendmentContent;
  proposedBy: ContractParty;
  now: string;
}): Amendment {
  const amendment: Amendment = {
    id: input.id,
    contractInstanceId: input.contractInstanceId,
    ...input.content,
    status: AmendmentStatus.Pending,
    confirmedParties: [],
    proposedBy: input.proposedBy,
    proposedAt: input.now,
    updatedAt: input.now,
    timeline: [
      {
        action: AmendmentAction.Created,
        party: input.proposedBy,
        at: input.now,
        detail: input.content.title
      }
    ]
  };
  return amendment;
}

/**
 * 一方确认变更。
 *
 * - 已确认过的一方再次确认：幂等，返回 ignored，状态与确认集合均不变；
 * - 终态（已生效 / 已撤回）下确认：拒绝；
 * - 新的一方确认：加入确认集合；ready=true 表示双方齐备，调用方应在
 *   同一个数据库事务内完成「生成新版本 + 替换正文 + 回写变更记录」。
 */
export function confirmAmendment(
  amendment: Amendment,
  party: ContractParty,
  now: string
): { amendment: Amendment; ready: boolean; ignored: boolean } {
  if (isTerminal(amendment.status)) {
    throw new AmendmentError(`变更已处于「${amendment.status}」状态，不能再确认`);
  }

  if (hasConfirmed(amendment, party)) {
    // 同一方重复确认不能重复生效：除一条审计轨迹外什么都不改
    return {
      amendment: {
        ...amendment,
        timeline: pushTimeline(amendment, {
          action: AmendmentAction.ConfirmIgnored,
          party,
          at: now,
          detail: '重复确认，已忽略'
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
      timeline: pushTimeline(amendment, { action: AmendmentAction.Confirmed, party, at: now })
    },
    ready,
    ignored: false
  };
}

/**
 * 任一方撤回：整条变更立即失效（终态）。撤回不需要该方先确认。
 * 已生效的变更不能撤回（正文已替换，需另行登记新变更）。
 */
export function withdrawAmendment(amendment: Amendment, party: ContractParty, now: string): Amendment {
  if (amendment.status === AmendmentStatus.Withdrawn) {
    // 重复撤回同样幂等：保持已失效状态，不重复留痕也不报错
    return amendment;
  }
  if (amendment.status === AmendmentStatus.Applied) {
    throw new AmendmentError('变更已生效，不能撤回；如需回退请登记新的变更');
  }

  return {
    ...amendment,
    status: AmendmentStatus.Withdrawn,
    withdrawnBy: party,
    withdrawnAt: now,
    updatedAt: now,
    timeline: pushTimeline(amendment, { action: AmendmentAction.Withdrawn, party, at: now })
  };
}

/**
 * 双方确认齐备后把变更推进到「已生效」。纯函数：只负责状态落位，
 * 调用方必须保证新版本与正文替换在同一事务内提交。
 */
export function markApplied(amendment: Amendment, versionId: string, baseVersionNo: number, now: string): Amendment {
  if (amendment.status !== AmendmentStatus.Pending || !bothConfirmed(amendment)) {
    throw new AmendmentError('只有双方均已确认的待确认变更才能标记生效');
  }

  return {
    ...amendment,
    status: AmendmentStatus.Applied,
    appliedVersionId: versionId,
    baseVersionNo,
    appliedAt: now,
    updatedAt: now,
    timeline: pushTimeline(amendment, {
      action: AmendmentAction.Applied,
      at: now,
      detail: `生成新版本，原版本 ${baseVersionNo} 被替换`
    })
  };
}
