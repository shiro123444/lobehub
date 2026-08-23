import { ActionIcon, Button } from '@lobehub/ui';
import { useResponsive } from 'antd-style';
import { Plus } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MOBILE_HEADER_ICON_SIZE } from '@/const/layoutTokens';
import SubmitRepoModal from '@/features/NexusRegistry/SubmitRepoModal';

const CreateButton = memo<{ mobile?: boolean }>(({ mobile }) => {
  const { mobile: resMobile } = useResponsive();
  const { t } = useTranslation('discover');
  const [isModalOpen, setIsModalOpen] = useState(false);

  const buttonContent =
    mobile || resMobile ? (
      <ActionIcon
        icon={Plus}
        size={MOBILE_HEADER_ICON_SIZE}
        title={t('user.submitRepo')}
        onClick={() => setIsModalOpen(true)}
      />
    ) : (
      <Button icon={Plus} style={{ flex: 'none' }} onClick={() => setIsModalOpen(true)}>
        {t('user.submitRepo')}
      </Button>
    );

  return (
    <>
      {buttonContent}
      <SubmitRepoModal open={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </>
  );
});

export default CreateButton;
