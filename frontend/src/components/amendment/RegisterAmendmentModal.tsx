import { Alert, Button, Form, Input, Message, Modal, Radio, Result, Space, Tag, Typography } from '@arco-design/web-react';
import { IconCopy } from '@arco-design/web-react/icon';
import { useEffect, useState } from 'react';
import { ContractInstance } from '../../types/contract-instance';
import { AmendmentContent, IssuedCredential } from '../../types/amendment';
import { ContractParty, CONTRACT_PARTY_LABELS } from '../../types/enums';
import { useAmendmentStore } from '../../stores/amendment';
import { RichEditor } from '../common';

interface RegisterAmendmentModalProps {
  visible: boolean;
  instance: ContractInstance;
  onClose: () => void;
}

interface FormValues {
  title: string;
  reason: string;
  proposedBy: ContractParty;
  proposedHtml: string;
}

/**
 * 合同变更的【唯一登记入口】。
 * 只在已签署合同实例页由 AmendmentPanel 唤起，别处不提供登记能力。
 * 登记成功后为甲、乙各生成一枚不同的一次性凭据，明文仅此一次展示，
 * 数据库只保存哈希；关闭后无法再次查看明文。
 */
export function RegisterAmendmentModal({ visible, instance, onClose }: RegisterAmendmentModalProps) {
  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState(false);
  // 正文不走 Form 注入（RichEditor 是 onChange(html) 形态），单独受控并参与校验
  const [proposedHtml, setProposedHtml] = useState('');
  const [issued, setIssued] = useState<IssuedCredential[] | null>(null);
  const registerAmendment = useAmendmentStore((state) => state.registerAmendment);

  // 每次打开都以「当前正文」为底稿初始化：变更必须针对当前版本提出
  useEffect(() => {
    if (visible) {
      form.setFieldsValue({
        title: '',
        reason: '',
        proposedBy: ContractParty.PartyA
      });
      setProposedHtml(instance.finalHtml);
      setIssued(null);
    }
  }, [visible, instance.finalHtml, form]);

  const handleSubmit = async () => {
    const values = await form.validate();
    if (!proposedHtml.replace(/<[^>]*>/g, '').trim()) {
      Message.error('变更后正文不能为空');
      return;
    }

    const content: AmendmentContent = {
      title: values.title.trim(),
      reason: values.reason.trim(),
      proposedHtml
    };

    setSubmitting(true);
    try {
      const result = await registerAmendment({
        contractInstanceId: instance.id,
        content,
        proposedBy: values.proposedBy
      });
      setIssued(result.credentials);
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '登记失败');
    } finally {
      setSubmitting(false);
    }
  };

  const copyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      Message.success('凭据已复制，请通过安全渠道转交对应一方');
    } catch {
      Message.warning('复制失败，请手动选择文本复制');
    }
  };

  return (
    <Modal
      title={issued ? '登记成功 · 请立即分发一次性凭据' : '登记合同变更'}
      visible={visible}
      style={{ width: 880, maxWidth: '92vw' }}
      unmountOnExit
      confirmLoading={submitting}
      okText={issued ? '我已妥善保存' : '提交登记'}
      cancelText={issued ? '关闭' : '取消'}
      onOk={() => {
        if (issued) {
          onClose();
        } else {
          void handleSubmit();
        }
      }}
      onCancel={onClose}
      maskClosable={false}
      escToExit={false}
    >
      {issued ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Result
            status="success"
            title="变更已登记，停在双方确认阶段"
            subTitle="在双方各凭自己的凭据确认之前，原合同继续有效，正文不会被修改。"
          />
          <Alert
            type="warning"
            content="以下两枚凭据仅现在展示一次，系统不保存明文。请立即复制并分别安全转交给甲方、乙方；遗失后只能撤回重登。"
          />
          {issued
            .slice()
            .sort((a, b) => a.party.localeCompare(b.party))
            .map((credential) => (
              <div key={credential.party} className="credential-row">
                <Tag color="arcoblue" className="credential-party-tag">
                  {CONTRACT_PARTY_LABELS[credential.party]}一次性凭据
                </Tag>
                <Input.TextArea readOnly value={credential.token} autoSize className="credential-token-box" />
                <Button size="small" icon={<IconCopy />} onClick={() => void copyToken(credential.token)}>
                  复制
                </Button>
              </div>
            ))}
          <Typography.Text type="secondary">
            凭据使用一次即作废：同一枚凭据重复提交不会产生第二次效果；甲方凭据不能用于乙方操作，反之亦然。
          </Typography.Text>
        </Space>
      ) : (
        <Form<FormValues> form={form} layout="vertical" className="amendment-form">
          <Form.Item field="title" label="变更标题" rules={[{ required: true, message: '请填写变更标题' }]}>
            <Input placeholder="例如：付款期限延长 30 天" maxLength={60} showWordLimit />
          </Form.Item>

          <Form.Item field="proposedBy" label="发起方（仅作记录，发起不等于确认）" rules={[{ required: true }]}>
            <Radio.Group
              options={[
                { label: CONTRACT_PARTY_LABELS[ContractParty.PartyA], value: ContractParty.PartyA },
                { label: CONTRACT_PARTY_LABELS[ContractParty.PartyB], value: ContractParty.PartyB }
              ]}
            />
          </Form.Item>

          <Form.Item field="reason" label="变更原因 / 说明">
            <Input.TextArea placeholder="说明本次变更的背景，供双方确认时参考" autoSize={{ minRows: 2, maxRows: 5 }} />
          </Form.Item>

          <div className="arco-form-item">
            <div className="arco-form-label-item">
              <label>变更后正文（双方凭凭据确认通过后替换当前正文）</label>
            </div>
            <RichEditor value={proposedHtml} onChange={setProposedHtml} minHeight={260} placeholder="编辑变更后的完整合同正文..." />
          </div>
        </Form>
      )}
    </Modal>
  );
}
