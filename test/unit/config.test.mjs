import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG_KEY, parseConfig } from "../../src/config.ts";

function settings(section) {
	return JSON.stringify({ defaultThinkingLevel: "high", [CONFIG_KEY]: section });
}

test("defaults to workspace-write from the default source", () => {
	const config = parseConfig({ settingsText: null });
	assert.equal(config.mode, "workspace-write");
	assert.equal(config.modeSource, "default");
	assert.deepEqual(config.fatal, []);
	assert.equal(config.runnerModule, null);
});

test("global settings set the mode", () => {
	const config = parseConfig({ settingsText: settings({ mode: "read-only" }) });
	assert.equal(config.mode, "read-only");
	assert.equal(config.modeSource, "settings");
});

test("a CLI flag beats the settings file", () => {
	const config = parseConfig({
		settingsText: settings({ mode: "read-only" }),
		flags: { "sandbox-mode": "off" },
	});
	assert.equal(config.mode, "off");
	assert.equal(config.modeSource, "flag");
});

test("an invalid mode fails closed", () => {
	const config = parseConfig({ settingsText: settings({ mode: "danger-full-access" }) });
	assert.equal(config.mode, "workspace-write");
	assert.equal(config.modeSource, "default");
	assert.equal(config.fatal.length, 1);
});

test("an invalid flag mode fails closed even over configured off", () => {
	const config = parseConfig({ settingsText: settings({ mode: "off" }), flags: { "sandbox-mode": "yes" } });
	assert.equal(config.mode, "workspace-write");
	assert.equal(config.modeSource, "default");
	assert.equal(config.fatal.length, 1);
});

test("additional writable roots are refused, not ignored", () => {
	for (const key of ["additionalWritableRoots", "writableRoots", "writeRoots"]) {
		const config = parseConfig({ settingsText: settings({ [key]: ["C:\\other"] }) });
		assert.equal(config.fatal.length, 1, key);
		assert.match(config.fatal[0], /暂不支持/);
	}
});

test("unknown keys only warn", () => {
	const config = parseConfig({ settingsText: settings({ fileTools: "kernel" }) });
	assert.equal(config.fatal.length, 0);
	assert.equal(config.warnings.length, 1);
	assert.match(config.warnings[0], /未知配置项/);
});

test("runner and temp paths must be absolute", () => {
	const config = parseConfig({
		settingsText: settings({ runnerModule: "lib/runner.js", tempRoot: "tmp" }),
	});
	assert.equal(config.fatal.length, 2);
	assert.equal(config.runnerModule, null);
	assert.equal(config.tempRoot, null);
});

test("absolute runner paths are kept", () => {
	const config = parseConfig({
		settingsText: settings({
			runnerModule: "C:\\dsh\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js",
			dshRoot: "C:\\dsh",
			tempRoot: "C:\\temp\\pidsbx",
		}),
	});
	assert.equal(config.fatal.length, 0);
	assert.equal(config.runnerModule.endsWith("runner.js"), true);
	assert.equal(config.dshRoot, "C:\\dsh");
	assert.equal(config.tempRoot, "C:\\temp\\pidsbx");
});

test("a corrupt settings file fails closed", () => {
	const config = parseConfig({ settingsText: "{not json" });
	assert.equal(config.mode, "workspace-write");
	assert.equal(config.fatal.length, 1);
	assert.match(config.fatal[0], /无法解析/);
});

test("the config section must be an object", () => {
	const config = parseConfig({ settingsText: settings("workspace-write") });
	assert.equal(config.mode, "workspace-write");
	assert.equal(config.fatal.length, 1);
	assert.match(config.fatal[0], /必须是对象/);
});

test("a blank flag value does not override settings", () => {
	const config = parseConfig({ settingsText: settings({ mode: "read-only" }), flags: { "sandbox-mode": "  " } });
	assert.equal(config.mode, "read-only");
});
