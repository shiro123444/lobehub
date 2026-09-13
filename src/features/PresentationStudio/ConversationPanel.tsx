import { Button } from '@lobehub/ui';
import { Input, Select } from 'antd';
import { createStaticStyles } from 'antd-style';
import { ArrowUp, MessageCircle, Minus } from 'lucide-react';
import { type ComponentRef, memo, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  PresentationJob,
  PresentationMessageInput,
} from '../../../packages/runtime-contracts/src';

const styles = createStaticStyles(({ css, cssVar }) => ({
  dock: css`
    position: absolute;
    z-index: 20;
    inset-block-end: 16px;
    inset-inline-start: 50%;
    transform: translateX(-50%);

    max-width: calc(100% - 32px);
  `,
  capsule: css`
    cursor: pointer;

    display: flex;
    gap: 14px;
    align-items: center;
    justify-content: center;

    min-width: 240px;
    min-height: 48px;
    padding-block: 10px;
    padding-inline: 20px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 999px;

    font: inherit;
    font-size: 13px;
    color: ${cssVar.colorText};

    background: ${cssVar.colorBgElevated};
    box-shadow: 0 4px 20px ${cssVar.colorFillSecondary};

    &:hover {
      background: ${cssVar.colorFillQuaternary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 3px;
    }
  `,
  header: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  `,
  panel: css`
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;

    width: 560px;
    max-width: 100%;
    max-height: min(640px, 75dvh);
    padding: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 18px;

    background: ${cssVar.colorBgElevated};
    box-shadow: 0 8px 32px ${cssVar.colorFillSecondary};
  `,
  hint: css`
    margin: 0;
    font-size: 12px;
    line-height: 1.7;
    color: ${cssVar.colorTextSecondary};
  `,
  history: css`
    overflow-y: auto;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 16px;

    min-height: 0;
    max-height: 36dvh;
  `,
  message: css`
    padding: 12px;
    border-radius: 12px;

    overflow-wrap: anywhere;
    white-space: pre-wrap;

    background: ${cssVar.colorFillQuaternary};
  `,
  footer: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: space-between;
  `,
}));

interface Props {
  job: PresentationJob;
  onCancel: (jobId: string) => Promise<void>;
  onRetry: (jobId: string) => Promise<void>;
  onSend: (jobId: string, input: PresentationMessageInput) => Promise<boolean>;
  selectedPage?: number;
}

export const ConversationPanel = memo<Props>(({ job, selectedPage, onSend, onCancel, onRetry }) => {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const input = useRef<ComponentRef<typeof Input.TextArea>>(null);
  const capsule = useRef<HTMLButtonElement>(null);
  const [content, setContent] = useState('');
  const [target, setTarget] = useState<number>(0);
  const [sending, setSending] = useState(false);
  const requestId = useRef<string | null>(null);
  const history = useRef<HTMLDivElement>(null);
  const messages = job.messages ?? [];
  const active = job.state === 'running' || job.state === 'queued';
  useEffect(() => {
    history.current?.scrollTo?.({ top: history.current.scrollHeight, behavior: 'smooth' });
  }, [open, messages.length, messages.at(-1)?.status]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  const collapse = () => {
    setOpen(false);
    requestAnimationFrame(() => capsule.current?.focus());
  };
  const send = async () => {
    if (!content.trim() || sending) return;
    setSending(true);
    requestId.current ??= crypto.randomUUID();
    try {
      if (
        await onSend(job.jobId, {
          content: content.trim(),
          requestId: requestId.current,
          target: target ? { type: 'slide', slideNumber: target } : { type: 'deck' },
        })
      ) {
        setContent('');
        requestId.current = null;
      }
    } finally {
      setSending(false);
    }
  };
  return (
    <aside
      aria-label={t('presentationConversation.title')}
      className={styles.dock}
      data-testid="presentation-conversation"
    >
      {!open ? (
        <button
          aria-controls={panelId}
          aria-expanded={false}
          className={styles.capsule}
          ref={capsule}
          type="button"
          onClick={() => setOpen(true)}
        >
          <MessageCircle aria-hidden size={21} strokeWidth={1.6} />
          {t('presentationConversation.open')}
        </button>
      ) : (
        <div
          className={styles.panel}
          id={panelId}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.defaultPrevented) {
              event.stopPropagation();
              collapse();
            }
          }}
        >
          <div className={styles.header}>
            <Select
              aria-label={t('presentationConversation.target')}
              value={target}
              options={[
                { value: 0, label: t('presentationConversation.deck') },
                ...Array.from(
                  {
                    length: Math.max(
                      job.slideCount ?? 0,
                      selectedPage ?? 0,
                      job.artifactIds?.filter((id) => id.includes(':slide:')).length ?? 0,
                      1,
                    ),
                  },
                  (_, i) => ({
                    value: i + 1,
                    label: t('presentationConversation.page', { number: i + 1 }),
                  }),
                ),
              ]}
              onChange={(value) => {
                setTarget(value);
                requestId.current = null;
              }}
            />
            <Button
              aria-label={t('presentationConversation.collapse')}
              size="small"
              type="text"
              onClick={collapse}
            >
              <Minus aria-hidden size={16} />
            </Button>
          </div>
          {!!messages.length && (
            <div aria-live="polite" className={styles.history} ref={history} role="log">
              {messages.map((message) => (
                <div key={message.requestId}>
                  <div className={styles.message}>
                    <p className={styles.hint}>
                      {message.target.type === 'slide'
                        ? t('presentationConversation.page', { number: message.target.slideNumber })
                        : t('presentationConversation.deck')}
                    </p>
                    {message.content}
                  </div>
                  <p className={styles.hint}>
                    {t(`presentationConversation.${message.status}`)}
                    {message.error ? ` · ${message.error}` : ''}
                  </p>
                </div>
              ))}
            </div>
          )}
          <Input.TextArea
            aria-label={t('presentationConversation.placeholder')}
            autoSize={{ minRows: 2, maxRows: 5 }}
            maxLength={4000}
            placeholder={t('presentationConversation.placeholder')}
            ref={input}
            value={content}
            variant="borderless"
            onChange={(event) => {
              setContent(event.target.value);
              requestId.current = null;
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.ctrlKey || event.metaKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className={styles.footer}>
            {active ? (
              <Button size="small" onClick={() => void onCancel(job.jobId)}>
                {t('presentationConversation.cancel')}
              </Button>
            ) : job.state === 'failed' || job.state === 'cancelled' ? (
              <Button size="small" onClick={() => void onRetry(job.jobId)}>
                {t('presentationConversation.retry')}
              </Button>
            ) : (
              <span />
            )}
            <Button
              aria-label={t('presentationConversation.send')}
              disabled={!content.trim()}
              loading={sending}
              size="small"
              type="primary"
              onClick={() => void send()}
            >
              <ArrowUp aria-hidden size={16} />
            </Button>
          </div>
        </div>
      )}
    </aside>
  );
});
