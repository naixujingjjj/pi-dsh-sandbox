# pi-dsh-sandbox

面向 **Windows 10/11 x64** 的 Pi 扩展：把 `powershell`、`bash`、`!`/`!!` 命令以及 `write`/`edit` 的**实际写入**限制在当前会话工作区根内。边界由 Windows 内核强制（受限令牌 + Low 完整性标签），不是插件侧的关键词过滤。

> 本项目当前**没有发布到 npm**；请从源码目录或实际发布页下载的 `.tgz` 安装。若以后提供 npm/git 源，以发布说明为准。

## 它做什么

- **受限执行**：`powershell`、`bash`、`!`/`!!` 通过包内**内置（vendored）**的 `@deepseek-ai/dsh-sandbox-windows-acl` 受限令牌运行器执行；根外写入/删除被内核拒绝。
- **写入落盘**：`write`/`edit` 保留 Pi 原有语义（相对路径、精确文本匹配、BOM/换行、diff、每文件队列），只有实际 `mkdir`/写文件交给受限进程内的 helper。
- **受控出口**：模型可调用 `sandbox_request` 申请**一次性**以 off（不经过沙盒）执行一条精确命令，每次都要人类四项审批；人类也可用 `/sandbox exec`。
- **失败即关闭**：缺运行器、平台不支持、配置错误、审批 UI 不可用等情况都不会退回未受限执行。

## 它不做什么（重要）

- **不限制读**：受限子进程能读你有权读的任何文件（包括其它工作区、`~/.ssh`）；`read`/`ls`/`grep`/`find` 仍是 Pi 原生行为。
- **不限制网络**：受限子进程可以联网；MCP web 工具也不经过本插件。
- **不是容器**：不限制进程可见性、CPU/内存或用户身份。
- **不是完整隔离**：内核保证为 `enforcement: partial`，只覆盖写入/删除。
- **不覆盖整个宿主**：第三方扩展、MCP 工具、扩展直接调用的 `pi.exec`/文件 API 不受本插件约束。

## 常驻副作用（安装前请读）

`workspace-write` 会在**授权根**上留下跨会话、跨重启的改动：一条能力 SID 允许 ACE、一条 `FILE_DELETE_CHILD` 拒绝 ACE，以及（当根还没有通过继承处于 Low 时）**Low 完整性标签**。它们**不会**随会话结束或卸载插件撤销；Low 标签还会让其它以 Low 完整性运行的进程写这个目录树。

- 0.4.2 起包内 vendored 后端在根已通过继承具备 Low no-write-up 时只改 DACL、不重写现有标签，因此这类布局**不需要额外补 `WRITE_OWNER`/`(WO)`**；正常授权仍会写上面两条 ACE（那是沙盒授权本身）。
- 不可逆的“通用回滚”很危险：**不要**用 `icacls <根> /reset /T`，它会抹掉你原有的自定义 ACL。
- 需要保留内容时，在首次使用前备份 DACL（用 `Get-Acl` 只取 Access 一节）；恢复时用 `Set-Acl` 只写回 DACL，owner/group 与 Low 标签不变。
- 可丢弃的临时副本用完即弃，是最简单的回滚。

细节、限制与备份示例见 [docs/security.md](docs/security.md)。**不要为了卸载插件而删除需要保留的真实项目。**

## 系统要求

| 项 | 要求 |
| --- | --- |
| 平台 | Windows 10/11 **x64**；其它平台在 confined 模式下报 `SANDBOX_UNAVAILABLE` |
| Node | **建议 24 LTS**；最低 **22.19**（与 Pi 的要求一致） |
| Pi | `@earendil-works/pi-coding-agent` **>= 1.6** |
| 运行器 | 本包**内置**（vendored）已打补丁的 `@deepseek-ai/dsh-sandbox-windows-acl@0.2.2-rc.5+pi-dsh.1`（`vendor/`）；无需全局 DSH，也不用改 `node_modules` |
| 可选 | Git for Windows 的 `bash.exe`（否则 `bash` 与 `!` 会被拒绝） |
| 网络 | 安装运行依赖需要联网 |

## 安装

### 从源码目录安装（推荐）

```powershell
cd C:\src\pi-dsh-sandbox
npm ci --include=optional

# 只在本次进程里试用，不写配置
pi -e C:\src\pi-dsh-sandbox

# 确认可用后写入全局 settings.json 的 packages
pi install C:\src\pi-dsh-sandbox
```

- `--include=optional` **必须带**：`koffi` 的原生二进制是 optional 依赖，省略后运行器无法加载。
- npm 需要联网安装运行依赖；源码目录与其中的 `node_modules` 必须保留，Pi 按**绝对路径**加载本地包，不会复制它。
- `pi install` 只把该目录加入 Pi 的全局 `packages`，不会改你的 `defaultTools` 或本插件以外的文件。
- 依赖里的宿主包（`@earendil-works/*`、`typebox`）是**可选 peer**，由 Pi 提供，不需要、也不应再装一份。

### 从 `.tgz` 安装

**不能**把 `.tgz` 直接交给 `pi install`：Pi 会把文件路径当作扩展源码，而不是一个待安装的包。先把 tarball 安装到一个固定位置，再用该位置里的包目录：

```powershell
$tgz = "C:\src\downloads\pi-dsh-sandbox-0.4.2.tgz"   # 换成实际文件
$extRoot = "$env:LOCALAPPDATA\pi-extensions"

New-Item -ItemType Directory -Force -Path $extRoot | Out-Null
npm install --prefix $extRoot --include=optional --omit=dev "$tgz"

# 包目录必须保留，不要删除或移动
pi install "$extRoot\node_modules\pi-dsh-sandbox"
```

- `.tgz` 里是源码、文档与包内 vendored 后端（`vendor/`），**不是**自带全部依赖的离线包；`npm install` 会联网取 `koffi`/`yaml`/DSH 运行依赖。
- 不要把 `.tgz` 解压后直接 `pi install <解压目录>`，除非你已在那个目录里装好运行依赖（见上一节）。
- 如果 `npm` 提示缺少 `koffi` 或 `@deepseek-ai/dsh-*`，见 [docs/troubleshooting.md](docs/troubleshooting.md)。

### 已安装后

- 改了插件代码、更新了包，或改了 `piDshSandbox` 配置：在 Pi 里执行 `/reload`。
- 检查是否加载成功：`/sandbox status`；做一次真实自检：`/sandbox doctor`。
- 卸载：`pi remove <pi list 中显示的同一 source>`。本地包的 source 是绝对路径；卸载只从 `packages` 移除，**不撤销**上面说的 ACL/Low 标签。

## 三种模式

| mode | `powershell` / `bash` / `!` | `write` / `edit` |
| --- | --- | --- |
| `off` | Pi 内置路径（未受限） | Pi 内置路径（未受限） |
| `read-only` | 受限令牌，任何写入/删除都被内核拒绝 | 在任何文件系统调用前拒绝（包括建目录） |
| `workspace-write`（默认） | 受限令牌，只能写授权根 + 运行器私有 temp | 实际落盘由受限进程内的 helper 完成 |

默认是 `workspace-write`，装上即生效。`/sandbox` 打开模式菜单；放宽限制（例如切到 `off`）需要额外确认。只有人类命令能改当前会话的模式，模型没有切换模式的工具。

## 授权根与 `cd`

- 授权根 = 当前会话 `cwd` 的**规范真实路径**（解析 junction/符号链接/8.3 短名），每个会话固定一次。
- 命令里 `cd` 到别处**不会扩大**授权根；运行器的 `--workspace` 与 spawn 的 cwd 始终是那个根。
- 想让另一个目录成为根：在另一个目录里启动 Pi 会话。
- temp 根默认 `%LOCALAPPDATA%\pi-dsh-sandbox\tmp`，必须在工作区之外；可用 `tempRoot` 改到别的盘。

## 越界审批（摘要）

模型调用 `sandbox_request` 时必须给 `command`（精确 PowerShell 命令）、`reason`（申请理由，只展示给审批人）、可选 `timeout`（正数秒，最大 600）。审批只对**本次命令 + 固定 cwd**有效：

| 选项 | 行为 |
| --- | --- |
| `Yes` | 只执行这一次，不改模式 |
| `No` | 不执行 |
| `Yes, and reason…` | 执行这一次；操作结束后，模型先报执行事实，再完成你填写的补充要求 |
| `No, and reason…` | **不执行**；你填写的文字成为当前任务的新方向，模型据此重新规划 |

审批窗口里的文字是**给代理的指示**，不是附言，也不会被拼进命令。交互式 TUI 里审批详情是消息流中的**黄色卡片**，底部是黄色小面板；`F2` 可隐藏面板回看前面的输出，再按 `F2` 返回。只有显式 `Enter` 才算答复，`Esc` 或空白理由都不批准。RPC/T3 保持宿主原生选择框，`print`/`json` 没有审批 UI 时一律不执行。

完整交互、按键与示例见 [docs/usage.md](docs/usage.md)。审批语言按当前分支最新用户提示词判断：**有中文就用中文，中英混合也用中文；没有中文且有英文字母就用英文**。不再分析词数、技术术语或“用某语言回答”等句意。申请开始后固定语言，历史卡片按保存语言重绘；命令、申请理由和你填写的文字原样保留。

## 配置（摘要）

只读 **全局** `~/.pi/agent/settings.json`（Windows：`%USERPROFILE%\.pi\agent\settings.json`）中的 `piDshSandbox` 段，以及四个 `--sandbox-*` CLI 参数。项目内的 `.pi/settings.json` **完全被忽略**，防止仓库自己把模式改成 `off`。

```json
{
  "piDshSandbox": {
    "mode": "workspace-write"
  }
}
```

`runnerModule`、`dshRoot`、`tempRoot` 都是可选的；显式配置了无效路径会直接报错，不会悄悄换成别的运行器。`additionalWritableRoots` 等“额外可写根”配置会被拒绝（当前插件只配置一个会话根，不支持持久额外根）。

完整字段、优先级和不可用项见 [docs/configuration.md](docs/configuration.md)。

## 已知边界（节选）

- **硬链接是文件对象别名**：同一文件在根外的硬链接仍可写（机制固有）。
- **安装类命令常失败**：`npm/pip install` 写 `~/.npm`、`~/.cache` 等根外路径会被拒绝；可把缓存改到工作区，或对单条命令走 `/sandbox exec`。
- **`read-only` 下 PowerShell 可能进 `ConstrainedLanguage`**：`Add-Type`、COM、反射不可用；这是后端行为。
- **部分管道 `spawn` 会 `EPERM`**：受限于后端对新建命名管道的限制；Node 测试与 Pi 内置本地 PowerShell 后端可能受影响。
- **`cmd.exe` 的中文拒绝信息是 GBK**：按 UTF-8 解码可能认不出拒绝；`node`/`pwsh` 的拒绝更可靠。
- **`bash` 拒绝 WSL 启动器**：它把命令交给 Linux 虚拟机，Windows 令牌管不到；请用 Git Bash 等非 WSL bash。

更多机制、回滚与“不做”的范围见 [docs/security.md](docs/security.md)；出问题先看 [docs/troubleshooting.md](docs/troubleshooting.md)。

## 文档与开发

| 文档 | 内容 |
| --- | --- |
| [docs/installation.md](docs/installation.md) | 源码/tarball 安装、卸载、目录保留 |
| [docs/usage.md](docs/usage.md) | 三模式、命令、四审批、F2、按键 |
| [docs/configuration.md](docs/configuration.md) | 配置字段、CLI 参数、优先级 |
| [docs/security.md](docs/security.md) | partial 边界、ACL 副作用、回滚 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 缺依赖、runner、WSL、管道、UI |
| [docs/releasing.md](docs/releasing.md) | 上传源码、打包与发布产物 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发、测试、打包 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变化 |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 第三方归属 |

本包以 MIT 许可发布，见 [LICENSE](LICENSE)。运行依赖与归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
