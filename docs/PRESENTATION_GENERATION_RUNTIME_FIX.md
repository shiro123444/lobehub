# Presentation 生成链路修复说明

## 原因

旧的 `/api/runtime/presentation/jobs` 只解析 `PresentationPort.createJob()`；
GLM planner、图像 capability、scene/toolchain worker 只存在于独立的
`/generation` seam，主页面从未调用它们。结果是 UI 能拿到任务响应，但不会进入
“规划 → 生图 → 素材注入 → SVG 质量检查 → ppt-master 转 PPTX”的完整链路。

## 现在的契约

当 `PresentationRuntimeComposition` 同时注入 `capability`、`contextFactory` 和
`generationArtifactStore` 时，它会提供按 `{userId, sessionId}` 缓存的
`generationPortFactory`。Presentation route 对 `/jobs`、查询、取消、重试和 artifact
操作统一使用该 port：

1. `createJob` 立即返回 `queued`，不会阻塞 HTTP 请求。
2. 后台调用 generation capability；SSE journal 发布 accepted/queued/planner/worker/
   artifact/completed 或 failed 事件。
3. `input.options.imageSlots` 存在时，先调用 image generation capability，结果以
   `generatedImageSlots` 注入 planner 输入，供 planner/scene renderer 使用。
4. capability 完成后由 artifact store 提供可查询、可导出的 PPTX artifact。

未提供完整 composition 时仍保留旧 `PresentationPort` 工厂，不伪造 completed；缺少
provider 继续返回 `PROVIDER_UNAVAILABLE`。

## 部署要求

生产环境必须在 composition/bootstrap 层显式注入真实 planner、image provider、
artifact store、workspace/toolchain 和 runner。路由层不读取客户端 header、数据库或
密钥，也不会在装配阶段 spawn。`/generation` 与独立 `/image-generation` 端点保持兼容。
