# Troubleshooting

Do these three things in order before deciding whether to change the configuration:

```text
/sandbox status
/reload
/sandbox doctor
```

- `/sandbox status`: mode, root, runner path/backend version, temp, bash, configuration errors.
- `/reload`: makes Pi read the global settings again and rebuild the extension runtime (required after changing configuration or dependencies).
- `/sandbox doctor`: really performs "read-only refuses writes, writes inside the root work, writes outside the root are refused, deletes outside the root are refused, exit code passthrough" in an isolated temporary workspace, and additionally runs one "workspace ready (real root)" probe with the **session's real workspace root**.

**Do not** change the default mode to `off` in order to work around a fault. That amounts to disabling the plugin; the right approach is to fix the dependency/configuration, or, when you knowingly accept it, to temporarily use a one-shot `/sandbox exec`.

## Workspace root cannot be authorized (`grantWrite` Win32 5)

Symptoms (even a read-only command will not start with a plain `powershell`):

```text
windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace root>)
Command exited with code 127
[sandbox: runner-failure] ...
```

This is **the runner failing to initialize while granting the workspace**; the subcommand never started at all, so it does not mean "some path has no write permission". It is therefore not a reason to go out of bounds, and `sandbox_request` cannot fix it either — filing one request per command only turns a single fault into many approvals.

The backend makes two kinds of edits on the root:

- **DACL**: an allow ACE for the capability SID (which only needs `WRITE_DAC`, and the owner has it implicitly) and a deny ACE for Everyone on deleting children;
- **SACL**: the Low no-write-up integrity label. It is written **only when the root is not already Low no-write-up through inheritance**; writing the label needs `WRITE_OWNER`.

So Win32 5 from `SetNamedSecurityInfoW` is **not** the same as a missing `WRITE_OWNER`. You may only conclude that when the backend states it in the error detail — the backend vendored in this package appends the following when the label write is refused:

```text
windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<root>): the Low integrity label needs WRITE_OWNER ...
```

Without that explanation, Win32 5 can also mean: the current account has no `WRITE_DAC` on the root (it is neither the owner nor authorized), the security descriptor is protected or restricted by policy, or the write of another component such as owner/group/SACL was refused. First do a read-only check (no ACL changes):

```powershell
icacls "<workspace root>"      # does the target account have explicit or inherited full control; does the parent directory ACE carry the inheritance flag
```

Then pair it with the "workspace ready (real root)" item of `/sandbox doctor` (it reproduces the same fault with the real root).

Fix (the human decides; the plugin never changes ACLs automatically):

1. **Preferred, no extra permission repair needed**: use 0.4.2+ with the vendored backend. `/sandbox status` should show source `vendor` and backend `0.2.2-rc.5+pi-dsh.N`. When the root is already Low no-write-up through inheritance, it changes only the DACL and does not rewrite the existing Low label. Note: the upstream `0.2.2-rc.5` **release does not contain this fix**, so switching to it does not solve the problem; a normal grant still writes the allow ACE for the capability SID and the deny ACE for Everyone on deleting children (that is the sandbox grant itself), and "no extra repair needed" here means no additional `WRITE_OWNER` is required.
2. If the read-only check confirms that the current account really lacks a required permission (or the backend explicitly reports that the label write needs `WRITE_OWNER`), add only one minimal ACE (no inheritance, no propagation, nothing involving Everyone), and back it up before changing it; the steps below run in **ordinary PowerShell** (not the restricted sandbox):

   ```powershell
   $root   = '<workspace root>'
   $backup = Join-Path $env:TEMP 'pi-dsh-sandbox-root-dacl.sddl'
   $access = [System.Security.AccessControl.AccessControlSections]::Access

   # backup: the DACL section only (no owner/group/SACL; %TEMP% must be written as $env:TEMP in PowerShell)
   (Get-Acl -LiteralPath $root).GetSecurityDescriptorSddlForm($access) | Set-Content -LiteralPath $backup

   # minimal fix: grant the current account WRITE_OWNER only
   icacls $root /grant "$env:USERDOMAIN\$env:USERNAME:(WO)"

   # rollback: write the DACL back only, owner/group/integrity label unchanged
   $acl = [System.Security.AccessControl.DirectorySecurity]::new()
   $acl.SetSecurityDescriptorSddlForm((Get-Content -LiteralPath $backup -Raw).Trim(), $access)
   Set-Acl -LiteralPath $root -AclObject $acl
   ```

   The DACL-only restore above has been measured on an isolated directory with the same name: after restoring, the SDDL is exactly identical to the original DACL, and owner/group and the Low label are unchanged.
   **Do not use `icacls /restore`**: in practice, as a non-admin it may process 0 files and report 1300, and the `/save` backup carries a SACL section (which would touch the integrity label).
   **Never** run `icacls /reset /T`, **never** give `Everyone` write permission, and do not reset the whole directory tree. Do not grant `(WO)` on the root without diagnosing first: that is not a general fix for this fault.
3. Or move the session to a directory in which the current account already has inheritable full control (or an already inherited Low label).

After fixing, `/reload` and then `/sandbox doctor`. If every item of the doctor's temporary workspace passes and only "workspace ready" fails, the problem is this workspace root, not a broken backend.

Tell the two kinds of failure apart:

| Symptom | Meaning | Handling |
| --- | --- | --- |
| `windows-acl-run:` + `[sandbox: runner-failure]` | runner/grant not ready, the command did not run | fix the workspace/dependencies/configuration; **do not** use `sandbox_request` |
| the command runs but a write/delete returns `EPERM`/"access denied" + `[sandbox: denied]` | the kernel refused an out-of-root write | rewrite it inside the root, or take the one-shot approval route for that command |

## Configuration changes do not take effect

- The plugin reads only the `piDshSandbox` section of the **global** `%USERPROFILE%\.pi\agent\settings.json`; it does not read the project's `.pi/settings.json`. Configuration written in the project never takes effect, and that is by design.
- After editing the file you must `/reload`; a running session does not hot-reload.
- The JSON must be valid; `piDshSandbox` must be an object; `mode` may only be `off`/`read-only`/`workspace-write`.
- When `SANDBOX_CONFIG` appears, read the error text:
  - extra root keys such as `additionalWritableRoots`: they must be deleted, the plugin does not support them;
  - `runnerModule`/`dshRoot`/`tempRoot` must be **absolute paths**;
  - `tempRoot` must not sit inside the workspace;
  - the top level of the global settings must be an object.
- `/sandbox mode ...` changes the current session only and does not write back to the configuration; a new session returns to the configured starting point.

## Runner not found

The error looks roughly like:

```text
SANDBOX_UNAVAILABLE: cannot find the Windows ACL sandbox runner ...
Tried:
  - ...
```

Order of handling:

1. **A global DSH is not needed**. This package ships pinned dependencies and **bundles** the patched backend:

   ```text
   <package dir>\vendor\dsh-sandbox-windows-acl\lib\runner.js
   ```

   Go by `/sandbox status`: `runner:` should point at the in-package `vendor\...`, `backend:` should show `0.2.2-rc.5+pi-dsh.N`, and the source should be `vendor`. If it points at the same-named package in `node_modules` or at a global DSH, what is loaded is old code or a hand-assembled environment.
   If none of the three locations has it, the package installation is incomplete or the package directory was moved/deleted.

2. Reinstall the dependencies in the source/package directory:

   ```powershell
   cd <source dir>
   npm ci --include=optional
   npm run vendor:check   # only the source directory has this script: it checks the in-package vendored backend against PROVENANCE.json
   ```

   Or for a tgz install directory use `npm install --prefix <dir> --include=optional --omit=dev <tgz>` (the published package does not contain `scripts/`, so there is no `vendor:check`; go by `/sandbox status` and `npm run check:package`).
   Do not fix it by "hand-copying the patched files into node_modules": `npm ci`, `npm pack` or a reinstall will wipe them.

3. If you explicitly configured `runnerModule` or `dshRoot`, **an invalid path is an immediate error and never silently falls back to another runner**. Change it to the correct absolute path, or delete that setting so the plugin prefers the in-package `vendor/` backend; when nothing is configured explicitly, the plugin also probes its own `node_modules` and the global DSH by Node's rules, in the order explicit configuration > in-package `vendor/` > plugin `node_modules` > global DSH.

After fixing, `/reload`, then look at `runner:`/`backend:` in `/sandbox status`.

## koffi native module fails to load

Symptoms:

```text
windows-acl-run: Cannot find module 'koffi'
```

Or the runner reports a native module load failure at startup.

- Installing **must** use `--include=optional`. `koffi`'s platform binary package is an optional dependency; `--omit=optional` leaves it missing.
- Confirm that it exists:

  ```text
  <package dir>\node_modules\@koromix\koffi-win32-x64\win32_x64\koffi.node
  ```

- Confirm Windows x64 and a Node version that meets the requirement (24 LTS recommended, 22.19 minimum). ARM64/ia32 are not supported targets.
- When you are offline or a mirror lacks the package, the only option is to install it online; this plugin's `.tgz` does not contain `node_modules` and is not an offline all-in-one package.
- After reinstalling, `/reload`.

## Missing DSH peer modules

If you installed with `--omit=peer`, you may see:

```text
Cannot find module '@deepseek-ai/cordis'
```

or `@deepseek-ai/dsh-skill` / `@deepseek-ai/dsh-error` and the like missing. This package declares the packages the runner imports directly
(`dsh-subprocess`, `dsh-win32-process`, `dsh-lazy-require`, `dsh-skill`) as direct `dependencies`,
but their own peers (such as `@deepseek-ai/cordis`) still need to be installed normally by npm.

Handling: rerun the install in the package directory without `--omit=peer`:

```powershell
npm ci --include=optional --omit=dev
```

For a tgz install directory: `npm install --prefix <dir> --include=optional --omit=dev <tgz>`.

## bash and ! commands are refused

- The `bash` tool and `!`/`!!` both need a bash that is **not WSL** (Git Bash / MSYS2 / Cygwin).
- When `%SystemRoot%\System32\bash.exe` (the WSL launcher) is detected, the plugin refuses outright: it hands the command to a Linux VM, where the Windows restricted token and Low label have no reach.
- After installing Git for Windows, you can set `shellPath` in the global `settings.json` to point at Git's `bash.exe` (for example `<Git install dir>\bin\bash.exe`), then `/reload`.
- The `bash` override is registered with `defaultActive: false`; overwriting it does **not** make it appear among the enabled tools automatically — you have to enable it explicitly in `defaultTools`/`--tools` (or it was already active). The official `!` command depends on bash; when no usable bash exists, use `powershell` instead.

## PowerShell cannot use Add-Type/COM in read-only mode

Under `read-only` the backend cannot create the AppLocker probe file, so PowerShell conservatively enters `ConstrainedLanguage`: `Add-Type`, non-core .NET static calls, COM and reflection fail.

- This is the startup behavior of the backend/PowerShell, not an ACL write-boundary fault.
- Use `workspace-write` for everyday work; if you must stay read-only, accept the language-mode restriction, or switch to commands that do not need those capabilities.

## spawn EPERM in Node tests / pipes

A confined child process cannot open the write end of a **newly created named pipe**, so `spawn(..., { stdio: "pipe" })` returns `EPERM`. This affects:

- the default child-process isolation mode of the Node test runner;
- some paths of Pi's built-in local PowerShell backend;
- any tool that creates a new pipe inside the restricted shell.

How this repository handles it:

- `npm test` uses `--test-isolation=none`, so the test runner does not open pipes itself;
- 4 of the **real local execution** tests skip automatically in the restricted shell with an explicit reason; this is **not** an assertion failure;
- tests that need real local processes/pipes, such as `npm run test:pi`, `npm run test:integration` and `npm run test:pack`, should be run in a **normal terminal** (not inside this plugin's restricted shell);
- `npm run test:register` creates no new pipes and can run in the restricted shell.

Do not turn the sandbox off just because of EPERM; switch to a normal terminal or accept the skipped tests.

## TUI and RPC approval UIs differ

- Interactive TUI: a **yellow card** in the message stream (full command/reason/cwd/mode/timeout) plus a **small yellow panel** at the bottom (four choices). The yellow is a fixed RGB and does not follow the theme.
- RPC/T3: the host's native `select`/`input`, a plain-text title, no ANSI; colors and layout are up to the host, so **not seeing yellow** is normal.
- `print`/`json`: there is no confirmable UI, so `sandbox_request`/`/sandbox exec` never execute.
- When the TUI panel is unavailable (`custom`/`setWidget`/`onTerminalInput` missing, or `ui.custom` throws), it falls back to the native four options; an explicit choice is still required, and it never approves automatically.

## Approval prompt missing after hiding with F2

- `F2` hiding the panel is for **looking back**, not for answering. Above the editor you will see "Approval pending: … · press F2 to return to the approval panel · nothing executes right now".
- Press `F2` again to return; the selected option and any reason already entered are kept.
- While hidden, pressing `Enter` in the editor only sends your own message and does not approve; only an explicit `Enter` after returning to the panel counts as an answer.
- If both the panel and the hint are gone, the pending approval has probably been cancelled by a session switch, `/reload`, a mode change or an interrupt; that command will not execute, and you can simply file the request again.

## Approval did not execute

Check each item:

| Symptom | Cause |
| --- | --- |
| chose `Yes, and reason…` but nothing ran | reason left empty/whitespace only/`Esc` pressed → not approved this time |
| pressed a number key `1`–`4` and nothing ran | numbers only move the selection; you must then press `Enter` |
| no approval prompt appeared at all | `hasUI=false` (print/json/subagent without a UI) → fail-closed; file it from an interactive terminal |
| after approving it still reports "not executed" | during the approval the session/root/runtime/mode changed, the signal was cancelled, or the audit write failed (fail-closed before execution) |
| `sandbox_request` reports invalid arguments | `command`/`reason` are required and must be non-empty; `timeout` must be a finite positive number ≤ 600 |
| expected a "global approval" | a one-shot approval is valid only for this exact command plus the fixed cwd, and does not change the mode |

The approval result and reason are shown in the result card/notification; you can also check `/sandbox status` to confirm the mode did not change.

## Error code quick reference

| Error | Meaning | Handling |
| --- | --- | --- |
| `SANDBOX_UNAVAILABLE` | platform unsupported, runner not found, explicit path invalid, runner cannot start | fix dependencies/paths; see "Runner not found" |
| `SANDBOX_CONFIG` | configuration unparsable/invalid value/extra root/relative path/temp inside the root | fix the global settings or the CLI, `/reload` |
| `SANDBOX_DENIED` | the kernel or an early check judged it as an out-of-root write | rewrite it inside the root, or go through the one-shot approval |
| `SANDBOX_READ_ONLY` | read-only mode refuses any `write`/`edit` (including creating directories) | if you need to write, a human must confirm the widening |
| `SANDBOX_RUNNER_FAILURE` | the runner itself failed, the helper returned no result, or the exit code was abnormal after success | treat it as a failure; run `/sandbox doctor` |

## Temporary directory leftovers

- Every call gets a host-owned `call-*` parent directory under the temp root; a normal finish, a timeout and a cancellation all try to clean it up.
- If Pi is force-killed, or the directory is in use/locked by an antivirus scan, it can still be left behind.
- The plugin **does not** scan for and delete the directories of other live calls, and does not clean up the shared temp root.
- To reduce `%LOCALAPPDATA%` usage: set `tempRoot` to another drive; only after confirming that no Pi is running, manually clean up your own old `call-*`/`ch-*` directories. Do not bulk-delete the whole temp root.
- `/sandbox doctor` uses its own temporary workspace and deletes it recursively at the end; a failed deletion is reported as a FAIL item of doctor.

## Denial messages are garbled or unrecognizable

- `cmd.exe`'s Chinese denial message is GBK; decoded as UTF-8 it may be unrecognizable. Denials from `node` (`EPERM`) and from `pwsh` (English/Chinese "access denied") are more reliable.
- The exit code of PowerShell `-Command` depends on the last statement; when a statement in the middle is refused, the exit code does not necessarily become non-zero. When you need a hard abort, use `$ErrorActionPreference='Stop'` and read the output / the appended `[sandbox: ...]` explanation.

## ACL/directory state is wrong

- First read [the rollback section in security](security.md#7-rollback-and-recovery); do not run `icacls /reset /T`.
- The first propagation over a large directory can take a while; if the command times out but the directory has already been tagged, the next attempt hits the cache.
- The Low label and the capability ACE are **not** revoked by uninstalling; decide whether the workspace can be thrown away, or restore the DACL exactly from the backup.
- When unsure, reproduce it with a one-shot copy; do not experiment with rollback commands on a real project.
