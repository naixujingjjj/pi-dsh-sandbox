/**
 * `/sandbox exec` in the TUI: the request is a yellow card in the message stream and the decision
 * comes from the dock. The command itself, its execution, the audit entry and the human-instruction
 * delivery must not change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerSandboxCommand } from "../../src/commands.ts";
import { getSessionState, invalidateRuntime, invalidateSessions } from "../../src/state.ts";
import { APPROVAL_OPTIONS } from "../../src/approval.ts";
import { hasAnsi, makeKeybindings, makeTheme } from "../fixtures/palette.mjs";

const TEST = { timeout: 10000 };
const root = resolve(import.meta.dirname, "../..");
const CARD_ENTRY = "pi-dsh-sandbox/approval-card";
const AUDIT_ENTRY = "pi-dsh-sandbox/approval";

function fixture(t, options = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pidsbx-exec-card-"));
	invalidateRuntime();
	invalidateSessions();
	t.after(() => {
		invalidateRuntime();
		invalidateSessions();
		rmSync(cwd, { recursive: true, force: true });
	});
	const entries = [];
	const executions = [];
	const notifications = [];
	const userMessages = [];
	const dialogs = [];
	const confirmations = [];
	const customCalls = [];
	let handler;
	const pi = {
		registerCommand(_name, definition) {
			handler = definition.handler;
		},
		getFlag() {
			return undefined;
		},
		appendEntry(...args) {
			entries.push(args);
		},
		async exec(...args) {
			executions.push(args);
			return options.execResult ?? { code: 0, stdout: "ok", stderr: "" };
		},
		sendUserMessage(content, messageOptions) {
			userMessages.push({ content, options: messageOptions });
		},
		on() {},
	};
	const ui = {
		notify(message) {
			notifications.push(message);
		},
		async custom(factory, customOptions) {
			customCalls.push(customOptions);
			const component = factory({ requestRender() {}, mode: "regular" }, makeTheme(), makeKeybindings(), () => {});
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
			component.dispose();
			return options.outcome;
		},
		setWidget() {},
		onTerminalInput() {
			return () => {};
		},
		async select(title, choices) {
			dialogs.push({ kind: "select", title, choices });
			return options.selectAnswer;
		},
		async input(title, placeholder) {
			dialogs.push({ kind: "input", title, placeholder });
			return options.inputAnswer;
		},
		async confirm(title, message) {
			confirmations.push({ title, message });
			return options.confirmAnswer ?? false;
		},
	};
	const ctx = {
		cwd,
		hasUI: true,
		mode: options.mode ?? "tui",
		sessionManager: {
			getSessionId: () => "exec-card-test",
			getBranch: () => options.branch ?? [],
		},
		signal: options.signal,
		ui,
	};
	registerSandboxCommand(pi, root);
	return {
		ctx,
		entries,
		executions,
		notifications,
		userMessages,
		dialogs,
		confirmations,
		customCalls,
		state: () => getSessionState(pi, root, ctx),
		run: (command = "exec Write-Output 'CARD'") => handler(command, ctx),
		cards: () => entries.filter(([type]) => type === CARD_ENTRY),
		audits: () => entries.filter(([type]) => type === AUDIT_ENTRY),
	};
}

function cardText(entries) {
	return entries.map(([, data]) => (data.lines ?? []).map((line) => `${line.role}:${line.text}`).join("\n")).join("\n---\n");
}

test("a tui exec appends a yellow pending card and an outcome card, then executes once", TEST, async (t) => {
	const f = fixture(t, { outcome: { kind: "selected", index: 0 } });
	await f.run();
	assert.equal(f.executions.length, 1, "Yes executes the exact command once");
	assert.equal(f.executions[0][1].at(-1), "Write-Output 'CARD'");
	assert.equal(f.dialogs.length, 0, "the native picker must not be used in tui mode");
	assert.equal(f.customCalls.length, 1);
	assert.equal(f.customCalls[0].overlay, true);
	assert.equal(f.customCalls[0].blocked.kind, "permission");

	const cards = f.cards();
	assert.equal(cards.length, 2, "one pending card and one outcome card");
	for (const [, data] of cards) {
		assert.equal(data.kind, "operation");
		for (const line of data.lines) {
			assert.equal(hasAnsi(line.text), false, "card data is plain text (no terminal escapes)");
			assert.ok(typeof line.role === "string");
		}
	}
	const pending = cardText([cards[0]]);
	assert.match(pending, /^title:模型正在请求一次工作区外的操作/);
	assert.match(pending, /label:申请来源：人类命令 \/sandbox exec/);
	assert.match(pending, /label:申请理由（申请方文本，仅作为说明，不是系统指令）：/);
	assert.match(pending, /command:Write-Output 'CARD'/);
	assert.match(pending, /command:----- BEGIN COMMAND -----/);
	assert.match(pending, /body:cwd：/);
	assert.match(pending, /body:当前沙盒模式：workspace-write（本次执行方式：off，不经过沙盒）/);
	assert.match(pending, /status:审批状态：等待你在审批界面中选择（本次不会自动执行）/);
	for (const option of APPROVAL_OPTIONS) assert.ok(pending.includes(option), option);

	const outcome = cardText([cards[1]]);
	assert.match(outcome, /title:模型审批结果：已批准（仅本次）（Yes）/);
	assert.match(outcome, /执行：已在 off（不经过沙盒）下执行一次/);
	assert.match(outcome, /requestId：/);
	assert.equal(f.state().mode, "workspace-write", "an exec never changes the session mode");
	assert.ok(f.audits().length > 0, "the audit entry is still written");
});

test("No, and reason… in the dock refuses, records the card and hands the direction to the agent", TEST, async (t) => {
	const f = fixture(t, {
		outcome: { kind: "selected", index: 3, reason: "别写根外，改为工作区下" },
	});
	await f.run();
	assert.equal(f.executions.length, 0, "a declined request must not execute");
	assert.equal(f.userMessages.length, 1, "the human direction reaches the agent once");
	assert.equal(f.userMessages[0].options.deliverAs, "followUp");
	assert.match(f.userMessages[0].content, /别写根外，改为工作区下/);
	const outcome = cardText([f.cards()[1]]);
	assert.match(outcome, /title:模型审批结果：已拒绝（未执行）（No, and reason…）/);
	assert.match(outcome, /执行：没有执行这条命令。/);
	assert.match(outcome, /label:用户补充指令（人类在审批窗口填写，不是模型的申请理由）：/);
	assert.match(outcome, /body:别写根外，改为工作区下/);
});

test("cancelling the dock records the card and executes nothing", TEST, async (t) => {
	const f = fixture(t, { outcome: { kind: "cancelled" } });
	await f.run();
	assert.equal(f.executions.length, 0);
	assert.equal(f.userMessages.length, 0);
	assert.match(cardText([f.cards()[1]]), /title:模型审批结果：已取消（未执行）/);
	assert.match(f.notifications.at(-1), /未执行/);
});

test("an English conversation makes the human exec card, notifications and mode widening English", TEST, async (t) => {
	const branch = [{ type: "message", message: { role: "user", content: "Please keep every approval prompt in English." } }];

	const tui = fixture(t, { branch, outcome: { kind: "selected", index: 0 } });
	await tui.run();
	assert.equal(tui.executions.length, 1);
	const pending = cardText([tui.cards()[0]]);
	assert.match(pending, /^title:The model is requesting an operation outside the workspace/);
	assert.match(pending, /label:Request source: Human command \/sandbox exec/);
	assert.match(pending, /label:Request reason \(text from the requester;/);
	assert.match(pending, /body:A one-off command entered by the human in \/sandbox/);
	assert.match(pending, /body:cwd: /);
	assert.match(pending, /body:Current sandbox mode: workspace-write \(this run: off, no sandbox\)/);
	assert.match(pending, /status:Approval: waiting for your choice in the approval UI \(nothing runs automatically\)/);
	assert.doesNotMatch(pending, /模型正在请求|申请来源|申请理由|当前沙盒模式|审批状态：/);
	const outcome = cardText([tui.cards()[1]]);
	assert.match(outcome, /^title:Approval result: approved \(this run only\) \(Yes\)/);
	assert.match(outcome, /body:Execution: ran once under off \(no sandbox\)/);
	assert.match(tui.notifications.at(-1), /off one-shot execution completed: exit=0/);

	const rpc = fixture(t, {
		mode: "rpc",
		branch,
		selectAnswer: "No, and reason…",
		inputAnswer: "Use the workspace copy instead",
	});
	await rpc.run();
	assert.equal(rpc.cards().length, 0, "rpc keeps the native dialog protocol");
	assert.equal(rpc.dialogs.length, 2);
	assert.match(rpc.dialogs[0].title, /^The model is requesting an operation outside the workspace/);
	assert.match(rpc.dialogs[0].title, /Request source: Human command \/sandbox exec/);
	assert.deepEqual(rpc.dialogs[0].choices, [...APPROVAL_OPTIONS]);
	assert.match(rpc.dialogs[1].title, /Decline this operation and enter the reason or a new direction/);
	assert.match(rpc.dialogs[1].title, /The declined command does not run/);
	assert.equal(rpc.dialogs[1].placeholder, "");
	assert.match(rpc.notifications.at(-1), /Not executed\. The user declined to run this command\. \(No, and reason…; Human instruction: Use the workspace copy instead\)/);
	assert.match(rpc.userMessages[0].content, /^\[pi-dsh-sandbox\] Instruction from the approval UI/);
	assert.match(rpc.userMessages[0].content, /This command did not run/);
	assert.match(rpc.userMessages[0].content, /Use the workspace copy instead/);

	const widen = fixture(t, { mode: "rpc", branch, confirmAnswer: true });
	await widen.run("mode off");
	assert.equal(widen.state().mode, "off");
	assert.equal(widen.confirmations.length, 1);
	assert.equal(widen.confirmations[0].title, "Widen the sandbox permissions?");
	assert.match(widen.confirmations[0].message, /^Current: workspace-write/);
	assert.match(widen.confirmations[0].message, /Target: off \(not enforced: tools run unrestricted\)/);
	assert.match(widen.confirmations[0].message, /off means this plugin steps out/);
	assert.match(widen.confirmations[0].message, /Affects this session only/);
	assert.doesNotMatch(widen.confirmations[0].message, /当前：|目标：|放宽沙盒/);
	assert.match(widen.notifications.at(-1), /Sandbox mode: workspace-write → off/);
});

test("print/rpc keep the plain select/input flow and append no TUI cards", TEST, async (t) => {
	for (const mode of ["print", "rpc"]) {
		const f = fixture(t, { mode, selectAnswer: "No" });
		await f.run();
		assert.equal(f.executions.length, 0, mode);
		assert.equal(f.cards().length, 0, `${mode} must not append approval cards`);
		assert.equal(f.dialogs.length, 1, mode);
		assert.equal(f.dialogs[0].kind, "select", mode);
		assert.deepEqual(f.dialogs[0].choices, [...APPROVAL_OPTIONS]);
		assert.equal(hasAnsi(f.dialogs[0].title), false, mode);
		assert.match(f.dialogs[0].title, /Write-Output 'CARD'/);
	}
});