import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerSandboxRequestTool } from "../../src/tools/sandbox-request.ts";
import { getSessionState, invalidateRuntime, invalidateSessions } from "../../src/state.ts";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = mkdtempSync(join(tmpdir(), "pidsbx-request-"));
const agentDir = join(base, "agent");
const workspace = join(base, "ws");
const outside = join(base, "out");
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(outside, { recursive: true });
// Never let these tests read the real user settings.
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

test.after(() => {
	invalidateRuntime();
	invalidateSessions();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(base, { recursive: true, force: true });
});

/** In-process execution used for the approval/flow tests (no child process needed). */
async function defaultHandler(command, cwd, options) {
	if (command.startsWith("MARK|")) {
		const [, path, ...value] = command.split("|");
		writeFileSync(path, value.join("|"), "utf8");
		return { exitCode: 0 };
	}
	if (command.startsWith("STREAM|")) {
		for (const line of ["第一行", "第二行 中文"]) options.onData(Buffer.from(`${line}\n`));
		return { exitCode: 0 };
	}
	if (command.startsWith("EXIT|")) return { exitCode: Number(command.slice(5)) };
	return { exitCode: 0 };
}

function setup({
	hasUI = true,
	select = async () => undefined,
	input = async () => undefined,
	appendEntry,
	sessionId = "request-test",
	cwd = workspace,
	operations,
	native = false,
	branch = [],
} = {}) {
	invalidateRuntime();
	invalidateSessions();
	const tools = new Map();
	const audit = [];
	const notifications = [];
	const executed = [];
	const pi = {
		registerTool(definition) { tools.set(definition.name, definition); },
		registerFlag() {},
		registerCommand() {},
		on() {},
		getFlag() { return undefined; },
		getSettings() { return {}; },
		appendEntry(type, data) {
			if (appendEntry) appendEntry(type, data, audit.length);
			audit.push({ type, data });
		},
	};
	const baseOperations =
		operations ??
		(native
			? undefined
			: () => ({
				async exec(command, cwd, options) {
					return defaultHandler(command, cwd, options);
				},
			}));
	const createOperations = baseOperations
		? () => {
			const inner = baseOperations();
			return {
				async exec(command, cwd, options) {
					executed.push({ command, cwd });
					return inner.exec(command, cwd, options);
				},
			};
		}
		: undefined;
	registerSandboxRequestTool(pi, pluginRoot, createOperations ? { createOperations } : {});
	const ctx = {
		cwd,
		hasUI,
		mode: "print",
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => cwd,
			getSessionFile: () => undefined,
			getSessionDir: () => base,
			getLeafId: () => null,
			getBranch: () => branch,
			getEntries: () => [],
		},
		ui: {
			select,
			input,
			notify(message) { notifications.push(message); },
		},
		signal: undefined,
	};
	return { definition: tools.get("sandbox_request"), pi, ctx, audit, notifications, executed };
}

function call(definition, params, ctx, signal) {
	return definition.execute("tool-call-1", params, signal, undefined, ctx);
}

function marker(name) {
	return join(outside, name);
}

function mark(path, value = "X") {
	return `MARK|${path}|${value}`;
}

function written(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

test("invalid or empty parameters are refused before any dialog or execution", async () => {
	const cases = [
		[{}, /command/],
		[{ command: "", reason: "r" }, /command/],
		[{ command: "   ", reason: "r" }, /command/],
		[{ command: "Write-Output 'x'", reason: "" }, /reason/],
		[{ command: "Write-Output 'x'", reason: "  " }, /reason/],
		[{ command: "Write-Output 'x'", reason: "r", timeout: 0 }, /timeout/],
		[{ command: "Write-Output 'x'", reason: "r", timeout: -1 }, /timeout/],
		[{ command: "Write-Output 'x'", reason: "r", timeout: Number.NaN }, /timeout/],
		[{ command: "Write-Output 'x'", reason: "r", timeout: 601 }, /timeout/],
		[{ command: "Write-Output 'x'", reason: "r", timeout: "5" }, /timeout/],
	];
	for (const [params, pattern] of cases) {
		let dialogs = 0;
		const { definition, ctx, executed } = setup({
			select: async () => { dialogs += 1; return "Yes"; },
		});
		const result = await call(definition, params, ctx);
		assert.equal(result.isError, true, JSON.stringify(params));
		assert.match(result.content[0].text, pattern);
		assert.equal(dialogs, 0);
		assert.equal(executed.length, 0);
	}
});

test("no UI refuses a model request without executing", async () => {
	const target = marker("no-ui.txt");
	const { definition, ctx, executed } = setup({ hasUI: false, select: async () => "Yes" });
	const result = await call(definition, { command: mark(target, "NO"), reason: "test" }, ctx);
	assert.equal(result.isError, true);
	assert.equal(result.details.decision, "no-ui");
	assert.match(result.content[0].text, /hasUI=false/);
	assert.match(result.content[0].text, /子代理/);
	assert.equal(executed.length, 0);
	assert.equal(existsSync(target), false);
});

test("No and No-with-reason decline without executing; the text is a new user direction", async () => {
	const plainTarget = marker("declined.txt");
	{
		const { definition, ctx, audit, executed } = setup({ select: async () => "No" });
		const result = await call(definition, { command: mark(plainTarget, "NO"), reason: "test" }, ctx);
		assert.equal(result.isError, true);
		assert.equal(result.details.decision, "declined");
		assert.equal(result.details.executed, false);
		assert.equal(result.details.userInstruction, undefined);
		assert.equal(executed.length, 0);
		assert.equal(existsSync(plainTarget), false);
		assert.equal(audit.length, 1);
		assert.equal(audit[0].type, "pi-dsh-sandbox/approval");
		assert.equal(audit[0].data.phase, "decision");
		assert.equal(audit[0].data.decision, "declined");
	}

	const reasonTarget = marker("declined-reason.txt");
	{
		const direction = "别写根外，改为工作区下";
		const { definition, ctx, audit, executed } = setup({
			select: async () => "No, and reason…",
			input: async () => direction,
		});
		const command = mark(reasonTarget, "NO");
		const result = await call(definition, { command, reason: "test" }, ctx);
		assert.equal(result.isError, true);
		assert.equal(result.details.decision, "declined");
		assert.equal(result.details.executed, false);
		assert.equal(result.details.decisionReason, direction);
		assert.equal(result.details.userInstruction, direction);
		assert.equal(result.details.reasonSource, "human-approval-ui");
		assert.equal(result.details.continuation, "replan-from-user-direction");
		const text = result.content.map((block) => block.text ?? "").join("\n");
		assert.match(text, /用户补充指令（请在当前任务中执行）/);
		assert.match(text, /别写根外，改为工作区下/);
		assert.match(text, /来源：人类在审批窗口里填写/);
		assert.match(text, /不要重新提交被拒绝的这条命令/);
		assert.match(text, /按上面的新方向重新规划/);
		assert.match(text, /sandbox_request/);
		assert.doesNotMatch(text, /仅反馈|仅作为反馈|不会影响当前指令|只是意见/);
		assert.equal(executed.length, 0, "the declined command must never be executed");
		assert.equal(existsSync(reasonTarget), false);
		assert.equal(audit[0].data.decisionReason, direction);
		assert.equal(audit[0].data.reasonSource, "human-approval-ui");
	}
});

test("Yes executes the exact captured command once in the canonical root and leaves the mode unchanged", async () => {
	const target = marker("approved.txt");
	const { definition, ctx, executed } = setup({ select: async () => "Yes" });
	const command = mark(target, "EXACT");
	const before = getSessionState({ getFlag: () => undefined }, pluginRoot, ctx).mode;
	const result = await call(definition, { command, reason: "一次性发布" }, ctx);
	assert.equal(result.isError, undefined, JSON.stringify(result.content));
	assert.equal(result.details.decision, "approved");
	assert.equal(result.details.executed, true);
	assert.equal(result.details.exitCode, 0);
	assert.equal(executed.length, 1, "exactly one execution");
	assert.equal(executed[0].command, command, "the exact captured command must reach the operations");
	assert.equal(executed[0].cwd, workspace, "the operations must be pinned to the canonical root");
	assert.equal(written(target), "EXACT");
	assert.match(result.content[0].text, /审批通过/);
	assert.match(result.content[0].text, /仅本次/);
	assert.equal(
		getSessionState({ getFlag: () => undefined }, pluginRoot, ctx).mode,
		before,
		"the approved request must not change the mode",
	);
});

test("Yes-with-reason executes the original command once and carries the human requirement into the model context", async () => {
	const target = marker("approved-reason.txt");
	const requirement = "完成后解释意图和作用";
	const { definition, ctx, audit, executed } = setup({
		select: async () => "Yes, and reason…",
		input: async () => requirement,
	});
	const command = mark(target, "ORIGINAL");
	const result = await call(definition, { command, reason: "需要写入根外目录" }, ctx);
	assert.equal(result.isError, undefined);
	assert.equal(result.details.decision, "approved");
	assert.equal(result.details.decisionReason, requirement);
	// The instruction must be in the content, in structured details and marked as a continuation.
	const text = result.content.map((block) => block.text ?? "").join("\n");
	assert.match(text, /用户补充指令（请在本次操作完成后执行）/);
	assert.match(text, /完成后解释意图和作用/);
	assert.match(text, /先如实报告本次操作的执行事实/);
	assert.match(text, /再完成上面这条补充要求/);
	assert.doesNotMatch(text, /仅反馈|仅作为反馈|不会影响当前指令|只是意见|审批附言/);
	assert.equal(result.details.userInstruction, requirement);
	assert.equal(result.details.reasonSource, "human-approval-ui");
	assert.equal(result.details.continuation, "complete-user-requirement");
	assert.equal(executed.length, 1, "the approved command must run exactly once");
	assert.equal(executed[0].command, command, "the human text must not rewrite the command");
	assert.equal(written(target), "ORIGINAL");
	assert.equal(audit.at(-1).data.phase, "result");
	assert.equal(audit.at(-1).data.executed, true);
	assert.equal(audit.at(-1).data.exitCode, 0);
	assert.equal(audit[0].data.reasonSource, "human-approval-ui");
	assert.equal(audit[0].data.decisionReason, requirement);
});

test("a real tool request takes its UI language from the current user branch, not from tool args", async () => {
	const branch = [
		{ type: "message", message: { role: "user", content: "请先检查工作区" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Sure, I can answer in English." }] } },
		{ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "English output" }], details: {} } },
		{ type: "message", message: { role: "user", content: "Please ask for approval in English from now on." } },
	];
	const dialogs = [];
	const requirement = "Explain the result after it finishes";
	const { definition, ctx, audit, executed } = setup({
		branch,
		select: async (title, options) => { dialogs.push({ kind: "select", title, options }); return "Yes, and reason…"; },
		input: async (title, placeholder) => { dialogs.push({ kind: "input", title, placeholder }); return requirement; },
	});
	assert.deepEqual(Object.keys(definition.parameters.properties), ["command", "reason", "timeout"], "the model cannot pass a locale");
	const command = "EXIT|0";
	const reason = "unrestricted request reason";
	const result = await call(definition, { command, reason }, ctx);
	assert.equal(result.isError, undefined);
	assert.equal(result.details.decision, "approved");
	assert.equal(result.details.executed, true);
	assert.equal(result.details.locale, "en", "the tool result carries the captured locale");
	assert.equal(result.details.decisionReason, requirement);
	assert.equal(result.details.source, "model-tool");
	assert.equal(executed[0].command, command, "the approved command stays byte-identical");

	assert.equal(dialogs.length, 2);
	assert.match(dialogs[0].title, /^The model is requesting an operation outside the workspace/);
	assert.match(dialogs[0].title, /Request source: Model tool sandbox_request \(tool call tool-call-1\)/);
	assert.match(dialogs[0].title, /Request reason \(text from the requester;/);
	assert.match(dialogs[0].title, /Full command \(verbatim, not truncated\):/);
	assert.match(dialogs[0].title, /Current sandbox mode: workspace-write \(this run: off, no sandbox\)/);
	assert.doesNotMatch(dialogs[0].title, /模型正在请求|申请来源|申请理由|完整命令/);
	assert.deepEqual(dialogs[0].options, ["Yes", "No", "Yes, and reason…", "No, and reason…"]);
	assert.match(dialogs[1].title, /Approve this operation and enter the requirement to complete after it/);
	assert.match(dialogs[1].title, /It never rewrites the command shown above/);
	assert.equal(dialogs[1].placeholder, "", "the placeholder stays empty (0.3.1 behavior)");

	const text = result.content.map((block) => block.text ?? "").join("\n");
	assert.match(text, /\[sandbox_request\] Approved: Yes, and reason…/);
	assert.match(text, /Human instruction \(complete it after this operation\)/);
	assert.match(text, /Explain the result after it finishes/);
	assert.match(text, /First report what actually happened/);
	assert.equal(audit[0].data.locale, "en");
});

test("Chinese remains the default for a branch with no decidable user message", async () => {
	const branch = [
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Please answer in English." }] } },
		{ type: "message", message: { role: "user", content: "123" } },
	];
	const dialogs = [];
	const { definition, ctx } = setup({
		branch,
		select: async (title) => { dialogs.push(title); return "No"; },
	});
	const result = await call(definition, { command: "EXIT|0", reason: "test" }, ctx);
	assert.equal(result.details.locale, "zh");
	assert.match(dialogs[0], /^模型正在请求一次工作区外的操作/);
	assert.match(dialogs[0], /申请来源：模型工具 sandbox_request/);
});

test("the tool prompt guidelines tell the model what both reason options mean", () => {
	const { definition } = setup();
	const guidelines = (definition.promptGuidelines ?? []).join("\n");
	assert.match(guidelines, /No, and reason…/);
	assert.match(guidelines, /新用户指示/);
	assert.match(guidelines, /不要重新提交同一条命令/);
	assert.match(guidelines, /Yes, and reason…/);
	assert.match(guidelines, /先如实报告执行事实/);
	assert.match(guidelines, /再完成用户填写的补充要求/);
	assert.match(guidelines, /不要把它拼进 PowerShell/);
	assert.doesNotMatch(guidelines, /审批意见只是人类的反馈|仅反馈|不会改写你提交的命令/);
});

test("an approved command that fails to start still carries the human requirement", async () => {
	const target = marker("approved-boom.txt");
	const requirement = "完成后解释意图和作用";
	const { definition, ctx, executed } = setup({
		select: async () => "Yes, and reason…",
		input: async () => requirement,
		operations: () => ({
			async exec() {
				throw new Error("spawn EPERM");
			},
		}),
	});
	const result = await call(definition, { command: mark(target, "NO"), reason: "test" }, ctx);
	assert.equal(result.isError, true);
	assert.equal(result.details.executed, true);
	assert.match(result.content.map((block) => block.text ?? "").join("\n"), /spawn EPERM/);
	const text = result.content.map((block) => block.text ?? "").join("\n");
	assert.match(text, /用户补充指令（请在本次操作完成后执行）/);
	assert.match(text, /执行没有正常完成/);
	assert.match(text, /完成后解释意图和作用/);
	assert.equal(result.details.continuation, "complete-user-requirement");
	assert.equal(result.details.userInstruction, requirement);
	assert.equal(executed.length, 1);
	assert.equal(existsSync(target), false);
});

test("a cancelled or blank approval reason never turns a Yes into an execution", async () => {
	for (const answer of [undefined, "", "   "]) {
		const target = marker("blank-reason.txt");
		const { definition, ctx, executed } = setup({
			select: async () => "Yes, and reason…",
			input: async () => answer,
		});
		const result = await call(definition, { command: mark(target, "NO"), reason: "test" }, ctx);
		assert.equal(result.isError, true);
		assert.equal(result.details.decision, "cancelled");
		assert.equal(result.details.executed, false);
		assert.match(result.content[0].text, /原因必填|为空/);
		assert.equal(executed.length, 0);
		assert.equal(existsSync(target), false);
	}
});

test("pre-aborted and mid-dialog aborts refuse execution (late Yes is invalid)", async () => {
	const preTarget = marker("pre-aborted.txt");
	{
		const controller = new AbortController();
		controller.abort();
		let dialogs = 0;
		const { definition, ctx, executed } = setup({ select: async () => { dialogs += 1; return "Yes"; } });
		const result = await call(definition, { command: mark(preTarget, "NO"), reason: "test" }, ctx, controller.signal);
		assert.equal(result.isError, true);
		assert.equal(result.details.decision, "cancelled");
		assert.equal(dialogs, 0);
		assert.equal(executed.length, 0);
		assert.equal(existsSync(preTarget), false);
	}

	const midTarget = marker("mid-aborted.txt");
	{
		const controller = new AbortController();
		const { definition, ctx, executed } = setup({
			select: async () => {
				controller.abort();
				return "Yes";
			},
		});
		const result = await call(definition, { command: mark(midTarget, "NO"), reason: "test" }, ctx, controller.signal);
		assert.equal(result.isError, true);
		assert.equal(result.details.decision, "cancelled");
		assert.match(result.content[0].text, /晚到/);
		assert.equal(executed.length, 0);
		assert.equal(existsSync(midTarget), false);
	}
});

test("a session switch or /reload during approval invalidates the grant", async () => {
	for (const invalidate of [invalidateSessions, invalidateRuntime]) {
		const target = marker(`stale-${invalidate.name}.txt`);
		let once = true;
		const { definition, ctx, executed } = setup({
			select: async () => {
				if (once) {
					once = false;
					invalidate();
				}
				return "Yes";
			},
		});
		const result = await call(definition, { command: mark(target, "NO"), reason: "test" }, ctx);
		assert.equal(result.isError, true);
		assert.equal(result.details.executed, false);
		assert.match(result.content[0].text, /会话、授权根或扩展运行时已变化|作废/);
		assert.equal(executed.length, 0);
		assert.equal(existsSync(target), false);
	}
});

test("audit failures are fail-closed before execution and reported after execution", async () => {
	const beforeTarget = marker("audit-before.txt");
	{
		const { definition, ctx, executed } = setup({
			select: async () => "Yes",
			appendEntry() { throw new Error("disk full"); },
		});
		const result = await call(definition, { command: mark(beforeTarget, "NO"), reason: "test" }, ctx);
		assert.equal(result.isError, true);
		assert.equal(result.details.executed, false);
		assert.match(result.content[0].text, /审计.*失败|disk full/);
		assert.equal(executed.length, 0);
		assert.equal(existsSync(beforeTarget), false);
	}

	const afterTarget = marker("audit-after.txt");
	{
		const { definition, ctx } = setup({
			select: async () => "Yes",
			appendEntry(_type, data, index) {
				if (index === 1) throw new Error("late audit failure");
			},
		});
		const result = await call(definition, { command: mark(afterTarget, "DONE"), reason: "test" }, ctx);
		assert.equal(result.details.executed, true);
		assert.equal(written(afterTarget), "DONE");
		assert.match(result.content.map((block) => block.text ?? "").join("\n"), /审计写入失败（命令已在 off 下执行）/);
	}
});

test("a mode change during approval invalidates the pending request", async () => {
	let context;
	const f = setup({ select: async () => {
		getSessionState(context.pi, pluginRoot, context.ctx).mode = "read-only";
		return "Yes";
	} });
	context = f;
	const result = await call(f.definition, { command: "EXIT|0", reason: "test" }, f.ctx);
	assert.equal(result.details.executed, false);
	assert.equal(result.details.decision, "cancelled");
	assert.equal(f.executed.length, 0);
});

test("invalid sandbox configuration blocks a request before asking or executing", async () => {
	let dialogs = 0;
	const f = setup({ select: async () => { dialogs += 1; return "Yes"; } });
	getSessionState(f.pi, pluginRoot, f.ctx).runtime.configError = new Error("invalid config");
	const result = await call(f.definition, { command: "EXIT|0", reason: "test" }, f.ctx);
	assert.equal(result.details.executed, false);
	assert.equal(result.details.decision, "error");
	assert.equal(dialogs, 0);
	assert.equal(f.executed.length, 0);
});

test("a cancelled pending tool request never executes when a late approval arrives", async () => {
	let release;
	const controller = new AbortController();
	const f = setup({ select: () => new Promise((resolve) => { release = resolve; }) });
	const running = call(f.definition, { command: "EXIT|0", reason: "test" }, f.ctx, controller.signal);
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	const result = await running;
	assert.equal(result.details.executed, false);
	assert.equal(result.details.decision, "cancelled");
	release("Yes");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.executed.length, 0);
});

test("audit entries carry hashes and status, never the raw command or output", async () => {
	const target = marker("audit-shape.txt");
	const command = mark(target, "SECRET-CONTENT");
	const { definition, ctx, audit } = setup({ select: async () => "Yes" });
	await call(definition, { command, reason: "secret request reason" }, ctx);
	assert.equal(audit.length, 2);
	const serialized = JSON.stringify(audit);
	assert.equal(serialized.includes(command), false, "the raw command must not be duplicated into the audit");
	assert.equal(serialized.includes("SECRET-CONTENT"), false);
	assert.equal(serialized.includes("secret request reason"), false);
	const expected = createHash("sha256").update(command, "utf8").digest("hex");
	assert.equal(audit[0].data.commandHash, expected);
	assert.match(audit[0].data.requestReasonHash, /^[a-f0-9]{64}$/);
	assert.match(audit[0].data.requestId, /^[0-9a-f-]{36}$/);
	assert.equal(audit[1].data.requestId, audit[0].data.requestId);
});

test("concurrent requests keep their own command, cwd and opinion", async () => {
	const targetA = marker("concurrent-a.txt");
	const targetB = marker("concurrent-b.txt");
	const commandA = mark(targetA, "A");
	const commandB = mark(targetB, "B");
	const make = (command, sessionId, decision, cwd) =>
		setup({
			sessionId,
			cwd,
			select: async (title) => (title.includes(command) ? decision : undefined),
			input: async () => (decision.startsWith("Yes") ? `${sessionId} 批准意见` : `${sessionId} 拒绝意见`),
		});
	const a = make(commandA, "session-a", "Yes, and reason…", workspace);
	const b = make(commandB, "session-b", "No, and reason…", outside);
	const [resultA, resultB] = await Promise.all([
		call(a.definition, { command: commandA, reason: "A" }, a.ctx),
		call(b.definition, { command: commandB, reason: "B" }, b.ctx),
	]);
	assert.equal(resultA.details.decision, "approved");
	assert.equal(resultA.details.decisionReason, "session-a 批准意见");
	assert.equal(resultB.details.decision, "declined");
	assert.equal(resultB.details.decisionReason, "session-b 拒绝意见");
	assert.equal(a.executed.length, 1);
	assert.equal(a.executed[0].command, commandA);
	assert.equal(a.executed[0].cwd, workspace);
	assert.equal(b.executed.length, 0, "the declined request must not be executed by the other approval");
	assert.equal(written(targetA), "A");
	assert.equal(existsSync(targetB), false);
	assert.match(resultA.content.map((block) => block.text ?? "").join("\n"), /session-a 批准意见/);
	assert.match(resultB.content.map((block) => block.text ?? "").join("\n"), /session-b 拒绝意见/);
	assert.equal(resultA.details.continuation, "complete-user-requirement");
	assert.equal(resultB.details.continuation, "replan-from-user-direction");
	assert.notEqual(resultA.details.requestId, resultB.details.requestId);
});

test("streaming output from the operations reaches the tool result", async () => {
	const { definition, ctx } = setup({ select: async () => "Yes" });
	const updates = [];
	const result = await definition.execute("tool-call-stream", { command: "STREAM|", reason: "stream" }, undefined, (update) => updates.push(update), ctx);
	assert.equal(result.isError, undefined);
	const text = result.content.map((block) => block.text ?? "").join("\n");
	assert.match(text, /第一行/);
	assert.match(text, /第二行 中文/);
	assert.equal(updates.length > 0, true, "onUpdate must receive partial output");
});

test("a non-zero exit code is preserved in details and the result stays an error", async () => {
	const { definition, ctx } = setup({ select: async () => "Yes" });
	const result = await call(definition, { command: "EXIT|42", reason: "exit" }, ctx);
	assert.equal(result.isError, true);
	assert.equal(result.details.executed, true);
	assert.equal(result.details.exitCode, 42);
	assert.match(result.content.map((block) => block.text ?? "").join("\n"), /exited with code 42/i);
});
