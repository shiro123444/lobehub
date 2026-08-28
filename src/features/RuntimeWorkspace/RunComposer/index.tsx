import { Button, Icon } from '@lobehub/ui';
import { Alert, Input } from 'antd';
import { Play, RotateCcw, Send } from 'lucide-react';
import { memo, useCallback, useState } from 'react';

import { useRuntimeStore } from '@/store/runtime';

import type { StartRunInput } from '../../../../packages/runtime-contracts/src/index';
import { styles } from './style';

export interface RunComposerProps {
  className?: string;
  defaultProfileId?: string;
  defaultSessionId?: string;
  onRunStarted?: (runId: string) => void;
}

export const RunComposer = memo<RunComposerProps>(
  ({ className, defaultProfileId = '', defaultSessionId = '', onRunStarted }) => {
    const startRun = useRuntimeStore((s) => s.startRun);

    const [sessionId, setSessionId] = useState(defaultSessionId);
    const [profileId, setProfileId] = useState(defaultProfileId);
    const [userMessage, setUserMessage] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = useCallback(async () => {
      if (loading) return;

      const trimmedMessage = userMessage.trim();
      const input: StartRunInput = {
        profileId: profileId.trim() || undefined,
        sessionId: sessionId.trim() || undefined,
        userMessage: trimmedMessage || undefined,
      };

      setLoading(true);
      setError(null);

      try {
        const snapshot = await startRun(input);
        setUserMessage('');
        onRunStarted?.(snapshot.runId);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to start run';
        setError(message);
      } finally {
        setLoading(false);
      }
    }, [loading, onRunStarted, profileId, sessionId, startRun, userMessage]);

    const handleReset = useCallback(() => {
      setSessionId(defaultSessionId);
      setProfileId(defaultProfileId);
      setUserMessage('');
      setError(null);
    }, [defaultProfileId, defaultSessionId]);

    return (
      <div
        aria-label="Run Composer"
        className={className ? `${styles.container} ${className}` : styles.container}
        data-testid="run-composer"
        role="form"
      >
        {error && (
          <div className={styles.errorBox} data-testid="composer-error-alert">
            <Alert
              closable
              showIcon
              description={error}
              message="Start Run Error"
              type="error"
              onClose={() => setError(null)}
            />
          </div>
        )}

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="composer-session-id">
              Session ID
            </label>
            <Input
              aria-disabled={loading}
              aria-label="Session ID"
              disabled={loading}
              id="composer-session-id"
              placeholder="e.g. session-dev (optional)"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="composer-profile-id">
              Profile / Strategy ID
            </label>
            <Input
              aria-disabled={loading}
              aria-label="Profile / Strategy ID"
              disabled={loading}
              id="composer-profile-id"
              placeholder="e.g. agent-chat (optional)"
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            />
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="composer-user-message">
            User Message / Prompt
          </label>
          <Input.TextArea
            aria-disabled={loading}
            aria-label="User Message / Prompt"
            aria-required="true"
            autoSize={{ maxRows: 6, minRows: 2 }}
            disabled={loading}
            id="composer-user-message"
            placeholder="Type a message or instruction for the runtime agent (Cmd+Enter to start)..."
            value={userMessage}
            onChange={(e) => setUserMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
        </div>

        <div className={styles.actions}>
          <Button
            aria-label="Reset form"
            disabled={loading}
            icon={<Icon icon={RotateCcw} size={{ fontSize: 13 }} />}
            size="small"
            onClick={handleReset}
          >
            Reset
          </Button>
          <Button
            aria-busy={loading}
            aria-label="Start Run"
            icon={<Icon icon={loading ? Send : Play} size={{ fontSize: 13 }} />}
            loading={loading}
            type="primary"
            onClick={handleSubmit}
          >
            Start Run
          </Button>
        </div>
      </div>
    );
  },
);

RunComposer.displayName = 'RunComposer';

export default RunComposer;
