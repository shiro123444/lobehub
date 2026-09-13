# Presentation Agent 重构计划（agy / Herdr 执行稿）

> 文档用途：给外部 Herdr 终端中的 `agy` 作为前端实施计划。
> 本文先冻结交互和接口边界，再开始代码修改。每个原子任务完成后，agy 必须向 root 正式回报，首行使用：`我是 agy（Herdr）`。

## 0. 当前目标

将 `/presentation` 从 “固定表单 + 一次性生成” 改成 LobeHub 风格的全宽 PPT Agent：

```text
主题/材料输入 → Agent 动态追问 → 结构化简报 → 全屏逐页大纲编辑
             → 用户确认 → 多轮素材生成/拼接 → ppt-master → 可编辑 PPT 工作台
```

保持以下产品边界：

- 继续使用 LobeHub 自己的对话、输入框、按钮、消息和动效。
- 推荐主题只是可编辑的提示词模板，点击模板不直接提交。
- 用户可以输入文字、拖拽图片、上传 PPT/PDF/Word/ 表格等参考材料。
- 参考材料只作为本次会话的 source references，不能把本地路径或二进制直接放进运行时事件。
- 生成中保持简洁光感界面；完成后才进入编辑工作台。
- 不引入清舟自定义 UI 组件，不修改 `/qingzhou`，不把 provider key 写入源码。

## 1. 必须复用的现有模块

### 首页输入逻辑

不要重新实现上传或聊天输入，优先复用首页 `InputArea` 使用的模块：

- `src/components/DragUploadZone`
- `useUploadFiles`
- `src/features/ChatInput/ChatInputProvider`
- `src/features/ChatInput/DesktopChatInput`
- `src/features/Conversation/ChatInput`

参考实现：`src/routes/(main)/home/features/InputArea/index.tsx`。

复用要求：

- 沿用首页的拖拽、粘贴、上传进度和取消行为。
- 通过当前 agent 的 `model/provider` 判断图片理解能力，不能硬编码 provider。
- Presentation 页面只接管 `onSend` 和参考材料投影，不复制首页上传实现。
- 输入框支持 “模板填充后继续编辑”，模板选择器不能绕过输入框直接提交。

### 首页打字机与清舟动画

- 标题优先复用首页 `WelcomeText` 的打字机行为，或将同一逻辑抽成共享模块。
- 路由缓冲复用 `BrandTextLoading` / `QingzhouBrandLoading`。
- 不新增第二套标题动画和路由 loading 动画。

## 2. 目标页面状态机

前端只渲染状态，状态由运行时事件或本地草稿投影产生：

```text
welcome
  ↓ 用户发送第一条消息
intake
  ↓ Agent 判断信息足够
outline
  ↓ 用户确认大纲
generating
  ↓ 任务完成
editor
```

异常状态保持独立：`reconnecting`、`provider-unavailable`、`invalid-input`、`cancelled`、`failed`。

前端不得用 “点击了第几个固定卡片” 推断状态；必须使用 `phase`、`questionId`、`outlineVersionId`、`jobId` 等稳定字段。

## 3. 页面设计

### 3.1 Welcome / Intake

```text
┌──────────────────────────────────────────────────────────────┐
│                         PPT 生成                              │
│                    （首页同款打字机轮询）                      │
│                                                              │
│   推荐模板：                                                  │
│   [企业战略规划] [课程讲义] [产品提案] [研究汇报]              │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 拖入图片、PPT、PDF 或输入你的主题……           [发送]   │  │
│  │ [参考材料缩略图] [文件名]                                │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

验收条件：

- 顶部没有 PPT 图标，也没有 “PPT 创作专家”。
- 标题文案在 “PPT 生成 / PPT 设计 / PPT 打磨 / PPT 编辑” 之间轮询。
- 点击模板只把 prompt 写入输入框并聚焦，用户可继续修改。
- 输入框可以添加和删除参考材料。
- 桌面端使用可用宽度，内容最大宽度建议 1280–1440px；移动端使用 `100dvh`。

### 3.2 Conversation

继续使用 LobeHub 的 `ConversationProvider` 和 `MessageItem`，但把对话容器改成全宽布局：

- 消息列占据主区域，滚动条贴近最右侧。
- 输入框固定在底部，不能被挤进中间窄栏。
- 快捷建议以可编辑草稿形式进入输入框，不直接提交。
- Agent 每次只问一个最有价值的问题。
- 建议按钮只是建议，用户点击后仍可以修改再发送。

Agent 可能动态询问：主题目标、受众、使用场景、演讲时长、页数、语言、画幅、视觉风格、资料来源、必须出现或禁止出现的内容。问题顺序由后端规划器决定，前端不写死顺序。

### 3.3 OutlineWorkspace

大纲必须脱离消息气泡，进入全屏工作区：

```text
┌──────────────────────────────────────────────────────────────┐
│ ← 返回对话              逐页大纲              生成 PPT →      │
├──────────────────────────────────────────────────────────────┤
│ 01  页面标题                                                 │
│     页面目标 / 关键要点 / 视觉建议 / 演讲备注                 │
│                                                              │
│ 02  页面标题                                                 │
│     页面目标 / 关键要点 / 视觉建议 / 演讲备注                 │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ [+ 添加页面]   [AI 优化]   [保存草稿]   [确认并开始生成]       │
└──────────────────────────────────────────────────────────────┘
```

每页支持：编辑标题、编辑要点、编辑视觉建议、编辑备注、拖动排序、复制、删除、AI 重写。

每次修改产生新的 `outlineVersionId`；确认生成时必须提交该版本，而不是让 ppt-master 重新猜测页面结构。

### 3.4 Generating

生成中只保留：

- “制作中”
- “正在制作 PPT”
- 当前任务标题
- 阶段和进度
- 左右滚轮预览卡片
- 取消制作

隐藏任务记录、Artifact 面板、素材 Slot、属性详情、幻灯片导航、画布和导出工具栏。任务完成后再恢复编辑器。

### 3.5 路由进入 loading

每次进入 `/presentation` 路由使用现有清舟 loading：

- 普通桌面动态路由和桌面静态配置保持一致。
- 路由层负责 `BrandTextLoading` / `QingzhouBrandLoading`。
- 页面内部只负责自己的数据 loading，不重复绘制清舟品牌动画。

## 4. 参考材料数据契约（前端投影）

前端只向运行时提交安全的引用和描述，不提交本地路径：

```typescript
interface PresentationReferenceInput {
  id: string;
  kind: 'image' | 'pptx' | 'pdf' | 'docx' | 'xlsx' | 'text';
  name: string;
  assetRef?: string;
  mimeType?: string;
  sizeBytes?: number;
  status: 'uploading' | 'ready' | 'failed';
}
```

规则：

- `assetRef` 由上传 / 资产模块产生，前端不能伪造本地 `file:` 或 `/tmp` 路径。
- 上传失败要显示可重试状态，不能静默丢失。
- 发送消息时同时提交 `message` 和 `references` 快照。
- 参考材料删除只影响当前会话草稿，不删除服务端已有资产。
- 重连后按事件序号恢复材料列表和上传状态。

## 5. 后端 Cordis 对接预期

agy 只依赖稳定的运行时事件，不在前端实现 Agent 决策。后端后续应提供：

```text
presentation.conversation.started
presentation.message.appended
presentation.question.created
presentation.brief.updated
presentation.outline.proposed
presentation.outline.updated
presentation.outline.confirmed
presentation.asset.plan.created
presentation.asset.ready
presentation.generation.started
presentation.generation.completed
```

Agent 端内部链路：

```text
用户消息/参考材料
  → BriefStateStore
  → QuestionPlanner
  → OutlinePlanner
  → ImageGenerationCapability
  → SceneRenderer / AssetCompositionCapability
  → PptMasterCapability
```

## 6. Image2 多资产与真实拼接的前端预留

前端展示的是资产状态，不直接理解 provider：

- 每页可以有多个 asset slot。
- 每个 slot 可以有多个候选图。
- 用户可以在生成前修改某个 slot 的视觉描述。
- 生成中显示轻量的素材进度，不恢复旧式任务侧栏。
- 完成后素材以图片节点进入 SVG/PPT 画布，文本、形状、图表保持可编辑。

当前 “多图生成” 与 “真实合成” 要分开：

1. 多图生成：Image2 为多个 slot 生成独立 `AssetRef`。
2. 场景拼接：SceneRenderer 按坐标、裁剪、旋转把资产放入页面。
3. 光栅合成：以后由独立 `AssetCompositionPort` 将多层资产合成一张新图，并保留来源记录。

前端不能把三种状态都显示成 “已完成”；必须区分 `planned`、`generating`、`ready`、`composed`、`failed`。

## 7. agy 原子任务分派顺序

### A-1 入口标题与模板填充

修改范围：`PresentationStudio/AgentFlow`、相关样式与测试。

完成条件：无图标、标题打字机轮询、模板只填充输入框、现有消息组件回归通过。

### A-2 复用首页输入和上传

修改范围：`PresentationChatInput`、Presentation 页面接线和测试。

完成条件：复用 `DragUploadZone + useUploadFiles + ChatInputProvider + DesktopChatInput`；支持图片和文档参考材料；上传状态、删除、失败重试有测试。

### A-3 全宽对话布局

修改范围：`AgentFlow`、Presentation 样式和路由 loading。

完成条件：1440×900 不窄、不出现中间滚动条；390×844 不溢出；进入路由显示清舟 loading。

### A-4 动态问题 UI

修改范围：消息事件投影、问题卡片和输入框。

完成条件：问题来自事件 payload；建议只填充输入框；自由文本和材料引用可以一起发送。

### A-5 全屏大纲编辑

新增 `OutlineWorkspace` 及定向测试。

完成条件：逐页编辑、增删、排序、AI 修改入口、版本号和确认事件完整；大纲不再缩在消息气泡里。

### A-6 生成态与编辑态回归

完成条件：生成中只显示简洁光感工作区；完成态仍能看到 SVG 页面、编辑入口和导出入口；无旧面板泄漏。

## 8. C-112 生成中体验问题契约（截图复盘）

本节冻结 2026-09-03 截图反馈，作为下一轮前端修改的唯一验收来源。目标不是增加信息面板，而是在保持 LobeHub 极简视觉的前提下，让用户明确知道 “任务仍在运行、当前处理到哪一页、离开页面后不会丢失”。

### 8.1 已确认的问题

| 编号     | 现象                                                     | 用户风险                  | 必须达到的结果                                                                                                                                                                                            |
| -------- | -------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-112-01 | 当前页卡片只有静态边框，无法强调正在处理哪一页           | 用户不知道焦点是否变化    | 当前卡片有低亮度、连续流动的边缘白光；不闪烁、不改变卡片尺寸；`prefers-reduced-motion` 下退化为静态高亮                                                                                                   |
| C-112-02 | 生成标题占据视觉中心，卡片偏小且页面留白大               | 视觉重心错误，像 “假进度” | 预览卡片组放大并居中；标题 / 阶段 / 进度整体下移到屏幕偏下区域；桌面端最大内容宽度约 1280–1440px，移动端不溢出                                                                                            |
| C-112-03 | 只显示 “第 2/4 阶段”，用户看不到细粒度进度或 AI 当前动作 | 长任务容易被误认为卡死    | 在不引入旧侧栏的情况下，展示当前阶段、页码 / 总页数、最近一条可读的 AI 动作（例如 “正在整理第 2 页的 Transformer 架构图”）和最近更新时间；事件长时间无变化时显示 “仍在处理，已等待 xx 秒”，不能伪造百分比 |
| C-112-04 | 离开 `/presentation` 再回来可能丢失生成态                | 用户误以为任务中断        | 生成态由 `jobId` + store / 事件续传恢复；重新进入页面先恢复状态，再订阅增量事件；不得重复创建任务；完成后自动进入编辑工作台                                                                               |
| C-112-05 | 左侧面板隐藏后没有再次打开入口                           | 页面不可逆，用户迷路      | 隐藏状态下保留 LobeHub 风格的窄边缘 “展开” 入口，44×44px 触达区、键盘可达、带 aria-label；展开 / 收起有 150–300ms transform/opacity 动画                                                                  |

### 8.2 交互与视觉不变量

- 继续复用 `@lobehub/ui`、现有 `styles`、清舟品牌动效；不引入第二套 loading 体系。
- 生成中不显示旧式任务列表、Artifact 详情、素材属性面板或第二层对话框。
- 所有动态文本必须来自事件投影或稳定的 job 字段；禁止用定时器伪造 “思考内容” 和虚假进度。
- 光晕只使用 `transform`、`opacity`、伪元素或渐变边框，动画 150–300ms 微交互、1.8–3.2s 循环；避免 layout thrashing。
- 文字保持中文、短句、可读；AI 动作最多一行，超长内容截断并支持无障碍完整文本。
- 1440×900：卡片是第一视觉中心，生成信息位于其下方；390×844：卡片可横向滚动但不能出现页面级横向溢出。

### 8.3 唯一性分工（两个 Herdr agy）

#### agy-A：生成工作区视觉与实时进度

只允许修改：

- `src/features/PresentationStudio/PresentationGenerationWorkspace.tsx`
- `src/features/PresentationStudio/style.ts`（仅生成态相关样式）
- `src/features/PresentationStudio/PresentationGenerationWorkspace.test.tsx`
- 新增同目录生成态测试时，文件名必须以 `generationExperience` 开头

负责 C-112-01、C-112-02、C-112-03：卡片放大 / 居中、当前页白光流动边缘、下移的标题区、事件驱动的动作文案、最近更新时间、等待提示、reduced-motion 和 1440×900/390×844 测试。不得修改对话输入、路由、store、侧栏。

#### agy-B：离页恢复与侧栏重开入口

只允许修改：

- `src/features/PresentationStudio/hooks/usePresentationStudio.ts`
- `src/features/PresentationStudio/store/presentationStore.ts`
- `src/features/PresentationStudio/PresentationStudio.tsx`
- `src/features/RuntimeWorkspace/Sidebar/**`
- 对应 `usePresentationStudio*`、`presentationStudioPerJob*`、`RuntimeWorkspace`/`Sidebar` 测试

负责 C-112-04、C-112-05：按 jobId 恢复生成状态和最高 seq 续传、避免重复创建任务、重新进入后的 loading / 订阅顺序、隐藏侧栏时的可发现展开按钮和键盘 / ARIA 行为。不得修改生成工作区视觉样式、模板 prompt、后端路由或 provider。

### 8.4 交付与审核顺序

1. 两个 agy 各自先读取本节，确认文件边界；不得交叉修改同一文件。
2. 完成后必须正式回报，首行分别为 “我是 agy-A（Herdr）” 或 “我是 agy-B（Herdr）”，包含 `status / files / contracts_changed / tests / evidence / risks / next`；只改代码，不 commit/push。
3. root 先审查 diff 和契约边界，再运行定向测试；若一方失败，只给该方最小修复任务，不打断另一方。
4. 最终验收：生成态截图 1440×900、390×844；离页重进不重复创建 job；侧栏隐藏后可重新打开；`prefers-reduced-motion` 无持续动画；无旧面板泄漏。

## 8. 每次回报格式

agy 完成任何一个原子任务后，必须向 root 回报：

```text
我是 agy（Herdr）
status: completed | partial | blocked
files:
contracts_changed:
tests:
evidence:
risks:
next:
```

不 commit、不 push；如果发现需要后端新合同，先回报阻塞点和最小合同建议，不自行扩大修改范围。
