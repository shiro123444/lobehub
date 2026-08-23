import { BRANDING_NAME } from '@lobechat/business-const';
import { Alert, Button, Flexbox, Icon, Input, Skeleton, Text } from '@lobehub/ui';
import { type FormInstance, type InputRef } from 'antd';
import { Badge, Divider, Form, Modal } from 'antd';
import { createStaticStyles } from 'antd-style';
import { CheckCircle2, ChevronRight, Clock3, Mail, MessageCircle, RotateCcw } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { message } from '@/components/AntdStaticMethods';
import AuthIcons from '@/components/AuthIcons';
import { PRIVACY_URL, TERMS_URL } from '@/const/url';

import AuthCard from '../../../../features/AuthCard';

const styles = createStaticStyles(({ css, cssVar }) => ({
  qqCode: css`
    font-size: 42px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: 0.24em;
  `,
  qqCodeBlock: css`
    position: relative;

    overflow: hidden;

    padding: 22px 20px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 20px;

    background:
      radial-gradient(circle at 18% 16%, ${cssVar.colorFillSecondary}, transparent 34%),
      linear-gradient(135deg, ${cssVar.colorFillTertiary}, ${cssVar.colorBgContainer});
  `,
  qqCodeLabel: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  qqIcon: css`
    display: grid;
    place-items: center;
    flex: 0 0 auto;

    width: 44px;
    height: 44px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 14px;

    color: ${cssVar.colorTextSecondary};
    background: ${cssVar.colorFillTertiary};
  `,
  qqLoginModal: css`
    .ant-modal-content {
      overflow: hidden;
      padding: 0;
      border: 1px solid ${cssVar.colorBorderSecondary};
      border-radius: 24px;

      background: ${cssVar.colorBgElevated};
      box-shadow: ${cssVar.boxShadowSecondary};
    }

    .ant-modal-close {
      inset-block-start: 14px;
      inset-inline-end: 14px;
    }
  `,
  qqPanel: css`
    padding: 28px;
  `,
  qqStatus: css`
    min-height: 42px;
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 14px;

    background: ${cssVar.colorFillQuaternary};
  `,
  qqStatusIcon: css`
    display: grid;
    place-items: center;
    flex: 0 0 auto;

    width: 22px;
    height: 22px;
    border-radius: 50%;

    color: ${cssVar.colorTextSecondary};
    background: ${cssVar.colorFillSecondary};
  `,
  qqStatusIconSuccess: css`
    color: ${cssVar.colorSuccess};
    background: ${cssVar.colorSuccessBg};
  `,
  qqStatusIconWarning: css`
    color: ${cssVar.colorWarning};
    background: ${cssVar.colorWarningBg};
  `,
  setPasswordLink: css`
    cursor: pointer;
    color: ${cssVar.colorPrimary};
    text-decoration: underline;
  `,
}));

export const EMAIL_REGEX = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;
export const USERNAME_REGEX = /^\w+$/;

export interface SignInEmailStepProps {
  disableEmailPassword?: boolean;
  form: FormInstance<{ email: string }>;
  isSocialOnly: boolean;
  lastAuthProvider?: string | null;
  loading: boolean;
  oAuthSSOProviders: string[];
  onCheckUser: (values: { email: string }) => Promise<void>;
  onSetPassword: () => void;
  onSocialSignIn: (provider: string) => void;
  serverConfigInit: boolean;
  socialLoading: string | null;
}

export const SignInEmailStep = ({
  disableEmailPassword,
  form,
  isSocialOnly,
  lastAuthProvider,
  loading,
  oAuthSSOProviders,
  serverConfigInit,
  socialLoading,
  onCheckUser,
  onSetPassword,
  onSocialSignIn,
}: SignInEmailStepProps) => {
  const { t } = useTranslation('auth');
  const router = useRouter();
  const searchParams = useSearchParams();
  const emailInputRef = useRef<InputRef>(null);
  const [qqLogin, setQqLogin] = useState<{
    code: string;
    expiresAt: string;
    id: string;
  } | null>(null);
  const [qqLoginLoading, setQqLoginLoading] = useState(false);
  const [qqLoginStatus, setQqLoginStatus] = useState<'expired' | 'pending' | 'preview' | 'success'>(
    'pending',
  );

  useEffect(() => {
    emailInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!qqLogin?.id || qqLoginStatus !== 'pending' || qqLogin.id === 'dev-preview') return;

    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/auth/im-login/qq/status?id=${encodeURIComponent(qqLogin.id)}`);
        const data = await response.json();

        if (!response.ok) throw new Error(data?.error || 'QQ login status failed');

        if (data.authenticated || data.status === 'authenticated') {
          setQqLoginStatus('success');
          const callbackUrl = searchParams.get('callbackUrl') || '/';
          router.push(callbackUrl);
          return;
        }

        if (data.status === 'expired') {
          setQqLoginStatus('expired');
        }
      } catch (error) {
        console.error('QQ login polling error:', error);
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [qqLogin?.id, qqLoginStatus, router, searchParams]);

  const handleStartQqLogin = async () => {
    setQqLoginLoading(true);
    setQqLoginStatus('pending');

    try {
      const response = await fetch('/api/auth/im-login/qq/start', { method: 'POST' });
      const data = response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : {};

      if (!response.ok) throw new Error(data?.error || 'QQ login failed');

      setQqLogin({
        code: data.code,
        expiresAt: data.expiresAt,
        id: data.id,
      });
    } catch (error) {
      console.error('QQ login start error:', error);
      if (process.env.NODE_ENV === 'development') {
        setQqLogin({
          code: '024681',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          id: 'dev-preview',
        });
        setQqLoginStatus('preview');
        return;
      }
      message.error(t('betterAuth.signin.qqLoginError'));
    } finally {
      setQqLoginLoading(false);
    }
  };

  const divider = (
    <Divider>
      <Text fontSize={12} type={'secondary'}>
        {t('betterAuth.signin.orContinueWith')}
      </Text>
    </Divider>
  );

  const getProviderLabel = (provider: string) => {
    const normalized = provider
      .toLowerCase()
      .replaceAll(/(^|[_-])([a-z])/g, (_, __, c) => c.toUpperCase());
    const normalizedKey = normalized.replaceAll(/[^\da-z]/gi, '');
    const key = `betterAuth.signin.continueWith${normalizedKey}`;
    return t(key, { defaultValue: `Continue with ${normalized}` });
  };

  const footer = (
    <Text fontSize={13} type={'secondary'}>
      <Trans
        i18nKey={'footer.agreement'}
        ns={'auth'}
        components={{
          privacy: (
            <a
              href={PRIVACY_URL}
              style={{ color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}
            >
              {t('footer.terms')}
            </a>
          ),
          terms: (
            <a
              href={TERMS_URL}
              style={{ color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}
            >
              {t('footer.privacy')}
            </a>
          ),
        }}
      />
    </Text>
  );

  const qqStatusIcon =
    qqLoginStatus === 'success' ? CheckCircle2 : qqLoginStatus === 'expired' ? RotateCcw : Clock3;

  return (
    <AuthCard
      footer={footer}
      subtitle={t('signin.subtitle', { appName: BRANDING_NAME })}
      title={t('signin.title')}
    >
      {!serverConfigInit && (
        <Flexbox gap={12}>
          <Skeleton.Button active block size="large" />
          <Skeleton.Button active block size="large" />
          {divider}
        </Flexbox>
      )}
      {serverConfigInit && oAuthSSOProviders.length > 0 && (
        <Flexbox gap={12}>
          {oAuthSSOProviders.map((provider) => {
            const button = (
              <Button
                block
                key={provider}
                loading={socialLoading === provider}
                size="large"
                icon={
                  <Icon
                    icon={AuthIcons(provider, 18)}
                    style={{
                      left: 12,
                      position: 'absolute',
                      top: 13,
                    }}
                  />
                }
                onClick={() => onSocialSignIn(provider)}
              >
                {getProviderLabel(provider)}
              </Button>
            );
            const showLastUsed =
              provider === lastAuthProvider &&
              (oAuthSSOProviders.length > 1 ||
                (oAuthSSOProviders.length === 1 && !disableEmailPassword));
            return showLastUsed ? (
              <Badge.Ribbon
                color="var(--ant-color-info-fill-tertiary)"
                key={provider}
                styles={{ content: { color: 'var(--ant-color-info)' } }}
                text={t('betterAuth.signin.lastUsed')}
              >
                {button}
              </Badge.Ribbon>
            ) : (
              button
            );
          })}
          {!disableEmailPassword && divider}
        </Flexbox>
      )}
      {serverConfigInit && disableEmailPassword && oAuthSSOProviders.length === 0 && (
        <Alert showIcon description={t('betterAuth.signin.ssoOnlyNoProviders')} type="warning" />
      )}
      {!disableEmailPassword && (
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => onCheckUser(values as { email: string })}
        >
          <Form.Item
            name="email"
            style={{ marginBottom: 0 }}
            rules={[
              { message: t('betterAuth.errors.emailRequired'), required: true },
              {
                validator: (_, value) => {
                  if (!value) return Promise.resolve();
                  const trimmedValue = (value as string).trim();
                  if (EMAIL_REGEX.test(trimmedValue) || USERNAME_REGEX.test(trimmedValue)) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error(t('betterAuth.errors.emailInvalid')));
                },
              },
            ]}
          >
            <Input
              placeholder={t('betterAuth.signin.emailPlaceholder')}
              ref={emailInputRef}
              size="large"
              prefix={
                <Icon
                  icon={Mail}
                  style={{
                    marginInline: 6,
                  }}
                />
              }
              style={{
                padding: 6,
              }}
              suffix={
                <Button
                  icon={ChevronRight}
                  loading={loading}
                  title={t('betterAuth.signin.nextStep')}
                  variant={'filled'}
                  onClick={() => form.submit()}
                />
              }
            />
          </Form.Item>
        </Form>
      )}
      {!disableEmailPassword && (
        <Button
          block
          icon={MessageCircle}
          loading={qqLoginLoading}
          size="large"
          variant="filled"
          onClick={handleStartQqLogin}
        >
          {t('betterAuth.signin.qqLoginButton')}
        </Button>
      )}
      {isSocialOnly && (
        <Alert
          showIcon
          style={{ marginTop: 12 }}
          type="info"
          description={
            <>
              {t('betterAuth.signin.socialOnlyHint')}{' '}
              <a className={styles.setPasswordLink} onClick={onSetPassword}>
                {t('betterAuth.signin.setPassword')}
              </a>
            </>
          }
        />
      )}
      <Modal
        centered
        className={styles.qqLoginModal}
        destroyOnHidden
        footer={null}
        open={Boolean(qqLogin)}
        title={null}
        width={420}
        onCancel={() => setQqLogin(null)}
      >
        <Flexbox className={styles.qqPanel} gap={20}>
          <Flexbox horizontal align={'flex-start'} gap={16} justify={'space-between'}>
            <Flexbox gap={6}>
              <Text fontSize={20} strong>
                {t('betterAuth.signin.qqLoginTitle')}
              </Text>
              <Text type="secondary">{t('betterAuth.signin.qqLoginDescription')}</Text>
            </Flexbox>
            <div className={styles.qqIcon}>
              <Icon icon={MessageCircle} />
            </div>
          </Flexbox>
          <Flexbox align={'center'} className={styles.qqCodeBlock} gap={10}>
            <Text className={styles.qqCodeLabel}>{t('betterAuth.signin.qqLoginCodeLabel')}</Text>
            <Text className={styles.qqCode}>{qqLogin?.code}</Text>
          </Flexbox>
          <Flexbox horizontal align={'center'} className={styles.qqStatus} gap={10}>
            <span
              className={[
                styles.qqStatusIcon,
                qqLoginStatus === 'success' && styles.qqStatusIconSuccess,
                (qqLoginStatus === 'expired' || qqLoginStatus === 'preview') &&
                  styles.qqStatusIconWarning,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <Icon icon={qqStatusIcon} size={14} />
            </span>
            <Text type={qqLoginStatus === 'expired' || qqLoginStatus === 'preview' ? 'warning' : 'secondary'}>
              {qqLoginStatus === 'expired'
                ? t('betterAuth.signin.qqLoginExpired')
                : qqLoginStatus === 'preview'
                  ? t('betterAuth.signin.qqLoginPreview')
                  : qqLoginStatus === 'success'
                    ? t('betterAuth.signin.qqLoginSuccess')
                    : t('betterAuth.signin.qqLoginPending')}
            </Text>
          </Flexbox>
          <Flexbox horizontal gap={8}>
            <Button
              block
              icon={RotateCcw}
              loading={qqLoginLoading}
              variant={'filled'}
              onClick={handleStartQqLogin}
            >
              {t('betterAuth.signin.qqLoginRefresh')}
            </Button>
            <Button block onClick={() => setQqLogin(null)}>
              {t('betterAuth.signin.qqLoginClose')}
            </Button>
          </Flexbox>
        </Flexbox>
      </Modal>
    </AuthCard>
  );
};
