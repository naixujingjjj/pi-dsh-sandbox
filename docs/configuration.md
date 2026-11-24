# 配置

本插件的授权配置**只有一个来源**：Pi 的全局设置文件，加上显式 CLI 参数。项目内的 `.pi/settings.json` 完全被忽略。

## 1. 配置文件在哪

| 平台 | 路径 |
| --- | --- |
| Windows | `%USERPROFILE%\.pi\agent\settings.json` |
| 类 Unix（仅用于查看结构；沙盒本身只支持 Windows） | `~/.pi/agent/settings.json` |

本插件读取顶层键 `piDshSandbox`：

```json
{
  "piDshSandbox": {
    "mode": "workspace-write"
  }
}
```

- 这是**唯一**会被读取的配置段；其它顶层键由 Pi 自己处理，本插件不碰。
- 如果文件不是合法 JSON，或 `piDshSandbox` 不是对象，沙盒会 **fail-closed**（工具报 `SANDBOX_CONFIG`），修复后 `/reload`。
- 本插件**不会**主动修改这个文件。安装时只有 `pi install` 会往 `packages` 写一条记录。

## 2. 字段

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `mode` | string | `workspace-write` | `off` / `read-only` / `workspace-write`。无效值会让沙盒报错 |
| `runnerModule` | string（绝对路径） | 未设置 | 运行器 `lib/runner.js` 的完整路径。设置后**只**用它；文件不存在直接报错，不会悄悄换别的运行器 |
| `dshRoot` | string（绝对路径） | 未设置 | DSH 安装根；等价于 `<dshRoot>\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js`。与 `runnerModule` 同时设置时 `runnerModule` 优先 |
| `tempRoot` | string（绝对路径） | `%LOCALAPPDATA%\pi-dsh-sandbox\tmp` | 运行器 `--temp` 的根目录；必须在工作区**之外**。插件会尝试创建它 |

`runnerModule`、`dshRoot`、`tempRoot` 都是**可选**的。正常情况下只写 `mode` 即可；本包**内置**（vendored）已打补丁的后端，不需要全局 DSH，也不需要手工指定路径。未显式配置时的查找顺序：包内 `vendor/dsh-sandbox-windows-acl/lib/runner.js` → 插件 `node_modules` → 全局 DSH。

### 2.1 完整但不必全填的示例

最简：

```json
{
  "piDshSandbox": {
    "mode": "workspace-write"
  }
}
```

只读 + 自定义 temp：

```json
{
  "piDshSandbox": {
    "mode": "read-only",
    "tempRoot": "D:\\pi-dsh-sandbox-tmp"
  }
}
```

显式指定运行器（仅当你确实要覆盖包内 vendored 后端时）：

```json
{
  "piDshSandbox": {
    "mode": "workspace-write",
    "runnerModule": "D:\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js"
  }
}
```

显式指定 DSH 根（与上例二选一，不要两个都填）：

```json
{
  "piDshSandbox": {
    "dshRoot": "D:\\dsh"
  }
}
```

示例里的路径只是占位，请换成你的实际绝对路径。JSON 中的反斜杠要写成 `\\`。

### 2.2 temp 的约束

- `tempRoot` 必须是**绝对路径**，且不能等于或位于当前工作区根内；否则 `assertReady` 会拒绝执行（`SANDBOX_CONFIG`）。
- 插件会在启动时 `mkdir -p` 该目录；如果创建失败，同样 fail-closed。
- 运行器会在 temp 下创建随机私有子目录，子进程退出后删除；宿主还会为每次调用持有 `call-*` 父目录，超时/取消时尝试清理。崩溃或目录被占用时仍可能残留（见 [troubleshooting](troubleshooting.md#临时目录残留)）。

## 3. CLI 参数

四个参数由扩展注册，值都是字符串：

| 参数 | 对应配置 |
| --- | --- |
| `--sandbox-mode <off\|read-only\|workspace-write>` | `mode` |
| `--sandbox-runner <绝对路径>` | `runnerModule` |
| `--sandbox-dsh-root <绝对路径>` | `dshRoot` |
| `--sandbox-temp <绝对路径>` | `tempRoot` |

示例：

```powershell
pi --sandbox-mode read-only
pi --sandbox-mode workspace-write --sandbox-temp "D:\pi-dsh-sandbox-tmp"
```

这些是**临时覆盖**：只影响本次 Pi 进程，不写回设置。显式传了无效值（例如相对路径、未知模式）会报配置错误并阻止执行，不会静默忽略。

## 4. 优先级

从高到低：

1. **CLI 参数**（`--sandbox-*`）
2. **全局 `settings.json` 的 `piDshSandbox`**
3. **内置默认值**

`/sandbox mode ...` 改的是**当前会话**的运行时模式，不写配置文件，也不是第 4 个持久来源。新会话、恢复会话、fork 或重启后都会重新从配置/CLI 起点开始。

## 5. 为什么项目配置被忽略

`<workspace>/.pi/settings.json` 中的任何 `piDshSandbox` 内容都不会被读取。

原因很直接：工作区是**被保护对象**。如果项目配置能改模式或运行器路径，那么模型只要往仓库里写一个 `.pi/settings.json`，就能把模式改成 `off`，或把运行器指向任意程序——沙盒会被它要保护的对象自己解除。只有人类编辑的全局设置和显式 CLI 参数能改变授权。

项目配置的其它 Pi 键（模型、工具等）由 Pi 按它自己的项目信任规则处理；**本插件不读、也不据此放宽**。

## 6. 不支持“额外可写根”

以下键一旦出现在 `piDshSandbox` 中，沙盒直接 fail-closed 并报 `SANDBOX_CONFIG`：

```text
additionalWritableRoots
writableRoots
additionalRoots
writeRoots
extraRoots
```

原因：**当前插件与 runner 接口只为会话配置一个工作区根**（当前会话 cwd）；`workspace-write` 的额外写权限只有运行器私有的 temp。本版本不支持持久的额外可写根，所以这些键会被拒绝，避免写成配置却误以为已经放开。

确实需要一次性写到根外时，用 `sandbox_request` 或 `/sandbox exec` 的**一次性**审批，不要试图扩展模式。

未知的其它键不会 fatal，但会产生 warning（`未知配置项 ... 已忽略`），可在 `/sandbox status` 看到。

## 7. 模式的配置边界

- `mode` 来自配置/CLI，是每个会话的起点。
- 只有人类 `/sandbox mode` 能改**当前会话**；模型没有切换模式的工具，`sandbox_request` 的批准也不改模式。
- `off` 只能由人类通过配置、CLI 或确认后的 `/sandbox mode off` 选择；不存在“项目配置自行 off”的路径。
- 恢复/分叉会话不会从历史带回更宽的模式。

## 8. RPC / print / json 的审批后端

- 交互式 TUI：黄色卡片 + 浮层面板（固定黄色，不跟随主题）。
- RPC/T3：宿主原生 `select`/`input`；标题是纯文本，不含 ANSI。
- `print`/`json`：没有可确认 UI。`sandbox_request`/`/sandbox exec` 一律不执行。
- TUI 面板创建失败时，退回原生四选项对话框；仍然需要明确选择，**不会自动批准**。
- 任何审批后端失败都不会“回退为未受限执行”；普通工具在配置/运行器不可用时同样 fail-closed。

## 9. 版本固定

- 运行依赖 `@deepseek-ai/dsh-sandbox-windows-acl` 在包内**内置**为 vendored 构建：上游 `0.2.2-rc.5` 源码 + 本地补丁，包内版本标识 **`0.2.2-rc.5+pi-dsh.1`**（`vendor/dsh-sandbox-windows-acl/pin.json` 固定上游 tarball 与补丁哈希，`PROVENANCE.json` 记录产物哈希）。
- 运行器以 argv 前缀协议调用；不同后端版本可能改变行为或参数契约。不要用 `npm update` 随意漂移插件依赖；升级应连同本插件一起测试。
- `/sandbox status` 会显示实际使用的 runner 路径与后端版本；正常情况下来源应为 `vendor`。如果它指向 `node_modules` 或全局 DSH，先检查是否有 `runnerModule`/`dshRoot` 覆盖，或包目录是否完整。

## 10. 配置改动后

修改全局设置后，在 Pi 里执行 `/reload`。插件在 `session_start` 时重新读取配置并重建运行时；仅修改文件不会热更新当前会话。

如果 `/sandbox status` 显示 `config: 错误 ...` 或 `runner: 不可用 ...`，先修复配置/依赖，再重试工具；不要通过把模式改成 `off` 来绕过。