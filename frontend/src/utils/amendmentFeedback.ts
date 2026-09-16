import { AmendmentErrorCode } from './amendmentMachine';

export type FeedbackTone = 'success' | 'info' | 'warning' | 'error';

export interface CredentialFeedback {
  tone: FeedbackTone;
  /** 操作处内联展示的一句话 */
  inline: string;
}

/** 把捕获到的异常归类为原因码 + 文案，供 store 在不抛异常的前提下回传 UI */
export function classifyCredentialError(error: unknown): { reason: AmendmentErrorCode; message: string } {
  if (error && typeof error === 'object' && 'code' in error) {
    const reason = (error as { code?: AmendmentErrorCode }).code;
    if (reason) {
      return { reason, message: error instanceof Error ? error.message : '操作被拒绝' };
    }
  }
  return {
    reason: 'PERSISTENCE_FAILED',
    message: error instanceof Error ? error.message : '操作失败，请重试'
  };
}

/**
 * 把凭据操作结果映射为用户可读反馈。三类结果严格可区分：
 * 成功（ok）、幂等忽略（ignored）、拒绝（rejected，含具体原因码）。
 */
export function describeRejection(reason: AmendmentErrorCode, message: string, action: 'confirm' | 'withdraw'): CredentialFeedback {
  const verb = action === 'confirm' ? '确认' : '撤回';
  switch (reason) {
    case 'CREDENTIAL_MALFORMED':
      return { tone: 'error', inline: `凭据格式错误：${message}。变更仍为待确认，合同正文和版本未改变。` };
    case 'CREDENTIAL_MISMATCH':
      return {
        tone: 'error',
        inline: `凭据不被接受（跨变更复用、他方凭据或内容有误），${verb}未执行。变更记录、正文和版本均未改变，请使用本变更登记时分发给本方的凭据重试。`
      };
    case 'CREDENTIAL_USED':
      return { tone: 'info', inline: '该凭据已使用过，不能再次生效；状态保持不变。' };
    case 'TERMINAL_STATE':
      return { tone: 'warning', inline: `${message}。请在变更列表中查看当前状态。` };
    case 'NOT_FOUND':
      return { tone: 'error', inline: '未找到对应变更记录，刷新页面后若仍异常请重新打开合同。' };
    case 'PERSISTENCE_FAILED':
      return {
        tone: 'error',
        inline: `落库失败，本次${verb}已整体回滚——合同正文、变更记录和版本号保持失败前一致。请使用合法凭据重试。`
      };
    default:
      return { tone: 'error', inline: message || `${verb}失败，请重试。` };
  }
}
