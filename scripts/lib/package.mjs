/** Shared release file policy; keep implementation notes and local data outside distributable packages. */
import assert from "node:assert/strict";

export const requiredPackageFiles = [
	"package.json", "README.md", "CONTRIBUTING.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md",
	"docs/installation.md", "docs/usage.md", "docs/configuration.md", "docs/security.md", "docs/troubleshooting.md",
	"src/index.ts", "src/kernel-helper.mjs", "src/runner.ts", "src/mutation.ts", "src/approval.ts", "src/reason.ts",
	"src/locale.ts", "src/i18n.ts",
	"src/tools/sandbox-request.ts", "src/tui/panel.ts", "src/tui/card.ts", "src/tui/theme.ts",
	// The patched backend travels inside the package; a tarball without it cannot authorize a
	// workspace whose root only inherits the Low label (see vendor/.../PATCH.md).
	"vendor/dsh-sandbox-windows-acl/package.json",
	"vendor/dsh-sandbox-windows-acl/pin.json",
	"vendor/dsh-sandbox-windows-acl/PROVENANCE.json",
	"vendor/dsh-sandbox-windows-acl/PATCH.md",
	"vendor/dsh-sandbox-windows-acl/LICENSE",
	"vendor/dsh-sandbox-windows-acl/lib/runner.js",
	"vendor/dsh-sandbox-windows-acl/lib/index.js",
	"vendor/dsh-sandbox-windows-acl/lib/acl.js",
	"vendor/dsh-sandbox-windows-acl/src/acl.ts",
	"vendor/dsh-sandbox-windows-acl/src/win32-abi.ts",
	"vendor/dsh-sandbox-windows-acl/patches/0001-low-label-guard-and-acl-walk-bounds.patch",
];

export function assertPackageFiles(paths) {
	const missing = requiredPackageFiles.filter((path) => !paths.includes(path));
	assert.deepEqual(missing, [], `Missing package files: ${missing.join(", ")}`);
	const forbidden = paths.filter((path) =>
		/^(?:node_modules|test|scripts|\.github)\//.test(path) ||
		/\.(?:tgz|log)$/.test(path) || /(?:^|\/)(?:research|implementation)\.md$/.test(path) ||
		/(?:^|\/)\.env(?:\.|$)/.test(path) || path.includes(".."));
	assert.deepEqual(forbidden, [], `Unexpected package files: ${forbidden.join(", ")}`);
}
