# 安装

本文覆盖两种安装来源：**源码目录**和**发布页的 `.tgz`**。两种方式最终都是让 Pi 加载一个本地包目录；运行依赖由 npm 安装，安装时需要联网。

> 本文不假设具体的 GitHub 仓库地址。请从项目实际发布页下载源码压缩包或 `.tgz`。

## 1. 系统要求

| 项 | 要求 |
| --- | --- |
| 操作系统 | **Windows 10/11 x64**。其它平台在 confined 模式下会报 `SANDBOX_UNAVAILABLE`；只有你显式把模式切成 `off` 才会回到 Pi 内置执行路径 |
| Node.js | **建议 Node 24 LTS**；最低 **22.19**（`engines` 与 Pi 的要求） |
| Pi | `@earendil-works/pi-coding-agent` **>= 1.6** |
| 运行器 | 本包固定的 `@deepseek-ai/dsh-sandbox-windows-acl@0.2.2-rc.5`。**不需要**全局安装 DSH |
| 可选 bash | Git for Windows、MSYS2 或 Cygwin 的 `bash.exe`；WSL 的 `bash.exe` 会被拒绝 |
| 网络 | 源码安装和 tgz 安装都需要从 npm 源取运行依赖 |
| 权限 | 当前用户对工作区目录有正常读写权限；首次 `workspace-write` 授权需要能修改该目录的 DACL/SACL |

Node 与 Pi 的版本在启动时就会影响扩展加载；先用 `node --version`、`pi --version` 确认。

## 2. 从源码目录安装

### 2.1 取得源码并放在固定目录

从发布页下载源码压缩包并解压，或 clone 仓库，放到一个**固定的绝对路径**，例如：

```text
C:\src\pi-dsh-sandbox
```

目录里应当直接看到 `package.json`、`package-lock.json`、`src\index.ts`。

### 2.2 安装运行依赖

```powershell
cd C:\src\pi-dsh-sandbox
npm ci --include=optional
```

说明：

- `--include=optional` **必须带**。`koffi` 的平台二进制包是 optional 依赖；省略或加上 `--omit=optional` 会让运行器在加载原生模块时失败。
- `npm ci` 要求 `package-lock.json` 存在，并严格按锁文件安装；这正是我们希望的可复现安装。
- 只想要运行依赖、不要开发工具时，可以加 `--omit=dev`：

  ```powershell
  npm ci --include=optional --omit=dev
  ```

- **不要加 `--omit=peer`**，除非你确认本仓库的 `package.json` 已把 DSH 后端的运行依赖提升为直接 `dependencies`。当前锁定的后端把 `@deepseek-ai/dsh-subprocess` 等声明为 **peer**；`--omit=peer` 会让 npm 不把它们写到磁盘，运行器 `lib/runner.js` 会在 `import "@deepseek-ai/dsh-subprocess/control"` 处失败。
- 本包声明给宿主 Pi 的 peer（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`）是**可选 peer**，由 Pi 在加载扩展时提供。不要为了它们安装第二份副本。
- 安装依赖需要联网。若 npm 缓存/镜像缺包，见 [troubleshooting](troubleshooting.md)。

### 2.3 先临时加载，再正式安装

```powershell
# 只在本次 Pi 进程里加载，不写任何配置
pi -e C:\src\pi-dsh-sandbox

# 确认 /sandbox status 正常后，写入全局 packages
pi install C:\src\pi-dsh-sandbox
```

- `pi install` 记录的是**解析后的绝对路径**，不会复制源码目录。**不要删除或移动** `C:\src\pi-dsh-sandbox`，也不要删掉它的 `node_modules`；否则下次启动会加载失败。
- `pi install` 只改 Pi 全局 `settings.json` 的 `packages` 数组。它**不会**改你的 `defaultTools`、主题、模型或其它设置；安装本插件也不需要你手工编辑任何用户设置。
- 安装后启动 Pi，或在已运行的 Pi 里执行 `/reload`，然后运行 `/sandbox status`。

### 2.4 如果只想跑一次

`pi -e <绝对目录>` 是临时加载：不写 `packages`，进程退出即结束。适合先验证 `/sandbox doctor`，再决定是否正式安装。

## 3. 从 `.tgz` 安装

### 3.1 为什么不能直接 `pi install <tgz>`

Pi 的本地 source 规则是：**文件路径按单个扩展源码加载，目录路径按包发现规则加载**。`.tgz` 是压缩包，不是扩展源码；直接 `pi install .\pi-dsh-sandbox-0.3.2.tgz` 不会把它当作 npm 包安装。

正确做法是先用 npm 把 tarball 装进一个固定目录，再把该目录里的包目录交给 `pi install`。

### 3.2 准备固定目录

建议使用一个专门放本地扩展的固定位置，例如：

```powershell
$extRoot = "$env:LOCALAPPDATA\pi-extensions"
New-Item -ItemType Directory -Force -Path $extRoot | Out-Null
```

这个目录以后不要随意删除或移动；Pi 记录的是它内部的绝对路径。

### 3.3 安装 tarball 及其依赖

```powershell
$tgz = "C:\src\downloads\pi-dsh-sandbox-0.4.1.tgz"   # 换成你下载的文件
npm install --prefix $extRoot --include=optional --omit=dev "$tgz"
```

说明：

- `.tgz` 只包含本包的源码/文档，**不包含** `node_modules`，也不是“离线全依赖包”。`npm install` 会联网安装固定的 DSH 后端、`koffi` 等依赖。
- `--include=optional` 仍然必须带，否则 `koffi` 的平台二进制不会落盘。
- 同样**不要加 `--omit=peer`**，原因见 2.2：当前后端把运行所需的 DSH 包声明为 peer。
- npm 可能在该目录生成/更新 `package.json`、`package-lock.json`；保留它们，后续 `pi install` 不需要它们，但删除目录再重装时会用到锁文件。
- 如果你下载的发布页同时提供 `.sha256` 或 `.manifest.json`，先核对校验和再安装。

安装完成后应存在：

```text
%LOCALAPPDATA%\pi-extensions\node_modules\pi-dsh-sandbox\
```

### 3.4 交给 Pi

```powershell
pi install "$extRoot\node_modules\pi-dsh-sandbox"
```

然后启动 Pi 或 `/reload`，用 `/sandbox status` 确认：

- `mode` 是 `workspace-write`（默认）；
- `runner:` 指向实际使用的 `@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js`。它可能在包目录的 `node_modules` 下，也可能被 npm 提升到 `<extRoot>\node_modules\@deepseek-ai\...`；以 `/sandbox status` 显示的路径为准；
- `backend:` 显示 `0.2.2-rc.5`；
- `enforcement: partial`。

符合上述内容即说明本包自带的固定 DSH 依赖可用，**不需要全局 DSH**。

### 3.5 不要把包目录解压出来直接加载

仅在一种情况下可以直接 `pi install <目录>`：该目录本身有 `package.json`，且已经装好运行依赖（即 2.2 的 `npm ci`）。只解压 tarball 而不装依赖，会让 `runnerModule`/`koffi` 缺失。

## 4. 已安装后的更新与卸载

- **更新源码**：替换源码文件后重新 `npm ci --include=optional`，再 `/reload`。
- **更新 tgz**：重新执行 3.3 的 `npm install`，再 `/reload`。旧版本文件会在同一包目录内被替换；不要手工删除整个 `pi-extensions`。
- **卸载**：

  ```powershell
  pi list
  pi remove <pi list 中显示的同一 source>
  ```

  本地包通常显示为绝对路径；用**同一个 source** 移除。`pi remove` 只从 `packages` 移除，不删除目录，也**不撤销** `workspace-write` 已写入的 ACE/Low 标签。

## 5. 安装后的最小验收

```text
/sandbox status        # 模式、根、runner、后端版本、temp、bash
/sandbox doctor        # 在独立临时工作区做真实写内/拒外/拒删/只读自检
```

`doctor` 全部 PASS 表示沙盒后端可用。若失败，先看 [troubleshooting](troubleshooting.md)，不要为了“能用”而默认把模式改成 `off`。

## 6. 常见安装问题的入口

| 症状 | 先看 |
| --- | --- |
| 缺 `koffi`、`Cannot find module 'koffi'` | [troubleshooting: 原生模块](troubleshooting.md#原生模块-koffi-加载失败) |
| 找不到 runner | [troubleshooting: runner](troubleshooting.md#找不到运行器) |
| `bash` 被拒绝 / 检测到 WSL | [troubleshooting: bash](troubleshooting.md#bash-与--命令被拒绝) |
| 配置改了不生效 | [troubleshooting: 配置](troubleshooting.md#改了配置但不生效) |
| 模式或 UI 不符合预期 | [usage](usage.md) 与 [troubleshooting: 审批](troubleshooting.md#审批没有执行) |
| 想回滚 ACL/目录 | [security: 回滚](security.md#7-回滚与恢复) |