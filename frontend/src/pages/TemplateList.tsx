import { Button, Input, Message, Space, Table, Tag, Typography } from '@arco-design/web-react';
import { IconExport, IconImport, IconPlus } from '@arco-design/web-react/icon';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CategoryFilter, TemplateCard } from '../components/common';
import { useAmendmentStore } from '../stores/amendment';
import { useClauseStore } from '../stores/clause';
import { useInstanceStore } from '../stores/instance';
import { useTemplateStore } from '../stores/template';
import { AmendmentStatus } from '../types/amendment';
import { ContractStatus, CONTRACT_STATUS_LABELS, TemplateCategory, TEMPLATE_CATEGORY_LABELS } from '../types/enums';
import { ExportPayload, exportAllData, importAllData } from '../utils/db';
import { downloadJson, readJsonFile } from '../utils/export';

export function TemplateList() {
  const navigate = useNavigate();
  const importInputRef = useRef<HTMLInputElement>(null);
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('all');
  const { templates, loadTemplates, createTemplate, duplicateTemplate, deleteTemplate } = useTemplateStore();
  const { createFromTemplate, instances, loadInstances } = useInstanceStore();
  const { loadClauses } = useClauseStore();
  const { amendments, loadAmendments } = useAmendmentStore();

  useEffect(() => {
    void Promise.all([loadTemplates(), loadInstances(), loadClauses(), loadAmendments()]);
  }, [loadClauses, loadInstances, loadTemplates, loadAmendments]);

  const categoryOptions = Object.values(TemplateCategory).map((value) => ({
    value,
    label: TEMPLATE_CATEGORY_LABELS[value],
    count: templates.filter((template) => template.category === value).length
  }));

  const filteredTemplates = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return templates.filter((template) => {
      const categoryMatched = category === 'all' || template.category === category;
      const keywordMatched =
        !normalizedKeyword ||
        template.title.toLowerCase().includes(normalizedKeyword) ||
        template.tags.some((tag) => tag.toLowerCase().includes(normalizedKeyword));
      return categoryMatched && keywordMatched;
    });
  }, [category, keyword, templates]);

  const createNewTemplate = async () => {
    const template = await createTemplate();
    navigate(`/templates/${template.id}/edit`);
  };

  const createInstance = async (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) {
      return;
    }

    const instance = await createFromTemplate(template);
    navigate(`/instances/${instance.id}`);
  };

  const handleExport = async () => {
    downloadJson(await exportAllData());
    Message.success('已导出本地数据');
  };

  const handleImport = async (file?: File) => {
    if (!file) {
      return;
    }

    try {
      const payload = await readJsonFile<ExportPayload>(file);
      await importAllData(payload);
      await Promise.all([loadTemplates(), loadInstances(), loadClauses(), loadAmendments()]);
      Message.success('导入完成');
    } catch {
      Message.error('导入失败，请确认 JSON 格式');
    } finally {
      if (importInputRef.current) {
        importInputRef.current.value = '';
      }
    }
  };

  return (
    <section className="page-section">
      <div className="page-heading">
        <div>
          <Typography.Title heading={3}>模板库</Typography.Title>
          <Typography.Text type="secondary">管理合同模板，按分类、标签和关键词快速定位。</Typography.Text>
        </div>
        <Space wrap>
          <Button icon={<IconImport />} onClick={() => importInputRef.current?.click()}>
            导入
          </Button>
          <Button icon={<IconExport />} onClick={handleExport}>
            导出
          </Button>
          <Button type="primary" icon={<IconPlus />} onClick={createNewTemplate}>
            新建模板
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            className="visually-hidden"
            onChange={(event) => void handleImport(event.target.files?.[0])}
          />
        </Space>
      </div>

      <div className="toolbar-row">
        <Input.Search allowClear placeholder="搜索模板标题或标签" value={keyword} onChange={setKeyword} />
        <CategoryFilter value={category} options={categoryOptions} onChange={setCategory} />
      </div>

      <div className="template-grid">
        {filteredTemplates.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
            onEdit={() => navigate(`/templates/${template.id}/edit`)}
            onDuplicate={() => void duplicateTemplate(template.id)}
            onDelete={() => void deleteTemplate(template.id)}
            onCreateInstance={() => void createInstance(template.id)}
          />
        ))}
      </div>

      {!filteredTemplates.length && <div className="empty-state">没有匹配的模板。</div>}

      {instances.length > 0 && (
        <div className="instance-overview">
          <div className="instance-overview-heading">
            <Typography.Title heading={5}>合同实例</Typography.Title>
            <Typography.Text type="secondary">
              共 {instances.length} 份；已签署合同的变更需进入实例详情，经双方确认后才会替换正文。
            </Typography.Text>
          </div>
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            data={instances}
            columns={[
              {
                title: '实例标题',
                dataIndex: 'title'
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 110,
                render: (status: ContractStatus) => (
                  <Tag color={status === ContractStatus.Signed ? 'green' : status === ContractStatus.Finalized ? 'blue' : 'gray'}>
                    {CONTRACT_STATUS_LABELS[status]}
                  </Tag>
                )
              },
              {
                title: '待确认变更',
                width: 110,
                render: (_: unknown, record: { id: string; status: ContractStatus }) => {
                  if (record.status !== ContractStatus.Signed) {
                    return <Typography.Text type="secondary">—</Typography.Text>;
                  }
                  const count = amendments.filter(
                    (item) => item.contractInstanceId === record.id && item.status === AmendmentStatus.Pending
                  ).length;
                  return count > 0 ? <Tag color="orange">{count} 条待确认</Tag> : <Typography.Text type="secondary">无</Typography.Text>;
                }
              },
              {
                title: '更新时间',
                dataIndex: 'updatedAt',
                width: 190,
                render: (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
              },
              {
                title: '操作',
                width: 90,
                render: (_: unknown, record: { id: string }) => (
                  <Button type="text" size="small" onClick={() => navigate(`/instances/${record.id}`)}>
                    打开实例
                  </Button>
                )
              }
            ]}
          />
        </div>
      )}
    </section>
  );
}
