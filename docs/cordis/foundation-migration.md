# Cordis 地基迁移

目标是让通用能力和后续插件共用真实 Cordis 的生命周期、服务和事件机制。当前先迁移 PPT 已使用的原子工具宿主，保留任务协议、资产版本、对话队列与恢复路径。

## 分层职责

- `cordis-foundation`：固定来源的 Cordis 4.0.2 与 Cosmokit 1.8.3 原样源码、许可证及独立声明构建。上游补丁和哈希见 `PROVENANCE.md`。
- `CordisAtomicHost`：把现有工具注册契约接到真实 Cordis Fiber；不重写状态机或事件分发。
- `AtomicRuntime`：输入校验、可信调用上下文、工具发现、调用事件与运行中的版本锁。
- PPT 插件：规划、视觉模板学习、资产处理、渲染、导出和作品恢复。业务状态仍由领域层持久化。

生成中追加指令、页级修改和资产重用继续使用原有业务协议。迁移工具宿主本身不会提升模型的视觉判断，也不会把现有生成编排自动变成自主 Agent loop。

## 迁移契约

候选工具在启动成功前不可见；启动失败必须清除候选并保留旧实现。成功切换后旧插件卸载不能删除新工具。同一任务持有插件版本锁，活动任务结束或取消前不混用新旧实现。

服务器提供用户及会话上下文，每次调用独立创建上下文对象。Cordis Context 的派生不等于业务授权或自动租户隔离；数据服务仍须校验可信 scope。安装的插件必须是宿主信任的代码。

基础包使用正式 workspace 包声明解析。类型检查先生成 vendor 声明，再在根严格配置下检查清舟代码。格式化工具排除 vendor，避免无意改变上游实现。

## 兼容阶段与下一步

旧 `cordis-kernel` 的 Context、PluginManager、Facade 尚有调用者。旧资源清理缺口由独立回归测试约束并作过渡修补，不能以添加基础包代替全平台迁移验收。

后续按独立改动推进：

1. 迁移通用服务和工具桥接，先明确 scoped service 的提供、撤销和依赖重启契约。
2. 将 Agent 的规划、工具执行与观察循环注册为可替换插件，使用类型化事件定义请求拦截及改写边界。
3. 引入 profile、bundle 和配置覆盖，以及受控的 loader / HMR；它们不属于本次 vendored 核心。
4. 让第二个业务插件复用相同宿主，以跨应用测试验证平台能力，而非仅凭 PPT 成功宣称通用性。

## 验证入口

```bash
pnpm --filter @lobechat/cordis-foundation run build:types
bunx vitest run --silent=passed-only src/server/runtime/cordis-atomic-host.test.ts src/server/runtime/atomic-runtime.test.ts
bunx vitest run --silent=passed-only --root packages/cordis-kernel
bunx vitest run --silent=passed-only src/server/runtime/presentation/atomic-recovery.test.ts src/server/runtime/presentation/public-atomic-api.test.ts
bun run type-check
```

声明构建、单测和类型检查分别验证不同契约。真实模型生成的质量、图像服务和办公软件导出需要另作端到端验收。

## 本轮实测记录（2026-09-13）

- 旧内核：17 个测试文件、174 项通过，包含原先失败的 4 项清理回归，以及共享异步 disposer 的顺序与完整等待。
- 运行时与 PPT 集成：10 个测试文件、95 项通过，覆盖真实 Cordis 宿主、候选切换、根卸载、公开接口、任务恢复和 SSE。
- `bun run type-check`、本次生产代码 ESLint、`git diff --check` 均退出 0。格式化后再次核对，上游 17 个源码与许可证文件仍与固定 Git 对象逐字节一致。
- 真实登录后的工具目录：29 个公开工具、39 个运行时工具、3 个已挂载插件。
- 验收任务：`presentation-7c2883ec-7ab2-4c44-ab81-6d0a514efe13`。生成 3 页可编辑 PPTX，含 1 张真实生成 PNG 与 3 页讲者备注；LibreOffice 成功打开并转成 PDF。
- 开发热更新期间任务曾被恢复逻辑标记为中断；通过同一任务的 retry 完成恢复。随后使用公开原子操作 `presentation.job.message` 只修改第 1 页。最终版本 `e8f8b7ef-6b8b-42ea-93f6-a02ca39acb81` 中，第 2、3 页的 PPTX XML 及图片字节与修改前一致。

本机验收文件位于 `/tmp/qz-cordis-acceptance/deck.pptx` 和 `deck.pdf`。这些结果确认本轮接线与回归范围，不代表任意插件的热更、复杂模板还原或所有视觉问题已解决。
