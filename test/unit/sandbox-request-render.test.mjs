/**
 * The `sandbox_request` tool row: the yellow request card (renderCall) and the result card.
 *
 * Rendering is a pure function of the tool arguments, the live request facts and the tool result, so
 * these tests need no TUI loop. They check that the card carries the complete request, that the row
 * stays yellow, and that a custom result renderer does not cost the user the command output.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Container } from "@earendil-works/pi-tui";
import { registerSandboxRequestTool } from "../../src/tools/sandbox-request.ts";
import { APPROVAL_OPTIONS } from "../../src/approval.ts";
import { clearLiveApprovals, registerLiveApproval, restoreHistoricalApprovalLocales, updateLiveApprovalPhase } from "../../src/tui/live.ts";
import { hasYellow, makeTheme, nonYellowText, stripAnsi, visibleWidth } from "../fixtures/palette.mjs";

const TEST = { timeout: 10000 };
const theme = makeTheme();

function definition() {
	const tools = new Map();
	const pi = {
		registerTool: (tool) => tools.set(tool.name, tool),
		registerFlag() {},
		registerCommand() {},
		on() {},
		getFlag() {},
		getSettings() {
			return {};
		},
		appendEntry() {},
	};
	registerSandboxRequestTool(pi, "F:\\placeholder", { createOperations: () => ({}) });
	return tools.get("sandbox_request");
}

const COMMAND = "Set-Content -LiteralPath 'C:\\outside\\发布.txt' -Value '第一行' -Encoding UTF8";
const REASON = "需要写入授权根之外的发布目录";

function liveRequest(overrides = {}) {
	return {
		requestId: "req-render-1",
		toolCallId: "call-render-1",
		source: "model-tool",
		sourceLabel: "模型工具 sandbox_request（工具调用 call-render-1）",
		command: COMMAND,
		requestReason: REASON,
		cwd: "C:\\work\\根 目录",
		mode: "workspace-write",
		timeoutSeconds: 90,
		...overrides,
	};
}

function context(overrides = {}) {
	return {
		args: { command: COMMAND, reason: REASON, timeout: 90 },
		toolCallId: "call-render-1",
		cwd: "C:\\work\\根 目录",
		keyHint: (keybinding, description) => `[${keybinding}:${description}]`,
		invalidate() {},
		lastComponent: undefined,
		state: {},
		...overrides,
	};
}

function renderedText(component, width = 90) {
	const lines = component.render(width);
	return { lines, text: lines.map((line) => stripAnsi(line)).join("\n") };
}

test("the call row renders the complete request as one yellow card with the pending state", TEST, () => {
	clearLiveApprovals();
	registerLiveApproval(liveRequest());
	const tool = definition();
	assert.equal(tool.renderShell, "self", "the row must render its own frame, not a themed tool shell");
	const component = tool.renderCall({ command: COMMAND, reason: REASON, timeout: 90 }, theme, context());
	const { lines, text } = renderedText(component, 90);
	assert.match(text, /^─+\n▏ 模型正在请求一次工作区外的操作/m);
	assert.ok(text.includes(COMMAND), "the full command must be shown");
	assert.ok(text.includes(REASON));
	assert.match(text, /cwd：C:\\work\\根 目录/);
	assert.match(text, /当前沙盒模式：workspace-write（本次执行方式：off，不经过沙盒）/);
	assert.match(text, /超时：90 秒（超时会杀掉命令进程树）/);
	assert.match(text, /审批状态：等待你在下方黄色审批面板中选择（本次不会自动执行）/);
	assert.match(text, /选项：Yes · No · Yes, and reason… · No, and reason…/);
	for (const option of APPROVAL_OPTIONS) assert.ok(text.includes(option), option);
	for (const line of lines) {
		assert.ok(hasYellow(line), "the whole row must be yellow");
		assert.equal(nonYellowText(line), "", `non-yellow text: ${JSON.stringify(nonYellowText(line))}`);
		assert.equal(visibleWidth(line), 90, "the card must fill exactly the requested width");
	}
});

test("a tool row created before execute refreshes when the captured request arrives", TEST, () => {
	clearLiveApprovals();
	const tool = definition();
	const args = { command: COMMAND, reason: REASON, timeout: 90 };
	let component;
	let refreshes = 0;
	const ctx = context({ invalidate() {
		refreshes += 1;
		component = tool.renderCall(args, theme, ctx);
	} });
	component = tool.renderCall(args, theme, ctx);
	assert.doesNotMatch(renderedText(component).text, /cwd：/);
	registerLiveApproval(liveRequest());
	assert.equal(refreshes, 1);
	assert.match(renderedText(component).text, /cwd：C:\\work\\根 目录/);
	assert.match(renderedText(component).text, /等待你在下方黄色审批面板中选择/);
	updateLiveApprovalPhase(liveRequest(), "declined");
	assert.equal(refreshes, 2);
	assert.doesNotMatch(renderedText(component).text, /等待你在下方黄色审批面板中选择/);
});

test("the call card drops the pending line once the request is settled but keeps the captured facts", TEST, () => {
	clearLiveApprovals();
	const request = liveRequest();
	registerLiveApproval(request);
	updateLiveApprovalPhase(request, "approved");
	const tool = definition();
	const { text } = renderedText(tool.renderCall({ command: COMMAND, reason: REASON }, theme, context()));
	assert.doesNotMatch(text, /等待你在下方黄色审批面板中选择/);
	assert.match(text, /cwd：C:\\work\\根 目录/);
	assert.match(text, /当前沙盒模式：workspace-write/);
});

test("a call row restored from session history does not invent cwd/mode facts", TEST, () => {
	clearLiveApprovals();
	const tool = definition();
	const { text } = renderedText(tool.renderCall({ command: COMMAND, reason: REASON }, theme, context()));
	assert.match(text, /历史记录：本次审批的 cwd、模式与超时见下面紧接的结果卡片/);
	assert.doesNotMatch(text, /当前沙盒模式/);
	assert.ok(text.includes(COMMAND));
});

test("the result row keeps the approval outcome and still shows the command output", TEST, () => {
	clearLiveApprovals();
	const tool = definition();
	const output = Array.from({ length: 14 }, (_, index) => `行 ${index + 1}`).join("\n");
	const result = {
		content: [
			{
				type: "text",
				text: [
					"[sandbox_request] 审批通过：Yes。",
					"执行方式：off（不经过沙盒），仅本次；cwd=C:\\work；会话模式保持 workspace-write。",
					"本次操作的执行结果见下方；请处理随结果返回的用户补充指令。",
				].join("\n"),
			},
			{ type: "text", text: output },
		],
		details: {
			requestId: "req-render-1",
			toolCallId: "call-render-1",
			source: "model-tool",
			cwd: "C:\\work\\根 目录",
			mode: "workspace-write",
			decision: "approved",
			option: "Yes",
			executed: true,
			exitCode: 0,
		},
	};
	const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context());
	assert.ok(collapsed instanceof Container, "the result must combine the card and the output");
	const collapsedLines = collapsed.render(90);
	const collapsedText = collapsedLines.map((line) => stripAnsi(line)).join("\n");
	assert.match(collapsedText, /模型审批结果：已批准（仅本次）（Yes）/);
	assert.match(collapsedText, /已在 off（不经过沙盒）下执行一次，exit=0/);
	// The output is present (10-line preview) and the self-authored summary is not repeated.
	assert.match(collapsedText, /行 1\s*\n/);
	assert.match(collapsedText, /行 10/);
	assert.doesNotMatch(collapsedText, /行 11/);
	assert.match(collapsedText, /more lines/);
	assert.match(collapsedText, /app\.tools\.expand:to expand/);
	assert.doesNotMatch(collapsedText, /审批通过：Yes。/, "the tool's own summary line is not duplicated");
	assert.doesNotMatch(collapsedText, /本次操作的执行结果见下方/, "the tool's own summary line is not duplicated");
	for (const line of collapsedLines.slice(0, 4)) {
		assert.equal(nonYellowText(line), "", "the result card itself must stay yellow");
	}

	const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme, context());
	const expandedText = expanded.render(90).map((line) => stripAnsi(line)).join("\n");
	assert.match(expandedText, /行 14/);
	assert.doesNotMatch(expandedText, /more lines/);
});

test("a declined and an errored result card state the outcome without claiming execution", TEST, () => {
	clearLiveApprovals();
	const tool = definition();
	const declined = tool.renderResult(
		{
			content: [{ type: "text", text: "未执行。用户拒绝执行本次命令。" }],
			details: {
				requestId: "req-2",
				cwd: "C:\\work",
				mode: "workspace-write",
				decision: "declined",
				option: "No, and reason…",
				decisionReason: "别写根外，改为工作区下",
				executed: false,
			},
		},
		{ expanded: false, isPartial: false },
		theme,
		context(),
	);
	const text = declined.render(80).map((line) => stripAnsi(line)).join("\n");
	assert.match(text, /模型审批结果：已拒绝（未执行）（No, and reason…）/);
	assert.match(text, /执行：没有执行这条命令。/);
	assert.match(text, /用户补充指令（人类在审批窗口填写，不是模型的申请理由）：/);
	assert.match(text, /别写根外，改为工作区下/);
	assert.doesNotMatch(text, /审批通过/);

	const errored = tool.renderResult(
		{
			content: [{ type: "text", text: "未执行：配置错误" }],
			details: { decision: "error", executed: false, executionError: "配置错误", auditError: "磁盘满了" },
		},
		{ expanded: false, isPartial: false },
		theme,
		context(),
	);
	const erroredText = errored.render(80).map((line) => stripAnsi(line)).join("\n");
	assert.match(erroredText, /审批失败（未执行，fail-closed）/);
	assert.match(erroredText, /错误：配置错误/);
	assert.match(erroredText, /警告：审计记录写入失败：磁盘满了/);
});

test("a live English request renders its whole card in English and keeps the four stable options", TEST, () => {
	clearLiveApprovals();
	registerLiveApproval(liveRequest({
		locale: "en",
		sourceLabel: "Model tool sandbox_request (tool call call-render-1)",
	}));
	const tool = definition();
	const { text } = renderedText(tool.renderCall({ command: COMMAND, reason: REASON, timeout: 90 }, theme, context()));
	assert.match(text, /^─+\n▏ The model is requesting an operation outside the workspace/m);
	assert.match(text, /Request source: Model tool sandbox_request/);
	assert.match(text, /Request reason \(text from the requester;/);
	assert.match(text, /Full command:/);
	assert.match(text, /cwd: C:\\work\\根 目录/);
	assert.match(text, /Current sandbox mode: workspace-write \(this run: off, no sandbox\)/);
	assert.match(text, /Timeout: 90s/);
	assert.match(text, /Approval: waiting for your choice in the yellow approval panel below/);
	assert.match(text, /Options: Yes · No · Yes, and reason… · No, and reason…/);
	assert.doesNotMatch(text, /模型正在请求|申请来源|申请理由|完整命令|当前沙盒模式|超时：|审批状态：/);
	assert.ok(text.includes(COMMAND), "the command text itself is never translated or truncated");
	assert.ok(text.includes(REASON), "the request reason text itself is never translated");
});

test("an English result card stays English, and a restored row gets its saved locale", TEST, () => {
	clearLiveApprovals();
	const tool = definition();
	const result = {
		content: [{ type: "text", text: "output" }],
		details: {
			requestId: "req-render-en",
			cwd: "C:\\work",
			mode: "workspace-write",
			locale: "en",
			decision: "declined",
			option: "No, and reason…",
			decisionReason: "Use the workspace copy",
			executed: false,
		},
	};
	const text = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context()).render(90)
		.map((line) => stripAnsi(line)).join("\n");
	assert.match(text, /Approval result: declined \(not executed\) \(No, and reason…\)/);
	assert.match(text, /Execution: this command was not run\./);
	assert.match(text, /Human instruction \(typed in the approval UI, not the model's request reason\):/);
	assert.match(text, /Use the workspace copy/);
	assert.doesNotMatch(text, /模型审批结果|没有执行这条命令|用户补充指令/);

	const errored = tool.renderResult(
		{
			content: [{ type: "text", text: "not executed" }],
			details: { locale: "en", decision: "error", executed: false, executionError: "config broken", auditError: "disk full" },
		},
		{ expanded: false, isPartial: false },
		theme,
		context(),
	).render(90).map((line) => stripAnsi(line)).join("\n");
	assert.match(errored, /Approval result: approval failed \(not executed, fail-closed\)/);
	assert.match(errored, /Error: config broken/);
	assert.match(errored, /Warning: the audit record could not be written: disk full/);
	assert.doesNotMatch(errored, /错误：|警告：/);

	// A reloaded row has only the call arguments; session_start rebuilds this map from the saved
	// tool-result details, so the request card must not fall back to Chinese next to that result.
	clearLiveApprovals();
	restoreHistoricalApprovalLocales([
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "sandbox_request",
				toolCallId: "call-render-1",
				details: { locale: "en" },
			},
		},
	]);
	const restored = renderedText(tool.renderCall({ command: COMMAND, reason: REASON }, theme, context())).text;
	assert.match(restored, /The model is requesting an operation outside the workspace/);
	assert.match(restored, /Request source: Model tool sandbox_request \(tool call call-render-1\)/);
	assert.match(restored, /History: the captured cwd, mode and timeout are on the result card directly below/);
	assert.doesNotMatch(restored, /模型正在请求|申请来源|历史记录/);

	// An entry without a locale stays on the Chinese default (legacy sessions).
	clearLiveApprovals();
	restoreHistoricalApprovalLocales([
		{ type: "message", message: { role: "toolResult", toolName: "sandbox_request", toolCallId: "call-render-1", details: {} } },
	]);
	assert.match(renderedText(tool.renderCall({ command: COMMAND, reason: REASON }, theme, context())).text, /模型正在请求/);
});

test("the tool renderers never mutate the result the model sees", TEST, () => {
	clearLiveApprovals();
	const tool = definition();
	const content = [{ type: "text", text: "输出" }];
	const details = { decision: "cancelled", executed: false };
	const before = JSON.stringify({ content, details });
	tool.renderResult({ content, details }, { expanded: false, isPartial: false }, theme, context());
	assert.equal(JSON.stringify({ content, details }), before);
});
