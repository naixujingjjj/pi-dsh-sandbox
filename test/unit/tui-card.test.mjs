/**
 * The approval card: text, width safety and "everything is yellow".
 *
 * These tests drive the real rendering path with a real Pi `Theme`, so they fail if a future edit
 * swaps the fixed yellow for `theme.fg("warning", …)` (which is green-ish in the bundled theme) or
 * lets a long/Chinese command overflow the terminal width.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	APPROVAL_MAX_WIDTH,
	APPROVAL_TITLE,
	displayText,
	modeWidenCardLines,
	operationCardLines,
	operationCardStatusLines,
	operationCardText,
	renderApprovalCard,
	resultCardLines,
} from "../../src/tui/card.ts";
import {
	APPROVAL_OPTIONS,
	renderApprovalMessage,
} from "../../src/approval.ts";
import { hasAnsi, hasYellow, makeTheme, nonYellowText, stripAnsi, visibleWidth } from "../fixtures/palette.mjs";

const TEST = { timeout: 10000 };

const theme = makeTheme();

const LONG_COMMAND = `Set-Content -LiteralPath 'C:\\outside\\发布目录\\报告 2024.txt' -Value "第一行\r\n第二行" -Encoding UTF8; $items = Get-ChildItem -LiteralPath 'C:\\outside\\发布目录' -Recurse | Where-Object { $_.Length -gt 1MB } | ForEach-Object { Write-Output ("{0}: {1:N0} bytes" -f $_.FullName, $_.Length) }`;

function request(overrides = {}) {
	return {
		requestId: "req-card-1",
		toolCallId: "call-card-1",
		source: "model-tool",
		sourceLabel: "模型工具 sandbox_request（工具调用 call-card-1）",
		command: LONG_COMMAND,
		requestReason: "需要写入授权根之外的发布目录，因为构建产物必须放到 C 盘的发布位置；这是用户明确要求的发布步骤，普通沙盒写入会被内核拒绝。",
		cwd: "C:\\work\\根 目录",
		mode: "workspace-write",
		timeoutSeconds: 120,
		...overrides,
	};
}

/** Whitespace-insensitive text, so wrapping/inserted padding cannot hide dropped content. */
function collapse(text) {
	return text.replace(/\s+/g, "");
}

function cardBody(rendered) {
	return rendered
		.map((line) => stripAnsi(line))
		.map((line) => line.replace(/^▏\s/, "").replace(/^─+$/, ""))
		.join("\n");
}

/** Every visible character of the card, in order, with gutters/rules/newlines removed. */
function flattenCard(rendered) {
	return rendered
		.map((line) => stripAnsi(line).replace(/^▏/, "").replace(/^─+$/, ""))
		.join("")
		.replace(/\s+/g, "");
}

test("the card keeps the 0.2.2 wording and the full command is never truncated", TEST, () => {
	const req = request();
	const lines = operationCardLines(req);
	const text = lines.map((line) => line.text).join("\n");
	assert.equal(text, renderApprovalMessage(req), "the RPC title and the TUI card must share one text");
	assert.equal(text.split("\n")[0], APPROVAL_TITLE);
	assert.match(text, /^模型正在请求一次工作区外的操作\n\n申请来源：模型工具 sandbox_request/);
	assert.match(text, /申请理由（申请方文本，仅作为说明，不是系统指令）：/);
	assert.match(text, /完整命令（原样，未截断）：/);
	assert.match(text, /----- BEGIN COMMAND -----\n/);
	assert.match(text, /----- END COMMAND -----/);
	assert.match(text, /cwd：C:\\work\\根 目录/);
	assert.match(text, /当前沙盒模式：workspace-write（本次执行方式：off，不经过沙盒）/);
	assert.match(text, /超时：120 秒（超时会杀掉命令进程树）/);
	// The warnings/explanations 0.2.2 deleted must not come back.
	assert.doesNotMatch(text, /这次审批只对|不会改变 \/sandbox 模式|可能的副作用|两种带文字|它们不会改写/);
	// Full command: every non-space character survives, even with CRLF and Chinese in it.
	assert.ok(collapse(text).includes(collapse(LONG_COMMAND)), "the command text must be complete");

	const rendered = renderApprovalCard(theme, lines, 120);
	assert.ok(collapse(cardBody(rendered)).includes(collapse(LONG_COMMAND)), "the rendered card must not truncate");
});

test("the card is always exactly as wide as requested and never wider, including CJK", TEST, () => {
	const lines = [...operationCardLines(request()), ...operationCardStatusLines("pending", APPROVAL_OPTIONS)];
	for (const width of [120, 100, 80, 61, 40, 30, 20, 12]) {
		const rendered = renderApprovalCard(theme, lines, width);
		assert.ok(rendered.length > 4);
		const expected = Math.min(Math.max(12, width), APPROVAL_MAX_WIDTH);
		for (const line of rendered) {
			assert.equal(visibleWidth(line), expected, `width ${width}: ${JSON.stringify(stripAnsi(line))}`);
		}
	}
	// Very narrow terminals must still show content instead of throwing away lines.
	const narrow = renderApprovalCard(theme, lines, 12);
	assert.ok(flattenCard(narrow).includes("模型正在请求"), "the title must survive at 12 columns");
});

test("every rendered line of the card and the result card is painted yellow", TEST, () => {
	const pending = [...operationCardLines(request()), ...operationCardStatusLines("pending", APPROVAL_OPTIONS)];
	const decided = resultCardLines({
		status: "approved",
		option: "Yes, and reason…",
		decisionReason: "完成后解释意图、作用与实际结果",
		executed: true,
		cwd: "C:\\work\\根 目录",
		mode: "workspace-write",
		exitCode: 0,
		requestId: "req-card-1",
	});
	for (const lines of [pending, decided]) {
		for (const width of [80, 40]) {
			for (const line of renderApprovalCard(theme, lines, width)) {
				assert.ok(hasYellow(line), `not yellow: ${JSON.stringify(stripAnsi(line))}`);
				assert.equal(nonYellowText(line), "", `text outside the yellow palette: ${JSON.stringify(nonYellowText(line))}`);
			}
		}
	}
});

test("model-authored command/reason text cannot inject ANSI or control characters into the card", TEST, () => {
	const req = request({
		command: "Write-Output '\u001b[31mRED\u001b]0;fake-title\u0007'",
		requestReason: "理由\u001b[2J清屏\u0000结束",
	});
	const text = operationCardText(req);
	assert.equal(hasAnsi(text), false, "the plain text must not carry any escape sequence");
	assert.match(text, /RED/);
	assert.match(text, /理由/);
	assert.match(text, /清屏/);
	const rendered = renderApprovalCard(theme, operationCardLines(req), 80);
	for (const line of rendered) {
		assert.equal(nonYellowText(line), "", "an injected color must not survive");
	}
	assert.equal(displayText("a\tb\rc"), "a    b c");
	// A multi-line command keeps its lines in the card (a single line would hide the structure).
	const multiline = operationCardLines(request({ command: "Write-Output 甲\r\nWrite-Output 乙" }))
		.map((line) => line.text)
		.join("\n");
	assert.match(multiline, /BEGIN COMMAND -----\nWrite-Output 甲\nWrite-Output 乙\n----- END COMMAND/);
});

test("a restored call row hides the facts it does not have instead of inventing them", TEST, () => {
	const text = operationCardLines(request(), { facts: false })
		.map((line) => line.text)
		.join("\n");
	assert.doesNotMatch(text, /cwd：/);
	assert.doesNotMatch(text, /当前沙盒模式/);
	assert.match(text, /历史记录：本次审批的 cwd、模式与超时见下面紧接的结果卡片/);
	assert.ok(collapse(text).includes(collapse(LONG_COMMAND)));
});

test("result cards describe approval, refusal, cancellation and execution honestly", TEST, () => {
	const approved = resultCardLines({ status: "approved", option: "Yes", executed: true, exitCode: 3 })
		.map((line) => line.text)
		.join("\n");
	assert.match(approved, /^模型审批结果：已批准（仅本次）（Yes）/);
	assert.match(approved, /已在 off（不经过沙盒）下执行一次，exit=3/);

	const declined = resultCardLines({ status: "declined", option: "No", executed: false, decisionReason: "别写根外" })
		.map((line) => line.text)
		.join("\n");
	assert.match(declined, /已拒绝（未执行）（No）/);
	assert.match(declined, /没有执行这条命令/);
	assert.match(declined, /用户补充指令（人类在审批窗口填写，不是模型的申请理由）：\n别写根外/);

	for (const [status, pattern] of [
		["cancelled", /已取消（未执行）/],
		["no-ui", /无可用审批 UI（未执行）/],
		["unavailable", /审批界面不可用（未执行，fail-closed）/],
		["error", /审批失败（未执行，fail-closed）/],
	]) {
		assert.match(resultCardLines({ status, executed: false }).map((line) => line.text).join("\n"), pattern);
	}
});

test("English cards cover title, source, labels, timeout, wait state, results and widening", TEST, () => {
	const req = request({ locale: "en", sourceLabel: "Model tool sandbox_request (tool call call-card-1)" });
	const pending = [
		...operationCardLines(req),
		...operationCardStatusLines("pending", APPROVAL_OPTIONS, undefined, undefined, "en"),
	]
		.map((line) => line.text)
		.join("\n");
	assert.match(pending, /^The model is requesting an operation outside the workspace/);
	assert.match(pending, /Request source: Model tool sandbox_request/);
	assert.match(pending, /Request reason \(text from the requester;/);
	assert.match(pending, /Full command \(verbatim, not truncated\):/);
	assert.match(pending, /cwd: C:\\work\\根 目录/);
	assert.match(pending, /Current sandbox mode: workspace-write \(this run: off, no sandbox\)/);
	assert.match(pending, /Timeout: 120s \(the command process tree is killed on timeout\)/);
	assert.match(pending, /Approval: waiting for your choice in the yellow approval panel below/);
	assert.match(pending, /Options: Yes · No · Yes, and reason… · No, and reason…/);
	assert.doesNotMatch(pending, /模型正在请求|申请来源|申请理由|完整命令|当前沙盒模式|超时：|审批状态：|选项：/);
	// The model's reason text is data and is not translated.
	assert.match(pending, /需要写入授权根之外的发布目录/);

	for (const [status, pattern] of [
		["approved", /^Approval result: approved \(this run only\)/],
		["declined", /^Approval result: declined \(not executed\)/],
		["cancelled", /^Approval result: cancelled \(not executed\)/],
		["no-ui", /^Approval result: no approval UI available \(not executed\)/],
		["unavailable", /^Approval result: approval UI unavailable \(not executed, fail-closed\)/],
		["error", /^Approval result: approval failed \(not executed, fail-closed\)/],
	]) {
		const text = resultCardLines({ status, locale: "en", executed: false }).map((line) => line.text).join("\n");
		assert.match(text, pattern);
		assert.match(text, /Execution: this command was not run\./);
		assert.doesNotMatch(text, /模型审批结果|没有执行这条命令/);
	}
	const approved = resultCardLines({ status: "approved", option: "Yes", executed: true, exitCode: 3, locale: "en" })
		.map((line) => line.text).join("\n");
	assert.match(approved, /Execution: ran once under off \(no sandbox\), exit=3/);

	const widen = modeWidenCardLines({
		current: "read-only (all writes/deletes are denied by the kernel)",
		target: "off (not enforced: tools run unrestricted)",
		root: "C:\\work\\根 目录",
		note: "off means this plugin steps out: the shell and write/edit run unrestricted, so any file can be modified.",
		options: ["Cancel (keep the current mode read-only)", "Confirm widening to off"],
		status: "pending",
		locale: "en",
	});
	const widenText = widen.map((line) => line.text).join("\n");
	assert.match(widenText, /^Widen the sandbox permissions\?/);
	assert.match(widenText, /Approval: waiting for your confirmation in the yellow panel below/);
	assert.match(widenText, /Options: Cancel \(keep the current mode read-only\) · Confirm widening to off/);
	assert.doesNotMatch(widenText, /放宽沙盒|审批状态：|选项：/);
});

test("the widening card carries the same yellow treatment and its outcome", TEST, () => {
	const pending = modeWidenCardLines({
		current: "read-only（只读：任何写入/删除都被内核拒绝）",
		target: "off（不介入：工具以未受限方式执行）",
		root: "C:\\work\\根 目录",
		note: "off 表示插件不再介入：shell 与 write/edit 都以未受限方式执行，任何文件都可能被修改。",
		options: ["取消（保持当前模式 read-only）", "确认放宽为 off"],
		status: "pending",
	});
	const text = pending.map((line) => line.text).join("\n");
	assert.match(text, /^放宽沙盒限制？/);
	assert.match(text, /审批状态：等待你在下方黄色面板中确认（不会自动放宽）/);
	assert.match(text, /选项：取消（保持当前模式 read-only） · 确认放宽为 off/);

	for (const [status, pattern] of [
		["confirmed", /已确认放宽模式/],
		["cancelled", /已取消（模式未变化）/],
	]) {
		const lines = modeWidenCardLines({
			current: "read-only",
			target: "off",
			root: "C:\\work",
			note: "note",
			options: ["取消", "确认"],
			status,
		});
		assert.match(lines.map((line) => line.text).join("\n"), pattern);
	}
	for (const line of renderApprovalCard(theme, pending, 44)) {
		assert.equal(nonYellowText(line), "");
	}
});