# 整理源码与发布安装包

上传 GitHub 的是源码目录。运行依赖 `node_modules/`、安装包和本地开发记录不属于源码仓库。

## 上传源码

首次创建仓库时，在源码根目录运行：

```powershell
git init
git add .
git diff --cached --stat
git status --short
```

确认待提交内容后再提交、添加你自己的 GitHub remote 并推送。项目已提供 `.gitignore`；不要使用 `git add -f` 把依赖、密钥或安装包强行加入仓库。

如果通过 GitHub 网页上传，可使用整理好的 `pi-dsh-sandbox-<版本>-source.zip`：先解压，再上传其中源码目录的内容，包括 `.github/`、`.gitignore` 等隐藏文件。不要将本机包含 `node_modules/` 的整个目录直接拖进上传框，也不要只上传 ZIP 文件代替源码。

仓库已提供 Windows GitHub Actions 工作流。首次推送后，在 Actions 中查看检查结果；本地测试通过并不代表远端工作流已经运行。

## 本地检查与打包

在普通、未受限的 Windows 终端中执行：

```powershell
npm ci --include=optional
npm run vendor:check   # 确认包内 vendored 后端与 PROVENANCE.json 一致
npm run verify:windows
npm run pack
npm run check:package
```

测试使用临时目录和本地测试模型，不需要真实模型 API。真实内核测试会修改临时测试工作区的 ACL；不要从本插件的受限 shell 中运行整套测试。

`npm run pack` 默认输出到源码目录旁的 `pi-dsh-sandbox-pkg/`，不会把安装包留在源码根目录。也可以指定外部目录：

```powershell
npm run pack -- --out-dir D:\releases\pi-dsh-sandbox
```

每个版本包含：

- `pi-dsh-sandbox-<版本>.tgz`：供 npm 安装的插件包，含 `vendor/dsh-sandbox-windows-acl/`（打好补丁的后端源码、编译产物、上游 `LICENSE`、`pin.json`、`PROVENANCE.json`、`patches/`），**不含** npm 依赖；安装时仍需联网。
- 同名 `.tgz.sha256`：SHA256 校验值。
- 同名 `.tgz.manifest.json`：文件清单、版本及校验值。
- `latest.json`：本地最新版本索引。

升级版本后打包时，脚本会把前一版产物移到输出目录的 `archive/`，保留历史文件。

如果本次改动了 ACL 后端，先用 `npm run vendor:build` 从 `pin.json` 固定的上游 tarball 重建 `vendor/`（校验上游 SHA-256、应用 `patches/`），再跑 `vendor:check`。不要手工编辑 `vendor/**/lib/`，也不要声称上游发布版已包含该补丁。

在 GitHub 建立对应版本的 Release 后，将当前 `.tgz` 与校验文件作为附件上传。源码中没有预填未知的仓库地址，也没有宣称已发布到 npm。

## 不上传的本地资料

`pi-dsh-sandbox-pkg/archive/` 保存旧安装包；`development-notes/` 保存迁出的研究报告和开发流水记录。这些资料可能包含本机绝对路径和历史探针，不应整目录上传到公开仓库。公开的安装、使用和安全说明均位于源码的 `docs/` 中。
