import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import extension from "../../src/index.ts";
import { registerSandboxCommand } from "../../src/commands.ts";
import { getSessionState, invalidateRuntime, invalidateSessions } from "../../src/state.ts";

test("initialization failure blocks tool calls and user shell commands", () => {
	const hooks = new Map();
	extension({
		registerFlag() {},
		registerTool() { throw new Error("registration failed"); },
		on(name, handler) { hooks.set(name, handler); },
	});
	for (const toolName of ["powershell", "bash", "write", "edit", "sandbox_request"]) {
		assert.equal(hooks.get("tool_call")({ toolName }).block, true, toolName);
	}
	assert.equal(hooks.get("tool_call")({ toolName: "read" }), undefined);
	assert.throws(() => hooks.get("user_bash")({ command: "should not run" }), /初始化失败/);
});

test("a late initialization failure still blocks the already-registered sandbox_request", () => {
	const hooks = new Map();
	const registered = [];
	extension({
		registerFlag() {},
		registerTool(definition) { registered.push(definition.name); },
		registerCommand() { throw new Error("late registration failure"); },
		on(name, handler) { hooks.set(name, handler); },
	});
	assert.equal(registered.includes("sandbox_request"), true, registered.join(", "));
	assert.equal(hooks.get("tool_call")({ toolName: "sandbox_request" }).block, true);
	assert.equal(hooks.get("tool_call")({ toolName: "read" }), undefined);
});

test("one-time exec uses the four-option approval, hands the human text to the agent and never changes the session mode", async () => {
	// `src/policy.ts` canonicalizes the root with `realpathSync.native`, and on GitHub's Windows
	// runners TEMP is the 8.3 short form (`C:\Users\RUNNER~1\...`). Resolve the temp directory the
	// same way so the title and the canonical root are compared as one string.
	const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "pidsbx-approval-")));
	let handler;
	const executions = [];
	const audit = [];
	const dialogs = [];
	const notifications = [];
	const selections = [];
	const inputs = [];
	const userMessages = [];
	const pi = {
		registerCommand(_name, definition) { handler = definition.handler; },
		getFlag() { return undefined; },
		appendEntry(...args) { audit.push(args); },
		async exec(...args) { executions.push(args); return { code: 0, stdout: "ok", stderr: "" }; },
		sendUserMessage(content, options) { userMessages.push({ content, options }); },
	};
	const ctx = {
		cwd, hasUI: false,
		sessionManager: { getSessionId: () => "approval-guard-test" },
		ui: {
			notify(message) { notifications.push(message); },
			async select(title, options) {
				dialogs.push({ title, options });
				return selections.shift();
			},
			async input(title) {
				dialogs.push({ title, input: true });
				return inputs.shift();
			},
		},
	};
	const root = resolve(import.meta.dirname, "../..");
	try {
		invalidateRuntime();
		invalidateSessions();
		registerSandboxCommand(pi, root);
		const mode = getSessionState(pi, root, ctx).mode;

		await handler("exec Write-Output 'test'", ctx);
		assert.equal(dialogs.length, 0, "no UI must not open a dialog");
		assert.equal(executions.length, 0);

		ctx.hasUI = true;
		selections.push("No");
		await handler("exec Write-Output 'test'", ctx);
		assert.equal(executions.length, 0);
		assert.equal(userMessages.length, 0, "a plain No carries no instruction, so nothing may start a model turn");
		assert.equal(dialogs[0].options.length, 4);
		assert.deepEqual(dialogs[0].options, ["Yes", "No", "Yes, and reason…", "No, and reason…"]);
		assert.ok(dialogs[0].title.includes("Write-Output 'test'"), "the full command must be shown");
		assert.ok(dialogs[0].title.includes(cwd), "the fixed cwd must be shown");
		assert.match(dialogs[0].title, /off/);
		assert.doesNotMatch(dialogs[0].title, /仅反馈|仅作为反馈|不会影响当前指令|只是意见|审批附言/);

		selections.push("Yes, and reason…");
		inputs.push("");
		await handler("exec Write-Output 'test'", ctx);
		assert.equal(executions.length, 0, "a blank approval reason must not approve");
		assert.equal(userMessages.length, 0, "a cancelled reason must not start a model turn");

		selections.push("Yes, and reason…");
		inputs.push("完成后解释意图和作用");
		await handler("exec Write-Output 'test'", ctx);
		assert.equal(executions.length, 1);
		assert.equal(executions[0][1].at(-1), "Write-Output 'test'");
		assert.equal(executions[0][2].cwd, cwd);
		assert.match(notifications.at(-1), /已作为新的用户消息交给代理继续/);
		assert.match(notifications.at(-1), /exit=0/);
		assert.equal(userMessages.length, 1, "the human requirement must reach the agent exactly once");
		assert.equal(userMessages[0].options.deliverAs, "followUp");
		assert.match(userMessages[0].content, /审批窗口里的补充指令/);
		assert.match(userMessages[0].content, /完成后解释意图和作用/);
		assert.match(userMessages[0].content, /审批结果：Yes, and reason…/);
		assert.match(userMessages[0].content, /执行结果：exit=0/);
		assert.match(userMessages[0].content, /先如实报告这次人工执行的意图、作用与实际结果/);
		assert.match(userMessages[0].content, /不要重新执行这条命令/);
		assert.match(userMessages[0].content, /BEGIN COMMAND -----\nWrite-Output 'test'\n----- END COMMAND/);
		assert.equal(getSessionState(pi, root, ctx).mode, mode);
		assert.equal(audit.length > 0, true);
		assert.equal(audit.every(([type]) => type === "pi-dsh-sandbox/approval"), true);
		assert.equal(audit.some(([, data]) => data.reasonSource === "human-approval-ui"), true);

		// No+text refuses the command and hands the agent a new direction instead.
		selections.push("No, and reason…");
		inputs.push("别写根外，改为工作区下");
		await handler("exec Write-Output 'test'", ctx);
		assert.equal(executions.length, 1, "the declined command must not run");
		assert.equal(userMessages.length, 2);
		assert.match(userMessages[1].content, /这条命令没有执行/);
		assert.match(userMessages[1].content, /新用户指示/);
		assert.match(userMessages[1].content, /别写根外，改为工作区下/);
		assert.match(userMessages[1].content, /sandbox_request/);
		assert.equal(userMessages[1].options.deliverAs, "followUp");

		// A reason from an old approval must never start work in a different session.
		selections.push("No, and reason…");
		inputs.push("old-session direction");
		const originalInput = ctx.ui.input;
		ctx.ui.input = async (...args) => {
			const value = await originalInput(...args);
			ctx.sessionManager.getSessionId = () => "new-session";
			return value;
		};
		const auditCount = audit.length;
		await handler("exec Write-Output 'stale'", ctx);
		assert.equal(executions.length, 1);
		assert.equal(userMessages.length, 2, "an old reason must not be delivered to the new session");
		assert.equal(audit.length, auditCount, "an old decision must not be audited in the new session");
	} finally {
		invalidateRuntime();
		invalidateSessions();
		rmSync(cwd, { recursive: true, force: true });
	}
});
