/** Shared release file policy; keep implementation notes and local data outside distributable packages. */
import assert from "node:assert/strict";

export const requiredPackageFiles = [
	"package.json", "README.md", "CONTRIBUTING.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md",
	"docs/installation.md", "docs/usage.md", "docs/configuration.md", "docs/security.md", "docs/troubleshooting.md",
	"src/index.ts", "src/kernel-helper.mjs", "src/runner.ts", "src/mutation.ts", "src/approval.ts", "src/reason.ts",
	"src/locale.ts", "src/i18n.ts",
	"src/tools/sandbox-request.ts", "src/tui/panel.ts", "src/tui/card.ts", "src/tui/theme.ts",
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
