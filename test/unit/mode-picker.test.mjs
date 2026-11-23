import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerSandboxCommand } from "../../src/commands.ts";
import { getSessionState, invalidateRuntime, invalidateSessions } from "../../src/state.ts";

function fixture(t) {
	const cwd = mkdtempSync(join(tmpdir(), "pidsbx-picker-"));
	invalidateRuntime();
	invalidateSessions();
	t.after(() => {
		invalidateRuntime();
		invalidateSessions();
		rmSync(cwd, { recursive: true, force: true });
	});
	let command;
	const choices = [];
	const confirmations = [];
	const entries = [];
	const notices = [];
	let selectMode;
	let approved = false;
	const pi = {
		registerCommand(_name, definition) { command = definition; },
		getFlag(name) { return name === "sandbox-mode" ? "workspace-write" : undefined; },
		appendEntry(...args) { entries.push(args); },
	};
	const ctx = {
		cwd, hasUI: true,
		sessionManager: { getSessionId: () => "picker-test" },
		ui: {
			notify(message) { notices.push(message); },
			async select(title, options) {
				choices.push({ title, options });
				return options.find((option) => option.replace(/^\[当前\] /, "").startsWith(`${selectMode}（`));
			},
			async confirm(...args) { confirmations.push(args); return approved; },
		},
	};
	const root = resolve(import.meta.dirname, "../..");
	registerSandboxCommand(pi, root);
	return {
		get command() { return command; }, ctx, choices, confirmations, entries, notices,
		pick(mode) { selectMode = mode; }, approve(value) { approved = value; },
		state: () => getSessionState(pi, root, ctx),
	};
}

test("mode argument completion offers complete commands and filters partial modes", (t) => {
	const f = fixture(t);
	assert.deepEqual(f.command.getArgumentCompletions("mode ").map((item) => item.value).sort(),
		["mode off", "mode read-only", "mode workspace-write"]);
	assert.deepEqual(f.command.getArgumentCompletions("mode w").map((item) => item.value), ["mode workspace-write"]);
	assert.equal(f.command.getArgumentCompletions("mode bad"), null);
});

test("picker opens from both sandbox commands, preserves cancellation and requires widening approval", async (t) => {
	const f = fixture(t);
	f.pick("read-only");
	await f.command.handler("", f.ctx);
	assert.equal(f.state().mode, "read-only");
	assert.equal(f.confirmations.length, 0);
	assert.equal(f.choices[0].options.length, 3);
	assert.match(f.choices[0].options[0], /^\[当前\] workspace-write/);
	f.pick("off");
	await f.command.handler("mode", f.ctx);
	assert.equal(f.state().mode, "read-only");
	assert.equal(f.confirmations.length, 1);
	f.approve(true);
	await f.command.handler("mode", f.ctx);
	assert.equal(f.state().mode, "off");
	assert.equal(f.confirmations.length, 2);
	const entryCount = f.entries.length;
	f.pick(undefined);
	await f.command.handler("", f.ctx);
	assert.equal(f.state().mode, "off");
	assert.equal(f.entries.length, entryCount);
});

test("no-UI command shows status instead of opening a picker; explicit modes still work", async (t) => {
	const f = fixture(t);
	f.ctx.hasUI = false;
	await f.command.handler("", f.ctx);
	assert.equal(f.choices.length, 0);
	assert.match(f.notices.at(-1), /mode: workspace-write/);
	await f.command.handler("mode read-only", f.ctx);
	assert.equal(f.state().mode, "read-only");
	await f.command.handler("mode off", f.ctx);
	assert.equal(f.state().mode, "read-only");
	assert.equal(f.confirmations.length, 0);
});
