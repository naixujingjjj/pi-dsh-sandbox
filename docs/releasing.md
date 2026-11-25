# Preparing the Source and Publishing the Installer Package

What gets uploaded to GitHub is the source directory. Runtime dependencies in `node_modules/`, installer packages, and local development records are not part of the source repository.

## Uploading the Source

When creating the repository for the first time, run the following in the source root:

```powershell
git init
git add .
git diff --cached --stat
git status --short
```

Review what is about to be committed before committing; then add your own GitHub remote and push. The project already ships a `.gitignore`; do not use `git add -f` to force dependencies, keys, or installer packages into the repository.

If you upload through the GitHub web UI, you can use the prepared `pi-dsh-sandbox-<version>-source.zip`: unpack it first, then upload the contents of the source directory inside it, including hidden files such as `.github/` and `.gitignore`. Do not drag the whole local directory containing `node_modules/` into the upload box, and do not upload only the ZIP file as a substitute for the source.

The repository already ships a Windows GitHub Actions workflow. After the first push, check the results in Actions; passing local tests does not mean the remote workflow has already run.

## Local Checks and Packaging

Run the following in a normal, unrestricted Windows terminal:

```powershell
npm ci --include=optional
npm run vendor:check   # confirm the vendored backend in the package matches PROVENANCE.json
npm run verify:windows
npm run pack
npm run check:package
```

The tests use temporary directories and a local test model, so no real model API is needed. The real kernel tests modify the ACL of the temporary test workspace; do not run the full test suite from this plugin's restricted shell.

`npm run pack` writes to `pi-dsh-sandbox-pkg/` next to the source directory by default, and does not leave the installer package in the source root. You can also specify an external directory:

```powershell
npm run pack -- --out-dir D:\releases\pi-dsh-sandbox
```

Each version contains:

- `pi-dsh-sandbox-<version>.tgz`: the plugin package for installation with npm, containing `vendor/dsh-sandbox-windows-acl/` (the patched backend source, compiled artifacts, the upstream `LICENSE`, `pin.json`, `PROVENANCE.json`, `patches/`), and **not** containing npm dependencies; installation still requires network access.
- A `.tgz.sha256` file of the same name: the SHA256 checksum.
- A `.tgz.manifest.json` file of the same name: the file manifest, version, and checksums.
- `latest.json`: the local index of the latest version.

When packing after a version bump, the script moves the previous version's artifacts into `archive/` in the output directory, preserving the historical files.

If this change touched the ACL backend, first rebuild `vendor/` from the upstream tarball pinned in `pin.json` with `npm run vendor:build` (verifying the upstream SHA-256 and applying `patches/`), then run `vendor:check`. Do not hand-edit `vendor/**/lib/`, and do not claim that the upstream release already contains that patch.

After creating a Release for the corresponding version on GitHub, upload the current `.tgz` and its checksum file as attachments. The source has no prefilled repository URL for an unknown remote, and it makes no claim of having been published to npm.

## Local Material That Is Not Uploaded

`pi-dsh-sandbox-pkg/archive/` holds old installer packages; `development-notes/` holds the research reports and development run records that were moved out. This material may contain local absolute paths and historical probes, and it should not be uploaded as whole directories to a public repository. The public installation, usage, and security documentation all lives in the source's `docs/`.
