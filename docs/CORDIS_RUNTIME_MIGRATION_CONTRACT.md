# LobeHub Cordis Runtime 原子契约

> 状态：Draft v1・2026-08-26\
> 目的：把 LobeHub 从 Agent 中心执行模型迁移到 Cordis Kernel + 可热插拔 Plugin 模型。\
> 本文是实现契约，不是代码实现；任何实现必须先满足本文的 Interface、生命周期、错误和验收条件。

## 0. 范围与不变量

### 目标

1. Runtime Kernel 不再把传统 Agent 当作执行根对象。
2. Agent 退化为 `agent-strategy` Plugin；Agent 配置退化为 `AgentProfile`。
3. 能力、工具、模型、会话、持久化、权限和 UI slot 都通过 Cordis Context/Fiber 装配。
4. 外部开源项目通过 Adapter 接入，不复制外部仓库源码。
5. 旧 tRPC/REST/Bot/Cron/Eval 接口在迁移期保持兼容，但内部转发到 `RuntimeFacade`。

### 非目标

- 本阶段不删除 `agents` 表，不要求一次性重写所有历史查询。
- 本阶段不允许在 Node 主进程执行任意用户 `toolCode`。
- 本阶段不复制或修改 `/home/shiro/Projects/ppt-master`。
- 本阶段不移植清舟的 AppShell、页面组件或动画状态机。

### 全局不变量

- 任何副作用必须归属于一个 Fiber，并在 `dispose()` 时按 LIFO 释放。
- 用户态服务不得写入无 scope 的 root Context。
- 插件只能通过已声明的 Interface 访问 Kernel 服务。
- 旧 Agent 执行路径和新 Cordis Run 不得同时执行同一个 operation。
- 未配置、权限不足、超时、取消、失败都必须保持真实状态，不能伪造 `completed`。

## 1. 术语与设计规则

本文使用以下术语：

- **Module**：拥有一个 Interface 和一个 Implementation 的模块。
- **Interface**：调用者必须知道的类型、前置条件、顺序、错误和性能约束。
- **Seam**：Interface 所在的可替换位置。
- **Adapter**：满足 Seam Interface 的具体实现。
- **Fiber**：一次 Plugin 挂载的生命周期和副作用所有权。
- **Depth**：小 Interface 背后承载大量行为；优先设计深 Module，避免透传型浅 Module。

## 2. 总体装配契约（C-00）

```text
HTTP / tRPC / Bot / Cron / Desktop
              │
              ▼
       RuntimeFacade (C-11)
              │
              ▼
       Cordis RuntimeHost (C-01)
              │
   ┌──────────┼──────────┐
   ▼          ▼          ▼
 Kernel     Capability   Agent Strategy
 Fibers     Plugins      Plugins
   │          │          │
   └──────────┴──────────┘
              │
       Run / Session / Event
```

启动顺序由 `inject` 拓扑决定，不允许重新引入手工的 `applyA(); applyB();` 顺序装配。

## 3. 原子 Module 契约

### C-01 RuntimeHost

**职责**：创建、启动、观察和销毁一个 Cordis root Context。

```ts
interface RuntimeHost {
  start(): Promise<RuntimeSnapshot>;
  snapshot(): RuntimeSnapshot;
  dispose(): Promise<void>;
}
```

**依赖**：`PluginManifest[]`、配置读取器、日志和时钟。\
**生命周期**：`created → starting → active → disposing → disposed`。\
**不变量**：`start()` 幂等；启动失败必须回滚已激活 Fiber；`dispose()` 幂等。\
**错误**：`PLUGIN_DEPENDENCY_MISSING`、`PLUGIN_START_FAILED`、`HOST_ALREADY_DISPOSED`。\
**验收**：可以在测试中启动完整 Kernel、替换一个 Adapter，并验证无残留 listener/tool/timer。

### C-02 Context / Fiber

**职责**：提供依赖注入、作用域、子 Fiber 和副作用回收。

```ts
interface RuntimeContext {
  readonly root: RuntimeContext;
  readonly fiber: Fiber;
  provide<T>(name: string, service: T): Disposable;
  plugin(plugin: RuntimePluginManifest, config?: unknown): Promise<Fiber>;
  withScope(scope: ScopeKey): RuntimeContext;
  on(event: string, listener: Listener): Disposable;
  dispose(): Promise<void>;
}
```

**不变量**：每个非 root Fiber 拥有稳定子 Context；跨 `await` 注册的 effect 仍归属原 Fiber；依赖缺失时为 `PENDING`。\
**安全约束**：root 只放无用户状态的共享服务；Session/User/Device 数据必须通过 scope 解析。\
**验收**：覆盖 pending activation、异步启动、替换 provider、级联卸载、重复 dispose、启动回滚。

### C-03 Plugin Manifest

```ts
interface RuntimePluginManifest {
  id: string;
  version: string;
  kind: 'kernel' | 'capability' | 'agent-strategy' | 'ui';
  inject?: string[];
  permissions?: PermissionManifest;
  apply(ctx: RuntimeContext, config?: unknown): Effect | Promise<Effect | void> | void;
}
```

**不变量**：`id + version` 唯一；依赖必须显式列出；`apply` 返回的所有副作用由 Fiber 接管。\
**禁止**：插件自行构造数据库连接、绕过 ToolRegistry、访问未授权文件或设备。

### C-04 PluginManager

```ts
interface PluginManager {
  list(query?: PluginQuery): Promise<PluginDescriptor[]>;
  mount(id: string, config?: unknown): Promise<PluginRuntimeState>;
  unmount(id: string): Promise<PluginRuntimeState>;
  reload(id: string): Promise<PluginRuntimeState>;
  getState(id: string): PluginRuntimeState | null;
}
```

**状态**：`installed | pending | active | failed | unloading | disabled`。\
**不变量**：mount/unmount/reload 幂等；旧 Fiber 不能删除新版本 provider；失败版本不可报告 active。\
**第一版支持**：内置 Plugin、MCP HTTP/stdio、受控远程 Adapter、独立 Worker。\
**延后**：任意动态 JavaScript、无权限声明的代码包。

### C-05 RunService

```ts
interface RunService {
  start(input: StartRunInput, signal?: AbortSignal): Promise<RunHandle>;
  cancel(runId: string): Promise<void>;
  resume(runId: string, input: ResumeRunInput): Promise<RunHandle>;
  get(runId: string): Promise<RunSnapshot | null>;
}
```

**状态**：`created → queued → running → waiting_* → completed|failed|cancelled`。\
**不变量**：状态迁移由单一 FSM 管理；`runId` 幂等；父子 Run 必须记录 `parentRunId`；取消必须传播到 Worker/LLM/ 工具。\
**错误**：`RUN_NOT_FOUND`、`INVALID_TRANSITION`、`RUN_ALREADY_TERMINAL`、`MAX_DEPTH_EXCEEDED`。

### C-06 AgentStrategy Plugin

```ts
interface AgentStrategyPlugin {
  id: string;
  createDriver(ctx: RunContext): RunDriver;
}

interface RunDriver {
  execute(input: StrategyInput): AsyncIterable<RunEvent>;
}
```

**迁移映射**：

| 旧对象             | 新角色                             |
| ------------------ | ---------------------------------- |
| `GeneralChatAgent` | `general-chat` strategy Plugin     |
| Group Supervisor   | `group-supervisor` strategy Plugin |
| Task Agent         | `task-agent` strategy Plugin       |
| Page Agent         | `page-agent` strategy Plugin       |
| Agent Builder      | `agent-builder` strategy Plugin    |

**不变量**：Strategy 不直接操作数据库、Redis、HTTP 或前端；只能使用 `RunContext` 暴露的 Kernel Interface。

### C-07 AgentProfile

```ts
interface AgentProfile {
  id: string;
  strategyPluginId: string;
  model?: string;
  provider?: string;
  systemPrompt?: string;
  enabledCapabilities: string[];
  metadata?: Record<string, unknown>;
}
```

`agents` 表在迁移期作为持久化来源，读取后转换为 Profile；新 Runtime 不得把数据库 Agent 行直接当作执行对象。

### C-08 ToolRegistry

```ts
interface ToolRegistry {
  register(ctx: RuntimeContext, definition: ToolDefinition): Disposable;
  list(scope?: RuntimeScope): ToolDescriptor[];
  execute(name: string, args: unknown, ctx: ToolExecutionContext): Promise<ToolResult>;
}
```

**不变量**：工具注册的 Disposable 归属调用方 Fiber；工具执行必须经过 policy、审计、超时和结果截断；工具可以绑定 UI slot，但不能直接操作 React。

### C-09 ModelGateway

**职责**：统一 LLM、Embedding、Vision、Streaming 和能力探测。\
**依赖**：现有 `@lobechat/model-runtime` Adapter。\
**不变量**：保持 provider-specific error 到统一 `RuntimeError` 的映射；API key 只由服务端 Secret/KeyVault 提供；Strategy 不保存 provider client。

### C-10 Persistence

第一版保留现有表并新增兼容投影：

```text
runtime_runs
runtime_run_events
runtime_plugin_installations
runtime_plugin_permissions
```

旧表映射：

```text
agent_operations → runtime_runs compatibility view
agents            → agent_profiles compatibility mapper
user_installed_plugins → runtime_plugin_installations adapter
```

**不变量**：事件序号单调；重放不重复副作用；PostgreSQL 是事实源，Redis 只做队列 / 短期协调。

### C-11 RuntimeFacade / Protocol

所有入口统一转为命令信封：

```ts
interface CommandEnvelope {
  protocol_version: 'runtime.v1';
  request_id: string;
  command: string;
  payload: Record<string, unknown>;
}
```

建议端点：

```text
POST /api/runtime/v1/runs
GET  /api/runtime/v1/runs/:runId
GET  /api/runtime/v1/runs/:runId/events?after_seq=123
POST /api/runtime/v1/runs/:runId/cancel
GET  /api/runtime/v1/plugins
POST /api/runtime/v1/plugins/:id/mount
POST /api/runtime/v1/plugins/:id/unmount
```

旧 `/api/agent` 和 tRPC `aiAgent.*` 只作为 Compatibility Adapter，不能再新增业务逻辑。

### C-12 EventBus / SSE

```ts
interface RuntimeEvent {
  protocol_version: 'runtime.v1';
  session_id: string;
  run_id?: string;
  seq: number;
  type: string;
  data: unknown;
}
```

**不变量**：`seq` 单调；客户端可用 `after_seq` 恢复；连接断开不取消 Run，除非明确发送 cancel；心跳和 terminal event 必须可观测。

### C-13 Policy / Permission

权限最小模型：

```ts
interface PermissionManifest {
  network?: string[];
  filesystem?: string[];
  tools?: string[];
  device?: string[];
  uiSlots?: string[];
}
```

Policy 在工具执行前决定 `allow | require_human | deny`。任何 Plugin 不能通过 prompt 或 LLM 结果绕过 Policy。

### C-14 Artifact / PresentationPort

```ts
interface PresentationPort {
  createJob(input: PresentationJobInput): Promise<PresentationJob>;
  getJob(jobId: string): Promise<PresentationJob | null>;
  cancelJob(jobId: string): Promise<PresentationJob>;
  retryJob(jobId: string): Promise<PresentationJob>;
  getArtifact(artifactId: string): Promise<ArtifactSnapshot | null>;
  exportArtifact(
    artifactId: string,
    format: 'pptx' | 'svg' | 'pdf' | 'quality-report',
  ): Promise<ExportResult>;
}
```

PPT Master Adapter 约束：

- 只调用外部 `/home/shiro/Projects/ppt-master`，不复制源码、不修改源码。
- 每个 job 独立临时目录，使用参数数组 `spawn`。
- 限制 allow-listed runner、超时、输出字节数和路径范围。
- 取消杀进程组，Fiber dispose 释放进程、timer、watcher。
- PPTX 必须是真实 OOXML ZIP，包含 `[Content_Types].xml`。
- 未配置 provider 返回 `PROVIDER_UNAVAILABLE`，不能返回假 `ready`。
- Strategist 八项确认、Image Generator、Executor 逐页生成属于后续增强，不得用 placeholder 冒充完整流程。

### C-15 Frontend Runtime Adapter

前端只依赖 `@lobechat/runtime-contracts`，不直接依赖服务端类、Python 路径或数据库模型。

```ts
interface RuntimeClient {
  startRun(input: StartRunInput): Promise<RunSnapshot>;
  subscribe(runId: string, afterSeq?: number): AsyncIterable<RuntimeEvent>;
  cancelRun(runId: string): Promise<void>;
  listPlugins(): Promise<PluginDescriptor[]>;
  mountPlugin(id: string): Promise<PluginRuntimeState>;
}
```

### C-15-L Presentation client seam

The frontend may expose a presentation seam without depending on server
classes or filesystem paths. `RuntimeClient` implementations can provide the
following request methods, backed by `/api/runtime/presentation/*` endpoints:

```ts
interface RuntimePresentationClient {
  createPresentationJob(input: PresentationJobInput): Promise<PresentationJob>;
  getPresentationJob(jobId: string): Promise<PresentationJob | null>;
  cancelPresentationJob(jobId: string): Promise<PresentationJob>;
  retryPresentationJob(jobId: string): Promise<PresentationJob>;
  getArtifact(artifactId: string): Promise<ArtifactSnapshot | null>;
  exportArtifact(artifactId: string, format: PresentationExportFormat): Promise<ExportResult>;
}
```

These methods must preserve protocol errors, support `AbortSignal`, and never
fabricate a `ready` artifact when the backend reports a provider failure.
The UI for this seam is deferred; this task only adds typed transport methods
and unit coverage.

### C-17 Runtime HTTP adapter seam

The backend exposes a framework-neutral adapter around `RuntimeFacade` before
Next.js route wiring. The adapter accepts validated `runtime.v1` command
envelopes and returns JSON-safe snapshots/events with stable error codes. It
must provide handlers for `run.start`, `run.get`, `run.cancel`, `run.resume`,
`run.events`, `plugin.list`, `plugin.mount`, and `plugin.unmount`, including
`after_seq` replay and request-id idempotency. No legacy AgentRuntime code is
deleted or bypassed in this task; route files and authentication middleware are
deferred to the next task.

### C-15-M Presentation status panel

Add a LobeHub-native `PresentationPanel` feature that renders a
`PresentationJob`/`ArtifactSnapshot` and exposes cancel, retry, and export
callbacks through props. It must show queued/running/completed/failed/cancelled
states honestly, disable unavailable actions, and remain independent of
`RuntimeClient` implementation details. Mounting into RuntimeWorkspace is
optional; no Qingzhou assets, AppShell, or animation components are allowed.

### C-18 Runtime route wiring

Wire the C-17 adapter into a Next.js runtime API route with the existing
authentication/session boundary. Route handlers must preserve `runtime.v1`
validation, stable JSON error codes, request-id idempotency, and `after_seq`
replay semantics. The route must obtain a scoped facade from an injectable
factory (no global user/session state), and this task must not delete or bypass
legacy AgentRuntime routes.

### C-15-N Multi-artifact presentation controls

Extend `PresentationPanel` so users can select among multiple ready artifacts
before exporting. The panel must keep failed/pending artifacts visible,
preserve honest disabled states, expose keyboard-accessible selection, and
remain a controlled LobeHub component with no network or Qingzhou dependency.

### C-19 Presentation HTTP routes

Expose the C-14 `PresentationPort` through authenticated Next.js routes under
`/api/runtime/presentation/*` (create/get/cancel/retry job, get artifact, and
export artifact). Use an injectable per-user/session factory, preserve
`PROVIDER_UNAVAILABLE` and other stable error codes, and never claim `ready`
without a real artifact. Keep `/api/runtime/v1` and legacy AgentRuntime routes
unchanged.

### C-15-O RuntimeWorkspace presentation slot

Expose `PresentationPanel` through an optional RuntimeWorkspace slot/prop so
the workspace can render a caller-provided job and artifacts without creating
network requests itself. Existing RuntimeWorkspace defaults and layout must
remain unchanged; this is a LobeHub-native integration only.

### C-20 Scoped runtime persistence bridge

Add a server-side factory bridge that binds a `RuntimeFacade` and
`PersistencePort` to the authenticated `{ userId, sessionId }` scope. Reads and
writes must reject cross-scope access, and the bridge must be injectable for
tests. Do not add migrations or remove legacy tables in this task.

### C-21 Legacy Agent compatibility seam

Create a framework-neutral compatibility adapter under
`src/server/runtime/compat/**` that maps legacy agent operation inputs/results
to `runtime.v1` commands and `RunSnapshot`-compatible outputs. It must be
structural and injectable (no direct `AgentRuntimeService` execution), preserve
legacy IDs/status/error fields, and provide an explicit feature-flag boundary
for later production wiring.

### C-22 Runtime SSE transport

Add SSE response wiring for `GET /api/runtime/v1/runs/:runId/events`. Replay
events after `after_seq`, emit `id:` and `data:` fields with monotonic
sequences, send periodic heartbeat comments, and close cleanly on abort. Keep
JSON error semantics for validation/auth failures and do not cancel the Run on
client disconnect.

### C-23 Scoped PresentationPort cache

Provide an injectable wrapper that caches a `PresentationPort` by authenticated
`{ userId, sessionId }` scope, reuses it across requests in the same scope, and
never shares ports between scopes. Include explicit reset/dispose hooks for
tests and shutdown; no global user state or provider execution may be added.

### C-24 Live Runtime SSE subscription

Extend the C-22 SSE seam with an injectable live event subscription when the
facade exposes one. Replayed events and newly appended events must share one
strictly increasing sequence stream; duplicate/old events are dropped, abort
unsubscribes cleanly, and the Run is never cancelled by disconnect. Keep the
replay-only fallback for facades without a subscription capability.

### C-25 Presentation cache factory integration

Provide a helper that wraps the existing `PresentationPortFactory` with the
C-23 scoped cache and is used by presentation route wiring when explicitly
configured. The wrapper must pass authenticated `{ userId, sessionId, request }`
through, reuse a port within a scope, isolate different scopes, and expose
reset/dispose for shutdown tests. No implicit global installation is allowed.

### C-15-P Frontend SSE reconnect

Harden `RuntimeStore.subscribeRun` with bounded reconnect/backoff when the SSE
stream ends unexpectedly. Resume from the highest stored sequence, stop on
AbortSignal or terminal Run state, and never duplicate events or turn a stream
failure into a completed Run. Keep the existing RuntimeClient API and UI
unchanged.

### C-26 EventJournal live bridge

Expose the kernel `EventJournal` subscription through the runtime facade's
optional live-event seam so C-24 can stream events appended after replay.
Unsubscribe must be disposable and scoped by run ID; duplicate sequence
delivery remains harmless. Existing facade commands and replay behavior must
remain unchanged.

### C-27 Presentation route cache adoption

Add an explicit route-wiring option that wraps the configured
`PresentationPortFactory` with C-25's scoped cache. The route must pass the
authenticated user/session/request scope, reuse ports within a scope, and keep
the current uncached behavior when the option is absent. No implicit globals or
provider execution are allowed.

### C-28 RuntimeFacade scoped cache

**职责**：为 RuntimeFacade 提供显式的 user/session 作用域缓存接线，保持
未配置缓存时的原有 uncached 行为。

**输入**：

- 认证边界提供的 `userId`、原始 `Request` 和不透明 `serverDB`。
- 调用方注入的 `sessionIdFor(request)`；它必须从真实认证 /session 上下文解析
  `sessionId`，不能由缓存猜测或信任固定值。
- 二选一的 `scopeCache` 或 `facadeFactory`。`scopeCache` 的 loader 接收
  `{ userId, sessionId }`，cache miss 时还可接收原始 request/session 上下文。

```ts
interface RuntimeFacadeScope {
  userId: string;
  sessionId: string;
  serverDB: unknown;
  request: Request;
}

type SessionIdFor = (request: Request) => string | undefined;
```

**输出**：

- 同一 `{ userId, sessionId }` 返回同一个 RuntimeFacade/binding；并发 cold
  load 只能创建一次。
- 不同 user 或 session 永不共享 facade、request-scoped state 或 disposer。
- 未传 `scopeCache` 时，每次请求继续调用原 `facadeFactory`，不引入隐式缓存。

**不变量**：缓存实例拥有自己的 Map 和生命周期，不使用模块级用户状态；cache
key 必须同时包含认证 `userId` 与注入的 `sessionId`；cache hit 不得用新的
request 改写旧 scope；显式同时传入 `scopeCache` 与 `facadeFactory` 必须在
route handler 创建时拒绝。

**错误语义**：缺失 / 非法 scope 返回 `RUNTIME_FACADE_CACHE_SCOPE_INVALID`；
非法 Request、facade 或 binding 分别返回对应的
`RUNTIME_FACADE_CACHE_REQUEST_INVALID`、`RUNTIME_FACADE_CACHE_INVALID_FACADE`
或 `RUNTIME_FACADE_CACHE_INVALID_BINDING`。scope 失败时不得触碰底层 factory。

**session 约定**：默认读取 `x-session-id` 只是一项开发 / 测试便利约定，不能
作为生产身份来源。生产接线必须显式注入来自认证 session 的真实
`sessionIdFor`，不能把客户端可伪造的固定 header 当作授权 scope。

**测试证据**：`src/server/runtime/facade-cache.test.ts` 与
`src/app/(backend)/api/runtime/v1/[[...path]]/route.test.ts` 覆盖同 scope
复用、不同 user/session 隔离、并发 cold load、注入 session resolver、非法
scope、冲突配置和无 cache 回归。

**禁止越界**：不引入全局用户缓存，不绕过认证，不读取或改写数据库，不执行
Runtime/provider，不修改 legacy AgentRuntime、前端或 `/qingzhou`。

**回滚点**：移除 `scopeCache` 即回到现有 uncached factory；显式
`reset/dispose` 可清空并释放缓存。发生 scope 串扰时先关闭缓存接线并回退到
逐请求 facade，不能用清空状态掩盖已发生的越权读写。

### C-29 Scoped legacy agent compat construction

**职责**：按认证 scope 惰性构造 C-21 `LegacyAgentCompatAdapter`，让旧
Agent operation 在迁移期间保持可回滚。

**输入**：

- 已认证且完整的 `{ userId, sessionId, serverDB, request }`；`serverDB` 只作为
  不透明句柄转发。
- 惰性 `legacyPortFactory({ userId, sessionId })` 与
  `RuntimeFacadeFactory({ userId, sessionId, serverDB, request })`，以及同步的
  flag 结果 / 解析注入点。
- 每个 adapter 实例绑定一个 scope；调用方不得从请求 payload 自行伪造 scope。

**输出**：返回 LegacyAgentCompatAdapter。每次 operation 只选择一侧：flag off
时物化 legacy port，flag on 时物化 RuntimeFacade 并发送 `runtime.v1` 命令；
成功物化的同侧 port 可在该 adapter 生命周期内复用，另一侧保持未触碰。

**不变量**：两个 factory 都是 lazy 且 per-scope；同一调用不会同时执行 legacy
和 Runtime 两条链；原始 Request identity 透传给 RuntimeFacadeFactory；bridge
不读取数据库、不执行 provider、不在同步 adapter 内偷偷 `await`；现有
`createLegacyAgentCompatAdapter` 与默认关闭行为保持不变。

**错误语义**：缺失、空值或伪造的 scope/factory 输入抛
`LEGACY_COMPAT_INVALID_INPUT`；工厂无法提供合法 port 或 RuntimeFacade 时抛
`LEGACY_COMPAT_RUNTIME_FAILED`；下游真实错误和旧字段必须保留，不能在另一侧
失败后静默切换或伪造成功。

**测试证据**：`src/server/runtime/compat/factory.test.ts` 覆盖 scope 校验、
lazy factory、flag off/on 互斥、Runtime request 透传、factory 失败、非法 port
和旧 adapter 行为；`adapter.test.ts` 保持既有同步兼容回归。

**禁止越界**：不直接调用 `AgentRuntimeService`，不访问数据库表，不执行模型 /
provider，不修改 legacy route、前端、`/qingzhou` 或 kernel API。

**回滚点**：关闭中央 Runtime flag 或移除 scoped construction 即回到现有
legacy adapter；任何 RuntimeFacade 初始化失败都必须停在真实错误状态，不得把
旧路径偷偷作为不透明 fallback。

### C-30 Central runtime feature flag

**职责**：把 Runtime v1 兼容开关纳入中央 FeatureFlag/RuntimeConfig，同时保留
旧环境变量作为有明确边界的兼容回退。

**输入**：

- 中央 `runtime_v1_agent_ops?: boolean | string[]`，复用现有
  `FeatureFlagValue` 与 `evaluateFeatureFlag` 语义。
- 可选 `userId`，用于用户 allowlist 和已合并的 user override。
- 兼容环境变量 `RUNTIME_V1_AGENT_OPS`；只接受既有 true 值
  `true`、`1`、`on`（大小写与空白按现有解析规则处理）。

**输出**：`isRuntimeV1AgentOpsEnabledForUser(userId)` 异步返回最终 boolean；
同步 `isRuntimeV1AgentOpsEnabled()` 继续只读同步 provider/env，不隐式等待
RuntimeConfig。未配置时最终结果为 `false`。

**不变量**：中央值优先于兼容 env/provider，包括显式 `false`；只有中央字段
缺省时才能回退 `RUNTIME_V1_AGENT_OPS`。为保留这个区分，raw
`DEFAULT_FEATURE_FLAGS` 不枚举该字段，但 state mapper 必须把缺省归一为关闭；
不能把中央默认 `false` 当作存在值后再覆盖它。

**错误语义**：中央 resolver/provider reject、返回非对象或非法 flag value 时
fail-closed 为 `false`，不得伪造开启；用户 allowlist 不命中也返回 `false`。
中央显式 `false` 永远不能被 env 打开。

**测试证据**：`src/config/featureFlags/schema.test.ts` 覆盖 schema 类型、
raw default 缺省哨兵和 state 默认关闭；`src/server/runtime/compat/
feature-flag.test.ts` 覆盖默认、env fallback、central true、用户数组、用户
override、显式 false、resolver 错误 / 非法值和同步 API 不回归；compat/schema
targeted suite 共 `59/59` 通过。

**禁止越界**：不在 `LegacyAgentCompatAdapter` 内 await，不修改 router、数据库、
前端、`/qingzhou`、ppt-master 或旧执行逻辑；flag 只决定已注入的两条 seam
之一，不负责创建 provider。

**回滚点**：保持 flag 默认关闭；删除 / 清空中央配置或关闭 rollout 可回到
legacy-agent。若中央配置不可用，关闭 Runtime 分支而不是使用 env 强行开启；
中央显式 false 的安全语义不得回滚成 env 覆盖。

### C-31 Safe PPT Runner

**职责**：提供可注入的安全 `PresentationRunner` process seam，供 C-14
`PptMasterAdapter` 在未来配置真实 provider 时使用；本条不等于已经接入
生产 PPT provider。

**输入**：

- `PresentationRunnerRequest`：`jobId`、provider、job 临时工作目录、参数数组
  `args`、`timeoutMs`、`maxOutputBytes` 和字面量 `shell: false`。
- 显式 provider command/commandArgs、runner id 与 allow-list；可注入 launcher
  和 filesystem port。输入 artifact 必须写入该 job workspace 内的相对路径。

**输出**：`spawn()` 返回可取消 process handle；成功时只返回真实 exit code、
stdout/stderr 和工作目录内实际读取的 artifact bytes。非零退出、启动失败、
超时、取消或预算超限都不得被转换成 completed/ready。

**不变量**：只能通过参数数组调用，永远 `shell: false`，禁止 shell 拼接；runner
必须在 allow-list 中；每 job 使用独立临时目录；输出和 artifact 共用字节预算；
路径不能逃逸 workspace；取消必须幂等并杀死 detached process group；timeout、
stdout/stderr/artifact 上限必须终止并回报真实失败。C-14 负责验证 PPTX 为真实
OOXML ZIP 且包含 `[Content_Types].xml`。

**错误语义**：未配置 command/provider 返回 `PROVIDER_UNAVAILABLE`；启动 / 非零
退出保留 `PPT_MASTER_FAILED` 与 cause/exit facts；请求非法返回
`PRESENTATION_INVALID`；超时、输出超限、路径逃逸分别返回
`PRESENTATION_TIMEOUT`、`PRESENTATION_OUTPUT_LIMIT`、
`PRESENTATION_PATH_OUT_OF_SCOPE`；runner 未 allow-list 或 PPTX 验证失败分别
保留 `PRESENTATION_RUNNER_NOT_ALLOWED`、`PPTX_INVALID`。错误状态不能伪造
artifact ready。

**测试证据**：`src/server/runtime/presentation/runner.test.ts` 的 11 个测试使用
memory launcher/fs，覆盖 argv 与 `shell:false`、provider 缺省、真实输出 / 非零
退出、启动失败、取消幂等、workspace 越界、输出预算、artifact 收集与 timeout；
`packages/cordis-kernel/src/presentation.test.ts` 覆盖 PPTX ZIP/
`[Content_Types].xml` 验证。测试不执行真实 ppt-master。

**禁止越界**：不修改或复制 `/home/shiro/Projects/ppt-master`，不硬编码生产
命令，不接数据库 / HTTP/Redis/AgentRuntime，不执行未经 allow-list 的动态代码，
不把 mock/placeholder 当作真实 artifact。

**回滚点**：未配置真实 command/provider 时保持 `PROVIDER_UNAVAILABLE`；生产接线
异常时移除 runner/provider 注入并保留 C-14 的诚实失败，不能降级成假 ready 或
绕过 process group cleanup。

## 4. 清舟素材与 LobeHub UI 契约（C-16）

### 允许复用

- 清舟的视觉素材、图形资产、色彩参考、插画和 “旋转摩天轮” 等装饰性资产。
- 清舟的视觉组件可以作为设计参考；如需交互化，必须在 LobeHub 内重新实现为本项目 Module。
- 资产经过尺寸、版权、压缩和主题适配后进入 LobeHub asset pipeline。
- 素材必须作为装饰层或空态视觉，不得承载 Runtime 状态语义。

### 禁止复用

- 不复制清舟的 AppShell、路由、页面组件、状态管理或不成熟动画组件。
- 不引入清舟自己的布局状态机替代 LobeHub 路由和 store。
- 不让清舟动画直接决定 Run、Plugin、Artifact 的状态。

### LobeHub 实现规则

- 组件继续使用 `@lobehub/ui`、antd 和 LobeHub 自有 feature 组件。
- 样式优先 `createStaticStyles` + `cssVar.*`；只有确需运行时 token 才使用 `createStyles`。
- 动画使用 LobeHub 自己的 motion/token 体系；旋转摩天轮只作为可替换视觉层。
- 旋转摩天轮等视觉元素允许重新封装成 LobeHub React Module，但其状态、计时器、动画和卸载逻辑必须由 LobeHub 实现并测试。
- 所有装饰动画必须支持 reduced-motion、暂停和卸载时清理。
- `/qingzhou` 既有页面保持不变；新 Runtime Workspace 使用 LobeHub AppShell。

推荐结构：

```text
RuntimeWorkspace (LobeHub)
  ├─ RuntimeHeader
  ├─ SessionSidebar
  ├─ ConversationPane
  ├─ PluginSlotHost
  └─ DecorativeLayer
       └─ QingzhouFerrisWheelAsset (asset only)
```

## 5. 迁移阶段与回滚

### 状态口径

- **内核接口完成**：Interface、可注入 / 纯内存实现和 targeted contract tests
  已具备；不表示已替换线上 `AgentRuntimeService`。
- **生产接线完成**：真实认证 `sessionIdFor`、生产 factory、持久化、provider
  生命周期、监控和 shutdown 已接入并验收；当前仍未完成。
- **E2E 完成**：真实 HTTP/session/provider/ 浏览器路径及并发、断线、失败回滚
  均通过；当前仍未完成。

### M0：契约冻结

- 发布 `@lobechat/runtime-contracts`。
- 建立 C-01～C-31 的 contract tests 和本文的输入 / 错误 / 回滚约束。
- 不改变线上执行路径。
- 本阶段的 “完成” 只表示契约与隔离测试完成，生产接线和 E2E 另行验收。

### M1：Kernel 外壳

- 引入 Context/Fiber/PluginManager。
- 将当前 `AgentRuntimeService` 包装为 `legacy-agent` Plugin。
- Feature flag 控制旧路径和 Cordis 路径。
- C-01～C-14 的 Kernel 接口与纯内存实现可先完成；Runtime 替换、真实
  AgentRuntime 装配和线上切流尚未完成。

### M2：策略插件化

- 将 `GeneralChatAgent`、Group、Task、Page Agent 迁移为 strategy Plugins。
- `AiAgentService` 改为 `RuntimeFacade` 的 Compatibility Adapter。

### M3：能力插件化

- builtin tools、MCP、Skill、Klavis、device、RAG 进入 PluginManager。
- 所有工具调用统一走 ToolRegistry + Policy。

### M4：持久化与隔离

- 新增 `runtime_runs` 和事件表。
- 完成 user/session scope、事件重放、epoch reload。
- 旧 `agent_operations` 变为兼容投影。
- C-20/C-28/C-29 的 scope seam 测试完成不等于 PostgreSQL、真实认证 session
  和多租户生产隔离已完成；这些仍需生产接线与 E2E 验证。

### M5：外部项目接入

- 首个外部能力为 PPT Master PresentationPort。
- 后续项目必须复用 C-14，不允许为每个项目创建专用 Agent 执行链。
- C-31 的安全 runner 只完成可注入 launcher/fs seam 和 mock 测试；真实
  provider command、worker/process supervision 和生产 artifact E2E 尚未完成。

### M6：前端 Runtime Workspace

- Chat、Session、Plugin、Artifact 全部接入 RuntimeClient。
- 新增 Plugin Marketplace、SlotHost 和 Presentation Studio。
- 清舟素材只进入 DecorativeLayer。

### M7：生产接线与 E2E 验收（未完成）

- 将 C-28/C-29/C-30 接入真实认证 user/session、生产 factory 和明确的 rollout
  配置；生产必须注入真实 `sessionIdFor`，不能使用 `x-session-id` 默认约定。
- 将 C-31 接入 allow-listed 的真实 provider，并验证进程组取消、超时、输出
  限制、真实 PPTX/SVG artifact 和 shutdown 清理。
- 完成跨用户 / 跨 session 并发、HTTP/SSE 断线恢复、旧路径回滚、浏览器 UI 和
  真实 provider 的 E2E；在此之前不能宣称迁移完成。

### 回滚规则

- 任一阶段发生数据不一致、用户 scope 串扰、Run 状态丢失或错误语义变化，关闭 feature flag 即回到 `legacy-agent` Plugin。
- 不能通过回滚隐藏 provider 失败或伪造 artifact 成功。

## 6. 两位 Agent 的原子分工

### 后端 Agent

负责：

- C-01～C-14 的 Implementation 和 contract tests。
- `packages/cordis-kernel/**`、`packages/runtime-contracts/**`。
- `src/server/runtime/**`、Runtime API、数据库 migration。
- legacy Compatibility Adapter、General Chat strategy Plugin。
- PluginManager、Policy、scope、Run FSM、SSE、PPT Master Adapter。

不得修改：

- 清舟页面视觉实现。
- `/home/shiro/Projects/ppt-master`。
- 前端 store 和组件实现。

### 前端 Agent

负责：

- C-15、C-16 的 Implementation 和组件测试。
- `src/services/runtime/**`、`src/store/runtime/**`。
- Runtime Workspace、Plugin Marketplace、PluginSlotHost、Presentation Studio。
- SSE 重连、Run 状态展示、真实错误展示、SVG/PPTX 下载。
- LobeHub 自有组件、token、motion 和 responsive 验收。

不得修改：

- Runtime Kernel、数据库 schema、PPT worker。
- 清舟既有 `/qingzhou` 行为和组件。

### 共同交接格式

每次交接必须包含：

```text
status
files
contracts_changed
tests
evidence
risks
next
```

跨边界变更先更新本文的 “契约变更记录”，再修改实现。

## 7. 最低验收矩阵与当前完成状态

> “内核 / 契约接口” 列的已完成只代表接口、可注入实现和隔离测试；生产
> factory、真实认证 /session、真实 provider 和 E2E 当前均未完成，不能将两者
> 合并为一个完成状态。

| 类别             | 内核 / 契约接口（当前）                                                                                    | 生产接线（当前）                                                                                                    | E2E / 必须证明                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Kernel           | **已完成**：C-01～C-14 的生命周期、依赖、FSM、策略、工具、模型、权限和 Presentation seam 有 targeted tests | **未完成**：尚未以新 Runtime 替换线上 AgentRuntimeService，未完成生产 shutdown / 观测                               | **未完成**：PENDING/ACTIVE/DISPOSED、回滚、幂等 dispose、provider 替换需真实路径复验        |
| Scope            | **已完成**：C-20/C-28/C-29/C-30 的纯内存 / 注入 scope、缓存、兼容和 flag tests                             | **未完成**：生产 factory 必须绑定真实认证 `{ userId, sessionId }`，注入真实 `sessionIdFor`；不能依赖 `x-session-id` | **未完成**：多用户并发不能读取彼此 Session、Tool、Device 或 Plugin 状态                     |
| Run/Event        | **已完成**：Run FSM、父子关系、seq、journal replay/live seam 有测试                                        | **未完成**：持久化、worker、队列和生产事件生命周期未完成接线                                                        | **未完成**：状态机、取消、恢复、重试、父子 Run、事件重放和断线恢复                          |
| Plugin/Policy    | **已完成**：mount/unmount/reload、工具注册和权限拒绝 seam 有测试                                           | **未完成**：生产插件装配 / 市场、真实 capability provider 和审计未完成                                              | **未完成**：无残留卸载、权限拒绝可观测、跨 scope 隔离                                       |
| Compatibility    | **已完成**：C-21/C-29/C-30 的映射、同步 API、异步 flag 和真实错误语义有测试                                | **未完成**：legacy route 的生产选路、真实中央 RuntimeConfig 和 rollout 未完成                                       | **未完成**：旧 `aiAgent.*` 与新 Runtime 结果语义一致且可关闭回滚                            |
| PPT/Presentation | **已完成**：C-14/C-31 的注入 runner、argv、限制、取消 / 超时和 PPTX 校验有 mock tests                      | **未完成**：真实 allow-listed provider command、worker/process supervision 和 artifact 存储未完成                   | **未完成**：未配置诚实失败、真实 PPTX ZIP、SVG preview、取消 / 重试和真实导出               |
| HTTP/SSE         | **已完成**：C-17/C-18/C-22/C-24/C-26 的 adapter、route、replay/live seam 有测试                            | **未完成**：部署级认证 /session、限流、观测和真实运行时负载未完成                                                   | **未完成**：JSON 错误、request id、after_seq、断线不取消 Run 的真实 E2E                     |
| Frontend/UI      | **已完成**：RuntimeClient/UI seam 的契约测试按各自任务维护                                                 | **未完成**：全量页面接入、真实 Runtime 数据和生产错误展示未完成                                                     | **未完成**：断线恢复、真实失败、空态、生成中态、1440×900、390×844；清舟素材不得承载业务状态 |

## 8. 契约变更记录

| 日期       | 变更                                                                                                                 | 影响                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 2026-08-26 | 初版原子契约；明确 Agent strategy Plugin、PPT PresentationPort、清舟素材 / UI 分离                                   | 后端 / 前端按 C-01～C-16 拆分                                             |
| 2026-08-26 | 增加 C-15-L Presentation client seam，仅定义前端传输方法，不引入清舟素材或 Presentation Studio UI                    | 前端 RuntimeClient 增加 Presentation 请求契约                             |
| 2026-08-26 | 增加 C-17 Runtime HTTP adapter seam，先冻结框架无关的 RuntimeFacade 请求 / 错误映射，再接 Next.js 路由               | 后端新增可测试 API seam；路由与鉴权后置                                   |
| 2026-08-27 | 增加 C-15-M Presentation 状态面板与 C-18 Runtime 路由接线契约；清舟素材继续冻结                                      | 前端原生面板与后端 Next 路由各自独立交付                                  |
| 2026-08-27 | 增加 C-15-N 多工件选择与 C-19 Presentation HTTP routes 契约                                                          | 前端增强导出选择；后端接入 C-14 PresentationPort                          |
| 2026-08-27 | 增加 C-15-O RuntimeWorkspace 可选 Presentation 插槽与 C-20 作用域持久化桥接契约                                      | 前端保持默认布局；后端先完成 scope 隔离 seam                              |
| 2026-08-27 | 增加 C-21 Legacy Agent compatibility seam，交由 opencode 独立实现                                                    | codex 与 opencode 后端任务各占一半，旧路径保持可回滚                      |
| 2026-08-27 | 增加 C-22 Runtime SSE transport 与 C-23 Scoped PresentationPort cache，继续按 codex/opencode 1:1 分工                | 完成事件流传输与 Presentation 任务跨请求状态保持                          |
| 2026-08-27 | 增加 C-24 Live Runtime SSE subscription 与 C-25 Presentation cache factory integration                               | 补齐实时事件与作用域缓存的生产接线                                        |
| 2026-08-27 | 增加 C-15-P 前端 SSE 断线重连契约，交由 agy 实现                                                                     | 前端在实时流中断时自动续传且保持幂等                                      |
| 2026-08-27 | 增加 C-26 EventJournal live bridge 与 C-27 Presentation route cache adoption                                         | 将实时事件与作用域缓存接入实际运行路径                                    |
| 2026-08-27 | 增加 C-29 Scoped legacy agent compat construction                                                                    | 旧 Agent 兼容层按认证作用域惰性构造，旧路径零改动                         |
| 2026-08-28 | 收口 C-28 RuntimeFacade scoped cache；明确 user/session key、注入 sessionIdFor、uncached 回退与 scope 隔离           | 接口与隔离测试完成；生产 factory、真实认证 session 和 E2E 未完成          |
| 2026-08-28 | 收口 C-30 central runtime_v1_agent_ops 与 C-31 safe PPT Runner；冻结 central 优先级、argv/shell:false 和真实失败语义 | 接口与 targeted tests 完成；真实 flag rollout、provider 接线和 E2E 未完成 |
| 2026-08-28 | C-32 文档收口：将内核 / 契约接口完成与生产接线、E2E 状态分列                                                         | 后续验收必须分别证明真实认证、factory、provider、持久化和浏览器路径       |
