# Contributing Guide

Thank you for considering improvements to `pi-dsh-sandbox`. This is a Windows-only Pi extension whose changes touch the **kernel boundary** and **human approval**, so please prioritize the property that "a failure never opens things up".

## 1. Environment

| Item | Requirement |
| --- | --- |
| OS | Windows 10/11 x64 (required for real kernel tests) |
| Node | **24 LTS** (minimum 22.19) |
| Pi | `@earendil-works/pi-coding-agent` >= 1.6 |
| Dependencies | `npm ci --include=optional` |

```powershell
npm ci --include=optional
npm run verify
```

`--include=optional` cannot be omitted: the `koffi` platform binaries are optional dependencies. If you install only runtime dependencies, use `npm ci --include=optional --omit=dev`; **do not add `--omit=peer`**, because the peers of the DSH packages that the runner imports would be omitted and the runner would fail to load.

## 2. Scripts

| Command | Content |
| --- | --- |
| `npm run verify` | `check:repo` + `vendor:check` + `typecheck` + unit tests; run at least this before committing |
| `npm run check:repo` | Offline checks of the public source tree, version/lock consistency, relative documentation links, and leftover personal paths and secrets |
| `npm run vendor:check` | **Offline** verification of `vendor/dsh-sandbox-windows-acl/`: `pin.json`, patch SHA-256, and every artifact hash in `PROVENANCE.json`; hand-edits to `vendor/**/lib` are rejected |
| `npm run vendor:build` | Downloads the upstream tarball pinned by `pin.json` over the network (verifying SHA-256), applies `vendor/.../patches/`, recompiles `lib/` with the devDependency TypeScript, and rewrites `PROVENANCE.json` |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm test` | Unit tests (including ACL boundary cases bound directly to the **vendored backend**). Use `--test-isolation=none` to avoid pipe `EPERM` in a restricted shell; the 4 tests that perform real local operations are skipped with a reason in a restricted shell |
| `npm run test:integration` | Real Windows kernel cases: writes to read-only are denied, writes inside the root are allowed, writes/deletes outside the root are denied, exit codes. **Authorized only in a separate temporary workspace** |
| `npm run test:pi` | Pi SDK-level smoke test: loads the extension, really executes the overridden tools, and the approval path; **no model calls, no API key needed** |
| `npm run test:register` | SDK registration/denial paths only; creates no new pipe and can run in a restricted shell |
| `npm run test:cli` | Real `pi` CLI (RPC)-level smoke test: the `/sandbox` command, approvals, the `!` hook; uses a local fixture provider |
| `npm run test:failure` | Fail-closed behavior of `powershell`/`write`/`edit`/`sandbox_request` under the real SDK when the runner is missing |
| `npm run test:pack` | `npm pack` artifact check + install into a temporary project; then verifies the installed package's `PROVENANCE.json`, **resolves the in-package runner from the installed plugin**, and actually runs it in an isolated parent/child ACL layout |
| `npm run pack` | Builds the release package **outside** the source tree (default sibling directory `pi-dsh-sandbox-pkg`), also writing `.sha256`, `.manifest.json`, `latest.json`; optional `-- --out-dir <dir>` |
| `npm run check:package` | **Offline** verification of `latest.json`, the tarball's SHA-256, and the manifest file list |
| `npm run verify:windows` | Runs the whole suite in a normal Windows terminal: `verify` + integration + register + pi + cli + failure + pack |
| `scripts/verify-real-root.ps1` | **One-time real-root acceptance** (dry run by default): verifies the vendored runner inside the package, first validates DACL-only restoration in an isolated directory of the same name, then with `-Execute` runs restricted `Get-Location`/read-only `git status`/creation and deletion of a unique probe file against **this repository root**, verifies that the ACE delta is only the capability SID and the Everyone delete-child deny and that the Low label is unchanged, then restores and compares against the original DACL. Must be run manually after human approval; it never runs automatically |

Notes:

- By default the release script refuses to write artifacts into the source directory; when you need a specific location, use `npm run pack -- --out-dir D:\path\outside\source`.
- `check:package` only reads existing artifacts and does not access the network; it is not a substitute for real installation acceptance.
- Run tests that involve real Windows or pipes in a **normal terminal**; running them inside the plugin's restricted shell will fail or be skipped because of `spawn EPERM` or environment differences, and that is not an assertion failure. Both `check:pack` and `test:integration` modify the ACL of temporary directories (only one-time directories under `%TEMP%`), so do not run them in a restricted shell.
- Tests **do not need** a model API key; do not configure real model calls just to run the tests.

## 3. Testing Discipline

- Heavy Windows tests use `mkdtemp` to create an **isolated temporary directory** as the authorization root and delete it afterward; **do not** point tests at the real project, the user directory, or `C:\`.
- Tests that add temporary `deny` ACEs must register cleanup with `try/finally` (or `t.after`), so that the temporary ACEs are removed even when an assertion fails; otherwise the one-time directory cannot be deleted.
- When changing the ACL backend, `vendor/` and `patches/` must stay in sync: rebuild with `npm run vendor:build`, and both `npm run vendor:check` and `npm run test:pack` must pass before committing. Do not test only against a development `node_modules` that has already been modified by hand.
- Tests must not modify the user's global `settings.json`, theme, model, or `defaultTools`; when isolation is needed, use `PI_CODING_AGENT_DIR`/a temporary agent directory.
- Do not weaken fail-closed assertions, skip denial paths, or rerun under `off` just to make "the tests pass".
- When adding approval/UI logic, test all of the following as well: approval, rejection, cancellation, blank reason, no UI, concurrent isolation, and session change/abort cleanup.
- When adding a write path, you must verify that "the kernel denies it outside the root", not merely that the plugin reports an error early.

## 4. Source Layout

```text
src/
  index.ts            Extension entry: registers tools, commands, flags, approval card renderers; blocks restrictable tools when loading fails
  state.ts            Per-process runtime + per-session root/mode/bash/temp state; fail-closed readiness checks
  config.ts           Global settings and CLI flag parsing, precedence, unsupported items
  policy.ts           Mode vocabulary, canonical roots, containment checks (used only for early error reporting)
  runner.ts           Locates and spawns the DSH runner; timeouts/cancellation/private temp cleanup
  shell-command.ts    PowerShell command assembly (matching the host backend shape)
  classify.ts         Denial/runner-failure signature classification
  readiness.ts        Diagnostic text for runner initialization failures (workspace/temp readiness; does not change ACLs automatically)
  mutation.ts         Restricted helper calls and result protocol for write/edit
  ipc.ts              Unique per-call request file channel (does not use a new pipe)
  kernel-helper.mjs   Helper that performs mkdir/write inside the restricted process
  approval.ts         Four approvals, TUI/RPC dispatch, audit fields
  reason.ts           Approval text -> instructions for the agent (does not execute, does not modify the command)
  errors.ts           SANDBOX_* error types
  tools/
    shell-tools.ts    Restricted operations for powershell/bash/!
    fs-tools.ts       write/edit registration and early containment checks
    sandbox-request.ts One-time model request tool, argument validation, live card
    types.ts          Lightweight types for tool results
  tui/
    card.ts           Yellow approval card (full width/wrapping/ANSI-forgery hardening)
    panel.ts          Bottom floating approval panel, reason input, F2 hide/restore
    theme.ts          Fixed yellow palette
    entry.ts          Session entry cards (manual exec / relaxed mode)
    live.ts           Stores pending-approval facts by toolCallId for card redraws
test/
  unit/               Pure logic + in-process TUI rendering/keys
  integration/        Real Windows ACL/runner cases (temporary workspace)
  fixtures/           Local provider, TUI/palette fixtures
scripts/              SDK/CLI/failure/package smoke tests, vendor build/check, and release scripts
vendor/               In-package vendored backend (upstream MIT source + patches + build output + PROVENANCE)
docs/                 User-facing installation, usage, configuration, security, and troubleshooting docs
```

Design principles:

- **The boundary is in the kernel.** The early checks in `policy.ts` only improve error messages; any security assertion must be verified at the kernel layer.
- **fail-closed.** When the runner is missing, the configuration is wrong, approval is unavailable, or the helper returns no result, never execute; a "degraded pass-through" is forbidden.
- **Approval text is data/instruction, not a command or a permission.** It cannot rewrite the command and cannot become a persistent grant.
- **Do not copy host packages.** `@earendil-works/*` and `typebox` are provided by Pi; keep them as peer/optional peer.

## 5. Code and Documentation

- TypeScript strict; ESM, with relative imports in the source carrying the `.ts` suffix (Pi loads them directly with jiti).
- Do not add dependencies that duplicate the host's; runtime dependencies use fixed versions and are locked in `package-lock.json`.
- Update `README.md`, the relevant `docs/*.md`, and `CHANGELOG.md` in step with behavior changes.
- Public documentation must not contain personal paths, user names, or machine names, and must not invent repository/release URLs; use generic placeholder paths in examples.
- Do not commit `node_modules`, `.tgz`, logs, or local caches.
- **Do not hand-edit `vendor/dsh-sandbox-windows-acl/lib/`**: it is generated output; change `src/`/`patches/` and then run `npm run vendor:build`. `vendor:check` rejects files that are inconsistent with `PROVENANCE.json`.

## 6. Commits and PRs

- Keep one PR focused on one thing; explain the motivation, behavior changes, risks, and verification commands.
- For changes involving the security boundary, approvals, or ACL/rollback, state explicitly in the description "which situations still remain fail-closed".
- You may submit a PR, but do not add unconfirmed repository or release addresses in the PR/documentation.
- Run `npm run verify` before committing; when possible, also run `test:integration`, `test:pi`, `test:cli`, `test:failure`, and `test:pack` (in a normal terminal).
- The repository provides a Windows GitHub Actions workflow (`.github/workflows/ci.yml`); after pushing you can view the results in Actions. Passing locally does not mean the remote workflow has already run.