# 内置（vendored）后端与补丁说明

`vendor/dsh-sandbox-windows-acl/` 是 **`@deepseek-ai/dsh-sandbox-windows-acl@0.2.2-rc.5` 的本地构建副本**：
以上游 npm tarball 的 `src/` 为基础，应用本目录 `patches/` 里的补丁，再由 `scripts/build-vendor-runner.mjs`
用 TypeScript 编译出 `lib/`。它不是上游发布产物，上游 `0.2.2-rc.5` **没有**包含这里的修复。

## 为什么内置

`workspace-write` 首次授权真实工作区根时，后端会同时写入 DACL（能力 SID 允许 ACE、Everyone
`FILE_DELETE_CHILD` 拒绝 ACE）和 Low no-write-up 完整性标签。标签在 SACL 中，写标签需要
`WRITE_OWNER`；若工作区根只从父目录继承到普通组权限（父目录把当前账户的完全控制限制在自己一层，
ACE 没有继承标志），根就只具备所有者隐含的 `WRITE_DAC`，整个 `SetNamedSecurityInfoW` 返回 Win32 5，
沙盒初始化失败（fail-closed）。真实根在隔离布局中已按 37/37 复现并定位。

修复：**根已经通过继承处于 Low no-write-up 时，只做 DACL 改动，不重复写标签**。跳过的是“写一个
已经生效、与现有继承标签完全相同的标签”，不会把目录降级，也不会放宽任何写权限；若继承标签后来被
父目录改掉，授权会重新走到写标签并（在缺少 `WRITE_OWNER` 时）失败，仍然是 fail-closed。

上游 `0.2.2-rc.5` 发布版只承认“完全相同的显式 Low 标签”；子目录继承到的标签带 `INHERITED_ACE`
标志，因此发布版会重复写标签并失败。插件的交付**不能**依赖手工改 `node_modules`：`npm ci`、`npm pack`
或干净安装都会覆盖手工改动。因此把打了补丁的构建副本放进包内，resolver 优先使用它。

## 补丁内容（`patches/0001-low-label-guard-and-acl-walk-bounds.patch`）

1. `grantWrite` 新增 `hasEffectiveLowLabel`：识别带 `INHERITED_ACE`、`OI|CI`、`NO_WRITE_UP`
   且 SID 为 Low 的继承标签。命中时只合并 DACL，`SetNamedSecurityInfoW` 不再携带
   `LABEL_SECURITY_INFORMATION`，因此只需要 `WRITE_DAC`。
2. `hasEffectiveLowLabel` 的 ACL 遍历做边界校验：读 ACE 头之前先确认 4 字节头在 `AclSize` 内；
   候选标签 ACE 的 `AceSize` 必须容得下 mask 与内联 SID 头，内联 SID 的
   `SubAuthorityCount` 不得超过 `SID_MAX_SUB_AUTHORITIES`，声明的子权威必须落在 `AceSize` 内，
   之后才允许 `sameSidAt` 读取。畸形 ACE 一律视为“没有有效标签”（走写标签的 fail-closed 方向），
   并且遍历完整条 ACL 才返回结果——前面命中标签不会掩盖后面的损坏。
3. `SetNamedSecurityInfoW` 返回 `ERROR_ACCESS_DENIED` 且这次确实在写标签时，错误详情点名
   `WRITE_OWNER`（标签在 SACL 中）；只改 DACL 的路径仍保留普通详情。

## 来源与许可

- 来源：`@deepseek-ai/dsh-sandbox-windows-acl@0.2.2-rc.5` 的 npm tarball，
  SHA-256 见 `pin.json` 的 `upstreamTarballSha256`（构建时强制校验）。
- 许可：MIT，原文见同目录 `LICENSE`（上游 `LICENSE` 逐字节复制）。`THIRD_PARTY_NOTICES.md` 有归属说明。
- 版本标识：`package.json` 为 `0.2.2-rc.5+pi-dsh.1`（semver build metadata 标出本地补丁），
  并带 `piDshSandbox.vendored` 标记；`PROVENANCE.json` 记录输入 tarball、补丁、构建工具版本和
  每个产物文件的 SHA-256。

## 重建与校验

```powershell
npm run vendor:build   # 联网 npm pack 固定版本 -> 校验 SHA-256 -> 打补丁 -> tsc -> 写 PROVENANCE.json
npm run vendor:check   # 离线：核对 pin/补丁/产物哈希，确认 vendor/ 未被手改
```

`vendor:build` 需要 `devDependencies`（TypeScript）与网络；产物与 `src/` 会一并写回本目录，提交前请
用 `vendor:check` 与 `npm run check:pack` 复核。禁止手工编辑 `vendor/**/lib/`：改动会被 `vendor:check` 拒绝。

## 不做的事

- 不在 `postinstall` 里改 `node_modules` 里的第三方包。
- 不依赖本机绝对路径或临时开发目录；`patches/`、`pin.json` 与构建脚本即可复现。
- 不声称上游已发布该修复；插件只保证**包内**的这份构建。