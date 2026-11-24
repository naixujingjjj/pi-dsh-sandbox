# 安全边界

本插件提供的是 **Windows 内核强制的写入限制**，不是完整沙盒、不是容器，也不是“模型不可做坏事”的保证。请在安装前理解下面每一条。

## 1. 一句话模型

- **写入/删除**：受限子进程只能写授权根与运行器私有 temp。
- **读、网络、进程可见性**：不受限。
- **失败**：一律 fail-closed，绝不退回未受限执行。
- **后端的正式标注**：`enforcement: partial`。

## 2. 实际机制

`workspace-write` / `read-only` 下，`powershell`、`bash`、`!` 以及 `write`/`edit` 的实际写操作都通过 DSH 的 `lib/runner.js`：

1. 复制调用者令牌为 `WRITE_RESTRICTED` 受限令牌；
2. 降为 **Low 完整性**；
3. 用能力 SID（capability SID）授予的工作区 ACE + 私有 temp ACE 作为唯一写权限来源；
4. 对 world SID 拒绝 `FILE_DELETE_CHILD`，防止借父目录权限删除；
5. 当根还不在 Low 完整性时，在同一个 `SetNamedSecurityInfoW` 调用里把目录标为 Low；若根已经通过继承处于 Low no-write-up，则跳过这次标签写入（标签在 SACL 中，写它需要 `WRITE_OWNER`）。
6. 子进程的 stdio 继承，退出码原样返回；任何 Win32 失败都阻止不受限 spawn。

因此，普通命令拒绝写入时，是**内核拒绝**；插件侧的包含判定只用于提前给出更清楚的报错。

## 3. 覆盖范围

| 对象 | 是否受本插件约束 |
| --- | --- |
| `powershell`、`bash`、`!`/`!!` | 是（confined 模式） |
| `write`、`edit` 的实际 `mkdir`/写文件 | 是（受限 helper） |
| `read`/`ls`/`grep`/`find` 与 `edit` 的读取部分 | **否**（Pi 进程内） |
| MCP 工具（web search/fetch、数据库等） | **否** |
| 第三方扩展、插件直接调用的 `pi.exec` / 文件 API | **否** |
| 整个 Pi 宿主、子代理运行时 | **不承诺** |

插件只**同名覆盖** `powershell`、`bash`、`write`、`edit`，并注册 `/sandbox`、`sandbox_request` 和四个 CLI 参数。它不会把整个宿主装进沙盒；其它扩展和 MCP 仍按它们自己的权限运行。

### 3.1 子代理

是否加载本插件取决于宿主如何为子代理装配扩展与工具，本仓库不把子代理视为额外的信任边界。

可以确认的行为是：没有可确认 UI 时，`sandbox_request` 返回 `no-ui` 并**不执行**，提示由上层代理或用户在交互式终端发起。子代理不能代替人类批准，也不会因为“在子代理里”而获得更宽的模式。

## 4. 读与网络

- **读不受限**：受限子进程可读你有权读的任何文件，包括其它工作区、`~/.ssh`、浏览器配置等。`read`/`grep` 等本来就在 Pi 进程内，连受限令牌都不经过。
- **网络不受限**：受限子进程可任意联网；MCP web 工具完全不经过本插件。
- 需要读侧隔离或网络限制时，应配合 AppContainer、防火墙、独立用户/虚拟机等其它机制；本插件不提供这些能力。

## 5. 硬链接例外

硬链接是**文件对象别名**，不是路径别名：

- 工作区授权会传播到那个底层文件的安全描述符；
- 同一个文件如果在根外还有一个硬链接，通过该别名仍然可写；
- 拒绝工作区中的所有多链接文件不可行（普通 pnpm 安装就使用硬链接）。

这是机制固有边界，不是配置错误。不要把“根外硬链接”当成被隔离。

## 6. 常驻副作用（最重要的代价）

`workspace-write` 第一次授权时会在**授权根**上留下改动：

1. 一条**能力 SID 允许 ACE**：SID 由规范根路径确定性派生（`S-1-4-<hash>`），每个工作区每台机器一次；
2. 一条对 **world/Everyone 的 `FILE_DELETE_CHILD` 拒绝**（仅容器继承），防止借父目录删除；
3. 当根还不在 Low 完整性时，把它标为 **Low 完整性**，带禁止向上写（no-write-up）策略；根已通过继承具备该标签时不重复写。

标签只在需要时写：如果根**已经**通过继承处于 Low no-write-up（父目录带了可继承的 Low 标签），
后端只做 DACL 改动。写标签属于 SACL，需要 `WRITE_OWNER`；只改 DACL 只需 `WRITE_DAC`（所有者隐含具备）。
这一区别有安全意义：跳过的是“写一个已经生效、与现有继承标签完全相同的标签”，从不把任何目录降到更低，
也不会让本该拒绝的写变得可写；若继承标签后来被父目录改掉，沙盒会以写失败（fail-closed）告终。

**“不需要额外修复权限”不等于“完全不改 ACL”**：正常授权仍会写第 1、2 项（能力 SID 允许 ACE 与
Everyone 删除子项拒绝 ACE），那属于沙盒授权本身；不需要的是为脚本补 `WRITE_OWNER`/`(WO)` 这类额外修复权限。

这些改动：

- **不会**随会话结束、`/reload`、插件卸载或 Pi 退出而撤销；
- 是跨会话的复用缓存：第二次进入同一工作区会命中已有 ACE/标签并跳过重新传播；
- 首次传播是**整棵树**的急切传播，大目录可能耗时数十秒；
- 会让根内的目录拒绝以 `GENERIC_ALL`/FullControl 方式打开（`FILE_DELETE_CHILD` 的副作用）；普通读写、`MAXIMUM_ALLOWED` 和基于 `DELETE` 的删除不受影响。

### 6.1 Low 标签的连带影响

Low 标签会**放宽**该目录树对其它 Low 完整性进程的可写性：别的产品的 Low-IL 沙盒、受保护模式阅读器，只要以同一用户运行在 Low，就可能写入/删除这个目录。Medium 标签下它们会被拒绝。

这是写入边界的前提：没有 Low 标签，受限子进程根本无法写入；按会话撤销标签会导致每次都要重新传播整棵树。

### 6.2 临时授权

私有 temp 的能力 SID 是随机、按调用创建的，运行器退出时会撤销；工作区授权则是常驻的。临时目录删除后，相关拒绝项会随目录消失；手工 `icacls` 无法回收未映射的能力 SID（会报 `ERROR_NONE_MAPPED (1332)`）。

## 7. 回滚与恢复

只能**精确恢复你实际备份过的状态**。没有“一键恢复到出厂 ACL”的安全方法。

### 推荐：使用可丢弃的工作区

如果这个目录只是临时副本、生成产物或可重新 clone 的检出，**用完直接丢弃整个副本**。这是最可靠的回滚：安全描述符随对象一起消失。

### 需要保留内容：先备份 DACL

在**首次使用沙盒之前**备份 DACL。用 PowerShell 的 `Get-Acl` 只取 **Access（DACL）** 一节，恢复时同样只写这一节；
owner/group/SACL（完整性标签）都不参与，因此不会把 Low 标签改掉。

```powershell
$root   = 'D:\work\demo'
$backup = Join-Path $env:TEMP 'demo-dacl.sddl'   # 记下这个真实路径
$access = [System.Security.AccessControl.AccessControlSections]::Access

# 备份（只存 DACL）
(Get-Acl -LiteralPath $root).GetSecurityDescriptorSddlForm($access) | Set-Content -LiteralPath $backup

# …确认发生了沙盒授权…

# 恢复（只替换 DACL）
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetSecurityDescriptorSddlForm((Get-Content -LiteralPath $backup -Raw).Trim(), $access)
Set-Acl -LiteralPath $root -AclObject $acl
```

在隔离的同名目录（父目录 + `pi-dsh-sandbox` 子目录，带可继承 Low 标签）中实测：
添加 Everyone 删除子项拒绝 ACE 与一条显式允许 ACE 后，用上面代码恢复得到**与原 DACL 完全相同的 SDDL**，
owner/group 与完整性标签均不变。

限制与注意事项：

- 上述代码只读写 **DACL**。Low 标签（SACL）不会被备份或还原；恢复后仍是原标签。
- **不要用 `icacls /restore` 作为 DACL 回滚**：实测非管理员下可能 `Successfully processed 0 files` 并报 1300，
  且 `icacls /save` 的备份文件带 SACL 段，回写需要额外特权（会把标签一起动）；`icacls /save` 也不能当纯 DACL 备份。
- 当前插件没有“自动撤销 Low 标签/能力 ACE”的功能。
- 恢复要按条目精确进行；不要把所有对象统一改成 Medium 来代替原始标签——那只是换了一种错误状态。
- 如果后端在**写 Low 标签**时返回 `ERROR_ACCESS_DENIED` 并明确点名 `WRITE_OWNER`，修复步骤（包括可回滚的最小 `(WO)` ACE）
  在 [troubleshooting 的「工作区根无法授权」](troubleshooting.md#工作区根无法授权grantwrite-win32-5) 一节；那属于修工作区，不是扩充沙盒权限。
  普通的 `SetNamedSecurityInfoW` Win32 5 **不**足以断定是缺 `WRITE_OWNER`：也可能是 DACL 写权限、受保护描述符、
  所有者/组/SACL 写入被拒。先做只读检查，再决定是否修改 ACL；插件不会自动改。

### 绝对不要做

- ❌ `icacls <根> /reset /T`：会抹掉你在该目录树上原有的自定义 ACL，只重建继承来的默认项，属于不可逆破坏。
- ❌ 手工 `icacls /remove` 能力 SID：未映射 SID 会报 `ERROR_NONE_MAPPED (1332)`，并不能安全还原。
- ❌ 为了“卸载干净”而删除需要保留的真实项目。卸载插件不会撤销副作用；删除项目只会丢失你的数据。
- ❌ 把整个用户目录、`C:\`、仓库根之上很大的目录当作工作区来“试一下”。首次传播和 Low 标签会影响整棵树。

## 8. 一次性 off 执行（`sandbox_request` / `/sandbox exec`）

批准后执行的那条命令**不经过沙盒**。它可以修改当前用户有权访问的任意文件，包括根外文件、用户配置、其它项目。审批只保护：

- **这一条**精确命令（屏幕展示的原文）；
- **这一个**固定 cwd（当前会话规范根）；
- **这一次**执行。

它**不**：

- 改变 `state.mode`；
- 设置“全局已批准”标志；
- 给后续 `write`/`edit`/`powershell` 任何授权；
- 让审批文字变成持久权限或后续命令的一部分。

审批文字是给代理的任务指示：`No, and reason…` 让代理换方向继续（被拒命令不执行）；`Yes, and reason…` 要求代理在操作结束后先报事实、再完成补充要求。它不是“允许更多操作”的授权。

批准后的执行**不受** ACL/Low 约束：模型工具 `sandbox_request` 使用 Pi 的本地 PowerShell operations（`createLocalPowerShellOperations`）执行；人工 `/sandbox exec` 使用 `pi.exec`。两条路径都不经过受限运行器。拒绝、取消、无 UI、空白理由、晚到的批准、会话/根/模式变化都会让它不执行。

## 9. Fail-closed 清单

以下情况一律**不执行**，也不会退回未受限路径：

- 平台不是 Windows；
- 找不到 runner，或显式配置的 `runnerModule`/`dshRoot` 无效；
- 配置不可解析、模式非法、出现不支持的额外可写根；
- temp 根不可创建或位于工作区内；
- helper 缺失、没有返回结果协议、runner 打印 `windows-acl-run:`（包括“工作区就绪”类初始化失败）；
- `read-only` 下的任何 `write`/`edit`；
- 审批 UI 不可用、审批被取消、理由为空、批准在 signal 取消后到达。

运行器初始化失败与命令被内核拒绝是两件事：前者命令没执行，不能被 `sandbox_request` “绕过”（它只跑一条一次性命令，
不修工作区也不修运行器）；后者是内核真的拒绝了越界写，才可能属于一次性审批的场景。

宁可报错，也不静默直通。`off` 只能由人类显式选择（配置、CLI 或确认后的 `/sandbox mode off`）。

## 10. 管道与 PowerShell 语言模式

- **管道 stdio 的 `EPERM`**：受限子进程无法为新建的命名管道打开写端，因此 `spawn(..., { stdio: "pipe" })` 在受限进程中会 `EPERM`。本插件的 `write`/`edit` 用**继承 stdio + 请求文件**规避；Node 测试运行器的默认子进程隔离模式、Pi 内置本地 PowerShell 后端等仍可能触发。
- **`read-only` 下的 ConstrainedLanguage**：后端在只读模式无法创建 AppLocker 探测文件，PowerShell 会保守地进入 `ConstrainedLanguage`；`Add-Type`、非核心 .NET 静态调用、COM、反射会失败。这是后端/PowerShell 启动行为，不是 ACL 写边界的一部分。日常使用 `workspace-write`。

## 11. 提示注入与审批 UI

- 审批卡片会剥掉 ANSI 转义与控制字符、展开制表符、把多行显示为多行；**执行仍使用原始字符串**。这能防止命令文本伪造界面，但不能防止模型被恶意内容诱导去申请一条危险命令。
- 读与网络不受限，模型可能读取到不可信内容并据此发起申请；**人类必须自己阅读卡片上的完整命令、cwd 与理由**，不要只看“看起来像批准”的标题。
- 黄色高亮、`F2` 回看、四项选择都只是让审批更可读，**不是**对提示注入的全面防护。不要在没有阅读的情况下按 `Yes`。
- 审批文字会进入会话记录；不要在其中填写密码/令牌。

## 12. 审计记录

插件用会话条目记录审批：

- `requestId`、`toolCallId`、时间、cwd、模式、状态；
- 命令与申请理由的 **SHA-256 hash**；
- 人类填写的审批文字与 `reasonSource`。

它**不**记录命令输出或文件内容。批准后的审计写入失败会在执行前失败；执行后的审计写入失败会如实说明“命令已执行”。

## 13. 建议的部署方式

- 把沙盒工作区设为**项目检出**或一次性副本，而不是整个用户目录。
- 不要把长期机密（私钥、令牌、生产配置）放在 Low 标签的目录树里；读本来就不受限，Low 标签还会放宽其它 Low 进程的写入。
- 首次在大目录使用前先备份 DACL 或确认该目录可丢弃。
- 安装/更新后先跑 `/sandbox doctor`，不要默认关沙盒来“排除故障”。
- 需要读隔离、网络隔离或多用户隔离时，选择真正的容器/虚拟机/独立账户方案；本插件只负责写入边界。