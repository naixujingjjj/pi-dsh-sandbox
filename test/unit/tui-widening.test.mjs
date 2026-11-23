/**
 * Mode-widening confirmation in the TUI: same yellow dock/card as an operation approval, same
 * fail-closed rules, and the plain `ui.confirm` kept for RPC/print.
 *
 * The dock itself is exercised by `tui-panel.test.mjs`; here the `ui.custom` transport is resolved by
 * the test so the focus is the command wiring: which card entries are appended, what happens on
 * cancel/unavailable, and that the mode never changes by accident.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerSandboxCommand } from "../../src/commands.ts";
import { getSessionState, invalidateRuntime, invalidateSessions } from "../../src/state.ts";
import { hasAnsi, hasYellow, makeTheme, makeKeybindings, nonYellowText, stripAnsi } from "../fixtures/palette.mjs";

const TEST = { timeout: 10000 };
const root = resolve(import.meta.dirname, "../..");

function fixture(t, options = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pidsbx-widen-"));
	invalidateRuntime();
	invalidateSessions();
	t.after(() => {
		invalidateRuntime();
		invalidateSessions();
		rmSync(cwd, { recursive: true, force: true });
	});
	const entries = [];
	const customCalls = [];
	const confirmCalls = [];
	let component;
	let handler;
	const pi = {
		registerCommand(_name, definition) {
			handler = definition.handler;
		},
		getFlag(name) {
			return name === "sandbox-mode" ? "workspace-write" : undefined;
		},
		appendEntry(...args) {
			entries.push(args);
		},
	};
	const ui = {
		notify() {},
		async select() {
			return undefined;
		},
		async custom(factory, customOptions) {
			customCalls.push(customOptions);
			component = factory({ requestRender() {}, mode: "regular" }, makeTheme(), makeKeybindings(), () => {});
			customOptions.onHandle?.({
				setHidden() {},
				isHidden() {
					return false;
				},
				focus() {},
				unfocus() {},
				isFocused() {
					return true;
				},
				hide() {},
				getBounds() {
					return undefined;
				},
			});
			if (options.outcome === "throw") throw new Error("custom unavailable");
			return options.outcome;
		},
		setWidget() {},
		onTerminalInput() {
			return () => {};
		},
		async confirm(title, message) {
			confirmCalls.push({ title, message });
			return options.confirmAnswer === true;
		},
	};
	const ctx = {
		cwd,
		hasUI: true,
		mode: options.mode ?? "tui",
		sessionManager: { getSessionId: () => "widen-test" },
		ui,
	};
	registerSandboxCommand(pi, root);
	return {
		ctx,
		entries,
		customCalls,
		confirmCalls,
		component: () => component,
		state: () => getSessionState(pi, root, ctx),
		run: (args = "mode off") => handler(args, ctx),
		cardEntries: () => entries.filter(([type]) => type === "pi-dsh-sandbox/approval-card"),
	};
}

function cardText(entries) {
	return entries.map(([, data]) => data.lines.map((line) => line.text).join("\n")).join("\n---\n");
}

test("the widening confirm uses the yellow dock and appends a plain-text card for both states", TEST, async (t) => {
	const f = fixture(t, { outcome: { kind: "selected", index: 0 } });
	await f.run();
	assert.equal(f.state().mode, "workspace-write", "the default option keeps the current mode");
	assert.equal(f.confirmCalls.length, 0, "the plain confirm must not be used in tui mode");
	assert.equal(f.customCalls.length, 1);
	assert.equal(f.customCalls[0].overlay, true, "the dock must float over the transcript");
	assert.equal(f.customCalls[0].blocked.kind, "permission");
	const cards = f.cardEntries();
	assert.equal(cards.length, 2, "pending + outcome");
	for (const [, data] of cards) {
		assert.equal(data.kind, "mode-widening");
		for (const line of data.lines) assert.equal(hasAnsi(line.text), false, "entry data carries no ANSI");
	}
	const text = cardText(cards);
	assert.match(text, /^放宽沙盒限制？/);
	assert.match(text, /当前：workspace-write（只能写工作区根与运行器私有 temp）/);
	assert.match(text, /目标：off（不介入：工具以未受限方式执行）/);
	assert.match(text, /授权根（规范真实路径）：/);
	assert.match(text, /审批状态：等待你在下方黄色面板中确认（不会自动放宽）/);
	assert.match(text, /选项：取消（保持当前模式 workspace-write） · 确认放宽为 off/);
	assert.match(text, /审批状态：已取消（模式未变化）/);

	// The dock the command built is yellow and offers exactly two choices.
	const component = f.component();
	const lines = component.render(80);
	for (const line of lines) {
		assert.ok(hasYellow(line), `not yellow: ${JSON.stringify(stripAnsi(line))}`);
		assert.equal(nonYellowText(line), "");
	}
	const screen = lines.map((line) => stripAnsi(line)).join("\n");
	assert.match(screen, /\[1\] 取消（保持当前模式 workspace-write）/);
	assert.match(screen, /\[2\] 确认放宽为 off/);
	assert.match(screen, /↑\/↓ 选择 · Enter 确认 · 1-2 选择 · Esc 取消（不执行）/);
	assert.match(screen, /F2 隐藏本面板回看对话/);
	assert.match(screen, /│ > \[1\] 取消（保持当前模式 workspace-write）/, "the safe option is preselected");
	component.dispose();
	assert.equal(f.state().mode, "workspace-write");
});

test("confirming the widening changes the mode and records the confirmation", TEST, async (t) => {
	const f = fixture(t, { outcome: { kind: "selected", index: 1 } });
	await f.run();
	assert.equal(f.state().mode, "off");
	const text = cardText(f.cardEntries());
	assert.match(text, /审批状态：已确认放宽模式/);
	f.component().dispose();
});

test("a cancelled dock or an aborted turn never widens the mode", TEST, async (t) => {
	for (const outcome of [{ kind: "cancelled" }, { kind: "reason-cancelled", index: 0 }]) {
		const f = fixture(t, { outcome });
		await f.run();
		assert.equal(f.state().mode, "workspace-write", JSON.stringify(outcome));
		assert.match(cardText(f.cardEntries()), /审批状态：已取消（模式未变化）/);
		f.component().dispose();
	}
});

test("an unavailable dock falls back to the plain confirm and still requires an answer", TEST, async (t) => {
	const denied = fixture(t, { outcome: "throw", confirmAnswer: false });
	await denied.run();
	assert.equal(denied.state().mode, "workspace-write");
	assert.equal(denied.confirmCalls.length, 1);
	assert.equal(denied.confirmCalls[0].title, "放宽沙盒限制？");
	assert.equal(hasAnsi(denied.confirmCalls[0].message), false, "the confirm text has no ANSI");
	assert.match(denied.confirmCalls[0].message, /当前：workspace-write/);
	assert.match(cardText(denied.cardEntries()), /黄色审批面板不可用，已改用原生确认对话框/);

	const accepted = fixture(t, { outcome: "throw", confirmAnswer: true });
	await accepted.run();
	assert.equal(accepted.state().mode, "off");
});

test("rpc and print keep the plain confirm without appending approval cards", TEST, async (t) => {
	for (const mode of ["rpc", "print"]) {
		const f = fixture(t, { mode, confirmAnswer: false });
		await f.run();
		assert.equal(f.customCalls.length, 0, mode);
		assert.equal(f.confirmCalls.length, 1, mode);
		assert.equal(f.cardEntries().length, 0, mode);
		assert.equal(f.state().mode, "workspace-write");
	}
});