# Cordis 原子能力与 PPT 插件开发

本文记录当前实现（2026-09-12）。接口以 [AtomicRuntime](../../src/server/runtime/atomic-runtime.ts)、[PPT 原子插件](../../src/server/runtime/presentation/atomic-plugin.ts) 和 [GenerationPort](../../src/server/runtime/presentation/generation-port.ts) 为准。

PPT 的生产装配使用真实 Cordis `Context`、`PluginManager` 和 `ToolRegistry`。生成、资产规划、渲染、校验及导出通过注册的操作执行；对话队列、任务恢复和产物版本由 PPT 领域层管理。其他插件可以使用同一个通用运行时，不需要继承 PPT 实现。

## 定义可组合操作

`AtomicPlugin` 包含稳定的 `id`、实现 `version` 和 `operations`。操作包含 `name`、`description`、Zod `input`、可选的 Zod `output`，以及 `execute(input, invocation)`。

- 插件 ID 使用不含 `.` 的单段名称；运行时按操作名的第一段定位插件。
- 操作名以 `${plugin.id}.` 开头，同一个插件内不能重复。
- 输入描述一个有独立价值的动作。复杂的一键流程可以组合多个动作。
- 为公开输入使用 `.strict()`，明确限制文本长度、数量及枚举。输出 schema 可选，但应为稳定的数据协议提供校验。
- `catalog()` 提供操作描述、输入 JSON Schema 和当前插件版本；schema 本身不负责业务资源的所有权检查。

下面的插件无需 PPT 组件即可加载和执行：

```ts
import { z } from 'zod';

import { AtomicRuntime, type AtomicPlugin } from '@/server/runtime/atomic-runtime';

const statistics: AtomicPlugin = {
  id: 'statistics',
  version: '1.0.0',
  operations: [
    {
      name: 'statistics.mean',
      description: 'Calculate the mean of a nonempty numeric series.',
      input: z
        .object({ values: z.array(z.number().finite().min(-1e12).max(1e12)).min(1).max(1000) })
        .strict(),
      output: z.object({ count: z.number().int(), mean: z.number().finite() }),
      execute: ({ values }) => ({
        count: values.length,
        mean: values.reduce((sum: number, value: number) => sum + value, 0) / values.length,
      }),
    },
  ],
};

const runtime = new AtomicRuntime();
await runtime.add(statistics);

// authenticatedScope must come from the host's authentication boundary.
const result = await runtime.invoke(
  'statistics.mean',
  { values: [2, 4, 6] },
  {
    scope: authenticatedScope,
  },
);

await runtime.remove('statistics');
await runtime.dispose();
```

当前兼容性错误码仍包括 `PRESENTATION_INVALID` 和 `PRESENTATION_WORKER_CANCELLED`，即使使用通用运行时也会遇到这两个名称。不要仅凭错误码前缀判断所属插件。

## 可信上下文与资源隔离

`AtomicInvocation` 的 `scope`、`signal`、`jobId`、`services` 和 `onEvent` 由服务器组装。工具参数不应接受用户 ID、会话 ID、服务实例、命令、文件工作区或密钥。

运行时会校验 scope 的形状，但它不验证登录凭据。宿主必须先完成认证，再提供 `{ userId, sessionId }`。默认 PPT 路由从服务器认证会话读取两者，并去除 `x-session-id` 等缓存约定请求头对认证的影响。

持久化服务的每次读写都必须传入可信 scope。现有任务、图片和模板按用户及会话共同隔离；相同用户的新登录会话也不会自动共享旧会话的数据。资源 ID 本身不能证明所有权。

`services` 是进程内的可信依赖：例如 `port`、`plannerContext`、`workerContext` 和上传后的 `Uint8Array`。HTTP 请求不能通过工具参数构造这些对象。新增公开能力时，要提供按当前 scope 解析资源的适配层，再将服务传给内部操作。

当前插件是服务器加载的可信 TypeScript 代码。Cordis 生命周期管理不构成针对恶意插件代码的进程、网络或文件系统沙箱；不要把任意上传的脚本直接作为插件执行。

## 加载、卸载和版本锁

`add(plugin)` 动态安装并挂载插件，`remove(id)` 卸载插件，`replace(plugin)` 替换已安装插件实现。卸载后工具从注册表移除，重新添加同一 ID 的新版本可以重新调用。

每次 `invoke` 自动持有一个 lease。一个跨多个操作的任务还应显式持有整个插件的 lease：

```ts
const release = await runtime.acquire('presentation');
try {
  // Invoke the operations belonging to this logical run.
} finally {
  release();
}
```

有活跃 lease 时，卸载和替换返回 `PLUGIN_BUSY`，调用方应完成或取消任务后再重试。PPT 的 `GenerationPort.run` 已持有整个运行周期的 lease，避免同一次运行混用两版实现。释放函数可以重复调用。

替换使用 Cordis staging：候选激活失败时旧实现继续运行；候选已注册的工具也会清理。使用新的实现版本号发布替换，避免用同一个版本名指代不同代码。

版本锁保护当前进程内的一次运行。插件代码与安装列表尚未作为可恢复的二进制版本仓库持久化；进程重启后加载什么实现仍由宿主装配决定，不能声称历史任务会自动恢复到旧插件代码。

运行时合并调用方取消信号与自身取消信号，并在操作前后检查。实现仍须将 `signal` 传给实际网络请求和子进程。取消不能撤销已经完成的外部副作用。

## PPT 的公开与内部工具

浏览器或 Agent 通过认证路由读取 `GET /api/runtime/presentation/tools`，再向 `POST /api/runtime/presentation/tools/{name}` 发送该操作的 JSON 参数。响应中的 `tools` 是允许公开调用的清单，`runtimeTools` 是内部注册情况，不代表全部可直接调用。

当前公开能力包括：

- `presentation.job.read`、`presentation.page.read`：读取本会话拥有的任务和页面。
- `presentation.page.replace`：指定页替换，需要 `expectedVersionId`、`requestId` 和完整 SVG。
- `presentation.job.message`：在运行中或完成后追加自然语言修改，可指定页码。
- `presentation.job.export`：取得已有版本实际生成的文件，不会把一种文件改标签冒充另一种格式。
- `presentation.template.fromJob`、`list`、`resolve`、`apply`：从当前任务学习模板、查询及应用指定模板版本。

`presentation.plan`、`slide.read`、`slide.replace`、`assets.prepare`、`assets.generate`、`render`、`validate`、`export` 和模板的 `learn`、`import` 属于内部组合能力，按实际 provider 配置注册。比如内部 `slide.replace` 操作内存中的 plan；公开 `page.replace` 则先确认任务所有权、当前版本及任务状态，再进入持久化队列。

新增操作仅注册到 Cordis 不会自动获得 HTTP 调用权限。需要显式补充公开适配器、允许列表和输入校验，并为资源所有权与冲突路径补充测试。

## 对话、版本和恢复语义

自然语言指令使用 `requestId` 去重，依次处理。指定页修改保留其余页面，后续指令能够在生成期间入队。精确 SVG 替换要求任务空闲且 `expectedVersionId` 与当前版本一致，防止覆盖更新的修改。

持久化的可编辑计划与渲染副本分开保存。计划中的平台图片使用 `/api/runtime/presentation/artifacts/{id}?raw=true` 引用；只有交给 Worker 的副本及最终 SVG 产物嵌入图片字节，以支持独立渲染和导出。渲染结果不能反向覆盖可编辑计划，否则后续修改会把整张图片的 base64 放进模型文本上下文。

修改时，Planner 从当前目标页的资源引用读取同 scope 的图片，通过独立的 `trustedImages` 图像输入提供视觉上下文。历史任务若已保存了嵌入图片，会在首次加载时按同 scope、任务关联图片的 MIME 与精确字节匹配还原资源引用并落盘，同时保留 SVG 其他内容。没有匹配到所属资产的嵌入内容不猜测映射，也不读取其他 scope 的资产。

PPT 领域层保存计划、消息状态、文件版本与资产准备结果。`preparedAssets` 的 `initial` 键与带 `message:` 前缀的消息键使用不同命名空间；准备结果在进入后续 Planner 前持久化，规划失败或进程重新创建后可复用，避免再次生成已经保存的图片。资产 ID 随最终产物版本保留。

恢复时，保存为运行中的任务会显式显示中断状态，由 retry 继续。模板 ID 会解析并固定到具体 `versionId`，后续模板更新不会静默改变已经绑定的任务。

这些恢复逻辑属于 PPT 适配器，通用 `AtomicRuntime.invoke` 不自动提供业务幂等、事务或任务持久化。外部服务完成后、准备结果落盘前仍存在中断窗口，不保证外部收费操作严格只执行一次。其他插件应明确自己的请求 ID、重试和副作用策略。

## 模板学习的能力边界

[模板库](../../src/server/runtime/presentation/templates/index.ts) 提供：

```ts
import { FilePresentationTemplateLibrary } from '@/server/runtime/presentation/templates';

const library = new FilePresentationTemplateLibrary({ root: persistentTemplateRoot });
await library.learnFromPlan(scope, { name, plan, templateId });
await library.importPptx(scope, { name, bytes, templateId });
await library.list(scope);
await library.get(scope, templateId, versionId);
const application = await library.resolve(scope, { templateId, versionId });
await library.getSourcePptx(scope, { templateId, versionId });
```

`templateId` 在首次学习或导入时省略；更新已有模板时产生新的不可变版本。模板提取是结构化解析，不训练模型，也不将上传文件发送给训练服务。

从已有 SVG 计划学习颜色、字体层级、元素几何、间距、估算的文字容量和图片槽位，保留参考页面、备注与设计信息。PPTX 导入读取 OOXML 的主题、版式占位、文本、图片槽位、分组变换及备注；忽略外部关系，不执行宏或脚本。上传限制为 32 MiB，并对 XML 展开大小、单文件大小和页面数量设置预算。

`resolve` 返回可检查的 `TemplateApplication`。Planner 收到实际约束和有界的参考布局，资产规划根据布局需求决定复用、生成、替换或移除图片。模板样本的文字是参考数据，不能覆盖当前用户内容和要求。

SVG 文本边界及容量是估算值；旋转、复杂形状、图表和表格在导入参考图中可能近似。原始 PPTX 字节单独保留供将来的原生填充使用。当前流程没有实现任意原生 PPTX 的无损模板填充，也没有承诺完整保留动画、母版语义和所有图表对象。应用模板后仍需校验并检查生成结果。

## 存储、审计与部署边界

`FilePresentationStorage` 保存任务、产物和事件日志；`FilePresentationTemplateLibrary` 保存模板 JSON 版本和源 PPTX。目录按 scope 和资源 ID 哈希隔离，写入使用临时文件后重命名。默认路由为两类存储统一使用 `CORDIS_PRESENTATION_DATA_DIR`，未配置时使用 `.data/presentation`。部署时应把该目录放到持久卷；自行注入存储实例时也要分别配置其持久化根目录。

这是单 Node 主机的文件存储实现，不是 PostgreSQL 事务或分布式任务队列。多实例共享状态、跨主机排他锁、自动过期清理、备份与数据库迁移尚需另外实现。单文件原子替换也不等于任务、产物和日志之间的跨文件事务。

通用运行时的操作事件目前保存在内存，每个 scope 最多保留 200 条，包含操作名、实现版本、开始 / 完成 / 失败及时间。PPT 的任务事件另有文件日志。不要把运行时内存快照当成长期审计记录。

## 验证入口

修改运行时或插件适配器后，选择相关测试运行，避免执行整个仓库测试命令：

```bash
bunx vitest run --silent='passed-only' src/server/runtime/atomic-runtime.test.ts
bunx vitest run --silent='passed-only' src/server/runtime/presentation/atomic-recovery.test.ts
bunx vitest run --silent='passed-only' src/server/runtime/presentation/canonical-plan.test.ts
bunx vitest run --silent='passed-only' src/server/runtime/presentation/templates/library.test.ts
bun run type-check
```

生命周期测试包含非 PPT 插件的动态安装 / 卸载、活跃任务保护、重新安装以及候选激活失败后的旧版本保留。恢复测试经过真实 Cordis 操作注册与执行，模拟资产准备后的 Planner 失败及运行实例重建，检查模板版本绑定、资产版本和跨 scope 隔离。涉及视觉与导出的修改，还需要生成真实 PPTX 并用办公软件打开验收。

生产导出明确使用统一淡入动画，避免转换器按整份文稿累计动画对象数，导致前页修改影响后页动画。局部编辑验收应同时比较未修改页面的 SVG 和 PPTX 页面 XML；已生成图片必须实际嵌入导出文件，讲者备注同时投影到预览元数据和原生备注页。
