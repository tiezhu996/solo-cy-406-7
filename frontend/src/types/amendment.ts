import { ContractParty } from './enums';

/**
 * 合同变更（ amendment ）。
 *
 * 业务规则：
 * - 仅对「已签署」合同可以登记变更；登记后原合同继续有效，在双方确认完成前
 *   合同正文不发生任何变化。
 * - 变更停在双方确认阶段：甲方、乙方各持有一枚不同的【一次性确认凭据】，
 *   只能用本侧凭据执行确认或撤回；不允许在同一界面切换身份自报为另一方。
 * - 凭据明文仅在登记成功时返回一次，数据库只保存 SHA-256 哈希；
 *   凭据使用一次后即作废，再次提交不产生任何第二次效果。
 * - 凭据错误、跨变更复用、已使用或落库失败时，变更保持待确认，正文/版本不变。
 * - 双方各凭合法凭据确认一次后，在同一个 IndexedDB 事务内生成新版本并替换
 *   当前正文；任一步失败则整体回滚。
 */

/** 变更生命周期状态 */
export enum AmendmentStatus {
  /** 待双方确认（至少一方尚未确认） */
  Pending = 'pending',
  /** 双方已确认，新版本已生成并替换当前正文（终态） */
  Applied = 'applied',
  /** 任一方撤回，整条变更失效（终态） */
  Withdrawn = 'withdrawn'
}

/** 凭据驱动的动作类型（仅在凭据合法且未使用时可执行） */
export type CredentialAction = 'confirm' | 'withdraw';

/**
 * 单方凭据的落库形态：绝不保存明文，只存哈希与一次性使用状态。
 */
export interface CredentialState {
  /** 凭据明文的 SHA-256（hex）；同时承担「变更 × 当事方」的绑定关系 */
  tokenHash: string;
  /** 是否已使用；一旦为 true，同凭据再次提交一律无效 */
  used: boolean;
  /** 首次使用时间 */
  usedAt?: string;
  /** 首次使用时执行的动作 */
  usedFor?: CredentialAction;
}

/** 登记成功时仅返回一次的明文凭据；调用方负责向甲、乙分别转交 */
export interface IssuedCredential {
  party: ContractParty;
  /** 形如 amd-a_<hex> / amd-b_<hex> 的一次性明文凭据 */
  token: string;
}

/** 单条变更的登记载荷，登记后不可修改 */
export interface AmendmentContent {
  /** 变更标题，例如「付款期限调整」 */
  title: string;
  /** 变更原因 / 说明 */
  reason: string;
  /** 变更后的完整合同正文（HTML）；双方确认通过后替换当前 finalHtml */
  proposedHtml: string;
}

export interface Amendment extends AmendmentContent {
  id: string;
  contractInstanceId: string;

  /**
   * 甲、乙各自的一次性凭据状态。key 为当事方，value 不落明文。
   * 这是确认/撤回权限的唯一来源；接口不再接受调用方自报 party。
   */
  credentials: Record<ContractParty, CredentialState>;

  /** 确认通过时生成的新版本 id；未通过前恒为 undefined */
  appliedVersionId?: string;
  /** 生效时合同所处版本序号（生成新版本前的当前版本号），便于审计 */
  baseVersionNo?: number;

  status: AmendmentStatus;

  /** 发起方（仅用于展示，发起本身不代表确认；确认必须凭票） */
  proposedBy: ContractParty;
  proposedAt: string;
  /** 最近一次动作时间，用于时间线排序 */
  updatedAt: string;
  /** 双方确认完成、新版本生成的时间 */
  appliedAt?: string;
  /** 撤回方与撤回时间 */
  withdrawnBy?: ContractParty;
  withdrawnAt?: string;

  /** 操作轨迹，登记 / 确认 / 撤回 / 生效各追加一条，刷新后可回读 */
  timeline: AmendmentTimelineEntry[];
}

export enum AmendmentAction {
  Created = 'created',
  Confirmed = 'confirmed',
  Withdrawn = 'withdrawn',
  Applied = 'applied',
  /** 凭据非法/跨变更/已用时的拒绝记录（仅审计，状态不变） */
  Rejected = 'rejected'
}

export interface AmendmentTimelineEntry {
  action: AmendmentAction;
  party?: ContractParty;
  at: string;
  detail?: string;
}
