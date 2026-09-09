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

### C-34 Production RuntimeFacade bootstrap

**职责**：提供显式、可审计的生产装配入口，将真实认证 scope resolver 与
RuntimeFacadeFactory（以及可选 PersistencePort / PresentationPort factory）
接到既有 `getRuntimeFacadeFactory` seam；bootstrap 本身不执行 provider、不保存
用户缓存，也不改变路由模块的默认加载顺序。

**输入**：`scopeResolver(request, authenticated)` 必须返回完整的
`{ userId, sessionId, serverDB, request }`；`facadeFactory` 必须显式注入。可选
端口 factory 按同一 scope 惰性解析。session 只能来自 resolver，客户端
`x-session-id` 不得作为生产身份来源。

**输出**：返回 request-scoped `RuntimeFacadeFactory`、不可变 audit snapshot 与
幂等 `reset()`；同一 bootstrap 不共享 user/session 状态，route scope 的
Request identity 原样透传。`reset()` 后 getter 恢复既有
`RUNTIME_FACADE_UNAVAILABLE` 默认行为。

**不变量与错误**：缺依赖、非法配置、scope 缺失/伪造分别返回稳定的
`RUNTIME_PRODUCTION_DEPENDENCY_MISSING`、`RUNTIME_PRODUCTION_OPTIONS_INVALID`、
`RUNTIME_PRODUCTION_SCOPE_INVALID`；userId 必须与认证边界一致，sessionId 非空，
Request identity 不可替换；factory 失败保留真实 cause，不得降级或伪造成功。

**测试证据**：`production-bootstrap.test.ts` 11 项通过；runtime 全套在该轮
为 186/186。全仓 type-check 仍受既有 app/runtime/presentation 类型错误及
Node heap OOM 影响，不能作为本条完成证据。

**回滚点**：不调用 bootstrap 或显式执行 reset 即回到未配置的
`RUNTIME_FACADE_UNAVAILABLE`；发生 scope 串扰时先移除 production factory，
不得用清空内存状态掩盖已发生的越权访问。

### C-35 Legacy aiAgent route selection seam

**职责**：在请求边界依据“已解析”的中央 `runtime_v1_agent_ops` 结果，冻结本次
请求选择 `legacy` 或 `runtime.v1` 单一路径，为旧 aiAgent 路由提供可回滚 seam。

**输入**：完整认证 scope `{ userId, sessionId, serverDB, request }`、惰性
`legacyFactory` 与 `runtimeFactory`、同步 `resolveFlag`。异步中央配置和用户
allow-list 必须在调用 `select()` 前解析；selector 不得在同步边界偷偷 await。

**输出与不变量**：`select()` 同步返回 `{ route, scope, adapter }`；flag off
只允许 legacy factory 物化，flag on 只允许 RuntimeFacade 物化，未选侧永不执行。
每个 selection 独立 memoize，scope 按对象 identity 透传；一次 selection 的决定
不会被中途 flag 变化改写，回滚只影响下一次请求。

**错误与测试**：非法 scope/factory 使用 `LEGACY_COMPAT_INVALID_INPUT`，非法
factory 输出使用 `LEGACY_COMPAT_RUNTIME_FAILED`，下游 coded error 原样透传；
`compat/route.test.ts` 12 项、compat 套件 51 项、runtime 套件 175 项通过。当前
仍有 12 个 compat 类型检查告警待机械修复，不影响上述行为测试。

**回滚点**：中央 flag 关闭或移除 selector 即严格回到 legacy；Runtime 初始化或
执行失败不得静默切换 legacy、伪造完成或吞掉错误。

### C-36 RuntimeWorkspace final acceptance guardrails

**职责**：为前端 RuntimeWorkspace 提供轻量、确定性的最终验收护栏，不引入新的
网络层或清舟 UI。

**输入/输出**：在 1440×900 与 390×844 视口下渲染既有 LobeHub AppShell；可选
presentation 与 plugin slot 由调用方注入，未注入时保持原布局；SSE 断流显示非致命
告警并在卸载时 abort，不伪造 Run 完成；DecorativeLayer 仅承载静态视觉。

**不变量**：继续使用 `@lobehub/ui`、antd 与现有 styles/motion；slot 崩溃由边界
隔离，artifact 只有 ready 状态可导出，a11y landmarks/键盘交互保持可用；禁止
fetch/EventSource、清舟组件或状态机参与 Runtime 语义。

**测试证据**：`acceptance.test.tsx` 新增 10 项；与 presentation、a11y、SSE、slot、
responsive 等共 15 个前端套件 131/131 通过；使用 DOM/CSS contract tests 代替
浏览器驱动，不代表真实浏览器 E2E 已完成。

**回滚点**：移除 acceptance harness 与 Icon 类型整理即可回到既有 UI；清舟素材
继续冻结，任何装饰层异常不得影响 Run/Plugin/Artifact 状态。

### C-37 Runtime production type-safety guard

**职责**：修正 C-34 生产 bootstrap 直接依赖的严格 TypeScript 边界，确保
`sessionIdFor(Request): string | undefined` 在进入 scoped presentation cache 前
经过显式非空校验。

**不变量与错误**：缺失或空 sessionId 返回
`PRESENTATION_CACHE_SCOPE_INVALID`（path=sessionId），不得把 undefined 传入
Persistence/Presentation scope；正常 scope 行为保持不变。

**测试证据**：bootstrap 与 presentation factory targeted 套件 22/22 通过，最小
strict source tsc 与 Prettier 通过；未运行全仓 type-check。

**回滚点**：移除该守卫即恢复旧实现，但生产接线不得绕过 session scope 校验。

### C-38 Compat type-safety guard

**职责**：清理 C-35 compat selector/factory 的机械类型错误，不改变路由选择、flag、
lazy factory 或错误透传语义。

**不变量**：`facadePortFrom` 在 route/factory 两处使用相同结构守卫；测试 fixture
显式标注 scope 与 legacy view，任何类型修复不得引入 AgentRuntimeService 或双执行。

**测试证据**：compat 5 个套件 51/51 通过；带真实 path aliases 的最小 strict tsc
0 errors；Prettier clean。全仓剩余类型债务仍需按归属处理。

**回滚点**：回退 guard/fixture 注解不会改变运行时路径，但不得恢复不安全 cast 后
再宣称类型门禁通过。

### C-39 RuntimeWorkspace scope and type audit

**职责**：审计 C-36 前端改动的范围与类型，确保 RuntimeWorkspace 组件继续使用
LobeHub UI 契约，移除无关 store 变更并修正 StartRunInput/图标类型。

**不变量**：只允许修改 RuntimeWorkspace/route 目录；RunComposer 必须提交契约要求
的字符串字段，Icon 使用 `@lobehub/ui` 支持的数值 size；不引入网络、清舟或后端
依赖。若 Herdr 工具在报告阶段失败，必须如实标记未回传，不把失败当作 E2E 通过。

**测试证据**：独立复验 RuntimeWorkspace、route、store、client 相关套件通过（核心
acceptance 10/10，组合复验 48/48）；真实浏览器 E2E 仍未完成。

**回滚点**：恢复 C-36 之前的 UI 文件即可回滚；store selector 的可选链改动若无
必要性应单独撤回，不能借审计混入其它状态逻辑。

### C-40 PPT Master production command seam

**职责**：把 `/home/shiro/Projects/ppt-master` 接成一个显式、可注入的
Presentation provider，不在 LobeHub 复制其源码，也不把其自身 UI/流程状态机带入
LobeHub。

**输入**：`provider`、`runnerId`、绝对命令路径或固定 argv、静态 `commandArgs`、
每个 job 的 workspace，以及 `create` / `export` 的结构化参数。命令构造只能返回
字符串数组；执行仍由 C-31 Runner 使用 `shell: false` 完成。

**输出**：稳定的 create/export argv 规范。create 命令接缝必须只产出 job workspace
内的受控 `input.json` 路径（标题、资料来源、页数、模板、语言、比例和 prompt 由
后续 adapter/runner 在 spawn 前写入）；export 必须只使用受控 `input.pptx` 路径并
约定输出目录 / 文件名。未配置命令、路径或 allow-list 时返回真实
`PROVIDER_UNAVAILABLE` / `PRESENTATION_RUNNER_NOT_ALLOWED`。

**禁止**：拼接 shell 字符串、从用户 payload 直接执行任意路径、修改
`/home/shiro/Projects/ppt-master`、复制其 Python/前端代码、用 mock/placeholder
冒充真实 PPTX。该契约只冻结 provider seam；真实 LLM/image provider、队列和持久化
仍需单独验收。

**测试证据**：覆盖 create/export argv 稳定性、静态参数与 job workspace 隔离、缺失
配置和 allow-list 拒绝；测试不得启动真实 ppt-master。

### C-41 Presentation capability plugin

PPT 不是新的 Agent 类型，而是 Cordis capability plugin，建议插件 id
`presentation.ppt-master`，声明以下 capability：

```text
presentation.create
presentation.inspect
presentation.edit
presentation.preview
presentation.export
presentation.retry
presentation.cancel
```

Agent strategy 只做意图识别和步骤编排，不能直接读写 PPTX。它把用户请求转换成
`PresentationOperation`：

```ts
type PresentationOperation = 'create' | 'edit' | 'preview' | 'export';
```

随后调用 `PresentationPort` 创建 / 查询 Job；Job 事件由 Runtime EventJournal/SSE
发布，前端只消费 Runtime contract。插件可热挂载、卸载，卸载必须取消其活动 Job
并释放 Runner/worker 资源。

### C-42 Presentation project and version contract

创建与编辑统一使用 Job，但编辑不得覆盖旧 artifact。持久化模型至少保留：

```text
PresentationProject
├── sourceVersion
├── designSpecVersion
├── slideVersions[]
├── artifactVersions[]
└── currentVersion
```

第一阶段编辑范围只承诺“内容编辑”和“整页重生成”：标题、正文、备注、图片说明
或整页自然语言修改会生成新 version。局部元素选择、颜色/字号/位置编辑属于第二
阶段，必须携带 `slideId + elementId + annotation`，生成新 artifact 后才能切换
`currentVersion`。旧版本可比较、导出和回滚；任何版本都必须保留真实失败状态。

### C-43 PresentationStudio frontend boundary

PPT 前端作为独立 feature，不塞进普通 Chat 组件。目录固定为：

```text
src/features/PresentationStudio/
├── index.tsx
├── PresentationStudio.tsx
├── PresentationComposer/
├── PresentationJobList/
├── PresentationProgress/
├── SlideNavigator/
├── SlidePreview/
├── SlideInspector/
├── AnnotationBar/
├── ArtifactPanel/
├── ExportMenu/
├── hooks/
├── store/
└── style.ts
```

路由只保留薄壳，推荐 `/presentation`；内部通过 `RuntimeClient` 的
`RuntimePresentationClient` 调用 `/api/runtime/presentation/*`。`PresentationStudio`
使用既有 LobeHub AppShell、`@lobehub/ui`、antd 和 style/motion token，不直接依赖
服务端类、Python 路径或数据库模型。

### C-44 PresentationStudio phase-1 acceptance

第一阶段只上线以下闭环：

```text
创建表单 → Job 进度 → SVG/缩略图预览 → 真实 PPTX 导出
```

必须提供：创建 / 取消 / 重试、queued/running/completed/failed/cancelled 真实状态、
多 artifact 选择、失败可见但不可导出、断线后按 `after_seq` 恢复。`SlideInspector`
与 `AnnotationBar` 第一阶段可只读或隐藏，不得做假编辑。

### C-45 PresentationStudio phase-2 editing acceptance

第二阶段再开放：选择 slide/element、自然语言 annotation、内容字段编辑、局部重生成、
版本比较和回滚。每次编辑都是新的 `edit` Job；前端显示旧/新 artifact 对比，只有
后端确认 `ready` 才允许导出。清舟素材若未来加入，只能挂在独立
`DecorativeLayer`，不能承载 Job、Run、Plugin 或 Artifact 状态。

### C-46 Agent-to-Presentation capability seam

**职责**：提供 Agent strategy 到 `PresentationPort` 的最小、可注入适配器。Agent
只负责从用户语言中识别意图和补齐参数；适配器负责把已验证的操作路由到
PresentationPort，不直接启动 provider。

```ts
type PresentationOperation =
  | 'create'
  | 'inspect'
  | 'edit'
  | 'preview'
  | 'export'
  | 'retry'
  | 'cancel';

interface PresentationCapabilityCommand {
  operation: PresentationOperation;
  jobId?: string;
  artifactId?: string;
  format?: PresentationExportFormat;
  input?: PresentationJobInput;
  metadata?: {
    parentVersionId?: string;
    slideId?: string;
    elementId?: string;
    annotation?: string;
  };
}

interface PresentationCapabilityResult {
  operation: PresentationOperation;
  job?: PresentationJob | null;
  artifact?: ArtifactSnapshot | null;
  export?: ExportResult;
}
```

`create` 调用 `createJob`；`cancel` 调用 `cancelJob`；`retry` 调用 `retryJob`；`export` 调用
`exportArtifact`；`inspect` / `preview` 至少调用 `getJob` / `getArtifact`。`edit`
在第一阶段统一转成带 `metadata.parentVersionId` / annotation 的新 `createJob`
命令，适配器将这些编辑元数据保留在新 Job 的 `input.options.presentationMetadata`
中，绝不覆盖旧 artifact。适配器接收已解析的 `{ userId, sessionId }` scope 和一个
可注入 authorizer；未声明的 operation、缺少 id/input、能力未授权或下游真实错误
必须返回稳定错误，不能在另一条路径静默 fallback。每个 operation 只允许调用对应
的 `PresentationPort` 方法，不得并行触发其它方法。

此 seam 只冻结 capability 路由和错误语义；LLM Strategist、SVG Executor、图像
provider、项目持久化和队列由后续 worker/production 接线契约负责。

### C-47 Universal external-project plugin pattern

以后接入任何开源项目，都必须按以下五个深模块拆分，不为外部项目再造一种
`Agent`：

```text
Cordis Plugin Manifest
        │  id/version/inject/permissions/capabilities
        ▼
Capability Port（小而深的领域接口）
        │
        ├── In-memory Adapter（测试）
        ├── Process/HTTP/MCP Adapter（生产）
        └── Worker Adapter（长任务/隔离进程）
        │
        ▼
Agent Strategy（意图识别 + 编排，不碰外部项目）
        │
        ▼
Runtime Event/Artifact/Policy
        │
        ▼
Feature UI + optional UI Slot（只消费 runtime-contracts）
```

**1. Manifest**

```ts
interface ExternalCapabilityManifest {
  id: string;
  version: string;
  capabilities: readonly string[];
  inject?: readonly string[];
  permissions?: PermissionManifest;
  source: 'builtin' | 'process' | 'http' | 'mcp' | 'worker';
}
```

Manifest 只描述依赖、权限和能力，不携带用户状态或 provider client。`id + version`
是唯一身份，挂载/卸载/reload 由 PluginManager 和 Fiber 负责。

**2. Capability Port**

每个领域设计一个小而深的 Port；Port 是外部项目与 Kernel 的唯一 seam。通用
约束是：输入为已验证的结构化 command，输出为真实 result 或 stable error；长任务
必须返回可观察的 operation/job id；需要流式进度时复用 EventJournal/SSE；需要文件
时复用 ArtifactPort。不要把外部项目的几十个脚本函数原样透传成浅接口。

`CapabilityRegistry.unregister()` 必须返回可等待结果；调用方在插件卸载或替换时必须
等待旧 Adapter 的异步 disposer 完成后，才能认为 capability 已移除。

**3. Adapter**

测试使用 in-memory adapter，生产使用 process/HTTP/MCP/worker adapter。Adapter
负责参数转换、超时、取消、输出预算、路径和凭据隔离；它不得修改外部仓库，不得
让用户 payload 决定任意命令路径。两个 Adapter 都必须通过同一个 Port 测试，证明
seam 真实存在。

**4. Agent Strategy**

Strategy 只把自然语言转成 capability command，并检查 AgentProfile 的
`enabledCapabilities` 与 Policy；它不能直接 import 外部项目、读取数据库或启动
进程。一次请求只能选择一条 capability 路径，失败必须保留原始错误，不能静默切换
到另一个项目或旧 Agent。

**5. Feature UI**

完整交互放在 `src/features/<CapabilityStudio>/`，路由是薄壳；通用状态、事件、
artifact、下载和错误只来自 `@lobechat/runtime-contracts`。可复用的进度/工件控件
可以进入 `RuntimeWorkspace` optional slot，但外部项目自己的 AppShell、状态机和
动画不得进入 LobeHub。

**当前实现状态（C-47）**：已提供 `CapabilityPort` 与 `CapabilityRegistry` 的最小
Kernel 接口和 runtime-contracts 类型投影。注册、卸载、替换、结构化 command 校验、
descriptor id 一致性、可等待 Fiber disposer 及错误透传已有 in-memory targeted tests；外部项目的 process/HTTP/MCP/worker
adapter、真实 provider 和用户级持久化仍未接线。

**标准目录**：

```text
packages/cordis-kernel/src/       # Fiber/PluginManager/Policy/Journal/Port types
packages/runtime-contracts/src/  # wire-safe command/result/event/artifact types
src/server/runtime/plugins/<id>/  # manifest + strategy + production adapter
src/server/runtime/<domain>/      # domain Port and handler
src/features/<CapabilityStudio>/  # LobeHub-native UI
src/routes/(main)/<capability>/   # thin route shell
```

**新项目接入清单**：先冻结 Port 和错误/取消/权限契约 → 写 in-memory adapter 与
targeted tests → 写生产 Adapter → 注册 Manifest → 接 Agent Strategy → 接 Runtime
Facade/API/SSE → 接 Feature UI/slot → 做真实 provider、跨 scope、断线和卸载 E2E。
任何一步都不能用 placeholder 结果替代下一步的真实证据。

**统一回滚点**：卸载插件或关闭 capability feature flag，即回到其它已注册能力；
不得删除旧数据，不得用清空内存状态掩盖 provider 失败或 scope 串扰。

### C-48 Presentation project/version persistence seam

**职责**：为 PPT 创建、编辑、比较和回滚提供不可变项目/版本接口；本条只冻结
Port 与 in-memory adapter，不引入数据库 migration，也不把内存状态当作生产事实源。

```ts
interface PresentationProjectStore {
  create(scope: RuntimeScope, input: PresentationProjectInput): Promise<PresentationProject>;
  get(scope: RuntimeScope, projectId: string): Promise<PresentationProject | null>;
  appendVersion(
    scope: RuntimeScope,
    projectId: string,
    version: PresentationVersionInput,
  ): Promise<PresentationProject>;
  selectVersion(
    scope: RuntimeScope,
    projectId: string,
    versionId: string,
  ): Promise<PresentationProject>;
}
```

每个项目至少保存 `sourceVersion`、`designSpecVersion`、`slideVersions[]`、
`artifactVersions[]`、`currentVersion`。`appendVersion` 只能追加新版本，不能覆盖旧
artifact；`selectVersion` 只能切换 current 指针。所有读写必须同时校验
`{ userId, sessionId }`，跨 scope 访问返回稳定错误。内存适配器和未来 PostgreSQL
适配器必须通过同一 Port 测试；真实数据库接线另行验收。

### C-49 Presentation artifact persistence seam

**职责**：把 PPTX/SVG/PDF/质量报告的二进制和元数据从短生命周期 Runner 中托管出来，
让 Job、Project 和 HTTP 下载可以跨请求读取。第一步只实现 Port 与 in-memory
adapter；生产对象存储或 PostgreSQL/文件存储另行接线。

```ts
interface PresentationArtifactStore {
  put(scope: RuntimeScope, artifact: ArtifactInput): Promise<ArtifactSnapshot>;
  get(scope: RuntimeScope, artifactId: string): Promise<StoredArtifact | null>;
  remove(scope: RuntimeScope, artifactId: string): Promise<void>;
}
```

`ArtifactSnapshot` 等 wire 类型继续放在 `@lobechat/runtime-contracts`；bytes 读写
类型属于 `src/server/runtime/presentation/` 的 server-only seam，使用 `Uint8Array`，
不得把 `Buffer` 或 Node 文件句柄泄漏到前端契约。

`put` 必须生成不可变 artifact 版本，保存 bytes、mimeType、type、name、size 和
source job/version metadata；重复 artifactId、跨 scope 读取、空 bytes 或非法类型
返回稳定错误。`get` 返回 defensive copy；下载只能由 `ready` artifact 触发。Store
不得启动 provider、猜测用户身份或把 bytes 写到未授权路径。

**当前实现状态（C-49）**：已提供 server-only `PresentationArtifactStore` 与
`InMemoryPresentationArtifactStore`，按 `{ userId, sessionId }` 隔离 put/get/remove，
并以 `Uint8Array` 保存 ready artifact。重复 id、空 bytes、非法 type/mime/name、跨
scope 访问均有稳定错误；读取返回 bytes 与嵌套 metadata 的 defensive copy。定向测试
已覆盖保存、校验、隔离、拷贝和幂等删除；尚未接入对象存储、数据库、下载 API 或真实
provider。

**契约变更记录（C-49）**：runtime-contracts 增加 wire-safe `ArtifactInput` 与
`StoredArtifact`（bytes 为只读 number 数组）；server seam 使用独立的
`ArtifactInput`/`StoredArtifact` 类型承载 `Uint8Array`，避免二进制实现细节泄漏到
前端契约。

### C-50 Persistent PresentationPort decorator

**职责**：在不修改 Kernel `PptMasterAdapter` 状态机的前提下，把完成 Job 产生的真实
artifact 镜像到 C-49 `PresentationArtifactStore`，使 `getArtifact`/导出可跨请求读取。

由于公共 `PresentationPort.getArtifact()` 只返回 wire snapshot，server 侧必须额外
注入 binary seam：

```ts
interface PresentationBinaryPort extends PresentationPort {
  readArtifactBytes(artifactId: string): Promise<Uint8Array | null>;
}
```

`PptMasterAdapter` 和生产 binding 必须显式实现/透传该方法；binary seam 不得导出到
前端 runtime-contracts。若 inner 没有 binary seam，decorator 必须返回真实的
`ARTIFACT_BYTES_UNAVAILABLE`，不能写入只有元数据的假 artifact。

装饰器必须在 `createJob`/`retryJob` 返回 ready artifact 后保存 bytes 和元数据，在
`exportArtifact` 返回后保存导出 artifact；provider 失败、pending 或 cancelled 不得
写成 ready。`store` 必须由调用方显式注入，禁止默认创建临时内存 store；
`getArtifact` 与 `readArtifactBytes` 都优先读取持久化 store，store 未命中时才查询 inner；跨 scope
错误原样透传。旧 artifact 不得被覆盖；相同 artifactId 的相同 bytes 可幂等复用，内容
冲突必须返回稳定错误。装饰器不得启动 provider、访问数据库或改变 inner Job 状态。

**测试证据**：使用 C-49 in-memory store + fake `PresentationBinaryPort`，覆盖 create/retry/
export 镜像、跨请求读取、失败不落盘、重复 artifact 冲突和 scope 隔离。

**当前实现状态（C-50）**：已实现 `PresentationBinaryPort` server-only 扩展、
`PptMasterAdapter.readArtifactBytes()` defensive copy、生产 binding 显式透传及
`PersistentPresentationPort` decorator。装饰器只镜像 ready artifact，优先从 C-49
store 读取并原样透传 scope/inner 错误；尚未接入真实持久化后端或下载 API。

**契约变更记录（C-50）**：新增稳定错误 `ARTIFACT_BYTES_UNAVAILABLE`（缺 binary seam
或 ready bytes 缺失）、`ARTIFACT_CONFLICT`（相同 artifactId 内容不一致）与
`ARTIFACT_STORE_UNAVAILABLE`（未显式注入 store），并保持 runtime-contracts 不暴露
`Uint8Array`。decorator 的 binary read 同样遵循 store 优先、inner fallback。

### C-51 PresentationPlan / planner seam

**目的**：将“理解用户意图并规划整套幻灯片”与“调用 ppt-master 执行 SVG 检查及
PPTX 转换”彻底分开。`ppt-master` 当前没有可假设存在的单一整套 PPT 生成 CLI；因此
Agent/ModelGateway 只产出结构化 `PresentationPlan`，worker 才负责把计划写入 workspace
并调用已存在的工具。Planner 不得启动进程、写文件或直接生成 artifact；worker 不得
解释自然语言意图。

**核心契约（runtime-contracts）**：

```ts
interface PresentationPlan {
  planId: string;
  title: string;
  aspectRatio: string;
  slides: readonly PresentationSlidePlan[];
  designSpec?: Record<string, unknown>;
  sourceVersionIds: readonly string[];
}

interface PresentationSlidePlan {
  slideId: string;
  order: number;
  svg: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

interface PresentationPlanner {
  plan(input: PresentationJobInput, context: PlannerContext): Promise<PresentationPlan>;
}
```

`planId`、`slideId` 必须为非空稳定标识；`slides` 不得为空，`slideId` 不得重复，
`order` 必须从 0 或 1 开始连续递增且唯一；`svg` 必须是可解析的 SVG/XML 文本并包含
根 `<svg>`，禁止把 HTML、脚本或二进制伪装成 SVG。Planner 必须执行可注入的页数/字节
预算校验，超限返回稳定的 `PLAN_INVALID`，不得返回 placeholder 并标成 ready。
`sourceVersionIds` 只记录来源版本，不得隐式覆盖项目当前版本；`designSpec` 与 slide
metadata 必须经过 defensive copy。

**边界与错误**：planner 错误必须原样透传给 Agent/runtime；planner 不感知用户身份、
scope、持久化或 provider。worker 接收合法 plan 后，负责 workspace materialize、调用
SVG 质量检查和 `svg_to_pptx.py`，并将生成的 artifact 交给 C-50 decorator；worker
失败不得修改项目版本指针。该 seam 先提供 in-memory/reference 实现与契约测试，真实
ModelGateway、队列、进程沙箱和 E2E 后置。

**验收证据**：覆盖合法单页/多页计划、空页、重复 id、乱序/重复 order、非法 SVG、
超出页数或字节预算、metadata 防御性拷贝及 planner 错误透传；测试不得启动真实
`ppt-master`，不得修改 `/home/shiro/Projects/ppt-master`。

**当前实现状态（C-51）**：已提供 runtime-contracts 的
`PresentationPlan`/`PresentationSlidePlan`/`PresentationPlanner`/`PlannerContext`，
以及 server-only `validatePresentationPlan` 与 `InMemoryPresentationPlanner`。校验
计划标识、连续页序、SVG/XML 根节点、页数与字节预算，并对 designSpec/slide metadata
做 defensive copy；planner builder 错误原样透传。未接前端、数据库、真实 provider 或
清舟素材。

**契约变更记录（C-51）**：新增稳定错误 `PLAN_INVALID`；planner 仅产出结构化 plan，
不启动进程、不写文件、不生成 artifact，后续 worker 负责 materialize 与 provider 调用。

### C-52 PresentationPlan worker / pipeline seam

**职责**：接收 C-51 已验证的 `PresentationPlan`，将每页 SVG 和设计规格以稳定文件名
物化到受控 workspace，依次执行 SVG 质量检查和 `svg_to_pptx.py` 转换，并把转换器
返回的二进制 artifact 交给 C-50 持久化装饰器。Worker 只执行计划，不解释自然语言、
不调用 ModelGateway、不改变 `PresentationProject.currentVersion`，也不写入 workspace
之外的路径。

**注入边界（server-only）**：

```ts
interface PresentationPlanWorker {
  run(
    plan: PresentationPlan,
    context: PresentationWorkerContext,
  ): Promise<PresentationWorkerResult>;
}

interface PresentationWorkerContext {
  jobId: string;
  workspace: PresentationWorkerWorkspace;
  qualityCheck: (workspacePath: string) => Promise<PresentationQualityReport>;
  convert: (workspacePath: string) => Promise<readonly PresentationWorkerArtifact[]>;
}
```

`PresentationWorkerWorkspace` 只允许写入相对路径（例如 `svg_output/001.svg`、
`design_spec.json`），必须拒绝 `..`、绝对路径和路径穿越；写入内容使用 UTF-8，不能把
用户输入拼接为 shell 命令。`qualityCheck` 失败或报告未通过时，Worker 返回稳定的
`PRESENTATION_QUALITY_FAILED`，不得执行 convert；convert 失败返回稳定的
`PRESENTATION_WORKER_FAILED`。任一失败都要清理/标记 workspace，且不得产生 ready
artifact 或推进项目版本。取消通过 `AbortSignal` 传递，取消后不得把结果伪装成完成。

**结果与验收**：成功结果必须包含 jobId、质量报告和至少一个带 mime/type/name/bytes
的 artifact；artifactId 由调用方或 C-50 生成，Worker 不覆盖既有 artifact。测试使用
fake workspace、quality checker 和 converter，覆盖文件布局、路径穿越拒绝、质量门禁、
转换失败、取消、artifact defensive copy 和 planner 错误透传；不得启动真实
`ppt-master`、不得修改 `/home/shiro/Projects/ppt-master`。本轮只实现 reference/in-memory
worker seam，真实队列、进程监督、对象存储与浏览器 E2E 后置。

**当前实现状态（C-52）**：已提供 server-only `InMemoryPresentationPlanWorker`，按
`svg_output/001.svg…` 与 `design_spec.json` 稳定物化合法计划，执行质量门禁后再调用
注入的 converter；支持 AbortSignal 取消、受控相对路径校验、失败映射与结果
defensive copy。未接真实队列、进程监督、对象存储、数据库或 provider。

**契约变更记录（C-52）**：新增稳定错误 `PRESENTATION_QUALITY_FAILED`、
`PRESENTATION_WORKER_FAILED` 与 `PRESENTATION_WORKER_CANCELLED`；worker 不调用
planner、不解释自然语言、不推进项目版本。

### C-53 ppt-master toolchain command adapter

**目的**：把 C-52 worker 所需的两个外部步骤（`svg_quality_checker.py` 与
`svg_to_pptx.py`）封装成显式、可审计的 Toolchain seam。适配层只生成受控 argv 并把
注入的 `PresentationRunner` 结果映射成质量报告 / artifact；不得自行发现可执行文件、
拼接 shell 字符串或修改 `/home/shiro/Projects/ppt-master`。

**契约**：

```ts
interface PresentationToolchain {
  qualityCheck(workspacePath: string, signal?: AbortSignal): Promise<PresentationQualityReport>;
  convert(
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<readonly PresentationWorkerArtifact[]>;
}
```

生产 adapter 必须显式注入 `providerCommand`、`qualityScriptPath`、`convertScriptPath`、
`runner`、`runnerId` 和 allow-list；所有路径需在配置阶段 canonicalize 并限制在允许的
ppt-master 根目录或 workspace 内。质量命令 argv 形如
`[python, qualityScriptPath, workspacePath]`，转换命令 argv 形如
`[python, convertScriptPath, workspacePath]`，均使用 `shell:false`。缺少配置或 runner
不在 allow-list 返回 `PROVIDER_UNAVAILABLE` / `PRESENTATION_RUNNER_NOT_ALLOWED`；非零
退出码、超时、取消和非法 artifact 分别映射为稳定的
`PRESENTATION_QUALITY_FAILED`、`PRESENTATION_WORKER_FAILED` 或
`PRESENTATION_WORKER_CANCELLED`，不得把失败报告标为 passed。

**验收**：只用 fake runner 验证 argv 数组、路径边界、allow-list、退出码/取消/超时、
质量报告解析和 PPTX ZIP artifact 映射；不得启动真实脚本，不得联网，不得改动
`ppt-master`。完成后该 adapter 才能被 C-52 worker 注入；真实命令执行与部署配置另行
验收。

**当前实现状态（C-53）**：已提供 server-only `PptMasterToolchain`，配置阶段
canonicalize 并限制脚本/工作区根边界，运行阶段仅构造 `shell:false` argv 并透传
注入 runner；质量 JSON 报告与 PPTX artifact 映射、allow-list、取消及稳定错误均有
fake-runner 定向测试。未启动真实脚本或接入部署配置。

### C-54 Presentation generation pipeline orchestrator

**目的**：提供唯一的“计划→执行”编排入口，避免 HTTP handler、Agent strategy 或 UI
各自重复调用 planner/worker。Pipeline 只负责顺序和错误边界：先用注入的
`PresentationPlanner` 生成并校验 `PresentationPlan`，再把同一 plan 交给 C-52 worker；
不持有用户状态、不写数据库、不推进项目版本、不直接启动 provider。

**契约（server-only）**：

```ts
interface PresentationGenerationPipeline {
  run(
    input: PresentationJobInput,
    context: PresentationPipelineContext,
  ): Promise<PresentationGenerationResult>;
}

interface PresentationPipelineContext {
  plannerContext: PlannerContext;
  workerContext: PresentationWorkerContext;
}

interface PresentationGenerationResult {
  plan: PresentationPlan;
  worker: PresentationWorkerResult;
}
```

Pipeline 必须把 planner 返回值交给 C-51 校验（或使用 `InMemoryPresentationPlanner`
的校验），校验失败不得调用 worker；worker 失败和 planner 错误原样透传，不能包装成
成功。`workerContext.jobId` 必须非空且与结果一致；Pipeline 不得修改 input、plan、
worker artifact 或 quality report 的引用，调用方可安全修改返回值。取消通过同一个
`AbortSignal` 传递到 planner context（若支持）和 worker，取消后不得返回 completed。

**验收**：fake planner/worker 测试调用顺序、同一 plan 引用、无效 plan 短路、planner/
worker 错误透传、jobId 校验和取消；不启动真实 `ppt-master`，不接数据库、队列、前端或
清舟素材。该 seam 通过后，C-55 再负责把 pipeline 接到 Presentation capability 与
HTTP route。

**当前实现状态（C-54）**：已提供 server-only `PresentationGenerationPipelineImpl`，
统一 planner→validate→worker 顺序，确保同一 plan 引用传给 worker；jobId、取消、短路、
错误透传和返回值 defensive copy 均有定向测试。未接 capability/HTTP、数据库、队列或
真实 provider。

### C-55 worker artifact persistence bridge

**目的**：把 C-52 worker 成功结果中的二进制 artifact 显式写入 C-49
`PresentationArtifactStore`，为后续 HTTP 下载和跨请求预览提供唯一持久化入口。Bridge
不创建临时 store、不覆盖已有 artifact、不改变 project/version 指针，也不把 bytes
泄漏到 runtime-contracts 之外。

**契约（server-only）**：

```ts
persistPresentationWorkerArtifacts(
  scope: RuntimeScope,
  result: PresentationWorkerResult,
  store: PresentationArtifactStore,
): Promise<readonly ArtifactSnapshot[]>;
```

每个 worker artifact 必须有非空 bytes、mimeType、type、name；缺失或重复 id 返回稳定的
`ARTIFACT_INVALID` / `ARTIFACT_DUPLICATE`。未提供 artifactId 时由 bridge 基于 jobId 和
序号生成稳定 id；同 id 同 bytes 可幂等复用，内容冲突透传 `ARTIFACT_CONFLICT`。写入
`status=ready`，保存 jobId、planId、quality metadata 和 size；store 写入失败必须原样
透传，后续 artifact 不得继续写入（全有或前缀失败语义需在测试中固定）。bytes 与嵌套
metadata 均 defensive copy。

**验收**：fake/in-memory store 测试覆盖单/多 artifact、稳定 id、幂等、冲突、非法输入、
scope 隔离、失败短路和防御性拷贝；不得启动真实 provider、修改 `ppt-master`、接 HTTP
或前端。C-56 再把 bridge 接入 generation pipeline 和 route。

**当前实现状态（C-55）**：待 codex 实现 artifact persistence bridge 与定向测试。

### C-56 generation capability adapter

**目的**：把 C-54 generation pipeline 与 C-55 artifact bridge 组合成一个供 Agent
strategy 调用的 server-only capability。该适配器不改变现有七类
`PresentationCapabilityCommand`，不直接启动 provider，也不处理 HTTP；它只负责作用域
校验、调用顺序和将 ready artifact snapshot 返回给上层。

**契约**：

```ts
interface PresentationGenerationCapability {
  execute(
    scope: RuntimeScope,
    input: PresentationJobInput,
    context: PresentationPipelineContext,
  ): Promise<PresentationGenerationCapabilityResult>;
}

interface PresentationGenerationCapabilityResult {
  plan: PresentationPlan;
  worker: PresentationWorkerResult;
  artifacts: readonly ArtifactSnapshot[];
}
```

必须先执行 pipeline，再执行 C-55 bridge；任一步失败原样透传，bridge 失败不得返回
部分成功。scope 的 `userId`/`sessionId` 必须非空并在调用前校验；同一 scope、同一
worker 结果重复执行应依赖 bridge 幂等语义，不创建第二份 artifact。返回 plan、worker
和 snapshots 均需 defensive copy；适配器不推进项目版本、不猜测认证、不修改输入。

**验收**：fake pipeline/store 测试调用顺序、scope/输入校验、错误短路、幂等与返回值
拷贝；不启动真实 `ppt-master`，不接 HTTP/数据库/前端或清舟素材。C-57 再把该能力
接入现有 capability command 与 HTTP route。

**当前实现状态（C-56）**：已提供 server-only `PresentationGenerationCapability`，在
scope/input 校验后严格执行 pipeline→C-55 bridge，返回 plan/worker/artifacts 的
defensive copy；错误短路与重复执行依赖 bridge 幂等。未接 HTTP、数据库、前端或真实
provider。

### C-57 generation HTTP adapter seam

**目的**：为 C-56 capability 提供框架无关的 HTTP 接缝，先冻结请求校验、认证 scope
传递和 wire-safe 响应，后续再接 Next route、SSE 和真实 session。不得把
`Uint8Array`、workspace 路径或内部 runner 细节返回给浏览器。

**契约（server-only）**：

```ts
handlePresentationGenerationRequest(
  request: Request,
  scope: RuntimeScope,
  capability: PresentationGenerationCapability,
  contextFactory: (jobId: string) => PresentationPipelineContext,
): Promise<PresentationGenerationHttpResponse>;
```

仅接受 `POST` 和 JSON object body；`PresentationJobInput` 的 notebookId/title/
sourceVersionIds 必须校验，非法请求返回 400 + `PRESENTATION_INVALID`。scope 必须由
调用方提供并再次校验，禁止读取客户端 session header。capability 错误按既有映射返回
结构化 `{ error: { code, message, details? } }`；成功响应只返回 `plan`、`jobId`、quality
摘要和 wire-safe artifact snapshots（artifactId/type/name/mime/size/status/uri），不含
bytes。contextFactory 不得在 handler 中启动 provider；请求取消时将 `AbortSignal`
传递到 pipeline context。

**验收**：fake capability 测试 method/body/scope 校验、调用参数、成功响应无二进制、
错误码映射和取消；不改 Next route、不接真实认证/数据库/provider、不修改
`ppt-master`。C-58 再负责 Next route 注册与前端 RuntimeClient 接线。

**当前实现状态（C-57）**：已提供框架无关 `handlePresentationGenerationRequest`，仅接受
POST/JSON object，校验输入与 scope，注入请求 AbortSignal，调用 C-56 capability，并
返回不含 bytes/workspace 的 wire-safe 响应；错误按稳定 code/status 映射。未接 Next route、
SSE、真实认证或 provider。

### C-58 PresentationStudio frontend shell

**职责**：由 claude（Herdr 独立终端）在 LobeHub 自有 UI 体系内实现 PPT 工作台第一阶段
壳层：创建表单、Job 状态列表、进度/错误展示、SVG 缩略图与 artifact 导出入口。继续
使用 `@lobehub/ui`、antd、LobeHub AppShell 和 motion；不得引入清舟 AppShell、路由、
状态管理或不成熟动画。清舟素材本轮冻结。

**目录与路由**：实现 `src/features/PresentationStudio/**`，路由段
`src/routes/(main)/presentation/index.tsx` 保持薄封装；桌面路由必须同步更新
`desktopRouter.config.tsx` 与 `desktopRouter.config.desktop.tsx`。业务状态放 feature
store/hooks，不放 routes。

**第一阶段交互**：create/cancel/retry、queued/running/completed/failed/cancelled 状态、
失败不可导出、多个 artifact 选择、SVG 预览和 responsive 空态；传输层通过可注入
RuntimeClient seam，允许 fake 数据测试，不伪造“真实 provider 已上线”。样式优先
`createStaticStyles` + `cssVar.*`；至少覆盖 1440×900 与 390×844 的组件测试/截图证据。

**验收**：组件单测、路由同步测试、无障碍和 reduced-motion 检查；不得修改
`/qingzhou`、`/home/shiro/Projects/ppt-master`、后端 Kernel 或数据库。真实 HTTP/SSE
接线由后续 C-59 负责。

**当前实现状态（C-58）**：已实现 LobeHub 原生 PresentationStudio shell（create/cancel/retry、五状态、多 artifact 选择、SVG 预览、失败不可导出、responsive 空态、注入式 RuntimeClient seam + demo 传输并诚实标注）；组件/路由/风格契约测试 60/60 通过；真实 HTTP/SSE 接线与浏览器 E2E 后置。

### C-59 Presentation generation Next route wiring

**目的**：把 C-57 的框架无关 generation handler 接到现有
`src/app/(backend)/api/runtime/presentation/[[...path]]/route.ts`，只增加精确的
`POST /api/runtime/presentation/generation` 分支；既有 `/jobs`、`/artifacts` 路径和
scope-cache 行为保持不变。

**边界与输入**：

- HTTP route 只负责路径分派、调用现有 `checkAuth`、解析服务端 session scope、调用
  C-57 handler 和返回 JSON；业务编排仍由 capability/pipeline 负责。
- generation scope 必须由服务端 Better Auth/OIDC 认证上下文解析出 `{ userId,
sessionId }`，并校验与 `checkAuth` 的 userId 一致；不得读取或信任客户端
  `x-session-id`、`session` 或同类 header。旧非-generation cache 路径的兼容 header
  约定不在本条款内扩散。
- `generationCapability`、`generationContextFactory`、`generationScopeFactory` 是
  测试/部署注入 seam；生产未配置 capability 时必须返回
  `PROVIDER_UNAVAILABLE`，不得构造、启动或伪造 provider。

**错误与 wire 约束**：沿用 C-57 的结构化 `{ error: { code, message } }` 和状态映射：
`PRESENTATION_INVALID`→400、认证失败→401/403、`NOT_FOUND`→404、provider 不可用
→503、质量/PPTX 错误→502、取消→499；成功响应递归移除 `bytes`、`workspace`、
`workspacePath`、本地 `path` 和 `Uint8Array`。

**验收**：route + C-57 handler targeted tests 覆盖成功、400、401、403、404、503、
502、499、伪造 session header 被忽略、旧路径未回归；source type-check 与 Prettier
通过。不得修改前端、`/qingzhou` 或 `/home/shiro/Projects/ppt-master`。

**当前实现状态（C-59）**：已接入 generation 分支；默认 resolver 使用服务端
`auth.api.getSession` 并剥离伪造 session header；route/handler 定向 37/37 通过。真实
provider、持久化队列、部署级 session 与浏览器 E2E 仍后置。

### C-60 PresentationStudio RuntimeClient wiring

**目的**：把 C-58 的 LobeHub 原生 PresentationStudio 从 demo-only seam 接到真实
`src/services/runtime/client.ts`，覆盖创建、查询/恢复、取消、重试、artifact 获取和
导出；demo 只能通过显式 `transportMode="demo"` 启用。

**边界与状态**：

- 前端只依赖 `RuntimePresentationClient`/`PresentationJobEvent` 类型，不引用服务端
  class、数据库模型或外部项目源码；默认 `transportMode="http"` 使用真实
  `RuntimeClientImpl`。
- `queued`、`running`、`completed`、`failed`、`cancelled` 五种状态必须诚实呈现；
  failed/cancelled 或未完成 job 不得导出，结构化错误 `{ code, message }` 原样显示。
- 多 artifact 通过键盘可访问的选择器切换；SVG 预览使用 wire-safe URI；下载动作只
  接受 ready artifact。loading、空态、响应式和 reduced-motion 继续由 LobeHub 自有
  `@lobehub/ui`/antd/motion 契约负责。
- `subscribePresentationJob(jobId, { afterSeq, signal })` 仅冻结事件形状和恢复语义：
  `seq` 按 job 单调、重复事件幂等、断流不伪造完成；服务端 SSE 尚未提供时必须降级
  polling 并保留 `lastSeqByJob`，不得把 demo 结果标成真实 provider。

**验收**：PresentationStudio、store、RuntimeClient wiring、route sync targeted tests
通过；覆盖 HTTP fetch 请求体/错误码、demo 显式标识、SSE/after_seq 去重与 polling
降级、五状态、artifact 选择/导出、a11y/reduced-motion。不得修改后端、数据库、
`/qingzhou` 或 `ppt-master`；真实 SSE 服务端、真实 provider 和浏览器 E2E 由后续
C-61/C-62 负责。

**当前实现状态（C-60）**：已完成真实 RuntimeClient HTTP seam 与显式 demo fallback，
定向 70/70 通过；真实 presentation SSE、provider 字节流和浏览器 E2E 仍未完成。

### C-61 Presentation job event journal and SSE route seam

**目的**：为 Presentation job 建立可注入的事件日志与 SSE 读取接缝，使 C-60 的
`subscribePresentationJob` 有真实服务端协议可连接；不在本条款内启动真实
`ppt-master` provider 或改变 worker 业务状态机。

**原子要求**：

- 提供 server-only `PresentationJobEventJournal`（至少支持 append、按 `jobId` 查询
  `afterSeq` 之后的 replay、live subscriber、幂等 dispose）；每个 job 的 `seq` 严格递增，
  重复/旧事件不得发出。
- 在现有 presentation route 增加精确 `GET /jobs/:jobId/events?after_seq=N` 分支，
  复用现有 `checkAuth` 和服务端 scope；客户端 `x-session-id`/`session` header 不得
  决定租户 scope。
- 成功响应使用 `text/event-stream`，事件 data 为 C-60 的
  `{ protocol_version, type, job_id, seq, data }`；先 replay 再订阅 live，断开时清理
  listener。非法 `after_seq`、越权 job、未知 job 使用结构化 JSON 错误，不伪造事件。
- journal、route 和 SSE serializer 必须可注入测试，不要求真实 PostgreSQL/Redis。

**验收**：journal 单测 + route/SSE targeted tests 覆盖 replay/live 顺序、after_seq、
重复/乱序过滤、取消信号、scope 隔离、错误 JSON 和 `text/event-stream` headers；不得
修改 `ppt-master`、清舟或前端组件。真实 worker 发布事件与生产持久化后置。

### C-62 RuntimeClient presentation SSE adapter

**目的**：在前端 `RuntimeClientImpl` 中实现 C-60 已冻结的
`subscribePresentationJob`，连接 C-61 SSE 路由，同时保持断流可恢复、可取消和 polling
降级。

**原子要求**：

- 仅在 `src/services/runtime/client.ts`（及其测试）增加 SSE 读取器：请求
  `/api/runtime/presentation/jobs/:jobId/events?after_seq=N`，解析标准 SSE `data:` 帧，
  严格校验 `protocol_version/job_id/seq/type`，并通过 `onSeqReceived` 暴露最高序号。
- `AbortSignal` 必须中止 fetch/reader；HTTP 非 2xx、格式非法或服务端断开应抛出可识别
  错误，不能返回 completed 假事件。重连由上层 hook 控制，客户端只保证 after_seq 参数
  与单次流的幂等顺序。
- 不改变 C-60 的 CRUD 方法和 demo fallback；无 SSE/错误时 PresentationStudio 继续
  显示 polling 提示并保留 `lastSeqByJob`。不得读取 session header、修改后端/数据库、
  清舟或 `ppt-master`。

**验收**：fetch/SSE parser 单测覆盖多帧、跨 chunk、注释/空帧、after_seq、重复 seq、
abort、非 2xx、非法 JSON/事件；与 C-60 前端套件联跑通过。真实浏览器断线重连与
provider E2E 后置。

### C-63 Presentation worker event publication

**目的**：把现有 Presentation pipeline/worker 的状态转换发布到 C-61 journal，形成
`queued → running → completed|failed|cancelled` 的可重放事件源；不在本条款内接入
真实 ppt-master 命令。

**原子要求**：

- 提供可注入 `PresentationJobEventPublisher`，依赖 `PresentationJobEventJournalPort`
  或等价 Port，不直接依赖 HTTP/SSE；事件 payload 复用 C-60 的 job/artifact 快照
  形状，`seq` 按 job 单调且重复发布幂等。
- worker 在接受任务、开始 planner/worker、artifact ready、质量失败、取消和异常路径
  分别发布明确 type；发布失败不得吞掉原始 worker 错误，也不得把失败改成 completed。
- pipeline/capability 通过显式 publisher 注入；未注入时保持现有行为，不创建全局 journal。
- publisher 必须支持 scope 校验和 dispose，不能跨 user/session 发布事件。

**验收**：publisher 单测覆盖顺序、幂等、错误/取消、scope 隔离和无注入回退；pipeline
targeted tests 证明状态终态与 journal 事件一致。不得修改前端、清舟或 ppt-master，
真实队列/数据库持久化后置。

### C-64 Presentation SSE reconnect backoff

**目的**：在 C-60/C-62 的 PresentationStudio hook 层增加有限、可取消的 SSE 断线重连，
减少短暂网络抖动导致的 polling 降级；服务端和 RuntimeClient parser 不改动。

**原子要求**：

- `useJobPolling` 对活动 job 最多进行可配置次数的指数退避重连（默认 3 次），每次以
  `lastSeqByJob[jobId]` 作为 `afterSeq`；AbortSignal/unmount 必须取消等待和 reader。
- 重连期间 UI 显示非致命 reconnecting 状态；达到上限或收到不可恢复错误后降级 polling，
  不伪造终态、不清空已收到的 artifact/seq。
- 保持显式 demo transport、五状态、失败不可导出和 reduced-motion 规则；重连策略通过
  注入时钟/延迟 seam 可测试，不能在测试中 sleep 真实长时间。

**验收**：hook/store targeted tests 覆盖首次断流、after_seq 递增重连、成功恢复、上限
降级、取消清理和 UI 状态；C-60/C-62 全套回归通过。不得修改后端、数据库、清舟或
`ppt-master`。

### C-65 Presentation generation event-publisher route binding

**目标**：把 C-63 的 server-only publisher 显式接入真实 generation route，同时保持
journal、认证和 provider 的装配边界清晰。

**原子要求**：

- `PresentationRouteOptions` 可注入 `generationEventPublisherFactory`；factory 接收服务端解析出的 `{ userId, sessionId }`、本次生成 `jobId` 与原始 `Request`，返回 `PresentationJobEventPublisherPort | undefined`，不得从客户端 header 推导 scope。
- generation route 只在 capability/contextFactory 已配置且 publisher factory 返回 publisher 时注入 `workerContext.eventPublisher` 与 `eventScope`；未注入时保持 C-59 行为，不创建全局 journal 或隐式 publisher。
- publisher factory 的异常必须保留结构化错误，不得把 generation 结果伪装成 completed；scope 不匹配必须拒绝并返回 403/结构化错误。
- `jobEventJournalFactory` 仍只负责 SSE replay/live；生产装配若需要同一 journal，必须由外部 factory/cache 保证共享，route 不持有跨用户全局状态。
- 只修改 generation route 及 `src/server/runtime/presentation/**` 对应测试；禁止修改前端、数据库、`/qingzhou`、`/home/shiro/Projects/ppt-master`。

**验收**：route 注入 scope/jobId 的测试、publisher 异常与未配置回归、C-59/C-61/C-63
targeted tests、定向 ESLint/Prettier/source tsc。

### C-66 Presentation per-job stream status

**目标**：消除多 job 并行时单一 `streamStatus` 互相覆盖，让 PresentationStudio 对当前
job 展示诚实的 live/reconnecting/polling 状态。

**原子要求**：

- store 新增按 `jobId` 索引的 `streamStatusByJob` 与幂等 setter；保留现有 `streamStatus` 作为向后兼容的汇总字段，不能改变 C-60/C-64 调用签名。
- `useJobPolling` 在首次订阅、重连、恢复 live、降级 polling、终态/取消和 unmount 时更新对应 job 的状态；一个 job 的变化不得覆盖另一个 job 的状态。
- PresentationStudio 优先读取 selected job 的 per-job 状态；无 selected job 时可显示汇总提示。不得伪造终态，不得清空 `lastSeqByJob` 或 artifacts。
- 只修改 `src/features/PresentationStudio/**` 与对应测试；继续使用 LobeHub 自有 UI/motion，不接入清舟素材或组件。

**验收**：至少两个并行 job 的状态隔离测试、重连/降级/取消清理测试、现有 C-60/C-64
套件回归、定向 ESLint/Prettier/type-check。

### C-67 Scoped presentation event-journal lifecycle binding

**目标**：让 generation route 与 SSE route 能通过显式、按 user/session 隔离的 journal
factory 共享同一任务事件流，同时不引入隐式全局状态或数据库耦合。

**原子要求**：

- 在 `src/server/runtime/presentation/**` 提供可注入的 scoped journal cache/factory，key
  必须同时包含 `userId` 与 `sessionId`，并支持 `resolve/peek/reset/dispose` 生命周期。
- loader、journal、subscriber 均为可注入 port；默认不创建全局 singleton，不读取客户端 header，跨 scope 不可 replay/subscribe。
- 同一 scope 下 generation publisher 与 SSE journal resolve 得到同一实例；reset/dispose 后不得继续写入或订阅，重复 dispose 安全。
- 只修改 server presentation seam 与对应测试；真实 PostgreSQL/Redis 适配后置，不改前端、清舟或 ppt-master。

**验收**：双 scope 隔离、同 scope 复用、reset/dispose、并发 resolve、SSE replay/live 回归，定向 ESLint/Prettier/source tsc。

### C-68 Presentation event payload projection

**目标**：让 PresentationStudio 正确消费 C-63 publisher 产生的 `{ job, artifact }` 事件包，避免实时事件到达但 UI 不更新。

**原子要求**：

- `applyPresentationEvent` 同时支持旧的顶层 job/artifact 快照和 C-63 的嵌套 `data.job`、`data.artifact`、`data.artifactIds` 形状；按 `seq` 幂等，乱序不回退。
- job 快照更新必须维护 `jobOrder`、selected job 与 artifactIds；artifact ready 事件必须写入 artifacts 并关联 job，禁止把 bytes/path/workspace 写入 store。
- 非法/未知事件只记录可观察错误或安全忽略，不伪造 completed/ready；lastSeqByJob 仍单调。
- 只修改 `src/features/PresentationStudio/**` 与对应测试；不改 RuntimeClient 协议、后端、数据库、清舟或 ppt-master。

**验收**：nested job/artifact 事件、重复/乱序、跨 job 隔离、终态与 artifact 关联测试；C-60/C-64/C-66 套件和定向 lint/type-check 回归。

### C-69 Presentation route journal binding bundle

**目标**：为部署装配提供一个不可误配的显式 bundle，一次由同一个
`ScopedPresentationJobEventJournalCache` 生成 SSE journal factory 与 generation
publisher factory，保证两条 route seam 使用完全相同的 user/session scope。

**原子要求**：

- 在 `src/server/runtime/presentation/**` 提供 `createPresentationRouteJournalBindings(cache, options?)`（名称可等价）及稳定类型，返回 `jobEventJournalFactory` 与 `generationEventPublisherFactory`；两者必须只调用传入 cache，不得创建模块级 singleton、读取客户端 header 或自行解析认证。
- bundle 的 scope 入参必须保持 C-61/C-65 的服务端 `{ userId, sessionId }`，generation publisher 继续接收 `jobId` 与原始 `Request`；可注入 `now` 等确定性选项必须透传且不改变事件协议。
- 同一 scope 的 SSE 与 generation resolve 必须得到同一 journal；不同 scope 必须隔离；cache 的 reset/dispose 语义和结构化错误必须原样透传。
- 只修改 `src/server/runtime/presentation/**` 及对应测试；不改 Next route、前端、数据库、清舟或 ppt-master，不 commit/push。

**验收**：bundle 类型与参数校验、同/跨 scope 复用隔离、publisher→SSE replay 闭环、reset/dispose 错误透传；C-61/C-63/C-65/C-67 targeted、定向 ESLint/Prettier/source tsc。

### C-70 Presentation runtime composition manifest

**目标**：冻结 PPT 能力在应用装配层的显式组合对象，让后续 Next route/部署只接收一个经过校验的 manifest，避免各处手工拼接 capability、journal 与 publisher seam。

**原子要求**：

- 仅在 `src/server/runtime/presentation/**` 提供 `createPresentationRuntimeComposition`（名称可等价）及稳定类型；输入必须显式注入 Presentation capability/port factory、`ScopedPresentationJobEventJournalCache`（或其 loader）与可选 `now`，输出只包含 route 所需的 generation handler、`jobEventJournalFactory`、`generationEventPublisherFactory` 及生命周期 `dispose/reset`。
- 组合对象不得持有模块级 singleton、读取客户端 header、启动 provider/进程或隐式连接数据库；所有 scope 继续由调用方传入并校验，未配置 provider 必须保留 `PROVIDER_UNAVAILABLE` 结构化错误。
- manifest 的 journal seam 必须来自 C-69 bundle，同 scope publisher/SSE 共享实例；生命周期调用幂等并原样透传 cache 错误。
- 只修改 presentation seam 与对应测试，不改 Next route、前端、数据库、清舟或 ppt-master，不 commit/push。

**验收**：输入/输出契约校验、route seam 组合与 scope 透传、同 scope replay、dispose/reset 生命周期和 provider 缺失回归；C-61/C-63/C-65/C-67/C-69 targeted、定向 ESLint/Prettier/source tsc。

### C-71 Next route composition manifest wiring

**目标**：让现有 presentation Next route 能直接消费 C-70 组合根，同时保留旧的逐项注入方式，避免部署方手工复制 capability/journal seam。

**原子要求**：

- 在 `src/app/(backend)/api/runtime/presentation/[[...path]]/route.ts` 及对应测试中增加可选 `composition` 注入；当提供 composition 时，generation capability/context、`jobEventJournalFactory` 与 `generationEventPublisherFactory` 从 composition 派生。
- composition 与对应单项 seam 同时提供时必须 fail-closed 返回稳定 `PRESENTATION_COMPOSITION_OPTIONS_INVALID`/结构化 400（不得静默覆盖）；未提供 composition 时 C-59～C-69 旧调用保持完全兼容。
- route 仍只使用服务端认证 scope；不得从客户端 header 推导 user/session，不得在 route 模块持有全局 cache；composition 的 reset/dispose 由外部生命周期调用，route 不擅自销毁。
- 只修改该 Next route 与对应测试，不改前端、数据库、清舟或 ppt-master，不 commit/push。

**验收**：composition-only generation/SSE 成功路径、冲突注入 fail-closed、旧逐项注入回归、scope/结构化错误透传；C-59/C-61/C-63/C-65/C-67/C-70 targeted、定向 ESLint/Prettier/source tsc。

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
- C-40 先冻结生产命令接缝；命令接线通过显式 provider 配置完成，不能把
  `/home/shiro/Projects/ppt-master` 当作 LobeHub 内置源码目录。

### M6：前端 Runtime Workspace

- Chat、Session、Plugin、Artifact 全部接入 RuntimeClient。
- 新增 Plugin Marketplace、SlotHost 和 Presentation Studio。
- 清舟素材只进入 DecorativeLayer。
- PresentationStudio 第一阶段只做 `/presentation` 的创建、进度、SVG 预览和真实
  PPTX 导出；元素级编辑在第二阶段单独验收。

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

| 日期       | 变更                                                                                                                                                                               | 影响                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-26 | 初版原子契约；明确 Agent strategy Plugin、PPT PresentationPort、清舟素材 / UI 分离                                                                                                 | 后端 / 前端按 C-01～C-16 拆分                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-08-26 | 增加 C-15-L Presentation client seam，仅定义前端传输方法，不引入清舟素材或 Presentation Studio UI                                                                                  | 前端 RuntimeClient 增加 Presentation 请求契约                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-08-26 | 增加 C-17 Runtime HTTP adapter seam，先冻结框架无关的 RuntimeFacade 请求 / 错误映射，再接 Next.js 路由                                                                             | 后端新增可测试 API seam；路由与鉴权后置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-08-27 | 增加 C-15-M Presentation 状态面板与 C-18 Runtime 路由接线契约；清舟素材继续冻结                                                                                                    | 前端原生面板与后端 Next 路由各自独立交付                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-08-27 | 增加 C-15-N 多工件选择与 C-19 Presentation HTTP routes 契约                                                                                                                        | 前端增强导出选择；后端接入 C-14 PresentationPort                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-08-27 | 增加 C-15-O RuntimeWorkspace 可选 Presentation 插槽与 C-20 作用域持久化桥接契约                                                                                                    | 前端保持默认布局；后端先完成 scope 隔离 seam                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-08-27 | 增加 C-21 Legacy Agent compatibility seam，交由 opencode 独立实现                                                                                                                  | codex 与 opencode 后端任务各占一半，旧路径保持可回滚                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-08-27 | 增加 C-22 Runtime SSE transport 与 C-23 Scoped PresentationPort cache，继续按 codex/opencode 1:1 分工                                                                              | 完成事件流传输与 Presentation 任务跨请求状态保持                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-08-27 | 增加 C-24 Live Runtime SSE subscription 与 C-25 Presentation cache factory integration                                                                                             | 补齐实时事件与作用域缓存的生产接线                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-08-27 | 增加 C-15-P 前端 SSE 断线重连契约，交由 agy 实现                                                                                                                                   | 前端在实时流中断时自动续传且保持幂等                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-08-27 | 增加 C-26 EventJournal live bridge 与 C-27 Presentation route cache adoption                                                                                                       | 将实时事件与作用域缓存接入实际运行路径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-08-27 | 增加 C-29 Scoped legacy agent compat construction                                                                                                                                  | 旧 Agent 兼容层按认证作用域惰性构造，旧路径零改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-08-28 | 收口 C-28 RuntimeFacade scoped cache；明确 user/session key、注入 sessionIdFor、uncached 回退与 scope 隔离                                                                         | 接口与隔离测试完成；生产 factory、真实认证 session 和 E2E 未完成                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-08-28 | 收口 C-30 central runtime_v1_agent_ops 与 C-31 safe PPT Runner；冻结 central 优先级、argv/shell:false 和真实失败语义                                                               | 接口与 targeted tests 完成；真实 flag rollout、provider 接线和 E2E 未完成                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-08-28 | C-32 文档收口：将内核 / 契约接口完成与生产接线、E2E 状态分列                                                                                                                       | 后续验收必须分别证明真实认证、factory、provider、持久化和浏览器路径                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-08-28 | 增加 C-40～C-45：冻结 PPT Master 生产命令接缝、Presentation capability plugin、项目版本链与 PresentationStudio 两阶段上线边界                                                      | PPT 第一阶段只承诺创建→进度→SVG 预览→真实 PPTX 导出；编辑与清舟装饰后置                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-08-28 | C-40/C-41 接缝实现并通过 targeted tests：生产 argv 只携带 workspace 受控路径，Kernel create 在 spawn 前 materialize 稳定 `input.json`，production factory 显式注入 provider/runner | 尚未启动真实 provider；下一轮负责 LobeHub-owned worker 与真实 artifact 闭环                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-08-28 | C-46 增加框架无关 Agent-to-Presentation capability seam：七类 operation、scope/authorizer、结果类型和 edit 元数据保留规则                                                          | strategy 只路由到 PresentationPort；不启动 provider、不覆盖旧 artifact；真实项目版本持久化后置                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-08-29 | 增加 C-47 通用 External Capability Plugin 范式：Manifest → Port → Adapter → Strategy → Runtime/UI，并冻结跨项目接入清单                                                            | 后续所有开源项目按同一深模块 seam 接入；PPT 仅作为首个实现，不复制外部 UI/源码                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-08-29 | C-48 完成 Presentation project/version in-memory seam：追加式版本、current 指针切换、scope 隔离与 defensive copy 测试                                                              | 编辑/回滚的数据模型已冻结；PostgreSQL、真实 worker 和 E2E 仍后置                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-08-29 | C-50 完成 server-only `PresentationBinaryPort` 与 PersistentPresentationPort：ready artifact 镜像、跨请求读取、冲突保护和显式 store 注入测试                                       | Kernel/内存持久化 seam 完成；真实对象存储、下载 API、worker 和 E2E 仍后置                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-08-29 | 增加 C-51 PresentationPlan / planner seam：结构化计划、SVG/XML 与预算校验、planner/worker 职责分离，禁止假设不存在的 ppt-master 整套 CLI                                           | codex 先实现 in-memory/reference planner；真实 ModelGateway、worker、队列和 E2E 后置                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-08-30 | 增加 C-52 PresentationPlan worker / pipeline seam：受控 workspace 物化、SVG 质量门禁、svg_to_pptx 转换与取消/失败边界                                                              | codex 实现 reference worker；真实队列、进程监督、对象存储和浏览器 E2E 后置                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-08-30 | 增加 C-53 ppt-master toolchain command adapter：质量检查与 SVG→PPTX 的显式 argv、路径边界、allow-list 与错误映射                                                                   | codex 实现 fake-runner 可测适配层；真实脚本执行与部署配置后置                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-08-30 | 增加 C-54 Presentation generation pipeline orchestrator：统一 planner→worker 顺序、短路与取消/错误透传边界                                                                         | codex 实现 reference pipeline；capability/HTTP 接线、队列和真实 provider 后置                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-08-30 | 增加 C-55 worker artifact persistence bridge：worker 二进制结果写入 C-49 store 的稳定 id、幂等/冲突与失败短路语义                                                                  | codex 实现内存 store bridge；pipeline/HTTP 接线与真实对象存储后置                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-08-30 | 增加 C-56 generation capability adapter：统一 pipeline→artifact bridge 调用顺序、scope 校验与 ready snapshot 返回                                                                  | codex 实现 server-only 适配层；现有 capability command、HTTP route 和真实 provider 后置                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-08-30 | 增加 C-57 generation HTTP adapter seam：POST/JSON/scope 校验与不含二进制的 wire-safe 响应                                                                                          | codex 实现框架无关 handler；Next route、SSE、真实认证和前端接线后置                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-08-30 | 增加 C-58 PresentationStudio frontend shell：LobeHub 自有 UI 的创建、Job 状态、SVG 预览与 artifact 操作边界                                                                        | claude 已实现 feature shell 与定向测试；真实 HTTP/SSE 接线后置，清舟素材继续冻结                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-08-30 | 增加 C-59 Presentation generation Next route wiring：将 C-57 handler 接入现有 Next API 路由，认证 scope 只来自服务端真实 session，保留结构化错误与未配置 provider 的诚实失败       | codex 负责路由接线与 route tests；仅允许 fake capability/provider 测试，不修改前端、清舟或 ppt-master                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-08-30 | 增加 C-60 PresentationStudio RuntimeClient wiring：将真实 RuntimeClient 接入创建、查询、取消、重试与导出，demo transport 保留为显式 fallback，冻结 SSE/after_seq 恢复接口          | claude 已完成：默认接入真实 RuntimeClientImpl（HTTP seam）、结构化错误 `{code,message}`、demo 仅显式 `transportMode="demo"` 接线并诚实标注、冻结 `PresentationJobEvent`/`subscribePresentationJob` 与 last-seq 恢复（真实 SSE 缺席时清晰降级 polling）、loading/五状态/不可导出/多 artifact/无障碍与 reduced-motion 契约保持；定向 70/70 通过；真实 SSE 服务端与浏览器 E2E 仍后置                                                                                                                                                           |
| 2026-08-30 | 增加 C-61 Presentation job event journal + SSE route seam：冻结 replay/live、after_seq、seq 幂等、scope 隔离与断开清理                                                             | codex 已完成 server-only journal、SSE serializer 与 route；journal/SSE/route 56/56，定向 tsc 与 Prettier 通过；真实 provider/数据库/前端接线后置                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-08-30 | 增加 C-62 RuntimeClient presentation SSE adapter：冻结标准 SSE parser、AbortSignal、after_seq 与错误语义                                                                           | claude 已完成：`RuntimeClientImpl.subscribePresentationJob` 接入 C-61 `jobs/:jobId/events?after_seq=N`，严格校验 protocol_version/job_id/seq/type，跨 chunk/多帧/注释空帧、seq 幂等过滤 + 最高 seq 回调、AbortSignal 取消 fetch/reader、非 2xx/非法 JSON/流错误抛出可识别错误；C-60 CRUD/demo/polling fallback 不变，12 项 parser targeted tests + 全套 122/122 通过；真实浏览器断线重连与 provider E2E 后置                                                                                                                                |
| 2026-08-30 | 增加 C-63 Presentation worker event publication：冻结 worker 状态到 journal 的 publisher seam、终态一致性、幂等和 scope 隔离                                                       | codex（Herdr）已完成 publisher、pipeline/worker/capability 接线与 20 files/145 tests；真实队列、数据库持久化和 ppt-master provider 后置                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-08-30 | 增加 C-64 Presentation SSE reconnect backoff：冻结前端有限重连、after_seq 递增、取消清理与 polling 降级                                                                            | claude 已完成：`useJobPolling` 对活动 job 做可配置指数退避重连（默认 3 次，`base*2^(n-1)`），每次以 `lastSeqByJob` 作 afterSeq，`reconnecting` 状态非致命展示，预算耗尽/不可恢复协议错误降级 polling 且保留 seq/artifact，注入 wait 时钟 seam + AbortSignal 取消（unmount 无 timer 泄漏）；C-60/C-62 全套 126/126 通过；浏览器断线重连 E2E 后置                                                                                                                                                                                             |
| 2026-08-30 | 增加 C-65 generation event-publisher route binding 与 C-66 per-job stream status：冻结真实 generation route 的 publisher 注入边界及多 job 状态隔离                                 | C-65 由 codex 完成：generation route/handler 注入 scope、jobId、Request publisher seam，scope denial 映射 403，route+presentation 21 files/186 tests；C-66 由 claude 完成：store `streamStatusByJob` + 幂等 setter（保留兼容 `streamStatus` 汇总，live>reconnecting>polling 优先级）、useJobPolling 每 job 首次 live/reconnect/恢复/降级/终态/取消更新不互相覆盖、UI selected-job 优先（Progress 状态 Tag + notice 走 per-job）、并行隔离/串扰/清理测试 8 项，PresentationStudio 20 files/134 tests；真实 provider、持久化和浏览器 E2E 后置 |
| 2026-08-30 | 完成 C-67 scoped event-journal lifecycle 与 C-68 nested event payload projection：冻结同 scope journal 复用及 C-63 `{ job, artifact }` 事件包的前端投影                            | C-67 codex（Herdr）完成按 userId+sessionId 隔离的显式 cache/factory、并发去重、reset/dispose 与 publisher/SSE 复用；C-68 claude（Herdr）完成 nested/legacy 投影、seq 幂等、非法事件安全忽略与 bytes/path/workspace 白名单过滤；定向综合 42 files/322 tests 通过。真实持久化、provider 与浏览器 E2E 后置；清舟素材和 ppt-master 未改                                                                                                                                                                                                         |
| 2026-08-31 | 完成 C-69 Presentation route journal binding bundle：冻结由同一 scoped cache 生成 SSE journal 与 generation publisher 两个 route seam 的装配方式                                   | codex（Herdr）完成 `createPresentationRouteJournalBindings`，透传服务端 scope、jobId、Request、now；同/跨 scope、publisher→SSE replay、reset/dispose 错误测试通过；C-69 相关 22 files/202 tests，根端追加 94 项定向回归通过。仍需外部显式装配，真实数据库/Redis、provider 与浏览器 E2E 后置                                                                                                                                                                                                                                                 |
| 2026-08-31 | 完成 C-70 Presentation runtime composition manifest：冻结 capability、generation context、scoped journal 与 route factories 的显式组合根                                           | codex（Herdr）完成 `createPresentationRuntimeComposition` 与 8 项测试；复用 C-69 bundle，支持 cache/loader、scope/jobId/Request/now 透传、同 scope replay、输入校验、幂等 reset/dispose，缺 provider 返回 `PROVIDER_UNAVAILABLE`；C-70 回归 23 files/210 tests，根端复核 86 项通过。仍未改 Next route，真实 provider/数据库与浏览器 E2E 后置                                                                                                                                                                                                |
| 2026-08-31 | 完成 C-71 Next route composition manifest wiring：冻结组合根直连 generation/SSE route 及冲突注入保护                                                                               | codex（Herdr）完成 route `composition` 可选注入、composition-only generation/SSE、非法/冲突配置结构化 400 与旧逐项 seam 回归；route 45/45、根端 C-69/C-70/route 69/69，定向 ESLint/Prettier/diff-check 通过。route 不持有或销毁 cache；真实 provider、数据库与浏览器 E2E 后置                                                                                                                                                                                                                                                               |

### C-72 Nested event job ownership hardening

**目标**：在前端消费 C-63 嵌套事件时，以 wire event 的 `job_id` 作为唯一归属，防止恶意或错误 payload 中的 `data.job.jobId` 把 artifact 挂到另一任务。

**原子要求**：

- 仅修改 `src/features/PresentationStudio/**` 及对应测试；nested `data.job` 快照若 `jobId` 与 `event.job_id` 不一致，必须安全忽略或重写为事件 job 归属，不能污染其他 job 的 `jobOrder`/`artifactIds`。
- artifact/artifactIds 始终关联 `event.job_id`；不得凭空创建未知 job；保持 C-68 的 seq 幂等、非法事件计数与 bytes/path/workspace 过滤。
- 不改 RuntimeClient、后端 route、数据库、清舟或 ppt-master，不 commit/push。

**验收**：不一致 jobId 的 nested bundle、跨 job 隔离、重复/乱序和既有 C-68/C-66 套件；定向 ESLint/Prettier/type-check。

| 2026-08-31 | 完成 C-72 Nested event job ownership hardening：冻结 `event.job_id` 为前端事件唯一归属 | claude（Herdr）落盘 nested bundle 归属保护与不一致 jobId 测试；root 复核并补齐覆盖，PresentationStudio 定向 24/24 后扩展为 14 项事件投影测试、相关 ESLint/Prettier 通过。claude 外部终端未能输出规范回报（manual/余额异常），不影响代码验收。 |

### C-73 Production provider readiness seam

**目标**：在不启动外部进程的前提下，提供可被部署健康检查调用的 PPT provider readiness 结果，区分“未配置”“配置合法但尚未执行”和“配置非法”。

**原子要求**：

- 仅修改 `src/server/runtime/presentation/production-command.ts` 及对应测试；新增显式 `inspect/resolveProviderReadiness`（名称可等价）返回 typed 状态，不读取客户端 header、不访问数据库、不执行命令。
- readiness 必须复用现有 provider 配置校验和 `PROVIDER_UNAVAILABLE`/`PRESENTATION_INVALID` 错误码，返回 provider、runnerId、command 是否可用等最小安全信息，不泄露 secrets 或完整 argv。
- 不改变 C-40/C-53 `buildArgv` 和真实 runner 行为；未配置 provider 仍 fail-closed，route 由外部决定如何映射 HTTP。

**验收**：合法/缺失/非法配置 readiness、secret/argv 不泄露、现有 production-command 回归；定向 ESLint/Prettier/source tsc。

| 2026-08-31 | 完成 C-73 Production provider readiness seam：冻结无副作用的 provider 健康检查投影 | codex（Herdr）新增 `resolveProviderReadiness`/`inspectProviderReadiness` 与最小安全状态（provider、runnerId、commandAvailable、typed code）；10/10 production-command 测试、定向 ESLint/Prettier/source tsc 与 diff-check 通过。不会启动进程、访问数据库或泄露 argv/secrets；真实 provider 探测后置 |

### C-74 Provider unavailable frontend recovery hint

**目标**：让 PresentationStudio 在 provider 未配置时给用户清晰的“当前不可生成”说明和可恢复动作，不显示伪造进度或成功状态。

**原子要求**：

- 仅修改 `src/features/PresentationStudio/**` 及对应测试；当 `clientError.code === 'PROVIDER_UNAVAILABLE'` 时显示稳定的可访问提示（配置/联系管理员 + 保留当前输入），提供重新提交或聚焦 Composer 的恢复入口。
- 其他错误码的现有展示保持不变；不得把 provider unavailable 转成 completed/failed job，不得清空已存在 jobs/artifacts/lastSeq。
- 继续使用 LobeHub 自有 UI/motion，不接清舟组件或素材，不改 RuntimeClient/后端。

**验收**：provider unavailable、网络错误、输入保留、键盘/aria 提示测试；C-68/C-72/C-66 PresentationStudio 套件和定向 ESLint/Prettier/type-check。

| 2026-08-31 | 完成 C-74 Provider unavailable frontend recovery hint：冻结不可生成提示与恢复入口 | claude（Herdr）在 `PresentationStudio` 增加可访问 warning Alert、配置/管理员指引、重提与聚焦 Composer 操作；store 保留 `lastCreateInput` 并原样重提，不创建伪 job、不清空 jobs/artifacts/lastSeq。providerUnavailable 定向 4/4、相关 store/event 投影 25/25、定向 ESLint/Prettier 通过；PresentationStudio 全套 94/95，唯一失败是既有 closed-loop 轮询时序（期望 Generating 时已 Completed），未改 demo/polling。全仓 type-check 仍有 14 个存量错误，PresentationStudio 相关 0 error |

### C-75 Production provider configuration loader

**目标**：把显式的 PPT provider/runner 配置安全地从部署环境转换为 C-73 可消费的 options，为真实上线准备可审计的配置边界。

**原子要求**：

- 仅修改 `src/server/runtime/presentation/production-config.ts` 及对应测试；输入为注入的 env-like `Record<string, string | undefined>`，不得读取客户端 header、数据库或启动进程。
- 冻结变量：`LOBE_PRESENTATION_PROVIDER`、`LOBE_PRESENTATION_COMMAND_JSON`（JSON 字符串数组）、`LOBE_PRESENTATION_COMMAND_ARGS_JSON`、`LOBE_PRESENTATION_RUNNER_ID`、`LOBE_PRESENTATION_ALLOWED_RUNNER_IDS_JSON`；缺 provider/command 返回可供 C-73 使用的 unavailable options，非法 JSON/空数组返回 `PRESENTATION_INVALID`。
- 不记录或回显完整 command/args；测试必须证明 secret/argv 不进入 readiness projection；不改变 C-40/C-53 command seam。

**验收**：合法/缺失/非法 env、allow-list 与错误码、不可变返回值、C-73 readiness 回归；定向 ESLint/Prettier/source tsc。

| 2026-08-31 | 完成 C-75 Production provider configuration loader：冻结部署 env 到 provider options 的安全映射 | codex（Herdr）新增 `loadProductionPresentationProviderOptions`，仅接受注入 env-like record，解析 JSON command/args/allow-list，缺失 fail-closed，非法值映射 `PRESENTATION_INVALID`，返回防御性冻结对象；C-75+C-73 定向 19/19，ESLint/Prettier/source tsc/diff-check 通过。未接入生产 factory、未启动进程或访问 DB |

### C-76 PresentationStudio recovery interaction hardening

**目标**：在 C-74 已有恢复入口上补齐键盘操作与状态保护，确保重复点击不会产生重复请求，恢复失败仍保留 draft 与原错误。

**原子要求**：

- 仅修改 `src/features/PresentationStudio/**` 及对应测试；resubmit 按钮在请求进行中禁用/显示 loading，重复键盘 Enter/Space 不得并发创建；失败后仍显示 provider unavailable 提示。
- Edit request 必须聚焦 Composer 标题输入并可由键盘触发；不得清空 jobs/artifacts/lastSeq，不得改变网络错误的既有 Alert。
- 继续使用 LobeHub 自有 UI，不接清舟素材或组件，不改 RuntimeClient/后端。

**验收**：键盘/aria、重复提交、恢复失败与输入保留测试；C-74/providerUnavailable 与既有 store/UI 定向套件、ESLint/Prettier/source tsc。

| 2026-08-31 | 完成 C-76 PresentationStudio recovery interaction hardening：冻结重提幂等与可访问交互 | claude（Herdr）在 store 增加 `resubmitting` 重入保护，重提进行中保留 provider Alert 并显式 `disabled`/`aria-busy`，成功才清除错误、失败保留 draft/错误；新增键盘、重复触发、失败恢复测试。providerUnavailable+C-76 8/8、store 37/37（合计 45/45）通过，定向 ESLint/Prettier/source tsc 通过；既有 acceptance closed-loop 轮询时序失败仍后置且未改 |

### C-77 Production provider composition wiring

**目标**：把 C-75 的显式 env-like 配置安全接入现有 production presentation factory/composition，完成“可装配但不自动执行”的上线前闭环。

**原子要求**：

- 仅修改 `src/server/runtime/presentation/production-factory.ts`、`src/server/runtime/presentation/production-factory.test.ts`、`src/server/runtime/production-bootstrap.ts` 及对应测试；如需导出 loader，只能复用 C-75，不得复制解析逻辑。
- 新增显式 composition 函数，参数必须注入 env-like record、runnerFactory、scope/workspace 依赖；禁止直接读取 `process.env`、客户端 header、数据库或在装配阶段启动进程。
- 缺 provider/command 必须保持 `PROVIDER_UNAVAILABLE` readiness；非法配置保持 `PRESENTATION_INVALID`；runner allow-list 与 C-53 规则一致；每个 authenticated scope 获得独立 port，不得跨 scope 共享状态。
- 旧的 `createPptMasterPresentationPortFactory` 签名与 C-40/C-53 command seam 保持兼容；不得修改前端、清舟或 `/home/shiro/Projects/ppt-master`。

**验收**：合法/缺失/非法配置装配、scope 隔离、runner 注入与“未 spawn”断言；C-73/C-75 production-config/production-factory/production-bootstrap 定向测试、ESLint/Prettier/source tsc/diff-check。

| 2026-08-31 | 完成 C-77 Production provider composition wiring：把 C-75 配置安全接入 production factory/bootstrap | codex（Herdr）新增显式 `createPptMasterProductionPresentationComposition`，复用 env-like loader 与 C-73 readiness；bootstrap 只透传已认证完整 scope，缺失/非法配置 fail-closed，runner/workspace 注入且装配阶段不 spawn，保留旧 factory 兼容与冲突保护。4 files/52 tests 通过，定向 ESLint、Prettier、source-only tsc、diff-check 通过；真实 provider/数据库/进程仍后置 |

### C-78 PresentationStudio production-state regression

**目标**：补齐前端在真实 HTTP transport 下的生产态回归与可访问边界，确保 provider 不可用、网络失败、空状态和恢复入口不会伪造任务或破坏已有状态。

**原子要求**：

- 仅修改 `src/features/PresentationStudio/**` 及对应测试；继续使用 LobeHub 自有 `@lobehub/ui`/antd，不接入清舟素材、组件或动画。
- 覆盖真实 HTTP transport 注入下的 provider unavailable、网络错误、恢复失败/成功、已有 jobs/artifacts/lastSeq 保留，以及无 draft 时不显示恢复入口；不得修改 RuntimeClient、后端 route 或 demo transport 语义。
- 生产态 badge/文本必须明确“Runtime HTTP transport”，不能把 demo 或未配置 provider 显示为成功；键盘 focus、`aria-busy`、reduced-motion 现有契约保持。
- 不修复超出本契约的 acceptance closed-loop 时序 flaky；如测试再次暴露，记录为风险而非扩大范围。

**验收**：PresentationStudio providerUnavailable/C-76/相关 store 与路由定向套件，新增生产 transport 回归测试；ESLint/Prettier/source tsc。

| 2026-08-31 | 完成 C-78 PresentationStudio production-state regression：冻结真实 HTTP transport 下的诚实状态与恢复回归 | claude（Herdr）新增 `productionTransport.test.tsx`，通过真实 `RuntimeClientImpl` + 注入 fetcher 覆盖 provider unavailable、网络错误、恢复成功/失败、已有 jobs/artifacts/lastSeq 保留、无 draft 无恢复入口、Runtime HTTP badge 与 reduced-motion；8/8 新增、PresentationStudio 全套 17 files/107 tests、定向 ESLint/Prettier/source tsc 通过。未改 RuntimeClient、后端 route、demo 或清舟；acceptance 时序问题本轮未复现但仍记录为风险 |

### C-79 Provider readiness HTTP projection

**目标**：将 C-73/C-75/C-77 的无副作用 readiness 状态以最小 HTTP 投影暴露给部署健康检查，明确区分已配置、未配置和非法配置。

**原子要求**：

- 仅修改 `src/app/(backend)/api/runtime/presentation/[[...path]]/route.ts`、对应 route 测试及必要的 server-only 导出；不得读取客户端伪造的 scope/header，不得在 readiness 请求中启动 runner、访问数据库或记录完整 argv/secrets。
- 新增显式 `GET` readiness 分支，必须使用注入的 production composition/readiness seam；`PROVIDER_UNAVAILABLE` 映射 503、`PRESENTATION_INVALID` 映射 400，合法但未执行的配置只返回最小安全字段（provider、runnerId、commandAvailable、code）。
- 现有 jobs/events/artifacts 路由和错误 wire 格式保持兼容；未注入 production seam 时继续 fail-closed，不得伪造 ready。

**验收**：合法/缺失/非法 readiness HTTP 响应、secret/argv 不泄露、无 spawn/DB 断言、既有 presentation route 回归；定向 ESLint/Prettier/source tsc/diff-check。

### C-80 PresentationStudio export failure recovery

**目标**：补齐 PPTX/SVG 导出失败时的可访问提示与重试入口，确保导出错误不丢失选中工件、不伪造下载成功。

**原子要求**：

- 仅修改 `src/features/PresentationStudio/**` 及对应测试；继续使用 LobeHub 自有 UI/antd，不接入清舟素材、组件或动画。
- 导出网络错误、后端结构化错误和空二进制必须显示稳定 Alert；保留 selectedJobId/selectedArtifactId、artifact 列表和 composer draft，提供键盘可达的 retry export；成功后才触发一次真实下载并清除错误。
- 不修改 RuntimeClient、后端 route、demo transport 或现有 provider-unavailable 语义；reduced-motion 与 aria-busy 契约保持。

**验收**：SVG/PPTX 导出成功、失败、重试、空二进制与状态保留测试；PresentationStudio 全套定向测试、ESLint/Prettier/source tsc。

### C-81 ImageGenerationPort 与 provider manifest 基础契约

**目标**：在 runtime-contracts 中定义 wire-safe 的图像生成基础契约：请求/结果、
AssetRef/AssetMetadata、provider manifest 与稳定错误码，以及一个 provider 无关的
`ImageGenerationPort`，为后续 ppt-master 等 provider 适配提供不绑定厂商的 seam。

**原子要求**：

- 仅修改 `packages/runtime-contracts/src/index.ts`、`packages/runtime-contracts/src/index.test.ts`
  与本契约文档；不实现真实 provider、不读 `process.env`、不 spawn、不改 ppt-master/清舟。
- `ImageGenerationRequest`/`ImageGenerationResult` 全部字段 JSON 可序列化；二进制
  禁止出现在任何 wire 形状中（禁止 `Uint8Array`/`Buffer`），生成结果以 `AssetRef`
  （opaque `ref`，非本地路径）+ `AssetMetadata`（createdAt/mimeType/sizeBytes/
  providerMetadata 投影）表示。
- `ImageGenerationPort` 暴露 `providerId`、`manifest`、`generate(request, context)`
  与 `resolveAsset(scope, ref)`；`ImageGenerationContext` 必须携带注入的
  `RuntimeScope`（fail-closed）、可选 `traceId`/`timeoutMs`/`AbortSignal`（取消映射
  `IMAGE_CANCELLED`）；`idempotencyKey` 为调用方幂等键，`supportsIdempotency` 在
  manifest 中声明。
- 稳定错误码集合 `IMAGE_GENERATION_ERROR_CODES`：`IMAGE_REQUEST_INVALID`、
  `IMAGE_PROVIDER_REJECTED`、`IMAGE_BUDGET_EXCEEDED`、`IMAGE_CANCELLED`、
  `IMAGE_PAYLOAD_INVALID`、`IMAGE_UNAVAILABLE`；错误形状为 `RunError` 风格的
  `ImageGenerationError`。
- 保持现有 `PresentationPlan`/C-51/C-52 类型与既有导出完全兼容（仅追加，不改名/不改形）。

**验收**：契约测试覆盖错误码常量、port 投影（generate/resolveAsset/manifest 一致性）、
请求/错误/AssetRef 的 JSON 可序列化往返与 manifest 类型；runtime-contracts 套件与
定向 ESLint/Prettier/source tsc 通过。真实 provider、资产存储与 HTTP seam 后置。

| 2026-08-31 | 完成 C-79 Provider readiness HTTP projection：冻结 readiness 健康检查 HTTP 投影 | codex（Herdr）新增 GET `/api/runtime/presentation/readiness`，复用 C-73/C-77 readiness seam，合法配置返回最小安全字段，未配置→503、非法→400，scope-free 且不 spawn/读 DB/泄露 argv；presentation route 与组合回归 104/104，定向 ESLint/Prettier/source tsc/diff-check 通过 |

| 2026-08-31 | 完成 C-80 PresentationStudio export failure recovery：冻结导出失败诚实提示与恢复路径 | claude（Herdr）在 store 增加 `exportError`、空 payload 失败判定、失败 retry 与 C-60 `clientError` 兼容；UI 增加可访问 Retry export/aria-busy，保留选择、artifact、draft；修复 completed restore 的首 job 选中与 artifact hydration。C-80 定向组合 6 files/52 tests、单文件 exportRecovery 7/7、providerUnavailable 8/8、acceptance 9/9、perJob 1/1 通过，ESLint/Prettier/source tsc 通过；并行全套 18 files/114 tests 偶发时序 flaky 记录为风险，未修改既有 acceptance |

| 2026-08-31 | 完成 C-81 ImageGenerationPort 与 provider manifest 基础契约：冻结 provider 无关的 wire-safe 图像生成 seam | claude（Herdr）在 runtime-contracts 追加 `ImageGenerationRequest`/`ImageGenerationResult`、`AssetRef`/`AssetMetadata`（禁止 Uint8Array/Buffer，opaque ref 非本地路径）、`ImageGenerationPort`（providerId/manifest/generate/resolveAsset）、`ImageGenerationContext`（注入 RuntimeScope fail-closed、traceId/timeoutMs/AbortSignal→IMAGE_CANCELLED、idempotencyKey）与 `ImageProviderManifest`（supportsIdempotency/supportedMimeTypes/maxImagesPerRequest），稳定错误码 `IMAGE_GENERATION_ERROR_CODES` 六枚；契约测试 6/6 覆盖错误码、port 投影与 JSON 往返，仅追加不改既有导出，PresentationPlan/C-51/C-52 兼容。真实 provider、资产存储与 HTTP seam 后置 |

### C-82 Presentation asset store 与图像生成事件模型

**目标**：在 C-81 wire-safe 图像生成契约之上冻结 server-only 资产存储与生命周期事件 seam，
为后续 provider、SSE 和持久化适配提供可替换的内存实现；本条款不启动真实 provider 或进程。

**输入/输出**：

- `InMemoryPresentationAssetStore` 接收服务端认证的 `{ userId, sessionId }`、`AssetRef`、
  `AssetMetadata` 投影、可选内部 `Uint8Array` 和幂等键；`now` 与 key-addressed storage
  通过构造参数注入。`put/get/remove` 返回或操作 `PresentationAssetSnapshot`/内部存储记录，
  snapshot 只允许 `AssetRef` 与 `AssetMetadata`。
- `ImageGenerationEventPublisher` 接收 `jobId`、六类事件 type、可选 `assetId`/安全 data、
  幂等键和服务端 scope；返回带 `jobId`、scope、`seq`、`idempotencyKey` 的 JSON-safe 事件。
  journal 支持 replay、live subscribe 和 disposer。

**不变量与错误语义**：

- 资产和事件实例按 user/session 隔离；同 scope 的相同幂等输入可重复返回，资产 ref 重复或
  幂等键绑定不同对象分别抛 `ASSET_DUPLICATE`/`ASSET_IDEMPOTENCY_CONFLICT`；缺失抛
  `ASSET_NOT_FOUND`，跨 scope 抛 `ASSET_SCOPE_MISMATCH`。
- 每个 job 的事件 `seq` 单调递增；重复/旧 seq 不重新通知，幂等键冲突抛
  `ASSET_IDEMPOTENCY_CONFLICT`。不完整 scope、非法 type/data 和生命周期关闭分别保持
  `ASSET_SCOPE_MISMATCH`、`ASSET_EVENT_INVALID`、`ASSET_EVENT_JOURNAL_DISPOSED`/
  `ASSET_EVENT_PUBLISHER_DISPOSED`。
- 事件 type 至少覆盖 accepted、started、progress、asset ready、failed、cancelled；data
  只做防御性 JSON 投影，过滤完整 prompt、secret/token、bytes、path、workspace、argv 等字段。
  `Uint8Array` 仅可留在 server-only 内部记录，绝不进入 runtime-contracts 或 wire snapshot。

**测试证据、禁止越界与回滚点**：

- C-82 targeted tests 覆盖注入 clock/storage、scope 隔离、put/get/remove、幂等/冲突、缺失、
  事件六态、seq/replay 去重、敏感字段过滤、订阅取消和幂等 dispose；后续 provider/SSE 可
  通过 port 接入而无需改变事件形状。
- 本条款禁止 process.env、客户端 header、数据库/Redis、HTTP、真实 provider、文件系统路径
  或 process spawn；不修改 C-81 runtime-contracts。生产接线失败时回滚为未注入 store/
  publisher，保留现有 C-59～C-81 行为，不伪造 asset ready 或 completed。

| 2026-08-31 | 完成 C-82 Presentation asset store 与图像生成事件模型：新增 scope-isolated server-only asset store、wire-safe generation event journal/publisher 及 targeted 契约测试；未接入 provider、数据库、HTTP、客户端 header 或进程，后续持久化/真实图像生成仍后置 |

### C-83 SlideScene / SceneNode 场景图契约

**目标**：在 runtime-contracts 中定义 wire-safe、厂商无关、可同时驱动 SVG/PPTX 渲染与
前端编辑的幻灯片场景图契约：`SlideScene` + `SceneNode` 判别联合（image/text/shape/
table/chart/group）、坐标/尺寸/zIndex/crop/rotation、通过 C-81 `AssetRef` 引用二进制
资产，以及 `referenceImage` 再生对照。

**原子要求**：

- 仅修改 `packages/runtime-contracts/src/index.ts`（在 C-81 之后追加）、
  `packages/runtime-contracts/src/index.test.ts` 与本契约文档；不改旧类型，不实现
  renderer/provider，不读 env/DB，不 spawn，不改 ppt-master/清舟。
- 禁止 `Uint8Array`/`Buffer` 出现在任何场景图 wire 形状中；image 节点必须通过
  `AssetRef.asset` 引用资产，`referenceImage` 亦为 `AssetRef`；text/table/chart 数据
  仅为 plain-text/数字，禁止嵌入 HTML/Markup/脚本。
- 节点契约：`id` 非空且场景内（含 group 递归）唯一；`rect` 坐标/尺寸为有限非负数且
  必须落在 `SLIDE_SCENE_CANVAS`（4096×4096 预算）内；`zIndex` 决定绘制顺序；`rotation`
  为顺角度数；`crop` 为非负源像素窗口；`locked` 节点可见但编辑器拒绝变更；group 不裁剪
  不变换子节点。
- 提供纯数据验证辅助 `validateSlideScene(scene): SlideSceneValidation`，错误码固定为
  `SLIDE_SCENE_ERROR_CODES`：`SCENE_INVALID`、`SCENE_NODE_ID_INVALID`、
  `SCENE_GEOMETRY_INVALID`；验证无副作用、不抛异常、稳定错误对象返回。
- 保持 C-51 `PresentationPlan`/C-81 全部导出兼容（仅追加，不改名/不改形）。

**验收**：契约测试覆盖错误码常量与画布预算、全部六种节点 kind 的合法场景（含嵌套
group 的递归 id 采集）、场景整体 JSON 往返无损、重复/嵌套重复 id、负坐标与画布超限、
非法场景形状全部映射稳定错误码；runtime-contracts 套件与包级 source tsc、Prettier 通过。
真实 renderer、编辑器接线与 HTTP seam 后置。

| 2026-08-31 | 完成 C-83 SlideScene / SceneNode 场景图契约：冻结 wire-safe 厂商无关的可编辑幻灯片场景图 | claude（Herdr）在 runtime-contracts C-81 之后追加 `SlideScene`（sceneId/canvas/metadata/referenceImage）、`SceneNode` 判别联合（image/text/shape/table/chart/group，image 走 C-81 `AssetRef`，text/table/chart 仅 plain-text 数据）、`SceneRect`/`SceneCrop`/`SceneRotation` 几何与 zIndex/crop/rotation/locked/editable 语义、`SLIDE_SCENE_CANVAS` 4096×4096 预算与 `SLIDE_SCENE_ERROR_CODES`（SCENE_INVALID/SCENE_NODE_ID_INVALID/SCENE_GEOMETRY_INVALID）及纯函数 `validateSlideScene`（递归唯一 id、有限非负且画布内几何、无副作用稳定错误）；契约测试 9/9（六 kind 全覆盖、JSON 往返、嵌套重复 id、负坐标/超限/非法形状映射），包级 tsc 0 error、Prettier 通过，仅追加不改旧类型，C-51/C-81/C-82 兼容。真实 renderer、编辑器与 HTTP seam 后置 |

### C-85 SlideScene → SVG/PPTX renderer seam

**目标**：提供 server-only 深模块 `SceneRendererPort`，把已验证的 C-83 `SlideScene`
投影为安全 SVG 文本；PPTX 只能由注入的 `convertSvg` converter（C-52 toolchain 或等价
adapter）产生，seam 内绝不 spawn、绝不直接调用 ppt-master。

**原子要求**：

- 仅修改 `src/server/runtime/presentation/scene-renderer.ts`、
  `src/server/runtime/presentation/scene-renderer.test.ts` 与本契约文档；复用
  runtime-contracts 的 `SlideScene`/`SceneNode`/`validateSlideScene`/C-81 `AssetRef`，
  不修改 runtime-contracts、C-82/C-84 文件或前端。
- `createSceneRenderer({ resolveAssetUri, convertSvg? })`：`renderSvg(scene, context)`
  先走 `validateSlideScene`，非法 scene 抛稳定 `SCENE_INVALID`/`SCENE_NODE_ID_INVALID`/
  `SCENE_GEOMETRY_INVALID`（`SceneRendererError`），不伪造 artifact；`convertSvg` 仅在
  注入时出现在 port 上，converter 异常原样透传，seam 不吞错不伪装成功。
- ImageNode 的 `<image href>` 只能来自注入 `resolveAssetUri(scope, asset)`，且仅接受
  `http(s):`/`data:`/`blob:` URI；opaque ref 永不当本地路径，不可解析的 ref 投影为诚实
  的虚线占位框。Text/Table/Chart 输出经过 XML escape（含 `=`→`&#61;` 属性分隔符编码）
  与控制字符过滤，`<script>`/`<img>`/事件属性无法重组。
- 坐标/尺寸、zIndex（升序绘制顺序）、rotation（围绕节点中心的 rotate transform）、
  crop（`data-crop` 投影）、locked（`data-locked`）与 editable 标记
  （`data-scene-node`/`data-z-index`，每节点恰好一次）全部保留在输出中；group 递归
  渲染，深度预算 32。
- 禁止 `process.env`、客户端 header、DB、真实网络与直接调用 ppt-master；PPTX 结果只能
  由注入 converter 返回。

**验收**：测试覆盖六类节点投影、zIndex 绘制顺序、资产 resolver 注入与不可解析占位、
危险 resolver 输出拒绝、XSS/属性注入过滤、非法 scene 稳定错误、rotation/crop/locked
保留、converter 未注入/注入/失败边界；定向 vitest、ESLint/Prettier/source tsc 通过。
真实 ppt-master provider 接线后置。

| 2026-08-31 | 完成 C-85 SlideScene → SVG/PPTX renderer seam：冻结场景图到安全 SVG 的 server-only 投影 | claude（Herdr）新增 `scene-renderer.ts`：`createSceneRenderer({ resolveAssetUri, convertSvg? })` 返回 `SceneRendererPort`，`renderSvg` 先经 C-83 `validateSlideScene`（非法→`SceneRendererError` 稳定 SCENE\_\* 码，不伪造 artifact），按 zIndex 升序投影六类节点，image 经注入 resolver 且仅接受 http(s)/data/blob URI（不可解析→诚实占位框，opaque ref 永不当路径），text/table/chart 全量 XML escape（含 `=` 编码）+ 控制字符过滤，坐标/zIndex/rotation/crop/locked/editable 标记（`data-scene-node`/`data-z-index`/`data-crop`/`data-locked`，每节点一次）保留，group 递归深度 32；PPTX 只能由注入 `convertSvg` 产生（未注入则 port 无该方法，异常透传）。测试 8/8（六 kind、绘制顺序、resolver 注入/占位、危险 URI 拒绝、XSS、非法 scene 四态、元数据保留、converter 边界）；runtime-contracts tsc 0、renderer 专项通过。未接真实 ppt-master/provider，真实转换与 HTTP seam 后置 |

### C-84 多素材图像生成规划、缓存、重试与预算

**目标**：在 C-81 `ImageGenerationPort`、C-82 `PresentationAssetStore` 与事件 publisher
之上提供 server-only 的多素材协调 seam；本条款只负责受限调度和安全投影，不接入真实 provider。

**输入/输出**：

- `ImageGenerationPlanner` 接收服务端 `RuntimeScope`、可选 `jobId`/`AbortSignal` 和素材槽位
  列表。每个槽位至少包含 `slideId`、`slotId`、`prompt`，并可声明 `size`、`quality`、`count`
  与幂等键；校验后仅将 prompt 作为请求字段传给注入的 `ImageGenerationPort`。
- 输出按 `slideId`/`slotId` 稳定排序，每个槽位返回 `ready`、`failed` 或 `cancelled` 状态与
  `AssetRef[]`；资产通过 C-82 store 持久化投影后返回，任何输出不含 bytes、workspace 或路径。

**不变量与错误语义**：

- planner 必须显式注入 image port、asset store、event publisher、时钟和 concurrency/预算；
  不读取 env、客户端 header、数据库，不创建全局 cache。成功槽位按 scope+槽位请求指纹缓存，
  重复计划不重复 provider 调用或事件；失败槽位不缓存，`retry` 只重新执行失败/缺失槽位。
- `concurrency` 限制同时进行的 provider 调用；`maxImages` 限制计划总图数，`maxDurationMs`
  限制计划总耗时。预算超限抛 `IMAGE_BUDGET_EXCEEDED`；调用方取消发布
  `IMAGE_CANCELLED`/返回 `cancelled`；非法计划抛 `IMAGE_PLAN_INVALID`。
- 每个未命中缓存的槽位按顺序发布 accepted、started、progress、asset-ready、failed 或
  cancelled 事件，事件继续携带同一 job/scope，幂等键不含 prompt 全文。provider 无法使用或
  抛出未分类错误映射 `IMAGE_UNAVAILABLE`；非法 provider 结果映射 `IMAGE_PAYLOAD_INVALID`，
  不伪造 ready。

**测试证据、禁止越界与回滚点**：

- C-84 targeted tests 覆盖稳定槽位排序、请求/scope 透传、成功缓存、失败槽位局部重试、
  最大并发、总图数/总耗时预算、AbortSignal、六类事件、provider 错误与非法 payload；
  planner source tsc、ESLint、Prettier 作为接线门禁。
- 本条款禁止 process.env、客户端 header、数据库/Redis、真实网络/provider、spawn、前端接线
  和 runtime-contracts 形状修改；失败或取消时回滚为对应槽位 failed/cancelled 与原有资产/事件
  状态，绝不写入伪造 ready。后续 provider、持久化及 C-87 前端由独立原子任务接入。

| 2026-08-31 | 完成 C-84 多素材图像生成规划、缓存、重试与预算：新增显式注入的 scope-aware planner，支持稳定槽位排序、成功缓存、失败局部重试、并发/图数/耗时预算、取消与 C-82 生命周期事件；planner targeted tests 11/11、source tsc/ESLint/Prettier 通过，真实 provider、持久化和 C-87 前端仍后置 |

### C-87 PresentationStudio 素材槽位与局部重新生成 UI

**目标**：为 PresentationStudio 增加按 `slideId`/`slotId` 的素材槽位面板：展示五态
（queued/generating/ready/failed/cancelled）、诚实占位、单槽位 Retry/Regenerate 与
稳定错误恢复入口；严格复用 LobeHub 自有 `@lobehub/ui`/antd/Zustand/store 约定，
不引入清舟组件/动画或 PPT Master UI。

**原子要求**：

- 仅修改 `src/features/PresentationStudio/AssetSlotPanel/**`（新增）、
  `PresentationStudio.tsx`（仅接入面板）、`store/presentationStore.ts` 及对应定向测试
  与本契约文档；不改后端、runtime-contracts、C-84/C-86 文件。
- store 新增 `slots`（key `${jobId}:${slideId}:${slotId}`）与 `slotRetryPending`；
  `applySlotEvent` 做按槽位 seq 幂等、prompt/vendor 字段一律剥离不入 store、
  ready-without-artifact 不被信任（计 `ignoredEvents`，不伪造 ready）、非法 payload
  可观察忽略；`retrySlot` 通过显式注入 `retrySlotAdapter`（prompt 只存在于 adapter
  请求内部）只重跑该槽位：其余槽位/selected job/artifact/composer draft 零影响，
  re-entrancy guard 防并发，适配器异常映射稳定 prompt-free `errorCode`，pending 标志
  释放；无 adapter 时为诚实 no-op。`dismissSlotError` 清除单槽位错误。
- `AssetSlotPanel`：五态 Tag、aria-busy（generating/retry 中）、键盘可达的原生按钮
  Retry、`role="alert"` 稳定错误码 + Dismiss、空态文案；`createStaticStyles` + cssVar、
  `prefers-reduced-motion` 契约保持；UI 不渲染 prompt。
- 事件驱动接缝：`PresentationStudio` 仅从 selected job 过滤槽位并转发
  retry/dismiss；真实 SSE slot 事件接线后置，当前经 `applySlotEvent` 投影（fake client
  注入测试，不依赖真实网络）。

**验收**：slot 投影测试（seq 幂等、prompt 剥离、伪造 ready 拒绝、跨槽位隔离、畸形
payload 计数）与单槽位 retry 测试（仅该槽位、re-entrancy、失败稳定码、无 adapter
no-op）及面板测试（五态/占位/空态、prompt 不入 DOM、单槽位触发、disabled+aria-busy、
错误 dismiss、键盘 focus/Enter）；定向 vitest、ESLint/Prettier/source tsc 通过。
真实 SSE 接线、真实 provider 后置。

| 2026-08-31 | 完成 C-87 PresentationStudio 素材槽位与局部重新生成 UI：冻结按槽位的状态投影与单槽位重试 | claude（Herdr）新增 `AssetSlotPanel`（五态 Tag、诚实占位/空态、键盘可达单槽位 Retry + aria-busy/disabled、role=alert 稳定错误 + Dismiss、createStaticStyles/cssVar/reduced-motion、prompt 永不入 UI）与 store 扩展（`slots`/`slotRetryPending`、`applySlotEvent` 按槽位 seq 幂等 + prompt/vendor 字段剥离 + ready-without-artifact 不信任 + 畸形 payload 计 ignoredEvents、`retrySlot` 注入 `retrySlotAdapter` 仅重跑该槽位且 re-entrancy guard/异常映射稳定码/无 adapter no-op、`dismissSlotError`）；PresentationStudio 仅接入面板。测试 13 项（slotProjection 7 + AssetSlotPanel 6）全绿，store+panel 定向 50/50，ESLint/Prettier 清零、contracts tsc 0。未改后端/runtime-contracts/C-84/C-86；真实 SSE slot 事件接线与 provider 后置 |

### C-86 参考图视觉差异质量门禁

**目标与输入/输出**：提供 server-only `VisualDiffPort.compare(reference, rendered,
options)`。`reference`/`rendered` 可为 `AssetRef`、渲染器输出文本或由调用方提供的
`Uint8Array`；AssetRef 只能通过注入的 resolver 取得二进制，decoder 与 comparator
均显式注入，seam 不读文件、不联网、不绑定图像库。输出只包含 `score`、`threshold`、
`passed` 与可选的数值 `perRegion`，不携带 bytes、workspace、路径、prompt 或 secrets。

**不变量与错误**：比较必须携带完整 `{ userId, sessionId }` scope，并将同一 scope
传给 resolver/comparator；`passed` 始终由 `score <= threshold` 计算，阈值边界通过，
超过阈值抛 `PRESENTATION_VISUAL_MISMATCH` 并保留失败报告。输入、scope、阈值或
comparator 投影非法抛 `VISUAL_DIFF_INVALID`；AbortSignal 取消抛
`VISUAL_DIFF_CANCELLED`，超出注入的字节/耗时预算抛 `VISUAL_DIFF_BUDGET_EXCEEDED`。
取消、预算和差异失败均不得伪造 `passed: true`。

**测试证据、禁止越界与回滚点**：`visual-diff.test.ts` 覆盖通过、失败、阈值边界、
取消、非法输入/输出、scope+AssetRef resolver 注入和敏感元数据不泄露；定向 Vitest、
ESLint、Prettier 与 source-only tsc 是验收门禁。本条禁止 process.env、客户端 header、
数据库、网络、spawn、具体图像库及 C-87 前端接线；未注入该 seam 或发生失败时回滚为
既有真实 renderer/quality 状态，不创建或伪造 ready/completed。

| 2026-08-31 | 完成 C-86 参考图视觉差异质量门禁：新增显式 decoder/comparator/clock 与 scope/AssetRef resolver seam，稳定 mismatch/invalid/cancel/budget 错误和 wire-safe 报告；7 项 targeted tests 覆盖核心门禁，真实图像库/provider 与前端接线仍后置 |

### C-88 OpenAI-compatible / gpt-image-2 ImageGenerationPort adapter 骨架

**目标与输入**：新增 server-only `OpenAIImageGenerationPort`，显式注入 endpoint、model、
apiKey、fakeable fetcher、可选 asset sink/HTTPS URI resolver 与 `now`；默认 providerId 为
`openai.image`、model 为 `gpt-image-2`。请求只把 C-81 的 prompt、size、quality、count
分别映射为 OpenAI Images API 的 `prompt`、`size`、`quality`、`n`，AbortSignal 原样透传。

**输出与不变量**：OpenAI `b64_json`/data URL/HTTPS URL 结果只投影为 `AssetRef` 与
`AssetMetadata`；二进制可交给显式 sink，URI 可交给显式 resolver，适配器没有默认网络或
存储边界。返回值不含 bytes、prompt、endpoint、完整响应或 apiKey；manifest providerId
与 port 一致，实例内 `resolveAsset` 按 authenticated `{ userId, sessionId }` 隔离。

**错误语义、测试与禁止越界**：非 JSON、空/缺图、非法 image payload 或返回数超过请求
count 映射 `IMAGE_PAYLOAD_INVALID`；HTTP 4xx 映射 `IMAGE_PROVIDER_REJECTED`，5xx/网络
错误映射 `IMAGE_UNAVAILABLE`，AbortSignal 映射 `IMAGE_CANCELLED`，输入/配置非法为
`IMAGE_REQUEST_INVALID`；错误消息不回显 key。测试覆盖请求体与 headers 脱敏、data/url 两类
投影、sink/resolver scope、manifest 默认值、HTTP/非法 payload、取消和隔离；禁止
process.env、真实网络、数据库、文件系统、spawn、真实 provider SDK 与前端接线。

**回滚点**：移除该 adapter 或不在 composition 中注入即可回到未配置的
`IMAGE_UNAVAILABLE`/既有 C-81 seam；本任务不修改 runtime-contracts、C-82～C-86 文件或
任何 route，真实 provider、持久化和生产密钥配置后置。

| 2026-08-31 | 完成 C-88 OpenAI-compatible / gpt-image-2 ImageGenerationPort adapter 骨架：新增显式 fetcher、sink/URI resolver、clock 注入与安全响应投影；12 项 targeted tests 覆盖请求映射、data/url、错误、取消、scope 隔离和 key 脱敏，未接真实网络/provider |

### C-89 C-84 ImageGenerationPlanner runtime capability 封装

**目标与输入**：提供 server-only `createImageGenerationCapability`，显式注入 C-81
`ImageGenerationPort`、C-82 `PresentationAssetStore`、`eventPublisherFactory(scope,
jobId)`、C-84 limits 与 clock。`generate(scope, slots, { jobId?, signal? })` 只接受服务端
完整 `{ userId, sessionId }` scope；publisher 必须通过 `assertScope` 校验后才能启动 planner。

**输出与不变量**：每次调用为该 scope/job 创建独立 planner，不在 capability 内跨调用或跨
scope 缓存；jobId 缺省时生成不含 prompt 的稳定 opaque id。成功、failed、cancelled 和
budget/validation 失败均在 `finally` 释放本次 publisher，factory 返回的 publisher 不会
泄漏。返回值仅为 C-84 `ImageGenerationPlanOutput` 的安全投影，不含 prompt、bytes、
apiKey、path、workspace 或 provider 异常全文。

**错误语义、测试与禁止越界**：scope/输入/装配错误为 `IMAGE_PLAN_INVALID`，总预算为
`IMAGE_BUDGET_EXCEEDED`，取消保留 `IMAGE_CANCELLED`，未分类装配/provider 错误为
`IMAGE_UNAVAILABLE`；planner 槽位状态与 C-84 行为保持兼容。测试覆盖 scope 隔离、每次
publisher 生命周期、成功/失败/取消/预算、显式 jobId、scope mismatch 与敏感字段脱敏；
禁止 process.env、数据库、文件系统、spawn、真实网络/provider、route 或前端接线。

**回滚点**：不注入 capability 即回到直接使用 C-84 planner 的既有行为；移除本 wrapper
不会清理或改变 C-84 planner/cache 语义，也不会影响 C-88 adapter 或 runtime-contracts。

| 2026-08-31 | 完成 C-89 C-84 ImageGenerationPlanner runtime capability 封装：新增按 scope/job 的显式 publisher/planner 生命周期 seam 与 wire-safe 返回投影；8 项 targeted tests 覆盖隔离、释放、取消、预算、scope 错误和脱敏，未接真实 provider/route/frontend |

### C-91 认证 Runtime HTTP image-generation seam

**输入/输出**：在既有认证边界下提供精确的
`POST /api/runtime/presentation/image-generation`。handler 接收服务端解析的完整
`RuntimeScope` 与显式注入的 C-89 `ImageGenerationCapability`；body 必须是 plain object，
包含非空 `slots` 数组，每个槽位必须有非空 `slideId`、`slotId`、`prompt`，并可选正整数
`count`、非空 `size`/`quality`，顶层 `jobId` 可选。调用 capability 时透传规范化槽位与
`{ jobId?, signal: request.signal }`；响应只包含 `jobId`、服务端 scope 与安全槽位投影。

**不变量**：scope 只能来自既有 server-side `generationScopeFactory`/认证 session，禁止
读取或信任客户端 session header、process.env、数据库；未知 body 字段不得进入 capability。
prompt 不得出现在响应、错误或日志中，响应不得包含 bytes、path、workspace、apiKey 或
provider 原始异常。未配置 image capability 不创建假 provider，诚实返回
`PROVIDER_UNAVAILABLE`/503；已配置 capability 的内部不可用保持 `IMAGE_UNAVAILABLE`/503。
旧 generation、jobs、events、artifacts 与 port 路径保持兼容。

**错误语义与测试证据**：method/body/slot/scope 校验为 `IMAGE_PLAN_INVALID`/400；预算为
`IMAGE_BUDGET_EXCEEDED`/429；取消为 `IMAGE_CANCELLED`/499；内部 provider 不可用为
`IMAGE_UNAVAILABLE`/503；未配置 seam 为 `PROVIDER_UNAVAILABLE`/503；scope 用户不匹配
沿既有认证错误投影为 403。handler 与 route targeted tests 覆盖服务端 scope、鉴权拒绝、
非法 body、成功/错误状态、取消/预算/未配置、prompt/二进制/路径脱敏及旧路由兼容。

**禁止越界与回滚点**：本条不接真实网络/provider、数据库、客户端 header、前端、清舟或
`ppt-master`，不修改 C-84/C-89 本体或 OpenAI adapter。移除 image capability 注入即可
回滚到诚实的 `PROVIDER_UNAVAILABLE`，不改变旧 presentation seam。

| 2026-09-01 | 完成 C-91 认证 Runtime HTTP image-generation seam：新增 prompt-free handler 与 scope-aware route 分支，覆盖未配置 `PROVIDER_UNAVAILABLE`、内部 `IMAGE_UNAVAILABLE`、取消/预算错误、脱敏和旧路径兼容；未接真实网络/provider |

### C-94 PresentationRuntimeComposition image-generation 显式装配

**输入/输出**：`PresentationRuntimeCompositionOptions` 可显式注入 C-89
`imageGenerationCapability`；composition 原样暴露同一 capability identity，并继续输出既有
generation handler、`jobEventJournalFactory` 与 `generationEventPublisherFactory`。Next
presentation route 在 composition 存在时从 composition 取得 image capability，调用前仍由认证
边界提供 `generationScopeFactory` 解析的服务端 `{ userId, sessionId }` scope。

**不变量与错误语义**：composition 装配阶段只做接口校验，不执行、不缓存 image capability；
composition 自带 capability 时允许该内部配置，但外部 `options.imageGenerationCapability`
重复注入必须 fail-closed，返回 `PRESENTATION_COMPOSITION_OPTIONS_INVALID`/400。composition
未提供 capability 时 image-generation 仍诚实返回 `PROVIDER_UNAVAILABLE`/503；capability
内部错误继续沿 C-91 映射。旧 generation/jobs/events/port 路径保持不变。

**测试证据、禁止越界与回滚点**：`composition.test.ts` 覆盖 capability identity、接口校验
以及不执行/不缓存；presentation route targeted tests 覆盖 composition-only generation、
认证 scope 透传、composition-only 未配置错误、重复配置冲突和旧 generation 回归。本文条款
禁止 process.env、数据库、客户端 session header、spawn、真实网络/provider、前端及
`/qingzhou`/`ppt-master` 接线；移除 composition capability 注入即可回滚到 C-91 的
`PROVIDER_UNAVAILABLE` 路径，不改动 C-89/C-91 本体。

| 2026-09-01 | 完成 C-94：将 C-89 ImageGenerationCapability 纳入 PresentationRuntimeComposition 的显式 DI，并接入 route 的 composition-only image-generation 分支；保留认证 scope、旧路由兼容和未配置 provider 的诚实失败语义 |

### C-95 假 provider 图像生成全链路集成测试

**输入/输出**：以测试内注入的 fake `ImageGenerationPort`、内存
`PresentationAssetStore` 与 image/event journal 驱动 C-84 planner、C-89
`ImageGenerationCapability`；将 `image.generation.*` 事件投影为 C-60
`PresentationJobEvent`，通过既有 SSE serializer/replay seam 消费，并把成功槽位的
`AssetRef` 交给 C-85 `SceneRenderer` 的注入式 asset URI resolver。测试输出必须是按
`slideId`/`slotId` 稳定排序的 `ready`/`failed`/`cancelled` 槽位状态、opaque asset refs
及严格 `runtime.v1` SSE 帧。

**不变量与错误语义**：fake provider、asset store、journal 均只存在于测试 harness；同一
`{ userId, sessionId }` 的事件、资产和 SSE replay 可关联，跨 scope 不可读取或渲染。事件
`seq` 严格递增，重复/旧 seq 不产生第二次副作用，`after_seq` 只返回后续事件。accepted、
started、progress、asset-ready、failed、cancelled 类型必须保持真实；provider 失败返回
`IMAGE_UNAVAILABLE` 与 failed 槽位，AbortSignal 返回 `IMAGE_CANCELLED` 与 cancelled 槽位，
二者均不得伪造 asset-ready 或 completed。事件、SSE、slot output 和 scene 投影不得泄露
prompt、apiKey、secret、bytes、path 或 workspace；跨 scope 资产解析保留
`ASSET_SCOPE_MISMATCH`。

**测试证据、禁止越界与回滚点**：`image-generation.integration.test.ts` 的 8 项测试覆盖
成功全链路、SSE `after_seq` replay、seq 幂等/去重、并发 scope 隔离、provider 失败、取消、
publisher 生命周期、renderer scope 校验及混合槽位状态。C-95 只验证既有公开 seam，禁止
修改生产实现、读取 process.env、客户端 header、数据库、真实网络、API key、spawn、
`ppt-master`、清舟或前端；移除该测试文件即可回滚测试覆盖，不改变任何生产行为。

| 2026-09-01 | 完成 C-95 假 provider 图像生成全链路集成测试：8 项测试覆盖 planner→capability→image 事件→SSE replay→资产→scene renderer、scope 隔离、seq 幂等、失败/取消和脱敏；未连接真实 provider 或生产存储 |

### C-98 OpenAI-compatible image provider 生产配置与组合装配 seam

**输入/输出**：提供 server-only 的显式配置 loader，输入为注入的 env-like
`Record<string, string | undefined>`，仅读取 `OPENAI_BASE_URL`、`OPENAI_API_KEY` 与可选的
`OPENAI_IMAGE_MODEL`；再输入显式注入的 fetcher、可选 asset sink/URI resolver、clock 与
provider id，输出 C-88 `ImageGenerationPort` adapter 所需的内部配置或组合后的 port。base URL
允许主机根路径、`/v1` 或已有 generations 路径，统一输出唯一的
`https://host/v1/images/generations`；model 缺省为 `gpt-image-2`。

**不变量与错误语义**：模块绝不读取 `process.env`，不访问网络/数据库/文件系统，不 spawn；
装配阶段不调用 fetcher、asset sink 或 clock。缺少 base URL、API key 或 fetcher 返回
`PROVIDER_UNAVAILABLE`；非 HTTPS、凭证/查询/片段或不允许路径、非法 model/dependency 返回
`PRESENTATION_INVALID`。API key 只作为 adapter 内部注入值，不进入错误、事件或
`ImageGenerationPort.generate` 的 wire-safe 返回；scope 不在配置中伪造，始终由调用方在
`ImageGenerationContext.scope` 传入并由 C-88 继续校验。

**测试证据、禁止越界与回滚点**：`production-image-config.test.ts` 覆盖根路径与 `/v1` 归一化、
默认/自定义 model、缺配置、非法 URL、依赖校验、装配无副作用、注入 sink/clock/fetcher、
调用方 scope 隔离、组合形式和凭证脱敏；定向 Vitest、source-only tsc、ESLint、Prettier 与
`git diff --check` 是本条验收证据。禁止修改 C-88 adapter 核心、前端、数据库、`/qingzhou`
或 `/home/shiro/Projects/ppt-master`，禁止真实 provider/网络与密钥探针。移除本 loader 或不
注入 production port 即可回滚到未配置的 provider 状态，不改变既有 fake provider seam。

| 2026-09-01 | 新增 C-98 OpenAI-compatible image provider 的显式 env-like 配置与 C-88 组合装配 seam；HTTPS endpoint 归一化、默认 gpt-image-2、缺配置 fail-closed 与 caller-owned scope 由定向测试覆盖，未连接真实网络或写入真实密钥 |

### C-100 PresentationRuntimeComposition OpenAI image port 显式装配

**输入/输出**：`PresentationRuntimeCompositionOptions` 增加可选
`imageGenerationPort`、`imageGenerationAssetStore` 与
`imageGenerationEventPublisherFactory`。三项依赖同时提供时，composition 在装配阶段创建
C-89 `ImageGenerationCapability` 并通过 `imageGenerationCapability` 原样暴露；调用时继续
由 capability 接收服务端 `{ userId, sessionId }` scope。仍可直接注入已有
`imageGenerationCapability`，不要求 provider、存储或事件实现了解 HTTP。

**不变量与错误语义**：直接 capability 与任一内部装配依赖同时出现时，fail-closed 为
`PRESENTATION_COMPOSITION_OPTIONS_INVALID`；三项依赖不完整时不创建 capability，保留
`PROVIDER_UNAVAILABLE` 回退。完整依赖只做接口校验与对象装配，不调用 provider、asset store、
event publisher、网络或进程；scope 不从配置生成或伪造。composition `dispose()` 幂等释放
已有 scoped journal，并调用注入 capability 的可选 disposer；C-89 每次调用仍释放其
publisher，旧 generation/port/journal 行为不变。

**测试证据、禁止越界与回滚点**：`composition.test.ts` 覆盖三项 DI 创建 C-89 capability、
provider 与事件 publisher 的调用时 scope 透传、装配无副作用、部分依赖的诚实 unavailable、
直接 capability 冲突以及 capability/journal dispose。定向 composition、route、image capability
Vitest，source-only tsc，ESLint，Prettier 与 `git diff --check` 为验收门禁。本条禁止
process.env、客户端 header、数据库、真实网络/provider、spawn、前端、`/qingzhou` 与
`ppt-master`，不修改 C-88/C-89 本体；移除三项 image DI 即回滚到 C-94/C-91 的未配置路径。

| 2026-09-01 | 完成 C-100：PresentationRuntimeComposition 支持显式 image port、asset store 与事件 publisher factory 装配 C-89 capability；保留 direct capability/legacy generation 兼容、scope 透传、fail-closed 冲突与 journal/capability 生命周期语义 |

### C-101 Runtime production bootstrap image composition

**输入/输出**：`initializeRuntimeProduction()` 保持既有
`facadeFactory`/`scopeResolver`/PresentationPort 签名，并可额外接收显式
`imageGeneration` 配置：env-like `Record<string, string | undefined>`、C-88 fakeable
`fetcher`、可选 `assetSink`、C-100 兼容的 `assetStore`/事件 publisher factory、可选
scoped journal loader/cache、limits 与 clock。bootstrap 复用 C-98 loader 生成
`ImageGenerationPort`，把 port、C-89 capability（完整依赖时）和 C-100 composition
作为 request scope 的依赖交给既有 `RuntimeFacadeFactory`；未配置 image 选项时输出完全保持
旧 factory 行为。

**不变量**：配置装配阶段不读取 `process.env`、不读取客户端 session header、不访问数据库、
不调用 fetcher/sink/publisher、不启动进程；scope 只由已注入的
`scopeResolver(request, authenticated)` 返回，userId、sessionId、Request identity 必须
通过校验。C-100 journal seam 只在显式提供时复用；无 journal 时可保留 C-89 capability，
不创建隐式全局 journal 或跨 scope 状态。reset 幂等，并恢复原有
`RUNTIME_FACADE_UNAVAILABLE` 回退。

**错误/测试证据**：缺 base URL/API key/fetcher 透传 C-98
`PROVIDER_UNAVAILABLE`，非法组合或不完整 journal 依赖为稳定生产 options error，scope
不完整为 `RUNTIME_PRODUCTION_SCOPE_INVALID`；真实 factory/provider error 不降级为成功。
`production-bootstrap.test.ts` 覆盖 image port/C-100 capability 注入、scope 透传、部分依赖、
缺配置与装配无副作用；定向 production Vitest、source-only tsc、ESLint、Prettier 与
`git diff --check` 是验收证据。

**禁止越界与回滚点**：本条不修改 route、数据库 schema、legacy AgentRuntime、前端、
`/qingzhou` 或 `ppt-master`，不连接真实 provider、不记录或回显密钥。移除
`imageGeneration` 选项即可回滚到 C-34/C-77 旧 bootstrap；配置异常必须保持诚实 unavailable，
不得用默认或客户端值伪造 provider ready。

### C-102 Image generation prompt/slot persistence seam

**输入/输出**：server-only `ImageGenerationPersistencePort` 接收显式
`RuntimeScope { userId, sessionId }`、jobId、slot plan（slideId、slotId、prompt、size、
quality、count/idempotencyKey）以及可选 artifact snapshot/state/error；所有 repository
方法均 Promise 化，并可注入 `ImageGenerationPlanRepository`。`create/get/require/resume/save/
update/remove` 返回仅供服务端恢复使用的记录；`toWire()` 返回无 prompt 的槽位状态、opaque
asset refs、安全 artifact snapshots、job state 和时间戳。`InMemoryImageGenerationPlanRepository`
只作为可替换 fake，复用同一 repository 可模拟重启/重连恢复。

**不变量**：jobId 在同一 scope 的相同 slot plan create 幂等；改变 prompt/slot fingerprint
返回 `IMAGE_PLAN_IDEMPOTENCY_CONFLICT`，不会覆盖旧计划。job、prompt、artifact snapshots
始终绑定 userId+sessionId，跨 scope 的读/改/删返回 `IMAGE_PLAN_SCOPE_MISMATCH`；失败/取消
state 与错误可恢复，缺失为 `IMAGE_PLAN_NOT_FOUND`，dispose 后所有操作为
`IMAGE_PLAN_PERSISTENCE_DISPOSED`。wire projection 不含 prompt、bytes、path、workspace、
argv 或 secret，且返回 defensive copy。

**错误/测试证据**：非法 scope/slot/state 使用 `IMAGE_PLAN_SCOPE_MISMATCH`、
`IMAGE_PLAN_INVALID`、`IMAGE_PLAN_STATE_INVALID`；repository 错误不被吞掉。对应 persistence
targeted tests 覆盖异步注入、重建 adapter 恢复、幂等/冲突、失败/取消、artifact snapshot、
跨 scope、not-found、dispose 及 prompt-free wire；只验证内存 seam，不宣称数据库持久化。

**禁止越界与回滚点**：本条不改 runtime-contracts、SSE/UI、前端、数据库迁移、Redis、
`/qingzhou` 或 `ppt-master`，不读取 process.env/客户端 header。移除 adapter 或改回
repository no-op 即可回滚到 C-84/C-89 既有内存 planner/cache；恢复失败必须保留真实 failed/
cancelled 状态，不伪造 ready/completed。

### C-103 ppt-master Cordis presentation plugin seam

**输入/输出**：新增 `presentation.ppt-master@1.0.0` capability manifest 与
`PptMasterPresentationCapability`。manifest 通过 Cordis `Context.plugin()` 接收显式
`convert(scene, context)` 与 `runner({ jobId, scope, svg, signal })` 函数；converter 返回
SVG 与 editable node identity，runner 返回 opaque artifact ref。成功输出仅包含
`{ jobId, scope, artifactId, artifact, mimeType, editableNodes }`，其中 mimeType 固定为
PPTX OOXML 类型，node 映射保留 scene node id/kind/slideId/editable 语义。

**不变量**：每次 render 校验 authenticated userId+sessionId 与 C-83 scene，scope 原样透传
给 converter/runner；转换和外部 renderer 的真实行为完全由注入函数承担，插件本身不发现
`/home/shiro/Projects/ppt-master`、不拼接 argv、不持有路径、不 spawn。取消返回
`PRESENTATION_WORKER_CANCELLED`，无效 scene/conversion/bytes/path/non-PPTX artifact 返回
`PRESENTATION_INVALID` 或 `PPTX_INVALID`，runner/converter 异常保留 `PPT_MASTER_FAILED`
与 cause；dispose 幂等且后续调用返回 `PPT_MASTER_PLUGIN_DISPOSED`。输出/metadata 过滤
bytes、path、workspace、argv、command、secret、token 与 key。

**错误/测试证据**：`ppt-master-plugin.test.ts` 使用 fake converter/runner 覆盖 manifest、
成功 editable mapping、scope 隔离、取消、invalid scope/scene、真实失败、unsafe artifact
与 Cordis install/dispose；测试不触碰外部项目或真实进程。该 seam 与 C-33/C-40 runner
装配兼容，但不等同于生产 ppt-master 已上线；source-only tsc、ESLint、Prettier 与
`git diff --check` 为验收门禁。

**禁止越界与回滚点**：本条不修改 `/home/shiro/Projects/ppt-master`、前端、数据库、
legacy AgentRuntime、`/qingzhou` 或 C-88 image adapter，不读取 process.env，不执行真实
provider。移除 manifest/capability 注入即可回滚到现有 PresentationPort/C-85 scene renderer
seam；真实 worker、PPTX 文件持久化、部署 factory 与 E2E 仍属于后续任务。

| 2026-09-01 | 完成 C-101/C-102/C-103：production bootstrap 显式接入 C-98/C-100 image seams；新增 scope-safe prompt/slot plan 异步持久化 adapter；新增 ppt-master Cordis manifest、fakeable scene conversion/runner capability；均未连接真实 provider、数据库、进程或外部 ppt-master |

### C-104 Real ppt-master JSONL runner bridge

**目标**：在不改变 C-77 组合边界的前提下，把真实 `ppt-master-runner.py` 接入通用
`PresentationRunner`，并让默认 presentation route 在服务端显式装配它。

**原子要求**：

- runner 仅使用 `shell:false` 的 argv，创建任务后才通过 stdin 写入 JSONL；装配阶段不得
  spawn；stdout/stderr/产物继续受统一输出上限与工作区路径校验约束。
- 产物扫描递归覆盖工作区内的 `.pptx/.svg`，不接受工作区外路径；缺失配置保持
  `PROVIDER_UNAVAILABLE`，非法配置保持原错误码。
- route 只把 `CORDIS_PPT_MASTER_ROOT`、`CORDIS_PPT_RUNNER`、`CORDIS_PPT_PYTHON`
  映射成 C-75 env-like record，sessionId 从服务端认证会话取得，不信任客户端 header。
- 不修改 `/home/shiro/Projects/ppt-master`、`/qingzhou` 或任何 API key；环境变量只存在
  本地部署配置。

**验收证据**：runner、production factory、production bootstrap 与 presentation route 定向
测试通过；使用真实 `ppt-master-runner.py` 完成 1 页 PPTX 探测，产物为有效 OOXML ZIP，
包含 `[Content_Types].xml`。完整浏览器登录链路仍需真实账号会话后验收。

| 2026-09-02 | 完成 C-105-A：新增可插拔多图层素材合成 seam（`AssetCompositionPort`）与内存 fake 实现；严格 fail-closed 校验、scope 隔离、幂等重放与取消语义；无外部图像库/进程依赖 |
| 2026-09-02 | 完成 C-106 / C-108 / C-109：补齐 PPT 生成链路中 GLM 多模态 Chat Provider 生产接线（`GLMMultimodalChatAdapter`、`GLMPresentationPlanner`、`loadProductionGLMChatProviderConfig`、`initializeRuntimeProduction` 装配）；明确环境注入与契约边界 |

### C-105-A Pluggable asset composition seam

**输入/输出**：`AssetCompositionPort` 接收纯 JSON 的 `AssetCompositionRequest`（包含 `canvas`、按 `zIndex` 排序的 `AssetCompositionLayer[]`、`output` MIME/quality、可选 `background` 与 `idempotencyKey`）与注入的 `AssetCompositionContext`（authenticated `RuntimeScope`、可选 `traceId`、`timeoutMs` 与 `AbortSignal`）；输出 `AssetCompositionResult`（包含新建的 opaque `AssetRef`、wire-safe `AssetMetadata`、terminal state `composed` 以及保留 paint order 与 provenance 的 `AssetCompositionLayerResult[]`）。`createFakeAssetCompositionPort` 提供纯内存的 fake 实现，并通过 `resolveSourceAsset` 依赖注入完成源素材解析。

**不变量**：
- 严格只接受 opaque `AssetRef`，拒绝 `data:`、`base64:`、`file:`、绝对路径与相对路径等任何本地/内联 URI；
- scope 匹配、画布尺寸、图层数预算（默认上限 32）、图层矩形（非负、非零、画布边界内）、`zIndex`、`opacity`（`[0, 1]`）、`crop`、`fit`、`rotation` 与 MIME 类型全部 fail-closed 校验；
- 过滤任何 metadata/options 中的 `bytes`、`path`、`workspace`、`apiKey`、`token`、`secret`、`password`、`buffer` 等内部或机密字段；
- 同一 scope 下相同 `idempotencyKey` 重放返回完全一致的结果；相同 key 冲突请求拒绝并抛出 `COMPOSITION_IDEMPOTENCY_CONFLICT`；取消或失败不残留幂等绑定；
- 显式支持 `COMPOSITION_UNAVAILABLE` 语义，无默认进程启动、无 Sharp/ImageMagick 绑定，不破坏 `ImageGenerationPort`。

**错误/测试证据**：稳定错误码：`COMPOSITION_REQUEST_INVALID`、`COMPOSITION_SCOPE_MISMATCH`、`COMPOSITION_ASSET_NOT_FOUND`、`COMPOSITION_LAYER_INVALID`、`COMPOSITION_BUDGET_EXCEEDED`、`COMPOSITION_CANCELLED`、`COMPOSITION_IDEMPOTENCY_CONFLICT`、`COMPOSITION_UNAVAILABLE`、`COMPOSITION_FAILED`。
测试覆盖：`packages/runtime-contracts/src/index.test.ts` 及 `src/server/runtime/presentation/asset-composition.test.ts`。

**禁止越界与回滚点**：不改动前端、route、production bootstrap、`/qingzhou` 或 `/home/shiro/Projects/ppt-master`；不引入外部图像处理库或网络调用；不修改既有 `ImageGenerationPort` 契约。

### C-106 / C-108 / C-109 GLM Multimodal Chat Provider & Production Wiring

> 状态更新（2026-09-04）：PPT 链路已移除 GLM 作为运行时 provider。现行生产装配使用
> provider-neutral 的 OpenAI-compatible 多模态端口，并由 `ANTHROPIC_*`（兼容
> `LOBE_PRESENTATION_CHAT_*`）显式注入 Gemini 等实际模型。文中保留的 GLM 类型名和
> 旧 `BAI_*` 键仅用于已有部署的源码兼容，不再由默认路由注册或选择。

**输入/输出**：
- `GLMMultimodalChatPort` 遵循 OpenAI-compatible `/v1/chat/completions` 标准协议，接收 `GLMChatRequest`（含多模态 `messages`、可选 `model`、`temperature`、`idempotencyKey` 等）及 `GLMChatContext`（authenticated `RuntimeScope`、`AbortSignal`）；输出标准化 `GLMChatResult`。
- `loadProductionGLMChatProviderConfig` 从显式注入的 env-like record 读取 `BAI_API_KEY`（或兼容键 `GLM_API_KEY`、`LOBE_PRESENTATION_CHAT_API_KEY`）、`BAI_BASE_URL`（默认 `https://api.b.ai`）与 `BAI_CHAT_MODEL`（默认 `glm-5.3-flash`）。
- `GLMPresentationPlanner` 消费 `GLMMultimodalChatPort`，将多模态用户需求及参考图片生成结构化的 `PresentationPlan` 与各页 SVG 大纲。

**不变量**：
- **机密保护**：`BAI_API_KEY` 严禁写入源码、单测、git diff 或日志；密钥仅通过运行环境注入并在 HTTP Header `Authorization: Bearer <key>` 中装配；所有错误信息（401/403 等）均净化脱敏为 `CHAT_PROVIDER_REJECTED` / `PROVIDER_UNAVAILABLE`，绝不外泄 raw key。
- **安全拦截器**：强制校验所有图片输入 `assertSafeImageUrl`，拦截并拒绝客户端 `data:`、`file:`、`blob:`、本地系统绝对/相对路径以及 base64 payload，仅允许安全远程 HTTP/HTTPS URL 或服务端解析的 asset ref。
- **Fail-Closed 语义**：未配置密钥或 fetcher 时报 `PROVIDER_UNAVAILABLE`；非法 base URL（非 HTTPS、含凭据、含 search/hash）或空 model 强校验报 `PRESENTATION_INVALID`。
- **零副作用装配**：在 `createProductionGLMMultimodalChatPort` 及 `initializeRuntimeProduction` 装配阶段，严禁任何网络调用、spawn 进程或异步副作用。CI/单测环境下未配置 `BAI_API_KEY` 时 live probe 探针自动且诚实地 skip，不伪造成功。
- **运行时隔离**：严格按 `RuntimeScope { userId, sessionId }` 隔离缓存与会话，支持 `idempotencyKey` 幂等重放与 `AbortSignal` 取消映射（`CHAT_CANCELLED`）。
- **兼容与独立**：保持既有 `ImageGenerationPort` (`gpt-image-2`)、`AssetCompositionPort` 与 `PresentationPort` 兼容，GLM 仅负责多模态视觉对话与大纲生成。

**消费链审计说明**：
- 当前架构中，`multimodalChatPort` 已在服务端 `PresentationRuntimeComposition` 与 `initializeRuntimeProduction` 注入并暴露。
- 前端 `PresentationStudio` 当前通过 `AgentFlow` 在客户端执行多步状态机收集参数并调用 `POST /api/runtime/presentation/jobs`。
- 后续如需将前端对话直接接入后端实时流式多模态推理，可平滑通过已就绪的 `multimodalChatPort` / `GLMPresentationPlanner` 扩展对应 agent 对话路由。

### C-114 `/jobs` 生成主路径协调桥

**目的**：修复前端主入口只调用旧 `PptMasterAdapter`、导致 planner/image/toolchain
完全不执行的问题。`PresentationRuntimeComposition` 在显式注入 generation capability、
context factory 与 artifact store 后，提供按 `{ userId, sessionId }` 隔离的
`generationPortFactory`，并由 presentation route 统一用于 `/jobs` 创建、查询、取消、重试
及 artifact 操作。

**原子要求**：

- `createJob` 立即返回 `queued`，后台按 accepted → queued → planner → worker → artifact →
  completed/failed 发布 SSE；不得把长时间 provider 调用阻塞在 HTTP 创建请求中。
- `input.options.imageSlots` 存在时，先调用注入的 image generation capability，结果以
  `generatedImageSlots` 传入 planner；没有 capability 时不伪造生图成功。
- 同一 scope 的后续请求必须复用同一 generation port，保证任务与 artifact 可查询；不同
  scope 不得串扰；dispose/cancel 必须可重复调用。
- 未提供完整 composition 时保留旧 PresentationPort 兼容路径；缺失 provider 继续返回
  `PROVIDER_UNAVAILABLE`，不伪造 completed。

**验收证据**：`generation-port.test.ts` 覆盖 queued 即时返回、后台完成、取消、image slot
调用与输入注入；composition/route 定向回归 88 项通过；ESLint、Prettier、`git diff --check`
通过。真实 GLM/image/ppt-master provider 仍需在部署层注入后做一次脱敏探测。

### R1-A 跨请求任务一致性与取消幂等

**目的**：修复默认 `/api/runtime/presentation/jobs` 请求因 adapter 实例未按 `{ userId, sessionId }` 缓存复用而导致取消报 `PRESENTATION_NOT_FOUND` 的根因，统一跨 HTTP 请求的任务一致性、幂等取消和重试语义。

**契约保证**：
- **跨请求实例复用**：默认 `defaultProductionPortFactory` 与 `composition.generationPortFactory` 均严格通过 `createScopedPresentationPortCache` 或 scoped map 按 authenticated `{ userId, sessionId }` 复用 port 实例。在同一会话生命周期内，后续 `create`、`get`、`cancel`、`retry`、`getArtifact` 请求命中同一内存任务 registry 与 artifact 存储。
- **取消幂等性**：
  - 对处于 `queued` / `running` 状态的任务执行取消，会触发底层 controller/process abort 并将状态置为 `cancelled`；
  - 对已处于 `cancelled` 状态的任务重复取消，保持幂等返回稳定的 `cancelled` 任务对象（HTTP 200），严禁抛出 `PRESENTATION_NOT_FOUND`；
  - 对已完成 (`completed`) 或失败 (`failed`) 状态的任务执行取消，返回稳定的当前终态对象（HTTP 200）；
  - 仅当任务在当前 scope 不存在时返回 404 `PRESENTATION_NOT_FOUND`。
- **重试语义**：
  - 对 `failed` / `cancelled` / `completed` 任务调用 `retryJob` 时，保留原任务在 registry 中的状态不变，基于原任务的输入数据创建新任务并分配全新 `jobId`，立即返回新任务的 `queued` 快照；
  - 对已处于 `running` / `queued` 的任务调用 `retryJob` 时，直接返回当前任务对象。
- **作用域隔离与安全**：
  - 严格以服务端认证会话（`auth.api.getSession`）获取的 `userId` 与 `sessionId` 隔离，剥除客户端伪造的 `x-session-id` 等 headers；
  - 装配与初始化阶段保持纯函数与零副作用，不发起网络调用、不执行 process spawn。

### R2-A 真实生成组合与 Provider 运行链路

**目的**：让 `/api/runtime/presentation/jobs` 具备真实执行 planner → image provider → worker → artifact 完整链路的能力，支持生产环境注入 GLM 多模态与 OpenAI-compatible 生图能力，产出真实逐页 SVG、素材与 PPTX 文件。

**契约保证**：
- **A1 生产装配**：
  - `createProductionPresentationGenerationComposition` 复用 C-75 配置加载器与 GLM 多模态 planner，接入可注入的 runnerFactory、workspaceFactory、imageGenerationCapability 与 event journal。
  - 装配与初始化阶段严格保持纯函数零副作用：不读取 `process.env`，不访问客户端 headers 或数据库，不发起网络调用，不执行 `spawn`。
  - 缺失或非法配置保持 `PROVIDER_UNAVAILABLE` / `PRESENTATION_INVALID` 稳定错误码，runner allow-list 与 C-53 一致，按 authenticated scope 实例化独立 port。
- **A2 串联生成与素材槽位注入**：
  - 任务包含 `imageSlots` 时，对每个素材槽位校验并规范化 `slideId`、`slotId` 与 `idempotencyKey`；
  - 在 planner 规划前优先调用注入的 `imageGenerationCapability` 生成真实视觉素材，并将产出的 `generatedImageSlots` 注入 planner 提示词与选项；
  - 若请求了 `imageSlots` 但生图 capability 未配置，立即失败并抛出 `PROVIDER_UNAVAILABLE`，严禁伪造生图成功或降级为假完成；
  - 规划器生成真实逐页 SVG 场景，Worker 产出逐页 SVG 文件、素材引用与 PPTX 二进制；
  - 仅在所有 Artifact 写入 `artifactStore` 且确认可读后发布 `completed` 终态事件；
  - 保持旧 factory 签名与 C-40 / C-53 seam 兼容。
- **R2-A-C 路由入口与 Generation Composition 接线**：
  - `route.ts` 启动装配处以现有 C-75 env-like 投影初始化 `createProductionPresentationGenerationComposition`（`configuredDefaultComposition`）；
  - 默认 `/jobs` 路由优先使用 `composition.generationPortFactory` 与 `composition.generationHandler`，贯通真实的 planner → image provider → worker → artifact 完整链路；
  - 保留旧 `portFactory`（`configuredDefaultPortFactory`）作为缺失配置时的兼容回退路径；缺失 provider 时继续返回 `PROVIDER_UNAVAILABLE`，严禁伪造 fake completion；
  - 维持作用域隔离（每个 authenticated `{ userId, sessionId }` 独立实例化与复用 port）与纯函数装配（不在装配阶段读 headers/db、不 spawn、不写 key）。
- **R3-A 页级 Artifact 与恢复 API**：
  - Artifact 存储与桥接层（`artifact-store.ts`、`artifact-bridge.ts`）确保元数据稳定包含 `jobId`、`slideId`、`type`、`mimeType`、`status`、`uri`；
  - 页面 SVG、图片素材、最终 PPTX 独立登记并赋予明确的 `status`（`ready`/`pending`/`failed`），严禁仅返回总 PPTX；
  - 查询任务支持获取已完成页与素材，未完成页保持明确的 `pending`；单页 artifact 读取失败仅影响该页，不污染其他页与全局任务；
  - 客户端通过 `getPresentationJob(jobId)` 查询状态与页级产物，并通过 `subscribePresentationJob(jobId, { afterSeq: lastSeq })` 按 `lastSeq` 增量恢复事件与进度；
  - 导出操作使用后端真实 URI（或二进制下载流），严禁空下载或假成功；保持 `{ userId, sessionId }` 严格隔离与 C-40/C-53 seam 兼容。
- **R4-A 真实 Provider、4 阶段取消、失败持久化与重试验收**：
  - **完整链路生成**：真实/注入 Provider 配置下贯通 planner → image provider → worker → quality check → PPTX 完整管道；产出 PPTX、逐页 SVG 与图片素材均在 `artifactStore` 建立稳定记录并通过 API 可读与下载；
  - **素材与产物同源持久化**：通过 `PresentationArtifactAssetStoreBridge` 将生图层的 `PresentationAssetStore` 与全局 `PresentationArtifactStore` 桥接统一，确保生成的图片素材与 SVG/PPTX 均写入同源持久化存储，并在任务完成时统一纳入 `artifactIds`，可通过 `GET /artifacts/:id` 查询元数据与 `GET /artifacts/:id/download` 下载二进制流；
  - **4 阶段取消幂等**：支持在规划（planner）、生图（image generation）、渲染（page rendering）、转换（PPTX convert）四个生命周期阶段响应 abort 信号，任务终态稳定置为 `cancelled`；重复取消保持幂等返回原终态，不再报 `PRESENTATION_NOT_FOUND`；
  - **确定性失败与持久化**：各类异常（`PROVIDER_UNAVAILABLE`、`IMAGE_BUDGET_EXCEEDED`、`PRESENTATION_QUALITY_FAILED`、`PRESENTATION_WORKER_FAILED`）均产生显式错误码并持久化至任务记录与 Journal，页面刷新/重进可恢复；
  - **重试能力**：`retryPresentationJob` / `POST /jobs/:id/retry` 保留原失败/取消任务终态，并在同一用户会话作用域内创建新任务重新执行；
  - **受保护环境契约**：部署环境通过 `BAI_API_KEY`、`BAI_BASE_URL`、`BAI_CHAT_MODEL` 注入多模态模型凭证，源码、日志、测试与 diff 中绝不写入密钥。未配置 runner 或 provider 时严格 fail-closed 返回 503 `PROVIDER_UNAVAILABLE`，严禁伪造成功。
