'use client';

import { ModelTag } from '@lobehub/icons';
import {
  ActionIconGroup,
  Block,
  Center,
  Empty,
  Flexbox,
  Icon,
  Image,
  Tag,
  Text,
} from '@lobehub/ui';
import { App } from 'antd';
import { createStaticStyles } from 'antd-style';
import dayjs from 'dayjs';
import { omit } from 'es-toolkit/compat';
import { CopyIcon, DownloadIcon, ImagesIcon, RotateCcwSquareIcon, Trash2 } from 'lucide-react';
import type { RuntimeImageGenParams } from 'model-bank';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import ImageItem from '@/components/ImageItem';
import NeuralNetworkLoading from '@/components/NeuralNetworkLoading';
import NavHeader from '@/features/NavHeader';
import WideScreenButton from '@/features/WideScreenContainer/WideScreenButton';
import { useDownloadImage } from '@/hooks/useDownloadImage';
import { useClientDataSWR } from '@/libs/swr';
import { generationService } from '@/services/generation';
import { useImageStore } from '@/store/image';
import type { ImageGenerationGalleryItem } from '@/types/generation';
import { inferFileExtensionFromImageUrl } from '@/utils/url';

const styles = createStaticStyles(({ css, cssVar, cx }) => ({
  actions: cx(
    'gallery-card-actions',
    css`
      opacity: 0;
      transition: opacity 0.12s ${cssVar.motionEaseInOut};
    `,
  ),
  card: css`
    break-inside: avoid;
    overflow: hidden;
    margin-block-end: 16px;

    &:hover {
      .gallery-card-actions {
        opacity: 1;
      }
    }
  `,
  content: css`
    padding: 12px;
  `,
  cover: css`
    overflow: hidden;
    background: ${cssVar.colorFillTertiary};
  `,
  grid: css`
    column-count: 4;
    column-gap: 16px;

    @media (max-width: 1440px) {
      column-count: 3;
    }

    @media (max-width: 960px) {
      column-count: 2;
    }

    @media (max-width: 640px) {
      column-count: 1;
    }
  `,
  meta: css`
    opacity: 0.72;
  `,
  page: css`
    overflow-y: auto;
    background: ${cssVar.colorBgContainer};
  `,
  prompt: css`
    display: -webkit-box;
    overflow: hidden;
    min-height: 40px;

    font-size: 13px;
    line-height: 1.55;
    color: ${cssVar.colorText};

    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  `,
  shell: css`
    width: min(1480px, 100%);
    margin: 0 auto;
    padding: 20px 32px 48px;
  `,
  title: css`
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
}));

const getAspectRatio = (item: ImageGenerationGalleryItem) => {
  const asset = item.generation.asset;
  if (asset?.width && asset?.height) return `${asset.width} / ${asset.height}`;
  if (item.batch.width && item.batch.height) return `${item.batch.width} / ${item.batch.height}`;
  return '1 / 1';
};

const ImageGallery = memo(() => {
  const { t } = useTranslation('image');
  const { message } = App.useApp();
  const navigate = useNavigate();
  const reuseSettings = useImageStore((s) => s.reuseSettings);
  const { downloadImage } = useDownloadImage();

  const { data, isLoading, mutate } = useClientDataSWR<ImageGenerationGalleryItem[]>(
    ['image-gallery', 120],
    async ([, limit]: [string, number]) => generationService.getImageGallery(limit),
  );

  const items = useMemo(() => data ?? [], [data]);

  const handleReuseSettings = (item: ImageGenerationGalleryItem) => {
    reuseSettings(
      item.batch.model,
      item.batch.provider,
      omit(item.batch.config as RuntimeImageGenParams, ['seed']),
    );
    navigate('/image');
  };

  const handleCopyPrompt = async (prompt: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
      message.success(t('generation.actions.promptCopied'));
    } catch (error) {
      console.error('Failed to copy prompt:', error);
      message.error(t('generation.actions.promptCopyFailed'));
    }
  };

  const handleDownloadImage = async (item: ImageGenerationGalleryItem) => {
    const url = item.generation.asset?.url;
    if (!url) return;

    const timestamp = dayjs(item.generation.createdAt).format('YYYY-MM-DD_HH-mm-ss');
    const baseName = item.batch.prompt.slice(0, 30).trim();
    const safePrompt = baseName.replaceAll(/["%*/:<>?\\|]/g, '').replaceAll(/\s+/g, '_') || 'image';
    const fileExtension = inferFileExtensionFromImageUrl(url);

    await downloadImage(url, `${safePrompt}_${timestamp}.${fileExtension}`);
  };

  const handleDeleteGeneration = async (generationId: string) => {
    await generationService.deleteGeneration(generationId);
    await mutate();
  };

  return (
    <>
      <NavHeader
        right={<WideScreenButton />}
        styles={{
          center: { alignItems: 'center', display: 'flex', justifyContent: 'center', minWidth: 0 },
          left: { flex: 1, minWidth: 0 },
          right: { flex: 1, minWidth: 0 },
        }}
      />
      <Flexbox className={styles.page} height="100%" width="100%">
        <Flexbox className={styles.shell} gap={20}>
          <Flexbox horizontal align="center" justify="space-between">
            <Flexbox horizontal align="center" gap={8}>
              <Icon icon={ImagesIcon} size={18} />
              <h1 className={styles.title}>{t('gallery.title')}</h1>
              {items.length > 0 && <Tag variant="borderless">{items.length}</Tag>}
            </Flexbox>
          </Flexbox>

          {isLoading ? (
            <Center flex={1} height="60vh">
              <NeuralNetworkLoading size={64} />
            </Center>
          ) : items.length === 0 ? (
            <Center flex={1} height="60vh">
              <Empty description={t('gallery.empty.desc')} icon={ImagesIcon} title={t('gallery.empty.title')} />
            </Center>
          ) : (
            <Image.PreviewGroup>
              <div className={styles.grid}>
                {items.map((item) => {
                  const url = item.generation.asset?.url;
                  if (!url) return null;

                  return (
                    <Block className={styles.card} key={item.generation.id} variant="filled">
                      <div className={styles.cover} style={{ aspectRatio: getAspectRatio(item) }}>
                        <ImageItem
                          alt={item.batch.prompt}
                          style={{ height: '100%', width: '100%' }}
                          url={url}
                          preview={{ src: url }}
                        />
                      </div>
                      <Flexbox className={styles.content} gap={10}>
                        <div className={styles.prompt}>{item.batch.prompt}</div>
                        <Flexbox horizontal align="center" className={styles.meta} gap={4} wrap="wrap">
                          <ModelTag model={item.batch.model} variant="borderless" />
                          {item.batch.width && item.batch.height && (
                            <Tag variant="borderless">
                              {item.batch.width} × {item.batch.height}
                            </Tag>
                          )}
                          <Text as="time" fontSize={12} type="secondary">
                            {dayjs(item.generation.createdAt).format('YYYY-MM-DD HH:mm')}
                          </Text>
                        </Flexbox>
                        <ActionIconGroup
                          className={styles.actions}
                          items={[
                            {
                              icon: RotateCcwSquareIcon,
                              key: 'reuse',
                              label: t('generation.actions.reuseSettings'),
                              onClick: () => handleReuseSettings(item),
                            },
                            {
                              icon: CopyIcon,
                              key: 'copy',
                              label: t('generation.actions.copyPrompt'),
                              onClick: () => handleCopyPrompt(item.batch.prompt),
                            },
                            {
                              icon: DownloadIcon,
                              key: 'download',
                              label: t('generation.actions.download'),
                              onClick: () => handleDownloadImage(item),
                            },
                            {
                              danger: true,
                              icon: Trash2,
                              key: 'delete',
                              label: t('generation.actions.delete'),
                              onClick: () => handleDeleteGeneration(item.generation.id),
                            },
                          ]}
                        />
                      </Flexbox>
                    </Block>
                  );
                })}
              </div>
            </Image.PreviewGroup>
          )}
        </Flexbox>
      </Flexbox>
    </>
  );
});

ImageGallery.displayName = 'ImageGallery';

export default ImageGallery;
