# 贡献指南

感谢你考虑改进 `pi-dsh-sandbox`。这是一个 Windows 专用的 Pi 扩展，改动涉及**内核边界**与**人类审批**，请优先保证“失败也不放开”的性质。

## 1. 环境

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10/11 x64（真实内核测试需要） |
| Node | **24 LTS**（最低 22.19） |
| Pi | `@earendil-works/pi-coding-agent` >= 1.6 |
| 依赖 | `npm ci --include=optional` |

```powershell
npm ci --include=optional
npm run verify
```

`--include=optional` 不能省：`koffi` 的平台二进制是 optional 依赖。若你只装运行依赖，用 `npm ci --include=optional --omit=dev`；**不要加 `--omit=peer`**，后端把运行所需的 DSH 包声明为 peer，省掉后 runner 会加载失败。

## 2. 脚本

| 命令 | 内容 |
| --- | --- |
| `npm run verify` | `check:repo` + `typecheck` + 单元测试；提交前至少跑这个 |
| `npm run check:repo` | 离线检查公开源码树、版本/锁一致、相对文档链接、个人路径与密钥残留 |
| `npm run typecheck` | `tsc --noEmit`（strict） |
| `npm test` | 单元测试。用 `--test-isolation=none` 规避受限 shell 的管道 `EPERM`；4 项真实本地执行测试在受限 shell 中带原因跳过 |
| `npm run test:integration` | 真实 Windows 内核用例：只读拒写、根内可写、根外拒写/拒删、退出码。**只在独立临时工作区**授权 |
| `npm run test:pi` | Pi SDK 层烟测：加载扩展、真实执行被覆盖的工具、审批路径；**不调模型、不需要 API key** |
| `npm run test:register` | 仅 SDK 注册/拒绝路径；不新建管道，可在受限 shell 中运行 |
| `npm run test:cli` | 真实 `pi` CLI（RPC）层烟测：`/sandbox` 命令、审批、`!` 钩子；使用本地 fixture provider |
| `npm run test:failure` | 真实 SDK 下缺 runner 时 `powershell`/`write`/`edit`/`sandbox_request` 的 fail-closed |
| `npm run test:pack` | `npm pack` 产物检查 + 装进临时工程做一次真实受限写 |
| `npm run pack` | 生成发行包到源码树**之外**（默认兄弟目录 `pi-dsh-sandbox-pkg`），同时写 `.sha256`、`.manifest.json`、`latest.json`；可选 `-- --out-dir <目录>` |
| `npm run check:package` | **离线**核对 `latest.json`、tarball 的 SHA-256、manifest 文件清单 |
| `npm run verify:windows` | 在普通 Windows 终端跑全套：`verify` + integration + register + pi + cli + failure + pack |

说明：

- 发布脚本默认拒绝把产物写进源码目录；需要指定位置时用 `npm run pack -- --out-dir D:\path\outside\source`。
- `check:package` 只读已有产物，不联网；它不能替代真实安装验收。
- 真实 Windows/管道相关测试请在**普通终端**运行；在插件的受限 shell 里跑会因 `spawn EPERM` 或环境差异失败或跳过，这不是断言失败。
- 测试**不需要**模型 API key；请勿为跑测试去配置真实模型调用。

## 3. 测试纪律

- 重型 Windows 测试使用 `mkdtemp` 创建**独立临时目录**作为授权根，结束后删除；**不要**把测试指向真实项目、用户目录或 `C:\`。
- 测试不得修改用户全局 `settings.json`、主题、模型或 `defaultTools`；需要隔离时用 `PI_CODING_AGENT_DIR`/临时 agent 目录。
- 不要为了“测试通过”而降低 fail-closed 断言、跳过拒绝路径，或在 `off` 下重跑。
- 新增审批/UI 逻辑时，同时测：批准、拒绝、取消、空白理由、无 UI、并发隔离、会话变化/abort 清理。
- 新增写入路径时，必须验证“根外被内核拒绝”，而不是只验证插件提前报错。

## 4. 源码结构

```text
src/
  index.ts            扩展入口：注册工具、命令、flag、审批卡片渲染器；加载失败时阻断可受限工具
  state.ts            每进程运行时 + 每会话根/模式/bash/temp 状态；fail-closed 就绪检查
  config.ts           全局设置与 CLI flag 解析、优先级、不支持项
  policy.ts           模式词汇、规范根、包含判定（仅用于提前报错）
  runner.ts           定位并 spawn DSH runner；超时/取消/私有 temp 清理
  shell-command.ts    PowerShell 命令拼装（与宿主后端形态一致）
  classify.ts         拒绝/runner 失败签名分类
  mutation.ts         write/edit 的受限 helper 调用与结果协议
  ipc.ts              每次调用唯一的请求文件通道（不使用新管道）
  kernel-helper.mjs   在受限进程内执行 mkdir/write 的 helper
  approval.ts         四项审批、TUI/RPC 分派、审计字段
  reason.ts           审批文字 → 给代理的指令（不执行、不改命令）
  errors.ts           SANDBOX_* 错误类型
  tools/
    shell-tools.ts    powershell/bash/! 的受限 operations
    fs-tools.ts       write/edit 注册与提前包含检查
    sandbox-request.ts 模型一次性申请工具、参数校验、live 卡片
    types.ts          工具结果的轻量类型
  tui/
    card.ts           黄色审批卡片（全宽/换行/防 ANSI 伪造）
    panel.ts          底部浮动审批面板、理由输入、F2 隐藏/恢复
    theme.ts          固定黄色调色板
    entry.ts          会话条目卡片（人工 exec / 放宽模式）
    live.ts           按 toolCallId 保存待批事实，供卡片重绘
test/
  unit/               纯逻辑 + in-process TUI 渲染/按键
  integration/        真实 Windows ACL/runner 用例（临时工作区）
  fixtures/           本地 provider、TUI/调色板夹具
scripts/              SDK/CLI/failure/package 烟测与发布脚本
docs/                 面向用户的安装、使用、配置、安全、排障文档
```

设计原则：

- **边界在内核**。`policy.ts` 的提前检查只改善报错，任何安全性断言都必须在内核层验证。
- **fail-closed**。缺 runner、配置错误、审批不可用、helper 无结果，一律不执行；禁止“降级直通”。
- **审批文字是数据/指示，不是命令或权限**。它不能改写命令、不能成为持久 grant。
- **不复制宿主包**。`@earendil-works/*` 与 `typebox` 由 Pi 提供，保持 peer/optional peer。

## 5. 代码与文档

- TypeScript strict；ESM，源码里相对导入带 `.ts` 后缀（Pi 用 jiti 直接加载）。
- 不新增与宿主重复的依赖；运行依赖固定版本并在 `package-lock.json` 中锁定。
- 行为变化同步更新 `README.md`、相关 `docs/*.md` 和 `CHANGELOG.md`。
- 公共文档不写个人路径、用户名、机器名，也不编造仓库/发布 URL；示例用通用占位路径。
- 不要提交 `node_modules`、`.tgz`、日志或本机缓存。

## 6. 提交与 PR

- 一个 PR 聚焦一件事；说明动机、行为变化、风险与验证命令。
- 涉及安全边界、审批、ACL/回滚的改动，请在描述里明确“哪些情况仍然 fail-closed”。
- 可以提交 PR，但不要在 PR/文档里添加未经确认的仓库或发布地址。
- 提交前跑 `npm run verify`；有条件时再跑 `test:integration`、`test:pi`、`test:cli`、`test:failure`、`test:pack`（普通终端）。
- 仓库提供 Windows GitHub Actions 工作流（`.github/workflows/ci.yml`），推送后可在 Actions 查看结果；本地通过不代表远端工作流已经运行。