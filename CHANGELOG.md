# 更新记录

## 0.4.2

- 修复「工作区根无法授权导致沙盒初始化失败」（`SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作区根>)`）的诊断与处置：这属于插件在真实目录上初始化失败，不是命令越界。
- **交付改为包内内置（vendored）的打补丁后端** `vendor/dsh-sandbox-windows-acl/`：以 npm 发布版 `0.2.2-rc.5` 的 `src/` 为基础，应用仓库内 `patches/` 后用 TypeScript 编译；带上游 `LICENSE`、`pin.json`（tarball SHA-256 与补丁哈希）和 `PROVENANCE.json`（每个产物哈希）。resolver 依次为显式配置 > 包内 `vendor/` > 插件 `node_modules` > 全局 DSH。交付不再依赖手工改 `node_modules`（`npm ci`/`npm pack`/重装都会覆盖它），也不以上游发布为前提。上游 `0.2.2-rc.5` 发布版**没有**该修复，本版不声称已发布上游。
- 后端行为：工作区根已经通过**继承**处于 Low no-write-up 时，不再重复写完整性标签（写标签需要 `WRITE_OWNER`；子目录通常只有所有者隐含的 `WRITE_DAC`），只改 DACL 即可完成授权。**正常授权仍会写能力 SID 允许 ACE 与 Everyone 删除子项拒绝 ACE**：这是“不需要额外修复权限/不需要重写现有 Low 标签”，不是“完全不改 ACL”。
- 加固继承标签的 native 解析：ACE 头必须落在 `AclSize` 内，内联 SID 的 `SubAuthorityCount`/长度必须与 `AceSize` 一致才做 `sameSidAt`，且必须遍历完整条 ACL 才接受——前面命中的标签不再掩盖后续损坏，畸形 ACL 不越界读、直接回退为写标签（fail-closed）。
- 后端在**写标签**被 `ERROR_ACCESS_DENIED` 拒绝时，错误详情点名 `WRITE_OWNER`；只改 DACL 的路径保留普通详情。`readiness` 只在错误行含此后端标记时断言该成因，其它 Win32 5 一律列为可能原因（DACL 写权限、受保护描述符、owner/group/SACL、策略），并给出只读检查，不自动改 ACL。
- `readiness` 修正：带括号的合法路径（先用配置根锚定，再平衡括号扫描）、运行器**私有 temp 子目录**（`call-*/dsh-*`，按“等于或位于 temp 根内”判定）。
- `powershell`/`bash` 的 runner-failure 说明继续区分「运行器/工作区未就绪」与「命令被内核拒绝」，并明确这类初始化失败**不能**用 `sandbox_request` 绕过；同一会话内首次出现时弹一条 error 通知给人类。
- `/sandbox doctor` 的「工作区就绪（真实根）」保留；`sandbox_request` 描述与 guidelines 保留防审批轰炸规则。四个审批选项、reason 语义、黄色卡片与语言规则均不变。
- 测试与验证：新增 vendored 后端单元测试（继承标签只改 DACL、畸形 ACE 边界、早命中不掩盖后续损坏）；Windows 集成测试的父子目录 ACL 布局把临时 deny 清理放进 `t.after`，失败时也能清理；`npm run check:pack` 从 tarball 干净安装后**从安装后的插件解析包内 runner**，校验 `PROVENANCE.json`，并在隔离父子 ACL 布局实际运行（授权成功、标签不变、根外仍拒写）。
- 文档修正：DACL 备份/恢复改用 PowerShell `Get-Acl`/`Set-Acl` 的 **Access（DACL）** 一节（隔离同名目录实测：还原后 SDDL 与原 DACL 完全一致，owner/group 与 Low 标签不变）；不再推荐 `icacls /save`/`/restore`（实测非管理员下 `/restore` 处理 0 个文件并报 1300，且 `/save` 备份带 SACL 段）；补充 vendored 来源/许可/重建说明，并更正“完全不改 ACL”的说法。

## 0.4.1

- 简化审批语言规则：用户提示词只要出现中文就用中文，中英混合中文优先；无中文且含英文字母就用英文。移除词数、技术术语过滤和显式语言指令识别。

## 0.4.0

- 审批界面随**当前对话语言**自动切换中文/英文：取当前分支最新的可判定真实用户消息，支持「用英文回答 / answer in English / 用中文回答」等明确切换；中性短消息、代码块、行内代码、URL 与路径不参与判断，无可判定内容时保持中文兼容既有行为。
- 语言由真正用户角色决定，不读取助手回复、工具结果、模型工具参数、`requestReason`、命令正文或插件生成的消息；不调用模型 API，不依赖操作系统语言，也没有模型可指定的 locale 参数。
- 每次申请把 locale 固定到请求/卡片/结果/审计记录：审批中途手动改语言不会混用；TUI 卡片、底部面板、F2 隐藏提示、两个理由输入框、RPC `select`/`input`、放宽模式确认，以及 `/sandbox exec` 的卡片与通知都会切换语言。
- 历史重绘使用保存的语言；旧请求/旧卡片缺少 locale 时按中文处理。命令、申请理由和人类填写的文字原样保留，四个选项标签与 off 执行/审批逻辑不变。
- `reason.ts` 给模型的 continuation 说明也跟随审批语言（用户原文不变）；主目标是可见审批界面。
- 新增检测、真实工具接线、TUI/RPC、历史卡片、人工 exec 与放宽模式的中英文测试；文档说明自动规则与启发式边界。

## 0.3.2

- 整理为可直接上传 GitHub 的源码仓库：发行 tarball、历史版本与开发笔记移出源码树，源码只保留构建所需的文件。
- 发布流程改为在源码之外生成产物：`npm run pack` 默认写入兄弟目录 `pi-dsh-sandbox-pkg`，并生成 `.sha256`、`.manifest.json`、`latest.json`；`npm run check:package` 做离线清单/校验和核对。
- 重写面向用户的文档：安装（源码/tarball）、使用与四项审批、配置、安全边界、故障排查、贡献指南。
- 修正第三方归属说明；补充 `CHANGELOG.md`，供 Pi 在包升级时展示。
- 修复 npm 安装 tarball 后依赖被提升到上层 `node_modules` 时的运行器探测；安装验收明确禁止依赖全局 DSH。
- 沙盒模式与审批语义保持不变；本版以发行整理、安装布局兼容和文档为主。

## 0.3.1

- 审批理由输入框保持**完全空白**，不显示占位文本；标题已说明该填什么。
- 留空、只输入空白或 `Esc` 取消仍然**不批准**本次操作，不会因为已选中带理由的选项而默认通过。

## 0.3.0

- 审批详情移到消息流里的**黄色卡片**：来源、申请理由、完整命令（`BEGIN/END` 标记之间原样展示）、cwd、模式、超时，不再把整段请求塞进对话框标题。
- 底部改为小型黄色审批面板，只放四个选项与按键提示；编辑器草稿保留。
- 新增 `F2`：隐藏面板回看前面的模型输出，再按 `F2` 返回；隐藏期间不执行，选中项与理由保留。
- 只有显式 `Enter` 才结束待批状态；数字键只移动选择，`Esc`/空白/滚动/隐藏都不批准。
- 黄色使用固定 RGB，不读取主题的 `warning`，换主题不会变色；RPC/T3 继续使用宿主原生选择框。

## 0.2.1

- 审批窗口里的文字明确为**给代理的指示**，与模型的 `reason` 申请理由分开：
  - `No, and reason…`：拒绝并**不执行**，文字成为当前任务的新用户指示，代理按新方向继续；
  - `Yes, and reason…`：只执行本次展示的命令，结束后先报告执行事实，再完成补充要求；
  - 文字不改写命令、不变成持久权限；空白或取消视为不批准。
- 工具路径把指示写入本次 tool result；人工 `/sandbox exec` 用一条 `followUp` 用户消息投递，避免重复注入。

## 0.2.0

- 新增模型工具 `sandbox_request`：主动申请**一次性**以 off 执行一条精确 PowerShell 命令。
- 每次申请都必须经过四项审批（`Yes` / `No` / 两个带理由选项），带可选超时（最大 600 秒）。
- 批准只对本次命令与固定规范根有效：不改模式、不授予后续权限、不自动重试；拒绝/取消/无 UI/会话变化均 fail-closed。
- 新增审批审计条目（命令与理由 hash、人类文字、来源），不记录命令输出或文件内容。

## 0.1.x

- 建立基本的 Windows 写入限制机制：`powershell`、`bash`、`!` 与 `write`/`edit` 的实际写操作走 DSH Windows ACL 受限令牌运行器。
- 三种模式：`off` / `read-only` / `workspace-write`；会话根为规范 cwd，`cd` 不扩大授权。
- `/sandbox` 提供 status、mode、doctor、exec、help；放宽模式需要确认，模型不能切换模式。
- 缺运行器、平台不支持、配置错误、helper 失败等情况一律 fail-closed，不静默直通。
