/**
 * Component-level checks of the approval dock: what it draws in each state and how it reacts to the
 * documented keys, without a terminal. The full key routing through a real `TuiAltScreen` is covered
 * by `tui-panel.test.mjs`; this file pins the drawing/说明 text and the fail-closed exits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalPanel } from "../../src/tui/panel.ts";
import { APPROVAL_OPTIONS } from "../../src/approval.ts";
import { hasYellow, makeKeybindings, makeTheme, nonYellowText, stripAnsi } from "../fixtures/palette.mjs";

const TEST = { timeout: 10000 };
const theme = makeTheme();

const SPEC = {
	title: "模型正在请求一次工作区外的操作",
	header: [
		"来源：模型工具 sandbox_request（工具调用 call-1）",
		"完整理由、完整命令（原样、未截断）、cwd、模式与超时都在上方的黄色审批卡片里。",
		"cwd：C:\\work\\root · 本次执行方式：off（不经过沙盒） · 会话模式保持 workspace-write",
	],
	options: [...APPROVAL_OPTIONS],
	defaultIndex: 0,
	reasonFor: {
		2: {
			title: "本次操作完成后的补充要求",
			placeholder: "",
			note: "批准本次操作，并填写「本次操作完成后的补充要求」（必填）。留空或取消=本次不批准，命令不会执行。",
		},
		3: {
			title: "拒绝原因或新的执行方向",
			placeholder: "",
			note: "拒绝本次操作，并填写「拒绝原因或新的执行方向」（必填）。留空或取消=只表示不执行本次操作。",
		},
	},
	panelKey: "panel-render",
	blockedMessage: "模型正在请求一次工作区外的操作（等待审批）",
};

function mount() {
	const outcomes = [];
	let widget;
	let listener;
	const hidden = { value: false };
	const focus = [];
	const handle = {
		setHidden(value) {
			hidden.value = value;
		},
		isHidden() {
			return hidden.value;
		},
		focus() {
			focus.push("focus");
		},
		unfocus() {},
		isFocused() {
			return true;
		},
		hide() {},
		getBounds() {
			return undefined;
		},
	};
	const panel = new ApprovalPanel({
		tui: { requestRender() {}, mode: "regular" },
		theme,
		keybindings: makeKeybindings(),
		spec: SPEC,
		done: (outcome) => outcomes.push(outcome),
		setWidget: (key, content, options) => {
			widget = content === undefined ? undefined : { key, content, options };
		},
		onTerminalInput: (handler) => {
			listener = handler;
			return () => {
				listener = undefined;
			};
		},
	});
	panel.attachHandle(handle);
	return {
		panel,
		outcomes,
		hidden,
		focus,
		widget: () => widget,
		listener: () => listener,
		setListener: (handler) => {
			listener = handler;
		},
	};
}

const screen = (panel, width = 90) => panel.render(width).map((line) => stripAnsi(line)).join("\n");

function assertAllYellow(panel, width = 90) {
	for (const line of panel.render(width)) {
		assert.ok(hasYellow(line), `not yellow: ${JSON.stringify(stripAnsi(line))}`);
		assert.equal(nonYellowText(line), "", `non-yellow text: ${JSON.stringify(nonYellowText(line))}`);
	}
}

test("the menu lists the four options, the hints and nothing that belongs to the card", TEST, () => {
	const { panel } = mount();
	const text = screen(panel);
	assert.match(text, /模型正在请求一次工作区外的操作/);
	assert.match(text, /\[1\] Yes/);
	assert.match(text, /\[3\] Yes, and reason…/);
	assert.match(text, /↑\/↓ 选择 · Enter 确认 · 1-4 选择 · Esc 取消（不执行）/);
	assert.match(text, /F2 隐藏本面板回看对话（再按 F2 返回；此时不会执行）/);
	assert.doesNotMatch(text, /Set-Content|BEGIN COMMAND/);
	assertAllYellow(panel);
	assert.equal(panel.render(90).every((line) => nonYellowText(line) === ""), true);
});

test("the reason state shows a blank yellow input row and then the typed text", TEST, () => {
	const { panel } = mount();
	panel.handleInput("\u001b[B");
	panel.handleInput("\u001b[B");
	panel.handleInput("\r");
	let text = screen(panel);
	assert.match(text, /本次操作完成后的补充要求/);
	assert.match(text, /将选择：\[3\] Yes, and reason…/);
	assert.match(text, /批准本次操作，并填写「本次操作完成后的补充要求」（必填）/);
	assert.match(text, /│ >\s+│/, "the reason input must be visibly blank");
	assert.doesNotMatch(text, /完成后解释意图、作用与实际结果|不要在C盘操作，改到工作区下/);
	assert.match(text, /Enter 提交 · Esc 取消（不执行）· Backspace 删除 · 支持中文与粘贴/);
	assertAllYellow(panel);

	for (const char of "不要在C盘操作") panel.handleInput(char);
	panel.handleInput("\u001b[200~，改到工作区下\u001b[201~");
	text = screen(panel);
	assert.match(text, /> 不要在C盘操作，改到工作区下/);
	assertAllYellow(panel);
});

test("a digit only moves the marker, and Enter settles the highlighted option", TEST, () => {
	const { panel, outcomes } = mount();
	panel.handleInput("4");
	assert.match(screen(panel), /> \[4\] No, and reason…/);
	assert.equal(outcomes.length, 0, "a digit must never decide");
	panel.handleInput("\u001b[A");
	assert.match(screen(panel), /> \[3\] Yes, and reason…/);
	assert.equal(outcomes.length, 0, "an arrow must never decide");
	panel.handleInput("\r");
	assert.match(screen(panel), /本次操作完成后的补充要求/);
	assert.equal(outcomes.length, 0, "the reason option only opens the editor");
	panel.handleInput("完成后解释意图");
	panel.handleInput("\r");
	assert.deepEqual(outcomes, [{ kind: "selected", index: 2, reason: "完成后解释意图" }]);
});

test("Esc, a blank reason and the reject path all fail closed", TEST, () => {
	const menu = mount();
	menu.panel.handleInput("\u001b");
	assert.deepEqual(menu.outcomes, [{ kind: "cancelled" }]);

	const blank = mount();
	blank.panel.handleInput("3");
	blank.panel.handleInput("\r");
	blank.panel.handleInput("\r");
	assert.deepEqual(blank.outcomes, [{ kind: "reason-cancelled", index: 2 }]);

	const plainDecline = mount();
	plainDecline.panel.handleInput("2");
	plainDecline.panel.handleInput("\r");
	assert.deepEqual(plainDecline.outcomes, [{ kind: "selected", index: 1 }]);

	const escape = mount();
	escape.panel.handleInput("4");
	escape.panel.handleInput("\r");
	escape.panel.handleInput("\u001b");
	assert.deepEqual(escape.outcomes, [{ kind: "reason-cancelled", index: 3 }]);

	for (const mounted of [menu, blank, plainDecline, escape]) {
		mounted.panel.handleInput("\r");
		assert.equal(mounted.outcomes.length, 1, "one interaction answers exactly once");
	}
});

test("F2 hides the panel, releases focus, installs only the F2 listener, and returns pending", TEST, () => {
	const { panel, hidden, focus, widget, listener, outcomes } = mount();
	panel.handleInput("\u001bOQ");
	assert.equal(hidden.value, true);
	assert.ok(widget(), "the one-line return hint must be installed");
	assert.equal(widget().options.placement, "aboveEditor");
	assert.equal(typeof listener(), "function", "the return key must be captured only while hidden");
	// Anything but F2 passes through untouched.
	assert.equal(listener()("x"), undefined);
	assert.equal(listener()("\r"), undefined);
	assert.equal(outcomes.length, 0, "hiding must never answer");

	const consumed = listener()("\u001bOQ");
	assert.deepEqual(consumed, { consume: true });
	assert.equal(hidden.value, false);
	assert.equal(widget(), undefined, "the hint is cleared on return");
	assert.equal(focus.length > 0, true, "focus must come back to the panel");
	assert.equal(listener(), undefined);
	assert.equal(outcomes.length, 0);

	panel.handleInput("\u001b");
	assert.deepEqual(outcomes, [{ kind: "cancelled" }]);
	assert.equal(hidden.value, false);
});

test("F2 in the reason state keeps the typed text and restores the editor", TEST, () => {
	const { panel, hidden, widget, listener } = mount();
	panel.handleInput("\u001b[B");
	panel.handleInput("\u001b[B");
	panel.handleInput("\r");
	for (const char of "完成后") panel.handleInput(char);
	panel.handleInput("\u001bOQ");
	assert.equal(hidden.value, true);
	assert.ok(widget());
	listener()("\u001bOQ");
	assert.equal(hidden.value, false);
	assert.match(screen(panel), /> 完成后/);
	assert.match(screen(panel), /本次操作完成后的补充要求/);
});

test("dispose settles as cancelled, removes the widget and the listener, and cannot answer twice", TEST, () => {
	const { panel, hidden, widget, listener, outcomes } = mount();
	panel.handleInput("\u001bOQ");
	assert.ok(widget());
	panel.dispose();
	assert.deepEqual(outcomes, [{ kind: "cancelled" }]);
	assert.equal(widget(), undefined);
	assert.equal(listener(), undefined);
	panel.dispose();
	panel.handleInput("\r");
	assert.equal(outcomes.length, 1);
});

test("a narrow terminal keeps every dock line inside the width", TEST, () => {
	const { panel } = mount();
	for (const width of [90, 60, 40, 30, 24]) {
		for (const line of panel.render(width)) {
			assert.ok(line.length > 0);
			assert.equal(nonYellowText(line), "", `width ${width}`);
		}
	}
	panel.handleInput("\u001b[B");
	panel.handleInput("\u001b[B");
	panel.handleInput("\r");
	for (const char of "这是一个很长的中文理由，用来验证窄窗口下的换行与宽度安全，不应该越界") panel.handleInput(char);
	for (const line of panel.render(24)) {
		assert.equal(nonYellowText(line), "", "narrow reason line");
	}
});
