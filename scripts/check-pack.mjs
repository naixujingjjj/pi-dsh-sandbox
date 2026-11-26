/**
 * Package check: the tarball must be installable, self-contained, and free of host-specific
 * residue.
 *
 * 1. `npm pack` and inspect the file list (no node_modules, no tarballs, no host paths).
 * 2. Install the tarball into a throw-away project with `--include=optional` and prove the
 *    dependency graph really works: the PATCHED backend travels inside the package under
 *    `vendor/dsh-sandbox-windows-acl`, its provenance hashes verify, the prebuilt koffi binary is
 *    present, and no unpatched `@deepseek-ai/dsh-sandbox-windows-acl` copy is installed.
 * 3. Resolve the runner through the INSTALLED plugin (never this checkout's node_modules), then run
 *    real confined probes with it: inside allowed, outside denied.
 * 4. Build an isolated parent/child ACL layout in which the root only INHERITS the Low label and
 *    does not inherit the account's full control, run the installed runner there, and assert that
 *    the grant completes without adding an account ACE while the inherited label stays unchanged.
 *    That is the reported fault, exercised against the shipped artifact.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNpm } from "./lib/npm.mjs";
import { assertPackageFiles } from "./lib/package.mjs";
import { locateRunner } from "../src/runner.ts";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Canonical, not the %TEMP% 8.3 spelling: the installed package reports the canonical root, and
// src/policy.ts resolves it with realpathSync.native.
const work = realpathSync.native(mkdtempSync(join(tmpdir(), "pidsbx-pack-")));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(work, "isolated-agent");
const passed = [];
const ok = (name, detail = "") => {
	passed.push(name);
	console.log(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
};

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function icacls(path, ...args) {
	const result = spawnSync("icacls", [path, ...args], { encoding: "utf8", windowsHide: true });
	return { status: result.status, text: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const VENDOR = "vendor/dsh-sandbox-windows-acl";   // npm pack lists POSIX-style paths

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
		"src/readiness.ts",
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
		`${VENDOR}/package.json`,
		`${VENDOR}/pin.json`,
		`${VENDOR}/PROVENANCE.json`,
		`${VENDOR}/PATCH.md`,
		`${VENDOR}/LICENSE`,
		`${VENDOR}/lib/runner.js`,
		`${VENDOR}/lib/acl.js`,
		`${VENDOR}/src/acl.ts`,
		`${VENDOR}/patches/0001-low-label-guard-and-acl-walk-bounds.patch`,
	];
	const missing = required.filter((path) => !paths.includes(path));
	assert.deepEqual(missing, [], `missing from the tarball: ${missing.join(", ")}`);
	assertPackageFiles(paths);
	ok("the tarball contains the extension, its docs, and the patched vendored backend", `${paths.length} files`);

	assert.deepEqual(paths.filter((path) => path.startsWith("node_modules/")), [], "node_modules must not be packed");
	assert.deepEqual(paths.filter((path) => path.includes("@earendil-works")), [], "the Pi host must not be bundled");
	assert.deepEqual(paths.filter((path) => path.endsWith(".tgz")), []);
	assert.deepEqual(paths.filter((path) => path.startsWith("test/")), [], "tests stay out of the package");
	assert.deepEqual(paths.filter((path) => path.startsWith("scripts/")), [], "maintenance scripts stay out of the package");
	ok("no node_modules, no second Pi host, no tests or scripts in the tarball");

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

	const installedPlugin = join(project, "node_modules", "pi-dsh-sandbox");
	const installedVendor = join(installedPlugin, VENDOR);
	assert.equal(existsSync(join(installedVendor, "lib", "runner.js")), true, "the patched vendored runner must be installed");
	assert.equal(existsSync(join(project, "node_modules", "@deepseek-ai", "dsh-sandbox-windows-acl")), false,
		"the unpatched published backend must not be installed");
	const koffi = join(project, "node_modules", "@koromix", "koffi-win32-x64", "win32_x64", "koffi.node");
	assert.equal(existsSync(koffi), true, "the prebuilt koffi binary must be installed");
	assert.equal(existsSync(join(project, "node_modules", "@earendil-works")), false, "Pi must not be installed as a dependency");
	ok("the installed tree carries the vendored runner and the prebuilt koffi binary, and no unpatched backend");

	// --- the shipped vendor build is the recorded one -------------------------------------------
	const provenance = JSON.parse(readFileSync(join(installedVendor, "PROVENANCE.json"), "utf8"));
	const patched = Object.keys(provenance.outputs ?? {});
	assert.ok(patched.length >= 20, "PROVENANCE.json must record the vendored files");
	const mismatched = patched.filter((rel) => sha256(join(installedVendor, rel)) !== provenance.outputs[rel]);
	assert.deepEqual(mismatched, [], `the installed vendored build does not match its provenance: ${mismatched.join(", ")}`);
	const aclSource = readFileSync(join(installedVendor, "lib", "acl.js"), "utf8");
	assert.match(aclSource, /hasEffectiveLowLabel/, "the shipped backend must carry the inherited-label guard");
	const manifest = JSON.parse(readFileSync(join(installedVendor, "package.json"), "utf8"));
	assert.match(manifest.version, /^0\.2\.2-rc\.5\+pi-dsh\.\d+$/, "the vendored build must identify its patch level");
	ok("the shipped vendored backend matches PROVENANCE.json and carries the patch", manifest.version);

	// --- resolver: the installed plugin finds ITS OWN vendored runner ----------------------------
	const located = locateRunner({
		runnerModule: null,
		dshRoot: null,
		pluginRoot: installedPlugin,
		globalRoots: () => { throw new Error("Installed tarball must work without global DSH"); },
	});
	assert.equal(located.location.source, "vendor");
	assert.equal(located.location.modulePath, join(installedVendor, "lib", "runner.js"));
	assert.equal(located.location.version, manifest.version);
	ok("the installed plugin resolves the runner from its own vendored backend");

	// Exercise host peer aliases from the installed tarball, which has no physical Pi/typebox copy.
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
		await import("@earendil-works/pi-coding-agent");
	const agentDir = join(work, "isolated-agent");
	mkdirSync(agentDir);
	const settingsManager = SettingsManager.inMemory({ defaultTools: ["-bash", "+powershell"] });
	const resourceLoader = new DefaultResourceLoader({ cwd: project, agentDir, settingsManager,
		additionalExtensionPaths: [installedPlugin],
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

	// --- the packaged graph really confines -----------------------------------------------------
	const runner = located.location.modulePath;
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

	// --- the reported fault, against the installed artifact -------------------------------------
	// A root whose parent grants the account full control WITHOUT inheritance, while the root only
	// inherits group rights and an inheritable Low label. The published 0.2.2-rc.5 backend rewrites
	// the label here and needs WRITE_OWNER (Win32 5); the vendored build must only edit the DACL.
	const account = `${process.env.USERDOMAIN || "."}\\${process.env.USERNAME}`;
	const accountPattern = new RegExp(account.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
	const aclBase = join(work, "acl-layout");
	const parent = join(aclBase, "parent (隔离)");
	const child = join(parent, "child (真实根布局)");
	const childTemp = join(work, "acl-temp (隔离)");
	mkdirSync(parent, { recursive: true });
	mkdirSync(childTemp, { recursive: true });
	let denyAdded = false;
	try {
		for (const [step, path, args] of [
			["strip inheritance", parent, ["/inheritance:r"]],
			["grant the account one level", parent, ["/grant:r", `${account}:(F)`]],
			["grant ambient group rights", parent, ["/grant", "*S-1-5-11:(OI)(CI)(M)"]],
			["deny ambient delete-child", parent, ["/deny", "*S-1-1-0:(CI)(DC)"]],
			["set the inheritable Low label", parent, ["/setintegritylevel", "(OI)(CI)L"]],
		]) {
			const result = icacls(path, ...args);
			assert.equal(result.status, 0, `${step} failed:\n${result.text}`);
		}
		denyAdded = true;
		mkdirSync(child, { recursive: true });

		const before = icacls(child).text;
		// Some hosts (GitHub's Windows runner: its %TEMP% carries an explicit CREATOR OWNER ACE that
		// /inheritance:r does not remove) instantiate that ACE for the creating account, so the child
		// gets an account ACE even though the parent was stripped clean. The layout under test cannot
		// be built there: report it as skipped with the ACL as evidence instead of a false failure.
		if (accountPattern.test(before)) {
			console.log(`SKIP  the inherited-Low-label layout cannot be built on this host:\n${before}`);
		} else {
			assert.match(before, /\(OI\)\(CI\)\(NW\)/i, `the child must inherit a Low no-write-up label:\n${before}`);

			const grant = spawnSync(
				process.execPath,
				[runner, "--workspace", child, "--temp", childTemp, "--mode", "workspace-write", "--", process.execPath, "-e", "process.stdout.write('granted')"],
				{ encoding: "utf8", cwd: child },
			);
			assert.equal(grant.status, 0, grant.stderr);
			assert.equal(grant.stdout, "granted");

			const after = icacls(child).text;
			assert.match(after, /S-1-4-\d+-\d+/, "the grant must add the workspace capability ACE");
			assert.match(after, /\(OI\)\(CI\)\(NW\)/i, "the inherited Low label must stay unchanged");
			assert.equal(accountPattern.test(after), false, `the grant must not need an account ACE:\n${after}`);

			const inside = join(child, "inside.txt");
			const insideRun = spawnSync(
				process.execPath,
				[runner, "--workspace", child, "--temp", childTemp, "--mode", "workspace-write", "--", process.execPath, "-e",
					`require('node:fs').writeFileSync(${JSON.stringify(inside)}, 'ok')`],
				{ encoding: "utf8", cwd: child },
			);
			assert.equal(insideRun.status, 0, insideRun.stderr);
			assert.equal(readFileSync(inside, "utf8"), "ok");
			const deniedTarget = join(work, "acl-outside.txt");
			const outsideRun = spawnSync(
				process.execPath,
				[runner, "--workspace", child, "--temp", childTemp, "--mode", "workspace-write", "--", process.execPath, "-e",
					`require('node:fs').writeFileSync(${JSON.stringify(deniedTarget)}, 'nope')`],
				{ encoding: "utf8", cwd: child },
			);
			assert.notEqual(outsideRun.status, 0);
			assert.equal(existsSync(deniedTarget), false);
			ok("the INSTALLED patched runner authorizes an inherited-Low-label root with a DACL-only edit and keeps the boundary");
		}
	} finally {
		// Drop the temporary deny before the tree is removed, so cleanup cannot be blocked.
		if (denyAdded) {
			const removed = icacls(parent, "/remove:d", "*S-1-1-0", "/T", "/C", "/Q");
			if (removed.status !== 0) console.error(`cleanup: removing the deny failed:\n${removed.text}`);
		}
	}

	console.log(`\nPack check: ${passed.length} checks passed`);
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(work, { recursive: true, force: true });
}