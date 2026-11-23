# 故障排查

先按顺序做这三件事，再决定是否改配置：

```text
/sandbox status
/reload
/sandbox doctor
```

- `/sandbox status`：模式、根、runner 路径/后端版本、temp、bash、配置错误。
- `/reload`：让 Pi 重新读取全局设置并重建扩展运行时（改完配置/依赖后必须做）。
- `/sandbox doctor`：在独立临时工作区里真实执行“只读拒写、根内可写、根外拒写、根外拒删、退出码透传”。

**不要**为了绕过故障而把模式默认改成 `off`。那等于关闭插件；正确做法是修依赖/配置，或在明确知情时临时使用一次性 `/sandbox exec`。

## 改了配置但不生效

- 本插件只读**全局** `%USERPROFILE%\.pi\agent\settings.json` 的 `piDshSandbox` 段，不读项目 `.pi/settings.json`。项目里写的配置永远不会生效，这是设计。
- 改完文件要 `/reload`；运行中的会话不会热更新。
- JSON 必须合法；`piDshSandbox` 必须是对象；`mode` 只能是 `off`/`read-only`/`workspace-write`。
- 出现 `SANDBOX_CONFIG` 时看错误文本：
  - `additionalWritableRoots` 等额外根键：必须删除，插件不支持；
  - `runnerModule`/`dshRoot`/`tempRoot` 必须是**绝对路径**；
  - `tempRoot` 不能位于工作区内；
  - 全局 settings 顶层必须是对象。
- `/sandbox mode ...` 只改当前会话，不写回配置；新会话会回到配置起点。

## 找不到运行器

错误类似：

```text
SANDBOX_UNAVAILABLE: 找不到 Windows ACL 沙盒运行器 ...
Tried:
  - ...
```

处理顺序：

1. **不需要全局 DSH**。本包自带固定依赖。runner 可能在：

   ```text
   <包目录>\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js
   ```

   也可能被 npm 提升到上层，例如：

   ```text
   <extRoot>\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js
   ```

   以 `/sandbox status` 的 `runner:` 为准；两处都没有时，说明依赖没装好或包目录被移动/删除了。

2. 在源码/包目录重装依赖：

   ```powershell
   cd <包目录>
   npm ci --include=optional
   ```

   或对 tgz 安装目录用 `npm install --prefix <目录> --include=optional --omit=dev <tgz>`。

3. 如果你显式配置了 `runnerModule` 或 `dshRoot`，**无效路径会直接报错，不会自动换别的运行器**。改成正确绝对路径，或删掉该配置让插件探测自带依赖。

   从 0.3.2 起，插件也会从自身安装目录按 Node 的依赖解析规则查找上层 `node_modules`，兼容 npm 提升依赖的布局。旧版本请先升级；若自定义安装布局仍无法找到，可用 `runnerModule` 指向实际的 `lib/runner.js`。

4. 只有在前三步都不适用时，才考虑全局 DSH（`npm i -g @deepseek-ai/dsh`）或把 `runnerModule` 指向一个已知可用的 runner。不要同时保留多个互相矛盾的覆盖。

修复后 `/reload`，再 `/sandbox status` 看 `runner:`/`backend:`。

## 原生模块 koffi 加载失败

症状：

```text
windows-acl-run: Cannot find module 'koffi'
```

或 runner 启动时报原生模块加载失败。

- 安装时**必须**带 `--include=optional`。`koffi` 的平台二进制包是 optional 依赖；`--omit=optional` 会让它缺失。
- 确认存在：

  ```text
  <包目录>\node_modules\@koromix\koffi-win32-x64\win32_x64\koffi.node
  ```

- 确认是 Windows x64、Node 版本符合要求（建议 24 LTS，最低 22.19）。ARM64/ia32 不是受支持目标。
- 离线或镜像缺包时，只能联网补装；本插件的 `.tgz` 不含 `node_modules`，不是离线全依赖包。
- 重装后 `/reload`。

## 缺 DSH 的 peer 模块

如果你用了 `--omit=peer` 安装，可能看到：

```text
Cannot find module '@deepseek-ai/dsh-subprocess/control'
```

或 `@deepseek-ai/dsh-skill` 缺失。当前锁定的后端把这些声明为 **peer**，`--omit=peer` 不会把它们写到磁盘。

处理：在包目录重新执行不带 `--omit=peer` 的安装：

```powershell
npm ci --include=optional --omit=dev
```

对 tgz 安装目录：`npm install --prefix <目录> --include=optional --omit=dev <tgz>`。

## bash 与 ! 命令被拒绝

- `bash` 工具与 `!`/`!!` 都需要一个**非 WSL** 的 bash（Git Bash / MSYS2 / Cygwin）。
- 检测到 `%SystemRoot%\System32\bash.exe`（WSL 启动器）时插件明确拒绝：它把命令交给 Linux 虚拟机，Windows 受限令牌与 Low 标签管不到。
- 安装 Git for Windows 后，可在全局 `settings.json` 设 `shellPath` 指向 Git 的 `bash.exe`（例如 `<Git 安装目录>\bin\bash.exe`），然后 `/reload`。
- `bash` 覆盖以 `defaultActive: false` 注册，**不会**因为它被覆盖就自动出现在启用工具里；需要你在 `defaultTools`/`--tools` 中显式启用（或它本来就是激活状态）。官方 `!` 命令依赖 bash；没有可用 bash 时请改用 `powershell`。

## 只读模式下 PowerShell 不能用 Add-Type/COM

`read-only` 下后端无法创建 AppLocker 探测文件，PowerShell 会保守进入 `ConstrainedLanguage`：`Add-Type`、非核心 .NET 静态调用、COM、反射失败。

- 这是后端/PowerShell 的启动行为，不是 ACL 写边界故障。
- 日常请用 `workspace-write`；如果必须只读，接受语言模式限制，或改用不需要这些能力的命令。

## Node 测试 / 管道出现 spawn EPERM

受限子进程无法为**新建命名管道**打开写端，`spawn(..., { stdio: "pipe" })` 会 `EPERM`。这会影响：

- Node 测试运行器默认的子进程隔离模式；
- Pi 内置本地 PowerShell 后端的某些路径；
- 任何在受限 shell 里新建管道的工具。

本仓库的处理：

- `npm test` 使用 `--test-isolation=none`，避免测试运行器自己开管道；
- 其中 4 项**真实本地执行**测试在受限 shell 中会带着明确原因自动跳过，这**不是断言失败**；
- `npm run test:pi`、`npm run test:integration`、`npm run test:pack` 等需要真实本地进程/管道的测试，请在**普通终端**（不要在本插件的受限 shell 里）运行；
- `npm run test:register` 不新建管道，可在受限 shell 中运行。

不要因为 EPERM 就关沙盒；换到普通终端或接受测试跳过即可。

## TUI 与 RPC 的审批界面不一样

- 交互式 TUI：消息流**黄色卡片**（完整命令/理由/cwd/模式/超时）+ 底部**黄色小面板**（四项选择）。黄色是固定 RGB，不跟随主题。
- RPC/T3：宿主原生 `select`/`input`，纯文本标题，无 ANSI；颜色和布局由宿主决定，**看不到黄色**是正常的。
- `print`/`json`：没有可确认 UI，`sandbox_request`/`/sandbox exec` 一律不执行。
- TUI 面板不可用（缺少 `custom`/`setWidget`/`onTerminalInput` 或 `ui.custom` 抛错）时退回原生四选项；仍然需要明确选择，不会自动批准。

## F2 隐藏后找不到审批

- `F2` 隐藏面板是**回看**，不是回答。编辑器上方会出现「审批待处理：… · 按 F2 返回审批面板 · 此时不会执行」。
- 再按 `F2` 返回，选中项与已输入理由保留。
- 隐藏期间在编辑器里按 `Enter` 只是发送你自己的消息，不会批准；只有回到面板后显式 `Enter` 才算答复。
- 如果面板/提示都不见了，待批可能已因会话切换、`/reload`、模式变化或中断而取消；该命令不会执行，重新发起申请即可。

## 审批没有执行

逐项检查：

| 现象 | 原因 |
| --- | --- |
| 选择了 `Yes, and reason…` 但没执行 | 理由留空/只含空白/按 `Esc` 取消 → 本次不批准 |
| 按了数字键 `1`–`4` 没执行 | 数字只移动选择，必须再按 `Enter` |
| 完全没有弹出审批 | `hasUI=false`（无 UI 的 print/json/子代理）→ fail-closed；请在交互式终端发起 |
| 批准后仍报“未执行” | 审批期间会话/根/运行时/模式变化、signal 取消，或审计写入失败（执行前 fail-closed） |
| `sandbox_request` 报参数无效 | `command`/`reason` 非空必填；`timeout` 必须是有限正数且 ≤ 600 |
| 以为是“全局批准” | 一次性审批只对本次精确命令 + 固定 cwd 有效，不改模式 |

审批结果与原因会显示在结果卡片/通知里；也可看 `/sandbox status` 确认模式没有变化。

## 错误码速查

| 错误 | 含义 | 处理 |
| --- | --- | --- |
| `SANDBOX_UNAVAILABLE` | 平台不支持、找不到 runner、显式路径无效、无法启动 runner | 修依赖/路径；见“找不到运行器” |
| `SANDBOX_CONFIG` | 配置不可解析/值非法/额外根/相对路径/temp 在根内 | 修全局设置或 CLI，`/reload` |
| `SANDBOX_DENIED` | 内核或提前检查判定根外写入 | 改写到根内，或走一次性审批 |
| `SANDBOX_READ_ONLY` | 只读模式拒绝任何 `write`/`edit`（含建目录） | 需要写就由人类确认放宽 |
| `SANDBOX_RUNNER_FAILURE` | 运行器自身失败、helper 没返回结果、成功后退出码异常 | 视为失败；跑 `/sandbox doctor` |

## 临时目录残留

- 每次调用会在 temp 根下有一个宿主持有的 `call-*` 父目录；正常结束、超时、取消都会尝试清理。
- Pi 被强制结束、目录被占用/杀毒扫描锁住时，仍可能残留。
- 插件**不会**扫描并删除其它存活调用的目录，也不会清理共享 temp 根。
- 想减少 `%LOCALAPPDATA%` 占用：设置 `tempRoot` 到别的盘；确认没有 Pi 在运行后，才手工清理你自己的旧 `call-*`/`ch-*` 目录。不要批量删除整个 temp 根。
- `/sandbox doctor` 使用自己的临时工作区，结束后递归删除；删除失败会作为 doctor 的一项 FAIL 报出来。

## 拒绝信息乱码或认不出

- `cmd.exe` 的中文拒绝信息是 GBK；按 UTF-8 解码可能认不出。`node`（`EPERM`）与 `pwsh`（英文/中文“拒绝访问”）的拒绝更可靠。
- PowerShell `-Command` 的退出码取决于最后一条语句；中间某条被拒不一定让退出码非 0。需要强中止时用 `$ErrorActionPreference='Stop'`，并查看输出/补充的 `[sandbox: ...]` 说明。

## ACL/目录状态不对

- 先读 [security 的回滚章节](security.md#7-回滚与恢复)；不要执行 `icacls /reset /T`。
- 首次传播大目录可能耗时；如果命令超时但目录已被标记，下一次会命中缓存。
- Low 标签和能力 ACE **不会**因卸载而撤销；确认工作区是否可丢弃，或按备份精确恢复 DACL。
- 不确定时用一次性副本复现，不要在真实项目上试验回滚命令。
