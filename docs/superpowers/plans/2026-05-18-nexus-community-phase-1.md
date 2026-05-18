# NEXUS Community Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the existing LobeHub `/community` surface into the first NEXUS ecosystem shell with Zen Tech styling and a unified publish-center entry.

**Architecture:** Keep the current SPA community route tree intact and make focused changes in the existing community route modules. Add small shared config/style helpers under `src/routes/(main)/community/features` instead of moving route code into a new feature domain during this phase.

**Tech Stack:** Next.js SPA routes, React 19, TypeScript, react-router-dom, `@lobehub/ui`, antd-style `createStaticStyles`, react-i18next.

---

## Scope

This plan implements Phase 1 UI shell work only. It does not add the database-backed `community_resources` model or real publishing mutations. Those belong in a follow-up backend plan after the community shell and publish-center UX are visible.

## File Structure

- Modify `src/routes/(main)/community/features/useNav.tsx`: add NEXUS category labels for the horizontal/list header navigation.
- Modify `src/routes/(main)/community/_layout/Sidebar/Header/Nav.tsx`: add Zen Tech/NEXUS sidebar nav labels and include Blogs/Creators entries as shell navigation items.
- Modify `src/routes/(main)/community/_layout/style.ts`: add Zen Tech background tokens to the community root shell.
- Modify `src/routes/(main)/community/(list)/_layout/style.ts`: add paper-like list page background and content surface styling.
- Modify `src/routes/(main)/community/(list)/(home)/index.tsx`: replace the current default home composition with a NEXUS ecosystem homepage that still reuses existing Agent/MCP list data.
- Create `src/routes/(main)/community/(list)/(home)/features/NexusHero.tsx`: Zen Tech hero for the community homepage.
- Create `src/routes/(main)/community/(list)/(home)/features/NexusEcosystemGrid.tsx`: category cards for Agents, Skills, MCP, Providers, Models, Blogs, and Creators.
- Modify `src/routes/(main)/community/features/CreateButton/Inner.tsx`: replace the legacy submit guide with a unified publish-center shell.
- Modify `src/locales/default/discover.ts`: add NEXUS community and publish-center copy.
- Modify `packages/types/src/discover/index.ts`: add `Blogs` and `Creators` enum values for shell navigation.

## Task 1: Add Community Type Labels

**Files:**

- Modify: `packages/types/src/discover/index.ts`

- Modify: `src/locales/default/discover.ts`

- [ ] **Step 1: Add enum values**

In `packages/types/src/discover/index.ts`, update `DiscoverTab` to include:

```ts
export enum DiscoverTab {
  Assistants = 'agent',
  Blogs = 'blog',
  Creators = 'creator',
  GroupAgents = 'group_agent',
  Home = 'home',
  Mcp = 'mcp',
  Models = 'model',
  Plugins = 'plugin',
  Providers = 'provider',
  Skills = 'skill',
  User = 'user',
}
```

- [ ] **Step 2: Add default locale keys**

In `src/locales/default/discover.ts`, add these keys near the existing `tab.*` keys:

```ts
'nexus.hero.eyebrow': 'NEXUS Ecosystem',
'nexus.hero.title': 'Build, publish, and fork your agent stack',
'nexus.hero.description':
  'A Zen Tech community for agents, skills, MCP tools, provider templates, model notes, and public creator blogs.',
'nexus.hero.primary': 'Publish a resource',
'nexus.hero.secondary': 'Explore official picks',
'nexus.home.official': 'Official and mirrored resources',
'nexus.home.community': 'Community launches',
'nexus.home.blogs': 'Latest creator writing',
'nexus.home.categories': 'Ecosystem categories',
'nexus.category.agent.title': 'Agents',
'nexus.category.agent.desc': 'Fork complete assistant configurations into your workspace.',
'nexus.category.skill.title': 'Skills',
'nexus.category.skill.desc': 'Install reusable agent skills from official and creator packages.',
'nexus.category.mcp.title': 'MCP Tools',
'nexus.category.mcp.desc': 'Connect tools and servers with clear permissions and setup guides.',
'nexus.category.provider.title': 'Providers',
'nexus.category.provider.desc': 'Share base URL templates, headers, and model mappings.',
'nexus.category.model.title': 'Models',
'nexus.category.model.desc': 'Compare model abilities, context windows, and provider availability.',
'nexus.category.blog.title': 'Blogs',
'nexus.category.blog.desc': 'Publish MDX articles using the Fumadocs-inspired public blog style.',
'nexus.category.creator.title': 'Creators',
'nexus.category.creator.desc': 'Discover builders publishing agents, skills, tools, and writing.',
'publishCenter.title': 'Publish to NEXUS',
'publishCenter.description':
  'Turn private workspace assets into public ecosystem resources. The first release supports the shell for every type, with Skills, Agents, and Blogs deepened first.',
'publishCenter.common.title': 'One publish flow',
'publishCenter.common.desc': 'Every resource shares title, description, cover, tags, category, visibility, and preview.',
'publishCenter.agent.title': 'Agent',
'publishCenter.agent.desc': 'Publish an assistant configuration that others can fork.',
'publishCenter.skill.title': 'Skill',
'publishCenter.skill.desc': 'Upload a zip, GitHub repository, or Skill.md package.',
'publishCenter.mcp.title': 'MCP / Tool',
'publishCenter.mcp.desc': 'Share connection details, manifests, and permission notes.',
'publishCenter.provider.title': 'Provider',
'publishCenter.provider.desc': 'Share base URL templates and supported model mappings.',
'publishCenter.model.title': 'Model',
'publishCenter.model.desc': 'Publish model metadata, abilities, context, and pricing notes.',
'publishCenter.blog.title': 'Blog',
'publishCenter.blog.desc': 'Publish Markdown or MDX to a public creator blog.',
'tab.blog': 'Blogs',
'tab.creator': 'Creators',
```

- [ ] **Step 3: Run type check for enum consumers**

Run:

```bash
bun run type-check
```

Expected: either pass, or fail only on unrelated existing repo issues. If new failures mention `DiscoverTab.Blogs` or `DiscoverTab.Creators`, fix the enum references before continuing.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/discover/index.ts src/locales/default/discover.ts
git commit -m "✨ feat: add NEXUS community labels"
```

## Task 2: Rebrand Community Navigation

**Files:**

- Modify: `src/routes/(main)/community/features/useNav.tsx`

- Modify: `src/routes/(main)/community/_layout/Sidebar/Header/Nav.tsx`

- [ ] **Step 1: Update horizontal nav labels**

In `src/routes/(main)/community/features/useNav.tsx`, import `Feather` and `UsersRound` from `lucide-react`, keep `react-router-dom` links, and make `items` include:

```tsx
{
  icon: <Icon icon={House} size={ICON_SIZE} />,
  key: DiscoverTab.Home,
  label: <div style={{ color: 'inherit', display: 'inline' }}>{t('tab.home')}</div>,
},
{
  icon: <Icon icon={Bot} size={ICON_SIZE} />,
  key: DiscoverTab.Assistants,
  label: <div style={{ color: 'inherit', display: 'inline' }}>{t('tab.assistant')}</div>,
},
{
  icon: <Icon icon={BrainCircuit} size={ICON_SIZE} />,
  key: DiscoverTab.Skills,
  label: <div style={{ color: 'inherit', display: 'inline' }}>{t('tab.skill')}</div>,
},
{
  icon: <MCP className={'anticon'} size={ICON_SIZE} />,
  key: DiscoverTab.Mcp,
  label: <div style={{ color: 'inherit', display: 'inline' }}>MCP</div>,
},
{
  icon: <Icon icon={Brain} size={ICON_SIZE} />,
  key: DiscoverTab.Models,
  label: <div style={{ color: 'inherit', display: 'inline' }}>{t('tab.model')}</div>,
},
{
  icon: <Icon icon={BrainCircuit} size={ICON_SIZE} />,
  key: DiscoverTab.Providers,
  label: <div style={{ color: 'inherit', display: 'inline' }}>{t('tab.provider')}</div>,
},
{
  icon: <Icon icon={Feather} size={ICON_SIZE} />,
  key: DiscoverTab.Blogs,
  label: <div style={{ color: 'inherit', display: 'inline' }}>{t('tab.blog')}</div>,
},
{
  icon: <Icon icon={UsersRound} size={ICON_SIZE} />,
  key: DiscoverTab.Creators,
  label: <div style={{ color: 'inherit', display: 'inline' }}>{t('tab.creator')}</div>,
},
```

Keep the active-key fallback to `DiscoverTab.Home`.

- [ ] **Step 2: Update sidebar nav**

In `src/routes/(main)/community/_layout/Sidebar/Header/Nav.tsx`, import `Feather` and `UsersRound` from `lucide-react`. Append shell navigation items:

```tsx
{
  icon: Feather,
  key: DiscoverTab.Blogs,
  title: t('tab.blog'),
  url: '/community/blog',
},
{
  icon: UsersRound,
  key: DiscoverTab.Creators,
  title: t('tab.creator'),
  url: '/community/user',
},
```

Keep existing URLs for current working pages:

```tsx
url: '/community/agent'
url: '/community/skill'
url: '/community/mcp'
url: '/community/model'
url: '/community/provider'
```

- [ ] **Step 3: Run a focused type check**

Run:

```bash
bun run type-check
```

Expected: navigation files compile with the new enum values and imports.

- [ ] **Step 4: Commit**

```bash
git add 'src/routes/(main)/community/features/useNav.tsx' 'src/routes/(main)/community/_layout/Sidebar/Header/Nav.tsx'
git commit -m "✨ feat: rebrand community navigation"
```

## Task 3: Add Zen Tech Community Shell Styling

**Files:**

- Modify: `src/routes/(main)/community/_layout/style.ts`

- Modify: `src/routes/(main)/community/(list)/_layout/style.ts`

- [ ] **Step 1: Style the community root**

Replace `mainContainer` in `src/routes/(main)/community/_layout/style.ts` with:

```ts
mainContainer: css`
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(circle at 20% 0%, rgb(221 118 39 / 10%), transparent 28rem),
    radial-gradient(circle at 85% 8%, rgb(198 187 88 / 10%), transparent 24rem),
    linear-gradient(135deg, #fbfaf6 0%, #f3eddf 46%, #ece2cf 100%);

  &::before {
    pointer-events: none;
    content: '';

    position: absolute;
    inset: 0;

    opacity: 0.32;
    background-image:
      linear-gradient(rgb(74 63 35 / 5%) 1px, transparent 1px),
      linear-gradient(90deg, rgb(74 63 35 / 5%) 1px, transparent 1px);
    background-size: 28px 28px;
    mask-image: linear-gradient(to bottom, black, transparent 72%);
  }

  [data-theme='dark'] & {
    background:
      radial-gradient(circle at 20% 0%, rgb(221 118 39 / 16%), transparent 28rem),
      radial-gradient(circle at 85% 8%, rgb(198 187 88 / 12%), transparent 24rem),
      linear-gradient(135deg, #080705 0%, #11100b 48%, #1b160e 100%);
  }
`,
```

- [ ] **Step 2: Style the list content container**

In `src/routes/(main)/community/(list)/_layout/style.ts`, keep existing class names and update or add:

```ts
mainContainer: css`
  position: relative;
  overflow: auto;
`,
contentContainer: css`
  position: relative;
  z-index: 1;
`,
spacer: css`
  flex: 1;
`,
```

If those keys already exist, preserve unrelated layout behavior and only add `position`, `z-index`, and scroll behavior.

- [ ] **Step 3: Run style/type check**

Run:

```bash
bun run type-check
```

Expected: styles compile.

- [ ] **Step 4: Commit**

```bash
git add 'src/routes/(main)/community/_layout/style.ts' 'src/routes/(main)/community/(list)/_layout/style.ts'
git commit -m "🎨 style: apply Zen Tech community shell"
```

## Task 4: Build NEXUS Homepage Hero And Category Grid

**Files:**

- Create: `src/routes/(main)/community/(list)/(home)/features/NexusHero.tsx`

- Create: `src/routes/(main)/community/(list)/(home)/features/NexusEcosystemGrid.tsx`

- Modify: `src/routes/(main)/community/(list)/(home)/index.tsx`

- [ ] **Step 1: Create `NexusHero.tsx`**

Create `src/routes/(main)/community/(list)/(home)/features/NexusHero.tsx`:

```tsx
'use client';

import { Button, Flexbox, Icon, Tag } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { Brush, Sparkles } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

const useStyles = createStaticStyles(({ css, cssVar }) => ({
  hero: css`
    overflow: hidden;
    position: relative;

    min-height: 320px;
    padding: 40px;

    border: 1px solid rgb(126 99 58 / 18%);
    border-radius: 28px;

    background:
      linear-gradient(135deg, rgb(255 255 255 / 72%), rgb(244 236 219 / 76%)),
      radial-gradient(circle at 78% 18%, rgb(221 118 39 / 18%), transparent 20rem);
    box-shadow: 0 24px 80px rgb(68 49 21 / 12%);

    [data-theme='dark'] & {
      border-color: rgb(255 255 255 / 10%);
      background:
        linear-gradient(135deg, rgb(22 19 14 / 88%), rgb(12 10 8 / 92%)),
        radial-gradient(circle at 78% 18%, rgb(221 118 39 / 20%), transparent 20rem);
      box-shadow: 0 24px 80px rgb(0 0 0 / 30%);
    }
  `,
  brush: css`
    pointer-events: none;
    position: absolute;
    right: -120px;
    bottom: -180px;

    width: 520px;
    height: 320px;
    border-radius: 999px;

    opacity: 0.18;
    background: linear-gradient(135deg, #332918, #dd7627 55%, #c6bb58);
    filter: blur(8px);
    transform: rotate(-14deg);
  `,
  title: css`
    max-width: 760px;
    margin: 0;

    color: #423a22;

    font-size: clamp(36px, 5vw, 68px);
    font-weight: 600;
    line-height: 0.98;
    letter-spacing: -0.055em;

    [data-theme='dark'] & {
      color: #fff4d8;
    }
  `,
  description: css`
    max-width: 680px;
    margin: 0;
    color: ${cssVar.colorTextSecondary};
    font-size: 17px;
    line-height: 1.7;
  `,
}));

const NexusHero = memo(() => {
  const { t } = useTranslation('discover');
  const styles = useStyles();

  return (
    <Flexbox className={styles.hero} gap={28}>
      <div className={styles.brush} />
      <Flexbox align={'flex-start'} gap={18} style={{ position: 'relative', zIndex: 1 }}>
        <Tag>
          <Icon icon={Sparkles} size={13} />
          {t('nexus.hero.eyebrow')}
        </Tag>
        <h1 className={styles.title}>{t('nexus.hero.title')}</h1>
        <p className={styles.description}>{t('nexus.hero.description')}</p>
        <Flexbox gap={12} horizontal>
          <Button icon={Brush} type={'primary'}>
            {t('nexus.hero.primary')}
          </Button>
          <Button>{t('nexus.hero.secondary')}</Button>
        </Flexbox>
      </Flexbox>
    </Flexbox>
  );
});

export default NexusHero;
```

- [ ] **Step 2: Create `NexusEcosystemGrid.tsx`**

Create `src/routes/(main)/community/(list)/(home)/features/NexusEcosystemGrid.tsx`:

```tsx
'use client';

import { Icon } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { Bot, Brain, BrainCircuit, Feather, Network, ServerCog, UsersRound } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

const useStyles = createStaticStyles(({ css, cssVar }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 14px;
  `,
  card: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    min-height: 156px;
    padding: 18px;

    color: inherit;
    text-decoration: none;

    border: 1px solid rgb(126 99 58 / 14%);
    border-radius: 20px;

    background: rgb(255 255 255 / 58%);
    backdrop-filter: blur(16px);

    transition:
      transform 160ms ease,
      border-color 160ms ease,
      background 160ms ease;

    &:hover {
      transform: translateY(-2px);
      border-color: rgb(221 118 39 / 42%);
      background: rgb(255 255 255 / 78%);
    }

    [data-theme='dark'] & {
      border-color: rgb(255 255 255 / 10%);
      background: rgb(255 255 255 / 5%);

      &:hover {
        border-color: rgb(255 210 110 / 34%);
        background: rgb(255 255 255 / 8%);
      }
    }
  `,
  icon: css`
    display: grid;
    place-items: center;

    width: 38px;
    height: 38px;

    color: #8b4a1f;

    border-radius: 14px;
    background: rgb(221 118 39 / 12%);

    [data-theme='dark'] & {
      color: #ffe2a8;
      background: rgb(221 118 39 / 18%);
    }
  `,
  title: css`
    margin: 0;
    color: ${cssVar.colorText};
    font-size: 16px;
    font-weight: 600;
  `,
  desc: css`
    margin: 0;
    color: ${cssVar.colorTextSecondary};
    font-size: 13px;
    line-height: 1.55;
  `,
}));

const categories = [
  { desc: 'nexus.category.agent.desc', icon: Bot, title: 'nexus.category.agent.title', url: '/community/agent' },
  { desc: 'nexus.category.skill.desc', icon: BrainCircuit, title: 'nexus.category.skill.title', url: '/community/skill' },
  { desc: 'nexus.category.mcp.desc', icon: Network, title: 'nexus.category.mcp.title', url: '/community/mcp' },
  { desc: 'nexus.category.provider.desc', icon: ServerCog, title: 'nexus.category.provider.title', url: '/community/provider' },
  { desc: 'nexus.category.model.desc', icon: Brain, title: 'nexus.category.model.title', url: '/community/model' },
  { desc: 'nexus.category.blog.desc', icon: Feather, title: 'nexus.category.blog.title', url: '/community/blog' },
  { desc: 'nexus.category.creator.desc', icon: UsersRound, title: 'nexus.category.creator.title', url: '/community/user' },
];

const NexusEcosystemGrid = memo(() => {
  const { t } = useTranslation('discover');
  const styles = useStyles();

  return (
    <div className={styles.grid}>
      {categories.map((category) => (
        <Link className={styles.card} key={category.title} to={category.url}>
          <div className={styles.icon}>
            <Icon icon={category.icon} size={18} />
          </div>
          <h3 className={styles.title}>{t(category.title)}</h3>
          <p className={styles.desc}>{t(category.desc)}</p>
        </Link>
      ))}
    </div>
  );
});

export default NexusEcosystemGrid;
```

- [ ] **Step 3: Replace home composition**

In `src/routes/(main)/community/(list)/(home)/index.tsx`, import and render `NexusHero` and `NexusEcosystemGrid` before the existing featured lists:

```tsx
import NexusEcosystemGrid from './features/NexusEcosystemGrid';
import NexusHero from './features/NexusHero';
```

Return:

```tsx
return (
  <>
    <NexusHero />
    <Title>{t('nexus.home.categories')}</Title>
    <NexusEcosystemGrid />
    <Title more={t('home.more')} moreLink={'/community/agent'}>
      {t('nexus.home.official')}
    </Title>
    <AssistantList data={assistantList.items} rows={4} />
    <div />
    <Title more={t('home.more')} moreLink={'/community/mcp'}>
      {t('nexus.home.community')}
    </Title>
    <McpList data={mcpList.items} rows={4} />
  </>
);
```

Remove `CreatorRewardBanner` from the home page for Phase 1.

- [ ] **Step 4: Run targeted checks**

Run:

```bash
bunx vitest run --silent='passed-only' 'src/routes/(main)/community/features/__tests__/calculateScore.test.ts'
bun run type-check
```

Expected: vitest passes; type check passes or only reports unrelated existing issues.

- [ ] **Step 5: Commit**

```bash
git add 'src/routes/(main)/community/(list)/(home)/index.tsx' 'src/routes/(main)/community/(list)/(home)/features/NexusHero.tsx' 'src/routes/(main)/community/(list)/(home)/features/NexusEcosystemGrid.tsx'
git commit -m "✨ feat: add NEXUS community homepage"
```

## Task 5: Replace Create Modal With Publish Center Shell

**Files:**

- Modify: `src/routes/(main)/community/features/CreateButton/Inner.tsx`

- [ ] **Step 1: Replace modal content**

In `src/routes/(main)/community/features/CreateButton/Inner.tsx`, replace the legacy GitHub submit guide with a publish-center shell:

```tsx
import { Flexbox, Icon, Tag, Typography } from '@lobehub/ui';
import { Bot, Brain, BrainCircuit, Feather, Network, ServerCog } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

const resourceTypes = [
  { desc: 'publishCenter.agent.desc', icon: Bot, title: 'publishCenter.agent.title' },
  { desc: 'publishCenter.skill.desc', icon: BrainCircuit, title: 'publishCenter.skill.title' },
  { desc: 'publishCenter.mcp.desc', icon: Network, title: 'publishCenter.mcp.title' },
  { desc: 'publishCenter.provider.desc', icon: ServerCog, title: 'publishCenter.provider.title' },
  { desc: 'publishCenter.model.desc', icon: Brain, title: 'publishCenter.model.title' },
  { desc: 'publishCenter.blog.desc', icon: Feather, title: 'publishCenter.blog.title' },
];

const Inner = memo(() => {
  const { t } = useTranslation('discover');

  return (
    <Typography fontSize={14} headerMultiple={0.5} marginMultiple={0.4}>
      <h2>{t('publishCenter.title')}</h2>
      <p>{t('publishCenter.description')}</p>
      <h3>
        <Tag color={'gold'}>{t('publishCenter.common.title')}</Tag>
      </h3>
      <p>{t('publishCenter.common.desc')}</p>
      <Flexbox gap={12}>
        {resourceTypes.map((item) => (
          <Flexbox
            gap={8}
            horizontal
            key={item.title}
            style={{
              border: '1px solid var(--ant-color-border-secondary)',
              borderRadius: 16,
              padding: 14,
            }}
          >
            <Icon icon={item.icon} size={18} />
            <Flexbox gap={2}>
              <strong>{t(item.title)}</strong>
              <span style={{ color: 'var(--ant-color-text-secondary)' }}>{t(item.desc)}</span>
            </Flexbox>
          </Flexbox>
        ))}
      </Flexbox>
    </Typography>
  );
});

export default Inner;
```

- [ ] **Step 2: Run type check**

Run:

```bash
bun run type-check
```

Expected: publish modal compiles.

- [ ] **Step 3: Commit**

```bash
git add 'src/routes/(main)/community/features/CreateButton/Inner.tsx'
git commit -m "✨ feat: add NEXUS publish center shell"
```

## Task 6: Browser Smoke Test

**Files:**

- No planned code changes.

- [ ] **Step 1: Start SPA dev server**

Run:

```bash
bun run dev:spa
```

Expected: Vite serves on `http://localhost:9876` and prints the Debug Proxy URL.

- [ ] **Step 2: Open community page**

Open:

```text
http://localhost:9876/community
```

Expected:

- The page shows the NEXUS Ecosystem hero.

- Category cards show Agents, Skills, MCP Tools, Providers, Models, Blogs, and Creators.

- Existing featured agent and MCP sections still render.

- Sidebar navigation includes Blogs and Creators without breaking existing links.

- The Create button opens the NEXUS publish-center shell.

- [ ] **Step 3: Capture manual verification notes**

Add a short note to the final response with:

```text
Verified /community in dev: NEXUS hero, category grid, nav, and publish modal render.
```

If a runtime error appears, fix it before final response.

## Self-Review

- Spec coverage: this plan covers Phase 1 community shell, Zen Tech visual direction, all target categories in navigation, and publish-center shell. It intentionally defers database-backed resources and real publishing mutations to the next plan.
- Placeholder scan: plan-specific placeholder red flags are absent.
- Type consistency: new enum values are `DiscoverTab.Blogs` and `DiscoverTab.Creators`; locale keys use `nexus.*`, `publishCenter.*`, `tab.blog`, and `tab.creator`.
