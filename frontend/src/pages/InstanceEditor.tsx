import { Alert, Button, Input, Message, Select, Space, Typography } from '@arco-design/web-react';
import { IconHistory, IconSave } from '@arco-design/web-react/icon';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AmendmentPanel } from '../components/amendment';
import { VariableForm } from '../components/common';
import { ContractPreview } from '../components/preview/ContractPreview';
import { useVariableReplace } from '../hooks/useVariableReplace';
import { useAmendmentStore } from '../stores/amendment';
import { useInstanceStore } from '../stores/instance';
import { useTemplateStore } from '../stores/template';
import { useVersionStore } from '../stores/version';
import { ContractStatus, CONTRACT_STATUS_LABELS } from '../types/enums';
import { VariableValues } from '../types/contract-instance';

const statusOptions = Object.values(ContractStatus).map((value) => ({
  label: CONTRACT_STATUS_LABELS[value],
  value
}));

export function InstanceEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [values, setValues] = useState<VariableValues>({});
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState(ContractStatus.Draft);
  const [remark, setRemark] = useState('');
  const { instances, loadInstances, updateInstance } = useInstanceStore();
  const { templates, loadTemplates } = useTemplateStore();
  const { loadVersions, saveVersion } = useVersionStore();
  const { loadAmendments } = useAmendmentStore();

  useEffect(() => {
    void Promise.all([loadInstances(), loadTemplates(), loadVersions(), loadAmendments()]);
  }, [loadInstances, loadTemplates, loadVersions, loadAmendments]);

  const instance = useMemo(() => instances.find((item) => item.id === id), [id, instances]);
  const template = useMemo(() => templates.find((item) => item.id === instance?.templateId), [instance?.templateId, templates]);
  const previewHtml = useVariableReplace(template, values);

  useEffect(() => {
    if (instance) {
      setValues(instance.variableValues);
      setTitle(instance.title);
      setStatus(instance.status);
    }
  }, [instance]);

  if (!instance || !template) {
    return <div className="empty-state">正在加载合同实例...</div>;
  }

  // 已签署即冻结：正文只能通过「合同变更确认」模块，在双方确认后被新版本替换
  const isSigned = instance.status === ContractStatus.Signed;
  const displayedHtml = isSigned ? instance.finalHtml : previewHtml;

  const buildNextInstance = () => ({
    ...instance,
    title: title || instance.title,
    variableValues: values,
    finalHtml: previewHtml,
    status
  });

  const saveInstance = async () => {
    await updateInstance(buildNextInstance());
    Message.success('合同实例已保存');
  };

  const saveSnapshot = async () => {
    const nextInstance = buildNextInstance();
    await updateInstance(nextInstance);
    const version = await saveVersion(nextInstance, remark);
    await updateInstance({
      ...nextInstance,
      versionIds: Array.from(new Set([...nextInstance.versionIds, version.id]))
    });
    setRemark('');
    Message.success(`已保存版本 ${version.versionNo}`);
  };

  return (
    <section className="page-section instance-page">
      <div className="page-heading">
        <div>
          <Typography.Title heading={3}>合同实例编辑</Typography.Title>
          <Typography.Text type="secondary">
            {isSigned
              ? '合同已签署并冻结，正文只能通过下方「合同变更确认」在双方确认后替换。'
              : '填写变量后实时生成最终合同 HTML；签署后正文将被冻结。'}
          </Typography.Text>
        </div>
        <Space wrap>
          <Button icon={<IconHistory />} onClick={() => navigate(`/instances/${instance.id}/versions`)}>
            版本对比
          </Button>
          {!isSigned && (
            <>
              <Button icon={<IconSave />} onClick={() => void saveInstance()}>
                保存实例
              </Button>
              <Button type="primary" onClick={() => void saveSnapshot()}>
                保存版本
              </Button>
            </>
          )}
        </Space>
      </div>

      <div className="instance-meta-bar">
        <Input value={title} onChange={setTitle} placeholder="实例标题" disabled={isSigned} />
        <Select value={status} options={statusOptions} onChange={setStatus} disabled={isSigned} />
        <Input value={remark} onChange={setRemark} placeholder="版本备注，例如：客户首轮修改" disabled={isSigned} />
      </div>

      {isSigned && (
        <Alert
          type="warning"
          className="signed-freeze-banner"
          content="已签署合同的原正文继续有效。任何修改都必须登记为变更，并经甲、乙双方确认后才会生成新版本替换当前正文；任一方撤回则变更失效。"
        />
      )}

      <div className="instance-grid">
        <ContractPreview
          title={title || instance.title}
          html={displayedHtml}
        />
        <div className="form-panel">
          <Typography.Title heading={5}>{isSigned ? '当前签署正文（只读）' : '变量填写'}</Typography.Title>
          {isSigned ? (
            <Alert
              type="info"
              content="变量与正文已随签署锁定。如需调整，请在下方「合同变更确认」中登记，变更停在双方确认阶段，不会立刻改动本页正文。"
            />
          ) : (
            <VariableForm variables={template.variables} values={values} onChange={setValues} />
          )}
        </div>
      </div>

      {isSigned && (
        <div className="amendment-section">
          <AmendmentPanel key={instance.id} instance={instance} />
        </div>
      )}
    </section>
  );
}
