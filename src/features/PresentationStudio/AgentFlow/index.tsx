import { type SendMessageParams, type UIChatMessage } from '@lobechat/types';
import { Block, Button, Flexbox, Icon } from '@lobehub/ui';
import { FileText, Layers, Palette, Presentation, RotateCcw, Sparkles, Users } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type ChatInputEditor } from '@/features/ChatInput';
import { ChatList, ConversationProvider, MessageItem } from '@/features/Conversation';
import { ServerConfigStoreProvider } from '@/store/serverConfig/Provider';

import OutlineWorkspace, { type OutlineSlide } from './OutlineWorkspace';
import PresentationChatInput, { type PresentationSendPayload } from './PresentationChatInput';
import PresentationTypewriterTitle from './PresentationTypewriterTitle';
import type { PresentationAgentBrief, PresentationAgentClient } from './presentationAgentClient';
import { styles } from './style';
import { type PresentationReferenceInput, toPresentationReference } from './types';

export interface PresentationAgentFlowProps {
  agentClient: PresentationAgentClient;
  creating?: boolean;
  defaultLanguage?: string;
  defaultNotebookId?: string;
  defaultSourceVersionIds?: string[];
  initialTopic?: string;
  onCreate: (input: {
    aspectRatio: '16:9' | '4:3';
    language: string;
    notebookId: string;
    options: Record<string, unknown>;
    prompt: string;
    slideCount: number;
    sourceVersionIds: string[];
    title: string;
  }) => Promise<void> | void;
  /** Server-backed outline refinement through presentation.outline. */
  onOutlineAiRewrite: (input: {
    allSlides: OutlineSlide[];
    index?: number;
    mode: 'all' | 'slide';
    slide?: OutlineSlide;
    topic: string;
    audience: string;
    style: string;
  }) => Promise<Partial<OutlineSlide> | OutlineSlide[] | void>;
}

type FlowStep = 'topic' | 'intake' | 'outline' | 'summary';

interface ChatMessage {
  content: string;
  createdAt?: number;
  id: string;
  references?: PresentationReferenceInput[];
  sender: 'agent' | 'user';
  stepKey?: FlowStep;
}

interface PresentationImageSlotDraft {
  prompt: string;
  quality: string;
  size: string;
  slideId: string;
  slotId: string;
}

/**
 * Pick a small set of high-value visual moments instead of generating one
 * decorative image per page. The canonical `slide-N` ids are shared with the
 * planner contract, so generated assets can be attached to the intended page.
 */
export const buildPresentationImageSlots = (
  slides: readonly OutlineSlide[],
  topic: string,
  audience: string,
  visualStyle: string,
): PresentationImageSlotDraft[] => {
  if (slides.length === 0) return [];

  const candidateIndexes = [
    0,
    slides.findIndex((slide) => /数据|案例|架构|方案|成果/u.test(slide.title)),
    Math.floor((slides.length - 1) / 2),
    slides.length - 1,
  ].filter((index) => index >= 0 && index < slides.length);
  const selectedIndexes = [...new Set(candidateIndexes)].slice(0, Math.min(4, slides.length));

  return selectedIndexes.map((index) => {
    const slide = slides[index];
    return {
      prompt: [
        `为「${topic || '演示文稿'}」第 ${index + 1} 页生成可用于 PPT 排版的高保真视觉素材。`,
        `页面主题：${slide.title}。`,
        `页面目标：${slide.objective || '清晰传达本页核心观点'}。`,
        `关键内容：${slide.keyPoints.join('；')}。`,
        `受众：${audience}；整体风格：${visualStyle}；视觉建议：${slide.visualSuggestion || '现代简洁构图'}。`,
        '画面需保留充足的标题与正文排版留白，避免生成文字、Logo、水印和复杂边框，采用 16:9 演示文稿构图。',
      ].join(''),
      quality: 'high',
      size: '1536x1024',
      slideId: `slide-${index + 1}`,
      slotId: 'hero-visual',
    };
  });
};

interface InspirationTemplate {
  desc: string;
  label: string;
  prompt: string;
}

const INSPIRATION_TEMPLATES: InspirationTemplate[] = [
  {
    desc: '2026年企业数字化转型战略规划',
    label: '企业战略规划',
    prompt: `【主题背景】2026年集团全面推进数智化转型与全球化业务升级战略规划。
【目标受众】集团董事会成员、高管团队及各事业部核心业务负责人。
【核心内容结构】
1. 行业宏观趋势与数字化变革挑战；
2. 集团核心业务现状与痛点诊断；
3. 2026数智转型总体战略愿景与三阶段推进路线图；
4. 核心战略支柱（云原生技术底座、全链路数据治理、AI业务场景落地）；
5. 组织变革、跨部门协同机制与重大风险应对预案。
【数据/案例要求】引入权威行业对标数据，包含近3年营收成长指标、预期提效ROI预测及典型标杆落地案例。
【视觉风格】商务稳重科技风，深蓝与质感雅灰为主色调，辅以金色强调，采用多栏信息卡片与流程图解。
【交付要求】标准16:9宽屏，生成12页高质量幻灯片，逻辑严密，各页附带演讲要点说明。`,
  },
  {
    desc: '人工智能前沿学术研讨会报告',
    label: '课程讲义',
    prompt: `【主题背景】面向高校与科研机构的人工智能前沿学术研讨会报告与教学讲义。
【目标受众】计算机科学与人工智能相关专业的师生、青年学者及学术研究人员。
【核心内容结构】
1. 人工智能技术演变脉络与生成式大模型前沿发展概况；
2. 核心架构原理解析（Transformer机制、多模态对齐与推理强化）；
3. 前沿学术突破与代表性顶级会议论文关键成果；
4. 行业应用实践探索与跨学科研究方向展望；
5. 开放性挑战、伦理安全治理与未来学术思考。
【数据/案例要求】展示主流学术榜单评测基准数据、经典实验对比图表与前沿实验室最新代表性案例。
【视觉风格】学术严谨风格，高对比度现代扁平排版，清爽蓝灰配色，公式与框架结构清晰易读。
【交付要求】标准16:9宽屏，生成12页教学演示讲义，重难点突出，适合45分钟深度讲解。`,
  },
  {
    desc: '智能新零售产品发布商业提案',
    label: '产品提案',
    prompt: `【主题背景】智能新零售产品发布商业提案与全渠道数智化解决方案。
【目标受众】大型零售品牌高管决策层、渠道战略合作伙伴及商业投资机构。
【核心内容结构】
1. 消费市场变革洞察与传统零售痛点（坪效瓶颈、全渠道割裂）；
2. 智能新零售产品核心价值主张与全局技术架构方案；
3. 核心功能矩阵（AI智能选品、全渠道客流分析、无人智能收银结账）；
4. 商业盈利模式、部署投资预算与实施周期规划；
5. 落地成功保障与全周期客户服务体系。
【数据/案例要求】结合知名连锁品牌试点经营指标，呈现客单价提升与运营成本降低的量化对比数据与ROI测算。
【视觉风格】活力现代商业风，明亮科技渐变色彩，搭配高清场景化插画与大尺寸关键指标展示。
【交付要求】标准16:9宽屏，生成12页商业提案，结构精练、销售说服力强，适合商务路演。`,
  },
  {
    desc: 'Q3 团队技术演进与业务增长复盘',
    label: '研究汇报',
    prompt: `【主题背景】Q3 团队技术演进与业务增长复盘深度研究汇报。
【目标受众】技术总监、研发团队骨干成员及业务线产品运营主管。
【核心内容结构】
1. Q3业务核心目标回顾与关键KPI达成成果综述；
2. 技术架构演进升级（微服务重构、稳定性保障与研发提效）；
3. 关键业务线增长归因分析与技术指标支撑关联；
4. 遇到的核心挑战、故障复盘反思与根因总结；
5. Q4重点技术攻坚方向、资源保障规划与长远演进建议。
【数据/案例要求】提供服务SLA稳定性指标、研发效能指标、线上异常监控趋势图及代表性技术攻坚案例。
【视觉风格】科技极简风，深邃深色模式或干净冷色调，强化数据可视化折线图、柱状图与时间线卡片。
【交付要求】标准16:9宽屏，生成12页技术复盘报告，逻辑客观严谨，图表详实直观。`,
  },
];

export const PresentationAgentFlow = memo<PresentationAgentFlowProps>(
  ({
    agentClient,
    creating = false,
    defaultLanguage = 'zh-CN',
    defaultNotebookId = '',
    defaultSourceVersionIds = [],
    initialTopic = '',
    onOutlineAiRewrite,
    onCreate,
  }) => {
    const editorRef = useRef<ChatInputEditor | null>(null);
    const [step, setStep] = useState<FlowStep>('topic');
    const [selectedTopic, setSelectedTopic] = useState('');
    const [selectedReferences, setSelectedReferences] = useState<PresentationReferenceInput[]>([]);
    const [selectedAudience, setSelectedAudience] = useState('');
    const [selectedSlideCount, setSelectedSlideCount] = useState<number>(0);
    const [selectedStyle, setSelectedStyle] = useState('');
    const [selectedAspectRatio, setSelectedAspectRatio] = useState<'16:9' | '4:3'>('16:9');
    const [selectedLanguage, setSelectedLanguage] = useState<string>(defaultLanguage);
    const [confirmedSlides, setConfirmedSlides] = useState<OutlineSlide[]>([]);
    const [outlineVersionId, setOutlineVersionId] = useState('v1');
    const [agentBrief, setAgentBrief] = useState<PresentationAgentBrief>({});
    const [agentBusy, setAgentBusy] = useState<'conversation' | 'outline' | null>(null);
    const [agentError, setAgentError] = useState<string | null>(null);
    const [agentOutline, setAgentOutline] = useState<OutlineSlide[] | undefined>();
    const threadIdRef = useRef(`presentation-thread-${Date.now()}`);
    const initialSubmittedRef = useRef(false);

    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const messageSequenceRef = useRef(0);
    const nextMessageId = useCallback((prefix: string) => {
      messageSequenceRef.current += 1;
      return `${prefix}-${messageSequenceRef.current}`;
    }, []);

    const applyAgentBrief = useCallback((brief: PresentationAgentBrief) => {
      setAgentBrief(brief);
      if (brief.topic) setSelectedTopic(brief.topic);
      if (brief.audience) setSelectedAudience(brief.audience);
      if (brief.slideCount) setSelectedSlideCount(brief.slideCount);
      if (brief.style) setSelectedStyle(brief.style);
      if (brief.aspectRatio) setSelectedAspectRatio(brief.aspectRatio);
      if (brief.language) setSelectedLanguage(brief.language);
    }, []);

    const handleAgentTurn = useCallback(
      async (payload: PresentationSendPayload) => {
        if (agentBusy) return;
        const text = payload.text.trim();
        if (!text && payload.references.length === 0) return;

        const content = text || '请根据我提供的参考材料规划演示文稿。';
        const userMessage: ChatMessage = {
          content,
          createdAt: Date.now(),
          id: nextMessageId('user'),
          references: payload.references,
          sender: 'user',
        };
        const conversation = [...messages, userMessage];
        setMessages(conversation);
        setSelectedReferences(payload.references);
        setStep('intake');
        setAgentError(null);
        setAgentBusy('conversation');

        try {
          const result = await agentClient.turn({
            brief: agentBrief,
            messages: conversation.map((message) => ({
              content: message.content,
              role: message.sender === 'agent' ? 'assistant' : 'user',
            })),
            references: payload.references,
            threadId: threadIdRef.current,
          });
          applyAgentBrief(result.brief);
          setMessages((current) => [
            ...current,
            {
              content: result.message,
              createdAt: Date.now(),
              id: nextMessageId(result.questionId ? `agent-${result.questionId}` : 'agent'),
              sender: 'agent',
            },
          ]);

          if (result.phase !== 'outline') return;
          setAgentBusy('outline');
          const outline = await agentClient.outline({ brief: result.brief });
          setAgentOutline(outline.slides);
          setConfirmedSlides([]);
          setOutlineVersionId('v1');
          setStep('outline');
        } catch (error) {
          setAgentError(error instanceof Error ? error.message : 'PPT Agent 暂时不可用');
        } finally {
          setAgentBusy(null);
        }
      },
      [agentBrief, agentBusy, agentClient, applyAgentBrief, messages, nextMessageId],
    );

    const handleTemplateSelect = useCallback((prompt: string) => {
      const editor = editorRef.current;
      if (editor) {
        try {
          editor.setDocument('markdown', prompt, { keepHistory: true });
        } catch {
          // Fallback
        }
        editor.focus?.();
      }
    }, []);

    useEffect(() => {
      if (initialTopic && !initialSubmittedRef.current && step === 'topic') {
        initialSubmittedRef.current = true;
        void handleAgentTurn({ references: [], text: initialTopic });
      }
    }, [handleAgentTurn, initialTopic, step]);

    const handleOutlineConfirm = useCallback(
      (data: { slides: OutlineSlide[]; versionId: string }) => {
        const slides = data.slides;
        const version = data.versionId;
        setConfirmedSlides(slides);
        setOutlineVersionId(version);

        setMessages((prev) => [
          ...prev,
          {
            content: `逐页大纲已确认（共 ${slides.length} 页，版本 ${version}），可以开始生成。`,
            createdAt: Date.now(),
            id: nextMessageId('user-outline'),
            sender: 'user',
          },
          {
            content: '需求已全部就绪。这是最终创作方案，确认后即可开始智能生成：',
            createdAt: Date.now(),
            id: nextMessageId('agent-summary'),
            sender: 'agent',
            stepKey: 'summary',
          },
        ]);
        setStep('summary');
      },
      [nextMessageId],
    );

    const handleChatSend = useCallback(
      (payload: PresentationSendPayload) => {
        const text = payload.text.trim();
        if (!text && payload.references.length === 0) return;

        void handleAgentTurn(payload);
      },
      [handleAgentTurn],
    );

    // Reuse LobeHub's native Conversation ChatInput/ChatList shell. The
    // lifecycle hook short-circuits the normal agent send and feeds the
    // presentation state machine instead.
    const handleConversationSend = useCallback(
      async (params: SendMessageParams) => {
        const references = (params.files ?? []).map(toPresentationReference);
        handleChatSend({ references, text: params.message });
        return false;
      },
      [handleChatSend],
    );

    const handleStartCreate = useCallback(async () => {
      const refSummary =
        selectedReferences.length > 0
          ? `\n参考材料：\n` +
            selectedReferences.map((r) => `- [${r.kind}] ${r.name} (${r.status})`).join('\n')
          : '';

      if (confirmedSlides.length === 0) {
        setAgentError('请先确认 Agent 返回的逐页大纲。');
        return;
      }
      const slidesToUse = confirmedSlides;

      const outlineFormatted = slidesToUse
        .map(
          (s, idx) =>
            `第 ${idx + 1} 页：${s.title}\n- 页面目标：${s.objective || '无'}\n- 关键要点：${s.keyPoints.join('；')}\n- 视觉建议：${s.visualSuggestion || '标准图文版式'}\n- 演讲备注：${s.speakerNotes || '无'}`,
        )
        .join('\n\n');

      const finalPrompt =
        [
          `演示文稿主题：${selectedTopic}`,
          `目标受众与场景：${selectedAudience}`,
          `视觉风格倾向：${selectedStyle}`,
          `目标页数：${slidesToUse.length} 页`,
          `大纲版本：${outlineVersionId}`,
          `\n逐页规划大纲：\n${outlineFormatted}`,
        ].join('\n') + refSummary;

      const imageSlots = buildPresentationImageSlots(
        slidesToUse,
        selectedTopic,
        selectedAudience,
        selectedStyle,
      );

      await onCreate({
        aspectRatio: selectedAspectRatio,
        language: selectedLanguage,
        notebookId: defaultNotebookId.trim() || 'studio',
        options: {
          audience: selectedAudience,
          imageSlots,
          references: selectedReferences
            .filter((reference) => reference.status === 'ready' && reference.assetRef)
            .map((reference) => ({
              kind: reference.kind,
              name: reference.name,
              url: reference.assetRef,
            })),
          style: selectedStyle,
        },
        prompt: finalPrompt,
        slideCount: slidesToUse.length,
        sourceVersionIds: [...defaultSourceVersionIds],
        title: selectedTopic || '智能演示文稿',
      });
    }, [
      confirmedSlides,
      selectedTopic,
      selectedAudience,
      selectedSlideCount,
      selectedStyle,
      selectedReferences,
      outlineVersionId,
      onCreate,
      selectedAspectRatio,
      selectedLanguage,
      defaultNotebookId,
      defaultSourceVersionIds,
    ]);

    const handleReset = useCallback(() => {
      setStep('topic');
      setSelectedTopic('');
      setSelectedReferences([]);
      setSelectedAudience('');
      setSelectedSlideCount(0);
      setSelectedStyle('');
      setSelectedAspectRatio('16:9');
      setSelectedLanguage(defaultLanguage);
      setConfirmedSlides([]);
      setOutlineVersionId('v1');
      setAgentBrief({});
      setAgentBusy(null);
      setAgentError(null);
      setAgentOutline(undefined);
      threadIdRef.current = `presentation-thread-${Date.now()}`;
      setMessages([]);
    }, [defaultLanguage]);

    const conversationContext = useMemo(
      () => ({ agentId: 'ppt-agent', threadId: null, topicId: null }),
      [],
    );

    const conversationMessages = useMemo<UIChatMessage[]>(
      () =>
        messages.map((m, index) => ({
          agentId: 'ppt-agent',
          content: m.content,
          createdAt: m.createdAt || Date.now(),
          id: m.id,
          ...(index > 0 ? { parentId: messages[index - 1].id } : {}),
          role: m.sender === 'agent' ? 'assistant' : 'user',
          updatedAt: m.createdAt || Date.now(),
        })),
      [messages],
    );

    const renderStepFooter = useCallback(
      (stepKey: FlowStep) => {
        switch (stepKey) {
          case 'outline': {
            if (step !== 'outline') return null;
            return (
              <OutlineWorkspace
                initialSlides={agentOutline ?? []}
                onBack={() => setStep('intake')}
                onConfirm={(data) => handleOutlineConfirm(data)}
                onAiRewrite={(input) =>
                  onOutlineAiRewrite({
                    ...input,
                    audience: selectedAudience,
                    style: selectedStyle,
                    topic: selectedTopic,
                  })
                }
              />
            );
          }
          case 'summary': {
            if (step !== 'summary') return null;
            const finalSlideCount =
              confirmedSlides.length > 0 ? confirmedSlides.length : selectedSlideCount;
            return (
              <Flexbox gap={14} style={{ marginTop: 8, width: '100%' }}>
                <div className={styles.summaryCard} data-testid="presentation-agent-summary">
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>
                      <Icon icon={Presentation} size={14} /> 主题：
                    </span>
                    <span className={styles.summaryValue}>{selectedTopic}</span>
                  </div>
                  {selectedReferences.length > 0 && (
                    <div className={styles.summaryItem}>
                      <span className={styles.summaryLabel}>
                        <Icon icon={FileText} size={14} /> 参考材料：
                      </span>
                      <span className={styles.summaryValue}>
                        {selectedReferences.map((r) => r.name).join(', ')}
                      </span>
                    </div>
                  )}
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>
                      <Icon icon={Users} size={14} /> 受众场景：
                    </span>
                    <span className={styles.summaryValue}>{selectedAudience}</span>
                  </div>
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>
                      <Icon icon={Layers} size={14} /> 幻灯片页数：
                    </span>
                    <span className={styles.summaryValue}>{finalSlideCount} 页</span>
                  </div>
                  <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>
                      <Icon icon={Palette} size={14} /> 视觉与画幅：
                    </span>
                    <span className={styles.summaryValue}>
                      {selectedStyle} · {selectedAspectRatio} ·{' '}
                      {selectedLanguage === 'zh-CN' ? '中文' : 'English'}
                    </span>
                  </div>
                </div>

                <Flexbox horizontal gap={10} justify="flex-end">
                  <Button
                    icon={<Icon icon={RotateCcw} size={12} />}
                    size="middle"
                    onClick={handleReset}
                  >
                    重新设定
                  </Button>
                  <Button
                    aria-label="Start presentation generation"
                    data-testid="agent-flow-submit-btn"
                    icon={<Icon icon={Sparkles} size={14} />}
                    loading={creating}
                    size="middle"
                    type="primary"
                    onClick={() => void handleStartCreate()}
                  >
                    开始生成 PPT
                  </Button>
                </Flexbox>
              </Flexbox>
            );
          }
          default: {
            return null;
          }
        }
      },
      [
        step,
        selectedAudience,
        selectedSlideCount,
        selectedStyle,
        selectedAspectRatio,
        selectedLanguage,
        selectedTopic,
        agentOutline,
        onOutlineAiRewrite,
        handleOutlineConfirm,
        confirmedSlides.length,
        selectedReferences,
        handleReset,
        creating,
        handleStartCreate,
      ],
    );

    const chatInputPlaceholder = useMemo(() => {
      if (step === 'topic') {
        return '拖入图片、PPT、PDF 或输入你的演示文稿主题与要求...';
      }
      return '继续补充要求，PPT Agent 会结合完整上下文决定下一步...';
    }, [step]);

    return (
      <Flexbox
        data-testid="presentation-agent-flow"
        flex={1}
        height={'100%'}
        justify={'space-between'}
        width={'100%'}
      >
        <ConversationProvider
          skipFetch
          context={conversationContext}
          hasInitMessages={conversationMessages.length > 0}
          hooks={{ onBeforeSendMessage: handleConversationSend }}
          messages={conversationMessages}
          key={
            conversationMessages.length > 0
              ? 'presentation-conversation-active'
              : 'presentation-conversation-empty'
          }
        >
          <Flexbox
            flex={1}
            style={{ minHeight: 0, overflowX: 'hidden', overflowY: 'auto' }}
            width="100%"
          >
            <ServerConfigStoreProvider>
              <ChatList
                itemContent={(index, id) => {
                  return (
                    <MessageItem
                      disableEditing
                      id={id}
                      index={index}
                      isLatestItem={index === messages.length - 1}
                    />
                  );
                }}
                welcome={
                  <>
                    <Flexbox flex={1} />
                    <Flexbox gap={32} style={{ paddingBottom: 'max(4vh, 16px)' }} width="100%">
                      <PresentationTypewriterTitle />
                      <Flexbox width="min(100%, 760px)">
                        <p
                          style={{
                            color: 'var(--ant-color-text-description)',
                            fontSize: 14,
                            lineHeight: 1.6,
                            margin: 0,
                          }}
                        >
                          告诉我主题、参考材料和要求，为你自动规划幻灯片大纲、设计视觉版式并生成高保真
                          PPT。
                        </p>
                      </Flexbox>
                      <div
                        data-testid="agent-inspiration-chips"
                        style={{ width: 'min(100%, 920px)' }}
                      >
                        <p
                          style={{
                            color: 'var(--ant-color-text-description)',
                            fontSize: 13,
                            marginBottom: 8,
                          }}
                        >
                          推荐主题模板
                        </p>
                        <Flexbox horizontal gap={8} wrap="wrap">
                          {INSPIRATION_TEMPLATES.map((item) => (
                            <Block
                              clickable
                              key={item.label}
                              paddingBlock={8}
                              paddingInline={14}
                              style={{ borderRadius: 48, fontSize: 13 }}
                              variant="filled"
                              onClick={() => {
                                handleTemplateSelect(item.prompt);
                              }}
                            >
                              {item.label} · {item.desc}
                            </Block>
                          ))}
                        </Flexbox>
                      </div>
                    </Flexbox>
                  </>
                }
              />
            </ServerConfigStoreProvider>
            <div
              aria-live="polite"
              data-testid="presentation-agent-transcript"
              style={{
                height: 0,
                overflow: 'hidden',
                position: 'absolute',
                width: 0,
              }}
            >
              {messages.map((message) => (
                <span key={message.id}>{message.content}</span>
              ))}
            </div>
            {agentBusy && (
              <div className={styles.realtimeTranscript} data-testid="presentation-agent-thinking">
                <div className={styles.thinkingBubble} role="status">
                  <span>
                    {agentBusy === 'outline' ? '正在组织逐页大纲' : '正在理解并规划下一问'}
                  </span>
                  <span className={styles.thinkingDot} />
                  <span className={styles.thinkingDot} />
                  <span className={styles.thinkingDot} />
                </div>
              </div>
            )}
            {agentError && (
              <div
                aria-live="assertive"
                className={styles.realtimeTranscript}
                data-testid="presentation-agent-error"
              >
                <div className={`${styles.realtimeMessage} ${styles.realtimeMessageAgent}`}>
                  {agentError}
                </div>
              </div>
            )}
            <div data-testid="presentation-agent-step-footer">{renderStepFooter(step)}</div>
          </Flexbox>

          {/* LobeHub Native ChatInput anchored directly at bottom for conversation steps */}
          {(step === 'topic' || step === 'intake') && (
            <PresentationChatInput
              conversation
              creating={creating || Boolean(agentBusy)}
              disabled={Boolean(agentBusy)}
              placeholder={chatInputPlaceholder}
              onSend={handleChatSend}
              onEditorReady={(inst) => {
                editorRef.current = inst;
              }}
            />
          )}
        </ConversationProvider>
      </Flexbox>
    );
  },
);

PresentationAgentFlow.displayName = 'PresentationAgentFlow';

export default PresentationAgentFlow;
