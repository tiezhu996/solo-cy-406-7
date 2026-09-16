import { Alert, Button, Card, Collapse, Empty, Input, Message, Modal, Space, Tag, Timeline, Typography } from '@arco-design/web-react';
import { IconEdit } from '@arco-design/web-react/icon';
import { useMemo, useState } from 'react';
import { Amendment, AmendmentAction, AmendmentStatus } from '../../types/amendment';
import { ContractInstance } from '../../types/contract-instance';
import { AMENDMENT_STATUS_LABELS, CONTRACT_PARTY_LABELS, ContractParty, ContractStatus } from '../../types/enums';
import { useAmendmentStore } from '../../stores/amendment';
import type { CredentialResponse } from '../../stores/amendment';
import { parseCredentialParty } from '../../utils/amendmentCredential';
import { describeRejection, FeedbackTone } from '../../utils/amendmentFeedback';
import { SEED_DEMO_TOKENS, SEED_PENDING_AMENDMENT_ID } from '../../utils/seed';
import { RegisterAmendmentModal } from './RegisterAmendmentModal';

interface AmendmentPanelProps {
  instance: ContractInstance;
}

const STATUS_TAG_COLOR: Record<AmendmentStatus, string> = {
  [AmendmentStatus.Pending]: 'orange',
  [AmendmentStatus.Applied]: 'green',
  [AmendmentStatus.Withdrawn]: 'gray'
};

const ACTION_LABEL: Record<AmendmentAction, string> = {
  [AmendmentAction.Created]: '登记变更',
  [AmendmentAction.Confirmed]: '凭票确认',
  [AmendmentAction.Withdrawn]: '凭票撤回',
  [AmendmentAction.Applied]: '双方确认完成，新版本已生效',
  [AmendmentAction.Rejected]: '凭据校验未通过'
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function credentialSlotState(amendment: Amendment, party: ContractParty) {
  const slot = amendment.credentials[party];
  if (!slot) {
    return { label: '无凭据槽', color: 'gray' as const };
  }
  if (!slot.used) {
    return { label: '凭据未使用', color: 'orange' as const };
  }
  return {
    label: slot.usedFor === 'confirm' ? '已凭票确认' : '已凭票撤回',
    color: slot.usedFor === 'confirm' ? ('green' as const) : ('red' as const)
  };
}

function PartyChips({ amendment }: { amendment: Amendment }) {
  return (
    <Space size={8} wrap>
      {[ContractParty.PartyA, ContractParty.PartyB].map((party) => {
        const state = credentialSlotState(amendment, party);
        return (
          <Tag key={party} color={state.color} bordered>
            {CONTRACT_PARTY_LABELS[party]}
            {state.label}
          </Tag>
        );
      })}
    </Space>
  );
}

function ProposedPreview({ amendment }: { amendment: Amendment }) {
  return (
    <Collapse bordered={false}>
      <Collapse.Item name="proposed" header="查看变更后正文">
        <article className="contract-preview amendment-proposed" dangerouslySetInnerHTML={{ __html: amendment.proposedHtml }} />
      </Collapse.Item>
    </Collapse>
  );
}

function AmendmentHistory({ amendments }: { amendments: Amendment[] }) {
  if (!amendments.length) {
    return <Empty description="暂无变更记录" />;
  }

  return (
    <Timeline>
      {amendments.map((amendment) => (
        <Timeline.Item
          key={amendment.id}
          dotColor={
            amendment.status === AmendmentStatus.Applied
              ? '#00b42a'
              : amendment.status === AmendmentStatus.Withdrawn
                ? '#86909c'
                : '#ff7d00'
          }
          label={formatTime(amendment.updatedAt)}
        >
          <Space direction="vertical" size={4} className="amendment-history-entry">
            <Space wrap>
              <Typography.Text bold>{amendment.title}</Typography.Text>
              <Tag color={STATUS_TAG_COLOR[amendment.status]} size="small">
                {AMENDMENT_STATUS_LABELS[amendment.status]}
              </Tag>
            </Space>
            <Typography.Text type="secondary" className="amendment-history-meta">
              发起：{CONTRACT_PARTY_LABELS[amendment.proposedBy]}
              {amendment.appliedAt ? ` · 生效于 ${formatTime(amendment.appliedAt)}` : ''}
              {amendment.withdrawnBy ? ` · ${CONTRACT_PARTY_LABELS[amendment.withdrawnBy]}凭票撤回` : ''}
              {amendment.reason ? ` · ${amendment.reason}` : ''}
            </Typography.Text>
            <Typography.Text type="secondary" className="amendment-trail">
              {amendment.timeline
                .map((entry) => `${entry.party ? CONTRACT_PARTY_LABELS[entry.party] : ''}${ACTION_LABEL[entry.action]}`)
                .join(' → ')}
            </Typography.Text>
          </Space>
        </Timeline.Item>
      ))}
    </Timeline>
  );
}

/** 凭据输入 + 凭票确认/撤回；持票人对号到哪一侧完全由凭据前缀决定 */
function CredentialActions({ amendment, busy }: { amendment: Amendment; busy: boolean }) {
  const [token, setToken] = useState('');
  const [feedback, setFeedback] = useState<{ tone: FeedbackTone; text: string } | null>(null);
  const { confirm, withdraw, pendingKey } = useAmendmentStore();

  const trimmed = token.trim();
  const party = trimmed ? parseCredentialParty(trimmed) : null;

  // 统一消费判别结果：成功 / 幂等忽略 / 拒绝（含原因码）都在这里给出操作处反馈
  const handleResponse = (response: CredentialResponse, action: 'confirm' | 'withdraw') => {
    if (response.kind === 'ok') {
      if (action === 'withdraw') {
        // 撤回成功后本卡片立即移入历史区，内联提示会随卡片卸载，改用全局提示
        Message.success('凭据有效，变更已撤回并失效；合同正文与版本未受影响。');
      } else if (response.applied) {
        Message.success('双方确认完成，新版本已生成并替换当前正文；变更记录与版本号已同步。');
      } else {
        setFeedback({
          tone: 'success',
          text: `${CONTRACT_PARTY_LABELS[response.party]}凭据有效，已确认；等待另一方凭据确认。`
        });
      }
      // 成功后清空凭据输入；切到下一条待确认时组件随卡片重挂载
      setToken('');
      return;
    }

    if (response.kind === 'ignored') {
      setFeedback({
        tone: 'warning',
        text: `${CONTRACT_PARTY_LABELS[response.party]}凭据此前已使用过，本次为幂等忽略，未产生第二次效果；状态、正文、版本均不变。`
      });
      return;
    }

    const described = describeRejection(response.reason, response.message, action);
    setFeedback({ tone: described.tone, text: described.inline });
  };

  const handleConfirm = async () => {
    if (!trimmed) {
      setFeedback({ tone: 'warning', text: '请粘贴本方持有的一次性凭据后再确认。' });
      return;
    }
    setFeedback(null);
    const response = await confirm(amendment.id, trimmed);
    handleResponse(response, 'confirm');
  };

  const handleWithdraw = () => {
    if (!trimmed) {
      setFeedback({ tone: 'warning', text: '请粘贴本方持有的一次性凭据后再撤回。' });
      return;
    }
    Modal.confirm({
      title: '凭票撤回该合同变更？',
      content: '任一方凭据撤回后，整条变更立即失效，已确认进度作废，原合同正文与版本不受影响。',
      okText: '确认撤回',
      cancelText: '取消',
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        const response = await withdraw(amendment.id, trimmed);
        handleResponse(response, 'withdraw');
      }
    });
  };

  return (
    <div className="credential-actions">
      <Input.Password
        value={token}
        onChange={(value) => {
          setToken(value);
          if (feedback) {
            setFeedback(null);
          }
        }}
        placeholder="粘贴一次性确认凭据（amd-a_… 或 amd-b_…）"
        visibilityToggle
        disabled={busy}
        status={feedback?.tone === 'error' ? 'error' : undefined}
      />
      <Space size={4} className="credential-party-hint">
        {party ? (
          <Tag size="small" color="arcoblue">
            识别为{CONTRACT_PARTY_LABELS[party]}凭据
          </Tag>
        ) : (
          trimmed && (
            <Tag size="small" color="red">
              凭据格式无法识别
            </Tag>
          )
        )}
      </Space>
      <Space wrap>
        <Button type="primary" loading={pendingKey === `confirm:${amendment.id}`} disabled={busy} onClick={() => void handleConfirm()}>
          凭票确认
        </Button>
        <Button status="danger" loading={pendingKey === `withdraw:${amendment.id}`} disabled={busy} onClick={handleWithdraw}>
          凭票撤回（整条失效）
        </Button>
      </Space>

      {feedback && (
        <Alert
          className="credential-feedback"
          type={feedback.tone === 'info' ? 'info' : feedback.tone}
          showIcon
          content={feedback.text}
        />
      )}
    </div>
  );
}

export function AmendmentPanel({ instance }: AmendmentPanelProps) {
  const [modalVisible, setModalVisible] = useState(false);
  const { amendments, pendingKey } = useAmendmentStore();

  const related = useMemo(
    () =>
      amendments
        .filter((amendment) => amendment.contractInstanceId === instance.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [amendments, instance.id]
  );

  const pending = related.filter((amendment) => amendment.status === AmendmentStatus.Pending);
  const settled = related.filter((amendment) => amendment.status !== AmendmentStatus.Pending);

  const isSigned = instance.status === ContractStatus.Signed;
  const busy = pendingKey !== null;

  return (
    <Card
      className="amendment-panel"
      title={
        <Space>
          <Typography.Text bold>合同变更确认</Typography.Text>
          <Tag color="arcoblue">{related.length} 条记录</Tag>
        </Space>
      }
      extra={
        isSigned && (
          <Button type="primary" icon={<IconEdit />} disabled={!isSigned || busy} onClick={() => setModalVisible(true)}>
            登记变更
          </Button>
        )
      }
    >
      {!isSigned && (
        <Alert
          type="info"
          content="合同签署后才能提出变更。请先在上方将合同状态置为「已签署」并保存。"
          style={{ marginBottom: 12 }}
        />
      )}

      {isSigned && !pending.length && (
        <Alert
          type="info"
          content="当前没有待确认的变更。原合同持续有效；点击右上角「登记变更」是唯一的变更登记入口。"
          style={{ marginBottom: 12 }}
        />
      )}

      {isSigned && pending.length > 1 && (
        <Alert type="warning" content="检测到多条待确认变更，按规则同一时间仅允许一条，请凭票撤回多余记录。" style={{ marginBottom: 12 }} />
      )}

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {pending.map((amendment) => (
          <Card key={amendment.id} className="amendment-pending-card" bordered>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                <Space wrap>
                  <Typography.Text bold>{amendment.title}</Typography.Text>
                  <Tag color="orange">{AMENDMENT_STATUS_LABELS[amendment.status]}</Tag>
                </Space>
              </Space>

              <PartyChips amendment={amendment} />
              {amendment.reason && <Typography.Text type="secondary">变更原因：{amendment.reason}</Typography.Text>}

              {amendment.id === SEED_PENDING_AMENDMENT_ID && (
                <Alert
                  type="info"
                  content={
                    <Space direction="vertical" size={4}>
                      <Typography.Text>演示凭据（真实环境中明文仅登记成功时展示一次）：</Typography.Text>
                      <Typography.Text copyable={{ text: SEED_DEMO_TOKENS.partyA }}>甲方：{SEED_DEMO_TOKENS.partyA}（已确认，再交被忽略）</Typography.Text>
                      <Typography.Text copyable={{ text: SEED_DEMO_TOKENS.partyB }}>乙方：{SEED_DEMO_TOKENS.partyB}（粘贴后确认即生效）</Typography.Text>
                    </Space>
                  }
                />
              )}

              <ProposedPreview amendment={amendment} />

              <Alert
                type="warning"
                content="确认与撤回必须出示登记时分发给本方的一次性凭据。系统不提供「切换为甲方/乙方」的入口，无凭据即无操作权。"
              />
              <CredentialActions amendment={amendment} busy={busy} />
            </Space>
          </Card>
        ))}

        {settled.length > 0 && (
          <div>
            <Typography.Title heading={6} style={{ margin: '4px 0 10px' }}>
              历史变更
            </Typography.Title>
            <AmendmentHistory amendments={settled} />
          </div>
        )}
      </Space>

      <RegisterAmendmentModal visible={modalVisible} instance={instance} onClose={() => setModalVisible(false)} />
    </Card>
  );
}
