import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	ACL_PACKAGE,
	buildRunnerArgv,
	describeRunner,
	isTempInsideWorkspace,
	locateRunner,
	runnerLookupFailure,
} from "../../src/runner.ts";

const scratch = mkdtempSync(join(tmpdir(), "pidsbx-runner-"));

test.after(() => {
	rmSync(scratch, { recursive: true, force: true });
});

const location = { modulePath: "C:\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js", version: "0.2.2-rc.5", source: "plugin" };

test("runner argv is the documented arg-prefix contract", () => {
	const argv = buildRunnerArgv({
		location,
		root: "C:\\work\\proj",
		temp: "C:\\temp\\pidsbx",
		mode: "workspace-write",
		argv: ["C:\\pwsh.exe", "-NoProfile", "-Command", "echo hi"],
	});
	assert.equal(argv[0], process.execPath);
	assert.equal(argv[1], location.modulePath);
	assert.deepEqual(argv.slice(2), [
		"--workspace",
		"C:\\work\\proj",
		"--temp",
		"C:\\temp\\pidsbx",
		"--mode",
		"workspace-write",
		"--",
		"C:\\pwsh.exe",
		"-NoProfile",
		"-Command",
		"echo hi",
	]);
});

test("runner argv keeps non-ASCII and quoted arguments intact", () => {
	const argv = buildRunnerArgv({
		location,
		root: "C:\\工作 区",
		temp: "C:\\temp 目录",
		mode: "read-only",
		argv: ["C:\\程序\\pwsh.exe", "-Command", "Write-Output '中文 \"quoted\" 空格'"],
	});
	assert.equal(argv.includes("C:\\工作 区"), true);
	assert.equal(argv.includes("Write-Output '中文 \"quoted\" 空格'"), true);
	assert.equal(argv.indexOf("--") < argv.indexOf("C:\\程序\\pwsh.exe"), true);
});

test("runner argv refuses relative paths", () => {
	assert.throws(
		() => buildRunnerArgv({ location, root: "relative\\root", temp: "C:\\temp", mode: "read-only", argv: ["x"] }),
		/工作区根必须是绝对路径/,
	);
	assert.throws(
		() => buildRunnerArgv({ location, root: "C:\\work", temp: "temp", mode: "read-only", argv: ["x"] }),
		/runner temp 根必须是绝对路径/,
	);
	assert.throws(
		() => buildRunnerArgv({ location, root: "C:\\work", temp: "C:\\temp", mode: "read-only", argv: [] }),
		/需要一个被包裹的命令/,
	);
});

test("temp inside the workspace is detected in both spellings", () => {
	assert.equal(isTempInsideWorkspace("C:\\ws", "C:\\ws\\tmp"), true);
	assert.equal(isTempInsideWorkspace("C:\\ws", "C:\\WS"), true);
	assert.equal(isTempInsideWorkspace("C:\\ws", "C:\\ws2\\tmp"), false);
	assert.equal(isTempInsideWorkspace("C:\\ws\\", "C:\\ws\\tmp\\"), true);
	assert.equal(isTempInsideWorkspace("C:\\ws", "C:\\temp"), false);
});

test("an explicit runnerModule must exist and is never replaced silently", () => {
	const missing = join(scratch, "does-not-exist", "runner.js");
	assert.throws(
		() => locateRunner({ runnerModule: missing, dshRoot: null, pluginRoot: scratch, globalRoots: [] }),
		(error) => {
			assert.equal(error.code, "SANDBOX_UNAVAILABLE");
			assert.match(error.message, /不会被自动替换/);
			return true;
		},
	);
});

test("an explicit dshRoot must contain the runner and is never replaced silently", () => {
	assert.throws(
		() => locateRunner({ runnerModule: null, dshRoot: scratch, pluginRoot: scratch, globalRoots: [] }),
		(error) => {
			assert.equal(error.code, "SANDBOX_UNAVAILABLE");
			assert.match(error.message, new RegExp(ACL_PACKAGE.replace(/[/\\]/g, "\\\\")));
			return true;
		},
	);
});

test("an explicit runnerModule that exists is used first", () => {
	const fake = join(scratch, "runner.js");
	writeFileSync(fake, "// fake\n");
	const located = locateRunner({ runnerModule: fake, dshRoot: "C:\\dsh", pluginRoot: scratch, globalRoots: [] });
	assert.equal(located.location.source, "config:runnerModule");
	assert.equal(located.location.modulePath, fake);
	assert.equal(located.location.version, null);
});

test("the plugin's own dependency is probed before global roots", () => {
	const plugin = join(scratch, "plugin");
	const runner = join(plugin, "node_modules", "@deepseek-ai", "dsh-sandbox-windows-acl", "lib", "runner.js");
	mkdirSync(resolve(runner, ".."), { recursive: true });
	writeFileSync(runner, "// runner\n");
	writeFileSync(
		join(plugin, "node_modules", "@deepseek-ai", "dsh-sandbox-windows-acl", "package.json"),
		JSON.stringify({ name: ACL_PACKAGE, version: "0.2.2-rc.5" }),
	);
	const globalRoot = join(scratch, "global");
	mkdirSync(globalRoot, { recursive: true });
	const located = locateRunner({ runnerModule: null, dshRoot: null, pluginRoot: plugin, globalRoots: [globalRoot] });
	assert.equal(located.location.source, "plugin");
	assert.equal(located.location.version, "0.2.2-rc.5");
});

test("an npm-hoisted dependency resolves from the plugin before any global lookup", () => {
	const prefix = join(scratch, "hoisted");
	const plugin = join(prefix, "node_modules", "pi-dsh-sandbox");
	const backend = join(prefix, "node_modules", "@deepseek-ai", "dsh-sandbox-windows-acl");
	const runner = join(backend, "lib", "runner.js");
	mkdirSync(plugin, { recursive: true });
	mkdirSync(resolve(runner, ".."), { recursive: true });
	writeFileSync(runner, "// hoisted runner\n");
	writeFileSync(join(backend, "package.json"), JSON.stringify({
		name: ACL_PACKAGE, version: "0.2.2-rc.5", exports: { "./runner": "./lib/runner.js" },
	}));
	const located = locateRunner({ runnerModule: null, dshRoot: null, pluginRoot: plugin,
		globalRoots: () => { throw new Error("A hoisted plugin dependency must not consult global DSH"); } });
	assert.equal(located.location.source, "plugin");
	assert.equal(located.location.modulePath, runner);
	assert.equal(located.location.version, "0.2.2-rc.5");
});

test("an installed DSH tree is found under a global root", () => {
	const globalRoot = join(scratch, "npm-root");
	const runner = join(
		globalRoot,
		"@deepseek-ai",
		"dsh",
		"node_modules",
		"@deepseek-ai",
		"dsh-sandbox-windows-acl",
		"lib",
		"runner.js",
	);
	mkdirSync(resolve(runner, ".."), { recursive: true });
	writeFileSync(runner, "// runner\n");
	const located = locateRunner({
		runnerModule: null,
		dshRoot: null,
		pluginRoot: join(scratch, "empty-plugin"),
		globalRoots: [globalRoot],
	});
	assert.equal(located.location.source, "installed-dsh");
	assert.equal(located.location.modulePath, runner);
});

test("a missing runner yields a fail-closed error listing every attempt", () => {
	const located = locateRunner({
		runnerModule: null,
		dshRoot: null,
		pluginRoot: join(scratch, "empty-plugin-2"),
		globalRoots: [join(scratch, "empty-global")],
	});
	assert.equal(located.location, null);
	assert.equal(located.attempted.length >= 2, true);
	const error = runnerLookupFailure(located.attempted);
	assert.equal(error.code, "SANDBOX_UNAVAILABLE");
	assert.match(error.message, /不会以未受限方式执行命令/);
	assert.match(error.hint ?? "", /npm install --include=optional/);
});

test("describeRunner mentions the package and version", () => {
	assert.match(describeRunner(location), new RegExp(`0\\.2\\.2-rc\\.5`));
	assert.match(describeRunner(location), new RegExp(ACL_PACKAGE));
});
