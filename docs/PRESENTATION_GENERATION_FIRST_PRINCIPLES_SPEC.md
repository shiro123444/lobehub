# PPT 生成工作台改造 Spec（第一性原理版）

状态：待 root 审核，尚未分派执行  
目标：让 LobeHub 的 PPT 工作台从“展示一个制作中的假界面”变成“可恢复、可取消、可观察、真正调用 planner / image provider / ppt-master 的生成系统”。

## 1. 第一性原理

### 1.1 生成的最小真实定义

一次 PPT 生成只有在以下条件全部成立时，才允许向用户显示“已完成”：

1. 输入已绑定到一个经过认证的 `{ userId, sessionId }` scope；
2. 任务已被后端持久化，创建、查询、取消、重试使用同一个任务记录；
3. planner 已产生并通过校验的逐页计划；
4. 需要视觉素材的页面已调用真实 image provider，并得到可引用的素材结果；
5. 每页 SVG 已生成并通过质量检查；
6. ppt-master 已将 SVG、文字、图片等合成为可编辑 PPTX；
7. PPTX、逐页 SVG 和图片素材均已持久化并可通过 artifact API 查询；
8. `completed` 事件只在上述产物全部可读之后发布。

任何一步没有发生，都不能用占位卡片、估算进度或“看起来完成”的状态替代。

### 1.2 状态的唯一来源

- 后端任务记录是任务状态的权威来源；
- 事件日志是状态变化的追加记录，使用单调 `seq` 和幂等 key；
- 前端 Zustand 只是事件投影，不能自行推断完成、页数、素材或进度；
- 浏览器 `sessionStorage` 只能保存最近的 `jobId` 和 `lastSeq`，不能代替后端任务持久化；
- 任何页面刷新、离开再进入、SSE 断线，都必须从后端查询和事件日志恢复。

### 1.3 任务生命周期

```text
accepted → queued → planning → material_generating
         → slide_rendering → quality_check → exporting
         → completed

任意活动阶段 → cancelling → cancelled
任意非终态阶段 → failed
```

终态只有 `completed`、`failed`、`cancelled`。终态任务的重复取消必须返回原终态，不得重新抛出“job 不存在”。

### 1.4 观察性原则

用户需要看到的是短、真实、可验证的动作，而不是整段提示词：

- “正在分析参考材料”
- “正在规划第 3 页”
- “正在生成第 3 页素材”
- “正在检查页面结构”
- “正在合成可编辑 PPT”

这些文字必须来自后端事件的 `activity` 字段；前端只负责快速打字机呈现。“正在制作 PPT”可以保留慢速打字机标题，但不能代替真实阶段。

### 1.5 UI 复用原则

- 对话区继续复用 LobeHub 的 `ConversationProvider`、`ChatList`、`MessageItem`、`ConversationChatInput`；
- 输入框继续使用 LobeHub 原生模型、附件、加号、智能模式、运行环境、批准模式、上下文窗口和放大能力；
- 生成态可以有 PPT 专用卡片，但卡片只消费真实事件和 artifact，不另造一套聊天系统；
- 清舟素材只作为后续视觉资产来源，不引入清舟不成熟的 UI 或动画组件。

## 2. 当前已确认的问题

### 2.1 取消报 `PRESENTATION_NOT_FOUND`

`src/app/(backend)/api/runtime/presentation/[[...path]]/route.ts` 的默认 `/jobs` 路径调用 `configuredDefaultPortFactory`。该 factory 每次 HTTP 请求都通过 `composition.portFactory(...)` 创建新的 `PptMasterAdapter`。

`packages/cordis-kernel/src/presentation.ts` 中的 `PptMasterAdapter` 使用实例内存保存 `jobs` 和 `artifacts`。因此：

```text
POST /jobs       → Adapter A 保存 job
POST /jobs/cancel → Adapter B 查询不到 job
```

这就是 `job does not exist` 的直接原因。

### 2.2 当前没有真正走完整生成链路

当前默认路径没有安装可用的 `PresentationRuntimeComposition`，而是直接进入外部
`/home/shiro/July/脑机、人工智能导论/runtime/scripts/ppt-master-runner.py`。

该 runner 当前明确是 lightweight vertical slice：

- 初始化 ppt-master 项目；
- 生成占位 SVG；
- 执行 finalize、质量检查和 PPTX 导出；
- 不调用 GLM planner；
- 不调用 image provider；
- 不产生真实的逐页视觉素材。

因此当前“制作中”卡片只代表请求已进入一个占位 runner，不代表完整的 AI 生成已经发生。

### 2.3 当前生成态 UI 是静态投影

`src/features/PresentationStudio/PresentationGenerationWorkspace.tsx` 当前通过页数构造固定卡片，卡片内部是灰色矩形和横线；`stageFor()` 只根据 `queued/running` 推导阶段；进度使用固定或估算值。

前端尚未消费：

- 当前动作；
- 当前 slideId；
- 当前页真实 SVG；
- image provider 返回的素材；
- 每页完成比例；
- 可恢复的阶段快照。

## 3. 任务分派规则

两个 Herdr 终端均使用 agy，但必须以 pane 为唯一目标：

- agy-A：后端 / runtime / provider / persistence；
- agy-B：前端 / PresentationStudio / event projection / visual interaction。

执行规则：

- root 先审核本 Spec，再发送执行提示；
- agy 只执行已写死的子任务，不负责重新定义问题；
- 不修改 `/qingzhou`；
- 不把 API key 写入源码、日志、文档或 git；
- 不 commit/push；
- 不用新的命令打断其他终端正在运行的测试或服务；
- 每个子任务完成后必须正式回报，首行写“我是 agy（Herdr）”，并包含 `status/files/contracts_changed/tests/evidence/risks/next`。

## 4. 四轮实施计划

每轮包含两个原子子任务。A 与 B 可以在同一轮并行，但后一轮必须等待本轮两个子任务的代码和契约审核通过。

### Round 1：建立真实任务根基

#### R1-A（agy-A）：跨请求任务一致性与取消幂等

**目标**：修复 `PRESENTATION_NOT_FOUND` 的直接根因，让创建、查询、取消、重试使用同一任务实例。

**允许修改**：

- `src/app/(backend)/api/runtime/presentation/[[...path]]/route.ts`
- `src/server/runtime/presentation/generation-port.ts`
- `src/server/runtime/presentation/composition.ts`
- `src/server/runtime/presentation/factory.ts`
- 对应后端测试与契约段落

**原子动作**：

1. 将默认 `/jobs` 路径接到按 `{ userId, sessionId }` 复用的 generation port 或持久化 port；禁止每次 HTTP 请求重新构造保存任务的 adapter；
2. 取消操作先按认证 scope 查找任务，再执行 abort；任务不存在、跨 scope、已完成、已失败、已取消分别返回稳定协议结果；
3. 同一个 `jobId` 重复取消必须幂等；
4. 重试必须基于原任务输入创建新任务，并保留原任务终态；
5. 不在 route 内读取客户端伪造的 session header，不在装配阶段 spawn。

**验收**：

- 创建后使用另一条 HTTP 请求查询能得到同一 job；
- 创建后点击取消返回 `cancelled`，重复点击仍返回 `cancelled`；
- A 用户不能读取或取消 B 用户同名 job；
- 服务器进程不重启时，离开页面再回来仍能恢复任务。

#### R1-B（agy-B）：生成态数据模型与原生对话壳边界

**目标**：前端停止从 `queued/running` 猜测页面状态，建立消费真实事件的最小投影，同时保持 LobeHub 原生聊天组件。

**允许修改**：

- `src/features/PresentationStudio/store/presentationStore.ts`
- `src/features/PresentationStudio/hooks/useJobPolling.ts`
- `src/features/PresentationStudio/PresentationStudio.tsx`
- `src/features/PresentationStudio/AgentFlow/PresentationChatInput.tsx`
- 对应前端测试

**原子动作**：

1. 增加按 job 保存的 `stage/activity/currentSlide/totalSlides/progress` 投影字段；字段只能由事件或后端快照写入；
2. 保留 `lastSeqByJob` 的单调去重，未知或非法字段安全忽略；
3. 对话输入继续使用 `ConversationProvider`、`ChatList`、`MessageItem`、`ConversationChatInput`，保留模型、附件、智能、运行环境、批准、上下文和放大入口；
4. 去除将完整用户 prompt 当作制作态主视觉的渲染路径，prompt 只保留在任务输入和必要的对话消息中。

**验收**：

- 前端不再用固定 18%/55% 代表真实进度；
- 没有事件时显示“等待运行时事件”，而不是伪造正在处理某页；
- 原生聊天输入外观和 Agent 页面一致。

### Round 2：接入真实 planner、素材与事件协议

#### R2-A（agy-A）：真实生成组合与 provider 运行链路

**目标**：让 `/jobs` 真正执行 planner → image provider → worker → artifact 的完整流程。

**允许修改**：

- `src/server/runtime/production-bootstrap.ts`
- `src/server/runtime/presentation/production-factory.ts`
- `src/server/runtime/presentation/pipeline.ts`
- `src/server/runtime/presentation/generation-port.ts`
- `/home/shiro/July/脑机、人工智能导论/runtime/scripts/ppt-master-runner.py`（仅在 runner 契约需要升级时）
- 对应 provider / pipeline 测试

**原子动作**：

1. 复用 C-75 loader 和现有 GLM 多模态 planner，不复制配置解析逻辑；
2. 将真实 image provider 作为注入能力接入，每个素材 slot 带 `slideId/slotId/idempotencyKey`；
3. runner 不再生成固定占位 SVG；必须接收 planner 结果和素材引用，并产出真实逐页 SVG、PPTX 和 artifact 元数据；
4. 只在 artifact 已写入并可读取后发布 `completed`；provider 不可用时返回 `PROVIDER_UNAVAILABLE`，输入非法时返回 `PRESENTATION_INVALID`。

**验收**：

- 一次真实请求能观察到 planner、素材、页面、质量检查、导出事件；
- 至少一个页面 artifact 含真实 SVG URI，一个素材 slot 含真实图片 artifact URI；
- 输出 PPTX 是可打开的 OOXML，页面文字和图片仍可编辑或可替换；
- 没有 provider 时不会显示“完成”。

#### R2-B（agy-B）：事件协议投影与短进度播报

**目标**：把后端页级事件转换成简洁、真实、稳定的前端状态。

**允许修改**：

- `src/server/runtime/presentation/publisher.ts`（若仅补充 wire-safe 字段）
- `src/features/PresentationStudio/store/presentationStore.ts`
- `src/features/PresentationStudio/hooks/useJobPolling.ts`
- `src/features/PresentationStudio/PresentationGenerationWorkspace.tsx`
- 对应前端测试

**原子动作**：

1. 支持 `phase/activity/slideId/currentSlide/totalSlides/progress/artifactIds` 的白名单投影；禁止 prompt、bytes、path、workspace、secret 进入前端事件；
2. 根据事件渲染快速打字机短句；动作切换时先完成当前短句，再切换下一条；
3. “正在制作 PPT”使用慢速打字机标题，不能把长 prompt 放在中心视觉；
4. 断线重连从 `lastSeq + 1` 继续，重复事件不重复打印、不重复增加 artifact。

**验收**：

- 页面能显示真实的“当前动作 + 当前页 + 已完成页数”；
- SSE 重放、乱序、断线恢复不会造成重复消息或进度倒退；
- 事件缺失时显示稳定的等待状态，不显示伪造页码。

### Round 3：动态卡片、真实预览与交互层次

#### R3-A（agy-A）：页级 artifact 与恢复 API

**目标**：让每一页的 SVG、图片素材和 PPTX 具备可查询、可恢复、可导出的稳定引用。

**允许修改**：

- `src/server/runtime/presentation/artifact-store.ts`
- `src/server/runtime/presentation/artifact-bridge.ts`
- `src/app/(backend)/api/runtime/presentation/[[...path]]/route.ts`
- `src/services/runtime/client.ts`
- 对应后端/客户端契约测试

**原子动作**：

1. artifact 元数据必须包含稳定的 `jobId/slideId/type/mimeType/status/uri`；
2. 页面 SVG、图片素材、最终 PPTX 分开登记，不能只返回一个总 PPTX；
3. 查询任务时返回已完成页和已生成素材，未完成页保持明确的 `pending`；
4. 页面离开后重新进入，使用 jobId 查询任务并按 lastSeq 增量恢复。

**验收**：

- 生成中途刷新页面，已完成页面仍能显示；
- 单页 artifact 查询不到时只影响该页，不污染其他页；
- 导出操作使用后端真实 URI，不允许空下载或假成功。

#### R3-B（agy-B）：动态生成卡片与真实预览交互

**目标**：把制作态从静态骨架改成“当前页突出、其他页有层次、可滚动、可预览”的工作台。

**允许修改**：

- `src/features/PresentationStudio/PresentationGenerationWorkspace.tsx`
- `src/features/PresentationStudio/style.ts`
- `src/features/PresentationStudio/AssetSlotPanel.tsx`（仅在预览入口需要联动时）
- 对应前端测试

**原子动作**：

1. 卡片按真实 slideId 渲染；当前页放大、居中、前景层级最高；相邻页缩小并在背景横向交换；
2. 当前页边缘使用连续白色流光，光效只作用于 active 卡片；支持 `prefers-reduced-motion` 降级；
3. 鼠标位于卡片区域时，滚轮转换为横向滚动；左右按钮复用现有 LobeHub 按钮风格；
4. 已生成 SVG 或图片 artifact 直接显示预览；悬浮卡片展示该页已完成素材，未完成时显示真实等待动作；
5. 卡片区域是主要视觉中心，进度文字与取消按钮放在其下方，不抢占视觉中心。

**验收**：

- 当前卡片可通过 `data-active` 明确识别；
- active 卡片视觉尺寸明显大于相邻卡片；
- 滚轮只在卡片区域横向移动，不影响页面整体滚动；
- 页面完成一张后，卡片从骨架切换为真实预览，而不是继续显示灰色占位。

### Round 4：端到端稳定性与交付收口

#### R4-A（agy-A）：真实 provider、取消、失败和持久化验收

**目标**：验证整个后端在真实 provider 下可运行，并把失败状态变成可恢复状态。

**允许修改**：

- 前三轮已定义的后端文件
- `docs/CORDIS_RUNTIME_MIGRATION_CONTRACT.md`
- 部署说明或 provider readiness 文档

**原子动作**：

1. 使用部署环境注入的真实 provider 配置执行一次完整生成；密钥只来自受保护环境文件，不进入源码和日志；
2. 在 planner、图片生成、页面渲染、导出四个阶段分别验证取消，确保进程被中止且任务终态为 `cancelled`；
3. 验证 provider 不可用、图片超预算、SVG 质量失败、PPTX 导出失败等错误均能持久化并在重进页面后恢复；
4. 更新契约文档，记录任务状态、事件、artifact 和取消语义。

**验收**：

- 真实 provider 产生真实 PPTX、SVG 和图片 artifact；
- 取消不再返回 `PRESENTATION_NOT_FOUND`；
- 进程重启后的恢复能力符合实际持久化实现，不能用 sessionStorage 冒充；
- 所有失败均有明确错误码和用户可执行的重试入口。

#### R4-B（agy-B）：最终视觉与交互收口

**目标**：让制作态与 Agent 页面保持同一套 LobeHub 交互语言，同时保证可访问性和长期运行体验。

**允许修改**：

- `src/features/PresentationStudio/PresentationGenerationWorkspace.tsx`
- `src/features/PresentationStudio/PresentationStudio.tsx`
- `src/features/PresentationStudio/style.ts`
- `src/features/PresentationStudio/AgentFlow/*`
- 对应前端测试与视觉验收记录

**原子动作**：

1. 进度播报、卡片预览、取消、重试、离页恢复统一消费同一个 store 状态；
2. 保持 Agent 页面原生对话框、附件、智能、沙盒、批准、放大和消息动画，不新增平行聊天实现；
3. 处理窄屏、键盘焦点、减少动画、错误提示和长时间等待；
4. 清理所有“固定 18%/55%”“假页码”“完整 prompt 主视觉”等临时降级逻辑；
5. 完成 1440×900 和 390×844 的视觉核验，确认页面不出现横向溢出、输入框遮挡或无法返回入口。

**验收**：

- 生成中、已完成、失败、取消、断线重连、离开再进入均有清晰界面；
- 页面视觉中心是动态卡片，不是长文本；
- 当前页、进度、动作、素材预览均可被用户理解；
- UI 与 `/agent/:id` 使用同一套 LobeHub 原生对话组件和交互节奏。

## 5. 完成定义（Definition of Done）

只有以下条件全部满足，才允许把本次改造标记为完成：

- [ ] `/jobs` 创建、查询、取消、重试使用同一 scope 的任务记录；
- [ ] 取消幂等，不再出现已创建任务找不到；
- [ ] planner、真实 image provider、worker、质量检查、PPTX 合成均有运行证据；
- [ ] 每页 SVG、图片素材和 PPTX 均可查询和恢复；
- [ ] 前端不再伪造进度、页码或完成状态；
- [ ] active 卡片放大居中，流光只作用于当前页，滚轮可横向浏览；
- [ ] 短动作由实时事件驱动并使用打字机效果；
- [ ] 离开页面、刷新、SSE 断线后能恢复真实状态；
- [ ] LobeHub 原生对话组件保持不变；
- [ ] 契约、错误码、artifact 和 provider readiness 文档同步；
- [ ] 没有密钥、`/qingzhou` 改动、未授权 commit/push 或未审核的跨边界修改。

## 6. 当前执行顺序

1. root 审核本 Spec；
2. 派发 R1-A 与 R1-B；
3. root 审核两个回报和工作树；
4. 派发 R2-A 与 R2-B；
5. 依次完成 R3、R4；
6. root 负责最终真实 provider 验证和启动，不把“卡片显示制作中”当作生成成功。

