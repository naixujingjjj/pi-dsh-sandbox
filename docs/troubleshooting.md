# 故障排查

先按顺序做这三件事，再决定是否改配置：

```text
/sandbox status
/reload
/sandbox doctor
```

- `/sandbox status`：模式、根、runner 路径/后端版本、temp、bash、配置错误。
- `/reload`：让 Pi 重新读取全局设置并重建扩展运行时（改完配置/依赖后必须做）。
- `/sandbox doctor`：在独立临时工作区里真实执行“只读拒写、根内可写、根外拒写、根外拒删、退出码透传”，并用**会话真实工作区根**额外跑一项「工作区就绪（真实根）」。

**不要**为了绕过故障而把模式默认改成 `off`。那等于关闭插件；正确做法是修依赖/配置，或在明确知情时临时使用一次性 `/sandbox exec`。

## 工作区根无法授权（`grantWrite` Win32 5）

症状（普通 `powershell` 连只读命令都起不来）：

```text
windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作区根>)
Command exited with code 127
[sandbox: runner-failure] ...
```

这是**运行器在授权工作区时初始化失败**，子命令根本没有开始执行，不是“某个路径没有写权限”。因此它不是越界理由，`sandbox_request` 也修不了它——逐条申请未受限执行只会把一次故障变成很多次审批。

后端在根上做两类编辑：

- **DACL**：能力 SID 的允许 ACE（只需 `WRITE_DAC`，所有者隐含具备）与 Everyone 删除子项拒绝 ACE；
- **SACL**：Low no-write-up 完整性标签。**仅当根还没有通过继承处于 Low no-write-up 时**才写；写标签需要 `WRITE_OWNER`。

所以 `SetNamedSecurityInfoW` 的 Win32 5 **不等于**缺 `WRITE_OWNER`。只有后端在错误详情里明确说明时才能这样断定——本包 vendored 后端在标签写入被拒时会追加：

```text
windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<根>): the Low integrity label needs WRITE_OWNER ...
```

没有这段说明时，Win32 5 还可能是：当前账户在根上没有 `WRITE_DAC`（既不是所有者也未获授权）、安全描述符受保护或被策略限制、所有者/组/SACL 等其它组件写入被拒。先做只读检查（不改 ACL）：

```powershell
icacls "<工作区根>"      # 目标账户是否有显式或继承的完全控制；父目录 ACE 是否带继承标志
```

再配合 `/sandbox doctor` 的「工作区就绪（真实根）」一项（它用真实根复现同一故障）。

修复（人类决定；插件永远不会自动改 ACL）：

1. **首选，不需要额外修复权限**：使用带 vendored 后端的 0.4.2+。`/sandbox status` 应显示来源 `vendor`、后端 `0.2.2-rc.5+pi-dsh.N`。根已通过继承处于 Low no-write-up 时，它只改 DACL、不重写现有 Low 标签。注意：上游 `0.2.2-rc.5` **发布版没有这个修复**，换成它不能解决；正常授权仍会写能力 SID 允许 ACE 与 Everyone 删除子项拒绝 ACE（沙盒授权本身），这里“无需额外修复”指不需要再补 `WRITE_OWNER`。
2. 若只读检查确认当前账户确实缺少必需权限（或后端明确报告标签写入需要 `WRITE_OWNER`），只补一条最小 ACE（不继承、不扩散、不涉及 Everyone），并在改之前备份；下面是**普通 PowerShell**（不是受限沙盒）里可执行的步骤：

   ```powershell
   $root   = '<工作区根>'
   $backup = Join-Path $env:TEMP 'pi-dsh-sandbox-root-dacl.sddl'
   $access = [System.Security.AccessControl.AccessControlSections]::Access

   # 备份：只用 DACL 一节（不包 owner/group/SACL；%TEMP% 在 PowerShell 里必须写成 $env:TEMP）
   (Get-Acl -LiteralPath $root).GetSecurityDescriptorSddlForm($access) | Set-Content -LiteralPath $backup

   # 最小修复：只给当前账户 WRITE_OWNER
   icacls $root /grant "$env:USERDOMAIN\$env:USERNAME:(WO)"

   # 回滚：只把 DACL 写回，owner/group/完整性标签不变
   $acl = [System.Security.AccessControl.DirectorySecurity]::new()
   $acl.SetSecurityDescriptorSddlForm((Get-Content -LiteralPath $backup -Raw).Trim(), $access)
   Set-Acl -LiteralPath $root -AclObject $acl
   ```

   以上 DACL-only 恢复已在隔离同名目录实测：还原后 SDDL 与原 DACL 完全一致，owner/group 与 Low 标签不变。
   **不要用 `icacls /restore`**：实测非管理员下可能处理 0 个文件并报 1300，且 `/save` 的备份里带 SACL 段（会动到完整性标签）。
   **禁止** `icacls /reset /T`、**禁止**给 `Everyone` 写权限、不要重置整棵目录树。不要不加诊断就给根 `(WO)`：这不是本故障的通用修复。
3. 或把会话换到一个当前账户已具备可继承完全控制（或已继承 Low 标签）的目录。

修复后 `/reload` 再 `/sandbox doctor`。如果 doctor 的临时工作区各项都通过、只有「工作区就绪」失败，那就是这个工作区根的问题，不是后端坏了。

区分两类失败：

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `windows-acl-run:` + `[sandbox: runner-failure]` | 运行器/授权未就绪，命令没执行 | 修工作区/依赖/配置；**不要**用 `sandbox_request` |
| 命令执行但写/删返回 `EPERM`/「拒绝访问」+ `[sandbox: denied]` | 内核拒绝越界写 | 改写到根内，或对该条命令走一次性审批 |

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

1. **不需要全局 DSH**。本包自带固定依赖，并且**内置**了打好补丁的后端：

   ```text
   <包目录>\vendor\dsh-sandbox-windows-acl\lib\runner.js
   ```

   以 `/sandbox status` 为准：`runner:` 应指向包内的 `vendor\...`，`backend:` 显示 `0.2.2-rc.5+pi-dsh.N`，
   `来源` 为 `vendor`。若指向 `node_modules` 里的同名包或全局 DSH，说明当前加载的是旧代码或手工拼装的环境。
   三处都没有时，说明包安装不完整或包目录被移动/删除了。

2. 在源码/包目录重装依赖：

   ```powershell
   cd <源码目录>
   npm ci --include=optional
   npm run vendor:check   # 仅源码目录有该脚本：核对包内 vendored 后端与 PROVENANCE.json
   ```

   或对 tgz 安装目录用 `npm install --prefix <目录> --include=optional --omit=dev <tgz>`（发布包不含 `scripts/`，不会有 `vendor:check`，以 `/sandbox status` 和 `npm run check:package` 为准）。
   不要用“手工把 patched 文件拷进 node_modules”来修：`npm ci`、`npm pack` 或重装会把它抹掉。

3. 如果你显式配置了 `runnerModule` 或 `dshRoot`，**无效路径会直接报错，不会自动换别的运行器**。
   改成正确绝对路径，或删掉该配置让插件优先使用包内 `vendor/` 后端；未显式配置时，
   插件还会按 Node 规则探测插件自己的 `node_modules` 与全局 DSH，优先顺序依次是
   显式配置 > 包内 `vendor/` > 插件 `node_modules` > 全局 DSH。

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
Cannot find module '@deepseek-ai/cordis'
```

或 `@deepseek-ai/dsh-skill` / `@deepseek-ai/dsh-error` 等缺失。本包把运行器直接 import 的包
（`dsh-subprocess`、`dsh-win32-process`、`dsh-lazy-require`、`dsh-skill`）声明为直接 `dependencies`，
但它们自身的 peer（如 `@deepseek-ai/cordis`）仍需要 npm 正常安装。

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
