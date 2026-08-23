'use client';

import { Block, Flexbox, Icon, Modal, Segmented, Text } from '@lobehub/ui';
import { GithubIcon } from '@lobehub/ui/icons';
import { App, Form, Input, Select, Steps, Switch, Upload } from 'antd';
import type { UploadFile } from 'antd/es/upload/interface';
import { BotIcon, FileArchiveIcon, SparklesIcon } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { nexusRegistryService } from '@/services/nexusRegistry';

interface SubmitRepoModalProps {
  onClose: () => void;
  onSuccess?: () => void;
  open: boolean;
}

type AiMode = 'normalize' | 'off' | 'polish';
type RepoKind = 'auto' | 'mcp' | 'plugin' | 'skill';
type SourceType = 'github' | 'manifest' | 'skill-md' | 'zip';

interface SubmitRepoFormValues {
  aiEnabled?: boolean;
  aiMode?: AiMode;
  content?: string;
  description?: string;
  file?: UploadFile[];
  gitUrl?: string;
  kind: RepoKind;
  manifestText?: string;
  name?: string;
  sourceType: SourceType;
  tags?: string;
}

const GITHUB_URL_REGEX =
  /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\/(?:tree|blob)\/[^/]+(?:\/.+)?)?\/?$/;

const parseTags = (value?: string): string[] | undefined => {
  const tags = value
    ?.split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);

  return tags && tags.length > 0 ? tags : undefined;
};

const readUploadFile = async (file?: UploadFile): Promise<string | undefined> => {
  const origin = file?.originFileObj;
  if (!origin) return;

  return origin.text();
};

const readUploadFileBase64 = async (file?: UploadFile): Promise<string | undefined> => {
  const origin = file?.originFileObj;
  if (!origin) return;

  const buffer = await origin.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary);
};

const readManifest = (value?: string): Record<string, unknown> | undefined => {
  if (!value?.trim()) return;

  return JSON.parse(value);
};

export const SubmitRepoModal = memo<SubmitRepoModalProps>(({ open, onClose, onSuccess }) => {
  const { t } = useTranslation('discover');
  const { message } = App.useApp();
  const [form] = Form.useForm<SubmitRepoFormValues>();
  const [sourceType, setSourceType] = useState<SourceType>('github');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const sourceOptions = useMemo(
    () => [
      {
        icon: <Icon icon={GithubIcon} />,
        label: t('user.submitSource.github'),
        value: 'github',
      },
      {
        icon: <Icon icon={BotIcon} />,
        label: 'SKILL.md',
        value: 'skill-md',
      },
      {
        icon: <Icon icon={SparklesIcon} />,
        label: t('user.submitSource.manifest'),
        value: 'manifest',
      },
      {
        icon: <Icon icon={FileArchiveIcon} />,
        label: 'ZIP',
        value: 'zip',
      },
    ],
    [t],
  );

  const handleSubmit = useCallback(async () => {
    try {
      const values = await form.validateFields();
      const aiMode: AiMode = values.aiEnabled === false ? 'off' : (values.aiMode ?? 'normalize');

      setIsSubmitting(true);

      if (values.sourceType === 'github') {
        const gitUrl = values.gitUrl?.trim();
        if (!gitUrl) return;

        await nexusRegistryService.submitRepo({
          aiMode,
          description: values.description?.trim() || undefined,
          gitUrl,
          kind: values.kind,
          name: values.name?.trim() || undefined,
          tags: parseTags(values.tags),
        });
      } else {
        const file = values.file?.[0];
        const isZip = values.sourceType === 'zip';
        const uploadedContent = isZip ? undefined : await readUploadFile(file);
        const artifactBase64 = isZip ? await readUploadFileBase64(file) : undefined;
        const content =
          values.sourceType === 'manifest'
            ? values.manifestText?.trim()
            : values.content?.trim() || uploadedContent;
        const manifest =
          values.sourceType === 'manifest' ? readManifest(values.manifestText) : undefined;

        await nexusRegistryService.submitArtifact({
          aiMode,
          artifact: file
            ? {
                dataBase64: artifactBase64,
                fileName: file.name,
                mimeType: file.type,
                size: file.size,
              }
            : undefined,
          content,
          description: values.description?.trim() || undefined,
          fileName: file?.name,
          kind: values.kind,
          manifest,
          name: values.name?.trim() || undefined,
          sourceType: values.sourceType,
          tags: parseTags(values.tags),
        });
      }

      message.success(t('user.submitRepoSuccess'));
      onSuccess?.();
      onClose();
      form.resetFields();
      setSourceType('github');
    } catch (error) {
      if (error && typeof error === 'object' && 'errorFields' in error) return;

      console.error('[SubmitRepoModal] Failed to submit:', error);
      message.error(error instanceof Error ? error.message : t('user.submitRepoError'));
    } finally {
      setIsSubmitting(false);
    }
  }, [form, message, onClose, onSuccess, t]);

  const handleCancel = useCallback(() => {
    form.resetFields();
    setSourceType('github');
    onClose();
  }, [form, onClose]);

  return (
    <Modal
      centered
      cancelText={t('user.cancel')}
      confirmLoading={isSubmitting}
      okText={t('user.submit')}
      open={open}
      title={false}
      width={680}
      onCancel={handleCancel}
      onOk={handleSubmit}
    >
      <Flexbox gap={20} style={{ marginTop: 16 }}>
        <Flexbox horizontal align={'center'} gap={12}>
          <Block
            padding={8}
            variant={'outlined'}
            style={{ borderRadius: 12, flex: 'none', lineHeight: 0 }}
          >
            <Icon icon={SparklesIcon} size={22} />
          </Block>
          <Flexbox gap={4}>
            <Text strong fontSize={20}>
              {t('user.submitRepoTitle')}
            </Text>
            <Text type="secondary">{t('user.submitRepoDescription')}</Text>
          </Flexbox>
        </Flexbox>

        <Steps
          size="small"
          current={0}
          items={[
            { title: t('user.submitStep.source') },
            { title: t('user.submitStep.preview') },
            { title: t('user.submitStep.review') },
          ]}
        />

        <Form
          form={form}
          initialValues={{
            aiEnabled: true,
            aiMode: 'normalize',
            kind: 'auto',
            sourceType: 'github',
          }}
          layout="vertical"
        >
          <Form.Item label={t('user.submitSource')} name="sourceType">
            <Segmented
              block
              options={sourceOptions}
              onChange={(value) => {
                setSourceType(value as SourceType);
                form.setFieldValue('sourceType', value);
              }}
            />
          </Form.Item>

          <Flexbox horizontal gap={12}>
            <Form.Item
              label={t('user.repoKind')}
              name="kind"
              rules={[{ required: true }]}
              style={{ flex: 1 }}
            >
              <Select
                options={[
                  { label: t('user.repoKind.auto'), value: 'auto' },
                  { label: t('user.repoKind.skill'), value: 'skill' },
                  { label: 'MCP', value: 'mcp' },
                  { label: t('user.repoKind.plugin'), value: 'plugin' },
                ]}
              />
            </Form.Item>
            <Form.Item label={t('user.aiPolish')} name="aiEnabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Flexbox>

          <Form.Item noStyle shouldUpdate={(prev, next) => prev.aiEnabled !== next.aiEnabled}>
            {({ getFieldValue }) =>
              getFieldValue('aiEnabled') ? (
                <Form.Item label={t('user.aiPolishMode')} name="aiMode">
                  <Select
                    options={[
                      { label: t('user.aiPolishMode.normalize'), value: 'normalize' },
                      { label: t('user.aiPolishMode.polish'), value: 'polish' },
                    ]}
                  />
                </Form.Item>
              ) : null
            }
          </Form.Item>

          {sourceType === 'github' && (
            <Form.Item
              label={t('user.githubUrl')}
              name="gitUrl"
              rules={[
                { message: t('user.githubUrlRequired'), required: true },
                {
                  message: t('user.githubUrlInvalid'),
                  pattern: GITHUB_URL_REGEX,
                },
              ]}
            >
              <Input placeholder="https://github.com/username/repo" />
            </Form.Item>
          )}

          {sourceType === 'skill-md' && (
            <Form.Item
              label="SKILL.md"
              name="content"
              rules={[{ message: t('user.artifactContentRequired'), required: true }]}
            >
              <Input.TextArea
                autoSize={{ maxRows: 10, minRows: 6 }}
                placeholder={t('user.skillMdPlaceholder')}
              />
            </Form.Item>
          )}

          {sourceType === 'manifest' && (
            <Form.Item
              label={t('user.manifestJson')}
              name="manifestText"
              rules={[{ message: t('user.artifactContentRequired'), required: true }]}
            >
              <Input.TextArea
                autoSize={{ maxRows: 10, minRows: 6 }}
                placeholder={`{\n  "name": "my-mcp",\n  "tools": []\n}`}
              />
            </Form.Item>
          )}

          {sourceType === 'zip' && (
            <Form.Item
              label={t('user.zipPackage')}
              name="file"
              valuePropName="fileList"
              getValueFromEvent={(event) => event?.fileList?.slice(-1)}
              rules={[{ message: t('user.zipPackageRequired'), required: true }]}
            >
              <Upload beforeUpload={() => false} maxCount={1}>
                <Block clickable padding={16} variant="outlined" style={{ textAlign: 'center' }}>
                  <Text>{t('user.zipPackageHint')}</Text>
                </Block>
              </Upload>
            </Form.Item>
          )}

          <Flexbox horizontal gap={12}>
            <Form.Item label={t('user.repoName')} name="name" style={{ flex: 1 }}>
              <Input placeholder={t('user.repoNamePlaceholder')} />
            </Form.Item>
            <Form.Item label={t('user.repoTags')} name="tags" style={{ flex: 1 }}>
              <Input placeholder={t('user.repoTagsPlaceholder')} />
            </Form.Item>
          </Flexbox>
          <Form.Item label={t('user.repoDescription')} name="description">
            <Input.TextArea autoSize={{ maxRows: 4, minRows: 2 }} />
          </Form.Item>
        </Form>

        <Block padding={12} variant="outlined">
          <Text style={{ fontSize: 12 }} type="secondary">
            {t('user.submitRepoHint')}
          </Text>
        </Block>
      </Flexbox>
    </Modal>
  );
});

SubmitRepoModal.displayName = 'SubmitRepoModal';

export default SubmitRepoModal;
