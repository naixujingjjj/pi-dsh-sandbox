# 第三方归属 / Third-Party Notices

本包（`pi-dsh-sandbox`）自身以 **MIT** 许可发布，见 [LICENSE](LICENSE)。

下面按本仓库 `package.json` / `package-lock.json` 以及锁定版本的安装结果，列出运行时**调用或依赖**的第三方组件。各组件版权与许可条款归其各自作者所有；再分发时请以对应包内的 `LICENSE` 原文为准。本文件是归属说明，不是法律意见。

## 运行时依赖

| 组件 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-sandbox-windows-acl` | `0.2.2-rc.5` + 本地补丁（包内版本标识 `0.2.2-rc.5+pi-dsh.1`） | MIT | Windows ACL 受限令牌沙盒后端。**本包原样内置源码副本**于 `vendor/dsh-sandbox-windows-acl/`（含上游 `LICENSE`、`patches/`、`pin.json`、`PROVENANCE.json`）；本插件调用其 `lib/runner.js` |
| `@deepseek-ai/dsh-win32-process` | `0.2.2-rc.5` | MIT | 受限进程、stdio、Job 对象与 Win32 原语 |
| `@deepseek-ai/dsh-subprocess` | `0.2.2-rc.5` | MIT | runner 使用的子进程控制通道约定（直接依赖） |
| `@deepseek-ai/dsh-skill` | `0.2.2-rc.5` | MIT | 内置后端 `acl-skill` 模块使用（直接依赖） |
| `@deepseek-ai/dsh-lazy-require` | `0.2.2-rc.5` | MIT | 延迟加载 |
| `@deepseek-ai/cordis` | `4.1.0` | MIT | 后端的 peer 依赖 |
| `koffi` | `3.1.1` | MIT | Win32 FFI |
| `@koromix/koffi-win32-x64` | `3.1.1`（optional） | MIT | `koffi.node` 预编译二进制；`npm install --include=optional` 时必须安装 |
| `yaml` | `2.9.x`（后端声明 `^2.4.2`） | ISC | ACL 后端内部使用 |

除包内 vendored 后端外，这些包通过 npm 依赖树安装；本仓库**只**复制该后端的 MIT 源码、编译产物与上游 `LICENSE`（`vendor/dsh-sandbox-windows-acl/`），并保留补丁与来源哈希。首次使用前请阅读该目录的 `PATCH.md` 与 `PROVENANCE.json`。

## 宿主提供的 peer（不打包）

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | MIT | Pi 扩展宿主；本包只在 `peerDependencies` 声明，Pi 加载扩展时把 `@earendil-works/*`、`typebox` 映射到宿主自身模块，不出现第二份宿主副本 |
| `@earendil-works/pi-tui` | MIT | 审批卡片与审批面板使用其 TUI 组件/工具：`Container`、`Text`、`Input`，`Component`/`Focusable`/`OverlayHandle`/`TUI` 类型，按键匹配，ANSI 安全的宽度/换行/截断，控制字符与转义清理，以及 `rgbColor`。用途不限于 `Text` |
| `typebox` | MIT | `sandbox_request` 的参数 schema（`Type.Object` 等）。由宿主提供并映射，本包不打包副本 |

`peerDependenciesMeta` 将上述三项标为 **optional**：由 Pi 提供；安装本包的运行依赖时不需要也不应再装一份。

## 设计参考

- 包含判定（`src/policy.ts`）参考了 DSH `packages/fs/fs-sandbox/src/containment.ts`（MIT）的“词法快路径 + 真实路径祖先校验”思路；本仓库为独立实现，未复制上游源码。
- 拒绝签名与 runner 失败签名沿用 DSH `packages/sandbox/sandbox-local/src/index.ts`（MIT）的公开常量（`windows-acl-run: ` / exit 127 / `DENIAL_SIGNATURES`），并追加了中文本地化与 `EPERM` 判据。

## 内置（vendored）上游副本

`@deepseek-ai/dsh-sandbox-windows-acl`（MIT，<https://github.com/deepseek-ai/deepseek-harness>）以 npm 发布版
`0.2.2-rc.5` 为基础，在 `vendor/dsh-sandbox-windows-acl/` 内保留 `src/` 与构建产物 `lib/`，并附：

- `LICENSE`：上游 MIT 许可原文；
- `patches/`：本次补丁的 unified diff（可用 `git apply` 审阅）；
- `pin.json`：上游 tarball 版本与 SHA-256、补丁哈希；
- `PROVENANCE.json`：构建工具版本与每个产物文件的 SHA-256。

上游 `0.2.2-rc.5` 发布版**没有**包含这个补丁；本包不声称该修复已发布到上游。

## 上游项目

- DSH / `deepseek-harness`：<https://github.com/deepseek-ai/deepseek-harness>
- Pi / `pi`：<https://github.com/earendil-works/pi>

如果要在再分发时满足各上游的许可条件，请保留对应包附带的版权与许可文本；本文件不替代它们。