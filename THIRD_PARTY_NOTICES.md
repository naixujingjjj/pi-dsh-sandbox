# Third-Party Notices

This package (`pi-dsh-sandbox`) is itself released under the **MIT** license; see [LICENSE](LICENSE).

Based on this repository's `package.json` / `package-lock.json` and on the installed result of the locked versions, the following lists the third-party components that are **called or depended on** at runtime. Copyright and license terms for each component belong to its respective authors; when redistributing, the authoritative text is the `LICENSE` shipped in the corresponding package. This file is an attribution statement, not legal advice.

## Runtime dependencies

| Component | Version | License | Purpose |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-sandbox-windows-acl` | `0.2.2-rc.5` + local patches (version identifier inside the package: `0.2.2-rc.5+pi-dsh.1`) | MIT | Windows ACL restricted-token sandbox backend. **This package vendors a verbatim copy of its source** in `vendor/dsh-sandbox-windows-acl/` (including the upstream `LICENSE`, `patches/`, `pin.json`, `PROVENANCE.json`); this extension calls its `lib/runner.js` |
| `@deepseek-ai/dsh-win32-process` | `0.2.2-rc.5` | MIT | Restricted processes, stdio, Job objects and Win32 primitives |
| `@deepseek-ai/dsh-subprocess` | `0.2.2-rc.5` | MIT | Subprocess control-channel convention used by the runner (direct dependency) |
| `@deepseek-ai/dsh-skill` | `0.2.2-rc.5` | MIT | Used by the bundled backend's `acl-skill` module (direct dependency) |
| `@deepseek-ai/dsh-lazy-require` | `0.2.2-rc.5` | MIT | Lazy loading |
| `@deepseek-ai/cordis` | `4.1.0` | MIT | Peer dependency of the backend |
| `koffi` | `3.1.1` | MIT | Win32 FFI |
| `@koromix/koffi-win32-x64` | `3.1.1` (optional) | MIT | Prebuilt `koffi.node` binary; must be installed with `npm install --include=optional` |
| `yaml` | `2.9.x` (backend declares `^2.4.2`) | ISC | Used internally by the ACL backend |

Apart from the backend vendored in this package, these packages are installed through the npm dependency tree; this repository copies **only** that backend's MIT source, build output and upstream `LICENSE` (`vendor/dsh-sandbox-windows-acl/`), and preserves the patch and provenance hashes. Read `PATCH.md` and `PROVENANCE.json` in that directory before first use.

## Peer dependencies provided by the host (not bundled)

| Component | License | Purpose |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | MIT | Pi extension host; this package declares it only in `peerDependencies`, and when Pi loads an extension it maps `@earendil-works/*`, `typebox` to the host's own modules, so no second copy of the host appears |
| `@earendil-works/pi-tui` | MIT | The approval card and the approval panel use its TUI components/utilities: `Container`, `Text`, `Input`, the `Component`/`Focusable`/`OverlayHandle`/`TUI` types, key matching, ANSI-safe width/wrapping/truncation, control-character and escape sanitization, and `rgbColor`. The use is not limited to `Text` |
| `typebox` | MIT | Parameter schema for `sandbox_request` (`Type.Object` etc.). Provided and mapped by the host; this package does not bundle a copy |

`peerDependenciesMeta` marks the three items above as **optional**: they are provided by Pi; when installing this package's runtime dependencies you do not need, and should not install, a second copy.

## Design references

- Containment checks (`src/policy.ts`) follow the "lexical fast path + real-path ancestor verification" approach of DSH `packages/fs/fs-sandbox/src/containment.ts` (MIT); this repository is an independent implementation and does not copy upstream source.
- Denial signatures and runner failure signatures reuse the public constants of DSH `packages/sandbox/sandbox-local/src/index.ts` (MIT) (`windows-acl-run: ` / exit 127 / `DENIAL_SIGNATURES`), with added Chinese localization and an `EPERM` criterion.

## Bundled (vendored) upstream copy

`@deepseek-ai/dsh-sandbox-windows-acl` (MIT, <https://github.com/deepseek-ai/deepseek-harness>) is based on the npm
release `0.2.2-rc.5`, keeps `src/` and the build output `lib/` inside `vendor/dsh-sandbox-windows-acl/`, and includes:

- `LICENSE`: the verbatim upstream MIT license;
- `patches/`: the unified diff of this patch (reviewable with `git apply`);
- `pin.json`: the upstream tarball version and SHA-256, and the patch hash;
- `PROVENANCE.json`: the build tool versions and the SHA-256 of each output file.

The upstream `0.2.2-rc.5` release does **not** include this patch; this package does not claim that the fix has been released upstream.

## Upstream projects

- DSH / `deepseek-harness`: <https://github.com/deepseek-ai/deepseek-harness>
- Pi / `pi`: <https://github.com/earendil-works/pi>

To satisfy each upstream's license conditions when redistributing, keep the copyright and license texts shipped with the corresponding packages; this file does not replace them.