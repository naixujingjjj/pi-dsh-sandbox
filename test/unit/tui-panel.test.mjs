/**
 * The approval dock, driven through the real TUI dispatch.
 *
 * The harness (see `test/fixtures/tui.mjs`) uses a real `TuiAltScreen`, the real `showOverlay`,
 * `setWidget` and `addInputListener` routing, and a real Pi theme. Keys therefore travel exactly the
 * documented way: global input listeners first, then the focused overlay, then the editor. What is
 * asserted below is what a local run shows: the panel's text, where focus is, what the screen says
 * after F2, and which decision (if any) came out.
 *
 * Every scenario is bounded: a short per-test timeout plus a `finally` that disposes the panel and
 * stops the TUI, so a failed assertion cannot leave an overlay or a timer hanging the suite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	APPROVAL_OPTIONS,
	renderApprovalMessage,
	requestOperationApproval,
} from "../../src/approval.ts";
import { canOpenTuiPanel, requestTuiPanel } from "../../src/tui/panel.ts";
import { createHarness, hasYellow, nonYellowText, visibleWidth } from "../fixtures/tui.mjs";

const DOWN = "\u001b[B";
const UP = "\u001b[A";
const ENTER = "\r";
const ESC = "\u001b";
const F2 = "\u001bOQ";
const TEST = { timeout: 8000 };

let sequence = 0;

function request(overrides = {}) {
	sequence += 1;
	return {
		requestId: `req-panel-${sequence}`,
		toolCallId: `call-panel-${sequence}`,
		source: "model-tool",
		sourceLabel: "模型工具 sandbox_request（工具调用 call-panel-1）",
		command: "Set-Content -LiteralPath 'C:\\outside\\a.txt' -Value '第一行'",
		requestReason: "需要写入授权根之外的发布目录",
		cwd: "C:\\work\\root",
		mode: "workspace-write",
		...overrides,
	};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function screenText(harness) {
	return harness.screen().join("\n");
}

/** Wrapping may split a Chinese phrase across bordered screen rows. */
function assertScreenIncludes(screen, expected) {
	const compact = (text) => text.replace(/[\s│]/g, "");
	assert.ok(compact(screen).includes(compact(expected)), `screen did not contain: ${expected}`);
}

/** Screen rows covered by the overlay (so the editor line is not part of the assertion). */
function overlayLines(harness) {
	const bounds = harness.state.handle?.getBounds();
	if (!bounds) return [];
	return harness.rawScreen().slice(bounds.row, bounds.row + bounds.height);
}

function assertOverlayIsYellow(harness) {
	const lines = overlayLines(harness);
	assert.ok(lines.length > 3, "the overlay must be on screen");
	for (const line of lines) {
		assert.ok(hasYellow(line), `overlay line without yellow: ${JSON.stringify(line)}`);
		assert.equal(
			nonYellowText(line),
			"",
			`text outside the approval palette: ${JSON.stringify(nonYellowText(line))}`,
		);
	}
}

async function open(overrides = {}, options = {}) {
	const harness = createHarness({
		width: options.width ?? 78,
		rows: options.rows ?? 28,
		draft: "还没发出去的消息",
	});
	harness.start();
	const awaiting = requestOperationApproval(harness.subject, request(overrides), {
		...(options.signal ? { signal: options.signal } : {}),
	});
	await flush();
	assert.ok(harness.state.panel, "the TUI panel must be the transport in tui mode");
	return { harness, awaiting };
}

/** Always dispose the panel and stop the TUI, whatever the assertions did. */
async function settle(harness, awaiting) {
	try {
		harness.state.panel?.dispose?.();
	} catch {
		/* the panel may already be gone */
	}
	try {
		harness.state.handle?.hide();
	} catch {
		/* the overlay may already be removed */
	}
	harness.stop();
	await Promise.race([Promise.resolve(awaiting).catch(() => undefined), flush()]);
}

async function withApproval(overrides, options, body) {
	const { harness, awaiting } = await open(overrides, options);
	try {
		return await body(harness, awaiting);
	} finally {
		await settle(harness, awaiting);
	}
}

test("the dock shows only the choices and key hints; the request lives in the card", TEST, async () => {
	await withApproval({}, {}, async (harness, awaiting) => {
		const screen = screenText(harness);
		assert.match(screen, /模型正在请求一次工作区外的操作/);
		assert.match(screen, /来源：模型工具 sandbox_request（工具调用 call-panel-1）/);
		assertScreenIncludes(screen, "完整理由、完整命令（原样、未截断）、cwd、模式与超时都在上方的黄色审批卡片里");
		for (const [index, option] of APPROVAL_OPTIONS.entries()) {
			assert.match(screen, new RegExp(`\\[${index + 1}\\] ${option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		}
		assert.match(screen, /↑\/↓ 选择/);
		assert.match(screen, /Enter 确认/);
		assert.match(screen, /1-4 选择/);
		assert.match(screen, /Esc 取消（不执行）/);
		assertScreenIncludes(screen, "F2 隐藏本面板回看对话（再按 F2 返回；此时不会执行）");
		// The full command/reason is deliberately NOT repeated in the dock.
		assert.doesNotMatch(screen, /outside\\a\.txt.*第一行/);
		// No native dialog was used, so RPC-only paths cannot interfere.
		assert.equal(harness.state.selectCalls.length, 0);
		assert.equal(harness.state.inputCalls.length, 0);
		assertOverlayIsYellow(harness);
		harness.press(ESC);
		assert.equal((await awaiting).status, "cancelled");
	});
});

test("every approval element in the dock is yellow, including the selection bar", TEST, async () => {
	await withApproval({}, {}, async (harness, awaiting) => {
		assertOverlayIsYellow(harness);
		const selected = overlayLines(harness).find((line) => line.includes("[1] Yes"));
		assert.ok(selected, "the selected option must be visible");
		assert.ok(selected.includes("\u001b[48;2;255;199;0m"), "the selected row must use the yellow selection bar");
		harness.press(DOWN);
		const second = overlayLines(harness).find((line) => line.includes("> [2] No"));
		assert.ok(second, "the marker must move to the second option");
		assert.equal(harness.state.settled, false);
		harness.press(ESC);
		await awaiting;
	});
});

test("arrows and digits select without deciding; Enter on a reason option then asks for the text", TEST, async () => {
	await withApproval({}, {}, async (harness, awaiting) => {
		harness.press(DOWN);
		harness.press(DOWN);
		assert.match(screenText(harness), /> \[3\] Yes, and reason…/);
		harness.type("4"); // a digit only moves the marker, it never authorizes
		assert.equal(harness.state.settled, false);
		assert.match(screenText(harness), /> \[4\] No, and reason…/);
		harness.press(UP);
		assert.equal(harness.state.settled, false);
		assert.match(screenText(harness), /> \[3\] Yes, and reason…/);
		harness.press(ENTER);
		assert.match(screenText(harness), /本次操作完成后的补充要求/);
		harness.type("完成后解释意图");
		harness.press(ENTER);
		const decision = await awaiting;
		assert.equal(decision.status, "approved");
		assert.equal(decision.option, "Yes, and reason…");
		assert.equal(decision.decisionReason, "完成后解释意图");
	});
});

test("the reason editor accepts Chinese and pasted text and returns the human instruction", TEST, async () => {
	await withApproval({}, {}, async (harness, awaiting) => {
		harness.press(DOWN);
		harness.press(DOWN);
		harness.press(ENTER);
		const reasonScreen = screenText(harness);
		assert.match(reasonScreen, /本次操作完成后的补充要求/);
		assert.match(reasonScreen, /将选择：\[3\] Yes, and reason…/);
		assertScreenIncludes(reasonScreen, "批准本次操作，并填写「本次操作完成后的补充要求」（必填）");
		assert.match(reasonScreen, /Enter 提交 · Esc 取消（不执行）· Backspace 删除 · 支持中文与粘贴/);
		harness.type("不要在C盘操作");
		harness.paste("，改到工作区下");
		assert.match(screenText(harness), /> 不要在C盘操作，改到工作区下/);
		harness.press(ENTER);
		const decision = await awaiting;
		assert.equal(decision.status, "approved");
		assert.equal(decision.option, "Yes, and reason…");
		assert.equal(decision.decisionReason, "不要在C盘操作，改到工作区下");
		assert.match(decision.detail, /用户批准了本次精确命令/);
	});
});

test("a blank or cancelled reason never approves (No, and reason… path)", TEST, async () => {
	for (const scenario of ["blank", "escape"]) {
		await withApproval({}, {}, async (harness, awaiting) => {
			harness.type("4"); // No, and reason…
			harness.press(ENTER);
			assert.match(screenText(harness), /拒绝原因或新的执行方向/);
			assert.match(screenText(harness), /将选择：\[4\] No, and reason…/);
			if (scenario === "escape") harness.press(ESC);
			else harness.press(ENTER); // blank must be refused
			const decision = await awaiting;
			assert.equal(decision.status, "cancelled", scenario);
			assert.equal(decision.decisionReason, undefined);
			assert.match(decision.detail, /为空或取消输入|必填/);
		});
	}
});

test("Esc in the menu cancels without executing and removes every hook", TEST, async () => {
	await withApproval({}, {}, async (harness, awaiting) => {
		harness.press(ESC);
		const decision = await awaiting;
		assert.equal(decision.status, "cancelled");
		assert.match(decision.detail, /ESC/);
		assert.equal(harness.state.widgets.size, 0);
		assert.equal(harness.state.listeners.size, 0);
	});
});

test("F2 hides the dock, lets the editor and the terminal own the keyboard, and comes back pending", TEST, async () => {
	await withApproval({}, {}, async (harness, awaiting) => {
		harness.press(F2);
		assert.equal(harness.state.handle.isHidden(), true, "the overlay must be hidden");
		assert.equal(harness.state.settled, false, "hiding is not an answer");
		const hiddenScreen = screenText(harness);
		assert.doesNotMatch(hiddenScreen, /\[3\] Yes, and reason…/, "the dock must be off screen");
		assert.match(hiddenScreen, /审批待处理/);
		assert.match(hiddenScreen, /按 F2 返回审批面板/);
		assertScreenIncludes(hiddenScreen, "此时不会执行");
		assert.equal(harness.state.widgets.size, 1, "the one-line return hint must be visible");

		// The editor keeps its draft and receives typing while the panel is hidden.
		harness.type("x");
		assert.match(harness.editor.text, /还没发出去的消息x/);
		assert.equal(harness.state.settled, false);

		// Enter while hidden submits editor content; it must not approve anything.
		harness.press(ENTER);
		assert.equal(harness.state.settled, false);
		assert.equal(harness.editor.text, "");

		harness.press(F2);
		assert.equal(harness.state.handle.isHidden(), false);
		assert.equal(harness.state.handle.isFocused(), true);
		assert.equal(harness.state.widgets.size, 0, "the return hint must be cleared");
		assert.match(screenText(harness), /\[1\] Yes/);
		assert.equal(harness.state.settled, false);

		harness.press(ESC);
		assert.equal((await awaiting).status, "cancelled");
	});
});

test("F2 keeps a half-typed reason and returns to the reason editor", TEST, async () => {
	await withApproval({}, {}, async (harness, awaiting) => {
		harness.press(DOWN);
		harness.press(DOWN);
		harness.press(ENTER);
		harness.type("完成后解释");
		harness.press(F2);
		assert.match(screenText(harness), /正在填写理由，已输入的内容保留/);
		harness.press(F2);
		assert.match(screenText(harness), /> 完成后解释/);
		assert.match(screenText(harness), /本次操作完成后的补充要求/);
		harness.type("意图");
		harness.press(ENTER);
		const decision = await awaiting;
		assert.equal(decision.decisionReason, "完成后解释意图");
	});
});

test("an abort settles as cancelled, clears the widget and unregisters the F2 listener", TEST, async () => {
	const controller = new AbortController();
	await withApproval({}, { signal: controller.signal }, async (harness, awaiting) => {
		harness.press(F2);
		assert.equal(harness.state.listeners.size, 1);
		controller.abort();
		await flush();
		const decision = await awaiting;
		assert.equal(decision.status, "cancelled");
		assert.match(decision.detail, /晚到的选择无效/);
		assert.equal(harness.state.widgets.size, 0);
		assert.equal(harness.state.listeners.size, 0);
		assert.equal(harness.state.settled, true);
		// A late Yes cannot turn into a grant: the panel is gone.
		harness.press(ENTER);
		assert.equal(harness.state.settled, true);
	});
});

test("an English approval uses English in the dock, the reason editor and F2, with stable option labels", TEST, async () => {
	await withApproval(
		{ locale: "en", sourceLabel: "Model tool sandbox_request (tool call call-panel-en)" },
		{},
		async (harness, awaiting) => {
			const screen = screenText(harness);
			assert.match(screen, /The model is requesting an operation outside the workspace/);
			assert.match(screen, /Source: Model tool sandbox_request/);
			assertScreenIncludes(screen, "The full reason, full command (verbatim, untruncated), cwd, mode and timeout are in the yellow approval card above");
			for (const option of APPROVAL_OPTIONS) assert.ok(screen.includes(option), option);
			assert.match(screen, /↑\/↓ select · Enter confirm/);
			assert.match(screen, /1-4 to choose/);
			assert.match(screen, /Esc cancel \(nothing runs\)/);
			assertScreenIncludes(screen, "F2 hides this panel so you can read the conversation");
			assert.doesNotMatch(screen, /模型正在请求|来源：|↑\/↓ 选择|隐藏本面板/);

			harness.press(DOWN);
			harness.press(DOWN);
			harness.press(ENTER);
			const reasonScreen = screenText(harness);
			assert.match(reasonScreen, /Requirement to complete after this operation/);
			assert.match(reasonScreen, /Choosing: \[3\] Yes, and reason…/);
			assertScreenIncludes(reasonScreen, "Approve this operation and enter the requirement to complete after it (required)");
			assert.match(reasonScreen, /Enter submit · Esc cancel \(nothing runs\)/);

			harness.press(F2);
			assert.match(screenText(harness), /Approval pending: The model is requesting/);
			assertScreenIncludes(screenText(harness), "press F2 to return to the approval panel · nothing runs yet");
			assert.doesNotMatch(screenText(harness), /审批待处理/);
			harness.press(F2);
			assert.match(screenText(harness), /Requirement to complete after this operation/);

			harness.type("explain the result");
			harness.press(ENTER);
			const decision = await awaiting;
			assert.equal(decision.status, "approved");
			assert.equal(decision.locale, "en");
			assert.equal(decision.decisionReason, "explain the result");
			assert.equal(decision.detail, "The user approved this exact command.");
		},
	);
});

test("a disposed panel fails closed and leaves no hook behind", TEST, async () => {
	await withApproval({}, {}, async (harness, awaiting) => {
		harness.press(F2);
		assert.equal(harness.state.listeners.size, 1);
		harness.state.panel.dispose();
		const decision = await awaiting;
		assert.equal(decision.status, "cancelled");
		assert.equal(harness.state.widgets.size, 0);
		assert.equal(harness.state.listeners.size, 0);
	});
});

test("two concurrent approvals keep their own panel, reason and decision", TEST, async () => {
	const first = await open({ requestId: "req-a", command: "Write-Output 'A'" });
	const second = await open({ requestId: "req-b", command: "Write-Output 'B'" });
	try {
		first.harness.press(DOWN);
		first.harness.press(DOWN);
		first.harness.press(DOWN);
		first.harness.press(ENTER);
		first.harness.type("A 的新方向");
		first.harness.press(ENTER);
		const firstDecision = await first.awaiting;
		assert.equal(firstDecision.status, "declined");
		assert.equal(firstDecision.decisionReason, "A 的新方向");
		// The second panel is untouched and still pending.
		assert.equal(second.harness.state.settled, false);
		assert.match(screenText(second.harness), /\[1\] Yes/);
		second.harness.press(ENTER);
		const secondDecision = await second.awaiting;
		assert.equal(secondDecision.status, "approved");
		assert.equal(secondDecision.decisionReason, undefined);
	} finally {
		await settle(first.harness, first.awaiting);
		await settle(second.harness, second.awaiting);
	}
});

test("a TUI panel that cannot be created falls back to the plain picker, still an explicit answer", TEST, async () => {
	const harness = createHarness({ draft: "draft" });
	try {
		harness.start();
		harness.state.failCustom = true;
		harness.state.selectAnswer = "No";
		const decision = await requestOperationApproval(harness.subject, request());
		assert.equal(decision.status, "declined");
		assert.equal(harness.state.selectCalls.length, 1);
		assert.equal(harness.state.selectCalls[0].title, renderApprovalMessage(request()));
		assert.deepEqual(harness.state.selectCalls[0].choices, [...APPROVAL_OPTIONS]);
		assert.equal(harness.state.selectCalls[0].title.includes("\u001b"), false, "RPC titles carry no ANSI");
	} finally {
		harness.stop();
	}
});

test("rpc mode never opens the TUI panel and keeps the select/input protocol", TEST, async () => {
	const harness = createHarness({ mode: "rpc" });
	try {
		harness.state.selectAnswer = "Yes, and reason…";
		harness.state.inputAnswer = "完成后解释";
		const decision = await requestOperationApproval(harness.subject, request());
		assert.equal(decision.status, "approved");
		assert.equal(decision.decisionReason, "完成后解释");
		assert.equal(harness.state.customCalls.length, 0);
		assert.equal(harness.state.selectCalls.length, 1);
		assert.equal(harness.state.inputCalls.length, 1);
		assert.equal(harness.state.selectCalls[0].title.includes("\u001b"), false);
		assert.equal(harness.state.inputCalls[0].title.includes("\u001b"), false);
	} finally {
		harness.stop();
	}
});

test("canOpenTuiPanel demands tui mode, a UI and all three public APIs", () => {
	const ui = {
		custom: () => {},
		setWidget: () => {},
		onTerminalInput: () => () => {},
	};
	assert.equal(canOpenTuiPanel({ mode: "tui", hasUI: true, ui }), true);
	assert.equal(canOpenTuiPanel({ mode: "rpc", hasUI: true, ui }), false);
	assert.equal(canOpenTuiPanel({ mode: "tui", hasUI: false, ui }), false);
	assert.equal(canOpenTuiPanel({ mode: "tui", hasUI: true, ui: { custom: ui.custom } }), false);
	assert.equal(canOpenTuiPanel({ mode: "tui", hasUI: true, ui: { ...ui, onTerminalInput: undefined } }), false);
});

test("requestTuiPanel reports unavailable instead of throwing when the host rejects custom()", TEST, async () => {
	const harness = createHarness();
	try {
		harness.state.failCustom = true;
		const outcome = await requestTuiPanel(harness.subject, {
			title: "t",
			header: [],
			options: ["a", "b"],
			defaultIndex: 0,
			reasonFor: {},
			panelKey: "k",
			blockedMessage: "m",
		});
		assert.deepEqual(outcome, { kind: "unavailable" });
	} finally {
		harness.stop();
	}
});

test("the dock is width-safe on a narrow terminal with a long header", TEST, async () => {
	await withApproval({}, { width: 34, rows: 30 }, async (harness, awaiting) => {
		for (const line of harness.rawScreen()) {
			assert.ok(visibleWidth(line) <= 34, `line wider than the terminal: ${JSON.stringify(line)}`);
		}
		assertOverlayIsYellow(harness);
		assert.match(screenText(harness), /\[4\] No, and reason…|\[4\]/);
		harness.press(ESC);
		await awaiting;
	});
});

test("cancellation before a delayed component factory opens cannot leave an approval waiting", TEST, async () => {
	const harness = createHarness({ draft: "草稿" });
	const controller = new AbortController();
	const originalCustom = harness.ui.custom;
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	harness.ui.custom = async (...args) => {
		await gate;
		return originalCustom(...args);
	};
	harness.start();
	try {
		const awaiting = requestOperationApproval(harness.subject, request(), { signal: controller.signal });
		await flush();
		controller.abort();
		release();
		assert.equal((await awaiting).status, "cancelled");
		assert.equal(harness.state.listeners.size, 0);
		assert.equal(harness.state.widgets.size, 0);
	} finally {
		harness.state.panel?.dispose();
		harness.stop();
	}
});
