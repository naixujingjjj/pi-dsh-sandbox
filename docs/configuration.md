# Configuration

The authorization configuration of this plugin comes from **exactly one source**: Pi's global settings file, plus explicit CLI parameters. The project-local `.pi/settings.json` is ignored completely.

## 1. Where the configuration file is

| Platform | Path |
| --- | --- |
| Windows | `%USERPROFILE%\.pi\agent\settings.json` |
| Unix-like (for inspecting the structure only; the sandbox itself supports Windows only) | `~/.pi/agent/settings.json` |

This plugin reads the top-level key `piDshSandbox`:

```json
{
  "piDshSandbox": {
    "mode": "workspace-write"
  }
}
```

- This is the **only** configuration section that is read; other top-level keys are handled by Pi itself, and this plugin does not touch them.
- If the file is not valid JSON, or `piDshSandbox` is not an object, the sandbox **fails closed** (tools report `SANDBOX_CONFIG`); fix it and then `/reload`.
- This plugin **does not** modify this file on its own. During installation, only `pi install` writes one entry into `packages`.

## 2. Fields

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | string | `workspace-write` | `off` / `read-only` / `workspace-write`. An invalid value makes the sandbox report an error |
| `runnerModule` | string (absolute path) | not set | Full path to the runner `lib/runner.js`. When set it is the **only** runner used; if the file does not exist this errors out immediately instead of quietly switching to another runner |
| `dshRoot` | string (absolute path) | not set | DSH installation root; equivalent to `<dshRoot>\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js`. When set together with `runnerModule`, `runnerModule` takes precedence |
| `tempRoot` | string (absolute path) | `%LOCALAPPDATA%\pi-dsh-sandbox\tmp` | Root directory for the runner's `--temp`; must be **outside** the workspace. The plugin tries to create it |

`runnerModule`, `dshRoot` and `tempRoot` are all **optional**. Under normal circumstances writing only `mode` is enough; this package **vendors** an already patched backend, so neither a global DSH nor a manually specified path is required. Lookup order when nothing is configured explicitly: the in-package `vendor/dsh-sandbox-windows-acl/lib/runner.js` → the plugin's `node_modules` → the global DSH.

### 2.1 A complete example that does not need to be filled in entirely

Minimal:

```json
{
  "piDshSandbox": {
    "mode": "workspace-write"
  }
}
```

Read-only plus a custom temp:

```json
{
  "piDshSandbox": {
    "mode": "read-only",
    "tempRoot": "D:\\pi-dsh-sandbox-tmp"
  }
}
```

Specifying the runner explicitly (only when you really want to override the in-package vendored backend):

```json
{
  "piDshSandbox": {
    "mode": "workspace-write",
    "runnerModule": "D:\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js"
  }
}
```

Specifying the DSH root explicitly (either this one or the previous example, not both):

```json
{
  "piDshSandbox": {
    "dshRoot": "D:\\dsh"
  }
}
```

The paths in the examples are placeholders only; replace them with your actual absolute paths. Backslashes in JSON must be written as `\\`.

### 2.2 Constraints on temp

- `tempRoot` must be an **absolute path**, and it must not be equal to or located inside the current workspace root; otherwise `assertReady` refuses to execute (`SANDBOX_CONFIG`).
- The plugin `mkdir -p`s that directory at startup; if creating it fails, it likewise fails closed.
- The runner creates a random private subdirectory under temp and deletes it after the child process exits; the host also holds a `call-*` parent directory for each call and attempts to clean it up on timeout or cancellation. After a crash or while the directory is in use, leftovers are still possible (see [troubleshooting](troubleshooting.md#temporary-directory-leftovers)).

## 3. CLI parameters

Four parameters are registered by the extension, all with string values:

| Parameter | Corresponding configuration |
| --- | --- |
| `--sandbox-mode <off\|read-only\|workspace-write>` | `mode` |
| `--sandbox-runner <absolute path>` | `runnerModule` |
| `--sandbox-dsh-root <absolute path>` | `dshRoot` |
| `--sandbox-temp <absolute path>` | `tempRoot` |

Examples:

```powershell
pi --sandbox-mode read-only
pi --sandbox-mode workspace-write --sandbox-temp "D:\pi-dsh-sandbox-tmp"
```

These are **temporary overrides**: they affect only the current Pi process and are not written back to the settings. Passing an invalid value explicitly (for example a relative path or an unknown mode) reports a configuration error and blocks execution; it is not silently ignored.

## 4. Precedence

From highest to lowest:

1. **CLI parameters** (`--sandbox-*`)
2. **`piDshSandbox` in the global `settings.json`**
3. **Built-in defaults**

`/sandbox mode ...` changes the runtime mode of the **current session**; it does not write the configuration file and is not a fourth, persistent source. A new session, a resumed session, a fork or a restart always starts again from the configuration/CLI starting point.

## 5. Why project configuration is ignored

No `piDshSandbox` content in `<workspace>/.pi/settings.json` is ever read.

The reason is straightforward: the workspace is the **protected object**. If project configuration could change the mode or the runner path, the model would only have to write a `.pi/settings.json` into the repository to change the mode to `off` or to point the runner at an arbitrary program — the sandbox would be switched off by the very object it is meant to protect. Only global settings edited by a human and explicit CLI parameters can change the authorization.

Other Pi keys in project configuration (models, tools, and so on) are handled by Pi according to its own project trust rules; **this plugin does not read them and does not relax anything based on them**.

## 6. "Additional writable roots" are not supported

As soon as any of the following keys appears in `piDshSandbox`, the sandbox fails closed directly and reports `SANDBOX_CONFIG`:

```text
additionalWritableRoots
writableRoots
additionalRoots
writeRoots
extraRoots
```

The reason: **the current plugin and runner interface configure only one workspace root per session** (the current session cwd); the extra write permission of `workspace-write` is only the runner's private temp. This version does not support persistent additional writable roots, which is why these keys are rejected — so that you do not write them into the configuration and mistakenly believe the restriction has already been opened up.

When you truly need a one-off write outside the root, use the **one-off** approval of `sandbox_request` or `/sandbox exec`; do not try to extend the mode.

Other, unknown keys are not fatal, but they produce a warning (`unknown configuration item ... ignored`), which you can see in `/sandbox status`.

## 7. Configuration boundaries of the mode

- `mode` comes from the configuration/CLI and is the starting point for every session.
- Only a human can change the **current session** via `/sandbox mode`; the model has no tool for switching modes, and an approval of `sandbox_request` does not change the mode either.
- `off` can only be selected by a human through the configuration, the CLI, or a confirmed `/sandbox mode off`; there is no path by which project configuration turns it off by itself.
- Resumed or forked sessions do not carry a broader mode back from their history.

## 8. Approval backends for RPC / print / json

- Interactive TUI: yellow card plus floating panel (fixed yellow, does not follow the theme).
- RPC/T3: the host's native `select`/`input`; the title is plain text and contains no ANSI.
- `print`/`json`: there is no UI to confirm with. `sandbox_request`/`/sandbox exec` are never executed.
- When creating the TUI panel fails, it falls back to the native four-option dialog; an explicit choice is still required, and it **never approves automatically**.
- A failure of any approval backend never "falls back to unrestricted execution"; ordinary tools likewise fail closed when the configuration/runner is unavailable.

## 9. Version pinning

- The runtime dependency `@deepseek-ai/dsh-sandbox-windows-acl` is **vendored** inside the package as a patched build: upstream `0.2.2-rc.5` source plus local patches, with the in-package version identifier **`0.2.2-rc.5+pi-dsh.1`** (`vendor/dsh-sandbox-windows-acl/pin.json` pins the upstream tarball and the patch hashes, and `PROVENANCE.json` records the artifact hashes).
- The runner is invoked through an argv-prefix protocol; different backend versions may change behavior or the parameter contract. Do not use `npm update` to let the plugin's dependencies drift arbitrarily; upgrades should be tested together with this plugin.
- `/sandbox status` shows the runner path actually in use and the backend version; under normal circumstances the source should be `vendor`. If it points at `node_modules` or at the global DSH, first check whether there is a `runnerModule`/`dshRoot` override, or whether the package directory is complete.

## 10. After changing the configuration

After modifying the global settings, run `/reload` in Pi. The plugin re-reads the configuration and rebuilds the runtime on `session_start`; merely modifying the file does not hot-update the current session.

If `/sandbox status` shows `config: error ...` or `runner: unavailable ...`, fix the configuration/dependencies first and then retry the tool; do not work around it by changing the mode to `off`.