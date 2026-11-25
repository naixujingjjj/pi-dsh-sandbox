# pi-dsh-sandbox

A Pi extension for **Windows 10/11 x64** that confines the **actual writes** of `powershell`, `bash`, `!`/`!!` commands and of `write`/`edit` to the current session's workspace root. The boundary is enforced by the Windows kernel (restricted token + Low integrity label), not by keyword filtering in the plugin.

> Repository and install sources: <https://github.com/naixujingjjj/pi-dsh-sandbox>. This package is not published on npm; install it from the GitHub source (`git:github.com/naixujingjjj/pi-dsh-sandbox`), from a source directory, or from a release `.tgz` — see [Installation](#installation).

## What it does

- **Confined execution**: `powershell`, `bash` and `!`/`!!` run through the `@deepseek-ai/dsh-sandbox-windows-acl` restricted-token runner that is **vendored** inside the package; writes and deletes outside the root are refused by the kernel.
- **Writes on disk**: `write`/`edit` keep Pi's original semantics (relative paths, exact text matching, BOM/line endings, diffs, per-file queues). Only the actual `mkdir`/file write is handed to a helper inside the confined process.
- **Controlled escape hatch**: the model may call `sandbox_request` to ask for **one** exact command to run once in `off` mode (outside the sandbox), with the human's four-way approval every time; a human can also use `/sandbox exec`.
- **Fail closed**: a missing runner, an unsupported platform, a configuration error or an unavailable approval UI never falls back to unconfined execution.

## What it does not do (important)

- **It does not restrict reads**: a confined child process can read any file you can read (including other workspaces and `~/.ssh`); `read`/`ls`/`grep`/`find` keep Pi's native behaviour.
- **It does not restrict the network**: confined child processes can go online; MCP web tools do not pass through this plugin either.
- **It is not a container**: it does not restrict process visibility, CPU, memory or user identity.
- **It is not complete isolation**: the kernel guarantee is `enforcement: partial` and covers writes and deletes only.
- **It does not cover the whole host**: third-party extensions, MCP tools, and `pi.exec`/file APIs called directly by an extension are not constrained by this plugin.

## Persistent side effects (read before installing)

`workspace-write` leaves changes on the **authorization root** that outlive the session and the reboot: a capability-SID allow ACE, a `FILE_DELETE_CHILD` deny ACE, and — when the root does not already inherit Low integrity — a **Low integrity label**. They are **not** reverted when the session ends or the plugin is removed, and a Low label also lets other processes running at Low integrity write to that directory tree.

- Since 0.4.2 the vendored backend only rewrites the DACL when the root already has Low no-write-up through inheritance, so it does not touch the existing label in such layouts and needs no extra `WRITE_OWNER`/`(WO)`; a normal authorization still writes the two ACEs above (that is the sandbox authorization itself).
- A generic, irreversible "rollback" is dangerous: **do not** use `icacls <root> /reset /T`, it wipes the custom ACLs you already had.
- When the content must be preserved, back up the DACL before first use (`Get-Acl` and keep only the `Access` section); restore it with `Set-Acl` writing only the DACL back, leaving owner/group and the Low label unchanged.
- A throwaway temporary copy that you delete afterwards is the simplest rollback.

Mechanisms, limits and backup examples are in [docs/security.md](docs/security.md). **Do not delete a real project you need in order to uninstall the plugin.**

## Requirements

| Item | Requirement |
| --- | --- |
| Platform | Windows 10/11 **x64**; other platforms report `SANDBOX_UNAVAILABLE` in confined modes |
| Node | **Node 24 LTS recommended**; **22.19** minimum (the same floor Pi requires) |
| Pi | `@earendil-works/pi-coding-agent` **>= 1.6** |
| Runner | **Vendored** in this package: a patched `@deepseek-ai/dsh-sandbox-windows-acl@0.2.2-rc.5+pi-dsh.1` under `vendor/`. No global DSH install is needed, and `node_modules` is left alone |
| Optional | Git for Windows' `bash.exe` (otherwise `bash` and `!` are refused) |
| Network | Installing the runtime dependencies needs network access |

## Installation

### From the GitHub source (recommended)

```powershell
# Try it in this process only; nothing is written to your settings
pi -e git:github.com/naixujingjjj/pi-dsh-sandbox

# Once /sandbox status looks right, add it to the global settings.json packages
pi install git:github.com/naixujingjjj/pi-dsh-sandbox

# Pin a version by appending @<tag>, @<branch> or @<commit> (no tags exist yet; use a commit hash)
pi install git:github.com/naixujingjjj/pi-dsh-sandbox@<commit>
```

- Pi clones the repository into its own directory and runs `npm install --omit=dev --legacy-peer-deps` inside it. Optional dependencies are included, so `koffi`'s platform binary lands on disk and you never run `npm ci` by hand.
- Network access is required: the clone and the runtime dependencies (`koffi`, `yaml`, `@deepseek-ai/dsh-*`) all come from the npm registry.
- Pi owns that directory. Do not develop in it and do not leave your own files there: `pi update --extensions` syncs with `git clean -fdx` and reinstalls dependencies.
- After installing, the `runner:` line of `/sandbox status` must point at `vendor\dsh-sandbox-windows-acl\lib\runner.js` **inside the package directory**; if it points anywhere else, you loaded a different runner.

### From a source directory (development or offline investigation)

```powershell
$repo = "$env:USERPROFILE\src\pi-dsh-sandbox"   # change this; do not move or delete it afterwards
git clone https://github.com/naixujingjjj/pi-dsh-sandbox.git $repo
cd $repo
npm ci --include=optional

# Try it in this process only; nothing is written to your settings
pi -e $repo

# Once it works, add it to the global settings.json packages
pi install $repo
```

- `--include=optional` is **mandatory**: `koffi`'s native binary is an optional dependency, and leaving it out makes the runner fail to load the native module.
- npm needs network access for the runtime dependencies; the source directory and its `node_modules` must be kept, because Pi loads a local package by **absolute path** and never copies it.
- `pi install` only adds that directory to Pi's global `packages`; it does not change your `defaultTools` or any file outside this plugin.
- Host packages among the dependencies (`@earendil-works/*`, `typebox`) are **optional peers** provided by Pi: do not install a second copy of them.

### From a `.tgz`

**You cannot** hand a `.tgz` straight to `pi install`: Pi treats a file path as extension source, not as a package to install. Install the tarball into a fixed location first, then use the package directory inside it:

```powershell
$tgz = "$env:USERPROFILE\Downloads\pi-dsh-sandbox-<version>.tgz"   # the file you downloaded
$extRoot = "$env:LOCALAPPDATA\pi-extensions"

New-Item -ItemType Directory -Force -Path $extRoot | Out-Null
npm install --prefix $extRoot --include=optional --omit=dev "$tgz"

# The package directory must be kept; do not delete or move it
pi install "$extRoot\node_modules\pi-dsh-sandbox"
```

- The `.tgz` carries the source, the docs and the vendored backend (`vendor/`); it is **not** an offline bundle with every dependency, so `npm install` fetches `koffi`/`yaml`/the DSH runtime packages over the network.
- Do not unpack the `.tgz` and run `pi install <unpacked dir>` unless you already installed the runtime dependencies in that directory (see the previous section).
- If `npm` reports a missing `koffi` or `@deepseek-ai/dsh-*`, see [docs/troubleshooting.md](docs/troubleshooting.md).

## After installation

- After changing the plugin code, updating the package or changing the `piDshSandbox` configuration, run `/reload` inside Pi.
- Check that it loaded: `/sandbox status`. Do a real self-test: `/sandbox doctor`.
- Uninstall: `pi remove <the same source pi list shows>`. For a local package the source is an absolute path; removing only takes it out of `packages` and does **not** revert the ACLs/Low label described above.

## The three modes

| mode | `powershell` / `bash` / `!` | `write` / `edit` |
| --- | --- | --- |
| `off` | Pi's built-in path (unconfined) | Pi's built-in path (unconfined) |
| `read-only` | Restricted token; every write and delete is refused by the kernel | Refused before any filesystem call (including directory creation) |
| `workspace-write` (default) | Restricted token; only the authorization root plus the runner's private temp | The actual write is performed by a helper inside the confined process |

The default is `workspace-write`, which takes effect as soon as the plugin is installed. `/sandbox` opens the mode menu; widening the confinement (for example switching to `off`) needs an extra confirmation. Only human commands can change the current session's mode; the model has no tool to switch it.

## Authorization root and `cd`

- The authorization root is the **canonical real path** of the current session `cwd` (junctions, symlinks and 8.3 short names resolved), fixed once per session.
- `cd` inside a command does **not** widen the root; the runner's `--workspace` and the spawned cwd always stay that root.
- To make another directory the root, start the Pi session in that directory.
- The temp root defaults to `%LOCALAPPDATA%\pi-dsh-sandbox\tmp` and must be outside the workspace; `tempRoot` can move it to another drive.

## Out-of-root approval (summary)

When the model calls `sandbox_request` it must provide `command` (the exact PowerShell command), `reason` (the justification, shown only to the approver) and optionally `timeout` (positive seconds, at most 600). An approval covers **this one command plus the fixed cwd** only:

| Option | Behaviour |
| --- | --- |
| `Yes` | Runs it once; the mode is unchanged |
| `No` | Not executed |
| `Yes, and reason…` | Runs it once; afterwards the model reports what happened and then fulfils your added instruction |
| `No, and reason…` | **Not executed**; the text you write becomes the task's new direction and the model replans from it |

The text in the approval window is **an instruction for the agent**, not a side note, and it is never spliced into the command. In the interactive TUI an approval is a **yellow card** in the message stream with a small yellow panel at the bottom; `F2` hides the panel so you can scroll back through earlier output, and `F2` again brings it back. Only an explicit `Enter` counts as an answer — `Esc` or a blank reason approves nothing. RPC/T3 keep the host's native chooser, and `print`/`json` never execute anything without an approval UI.

The full interaction, keys and examples are in [docs/usage.md](docs/usage.md). The approval language follows the latest user prompt on the current branch: **use Chinese when it contains Chinese, including mixed Chinese and English; use English when it has no Chinese and contains Latin letters**. Word counts, technical terms and instructions such as "answer in language X" are no longer analysed. The language is fixed once the request starts, and historical cards are redrawn in the language they were saved in; the command, the reason and the text you write are kept verbatim.

## Configuration (summary)

Only the `piDshSandbox` section of the **global** `~/.pi/agent/settings.json` (on Windows: `%USERPROFILE%\.pi\agent\settings.json`) is read, plus the four `--sandbox-*` CLI options. A project's `.pi/settings.json` is **ignored entirely**, which stops a repository from switching the mode to `off` by itself.

```json
{
  "piDshSandbox": {
    "mode": "workspace-write"
  }
}
```

`runnerModule`, `dshRoot` and `tempRoot` are all optional; an explicitly configured invalid path is reported as an error instead of silently selecting a different runner. "Extra writable root" settings such as `additionalWritableRoots` are rejected (the current plugin configures exactly one session root and does not support persistent extra roots).

The complete fields, precedence and unsupported options are in [docs/configuration.md](docs/configuration.md).

## Known boundaries (excerpt)

- **Hard links are file-object aliases**: the same file hard-linked outside the root is still writable (inherent to the mechanism).
- **Installer-style commands often fail**: `npm/pip install` writing `~/.npm`, `~/.cache` and similar paths outside the root are refused; move the cache into the workspace, or use `/sandbox exec` for a single command.
- **Under `read-only` PowerShell may drop to `ConstrainedLanguage`**: `Add-Type`, COM and reflection are unavailable; this is backend behaviour.
- **Some piped `spawn` calls return `EPERM`**: a backend limit on creating new named pipes; Node tests and Pi's built-in local PowerShell backend can be affected.
- **`cmd.exe` writes its refusal message in the ANSI code page**: Chinese refusals may be unreadable when decoded as UTF-8; `node`/`pwsh` refusals are more reliable.
- **`bash` refuses the WSL launcher**: it hands the command to a Linux VM that the Windows token cannot reach; use a non-WSL bash such as Git Bash.

More on the mechanism, rollback and what is out of scope is in [docs/security.md](docs/security.md); when something breaks start with [docs/troubleshooting.md](docs/troubleshooting.md).

## Documentation and development

| Document | Content |
| --- | --- |
| [docs/installation.md](docs/installation.md) | GitHub source / source directory / tarball install, uninstall, keeping the directory |
| [docs/usage.md](docs/usage.md) | Three modes, commands, the four approvals, F2, keys |
| [docs/configuration.md](docs/configuration.md) | Configuration fields, CLI options, precedence |
| [docs/security.md](docs/security.md) | The partial boundary, ACL side effects, rollback |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Missing dependencies, runner, WSL, pipes, UI |
| [docs/releasing.md](docs/releasing.md) | Uploading the source, packing and release artefacts |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development, tests, packing |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Third-party attribution |

This package is released under the MIT license, see [LICENSE](LICENSE). Runtime dependencies and their attribution are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).