'use client';

import { memo, useCallback, useRef } from 'react';
import { MemoryRouter, useInRouterContext } from 'react-router-dom';

import DragUploadZone, { useUploadFiles } from '@/components/DragUploadZone';
import {
  type ActionKeys,
  type ChatInputEditor,
  ChatInputProvider,
  DesktopChatInput,
} from '@/features/ChatInput';
import ConversationChatInput from '@/features/Conversation/ChatInput';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';
import { fileChatSelectors, useFileStore } from '@/store/file';
import { ServerConfigStoreProvider } from '@/store/serverConfig/Provider';

import { toPresentationReference, type PresentationReferenceInput } from './types';

const DIRECT_LEFT_ACTIONS: ActionKeys[] = ['fileUpload'];
const DIRECT_RIGHT_ACTIONS: ActionKeys[] = [];

// Match native Agent conversation composer: model, plus/attachments (R1-B);
// AgentMode, runtimeEnv, and approvalMode are provided natively by RuntimeConfig
const CONVERSATION_LEFT_ACTIONS: ActionKeys[] = ['model', 'plus'];
const CONVERSATION_RIGHT_ACTIONS: ActionKeys[] = ['contextWindow'];

export interface PresentationSendPayload {
  references: PresentationReferenceInput[];
  text: string;
}

export interface PresentationChatInputProps {
  agentId?: string;
  conversation?: boolean;
  creating?: boolean;
  disabled?: boolean;
  onEditorReady?: (editor: ChatInputEditor) => void;
  onSend: (payload: PresentationSendPayload) => void;
  placeholder?: string;
}

const PresentationChatInputInner = memo<PresentationChatInputProps>(
  ({
    agentId,
    conversation = false,
    creating = false,
    disabled = false,
    onEditorReady,
    onSend,
    placeholder,
  }) => {
    const editorRef = useRef<ChatInputEditor | null>(null);

    const resolvedAgentId = agentId ?? '';
    const model = useAgentStore((s) => agentByIdSelectors.getAgentModelById(resolvedAgentId)(s));
    const provider = useAgentStore((s) =>
      agentByIdSelectors.getAgentModelProviderById(resolvedAgentId)(s),
    );
    const { handleUploadFiles } = useUploadFiles({ model, provider });

    const isUploadingFiles = useFileStore(fileChatSelectors.isUploadingFiles);

    const handleSend = useCallback(
      (handlers: any) => {
        const text =
          typeof handlers === 'string'
            ? handlers
            : handlers?.getMarkdownContent?.() || handlers?.text || '';

        const rawFiles = fileChatSelectors.chatUploadFileList(useFileStore.getState());
        const references: PresentationReferenceInput[] = rawFiles.map(toPresentationReference);

        const trimmedText = text.trim();
        if (!trimmedText && references.length === 0) return;

        onSend({ references, text: trimmedText });
        handlers?.clearContent?.();
        useFileStore.getState().clearChatUploadFileList();
      },
      [onSend],
    );

    if (conversation) {
      return (
        <div
          data-testid="presentation-chat-input-adapter"
          style={{ position: 'relative', width: '100%' }}
        >
          <DragUploadZone
            style={{ position: 'relative', width: '100%', zIndex: 1 }}
            onUploadFiles={handleUploadFiles}
          >
            <ConversationChatInput
              allowExpand
              skipScrollMarginWithList
              leftActions={CONVERSATION_LEFT_ACTIONS}
              rightActions={CONVERSATION_RIGHT_ACTIONS}
              placeholder={placeholder}
              onEditorReady={onEditorReady}
              sendButtonProps={{
                disabled: disabled || creating || isUploadingFiles,
                generating: creating,
                onStop: () => undefined,
                shape: 'round',
              }}
            />
          </DragUploadZone>
        </div>
      );
    }

    return (
      <div
        data-testid="presentation-chat-input-adapter"
        style={{
          boxSizing: 'border-box',
          margin: '0 auto',
          maxWidth: 1080,
          paddingBottom: 16,
          paddingInline: 16,
          position: 'relative',
          width: '100%',
        }}
      >
        <DragUploadZone
          style={{ position: 'relative', width: '100%', zIndex: 1 }}
          onUploadFiles={handleUploadFiles}
        >
          <ChatInputProvider
            disableMention
            disableSlash
            agentId={agentId}
            allowExpand
            leftActions={DIRECT_LEFT_ACTIONS}
            rightActions={DIRECT_RIGHT_ACTIONS}
            chatInputEditorRef={(instance) => {
              editorRef.current = instance;
              if (instance) onEditorReady?.(instance);
            }}
            sendButtonProps={{
              disabled: disabled || creating || isUploadingFiles,
              generating: creating,
              onStop: () => undefined,
              shape: 'round',
            }}
            onSend={handleSend}
          >
            <DesktopChatInput
              borderRadius={16}
              isConfigLoading={false}
              showFootnote={false}
              showRuntimeConfig={false}
              placeholder={
                placeholder ??
                '拖入图片、PPT、PDF 或输入你的演示文稿主题（例如：2026年企业数字化转型与AI赋能战略汇报）...'
              }
            />
          </ChatInputProvider>
        </DragUploadZone>
      </div>
    );
  },
);

export const PresentationChatInput = memo<PresentationChatInputProps>((props) => {
  let inRouter = false;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    inRouter = useInRouterContext();
  } catch {}

  const content = (
    <ServerConfigStoreProvider>
      <PresentationChatInputInner {...props} />
    </ServerConfigStoreProvider>
  );

  if (!inRouter) {
    return <MemoryRouter>{content}</MemoryRouter>;
  }

  return content;
});

PresentationChatInput.displayName = 'PresentationChatInput';

export default PresentationChatInput;
