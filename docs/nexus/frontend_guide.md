# 清舟 Frontend 改造：原子化步骤、验证与回档安全操作指南

> \[!IMPORTANT]
> 为保证系统的极高稳定性，防止不当修改毁坏现有代码库，前端所有涉及 **Community UI / Zen Tech 风格改造** 的操作必须遵循本指南的原子化步骤和回档规范。

---

## 1. 安全准备：防线与快速回档

在进行任何前端文件修改前，请确保执行以下操作建立 “安全存档点”：

### A. 创建专属隔离分支

不要直接在 `canary` 上修改。从最新 `canary` 切出功能分支：

```bash
git checkout -b feat/community-zen-rebrand
```

### B. 暂存当前未提交的工作区

如果你有未提交的基础设施改动，先创建一个 Stash：

```bash
git stash save "Nexus base changes backup before UI redesign"
```

### C. 突发故障时的 “一键回滚” 指令

- **只回滚单个文件**：
  ```bash
  git checkout -- src/routes/\(main\)/community/\(list\)/_layout/index.tsx
  ```
- **彻底清除本次 UI 尝试并退回到起点**：
  ```bash
  git reset --hard HEAD
  ```

---

## 2. 原子化改造步骤 (Atomic Steps)

社区界面的 “Zen Tech & Hero” 风格改造分为 4 个原子步骤。每次完成一个步骤，必须通过下一节的【验证机制】才能进入下一步。

### Step 1: 布局底座零运行时 CSS 化 (Zero-runtime Layout Styles)

- **目标**：重构 `src/routes/(main)/community/(list)/_layout/index.tsx` 和 `style.ts`。
- **规则**：将 `style.ts` 中可能存在的运行时 `createStyles` 迁移至 `createStaticStyles`。使用 `cssVar.*` 来读取 antd 变量，确保滚动渲染零开销。
- **文件修改范围**：
  - `src/routes/(main)/community/(list)/_layout/index.tsx`
  - `src/routes/(main)/community/(list)/_layout/style.ts`

### Step 2: 首页 Hero 聚焦组件 (Hero Banner Component)

- **目标**：在 `/community` 首页（或 `(home)` 路由）顶部增加一个精美的 Hero Banner 聚焦区，具备 Zen Tech 风格（大字留白、软阴影、半透明纸质感卡片）。
- **规则**：新建组件必须放在 `src/features/CommunityHub/HeroBanner` 中，由 Route 文件进行纯净导入。
- **文件修改范围**：
  - `[NEW] src/features/CommunityHub/HeroBanner/index.tsx`
  - `[NEW] src/features/CommunityHub/HeroBanner/style.ts`

### Step 3: 卡片与分类排版微调 (Card & Category Refinements)

- **目标**：微调 `agent`、`mcp`、`model` 和 `skill` 的展示卡片，去除硬边框，使用极细的 Outlined 边界和悬浮微交互，确保视觉风格高度统一。
- **文件修改范围**：
  - `src/routes/(main)/community/features/` 下的相关共享卡片

### Step 4: 加载动效整合 (Loading integration)

- **目标**：将 `QingzhouBrandLoading` 整合进社区页面的 SWR / 路由挂载状态，确保在骨架屏加载时展示流光绘制动效。

---

## 3. 严格的验证机制 (Verification Pipeline)

每修改完一个 Step，**必须依次通过以下命令检测**，才算做该步骤原子化成功。

### 1. 类型校验 (Type Check)

任何 CSS-in-JS 的重构，很容易因为 Token 拼写引起编译错误。运行：

```bash
bun run type-check
```

### 2. 本地测试运行

对路由和公共配置的改动，需确保现有的同步测试通过：

```bash
bunx vitest run src/spa/router/desktopRouter.sync.test.tsx
```

---

## 4. 前端样式最佳实践提醒

在修改 CSS 时，请严格遵守以下范式：

```typescript
// 推荐做法：使用 createStaticStyles
import { createStaticStyles, css } from 'antd-style';

export const useStyles = createStaticStyles(({ cssVar }) => ({
  mainContainer: css`
    background: ${cssVar.colorBgLayout};
    padding-bottom: 56px;
  `,
  heroCard: css`
    backdrop-filter: blur(8px);
    background: rgba(255, 255, 255, 0.7);
  `,
}));
```

避免使用 `createStyles(({ token }) => ...)` 这样的运行时 Token 读取，除非卡片背景确实需要实时根据用户主题进行复杂的 JavaScript 计算。这能防止大型社区长列表因重绘而导致掉帧。
