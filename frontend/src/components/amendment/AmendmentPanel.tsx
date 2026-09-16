import { Alert, Button, Card, Collapse, Empty, Modal, Select, Space, Tag, Timeline, Typography } from '@arco-design/web-react';
import { IconEdit } from '@arco-design/web-react/icon';
import { useMemo, useState } from 'react';
import { Message } from '@arco-design/web-react';
import { Amendment, AmendmentAction, AmendmentStatus } from '../../types/amendment';
import { ContractInstance } from '../../types/contract-instance';
import {
  AMENDMENT_STATUS_LABELS,
  CONTRACT_PARTY_LABELS,
  ContractParty,
  ContractStatus
} from '../../types/enums';
import { useAmendmentStore } from '../../stores/amendment';
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
  [AmendmentAction.Confirmed]: '确认',
  [AmendmentAction.ConfirmIgnored]: '重复确认（已忽略）',
  [AmendmentAction.Withdrawn]: '撤回',
  [AmendmentAction.Applied]: '双方确认完成，新版本已生效'
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function PartyChips({ confirmed }: { confirmed: ContractParty[] }) {
  return (
    <Space size={8}>
      {[ContractParty.PartyA, ContractParty.PartyB].map((party) => {
        const done = confirmed.includes(party);
        return (
          <Tag key={party} color={done ? 'green' : 'gray'} bordered>
            {CONTRACT_PARTY_LABELS[party]}
            {done ? '已确认' : '待确认'}
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
              {amendment.withdrawnBy ? ` · ${CONTRACT_PARTY_LABELS[amendment.withdrawnBy]}撤回` : ''}
              {amendment.reason ? ` · ${amendment.reason}` : ''}
            </Typography.Text>
            <Typography.Text type="secondary" className="amendment-trail">
              {amendment.timeline.map((entry) => `${entry.party ? CONTRACT_PARTY_LABELS[entry.party] : ''}${ACTION_LABEL[entry.action]}`).join(' → ')}
            </Typography.Text>
          </Space>
        </Timeline.Item>
      ))}
    </Timeline>
  );
}

export function AmendmentPanel({ instance }: AmendmentPanelProps) {
  const [modalVisible, setModalVisible] = useState(false);
  const { amendments, pendingKey, confirm, withdraw } = useAmendmentStore();
  const [actingParty, setActingParty] = useState<ContractParty>(ContractParty.PartyA);

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

  const handleConfirm = async (amendment: Amendment, party: ContractParty) => {
    const alreadyConfirmed = amendment.confirmedParties.includes(party);
    const willComplete = !alreadyConfirmed && amendment.confirmedParties.length === 1;
    try {
      await confirm(amendment.id, party);
      Message.success(
        alreadyConfirmed
          ? `${CONTRACT_PARTY_LABELS[party]}此前已确认，重复确认不产生新效果`
          : willComplete
            ? '双方确认完成，新版本已生成并替换当前正文'
            : `${CONTRACT_PARTY_LABELS[party]}已确认，等待另一方确认`
      );
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '确认失败');
    }
  };

  const handleWithdraw = (amendment: Amendment, party: ContractParty) => {
    Modal.confirm({
      title: '撤回该合同变更？',
      content: '任一方撤回后，整条变更立即失效，双方确认进度作废，原合同正文不受影响。',
      okText: '确认撤回',
      cancelText: '取消',
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        try {
          await withdraw(amendment.id, party);
          Message.success('变更已撤回并失效');
        } catch (error) {
          Message.error(error instanceof Error ? error.message : '撤回失败');
        }
      }
    });
  };

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
        <Alert type="warning" content="检测到多条待确认变更，按规则同一时间仅允许一条，请撤回多余记录。" style={{ marginBottom: 12 }} />
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
                <Typography.Text type="secondary" className="amendment-party-picker">
                  以
                  <Select
                    size="mini"
                    value={actingParty}
                    style={{ width: 84, margin: '0 4px' }}
                    onChange={(value) => setActingParty(value as ContractParty)}
                    options={[
                      { label: CONTRACT_PARTY_LABELS[ContractParty.PartyA], value: ContractParty.PartyA },
                      { label: CONTRACT_PARTY_LABELS[ContractParty.PartyB], value: ContractParty.PartyB }
                    ]}
                  />
                  身份操作
                </Typography.Text>
              </Space>

              <PartyChips confirmed={amendment.confirmedParties} />
              {amendment.reason && <Typography.Text type="secondary">变更原因：{amendment.reason}</Typography.Text>}
              <ProposedPreview amendment={amendment} />

              <Space wrap>
                <Button
                  type="primary"
                  loading={pendingKey === `confirm:${amendment.id}`}
                  disabled={busy}
                  onClick={() => void handleConfirm(amendment, actingParty)}
                >
                  {amendment.confirmedParties.includes(actingParty)
                    ? `${CONTRACT_PARTY_LABELS[actingParty]}已确认（重复确认不生效）`
                    : `${CONTRACT_PARTY_LABELS[actingParty]}确认`}
                </Button>
                <Button
                  status="danger"
                  loading={pendingKey === `withdraw:${amendment.id}`}
                  disabled={busy}
                  onClick={() => handleWithdraw(amendment, actingParty)}
                >
                  {CONTRACT_PARTY_LABELS[actingParty]}撤回（整条失效）
                </Button>
              </Space>
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

      <RegisterAmendmentModal
        visible={modalVisible}
        instance={instance}
        onClose={() => setModalVisible(false)}
      />
    </Card>
  );
}
