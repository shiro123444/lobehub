# Cordis Foundation 来源与审计说明 (PROVENANCE)

本文档记录 `packages/cordis-foundation` 所引入的 Cordis 及 Cosmokit 源码基础包的真实上游来源、提交哈希、版本信息、校验方式、构建边界配置、manifest 差异及当前静态检查状态。

---

## 1. 真实上游仓库与元数据

- **本地上游仓库路径**：`/home/shiro/Projects/deepseek-harness`
- **上游 Git Remote**：`git+https://github.com/deepseek-ai/deepseek-harness.git`
- **上游 Commit SHA (HEAD)**：`c291e7961a515f6d7af9304e7fd1d257929aef26`
- **原始 Cordis 上游**：`https://github.com/cordiverse/cordis` (`packages/core`)
- **原始 Cosmokit 上游**：`https://github.com/deepseek-harness/cosmokit`
- **纳入包版本与 npm 包名**：
  - `vendor/cordis`：版本 `4.0.2`，上游 scoped 名称 `@deepseek-ai/cordis`
  - `vendor/cosmokit`：版本 `1.8.3`，上游 scoped 名称 `@deepseek-ai/cosmokit`
- **Wrapper 包**：
  - `packages/cordis-foundation`：版本 `0.1.0`，包名 `@lobechat/cordis-foundation`

---

## 2. 复制清单与逐文件校验 (SHA-256)

所有源文件（`src/*.ts`）与许可证（`LICENSE`）直接复制自本地上游，源码逐字节保留（0 diff），未修改任何源码逻辑。

| 文件路径                        | SHA-256 Checksum                                                   |   校验结果    |
| ------------------------------- | ------------------------------------------------------------------ | :-----------: |
| `vendor/cordis/LICENSE`         | `034fb52b1d57360ecbae6cb1632a88f86fd7c3d3f5631a5f082710203dda0be7` | ✅ 与上游一致 |
| `vendor/cordis/src/context.ts`  | `96b388162d6013c1898de61e35f28917abb93809de24174980f2a1a348d0b115` | ✅ 与上游一致 |
| `vendor/cordis/src/events.ts`   | `96565a2b5fbf35c26b78cbdc785b2b2e3f01fa55a9fd1f6af5355ab35ccc343c` | ✅ 与上游一致 |
| `vendor/cordis/src/fiber.ts`    | `750555b47603f88e7ef7a05d1a8d629b355c176a1185af411aac6e3e1e2b7ba3` | ✅ 与上游一致 |
| `vendor/cordis/src/index.ts`    | `c2232f082c763488225eafcd33530640ad26af0c7d6ea871a4f7e8ebf0eb3704` | ✅ 与上游一致 |
| `vendor/cordis/src/logger.ts`   | `5121e76fd9f55b9b90dfea09d6e60d122e7530246b8b19970ddebd9c35ccf7d8` | ✅ 与上游一致 |
| `vendor/cordis/src/reflect.ts`  | `6847b9781044023d65aebb5896a873b9f0a3d777eaf7fa0dd2a7a408eb6b74a6` | ✅ 与上游一致 |
| `vendor/cordis/src/registry.ts` | `34bbd60ae502b4f85201c204afb52a9acabde6878d9278493478c1b2183debd3` | ✅ 与上游一致 |
| `vendor/cordis/src/service.ts`  | `614205c6ce7cf1a057b8b352e96aa4fcd734c967a3d2283a126c9c61f268e3be` | ✅ 与上游一致 |
| `vendor/cordis/src/utils.ts`    | `8fe273424583d21267ef13f248840e97454d09d836a0ac08323a9482c2069263` | ✅ 与上游一致 |
| `vendor/cosmokit/LICENSE`       | `034fb52b1d57360ecbae6cb1632a88f86fd7c3d3f5631a5f082710203dda0be7` | ✅ 与上游一致 |
| `vendor/cosmokit/src/array.ts`  | `cf4de899ecffd66a90d8cef6f4c7d127d31f77f776d8e173d41c30d2d7632cf7` | ✅ 与上游一致 |
| `vendor/cosmokit/src/index.ts`  | `51dd173c70001d7d7891d3aab7e26594da65f7cb6671253f6d457ac889326b3c` | ✅ 与上游一致 |
| `vendor/cosmokit/src/misc.ts`   | `117617943074ea57c15f216905dacd2f6d1c4c2ff16586f97a7a7a87dbf2141f` | ✅ 与上游一致 |
| `vendor/cosmokit/src/string.ts` | `5564272b3e15e49235cbe3a8b453f27306baf282d23a893982841670f65d3c04` | ✅ 与上游一致 |
| `vendor/cosmokit/src/time.ts`   | `49957c4608465a1fbd738186a92c47fffcd1fc4ba59dbf89524f8a773fe16fe2` | ✅ 与上游一致 |
| `vendor/cosmokit/src/types.ts`  | `09d72a91052105e88500bfb99a8e8ce0c9ebf6f6e7df569053e114bc77aa019c` | ✅ 与上游一致 |

---

## 3. 独立 Declaration 构建边界与编译配置

为了隔离清舟根项目对 `vendor/**/*.ts` 的直接扫描污染，建立独立的声明构建边界：

1. **`vendor/cosmokit/tsconfig.json`**：
   - 独立配置，不继承根 `tsconfig.json` 的 `include`/`paths`。
   - 配置 `composite: true`, `declaration: true`, `declarationMap: true`, `emitDeclarationOnly: true`。
   - 产物目录指向 `lib/types`。
   - 沿用上游编译选项（`noUncheckedIndexedAccess: false` 等）。
   - **构建状态**：运行 `tsc --build vendor/cosmokit/tsconfig.json` **执行成功（退出码 0）**，已生成完整的 `.d.ts` 与 `.d.ts.map`。
2. **`vendor/cordis/tsconfig.json`**：
   - 独立配置，不继承根 `tsconfig.json` 的 `include`/`paths`。
   - 配置 `composite: true`, `declaration: true`, `declarationMap: true`, `emitDeclarationOnly: true`。
   - 产物目录指向 `lib/types`。
   - 通过 `references` 引用 `../cosmokit`，通过正式 workspace 包的 `types` 读取其已构建声明，没有指向源码的 `paths` 回退。
   - 沿用上游编译选项（`noImplicitAny: false`, `noImplicitThis: false`, `strictFunctionTypes: false` 等）。
3. **`packages/cordis-foundation/tsconfig.json`（Wrapper）**：
   - 继承根 `../../tsconfig.json`，**不关闭**任何 `strict`/`noImplicitAny`/`noImplicitThis`/`strictFunctionTypes` 选项。
   - `include` 严格限定为 `src/**/*.ts`，不包含 `vendor/**`。
   - 两个 vendor 项目均显式配置 `strict: true`；Cordis 只保留上游明确覆盖的选项。根工程排除 vendor 源码扫描，类型检查命令先构建声明；ESLint、Prettier 和 Stylelint 忽略 vendor，避免格式化改变上游字节。
   - **检查状态**：运行 `tsc --project packages/cordis-foundation/tsconfig.json --noEmit` **通过（退出码 0）**。
4. **可复现构建命令**：
   - `pnpm --filter @lobechat/cordis-foundation run build:types`
   - 等价于：`tsc --build packages/cordis-foundation/vendor/cosmokit/tsconfig.json && tsc --build packages/cordis-foundation/vendor/cordis/tsconfig.json`

---

## 4. Manifest 精确差异说明

1. **`packages/cordis-foundation/package.json`**：
   - `name: "@lobechat/cordis-foundation"`，版本 `0.1.0`，`private: true`。
   - `src/index.ts` 缩小公共面：仅从 `@deepseek-ai/cordis` 导出公共 API，移除了 `cosmokit` 重导出及额外 vendor 子路径导出。
   - `exports` 仅暴露 `"."` 与 `"./package.json"`。
   - 添加 `"build:types"` 脚本。
2. **`vendor/cordis/package.json`**：
   - `name: "@deepseek-ai/cordis"`，版本 `4.0.2`，`private: true`。
   - `types` 指向 `./lib/types/index.d.ts`。
   - `exports["."].types` 指向 `./lib/types/index.d.ts`。
   - `exports["."].default` 保持指向 `./src/index.ts`。
   - 移除 `peerDependencies`（未 vendored 的插件）与 `bin`。
3. **`vendor/cosmokit/package.json`**：
   - `name: "@deepseek-ai/cosmokit"`，版本 `1.8.3`，`private: true`。
   - `types` 指向 `./lib/types/index.d.ts`。
   - `exports["."].types` 指向 `./lib/types/index.d.ts`。
   - `exports["."].default` 保持指向 `./src/index.ts`。

---

## 5. 上游 deepseek-harness 已维护补丁说明

上游 `deepseek-harness` 在官方 Cordis 基础上维护了如下补丁（详见上游 `vendor/README.md`）：

1. **`cordis/src/fiber.ts` 生命周期重入销毁加固**：提前注册 effect owner wrapper，回滚同步 setup 失败时的清理；防止 `UNLOADING` 状态下逃逸注册；隔离 observer 异常；`Fiber.update()` 返回 waterfall 等待结果。
2. **`cordis/src/*.ts` JSDoc 文档强化**：补充完整的 `@param`、`@returns` 与生命周期契约文档。
3. **Node 兼容性显式类型擦除**：标记 erased imports。
4. **显式 `.ts` 扩展名说明符**：满足 ECMAScript 与 NodeNext 规范。
5. **Lazy Loader 配置延迟解析**（Port of cordiverse/cordis#41）。

---

## 6. 静态检查与构建测试真实结果

### 实际执行并验证通过的检查：

1. **源码完整性**：
   - `diff -r` 与上游 `deepseek-harness/vendor/{cordis,cosmokit}/src` 比对：**0 差异**。
   - `sha256sum` 校验：全部 17 个源文件与许可证哈希值 100% 吻合，逐字节原样保留。
2. **依赖静态语法检查**：
   - 使用 ripgrep 对 `vendor/{cordis,cosmokit}/src` 检查 `import`/`require`，确认核心源码不存在对 `loader`/`include`/`hmr` 的强制依赖。
3. **Cosmokit Declaration 构建**：
   - 执行 `npx tsc --build packages/cordis-foundation/vendor/cosmokit/tsconfig.json`：**成功（退出码 0）**，产物已输出至 `vendor/cosmokit/lib/types/`。
4. **Cordis Declaration 构建**：
   - 在依赖 `@standard-schema/spec@^1.1.0` 安装完毕后，配置 `strict: true`（对齐上游配置），执行 `npx tsc --build packages/cordis-foundation/vendor/cordis/tsconfig.json`：**成功（退出码 0）**，产物已输出至 `vendor/cordis/lib/types/`。
5. **Wrapper 类型检查（Strict: true）**：
   - 执行 `npx tsc --project packages/cordis-foundation/tsconfig.json --noEmit`：**成功（退出码 0）**，wrapper 继承根严谨 strict 选项无任何报错。
6. **根工程集成类型检查**：
   - 执行 `bun run type-check`（执行 `pnpm --filter @lobechat/cordis-foundation run build:types && tsgo --noEmit`）：**全量通过（退出码 0）**。
