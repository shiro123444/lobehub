# NEXUS Community Platform Design

Date: 2026-05-18

## Objective

Transform LobeHub/LobeChat into the unified NEXUS platform, starting with a complete
community ecosystem rebuild. The first phase keeps LobeHub's mature UI structure and
interaction model, applies a Zen Tech Eastern visual direction, and adds a unified
publishing layer for official and user-created ecosystem resources.

The long-term platform supports agents, skills, MCP/tools, providers, models, blogs,
gateway configuration, and billing in one product. This design focuses on the
community and publishing foundation.

## Context

Current LobeHub already provides a rich `/community` surface with list and detail pages
for agents, group agents, skills, MCP/plugins, models, providers, and users. It also
has user skill storage and import flows through `agentSkillsRouter`, `AgentSkillModel`,
`SkillStore`, `UploadSkillModal`, and `MarketService`.

The existing NEXUS repository is infrastructure-heavy. It includes Kiro Proxy,
CLI Proxy API management, billing gateway, FAST-P2P, Nginx, Cloudflare, and systemd
deployment configs. These services should inform later platform integration, but the
first community phase should not directly merge all service internals into LobeHub.

The existing Fumadocs project at `/home/shiro/Projects/fumadocs/shiro` provides the
desired public blog visual direction. Community listings should use the LobeHub-style
community UI, while blog detail/public pages should use the Fumadocs/Estival style.

## Product Direction

The selected end state is a unified platform. LobeHub becomes the main product shell
for chat, agents, community, publishing, provider templates, model discovery, and later
gateway/billing management.

The selected community visual direction is Zen Tech:

- Warm paper-like backgrounds.
- Ink gray text and low-contrast borders.
- Restrained gold and cinnabar accent colors.
- Dense, polished LobeHub-style cards and detail pages.
- Calm marketplace atmosphere rather than heavy cyberpunk decoration.

Blogs keep the existing Fumadocs/Estival direction:

- Warm editorial hero treatment.
- Shader/textured background.
- MDX/documentation-like reading experience.
- Public creator pages that feel more like a personal knowledge site than an app panel.

## Information Architecture

The `/community` route remains the ecosystem hub and is rebranded for NEXUS.

Primary routes:

- `/community`: ecosystem homepage with Zen Tech hero, featured official resources,
  trending user resources, latest blogs, and category entry points.
- `/community/agents`: public agent configurations users can fork into their workspace.
- `/community/skills`: official and user skills, with install actions, file tree,
  versions, README/details, and resource metadata.
- `/community/mcp`: MCP servers and tools with connection methods, permissions, and
  installation guidance.
- `/community/providers`: third-party provider/base URL templates with authentication
  notes, model mappings, and recommended setup.
- `/community/models`: model cards with ability tags, context information, pricing
  metadata, and related providers.
- `/community/blogs`: public article feed using community cards.
- `/community/users/:id`: creator profile showing the author's public agents, skills,
  MCP/tools, providers, models, and blogs.

Blog detail/public routes should use the Fumadocs visual system:

- `/community/blogs/:slug` for community-origin navigation.
- `/u/:username/blog/:slug` or `/blog/:username/:slug` for public sharing.
- `/u/:username` for a creator public home with articles and resources.

## Unified Resource Model

Add a generic community publishing layer instead of building separate systems for each
content type.

Core table: `community_resources`

Suggested fields:

- `id`
- `type`: `agent`, `skill`, `mcp`, `provider`, `model`, `blog`
- `title`
- `description`
- `slug`
- `authorId`
- `source`: `official`, `lobehub`, `user`
- `status`: `draft`, `submitted`, `published`, `hidden`, `rejected`, `archived`
- `visibility`: `public`, `unlisted`, `private`
- `tags`
- `category`
- `coverUrl`
- `metadata`
- `version`
- `publishedAt`
- timestamps

Supporting tables:

- `community_resource_versions`: immutable snapshots of published config, manifests,
  content, and metadata.
- `community_resource_stats`: views, installs, forks, likes, favorites, and comments.
- `community_resource_relations`: dependencies between resources, such as an agent
  depending on skills or a model belonging to providers.
- `community_reviews`: moderation decisions and reasons.
- `blog_posts`: MDX body and blog-specific metadata linked by `resourceId`.

Existing private workspace tables remain the source of user-owned working data. Public
resources are published snapshots. For example, `agent_skills` continues storing private
skills, and publishing creates or updates a `community_resources` record.

## Publishing Flow

All public content types use one publish center.

1. User clicks `Create` or `Publish` from community or a private resource page.
2. User chooses a type: Agent, Skill, MCP, Provider, Model, or Blog.
3. User fills common metadata: title, description, cover, tags, category, visibility.
4. User completes type-specific fields.
5. User previews the community card and detail page.
6. User publishes the resource.
7. The resource appears in community feeds and the creator profile.
8. Later edits create new versions or update draft metadata depending on type.

Type-specific first-pass requirements:

- Agent: publish current agent configuration, system role, model/provider reference,
  enabled skills/tools, and metadata. Other users can fork it.
- Skill: support zip upload, GitHub URL import, Skill.md/manual creation, installation,
  file tree, and version metadata.
- MCP/tool: publish manifest/config, connection method, permission notes, and install
  guidance.
- Provider: publish base URL template, headers/auth guidance, supported models, and
  compatibility notes.
- Model: publish model metadata, ability tags, pricing/context information, and related
  providers.
- Blog: publish Markdown/MDX, excerpt, cover, SEO metadata, generated table of contents,
  reading time, and public slug.

## Moderation And Permissions

First version uses lightweight moderation.

Initial status flow:

```text
draft -> published -> hidden
```

Longer-term status flow:

```text
draft -> submitted -> published/rejected
published -> hidden
published -> archived
```

Roles:

- Owner: create, edit, publish, unpublish, archive, and delete own draft resources.
- Admin: hide, restore, feature, categorize, and reject resources.
- Official publisher: create official NEXUS resources and mirrored LobeHub resources.
- Logged-in user: install, fork, favorite, like, and comment.
- Public visitor: browse published public resources and public blogs.

Default first version behavior:

- User publish defaults to `published`.
- Admin can hide resources.
- Rejection/submission queues can be added after content volume grows.

## UI Strategy

Preserve LobeHub's mature community UX. Do not rebuild the community from scratch.

Reuse and adapt:

- Existing `/community` routes and layouts.
- Existing list/detail/user profile patterns.
- Existing `MarketService` for official LobeHub market mirroring.
- Existing `agentSkillsRouter` and `AgentSkillModel` for user skill creation/import.
- Existing `SkillStore`, `UploadSkillModal`, and skill detail UI.
- Existing create/submit modal patterns as a foundation for the unified publish center.

Add:

- NEXUS community nav: Home, Agents, Skills, MCP, Providers, Models, Blogs, Creators.
- Zen Tech visual tokens for community shell and cards.
- Unified publish entry and resource-type selector.
- User creator dashboard sections for drafts, published resources, hidden resources,
  and versions.
- Blog detail rendering that uses the Fumadocs/Estival visual identity.

## Implementation Phases

### Phase 1: Branded Community Shell And Publishing Base

Deliver:

- Rebrand `/community` into NEXUS ecosystem.
- Add Zen Tech community visual system.
- Add unified community resource schema and service layer.
- Add community navigation for all target resource types.
- Add unified publish entry with common metadata.
- Keep official/mirrored LobeHub resources visible.

### Phase 2: Skill, Agent, And Blog Core Loops

Deliver:

- Skill upload/import -> publish -> install loop.
- Agent config -> publish -> fork loop.
- Blog MDX/Markdown -> publish -> Fumadocs-style public page loop.
- Creator profile showing all public resources.

### Phase 3: MCP, Provider, And Model Expansion

Deliver:

- Provider/base URL template publishing.
- Model cards with abilities, pricing/context metadata, and related providers.
- MCP/tool manifest publishing and installation guidance.

### Phase 4: Ecosystem Growth Features

Deliver:

- Moderation queue.
- Featured collections.
- Rankings and trends.
- Full search.
- Comments, reports, ratings, and creator following.
- Deeper integration with NEXUS gateway and billing.

## First Version Scope

The first implementation should include:

- Complete `/community` information architecture rewrite for NEXUS.
- Zen Tech community branding.
- Unified resource data model that supports all target types.
- Publishing shell for all target types.
- Deep functional loops for Skill, Agent, and Blog.
- Fumadocs/Estival blog detail/public pages.
- Creator profiles showing public resources.
- Lightweight moderation with admin hide.
- Official and mirrored LobeHub content as seed content.

The first implementation should not include:

- Full billing gateway migration.
- Full CLI Proxy API management UI inside LobeHub.
- Mature review queues.
- Complex ranking algorithms.
- Full comment/report moderation system.

## Risks And Mitigations

- Scope risk: supporting all types can become too broad. Mitigate by making the schema
  support all types while only deepening Skill, Agent, and Blog first.
- Data duplication risk: private workspace data and public resources can drift. Mitigate
  by treating public resources as versioned snapshots.
- UI regression risk: `/community` already has many nested routes. Mitigate by preserving
  route structure and replacing data/style layers incrementally.
- Moderation risk: default public publishing can allow low-quality content. Mitigate with
  admin hide in version one and add review queues later.
- Blog integration risk: Fumadocs and LobeHub have different rendering systems. Mitigate
  by keeping blog detail routes visually separate while linking them through the unified
  resource model.

## Open Decisions

- Final product name and logo assets.
- Exact public blog URL format: `/u/:username/blog/:slug` vs `/blog/:username/:slug`.
- Whether comments ship in phase one or later.
- Whether published Provider templates can contain encrypted secrets, or only public
  configuration templates.
- Which LobeHub official market resources should be mirrored at launch.
