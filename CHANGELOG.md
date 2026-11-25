# Changelog

## Unreleased

- The documentation is now English-only: the `README.md`, every file under `docs/`, and `CONTRIBUTING.md`, `CHANGELOG.md` and `THIRD_PARTY_NOTICES.md`.
- Installation is documented for the GitHub source (`pi -e git:github.com/naixujingjjj/pi-dsh-sandbox`, `pi install git:github.com/naixujingjjj/pi-dsh-sandbox`) as the recommended route, and no instruction assumes a particular local directory any more: the source-directory and `.tgz` routes use `$repo` / `$env:USERPROFILE` and `$env:LOCALAPPDATA` placeholders instead.
- `docs/installation.md` now covers three sources (GitHub, source directory, `.tgz`) and its sections were renumbered accordingly.

## 0.4.2

- Fixed the diagnosis and remediation of "the workspace root cannot be granted, so sandbox initialization fails" (`SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace root>)`): this is a plugin initialization failure on a real directory, not a command crossing the sandbox boundary.
- **Delivery switched to a package-internal (vendored) patched backend** `vendor/dsh-sandbox-windows-acl/`: based on the `src/` of the npm release `0.2.2-rc.5`, applying the in-repo `patches/` and then compiling with TypeScript; ships the upstream `LICENSE`, `pin.json` (tarball SHA-256 and patch hashes) and `PROVENANCE.json` (hash of every artifact). The resolver order is explicit configuration > in-package `vendor/` > plugin `node_modules` > global DSH. Delivery no longer depends on hand-editing `node_modules` (which `npm ci`/`npm pack`/a reinstall will overwrite), nor on an upstream release. The upstream `0.2.2-rc.5` release does **not** contain this fix, and this version does not claim any upstream release.
- Backend behavior: when the workspace root is already Low no-write-up through **inheritance**, the integrity label is no longer written again (writing a label requires `WRITE_OWNER`; subdirectories usually only have the owner-implied `WRITE_DAC`), and changing only the DACL completes the grant. **Normal granting still writes the capability SID allow ACE and the Everyone deny-delete-child ACE**: this means "no extra privilege repair and no rewrite of the existing Low label are needed", not "the ACL is left completely unchanged".
- Hardened the native parsing of inherited labels: an ACE header must fall inside `AclSize`, the inline SID's `SubAuthorityCount`/length must agree with `AceSize` before `sameSidAt` is performed, and the entire ACL must be traversed before the result is accepted — an earlier hit no longer masks later corruption, malformed ACLs cause no out-of-bounds read and fall back directly to writing the label (fail-closed).
- When a **label write** by the backend is rejected with `ERROR_ACCESS_DENIED`, the error detail names `WRITE_OWNER`; the DACL-only path keeps the ordinary detail. `readiness` asserts that cause only when the error line carries this backend marker; every other Win32 5 is listed as a possible cause (DACL write permission, protected descriptor, owner/group/SACL, policy) together with read-only checks, and no ACL is changed automatically.
- `readiness` fixes: bracketed legal paths (anchor on the configured root first, then a balanced-bracket scan), and the runner's **private temp subdirectory** (`call-*/dsh-*`, judged as "equal to or inside the temp root").
- The runner-failure explanations of `powershell`/`bash` continue to distinguish "runner/workspace not ready" from "command rejected by the kernel", and state clearly that such initialization failures **cannot** be bypassed with `sandbox_request`; the first occurrence within a session raises one error notification to the human.
- `/sandbox doctor`'s "workspace ready (real root)" is retained; the `sandbox_request` description and guidelines retain the anti-approval-bombing rule. The four approval options, the reason semantics, the yellow card and the language rules are all unchanged.
- Tests and verification: added unit tests for the vendored backend (inherited label changes only the DACL, malformed ACE boundaries, an early hit does not mask later corruption); the parent/child directory ACL layout of the Windows integration test moves temporary deny cleanup into `t.after`, so cleanup also happens on failure; `npm run check:pack` performs a clean install from the tarball and then **resolves the in-package runner from the installed plugin**, validates `PROVENANCE.json`, and actually runs it in an isolated parent/child ACL layout (grant succeeds, labels unchanged, writes outside the root are still refused).
- Documentation fixes: DACL backup/restore now uses the **Access (DACL)** section of PowerShell `Get-Acl`/`Set-Acl` (verified in an isolated directory with the same name: after restore the SDDL is exactly identical to the original DACL, and owner/group and the Low label are unchanged); `icacls /save`/`/restore` are no longer recommended (measured: as a non-administrator `/restore` processes 0 files and reports 1300, and `/save` backups carry a SACL section); added the vendored origin/license/rebuild notes, and corrected the statement that "the ACL is left completely unchanged".

## 0.4.1

- Simplified the approval language rules: if the user prompt contains any Chinese, use Chinese, and for mixed Chinese/English Chinese takes precedence; with no Chinese and with Latin letters present, use English. Word counts, technical-term filtering and explicit language-instruction detection are removed.

## 0.4.0

- The approval UI switches between Chinese/English automatically following the **current conversation language**: it takes the latest decidable real user message on the current branch, and supports explicit switches such as "answer in English / answer in English / answer in Chinese"; neutral short messages, code blocks, inline code, URLs and paths do not participate in the decision, and when nothing is decidable it stays Chinese to stay compatible with existing behavior.
- The language is determined by the actual user role; assistant replies, tool results, model tool arguments, `requestReason`, command bodies and plugin-generated messages are not read; no model API is called, the OS language is not used, and there is no locale parameter that the model can specify.
- Each request pins the locale onto the request/card/result/audit record: manually changing the language in the middle of an approval cannot mix them; the TUI card, the bottom panel, the F2 hide hint, the two reason input boxes, RPC `select`/`input`, the relaxed-mode confirmation, and the card and notification of `/sandbox exec` all switch language.
- History redraw uses the saved language; older requests/cards without a locale are treated as Chinese. Commands, request reasons and human-typed text are kept as-is, and the four option labels plus the off execution/approval logic are unchanged.
- The continuation text that `reason.ts` gives the model also follows the approval language (the user's original text is unchanged); the primary target is the visible approval UI.
- Added Chinese/English tests for detection, real tool wiring, TUI/RPC, history cards, manual exec and relaxed mode; the documentation explains the automatic rules and the boundaries of the heuristics.

## 0.3.2

- Reorganized into a source repository that can be uploaded to GitHub directly: the release tarball, historical versions and development notes were moved out of the source tree, and the source keeps only the files needed for building.
- The release flow now produces artifacts outside the source: `npm run pack` writes by default into the sibling directory `pi-dsh-sandbox-pkg` and generates `.sha256`, `.manifest.json`, `latest.json`; `npm run check:package` performs offline verification of the manifest and checksums.
- Rewrote the user-facing documentation: installation (source/tarball), usage and the four approvals, configuration, security boundaries, troubleshooting, contribution guide.
- Corrected the third-party attribution; added `CHANGELOG.md` for Pi to display when the package is upgraded.
- Fixed runner detection when dependencies are hoisted into the parent `node_modules` after installing the tarball with npm; installation acceptance now explicitly forbids depending on a global DSH.
- Sandbox modes and approval semantics are unchanged; this version is mainly about release organization, install-layout compatibility and documentation.

## 0.3.1

- The approval reason input box stays **completely blank** and shows no placeholder text; the title already says what to enter.
- Leaving it empty, entering only whitespace, or pressing `Esc` to cancel still **does not approve** the operation, and it will not pass by default just because an option with a reason is already selected.

## 0.3.0

- Approval details moved to a **yellow card** in the message stream: source, request reason, full command (shown verbatim between the `BEGIN/END` markers), cwd, mode, timeout; the whole request is no longer stuffed into the dialog title.
- The bottom is now a small yellow approval panel holding only the four options and the key hints; the editor draft is preserved.
- Added `F2`: hide the panel to look back at earlier model output, then press `F2` again to return; nothing executes while it is hidden, and the selected item and the reason are preserved.
- Only an explicit `Enter` ends the pending state; number keys only move the selection, and `Esc`/blank/scroll/hide never approve.
- Yellow uses a fixed RGB and does not read the theme's `warning`, so changing the theme does not change the color; RPC/T3 continue to use the host's native select box.

## 0.2.1

- The text in the approval window is explicitly **an instruction to the agent**, separate from the model's `reason` request reason:
  - `No, and reason…`: refuse and **do not execute**; the text becomes a new user instruction for the current task, and the agent continues in the new direction;
  - `Yes, and reason…`: execute only the command shown this time, and afterwards report the execution facts first, then fulfil the additional requirement;
  - the text does not rewrite the command and does not become a persistent permission; blank or cancel counts as no approval.
- The tool path writes the instruction into this tool result; manual `/sandbox exec` delivers it as one `followUp` user message to avoid duplicate injection.

## 0.2.0

- Added the model tool `sandbox_request`: proactively request **one-time** execution of a single precise PowerShell command with off.
- Every request must go through the four approvals (`Yes` / `No` / the two options with a reason), with an optional timeout (600 seconds maximum).
- An approval is valid only for this command and the fixed canonical root: it does not change the mode, does not grant later permissions and does not retry automatically; refusal/cancel/no UI/session change all fail closed.
- Added approval audit entries (hash of the command and reason, human text, source); command output and file contents are not recorded.

## 0.1.x

- Established the basic Windows write restriction mechanism: the actual write operations of `powershell`, `bash`, `!` and `write`/`edit` go through the DSH Windows ACL restricted-token runner.
- Three modes: `off` / `read-only` / `workspace-write`; the session root is the canonical cwd, and `cd` does not widen the grant.
- `/sandbox` provides status, mode, doctor, exec, help; relaxing the mode requires confirmation, and the model cannot switch modes.
- A missing runner, an unsupported platform, configuration errors, helper failure and the like all fail closed and never pass through silently.
