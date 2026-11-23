import test from "node:test";
import assert from "node:assert/strict";
import {
	APPROVAL_OPTIONS,
	decisionNote,
	renderApprovalMessage,
	requestOperationApproval,
} from "../../src/approval.ts";

function request(overrides = {}) {
	return {
		requestId: "req-1",
		toolCallId: "call-1",
		source: "model-tool",
		sourceLabel: "模型工具 sandbox_request",
		command: "Set-Content -LiteralPath 'C:\\outside\\a.txt' -Value 'x'",
		requestReason: "需要写入授权根之外的发布目录",
		cwd: "C:\\work\\root",
		mode: "workspace-write",
		...overrides,
	};
}

function ui({ select, input = async () => undefined } = {}) {
	return {
		hasUI: true,
		ui: {
			select: select ?? (async () => undefined),
			input,
		},
	};
}

test("approval message shows the full untruncated command, reason, cwd, mode and off scope", () => {
	const longTail = "X".repeat(4000);
	const message = renderApprovalMessage(request({ command: `Write-Output '${longTail}'` }));
	assert.ok(message.includes(`Write-Output '${longTail}'`), "the command must not be truncated");
	assert.match(message, /----- BEGIN COMMAND -----/);
	assert.match(message, /----- END COMMAND -----/);
	assert.match(message, /申请理由/);
	assert.match(message, /需要写入授权根之外的发布目录/);
	assert.match(message, /C:\\work\\root/);
	assert.match(message, /workspace-write/);
	assert.match(message, /off，不经过沙盒/);
	assert.match(message, /^模型正在请求一次工作区外的操作/);
	assert.doesNotMatch(message, /这次审批只对|不会改变 \/sandbox 模式|可能的副作用|两种带文字|它们不会改写/);
	assert.match(message, /不是系统指令/);
	// The picker options carry the decisions; the main prompt keeps only the request details.
	assert.doesNotMatch(message, /仅作为反馈|仅反馈|不会影响当前指令|只是意见|审批附言/);
});

test("no UI, missing dialogs and a dialog exception all refuse without approval", async () => {
	const noUi = await requestOperationApproval({ hasUI: false, ui: {} }, request());
	assert.equal(noUi.status, "no-ui");

	let selectCalls = 0;
	const missingInput = await requestOperationApproval(
		{ hasUI: true, ui: { select: async () => { selectCalls += 1; return "Yes"; } } },
		request(),
	);
	assert.equal(missingInput.status, "unavailable");
	assert.equal(selectCalls, 0, "no select/input pair must not open a dialog");

	const thrown = await requestOperationApproval(ui({ select: async () => { throw new Error("dialog exploded"); } }), request());
	assert.equal(thrown.status, "error");
	assert.match(thrown.detail, /dialog exploded/);

	const inputThrown = await requestOperationApproval(
		ui({
			select: async () => "Yes, and reason…",
			input: async () => { throw new Error("input exploded"); },
		}),
		request(),
	);
	assert.equal(inputThrown.status, "error");
	assert.match(inputThrown.detail, /input exploded/);
});

test("the four visible options map to approve/decline and the exact labels are stable", async () => {
	assert.deepEqual([...APPROVAL_OPTIONS], ["Yes", "No", "Yes, and reason…", "No, and reason…"]);
	const seen = [];
	const inputs = [];
	const base = (choice, answer = "审批人写的内容") =>
		ui({
			select: async (title, options) => { seen.push({ title, options }); return choice; },
			input: async (title, placeholder) => { inputs.push({ title, placeholder }); return answer; },
		});

	const yes = await requestOperationApproval(base("Yes"), request());
	assert.equal(yes.status, "approved");
	assert.equal(yes.option, "Yes");
	assert.equal(yes.decisionReason, undefined);

	const no = await requestOperationApproval(base("No"), request());
	assert.equal(no.status, "declined");
	assert.equal(no.option, "No");
	assert.equal(no.decisionReason, undefined);

	const yesReason = await requestOperationApproval(base("Yes, and reason…"), request());
	assert.equal(yesReason.status, "approved");
	assert.equal(yesReason.option, "Yes, and reason…");
	assert.equal(yesReason.decisionReason, "审批人写的内容");

	const noReason = await requestOperationApproval(base("No, and reason…"), request());
	assert.equal(noReason.status, "declined");
	assert.equal(noReason.option, "No, and reason…");
	assert.equal(noReason.decisionReason, "审批人写的内容");

	assert.deepEqual(seen[0].options, ["Yes", "No", "Yes, and reason…", "No, and reason…"]);
	assert.match(decisionNote(yesReason), /用户补充指令：审批人写的内容/);

	// The two inputs have distinct labels/placeholders; their descriptions omit example sentences.
	assert.equal(inputs.length, 2);
	const [approveInput, declineInput] = inputs;
	assert.match(approveInput.title, /本次操作完成后的补充要求/);
	assert.match(approveInput.title, /^批准/);
	assert.doesNotMatch(approveInput.title, /例如：/);
	assert.equal(approveInput.placeholder, "");
	assert.match(approveInput.title, /先如实报告执行事实|再完成你写的要求/);
	assert.match(declineInput.title, /拒绝原因或新的执行方向/);
	assert.match(declineInput.title, /^拒绝/);
	assert.doesNotMatch(declineInput.title, /例如：/);
	assert.equal(declineInput.placeholder, "");
	assert.match(declineInput.title, /新用户指示/);
	assert.match(declineInput.title, /重新规划并继续/);
	for (const input of inputs) {
		assert.doesNotMatch(input.title, /仅作为反馈|仅反馈|不会影响当前指令|只是意见|审批附言/);
	}
});

test("ESC/undefined, an unknown choice, blank reason and cancelled reason input never approve", async () => {
	for (const select of [async () => undefined]) {
		const decision = await requestOperationApproval(ui({ select }), request());
		assert.equal(decision.status, "cancelled");
		assert.match(decision.detail, /ESC/);
	}

	const unknown = await requestOperationApproval(ui({ select: async () => "Approve everything forever" }), request());
	assert.equal(unknown.status, "error");
	assert.match(unknown.detail, /无法识别/);

	const cancelledInput = await requestOperationApproval(
		ui({ select: async () => "Yes, and reason…", input: async () => undefined }),
		request(),
	);
	assert.equal(cancelledInput.status, "cancelled");
	assert.equal(cancelledInput.option, "Yes, and reason…");

	const blankInput = await requestOperationApproval(
		ui({ select: async () => "Yes, and reason…", input: async () => "   \r\n\t " }),
		request(),
	);
	assert.equal(blankInput.status, "cancelled");
	assert.match(blankInput.detail, /为空或取消输入|必填/);

	const cancelledDecline = await requestOperationApproval(
		ui({ select: async () => "No, and reason…", input: async () => undefined }),
		request(),
	);
	assert.equal(cancelledDecline.status, "cancelled");
	assert.notEqual(cancelledDecline.status, "declined");
});

test("an already aborted signal never opens a dialog", async () => {
	const controller = new AbortController();
	controller.abort();
	let calls = 0;
	const decision = await requestOperationApproval(
		ui({ select: async () => { calls += 1; return "Yes"; } }),
		request(),
		{ signal: controller.signal },
	);
	assert.equal(decision.status, "cancelled");
	assert.equal(calls, 0);
});

test("a late Yes after cancellation during select or reason input is ignored", async () => {
	const controller = new AbortController();
	const duringSelect = await requestOperationApproval(
		ui({
			select: async () => {
				controller.abort();
				return "Yes";
			},
		}),
		request(),
		{ signal: controller.signal },
	);
	assert.equal(duringSelect.status, "cancelled");
	assert.match(duringSelect.detail, /晚到/);

	const controller2 = new AbortController();
	const duringInput = await requestOperationApproval(
		ui({
			select: async () => "Yes, and reason…",
			input: async () => {
				controller2.abort();
				return "看起来批准了";
			},
		}),
		request(),
		{ signal: controller2.signal },
	);
	assert.equal(duringInput.status, "cancelled");
	assert.equal(duringInput.decisionReason, undefined, "a late reason must not become a grant");
});

test("concurrent approvals do not share decisions or reasons", async () => {
	const commands = ["Write-Output 'A'", "Write-Output 'B'"];
	const ctx = {
		hasUI: true,
		ui: {
			async select(title) {
				if (title.includes(commands[0])) return "Yes, and reason…";
				if (title.includes(commands[1])) return "No, and reason…";
				return undefined;
			},
			async input(title) {
				return title.startsWith("批准") ? "A 的批准后要求" : "B 的新方向";
			},
		},
	};
	const [a, b] = await Promise.all([
		requestOperationApproval(ctx, request({ requestId: "A", command: commands[0] })),
		requestOperationApproval(ctx, request({ requestId: "B", command: commands[1] })),
	]);
	assert.equal(a.status, "approved");
	assert.equal(a.decisionReason, "A 的批准后要求");
	assert.equal(b.status, "declined");
	assert.equal(b.decisionReason, "B 的新方向");
});

test("cancellation settles even when a select or input transport ignores the abort signal", async () => {
	for (const phase of ["select", "input"]) {
		const controller = new AbortController();
		let release;
		const pending = () => new Promise((resolve) => { release = resolve; });
		const running = requestOperationApproval(ui({
			select: phase === "select" ? pending : async () => "Yes, and reason…",
			input: pending,
		}), request(), { signal: controller.signal });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(typeof release, "function");
		controller.abort();
		const timeout = AbortSignal.timeout(500);
		const result = await Promise.race([
			running,
			new Promise((_, reject) => timeout.addEventListener("abort", () => reject(new Error("approval did not cancel")), { once: true })),
		]);
		assert.equal(result.status, "cancelled");
		release(phase === "select" ? "Yes" : "late reason");
		assert.equal((await running).status, "cancelled");
	}
});
