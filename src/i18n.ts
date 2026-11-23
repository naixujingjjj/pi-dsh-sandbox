/**
 * Central bilingual dictionary for the approval surfaces.
 *
 * The approval UI follows the language of the real user messages on the current session branch
 * (see `src/locale.ts`). Everything the user sees while approving — the card, the dock, the reason
 * editor, the plain RPC `select`/`input` wording, the mode-widening confirmation and the human
 * `/sandbox exec` notifications — comes from here, so a surface cannot drift into a mixed language.
 *
 * Rules that this module keeps:
 *
 * - The four option labels (`Yes` / `No` / `Yes, and reason…` / `No, and reason…`) are protocol
 *   values and are never translated.
 * - Commands, the model's `requestReason`, and the human's approval text are data: they are shown
 *   verbatim and are never passed through this dictionary.
 * - `locale` is an optional field on the request/decision data. A request that predates 0.4.0, or a
 *   surface that was never given a locale, resolves to `zh`, exactly as those versions behaved.
 *
 * The dictionary is deliberately data plus small formatting functions instead of a screen-wide
 * string replacement: a new label must be added to both languages at the same place, and tests can
 * call the same accessor the UI uses.
 */
export type Locale = "zh" | "en";

export const DEFAULT_LOCALE: Locale = "zh";

/** Missing/legacy/unknown locales stay Chinese for backward compatibility. */
export function resolveLocale(value: unknown): Locale {
	return value === "en" ? "en" : DEFAULT_LOCALE;
}

export interface ReasonWording {
	/** Short heading of the reason editor. */
	title: string;
	/** Always empty: the 0.3.1 behavior keeps the editor blank. */
	placeholder: string;
	/** Description used by the plain `ui.input` transport. */
	description: string;
	/** Compact note shown inside the TUI dock. */
	note: string;
}

export type ReasonKey = "approve" | "decline";

export interface ApprovalStrings {
	title: string;
	titleShort: string;
	sourcePrefix: string;
	requestReasonLabel: string;
	notProvided: string;
	missingCommand: string;
	missingReason: string;
	fullCommandLabel: string;
	cwdPrefix: string;
	sandboxModePrefix: string;
	sandboxModeSuffix: string;
	timeoutPrefix: string;
	timeoutSuffix: string;
	historyHint: string;
	optionsPrefix: string;
	approvalStatusPrefix: string;
	pendingChoice: string;
	execPendingChoice: string;
	panelHint: string;
	decidedFallback: string;
	resultTitlePrefix: string;
	status: Record<
		"approved" | "declined" | "cancelled" | "no-ui" | "unavailable" | "error",
		string
	>;
	executedPrefix: string;
	executedExit: string;
	notExecuted: string;
	modeHeldPrefix: string;
	decisionReasonLabel: string;
	requestIdPrefix: string;
	widenTitle: string;
	currentPrefix: string;
	targetPrefix: string;
	rootPrefix: string;
	widenScope: string;
	widenPending: string;
	widenHint: string;
	widenConfirmed: string;
	widenCancelled: string;
	widenFallback: string;
	cancelKeepPrefix: string;
	confirmWidenPrefix: string;
	panelSourcePrefix: string;
	panelCardPointer: string;
	panelRunOff: string;
	panelModeHeld: string;
	panelBlockedSuffix: string;
	panelReasonChoicePrefix: string;
	panelEditorHint: string;
	panelF2Hint: string;
	panelMenuHint: string;
	panelDigitHint: string;
	menuEscHint: string;
	panelHiddenPrefix: string;
	panelHiddenReason: string;
	panelHiddenHint: string;
	/** Approval decision details and notifications. */
	cancelledBefore: string;
	noUi: string;
	cancelledWhileWaiting: string;
	lateCancelled: string;
	escCancelled: string;
	unknownChoicePrefix: string;
	unknownChoiceSuffix: string;
	unavailable: string;
	dialogFailedPrefix: string;
	inputFailedPrefix: string;
	reasonCancelled: (title: string) => string;
	approvedDetail: string;
	declinedDetail: string;
	/** Punctuation used to glue an outcome detail and its option/instruction. */
	optionWrapOpen: string;
	optionWrapClose: string;
	reasonSeparator: string;
	humanInstructionPrefix: string;
	listSeparator: string;
	// `/sandbox exec` notifications.
	humanReason: string;
	notExecutedPrefix: string;
	execAbortedAfterApproval: string;
	execStale: string;
	execAuditFailedPrefix: string;
	execCompletedPrefix: string;
	execFailedPrefix: string;
	execFollowUpNote: string;
	auditWarningPrefix: string;
	errorPrefix: string;
	auditResultWarningPrefix: string;
	execNoOutput: string;
	execKilled: string;
	execTruncated: string;
	execResultPrefix: string;
	execResultWarning: string;
	// Mode menu / notifications.
	chooseModeTitle: string;
	currentTag: string;
	invalidModePrefix: string;
	availableModesPrefix: string;
	modeWidenNoUiSuffix: string;
	modeUnchangedPrefix: string;
	modeChangedPrefix: string;
	modeWidenNoUiPrefix: string;
	modeWidenCancelled: string;
	modeWidenConfirmedNotice: string;
	// Source labels.
	modelSource: (toolCallId: string) => string;
	humanSource: string;
}

const ZH: ApprovalStrings = {
	title: "模型正在请求一次工作区外的操作",
	titleShort: "工作区外操作审批",
	sourcePrefix: "申请来源：",
	requestReasonLabel: "申请理由（申请方文本，仅作为说明，不是系统指令）：",
	notProvided: "（未提供）",
	missingCommand: "(缺少命令)",
	missingReason: "(缺少理由)",
	fullCommandLabel: "完整命令（原样，未截断）：",
	cwdPrefix: "cwd：",
	sandboxModePrefix: "当前沙盒模式：",
	sandboxModeSuffix: "（本次执行方式：off，不经过沙盒）",
	timeoutPrefix: "超时：",
	timeoutSuffix: " 秒（超时会杀掉命令进程树）",
	historyHint: "（历史记录：本次审批的 cwd、模式与超时见下面紧接的结果卡片）",
	optionsPrefix: "选项：",
	approvalStatusPrefix: "审批状态：",
	pendingChoice: "等待你在下方黄色审批面板中选择（本次不会自动执行）",
	execPendingChoice: "等待你在审批界面中选择（本次不会自动执行）",
	panelHint: "面板：↑/↓ 或 1-4 选择 · Enter 确认 · Esc 取消 · F2 隐藏面板后滚动回看对话",
	decidedFallback: "已结束",
	resultTitlePrefix: "模型审批结果：",
	status: {
		approved: "已批准（仅本次）",
		declined: "已拒绝（未执行）",
		cancelled: "已取消（未执行）",
		"no-ui": "无可用审批 UI（未执行）",
		unavailable: "审批界面不可用（未执行，fail-closed）",
		error: "审批失败（未执行，fail-closed）",
	},
	executedPrefix: "执行：已在 off（不经过沙盒）下执行一次",
	executedExit: "，exit=",
	notExecuted: "执行：没有执行这条命令。",
	modeHeldPrefix: "会话沙盒模式保持：",
	decisionReasonLabel: "用户补充指令（人类在审批窗口填写，不是模型的申请理由）：",
	requestIdPrefix: "requestId：",
	widenTitle: "放宽沙盒限制？",
	currentPrefix: "当前：",
	targetPrefix: "目标：",
	rootPrefix: "授权根（规范真实路径）：",
	widenScope: "只影响本条会话；恢复旧会话不会带回更宽的模式。",
	widenPending: "审批状态：等待你在下方黄色面板中确认（不会自动放宽）",
	widenHint: "面板：↑/↓ 选择 · Enter 确认 · Esc 取消 · F2 隐藏面板后回看对话",
	widenConfirmed: "审批状态：已确认放宽模式",
	widenCancelled: "审批状态：已取消（模式未变化）",
	widenFallback: "黄色审批面板不可用，已改用原生确认对话框（仍然需要你确认，不会自动放宽）。",
	cancelKeepPrefix: "取消（保持当前模式 ",
	confirmWidenPrefix: "确认放宽为 ",
	panelSourcePrefix: "来源：",
	panelCardPointer: "完整理由、完整命令（原样、未截断）、cwd、模式与超时都在上方的黄色审批卡片里。",
	panelRunOff: "本次执行方式：off（不经过沙盒）",
	panelModeHeld: "会话模式保持 ",
	panelBlockedSuffix: "（等待审批）",
	panelReasonChoicePrefix: "将选择：",
	panelEditorHint: "Enter 提交 · Esc 取消（不执行）· Backspace 删除 · 支持中文与粘贴",
	panelF2Hint: "F2 隐藏本面板回看对话（再按 F2 返回；此时不会执行）",
	panelMenuHint: "↑/↓ 选择 · Enter 确认",
	panelDigitHint: " 选择",
	menuEscHint: " · Esc 取消（不执行）",
	panelHiddenPrefix: "审批待处理：",
	panelHiddenReason: "（正在填写理由，已输入的内容保留）",
	panelHiddenHint: " · 按 F2 返回审批面板 · 此时不会执行",
	cancelledBefore: "等待审批前请求已被取消，未执行。",
	noUi:
		"当前会话没有可确认的 UI（hasUI=false），未执行。" +
		"子代理无法代替人类批准，请由父代理或用户在交互式终端发起该操作。",
	cancelledWhileWaiting: "等待审批时请求被取消，晚到的选择无效，未执行。",
	lateCancelled: "审批结果到达前请求已被取消，晚到的选择无效，未执行。",
	escCancelled: "审批被取消（ESC/无选择），未执行。",
	unknownChoicePrefix: "无法识别的审批选择 ",
	unknownChoiceSuffix: "，按未批准处理，未执行。",
	unavailable: "当前会话缺少 select/input 审批 UI，未执行（fail-closed）。",
	dialogFailedPrefix: "审批对话框失败，未执行：",
	inputFailedPrefix: "用户填写内容的输入失败，未执行：",
	reasonCancelled: (title) => `「${title}」为空或取消输入，本次不批准，命令未执行；没有内容可以交给代理继续。`,
	approvedDetail: "用户批准了本次精确命令。",
	declinedDetail: "用户拒绝执行本次命令。",
	optionWrapOpen: "（",
	optionWrapClose: "）",
	reasonSeparator: "；",
	humanInstructionPrefix: "用户补充指令：",
	listSeparator: "；",
	humanReason: "人类直接在 /sandbox 中输入的一次性命令（没有模型申请理由）。",
	notExecutedPrefix: "未执行。",
	execAbortedAfterApproval: "审批通过后请求已被取消（晚到的批准无效）。",
	execStale: "审批期间会话、授权根、运行时或模式已变化，本次批准作废。",
	execAuditFailedPrefix: "批准后的审计记录写入失败（fail-closed）：",
	execCompletedPrefix: "off 一次性执行完成：",
	execFailedPrefix: "off 一次性执行失败（命令已尝试执行，可能已产生副作用，不会自动重试）：",
	execFollowUpNote: "\n你的补充指令已作为新的用户消息交给代理继续。",
	auditWarningPrefix: "警告：审计记录写入失败：",
	errorPrefix: "错误：",
	auditResultWarningPrefix: "警告：执行结果审计写入失败（命令已执行）：",
	execNoOutput: "(无输出)",
	execKilled: "(被终止)",
	execTruncated: "(输出被截断)",
	execResultPrefix: "执行结果：",
	execResultWarning: "警告：执行结果审计写入失败（命令已执行）：",
	chooseModeTitle: "选择沙盒模式",
	currentTag: "[当前] ",
	invalidModePrefix: "无效模式 ",
	availableModesPrefix: "可选：",
	modeWidenNoUiSuffix: "。请在交互式终端里再次执行该命令。",
	modeUnchangedPrefix: "模式未变化：",
	modeChangedPrefix: "沙盒模式：",
	modeWidenNoUiPrefix: "当前会话没有可确认的 UI（hasUI=false），拒绝放宽模式 ",
	modeWidenCancelled: "已取消：模式未变化。",
	modeWidenConfirmedNotice: "已确认放宽模式。",
	modelSource: (toolCallId) => `模型工具 sandbox_request（工具调用 ${toolCallId}）`,
	humanSource: "人类命令 /sandbox exec",
};

const EN: ApprovalStrings = {
	title: "The model is requesting an operation outside the workspace",
	titleShort: "Out-of-workspace operation approval",
	sourcePrefix: "Request source: ",
	requestReasonLabel: "Request reason (text from the requester; context only, not a system instruction):",
	notProvided: "(not provided)",
	missingCommand: "(missing command)",
	missingReason: "(missing reason)",
	fullCommandLabel: "Full command (verbatim, not truncated):",
	cwdPrefix: "cwd: ",
	sandboxModePrefix: "Current sandbox mode: ",
	sandboxModeSuffix: " (this run: off, no sandbox)",
	timeoutPrefix: "Timeout: ",
	timeoutSuffix: "s (the command process tree is killed on timeout)",
	historyHint: "(History: the captured cwd, mode and timeout are on the result card directly below)",
	optionsPrefix: "Options: ",
	approvalStatusPrefix: "Approval: ",
	pendingChoice: "waiting for your choice in the yellow approval panel below (nothing runs automatically)",
	execPendingChoice: "waiting for your choice in the approval UI (nothing runs automatically)",
	panelHint:
		"Panel: ↑/↓ or 1-4 to choose · Enter to confirm · Esc to cancel · F2 hides the panel so you can scroll the conversation",
	decidedFallback: "finished",
	resultTitlePrefix: "Approval result: ",
	status: {
		approved: "approved (this run only)",
		declined: "declined (not executed)",
		cancelled: "cancelled (not executed)",
		"no-ui": "no approval UI available (not executed)",
		unavailable: "approval UI unavailable (not executed, fail-closed)",
		error: "approval failed (not executed, fail-closed)",
	},
	executedPrefix: "Execution: ran once under off (no sandbox)",
	executedExit: ", exit=",
	notExecuted: "Execution: this command was not run.",
	modeHeldPrefix: "Session sandbox mode stays: ",
	decisionReasonLabel: "Human instruction (typed in the approval UI, not the model's request reason):",
	requestIdPrefix: "requestId: ",
	widenTitle: "Widen the sandbox permissions?",
	currentPrefix: "Current: ",
	targetPrefix: "Target: ",
	rootPrefix: "Authorization root (canonical path): ",
	widenScope: "Affects this session only; resuming an old session never restores a wider mode.",
	widenPending: "Approval: waiting for your confirmation in the yellow panel below (nothing widens automatically)",
	widenHint: "Panel: ↑/↓ to choose · Enter to confirm · Esc to cancel · F2 hides the panel so you can read the conversation",
	widenConfirmed: "Approval: mode widening confirmed",
	widenCancelled: "Approval: cancelled (the mode did not change)",
	widenFallback: "The yellow approval panel is unavailable; the native confirmation dialog is used instead (you still must confirm; nothing widens automatically).",
	cancelKeepPrefix: "Cancel (keep the current mode ",
	confirmWidenPrefix: "Confirm widening to ",
	panelSourcePrefix: "Source: ",
	panelCardPointer:
		"The full reason, full command (verbatim, untruncated), cwd, mode and timeout are in the yellow approval card above.",
	panelRunOff: "this run: off (no sandbox)",
	panelModeHeld: "session mode stays ",
	panelBlockedSuffix: " (waiting for approval)",
	panelReasonChoicePrefix: "Choosing: ",
	panelEditorHint: "Enter submit · Esc cancel (nothing runs) · Backspace delete · supports Chinese input and paste",
	panelF2Hint: "F2 hides this panel so you can read the conversation (press F2 again to return; nothing runs while hidden)",
	panelMenuHint: "↑/↓ select · Enter confirm",
	panelDigitHint: " to choose",
	menuEscHint: " · Esc cancel (nothing runs)",
	panelHiddenPrefix: "Approval pending: ",
	panelHiddenReason: " (typing a reason; your text is kept)",
	panelHiddenHint: " · press F2 to return to the approval panel · nothing runs yet",
	cancelledBefore: "The request was cancelled before approval; nothing ran.",
	noUi:
		"This session has no UI that can confirm the request (hasUI=false), so nothing ran. " +
		"A subagent cannot approve on a human's behalf; start the operation from an interactive terminal or the parent agent.",
	cancelledWhileWaiting: "The request was cancelled while waiting for approval; a late choice is ignored and nothing ran.",
	lateCancelled: "The request was cancelled before the approval result arrived; a late choice is ignored and nothing ran.",
	escCancelled: "Approval was cancelled (ESC / no selection); nothing ran.",
	unknownChoicePrefix: "Unrecognized approval choice ",
	unknownChoiceSuffix: ", treated as not approved; nothing ran.",
	unavailable: "This session has no select/input approval UI; nothing ran (fail-closed).",
	dialogFailedPrefix: "The approval dialog failed; nothing ran: ",
	inputFailedPrefix: "The text input failed; nothing ran: ",
	reasonCancelled: (title) => `"${title}" was empty or cancelled, so this request is not approved and nothing ran; there is no text to continue with.`,
	approvedDetail: "The user approved this exact command.",
	declinedDetail: "The user declined to run this command.",
	optionWrapOpen: " (",
	optionWrapClose: ")",
	reasonSeparator: "; ",
	humanInstructionPrefix: "Human instruction: ",
	listSeparator: "; ",
	humanReason: "A one-off command entered by the human in /sandbox (there is no model request reason).",
	notExecutedPrefix: "Not executed. ",
	execAbortedAfterApproval: "The request was cancelled after approval (a late approval is invalid); nothing ran.",
	execStale: "The session, authorization root, runtime or mode changed during approval; this approval is void.",
	execAuditFailedPrefix: "The post-approval audit record could not be written (fail-closed): ",
	execCompletedPrefix: "off one-shot execution completed: ",
	execFailedPrefix:
		"off one-shot execution failed (the command was attempted and may have had side effects; it is not retried automatically): ",
	execFollowUpNote: "\nYour instruction was delivered to the agent as a new user message.",
	auditWarningPrefix: "Warning: the audit record could not be written: ",
	errorPrefix: "Error: ",
	auditResultWarningPrefix: "Warning: the execution-result audit record could not be written (the command ran): ",
	execNoOutput: "(no output)",
	execKilled: "(killed)",
	execTruncated: "(output truncated)",
	execResultPrefix: "Execution result: ",
	execResultWarning: "Warning: the execution-result audit record could not be written (the command ran): ",
	chooseModeTitle: "Choose sandbox mode",
	currentTag: "[current] ",
	invalidModePrefix: "Invalid mode ",
	availableModesPrefix: "Available: ",
	modeWidenNoUiSuffix: ". Run the command again in an interactive terminal.",
	modeUnchangedPrefix: "Mode unchanged: ",
	modeChangedPrefix: "Sandbox mode: ",
	modeWidenNoUiPrefix: "This session has no UI that can confirm the change (hasUI=false); refusing to widen the mode ",
	modeWidenCancelled: "Cancelled: the mode did not change.",
	modeWidenConfirmedNotice: "Mode widening confirmed.",
	modelSource: (toolCallId) => `Model tool sandbox_request (tool call ${toolCallId})`,
	humanSource: "Human command /sandbox exec",
};

const REASON: Record<Locale, Record<ReasonKey, ReasonWording>> = {
	zh: {
		approve: {
			title: "本次操作完成后的补充要求",
			placeholder: "",
			description:
				"批准本次操作，并填写「本次操作完成后的补充要求」（必填）。\n\n" +
				"这段内容会作为你的指示交给代理：本次操作完成（成功或失败）后，代理必须先如实报告执行事实，再完成你写的要求。\n" +
				"它不会改写上面展示的命令本身；留空或取消输入将视为本次不批准，命令不会执行。",
			note:
				"批准本次操作，并填写「本次操作完成后的补充要求」（必填）。这段内容只作为你给代理的指示，不会改写上面展示的命令；留空或取消=本次不批准，命令不会执行。",
		},
		decline: {
			title: "拒绝原因或新的执行方向",
			placeholder: "",
			description:
				"拒绝本次操作，并填写「拒绝原因或新的执行方向」（必填）。\n\n" +
				"这段内容会作为当前任务的新用户指示交给代理：代理会按新方向重新规划并继续，你不需要再发一遍提示词。\n" +
				"被拒绝的命令不会执行；如果新方向仍然需要越界，代理必须对新的命令重新申请审批。留空或取消输入只表示不执行本次操作。",
			note:
				"拒绝本次操作，并填写「拒绝原因或新的执行方向」（必填）。这段内容会作为当前任务的新用户指示交给代理；留空或取消=只表示不执行本次操作。",
		},
	},
	en: {
		approve: {
			title: "Requirement to complete after this operation",
			placeholder: "",
			description:
				"Approve this operation and enter the requirement to complete after it (required).\n\n" +
				"The text is handed to the agent as your instruction: after this operation finishes (successfully or not), the agent must first report the execution facts, then complete what you wrote.\n" +
				"It never rewrites the command shown above; leaving it empty or cancelling means this request is not approved and the command does not run.",
			note:
				"Approve this operation and enter the requirement to complete after it (required). The text is only an instruction to the agent and never rewrites the displayed command; empty or cancelled = not approved, nothing runs.",
		},
		decline: {
			title: "Reason for declining or a new direction",
			placeholder: "",
			description:
				"Decline this operation and enter the reason or a new direction (required).\n\n" +
				"The text becomes a new user instruction for the current task: the agent replans from it and continues, so you do not need to resend the prompt.\n" +
				"The declined command does not run; if the new direction still needs an out-of-bounds operation, the agent must request approval for a new exact command. Empty or cancelled simply means this operation does not run.",
			note:
				"Decline this operation and enter the reason or a new direction (required). The text becomes a new user instruction for the current task; empty or cancelled = this operation does not run.",
		},
	},
};

export function approvalStrings(locale: Locale | undefined): ApprovalStrings {
	return resolveLocale(locale) === "en" ? EN : ZH;
}

export function reasonWording(locale: Locale | undefined, key: ReasonKey): ReasonWording {
	return REASON[resolveLocale(locale)][key];
}

/** English mode descriptions used by the widened-mode confirmation; Chinese uses policy.ts. */
export function modeDescriptionEn(mode: string): string {
	switch (mode) {
		case "read-only":
			return "read-only (all writes/deletes are denied by the kernel)";
		case "workspace-write":
			return "workspace-write (only the workspace root and the runner's private temp)";
		case "off":
			return "off (not enforced: tools run unrestricted)";
		default:
			return mode;
	}
}

export interface ReasonStrings {
	headingDecline: string;
	headingApprove: string;
	originPrefix: string;
	resultPrefix: string;
	verbatimLabel: string;
	followInstruction: string;
	requirementExecuted: readonly string[];
	requirementFailed: readonly string[];
	requirementNotExecuted: readonly string[];
	declineFollowUp: readonly string[];
	humanHeading: string;
	humanSourcePrefix: string;
	humanResultPrefix: string;
	humanCommandLabel: string;
	humanOutputLabel: string;
	humanInstructionLabel: string;
	humanDeclineLines: readonly string[];
	humanExecutedLines: readonly string[];
	humanNotExecutedLine: string;
	executedLine: (option: string) => string;
	failedLine: (option: string) => string;
	notExecutedLine: (option: string) => string;
	declinedLine: (option: string) => string;
	approvedLine: (option: string) => string;
}

const REASON_TEXT: Record<Locale, ReasonStrings> = {
	zh: {
		headingDecline: "===== 用户补充指令（请在当前任务中执行）=====",
		headingApprove: "===== 用户补充指令（请在本次操作完成后执行）=====",
		originPrefix: "来源：人类在审批窗口里填写（不是你的 requestReason 申请理由）。审批来源：",
		resultPrefix: "审批结果：",
		verbatimLabel: "用户填写的内容（原样）：",
		followInstruction: "后续行为以用户填写的具体要求为准；如果要求停止、暂停或只解释，不得自行继续操作。",
		requirementExecuted: [
			"1. 先如实报告本次操作的执行事实：是否成功、退出码与输出、实际产生了什么作用（有副作用就说清楚）。",
			"2. 再完成上面这条补充要求（例如解释这次操作的意图、作用、结果与后续计划）。",
			"3. 然后继续当前任务；不要重新执行这条命令，也不要把它当成新的申请理由或新的命令。",
		],
		requirementFailed: [
			"1. 先如实报告执行未正常完成：错误是什么、命令是否已经开始执行、可能产生了什么副作用（不会自动重试）。",
			"2. 再完成上面这条补充要求（例如说明这次操作的意图、失败原因与补救计划）。",
			"3. 然后继续当前任务；不要在未重新审批的情况下重试这条命令。",
		],
		requirementNotExecuted: [
			"1. 先如实说明本次操作没有执行以及原因（批准失效、被取消或审计失败）。",
			"2. 再完成上面这条补充要求（例如解释这次操作本来要做什么、为什么没有执行、接下来怎么做）。",
			"3. 然后继续当前任务；需要再次执行时重新发起申请，不要静默重试。",
		],
		declineFollowUp: [
			"这是一条新的用户指示，不是需要中止任务的普通工具错误：",
			"1. 不要重新提交被拒绝的这条命令，也不要因为它失败就结束当前任务或让用户重发一遍提示词。",
			"2. 按上面的新方向重新规划，用普通沙盒工具（powershell/write/edit）继续当前任务。",
			"3. 如果新方向仍然需要越界操作，用 sandbox_request 提交一条新的精确命令，并等待新的审批。",
		],
		humanHeading: "[pi-dsh-sandbox] 审批窗口里的补充指令（人工命令，不是模型 sandbox_request）",
		humanSourcePrefix: "审批来源：",
		humanResultPrefix: "审批结果：",
		humanCommandLabel: "人类输入的这条命令（原样，已展示并审批；不要重新执行）：",
		humanOutputLabel: "输出（可能已截断）：",
		humanInstructionLabel: "用户在审批窗口填写的内容（原样）：",
		humanDeclineLines: [
			"这条命令没有执行。请把上面的内容当作当前任务的新用户指示：按新方向重新规划并继续当前任务，不需要用户再发一遍提示词；",
			"如果新方向仍然需要越界操作，用 sandbox_request 提交一条新的精确命令并等待新的审批。",
		],
		humanExecutedLines: [
			"请先如实报告这次人工执行的意图、作用与实际结果（成功或失败、退出码、输出、副作用），再完成上面的补充要求，然后继续当前任务。",
			"不要重新执行这条命令，也不要在没有新审批的情况下执行改写过的命令。",
		],
		humanNotExecutedLine:
			"请先如实说明这次人工操作没有执行（或没有正常完成）以及原因，再按上面的补充要求继续当前任务。不要重新执行这条命令。",
		executedLine: (option) => `${option}：批准并已执行本次展示的命令（只执行这一次）。`,
		failedLine: (option) => `${option}：批准并已开始执行，但执行没有正常完成（可能已产生副作用，不会自动重试）。`,
		notExecutedLine: (option) => `${option}：批准，但本次命令没有执行（批准已失效或执行前被取消）。`,
		declinedLine: (option) => `${option}：拒绝执行本次展示的命令，它没有被执行。`,
		approvedLine: (option) => `${option}：批准。`,
	},
	en: {
		headingDecline: "===== Human instruction (apply it to the current task) =====",
		headingApprove: "===== Human instruction (complete it after this operation) =====",
		originPrefix:
			"Origin: typed by the human in the approval UI (not your requestReason). Approval source: ",
		resultPrefix: "Approval result: ",
		verbatimLabel: "What the user wrote (verbatim):",
		followInstruction:
			"The user's specific requirement governs what happens next; if it asks to stop, pause or only explain, do not continue operating on your own.",
		requirementExecuted: [
			"1. First report what actually happened: success or failure, exit code and output, and any real effect (state side effects plainly).",
			"2. Then complete the requirement above (for example explain the intent, effect, result and next steps of this operation).",
			"3. Then continue the current task; do not run this command again and do not treat it as a new request reason or a new command.",
		],
		requirementFailed: [
			"1. First report plainly that execution did not complete: the error, whether the command started, and any possible side effects (it is not retried automatically).",
			"2. Then complete the requirement above (for example explain what the operation intended, why it failed, and the recovery plan).",
			"3. Then continue the current task; do not retry this command without a new approval.",
		],
		requirementNotExecuted: [
			"1. First state plainly that this operation did not run, and why (approval became invalid, was cancelled, or the audit failed).",
			"2. Then complete the requirement above (for example explain what the operation was going to do, why it did not run, and what comes next).",
			"3. Then continue the current task; request a fresh approval if it needs to run again, and never retry silently.",
		],
		declineFollowUp: [
			"This is a new user instruction, not an ordinary tool error that should end the task:",
			"1. Do not resubmit the declined command, and do not end the task or ask the user to repeat the prompt just because it failed.",
			"2. Replan from the new direction above and continue the current task with the ordinary sandboxed tools (powershell/write/edit).",
			"3. If the new direction still needs an out-of-bounds operation, submit a new exact command with sandbox_request and wait for a new approval.",
		],
		humanHeading: "[pi-dsh-sandbox] Instruction from the approval UI (human command, not a model sandbox_request)",
		humanSourcePrefix: "Approval source: ",
		humanResultPrefix: "Approval result: ",
		humanCommandLabel:
			"The command the human entered (verbatim, shown and approved; do not run it again):",
		humanOutputLabel: "Output (may be truncated):",
		humanInstructionLabel: "What the user wrote in the approval UI (verbatim):",
		humanDeclineLines: [
			"This command did not run. Treat the text above as a new user instruction for the current task: replan from the new direction and continue; the user does not need to resend the prompt.",
			"If the new direction still needs an out-of-bounds operation, submit a new exact command with sandbox_request and wait for a new approval.",
		],
		humanExecutedLines: [
			"First report the intent, effect and actual result of this human execution (success or failure, exit code, output, side effects), then complete the requirement above, then continue the current task.",
			"Do not run this command again, and do not run a rewritten command without a new approval.",
		],
		humanNotExecutedLine:
			"First state plainly that this human operation did not run (or did not complete) and why, then continue the current task per the requirement above. Do not run this command again.",
		executedLine: (option) => `${option}: approved and executed the displayed command (this run only).`,
		failedLine: (option) =>
			`${option}: approved and started, but execution did not complete (possible side effects; it is not retried automatically).`,
		notExecutedLine: (option) =>
			`${option}: approved, but this command did not run (the approval became invalid or was cancelled before execution).`,
		declinedLine: (option) => `${option}: declined the displayed command; it did not run.`,
		approvedLine: (option) => `${option}: approved.`,
	},
};

export function reasonStrings(locale: Locale | undefined): ReasonStrings {
	return REASON_TEXT[resolveLocale(locale)];
}