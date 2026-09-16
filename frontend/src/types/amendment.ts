/**
 * 合同变更（ amendment ）。
 *
 * 业务规则：
 * - 仅对「已签署」合同可以登记变更；登记后原合同继续有效，在双方确认完成前
 *   合同正文不发生任何变化。
 * - 变更停在双方确认阶段：需甲方、乙方分别确认；同一方重复确认为幂等操作，
 *   不会重复生效。
 * - 任一方在变更生效前撤回，整条变更立即失效（withdrawn 为终态）。
 * - 双方都确认的瞬间，在同一个 IndexedDB 事务内生成新版本并替换当前正文；
 *   若任一步失败，事务整体回滚，正文 / 变更记录 / 版本号保持不变。
 */

import { ContractParty } from './enums';

/** 变更生命周期状态 */
export enum AmendmentStatus {
  /** 待双方确认（至少一方尚未确认） */
  Pending = 'pending',
  /** 双方已确认，新版本已生成并替换当前正文（终态） */
  Applied = 'applied',
  /** 任一方撤回，整条变更失效（终态） */
  Withdrawn = 'withdrawn'
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

  /** 确认通过时生成的新版本 id；未通过前恒为 undefined */
  appliedVersionId?: string;
  /** 生效时合同所处版本序号（生成新版本前的当前版本号），便于审计 */
  baseVersionNo?: number;

  status: AmendmentStatus;
  /** 已确认的一方集合；同一方重复确认不会产生新效果 */
  confirmedParties: ContractParty[];

  /** 发起方（登记时选定，登记即视为发起，但仍需显式确认） */
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
  /** 重复确认被识别为幂等，不改变状态，仅留审计痕迹 */
  ConfirmIgnored = 'confirm_ignored',
  Withdrawn = 'withdrawn',
  Applied = 'applied'
}

export interface AmendmentTimelineEntry {
  action: AmendmentAction;
  party?: ContractParty;
  at: string;
  detail?: string;
}
