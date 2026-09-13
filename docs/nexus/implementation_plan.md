# 清舟 Community：当前状态、改造进度与优雅设计蓝图

> \[!NOTE]
> 本文档梳理了清舟 Community（原 LobeHub 发现页）的演进路线，并提出了基于 “Zen Tech” 美学与集中式发布中心（内部兼容标识 `NexusRegistry`）的优雅改造方案。

## 1. 当前已经有什么 (Current State)

在 LobeHub 原有的基础上，社区模块被放置在 `src/routes/(main)/community` 下。
目前系统中**已经拥有**的模块包括：

- **分散的展示列表**：包含 `agent` (助手)、`model` (模型)、`provider` (供应商)、`skill` (技能 / 插件) 的浏览列表。
- **基础布局容器**：通过 `WideScreenContainer` 和简单的 `Header` / `Footer` 实现了左右定宽的瀑布流或网格布局（位于 `(list)/_layout/index.tsx`）。
- **底层数据结构**：基于原有的 JSON / Markdown 解析体系，用于展示静态的社区资源。

> \[!WARNING]
> 原有的设计是一个 “松散的黄页（Directory）”，缺乏 “社区中心（Hub）” 的凝聚力。排版相对拥挤，视觉表现（如样式代码）部分依赖动态运行时的 `createStyles`。

## 2. 正在改造什么 (Work In Progress)

根据本地代码树中尚未提交的改动，我们正在经历一次彻底的**架构级重构**，旨在将松散的黄页整合为**全平台统一的资源枢纽 (Nexus Registry)**。

- **统一发布中心 (Submission Center)**
  - **成果**：在 `src/features/NexusRegistry/SubmitRepoModal.tsx` 中，我们已经开发了一个极度惊艳的统一提交入口。
  - **能力**：它支持用户通过 **GitHub 链接、本地 ZIP、SKILL.md 纯文本、或者 manifest JSON** 四种途径，一键向 Nexus 提交资源（MCP、Skill、Plugin）。它甚至内置了 AI 润色（`aiMode: 'polish' | 'normalize'`）功能。
- **业务路由拓展**
  - **成果**：在 `src/routes/(main)/community/(list)/` 目录下，新增了 `analytics` (社区数据分析)、`review` (审核中心) 和 `submissions` (提交队列) 的入口。
  - **意义**：这标志着 Nexus Community 正在从 “纯前端静态展示” 向 “动态的、UGC (用户生成内容) 驱动的生态系统” 转型。

## 3. Future Elegant Design (未来继续怎么设计更优雅)

为了让 Nexus Community 的代码与视觉体验达到极致的 “优雅 (Elegant)”，我们接下来的改造方向（Blueprint）如下：

### 视觉方向：“Zen Tech” 暖色纸质基调与 Hero 聚焦排版

- **打破无聊的列表**：在首页 (`/community/(home)`) 引入大面积的 **Hero Section (焦点图 / 轮播)**。利用大量留白、现代无衬线字体（如 Inter / Outfit），配合暖白纸质背景和微弱的玻璃拟物化 (Glassmorphism) 卡片，提升高级感。
- **微动效与品牌融合**：将 `QingzhouBrandLoading`（SVG 流光渐入）融入页面切换和图片加载中。

### 技术实现：“Zero-runtime” 与组件内聚

- **彻底改造 CSS-in-JS**：
  > \[!TIP]
  > 严格遵循 LobeHub 最新规范，**坚决摒弃**社区页面中旧的 `createStyles` + `token`。全面改用 `createStaticStyles` 配合 `cssVar.*`。这将彻底消除页面滚动和切换时的运行时 CSS 重新计算卡顿。
- **SPA 路由极致瘦身**：
  保持 `src/routes/(main)/community/` 极度轻薄，**所有的业务组件和模态框必须内聚到 `src/features/NexusRegistry` 或 `src/features/CommunityHub` 中**，只在 Route 级别做简单的组装。

### 生态闭环：与 NewAPI 后端深度绑定

- 用户在 `SubmitRepoModal` 中提交的资源，不仅在 Nexus 中展示，还可以直接被 NewAPI 的路由层感知到。例如提交的 MCP 协议或大模型代理，可以无缝变为 Nexus 对话界面中的内置工具。

---

## Open Questions (需要你确认的下一步行动)

> \[!IMPORTANT]
> 这里的蓝图已经非常清晰。在继续之前，请告诉我你想优先落地哪一部分：

1. **直接动手写代码**：我现在就去把 `community/(list)/_layout/index.tsx` 和首页改造成 "Zen Tech" 风格的 Hero 布局，并引入 `createStaticStyles`？
2. **先清理积欠**：我们本地积压了大量未提交的修改（数据库互通、生图适配、统一发布中心等），是否要先执行一系列 `git commit` 将这些成果封存，保持工作区干净？
