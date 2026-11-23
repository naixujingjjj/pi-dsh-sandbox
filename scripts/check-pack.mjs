/**
 * Package check: the tarball must be installable and free of host-specific residue.
 *
 * 1. `npm pack` and inspect the file list (no node_modules, no tarballs, no host paths).
 * 2. Install the tarball into a throw-away project with `--include=optional` and prove the
 *    dependency graph really works: the runner and the prebuilt koffi binary are present, and a
 *    confined write is allowed inside / denied outside an isolated temp workspace.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNpm } from "./lib/npm.mjs";
import { assertPackageFiles } from "./lib/package.mjs";
import { locateRunner } from "../src/runner.ts";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "pidsbx-pack-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(work, "isolated-agent");
const passed = [];
const ok = (name, detail = "") => {
	passed.push(name);
	console.log(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
};

try {
	// --- pack ---------------------------------------------------------------------------------
	const packed = JSON.parse(runNpm(["pack", "--json", "--pack-destination", work], { cwd: pluginRoot }).stdout);
	assert.equal(packed.length, 1);
	const tarball = join(work, packed[0].filename);
	assert.equal(existsSync(tarball), true);
	const paths = packed[0].files.map((file) => file.path);
	ok("npm pack produces one tarball", `${packed[0].filename} (${packed[0].size} bytes)`);

	const required = [
		"package.json",
		"README.md",
		"LICENSE",
		"THIRD_PARTY_NOTICES.md",
		"src/index.ts",
		"src/kernel-helper.mjs",
		"src/mutation.ts",
		"src/runner.ts",
		"src/policy.ts",
		"src/approval.ts",
		"src/reason.ts",
		"src/classify.ts",
		"src/config.ts",
		"src/ipc.ts",
		"src/commands.ts",
		"src/shell-command.ts",
		"src/state.ts",
		"src/errors.ts",
		"src/tools/fs-tools.ts",
		"src/tools/shell-tools.ts",
		"src/tools/sandbox-request.ts",
		"src/tools/types.ts",
		"src/tui/theme.ts",
		"src/tui/card.ts",
		"src/tui/panel.ts",
		"src/tui/entry.ts",
		"src/tui/live.ts",
		"CHANGELOG.md",
		"docs/installation.md",
		"docs/usage.md",
		"docs/configuration.md",
		"docs/security.md",
		"docs/troubleshooting.md",
	];
	const missing = required.filter((path) => !paths.includes(path));
	assert.deepEqual(missing, [], `missing from the tarball: ${missing.join(", ")}`);
	assertPackageFiles(paths);
	ok("the tarball contains the extension, its docs and the licence", `${paths.length} files`);

	assert.deepEqual(paths.filter((path) => path.startsWith("node_modules/")), [], "node_modules must not be packed");
	assert.deepEqual(paths.filter((path) => path.includes("@earendil-works")), [], "the Pi host must not be bundled");
	assert.deepEqual(paths.filter((path) => path.endsWith(".tgz")), []);
	assert.deepEqual(paths.filter((path) => path.startsWith("test/")), [], "tests stay out of the package");
	ok("no node_modules, no second Pi host, no tests in the tarball");

	// --- host paths ---------------------------------------------------------------------------
	const hostPathPatterns = [/\b[A-Za-z]:\\\\Users\\\\/, /\b[A-Za-z]:\\Users\\/, /\bF:\\dsh\b/, /\bF:\/dsh\b/];
	const offenders = [];
	for (const path of paths) {
		if (!/\.(ts|js|mjs|json|md)$/.test(path)) continue;
		const text = readFileSync(join(pluginRoot, path), "utf8");
		for (const pattern of hostPathPatterns) {
			if (pattern.test(text)) offenders.push(`${path} matches ${pattern}`);
		}
	}
	assert.deepEqual(offenders, [], `host absolute paths in the package: ${offenders.join("; ")}`);
	ok("no machine-specific absolute paths in the packaged sources");

	// --- install the tarball -------------------------------------------------------------------
	const project = join(work, "install");
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, "package.json"), JSON.stringify({ name: "pidsbx-install-check", private: true, version: "1.0.0" }));
	runNpm(["install", "--include=optional", "--omit=dev", "--no-audit", "--no-fund", tarball], { cwd: project });
	ok("npm install <tarball> succeeds with --include=optional");

	const aclRoot = join(project, "node_modules", "@deepseek-ai", "dsh-sandbox-windows-acl");
	const runner = join(aclRoot, "lib", "runner.js");
	assert.equal(existsSync(runner), true, "the sandbox runner must be installed");
	const koffi = join(project, "node_modules", "@koromix", "koffi-win32-x64", "win32_x64", "koffi.node");
	assert.equal(existsSync(koffi), true, "the prebuilt koffi binary must be installed");
	assert.equal(existsSync(join(project, "node_modules", "@earendil-works")), false, "Pi must not be installed as a dependency");
	const version = JSON.parse(readFileSync(join(aclRoot, "package.json"), "utf8")).version;
	ok("the installed tree carries the runner and the prebuilt koffi binary", `acl ${version}`);
	const installedPlugin = join(project, "node_modules", "pi-dsh-sandbox");
	assert.equal(readFileSync(join(installedPlugin, "src", "runner.ts"), "utf8"),
		readFileSync(join(pluginRoot, "src", "runner.ts"), "utf8"), "the installed resolver must match the checked source");
	const located = locateRunner({ runnerModule: null, dshRoot: null, pluginRoot: installedPlugin,
		globalRoots: () => { throw new Error("Installed tarball must work without global DSH"); } });
	assert.equal(located.location.source, "plugin");
	assert.equal(located.location.modulePath, runner);
	ok("the installed plugin resolves its hoisted backend without global DSH");

	// Exercise host peer aliases from the installed tarball, which has no physical Pi/typebox copy.
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
		await import("@earendil-works/pi-coding-agent");
	const agentDir = join(work, "isolated-agent");
	mkdirSync(agentDir);
	const settingsManager = SettingsManager.inMemory({ defaultTools: ["-bash", "+powershell"] });
	const resourceLoader = new DefaultResourceLoader({ cwd: project, agentDir, settingsManager,
		additionalExtensionPaths: [join(project, "node_modules", "pi-dsh-sandbox")],
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, [], "the installed extension must resolve host peers");
	const { session } = await createAgentSession({ cwd: project, agentDir, resourceLoader, settingsManager,
		sessionManager: SessionManager.inMemory() });
	try {
		assert.equal(session.getActiveToolNames().includes("sandbox_request"), true);
		assert.equal(session.getActiveToolNames().includes("bash"), false);
	} finally {
		session.dispose();
	}
	ok("the installed tarball loads through Pi and registers sandbox_request without a second host");

	// --- the packaged graph really confines ---------------------------------------------------
	const ruleDir = join(work, "rule");
	const ws = join(ruleDir, "ws");
	const tp = join(ruleDir, "tp");
	const outside = join(ruleDir, "out");
	for (const dir of [ws, tp, outside]) mkdirSync(dir, { recursive: true });
	const probe = (mode, target) =>
		spawnSync(
			process.execPath,
			[runner, "--workspace", ws, "--temp", tp, "--mode", mode, "--", process.execPath, "-e",
				`require('node:fs').writeFileSync(${JSON.stringify(target)}, 'x')`],
			{ encoding: "utf8", cwd: ws },
		);
	const insideWrite = probe("workspace-write", join(ws, "installed-inside.txt"));
	assert.equal(insideWrite.status, 0, insideWrite.stderr);
	assert.equal(existsSync(join(ws, "installed-inside.txt")), true);
	const outsideWrite = probe("workspace-write", join(outside, "installed-outside.txt"));
	assert.notEqual(outsideWrite.status, 0);
	assert.equal(existsSync(join(outside, "installed-outside.txt")), false);
	assert.match(`${outsideWrite.stdout}${outsideWrite.stderr}`, /EPERM|denied/i);
	ok("the installed package confines a real write (inside allowed, outside denied)");

	console.log(`\nPack check: ${passed.length} checks passed`);
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(work, { recursive: true, force: true });
}
