import { Amendment, AmendmentAction, AmendmentContent, AmendmentStatus, AmendmentTimelineEntry, CredentialAction, CredentialState, IssuedCredential } from '../types/amendment';
import { ContractParty } from '../types/enums';
import { hashCredential } from './amendmentCredential';

/** 合同当事方全集：双方都确认后变更才可生效 */
export const ALL_PARTIES: readonly ContractParty[] = [ContractParty.PartyA, ContractParty.PartyB];

export class AmendmentError extends Error {}

export function isTerminal(status: AmendmentStatus) {
  return status === AmendmentStatus.Applied || status === AmendmentStatus.Withdrawn;
}

/** 该侧凭据是否已用于「确认」 */
export function partyConfirmed(amendment: Amendment, party: ContractParty) {
  const credential = amendment.credentials[party];
  return credential.used && credential.usedFor === 'confirm';
}

/** 双方是否均已凭合法凭据确认（不改变状态，仅做判定） */
export function bothConfirmed(amendment: Amendment) {
  return ALL_PARTIES.every((party) => partyConfirmed(amendment, party));
}

function pushTimeline(amendment: Amendment, entry: AmendmentTimelineEntry): AmendmentTimelineEntry[] {
  return [...amendment.timeline, entry];
}

/**
 * 登记一条变更。调用方必须在【开启数据库事务之前】算好双方凭据哈希
 * （SHA-256 是异步操作，放在事务内 await 会让事务自动关闭）。
 */
export function createAmendment(input: {
  id: string;
  contractInstanceId: string;
  content: AmendmentContent;
  proposedBy: ContractParty;
  credentialHashes: Record<ContractParty, string>;
  now: string;
}): Amendment {
  const credentials = {} as Record<ContractParty, CredentialState>;
  for (const party of ALL_PARTIES) {
    // 两侧槽位必须齐全，缺一不可
    if (!input.credentialHashes[party]) {
      throw new AmendmentError('甲、乙双方凭据必须同时签发');
    }
    credentials[party] = { tokenHash: input.credentialHashes[party], used: false };
  }

  return {
    id: input.id,
    contractInstanceId: input.contractInstanceId,
    ...input.content,
    credentials,
    status: AmendmentStatus.Pending,
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
}

/** 把一对明文凭据转换为落库哈希槽（必须在数据库事务外调用） */
export async function buildCredentialHashes(issued: IssuedCredential[]): Promise<Record<ContractParty, string>> {
  const hashes = {} as Record<ContractParty, string>;
  for (const item of issued) {
    hashes[item.party] = await hashCredential(item.token);
  }
  return hashes;
}

/**
 * 在凭据【已验签、确认为未使用】后应用动作。纯函数，不做任何票证校验——
 * 验票在事务层（amendmentTx）完成，这里只表达状态迁移。
 *
 * - confirm：标记本侧凭据已用于确认；ready=true 时调用方须在同一事务内
 *   完成「生成新版本 + 替换正文 + 回写变更记录」。
 * - withdraw：整条变更立即失效（终态），撤回侧凭据标记已用于撤回。
 */
export function applyCredentialAction(
  amendment: Amendment,
  party: ContractParty,
  action: CredentialAction,
  now: string
): { amendment: Amendment; ready: boolean } {
  if (isTerminal(amendment.status)) {
    throw new AmendmentError(`变更已处于「${amendment.status}」状态，操作无效`);
  }

  const slot = amendment.credentials[party];
  if (!slot) {
    throw new AmendmentError('该方不存在凭据槽');
  }
  // 防线：事务层已对「已用凭据」做幂等忽略；落到这里仍为已用时必须拒绝，
  // 保证同一枚凭据在状态机层面也不可能产生第二次效果。
  if (slot.used) {
    throw new AmendmentError('该凭据已使用过，不能再次生效');
  }

  if (action === 'withdraw') {
    const withdrawn: Amendment = {
      ...amendment,
      status: AmendmentStatus.Withdrawn,
      withdrawnBy: party,
      withdrawnAt: now,
      updatedAt: now,
      credentials: consumeCredential(amendment.credentials, party, 'withdraw', now),
      timeline: pushTimeline(amendment, { action: AmendmentAction.Withdrawn, party, at: now })
    };
    return { amendment: withdrawn, ready: false };
  }

  const credentials = consumeCredential(amendment.credentials, party, 'confirm', now);
  const next: Amendment = {
    ...amendment,
    credentials,
    updatedAt: now,
    timeline: pushTimeline(amendment, { action: AmendmentAction.Confirmed, party, at: now })
  };

  const ready = ALL_PARTIES.every((candidate) => {
    const credential = credentials[candidate];
    return credential.used && credential.usedFor === 'confirm';
  });

  return { amendment: next, ready };
}

function consumeCredential(
  credentials: Record<ContractParty, CredentialState>,
  party: ContractParty,
  action: CredentialAction,
  now: string
): Record<ContractParty, CredentialState> {
  return {
    ...credentials,
    [party]: { ...credentials[party], used: true, usedAt: now, usedFor: action }
  };
}

/**
 * 双方确认齐备后把变更推进到「已生效」。纯函数：只负责状态落位，
 * 调用方必须保证新版本与正文替换在同一事务内提交。
 */
export function markApplied(amendment: Amendment, versionId: string, baseVersionNo: number, now: string): Amendment {
  if (amendment.status !== AmendmentStatus.Pending || !bothConfirmed(amendment)) {
    throw new AmendmentError('只有双方均已凭合法凭据确认的待确认变更才能标记生效');
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
