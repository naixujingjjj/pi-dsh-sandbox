# Installation

This document covers three install sources: **the GitHub source (recommended)**, **a source directory** and **a release `.tgz`**. All three end with Pi loading a package directory; the runtime dependencies come from npm, so installing needs network access.

> Repository: <https://github.com/naixujingjjj/pi-dsh-sandbox>. The GitHub source is written `git:github.com/naixujingjjj/pi-dsh-sandbox`. Source archives and `.tgz` files come from that repository's releases or from `git clone`.

## 1. Requirements

| Item | Requirement |
| --- | --- |
| Operating system | **Windows 10/11 x64**. Other platforms report `SANDBOX_UNAVAILABLE` in confined modes; only an explicit switch to `off` returns to Pi's built-in execution path |
| Node.js | **Node 24 LTS recommended**; **22.19** minimum (`engines` and Pi's own floor) |
| Pi | `@earendil-works/pi-coding-agent` **>= 1.6** |
| Runner | A patched `@deepseek-ai/dsh-sandbox-windows-acl@0.2.2-rc.5+pi-dsh.1`, **vendored** in this package under `vendor/`. A global DSH install is **not** needed |
| Optional bash | `bash.exe` from Git for Windows, MSYS2 or Cygwin; WSL's `bash.exe` is refused |
| Network | Both the source install and the tarball install fetch the runtime dependencies from the npm registry |
| Permissions | The current user has normal read/write access to the workspace directory; the first `workspace-write` authorization must be able to change that directory's DACL/SACL |

The Node and Pi versions matter for extension loading already at startup; confirm with `node --version` and `pi --version` first.

## 2. From the GitHub source (recommended)

Nothing has to be prepared locally: Pi clones the repository itself and runs `npm install --omit=dev --legacy-peer-deps` inside the clone (optional dependencies are included, so `koffi`'s platform binary lands on disk).

```powershell
# Load only in this Pi process, writing no configuration
pi -e git:github.com/naixujingjjj/pi-dsh-sandbox

# Once /sandbox status looks right, add it to the global packages
pi install git:github.com/naixujingjjj/pi-dsh-sandbox

# Pin a version (tag, branch or commit); unpinned sources follow pi update --extensions
pi install git:github.com/naixujingjjj/pi-dsh-sandbox@<commit>
```

Notes:

- Network access is required: the clone and the runtime dependencies (`koffi`, `yaml`, `@deepseek-ai/dsh-*`) all come from the npm registry.
- Pi owns that directory. Do not develop in it or keep your own files there: `pi update --extensions` runs `git clean -fdx` and then reinstalls the dependencies. To change code, use the source-directory route in the next section.
- The `runner:` line of `/sandbox status` must point at `vendor\dsh-sandbox-windows-acl\lib\runner.js` **inside the package directory**; if it points anywhere else, you loaded a different runner than the one this package vendors.
- To uninstall, use the source `pi list` shows: `pi remove git:github.com/naixujingjjj/pi-dsh-sandbox`. Removing it does **not** revert the ACEs/Low label that `workspace-write` wrote (see [security](security.md)).

## 3. From a source directory

### 3.1 Get the source into a fixed directory

Clone the repository (or download and unpack a source archive) into a **fixed absolute path**, for example:

```powershell
$repo = "$env:USERPROFILE\src\pi-dsh-sandbox"   # change this; do not move or delete it afterwards
git clone https://github.com/naixujingjjj/pi-dsh-sandbox.git $repo
```

The directory should directly contain `package.json`, `package-lock.json` and `src\index.ts`. The rest of this section uses `$repo` for that directory — keep running the commands in the same PowerShell session.

### 3.2 Install the runtime dependencies

```powershell
cd $repo
npm ci --include=optional
```

Notes:

- `--include=optional` is **mandatory**. `koffi`'s platform binaries are optional dependencies; leaving them out or adding `--omit=optional` makes the runner fail when it loads the native module.
- `npm ci` requires `package-lock.json` and installs strictly from the lock file — exactly the reproducible install we want.
- For runtime dependencies only, without the development tooling, add `--omit=dev`:

  ```powershell
  npm ci --include=optional --omit=dev
  ```

- Do **not** add `--omit=peer` unless you have confirmed that every package the runner imports is on disk. This package declares `@deepseek-ai/dsh-subprocess`, `dsh-win32-process`, `dsh-lazy-require` and `dsh-skill` as direct `dependencies`, but their own peers (such as `@deepseek-ai/cordis`) have to be installed normally by npm; `--omit=peer` can leave them missing and the runner then fails at import time.
- The peers this package declares to the host Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) are **optional peers** supplied by Pi when it loads the extension. Do not install a second copy of them.
- Installing the dependencies needs network access. If your npm cache or mirror lacks a package, see [troubleshooting](troubleshooting.md).

### 3.3 Load it temporarily first, then install it for real

```powershell
# Load only in this Pi process, writing no configuration
pi -e $repo

# Once /sandbox status looks right, write it to the global packages
pi install $repo
```

- `pi install` records the **resolved absolute path** and does not copy the source directory. Do not delete or move the directory `$repo` points at, and do not delete its `node_modules`; otherwise the next start fails to load.
- `pi install` only changes the `packages` array in Pi's global `settings.json`. It does **not** change your `defaultTools`, themes, models or any other setting; installing this plugin never needs hand-edited user settings.
- After installing, start Pi (or run `/reload` in a running Pi), then run `/sandbox status`.

### 3.4 If you only want one run

`pi -e <absolute dir>` is a temporary load: nothing is written to `packages` and everything ends when the process exits. That is the right way to verify `/sandbox doctor` before committing to the install.

## 4. From a `.tgz`

### 4.1 Why `pi install <tgz>` does not work

Pi's rule for local sources is: **a file path loads as one extension source, a directory path follows the package discovery rules**. A `.tgz` is an archive, not extension source, so `pi install .\pi-dsh-sandbox-<version>.tgz` does not install it as an npm package.

The correct way is to use npm to install the tarball into a fixed directory and then hand the package directory inside it to `pi install`.

### 4.2 Prepare a fixed directory

Use a dedicated fixed location for local extensions, for example:

```powershell
$extRoot = "$env:LOCALAPPDATA\pi-extensions"
New-Item -ItemType Directory -Force -Path $extRoot | Out-Null
```

Do not delete or move this directory later; Pi records the absolute path inside it.

### 4.3 Install the tarball and its dependencies

```powershell
$tgz = "$env:USERPROFILE\Downloads\pi-dsh-sandbox-<version>.tgz"   # the file you downloaded
npm install --prefix $extRoot --include=optional --omit=dev "$tgz"
```

Notes:

- The `.tgz` contains only this package's source, docs and vendored backend — **not** `node_modules` — and is not an "offline bundle with every dependency". `npm install` fetches `koffi`, `yaml` and the DSH runtime dependencies over the network.
- The `.tgz` **does** contain `vendor/dsh-sandbox-windows-acl/` (the patched backend source, build output, provenance and hash records); it is part of the delivery — do not replace it with an older tarball or hand-copied files.
- `--include=optional` is still mandatory, otherwise `koffi`'s platform binaries are not written to disk.
- Likewise do **not** add `--omit=peer`, for the reason in 3.2: the current backend declares the DSH packages it runs on as peers.
- npm may create or update `package.json` and `package-lock.json` in that directory; keep them. `pi install` does not need them, but reinstalling after deleting the directory does use the lock file.
- If the release also ships a `.sha256` or `.manifest.json`, verify the checksum before installing.

After the install this must exist:

```text
%LOCALAPPDATA%\pi-extensions\node_modules\pi-dsh-sandbox\
```

### 4.4 Hand it to Pi

```powershell
pi install "$extRoot\node_modules\pi-dsh-sandbox"
```

Then start Pi or run `/reload`, and check with `/sandbox status`:

- `mode` is `workspace-write` (the default);
- `runner:` points at the **in-package** `vendor\dsh-sandbox-windows-acl\lib\runner.js`;
- `backend:` shows `@deepseek-ai/dsh-sandbox-windows-acl 0.2.2-rc.5+pi-dsh.N (source: vendor)`;
- `enforcement: partial`.

If that matches, the vendored backend inside the package is usable and **no global DSH is needed**. If `runner:` points at an old backend under `node_modules` or at some global DSH, you are not running this version: run `/reload` first, then check that the package directory is complete.

### 4.5 Do not unpack the package directory and load it directly

Only one case allows `pi install <dir>` directly: the directory itself has a `package.json` and the runtime dependencies are already installed (that is the `npm ci` from 3.2). Unpacking a tarball without installing the dependencies leaves `runnerModule`/`koffi` missing.

## 5. Updating and uninstalling after installation

- **Updating a git install**: nothing to do by hand; `pi update --extensions` syncs the clone and reinstalls the dependencies. A source pinned to a tag, branch or commit keeps its ref.
- **Updating the source**: replace the source files, run `npm ci --include=optional` again, then `/reload`.
- **Updating the tgz**: rerun the `npm install` from 4.3, then `/reload`. The old version's files are replaced inside the same package directory; do not delete the whole `pi-extensions` by hand.
- **Uninstalling**:

  ```powershell
  pi list
  pi remove <the same source pi list shows>
  ```

  A git-source install shows `git:github.com/naixujingjjj/pi-dsh-sandbox`; a local package usually shows an absolute path — remove it with the **same source**. `pi remove` only removes the entry from `packages`: it does not delete the directory and does **not** revert the ACEs/Low label that `workspace-write` wrote.

## 6. Minimal acceptance after installation

```text
/sandbox status        # mode, root, runner, backend version, temp, bash
/sandbox doctor        # real self-test in a separate temporary workspace: write inside, refuse outside, refuse delete, read-only
```

All PASS in `doctor` means the sandbox backend works. If it fails, read [troubleshooting](troubleshooting.md) first, and do not default the mode to `off` just to "make it work".

## 7. Entry points for common installation problems

| Symptom | Start with |
| --- | --- |
| Missing `koffi`, `Cannot find module 'koffi'` | [troubleshooting: native module](troubleshooting.md#koffi-native-module-fails-to-load) |
| Runner not found | [troubleshooting: runner](troubleshooting.md#runner-not-found) |
| `bash` refused / WSL detected | [troubleshooting: bash](troubleshooting.md#bash-and--commands-are-refused) |
| Configuration changes have no effect | [troubleshooting: configuration](troubleshooting.md#configuration-changes-do-not-take-effect) |
| Mode or UI behaves differently than expected | [usage](usage.md) and [troubleshooting: approval](troubleshooting.md#approval-did-not-execute) |
| Want to roll back the ACLs/directory | [security: rollback](security.md#7-rollback-and-recovery) |