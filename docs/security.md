# Security boundaries

This plugin provides **Windows kernel-enforced write restrictions**: it is not a complete sandbox, not a container, and not a guarantee that "the model cannot do bad things". Please understand every item below before installing.

## 1. The model in one sentence

- **Writes/deletes**: a restricted child process can only write to the authorized roots and the runner's private temp.
- **Reads, network, process visibility**: unrestricted.
- **Failure**: always fail-closed, never falling back to unrestricted execution.
- **The backend's formal designation**: `enforcement: partial`.

## 2. The actual mechanism

Under `workspace-write` / `read-only`, the actual write operations of `powershell`, `bash`, `!`, and `write`/`edit` all go through DSH's `lib/runner.js`:

1. Duplicate the caller's token into a `WRITE_RESTRICTED` restricted token;
2. Drop it to **Low integrity**;
3. Use the workspace ACE granted to a capability SID plus the private temp ACE as the only source of write permission;
4. Deny `FILE_DELETE_CHILD` to the world SID, preventing deletion by way of parent-directory permissions;
5. When the root is not yet at Low integrity, mark the directory Low in the same `SetNamedSecurityInfoW` call; if the root is already at Low no-write-up through inheritance, skip this label write (the label lives in the SACL, and writing it requires `WRITE_OWNER`).
6. The child process's stdio is inherited and its exit code is returned as-is; any Win32 failure prevents the unrestricted spawn.

So when an ordinary command is refused a write, it is **the kernel refusing**; the plugin-side containment check only exists to produce a clearer error up front.

## 3. Coverage

| Object | Constrained by this plugin |
| --- | --- |
| `powershell`, `bash`, `!`/`!!` | Yes (confined mode) |
| The actual `mkdir`/file writes of `write`, `edit` | Yes (restricted helper) |
| `read`/`ls`/`grep`/`find` and the reading part of `edit` | **No** (inside the Pi process) |
| MCP tools (web search/fetch, databases, etc.) | **No** |
| Third-party extensions, `pi.exec` / file APIs called directly by plugins | **No** |
| The entire Pi host, sub-agent runtimes | **Not promised** |

The plugin only **overrides tools of the same name** — `powershell`, `bash`, `write`, `edit` — and registers `/sandbox`, `sandbox_request`, and four CLI parameters. It does not put the whole host into a sandbox; other extensions and MCP still run with their own permissions.

### 3.1 Sub-agents

Whether this plugin is loaded depends on how the host assembles extensions and tools for sub-agents; this repository does not treat sub-agents as an additional trust boundary.

What can be confirmed is: when there is no confirmable UI, `sandbox_request` returns `no-ui` and does **not execute**, and suggests that the upper-level agent or the user initiate it from an interactive terminal. A sub-agent cannot approve on a human's behalf, and does not get a wider mode merely because it is "inside a sub-agent".

## 4. Reads and the network

- **Reads are unrestricted**: a restricted child process can read any file you have permission to read, including other workspaces, `~/.ssh`, browser profiles, and so on. `read`/`grep` etc. live inside the Pi process anyway and do not even go through the restricted token.
- **The network is unrestricted**: a restricted child process can access the network arbitrarily; MCP web tools do not go through this plugin at all.
- When you need read-side isolation or network restrictions, pair this with other mechanisms such as AppContainer, firewalls, or a separate user/virtual machine; this plugin does not provide those capabilities.

## 5. The hard-link exception

A hard link is a **file object alias**, not a path alias:

- A workspace authorization propagates to that underlying file's security descriptor;
- If the same file also has a hard link outside the root, it is still writable through that alias;
- Refusing all multi-link files inside a workspace is infeasible (an ordinary pnpm install already uses hard links).

This is an inherent boundary of the mechanism, not a configuration error. Do not treat a "hard link outside the root" as isolated.

## 6. Persistent side effects (the most important cost)

The first authorization of `workspace-write` leaves changes on the **authorized root**:

1. A **capability-SID allow ACE**: the SID is deterministically derived from the canonical root path (`S-1-4-<hash>`), one per workspace per machine;
2. A `FILE_DELETE_CHILD` **deny** for the **world/Everyone** (container inheritance only), preventing deletion by way of the parent directory;
3. When the root is not yet at Low integrity, mark it **Low integrity** with a no-write-up policy; when the root already carries that label through inheritance, do not write the label again.

The label is written only when needed: if the root is **already** at Low no-write-up through inheritance (the parent directory carries an inheritable Low label),
the backend makes only the DACL changes. Writing the label is a SACL operation and requires `WRITE_OWNER`; changing only the DACL requires only `WRITE_DAC` (which the owner implicitly has).
This distinction has security significance: what is skipped is "writing a label that is already in effect and exactly identical to the existing inherited label"; it never lowers any directory to a lower level,
and never makes a write that should be refused become writable; if the inherited label is later changed by the parent directory, the sandbox ends in a write failure (fail-closed).

**"No extra permission repair is needed" does not mean "the ACL is not modified at all"**: a normal authorization still writes items 1 and 2 (the capability-SID allow ACE and
the Everyone deny-delete-child ACE), which belong to the sandbox authorization itself; what is not needed is extra repair permissions such as `WRITE_OWNER`/`(WO)` for the script.

These changes:

- **Are not** reverted when the session ends, on `/reload`, on plugin unload, or when Pi exits;
- Are a cross-session reuse cache: entering the same workspace a second time hits the existing ACE/label and skips re-propagation;
- The first propagation is an eager propagation of the **whole tree**, which may take tens of seconds on large directories;
- Make directories inside the root refuse to be opened with `GENERIC_ALL`/FullControl (a side effect of `FILE_DELETE_CHILD`); ordinary reads and writes, `MAXIMUM_ALLOWED`, and `DELETE`-based deletion are unaffected.

### 6.1 Knock-on effects of the Low label

The Low label **loosens** the writability of that directory tree for other Low integrity processes: another product's Low-IL sandbox, a protected-mode reader — as long as they run as the same user at Low, they may be able to write to/delete this directory. Under a Medium label they would be refused.

This is a precondition of the write boundary: without the Low label, the restricted child process could not write at all; revoking the label per session would mean re-propagating the whole tree every time.

### 6.2 Temporary authorization

The capability SID for the private temp is random and created per invocation, and is revoked when the runner exits; the workspace authorization, by contrast, is persistent. After the temporary directory is deleted, the related deny entries disappear along with the directory; a manual `icacls` cannot reclaim an unmapped capability SID (it reports `ERROR_NONE_MAPPED (1332)`).

## 7. Rollback and recovery

You can only **restore exactly the state you actually backed up**. There is no safe way to "restore the factory ACL with one click".

### Recommended: use a disposable workspace

If this directory is only a temporary copy, generated output, or a checkout that can be cloned again, **just discard the whole copy when you are done**. This is the most reliable rollback: the security descriptor disappears along with the object.

### If you need to keep the contents: back up the DACL first

Back up the DACL **before using the sandbox for the first time**. With PowerShell's `Get-Acl`, take only the **Access (DACL)** section, and when restoring, write only that section as well;
owner/group/SACL (the integrity label) do not participate, so the Low label will not be changed.

```powershell
$root   = 'D:\work\demo'
$backup = Join-Path $env:TEMP 'demo-dacl.sddl'   # note down this real path
$access = [System.Security.AccessControl.AccessControlSections]::Access

# Back up (stores only the DACL)
(Get-Acl -LiteralPath $root).GetSecurityDescriptorSddlForm($access) | Set-Content -LiteralPath $backup

# …confirm that a sandbox authorization has happened…

# Restore (replaces only the DACL)
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetSecurityDescriptorSddlForm((Get-Content -LiteralPath $backup -Raw).Trim(), $access)
Set-Acl -LiteralPath $root -AclObject $acl
```

Measured in an isolated directory of the same name (a parent directory + a `pi-dsh-sandbox` subdirectory, carrying an inheritable Low label):
after adding the Everyone deny-delete-child ACE and one explicit allow ACE, restoring with the code above yields **an SDDL exactly identical to the original DACL**,
with owner/group and the integrity label unchanged.

Limitations and caveats:

- The code above reads and writes **only the DACL**. The Low label (SACL) is neither backed up nor restored; after restoration it is still the original label.
- **Do not use `icacls /restore` as a DACL rollback**: measured as a non-administrator, it may print `Successfully processed 0 files` and report 1300,
  and a backup file from `icacls /save` carries a SACL section whose write-back requires additional privileges (it would touch the label as well); `icacls /save` also cannot serve as a pure DACL backup.
- The current plugin has no feature to "automatically revoke the Low label/capability ACE".
- Restoration must be done precisely, entry by entry; do not uniformly change all objects to Medium in place of the original label — that is merely a different wrong state.
- If the backend returns `ERROR_ACCESS_DENIED` while **writing the Low label** and explicitly names `WRITE_OWNER`, the repair steps (including a minimal, rollback-safe `(WO)` ACE)
  are in the [troubleshooting "Workspace root cannot be authorized"](troubleshooting.md#workspace-root-cannot-be-authorized-grantwrite-win32-5) section; that belongs to repairing the workspace, not to expanding the sandbox's permissions.
  An ordinary `SetNamedSecurityInfoW` Win32 5 is **not** enough to conclude that `WRITE_OWNER` is missing: it could also be DACL write permission, a protected descriptor,
  or owner/group/SACL writes being denied. Do read-only checks first, then decide whether to modify the ACL; the plugin will not modify it automatically.

### Never do this

- ❌ `icacls <root> /reset /T`: this wipes the custom ACLs you already had on that directory tree and rebuilds only the inherited default entries; it is irreversible damage.
- ❌ Manually `icacls /remove` the capability SID: an unmapped SID reports `ERROR_NONE_MAPPED (1332)`, and this cannot safely restore anything.
- ❌ Delete a real project you need to keep just to "uninstall cleanly". Uninstalling the plugin does not revert the side effects; deleting the project only loses your data.
- ❌ Treat your whole user directory, `C:\`, or a directory far above the repository root as a workspace just to "give it a try". The first propagation and the Low label affect the whole tree.

## 8. One-off off execution (`sandbox_request` / `/sandbox exec`)

The single command executed after approval **does not go through the sandbox**. It can modify any file the current user has permission to access, including files outside the root, user configuration, and other projects. Approval protects only:

- **this one** exact command (the literal text shown on screen);
- **this one** fixed cwd (the current session's canonical root);
- **this one** execution.

It does **not**:

- change `state.mode`;
- set a "globally approved" flag;
- grant any authorization to subsequent `write`/`edit`/`powershell`;
- turn the approval text into a persistent permission or part of subsequent commands.

The approval text is a task instruction for the agent: `No, and reason…` tells the agent to continue in a different direction (the rejected command is not executed); `Yes, and reason…` requires the agent to first report the facts after the operation, then fulfill the additional requirement. It is not an authorization to "allow more operations".

Execution after approval is **not** subject to ACL/Low constraints: the model tool `sandbox_request` executes using Pi's local PowerShell operations (`createLocalPowerShellOperations`); a manual `/sandbox exec` uses `pi.exec`. Neither path goes through the restricted runner. Rejection, cancellation, no UI, an empty reason, a late-arriving approval, and a change of session/root/mode all keep it from executing.

## 9. Fail-closed checklist

In the following situations the command is always **not executed**, and there is no fallback to an unrestricted path:

- the platform is not Windows;
- the runner cannot be found, or the explicitly configured `runnerModule`/`dshRoot` is invalid;
- the configuration cannot be parsed, the mode is invalid, or an unsupported additional writable root is present;
- the temp root cannot be created or lies inside the workspace;
- the helper is missing, does not return the result protocol, or the runner prints `windows-acl-run:` (including "workspace ready" style initialization failures);
- any `write`/`edit` under `read-only`;
- the approval UI is unavailable, the approval is cancelled, the reason is empty, or the approval arrives after the signal is cancelled.

Runner initialization failure and a command being refused by the kernel are two different things: in the former the command was not executed, and it cannot be "bypassed" by `sandbox_request` (which only runs one one-off command,
and neither repairs the workspace nor the runner); in the latter the kernel really refused an out-of-bounds write, which is when a one-off approval may be the applicable scenario.

Better to error out than to pass through silently. `off` can only be chosen explicitly by a human (configuration, CLI, or `/sandbox mode off` after confirmation).

## 10. Pipes and the PowerShell language mode

- **`EPERM` on piped stdio**: a restricted child process cannot open the write end of a newly created named pipe, so `spawn(..., { stdio: "pipe" })` yields `EPERM` in a restricted process. This plugin's `write`/`edit` avoid this with **inherited stdio + a request file**; Node test runners' default child-process isolation mode, Pi's built-in local PowerShell backend, and others may still trigger it.
- **ConstrainedLanguage under `read-only`**: in read-only mode the backend cannot create the AppLocker probe file, so PowerShell conservatively enters `ConstrainedLanguage`; `Add-Type`, non-core .NET static calls, COM, and reflection fail. This is backend/PowerShell startup behavior, not part of the ACL write boundary. For daily use, use `workspace-write`.

## 11. Prompt injection and the approval UI

- The approval card strips ANSI escapes and control characters, expands tabs, and renders multi-line text as multiple lines; **execution still uses the raw string**. This prevents command text from forging the interface, but does not prevent the model from being induced by malicious content into requesting a dangerous command.
- Reads and the network are unrestricted, so the model may read untrusted content and request based on it; **the human must personally read the complete command, cwd, and reason on the card**; do not look only at a title that "looks like approval".
- The yellow highlight, `F2` review, and the four choices only make approval more readable; they are **not** comprehensive protection against prompt injection. Do not press `Yes` without reading.
- The approval text enters the session record; do not put passwords/tokens in it.

## 12. Audit records

The plugin records approvals as session entries:

- `requestId`, `toolCallId`, time, cwd, mode, status;
- a **SHA-256 hash** of the command and of the request reason;
- the approval text entered by the human and `reasonSource`.

It does **not** record command output or file contents. An audit write after approval that fails will fail before execution; an audit write after execution that fails truthfully states "the command has already been executed".

## 13. Recommended deployment

- Set the sandbox workspace to a **project checkout** or a one-off copy, not your whole user directory.
- Do not put long-lived secrets (private keys, tokens, production configuration) in a directory tree carrying the Low label; reads are unrestricted anyway, and the Low label also loosens writes by other Low processes.
- Back up the DACL before using a large directory for the first time, or confirm that the directory can be discarded.
- After installing/updating, run `/sandbox doctor` first; do not disable the sandbox by default as a way to "troubleshoot".
- When you need read isolation, network isolation, or multi-user isolation, choose a real container/virtual machine/separate-account solution; this plugin is only responsible for the write boundary.