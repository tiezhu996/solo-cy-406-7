import { Form, Input, Message, Modal, Radio } from '@arco-design/web-react';
import { useEffect, useState } from 'react';
import { ContractInstance } from '../../types/contract-instance';
import { AmendmentContent } from '../../types/amendment';
import { ContractParty, CONTRACT_PARTY_LABELS } from '../../types/enums';
import { useAmendmentStore } from '../../stores/amendment';
import { RichEditor } from '../common';

interface RegisterAmendmentModalProps {
  visible: boolean;
  instance: ContractInstance;
  onClose: () => void;
  onRegistered?: () => void;
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
 */
export function RegisterAmendmentModal({ visible, instance, onClose, onRegistered }: RegisterAmendmentModalProps) {
  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState(false);
  // 正文不走 Form 注入（RichEditor 是 onChange(html) 形态），单独受控并参与校验
  const [proposedHtml, setProposedHtml] = useState('');
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
      await registerAmendment({
        contractInstanceId: instance.id,
        content,
        proposedBy: values.proposedBy
      });
      Message.success('变更已登记，停在双方确认阶段；在双方确认前原合同继续有效');
      onRegistered?.();
      onClose();
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '登记失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="登记合同变更"
      visible={visible}
      style={{ width: 880, maxWidth: '92vw' }}
      unmountOnExit
      confirmLoading={submitting}
      okText="提交登记"
      cancelText="取消"
      onOk={() => void handleSubmit()}
      onCancel={onClose}
    >
      <Form<FormValues> form={form} layout="vertical" className="amendment-form">
        <Form.Item field="title" label="变更标题" rules={[{ required: true, message: '请填写变更标题' }]}>
          <Input placeholder="例如：付款期限延长 30 天" maxLength={60} showWordLimit />
        </Form.Item>

        <Form.Item field="proposedBy" label="发起方" rules={[{ required: true }]}>
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
            <label>变更后正文（双方确认通过后替换当前正文）</label>
          </div>
          <RichEditor value={proposedHtml} onChange={setProposedHtml} minHeight={260} placeholder="编辑变更后的完整合同正文..." />
        </div>
      </Form>
    </Modal>
  );
}
