'use client';

import { Button, Flexbox, Icon } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { Trash2Icon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import MCPInstallProgress from '@/features/MCP/MCPInstallProgress';
import { useDetailContext } from '@/features/MCPPluginDetail/DetailProvider';
import { useToolStore } from '@/store/tool';
import { pluginSelectors } from '@/store/tool/slices/plugin/selectors';

const styles = createStaticStyles(({ css }) => ({
  button: css`
    button {
      width: 100%;
    }
  `,
}));

const ActionButton = memo(() => {
  const { t } = useTranslation(['discover', 'plugin']);
  const detailContext = useDetailContext();
  const { identifier } = detailContext;
  const [isLoading, setIsLoading] = useState(false);

  const [installed, installMCPPlugin, uninstallMCPPlugin] = useToolStore((s) => [
    pluginSelectors.isPluginInstalled(identifier!)(s),
    s.installMCPPlugin,
    s.uninstallMCPPlugin,
  ]);

  const installPlugin = async () => {
    if (!identifier) return;

    setIsLoading(true);
    try {
      await installMCPPlugin(identifier);
    } finally {
      setIsLoading(false);
    }
  };

  const buttonLoading = isLoading;

  return installed ? (
    <Flexbox horizontal gap={8}>
      <Button
        block
        className={styles.button}
        disabled={buttonLoading}
        size={'large'}
        type={'default'}
      >
        {t('plugins.installed')}
      </Button>

      <Button
        icon={<Icon icon={Trash2Icon} size={20} />}
        loading={buttonLoading}
        size={'large'}
        style={{ minWidth: 45 }}
        styles={{
          icon: { height: 20 },
        }}
        onClick={async () => {
          setIsLoading(true);
          await uninstallMCPPlugin(identifier!);
          setIsLoading(false);
        }}
      />
    </Flexbox>
  ) : (
    <>
      <Button
        block
        className={styles.button}
        loading={buttonLoading}
        size={'large'}
        type={'primary'}
        onClick={installPlugin}
      >
        {t('plugins.install')}
      </Button>
      <MCPInstallProgress identifier={identifier!} />
    </>
  );
});

export default ActionButton;
