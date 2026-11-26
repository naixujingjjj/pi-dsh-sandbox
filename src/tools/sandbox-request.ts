/**
 * `sandbox_request` — a model-callable, human-approved one-shot unrestricted execution.
 *
 * The tool does **not** return a grant for the model to use later. It asks for approval and then
 * executes exactly the command that was shown, in the canonical session root, once. Afterwards
 * nothing remains approved: the ordinary `powershell`/`write`/`edit` tools keep their kernel
 * sandbox and the session mode is untouched.
 *
 * Execution reuses Pi's built-in PowerShell tool definition and its local operations, so streaming
 * output, timeout/abort wording, PI_* environment, exit codes, truncation and `fullOutputPath` stay
 * byte-identical to a native off-mode run. The operations wrapper ignores the tool-supplied cwd and
 * pins the captured root, so a later argument change cannot relocate the grant.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	createLocalPowerShellOperations,
	createPowerShellToolDefinition,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionToolContext,
	type PowerShellOperations,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Container, Text, replaceControlCharacters, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
	APPROVAL_OPTIONS,
	APPROVAL_AUDIT_ENTRY,
	type ApprovalDecision,
	type ApprovalStatus,
	type OperationRequest,
	decisionNote,
	requestOperationApproval,
} from "../approval.ts";
import {
	ApprovalCardComponent,
	operationCardLines,
	operationCardStatusLines,
	resultCardLines,
} from "../tui/card.ts";
import { getLiveApproval, historicalApprovalLocale, registerLiveApproval, rememberHistoricalApprovalLocale, updateLiveApprovalPhase, watchLiveApproval, type LiveApprovalPhase } from "../tui/live.ts";
import { detectLocaleFromSession } from "../locale.ts";
import { approvalStrings, resolveLocale, type Locale } from "../i18n.ts";
import {
	type Continuation,
	type InstructionContext,
	type InstructionOutcome,
	instructionDetails,
	toolInstructionText,
	userInstructionOf,
} from "../reason.ts";
import { errorMessage } from "../errors.ts";
import { canonicalDir, type SandboxMode } from "../policy.ts";
import { PLUGIN_NAME, getSessionState, type SessionState } from "../state.ts";

export const SANDBOX_REQUEST_TOOL = "sandbox_request";
export const MAX_REQUEST_TIMEOUT_SECONDS = 600;

const sandboxRequestParameters = Type.Object({
	command: Type.String({
		description:
			"The one exact PowerShell command to run. The approval window shows exactly this text; a supplementary instruction the human types there does not rewrite it.",
		minLength: 1,
	}),
	reason: Type.String({
		description:
			"Why this command needs unrestricted (out-of-sandbox) execution — your request reason, required. It is shown to the approver only; text the human types into the approval window is a user instruction to you.",
		minLength: 1,
	}),
	timeout: Type.Optional(
		Type.Number({
			description: `Optional timeout in seconds (positive, at most ${MAX_REQUEST_TIMEOUT_SECONDS}). On timeout the command's process tree is killed.`,
			exclusiveMinimum: 0,
			maximum: MAX_REQUEST_TIMEOUT_SECONDS,
		}),
	),
});

export type SandboxRequestInput = Static<typeof sandboxRequestParameters>;

export interface SandboxRequestDetails {
	requestId: string;
	toolCallId: string;
	source: "model-tool";
	/** Locale captured from the user conversation; saved so restored cards keep their language. */
	locale?: Locale;
	cwd: string;
	mode: SandboxMode;
	decision: ApprovalStatus;
	option?: string;
	/** Text the human typed into the approval UI (their instruction to you, never your requestReason). */
	decisionReason?: string;
	/** Where the instruction text came from: always the human approval UI. */
	reasonSource?: "human-approval-ui";
	/** The human instruction, verbatim, so the caller/UI does not have to parse the content blocks. */
	userInstruction?: string;
	/** What you are expected to do next with that instruction. */
	continuation?: Continuation;
	executed: boolean;
	exitCode?: number | null;
	durationMs?: number;
	executionError?: string;
	auditError?: string;
	truncation?: unknown;
	fullOutputPath?: string;
}

type ValidRequest = { ok: true; command: string; requestReason: string; timeoutSeconds?: number };
type InvalidRequest = { ok: false; message: string };

function validateInput(params: SandboxRequestInput): ValidRequest | InvalidRequest {
	if (!params || typeof params !== "object") return { ok: false, message: "缺少参数对象。" };
	const { command, reason, timeout } = params as Partial<SandboxRequestInput>;
	if (typeof command !== "string" || command.trim().length === 0) {
		return { ok: false, message: "command 必须是非空的 PowerShell 命令字符串。" };
	}
	if (typeof reason !== "string" || reason.trim().length === 0) {
		return { ok: false, message: "reason 必须是非空字符串：说明为什么需要这次一次性未受限执行。" };
	}
	if (timeout !== undefined) {
		if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
			return { ok: false, message: "timeout 必须是有限正数（秒）。" };
		}
		if (timeout > MAX_REQUEST_TIMEOUT_SECONDS) {
			return { ok: false, message: `timeout 最大为 ${MAX_REQUEST_TIMEOUT_SECONDS} 秒。` };
		}
	}
	// Snapshot into immutable strings before any await: later mutations of the input object must not
	// change what was approved or executed.
	return {
		ok: true,
		command: String(command),
		requestReason: String(reason),
		...(timeout === undefined ? {} : { timeoutSeconds: timeout }),
	};
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

interface AuditInput {
	requestId: string;
	toolCallId?: string;
	phase: "decision" | "result";
	decision: ApprovalStatus;
	option?: string;
	/** Human-authored instruction text (approval UI input), kept for the audit trail. */
	decisionReason?: string;
	reasonSource?: "human-approval-ui";
	/** UI language pinned at request time (old audit entries may omit it). */
	locale?: Locale;
	cwd: string;
	mode: SandboxMode;
	commandHash: string;
	requestReasonHash: string;
	executed?: boolean;
	exitCode?: number | null;
	executionError?: string;
}

function writeAudit(pi: ExtensionAPI, record: AuditInput): string | undefined {
	try {
		if (typeof pi.appendEntry !== "function") throw new Error("appendEntry 不可用");
		pi.appendEntry(APPROVAL_AUDIT_ENTRY, {
			...record,
			at: new Date().toISOString(),
			plugin: PLUGIN_NAME,
		});
		return undefined;
	} catch (error) {
		return errorMessage(error);
	}
}

function errorResult(
	message: string,
	details: SandboxRequestDetails,
	extraText: Array<string | undefined> = [],
): AgentToolResult<SandboxRequestDetails> {
	const content: Array<{ type: "text"; text: string }> = [{ type: "text", text: `[${SANDBOX_REQUEST_TOOL}] ${message}` }];
	for (const text of extraText) {
		if (text !== undefined && text.length > 0) content.push({ type: "text", text });
	}
	return { content, details, isError: true };
}

function identityOf(state: SessionState, ctx: ExtensionToolContext) {
	return {
		state,
		sessionId: ctx.sessionManager.getSessionId(),
		root: state.root,
		runtime: state.runtime,
		mode: state.mode,
	};
}

function identityStillMatches(
	pi: ExtensionAPI,
	pluginRoot: string,
	ctx: ExtensionToolContext,
	captured: ReturnType<typeof identityOf>,
): boolean {
	if (ctx.sessionManager.getSessionId() !== captured.sessionId) return false;
	const current = getSessionState(pi, pluginRoot, ctx);
	if (current !== captured.state) return false;
	if (current.runtime !== captured.runtime) return false;
	if (current.sessionId !== captured.sessionId) return false;
	if (current.root !== captured.root) return false;
	if (current.mode !== captured.mode) return false;
	return canonicalDir(ctx.cwd) === captured.root;
}

/**
 * Execute the captured command with Pi's native local PowerShell operations. `_cwd` from the tool
 * definition is deliberately ignored; the captured canonical root is the only cwd.
 */
async function executeCapturedCommand(
	frozen: ValidRequest,
	root: string,
	toolCallId: string,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<any> | undefined,
	ctx: ExtensionToolContext,
	createOperations: () => PowerShellOperations,
): Promise<{ result: AgentToolResult<unknown>; exitCode: number | null | undefined }> {
	const local = createOperations();
	let exitCode: number | null | undefined;
	const operations = {
		async exec(command: string, _cwd: string, options: Parameters<typeof local.exec>[2]) {
			if (command !== frozen.command) {
				throw new Error("sandbox_request: 执行命令与审批时捕获的命令不一致，已拒绝执行。");
			}
			const result = await local.exec(command, root, options);
			exitCode = result.exitCode;
			return result;
		},
	};
	const definition = createPowerShellToolDefinition(root, { operations });
	const params =
		frozen.timeoutSeconds === undefined
			? { command: frozen.command }
			: { command: frozen.command, timeout: frozen.timeoutSeconds };
	const result = await definition.execute(toolCallId, params, signal, onUpdate, ctx);
	return { result, exitCode };
}

/**
 * The parts of Pi's tool-render context this file uses. Declared locally: the package index exposes the
 * tool definition types but not `ToolRenderContext` itself, and a structural type keeps the reader
 * honest about what is actually touched (tool call id, cwd, key hints).
 */
export interface CardRenderContext {
	toolCallId: string;
	cwd?: string;
	keyHint(keybinding: string, description: string): string;
}

function isApprovalStatus(value: unknown): value is ApprovalStatus {
	return (
		value === "approved" ||
		value === "declined" ||
		value === "cancelled" ||
		value === "no-ui" ||
		value === "unavailable" ||
		value === "error"
	);
}

function livePhaseOf(status: ApprovalStatus): LiveApprovalPhase {
	return status === "approved" || status === "declined" || status === "cancelled" ? status : "error";
}

/**
 * A call row restored from session history has only the arguments, not the captured cwd/mode/timeout.
 * Those facts are hidden in that card (`facts: false`) and come from the result row right below,
 * instead of being invented here.
 */
function historicalRequest(args: unknown, context: CardRenderContext): OperationRequest {
	const partial = (args ?? {}) as Partial<SandboxRequestInput>;
	const locale = historicalApprovalLocale(context.toolCallId);
	const text = approvalStrings(locale);
	return {
		requestId: context.toolCallId,
		toolCallId: context.toolCallId,
		source: "model-tool",
		sourceLabel: text.modelSource(context.toolCallId),
		command: typeof partial.command === "string" ? partial.command : text.missingCommand,
		requestReason: typeof partial.reason === "string" ? partial.reason : text.missingReason,
		cwd: context.cwd ?? "",
		mode: "workspace-write",
		...(typeof partial.timeout === "number" ? { timeoutSeconds: partial.timeout } : {}),
		...(locale === undefined ? {} : { locale }),
	};
}

/** Text blocks this tool adds itself; the output preview below the card skips them (no repetition). */
const SELF_TEXT_PREFIXES = ["[sandbox_request]", "===== 用户补充指令", "===== Human instruction", "警告：", "Warning: "];

/**
 * The approved command's output, rendered like Pi's own tool-result fallback (10-line preview with
 * the configured expand hint), so a custom result renderer does not cost the user the output view.
 */
function toolOutputComponent(
	content: unknown,
	expanded: boolean,
	theme: Theme,
	context: CardRenderContext,
): Text | undefined {
	const blocks = Array.isArray(content) ? content : [];
	const texts: string[] = [];
	for (const block of blocks) {
		if (block === null || typeof block !== "object") continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type !== "text" || typeof candidate.text !== "string") continue;
		const text = candidate.text;
		if (SELF_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix))) continue;
		// Sanitize per line: `replaceControlCharacters` would also flatten real newlines.
		texts.push(
			text
				.replace(/\r/g, "")
				.split("\n")
				.map((line) => replaceControlCharacters(stripTerminalSequences(line)))
				.join("\n"),
		);
	}
	const output = texts.join("\n");
	if (output.length === 0) return undefined;
	const lines = output.split("\n");
	const displayLines = expanded ? lines : lines.slice(0, 10);
	const remaining = lines.length - displayLines.length;
	let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return new Text(text, 0, 0);
}

function approvalSummary(decision: ApprovalDecision, request: { cwd: string; mode: SandboxMode }): string {
	const locale = resolveLocale(decision.locale);
	if (locale === "en") {
		return [
			`[${SANDBOX_REQUEST_TOOL}] Approved: ${decision.option ?? "Yes"}.`,
			`Execution: off (no sandbox), this run only; cwd=${request.cwd}; session mode stays ${request.mode}.`,
			"See the execution result below; handle any human instruction returned with it.",
		].join("\n");
	}
	const lines = [
		`[${SANDBOX_REQUEST_TOOL}] 审批通过：${decision.option ?? "Yes"}。`,
		`执行方式：off（不经过沙盒），仅本次；cwd=${request.cwd}；会话模式保持 ${request.mode}。`,
		"本次操作的执行结果见下方；请处理随结果返回的用户补充指令。",
	];
	return lines.join("\n");
}

export interface SandboxRequestToolOptions {
	/**
	 * Operations used for the approved execution. Defaults to Pi's own local PowerShell backend.
	 * A test can inject an in-process implementation; production always uses the default.
	 */
	createOperations?: () => PowerShellOperations;
}

export function registerSandboxRequestTool(
	pi: ExtensionAPI,
	pluginRoot: string,
	options: SandboxRequestToolOptions = {},
): void {
	const createOperations = options.createOperations ?? createLocalPowerShellOperations;
	pi.registerTool({
		name: SANDBOX_REQUEST_TOOL,
		label: "sandbox_request (one-shot unrestricted, needs human approval)",
		description:
			"Request one exact PowerShell command and run it immediately once, with off (no sandbox). " +
			"The command and the reason are required. The approval covers only this command and the session's canonical root; " +
			"it does not change the /sandbox mode and grants nothing to later write/edit/powershell calls. " +
			"An approval runs the command at once and returns its output; a decline or a cancel runs nothing. " +
			"The human can choose \"No, and reason…\" to decline and give a new direction, or \"Yes, and reason…\" to approve " +
			"with a requirement to complete after this operation; either text reaches you as a user instruction and is marked in this call's tool result. " +
			"Use this tool only when the operation needs to go outside the authorized root or the kernel would refuse it, or when a sandboxed command has already failed clearly; " +
			"never re-run a command that already ran just because stderr looks like a refusal. " +
			"A sandbox runner that failed to initialize (windows-acl-run / workspace not ready) is not an escape hatch this tool can fix.",
		promptSnippet: "Request one unrestricted one-shot execution, approved by a human whose text is your instruction",
		promptGuidelines: [
			"Prefer the already-sandboxed powershell/write/edit tools; call sandbox_request only when the operation genuinely needs to write outside the authorized root, or when it is one concrete action the kernel would refuse.",
			"sandbox_request needs a human approval and executes immediately once approved; it does not change the session mode and grants nothing to later tool calls.",
			"Your reason argument is only your request reason, shown to the approver; text the human types into the approval window is a user instruction to you. Never conflate the two.",
			"If the approval is \"No, and reason…\": that command is declined and will not run, and the human's text is a new user instruction for the current task. Do not resubmit the same command and do not end the task as if it were an ordinary error; replan from the new instruction and continue with the ordinary sandboxed tools. If the new direction still needs to go out of bounds, submit a new exact command and wait for a new approval.",
			"If the approval is \"Yes, and reason…\": that command is approved and runs exactly once. When the execution result (success or failure) is in, first report the facts truthfully (exit code, output, side effects), then complete the requirement the human wrote (for example explain the intent, effect and result of the operation), then continue the current task.",
			"The human's text only governs your next behaviour and never rewrites the command that was displayed: do not splice it into PowerShell, and do not run any command that was not shown in the approval window.",
			"Respect a decline or a cancel: do not automatically request the same command again; after adjusting to the new instruction, submit a fresh request only if it is genuinely needed.",
			"Do not fall back to sandbox_request just because an ordinary command failed or stderr mentions permissions; first establish whether the command has already produced side effects.",
			"If the failure is the sandbox runner itself failing to initialize (`windows-acl-run:` / runner-failure / workspace readiness), do not bypass it with sandbox_request: one-shot execution neither fixes the workspace nor the runner, and a request per command only creates an approval storm. Report the diagnostics (including the workspace readiness result of /sandbox doctor) to the human, and retry the same command with the ordinary sandboxed tool once it is fixed.",
		],
		// The card in the message stream owns the wording: the row renders its own frame, so it stays
		// one yellow block instead of a themed tool shell with mixed toolTitle/accent/dim colors.
		renderShell: "self",
			renderCall(args, theme, context) {
			const live = getLiveApproval(context.toolCallId);
			if ((!live || live.phase === "pending") && typeof context.invalidate === "function") {
				watchLiveApproval(context.toolCallId, () => context.invalidate());
			}
			const request = live?.request ?? historicalRequest(args, context);
			const pending = live?.phase === "pending";
			return new ApprovalCardComponent(theme, () => {
				const lines = [
					...operationCardLines(request, { facts: live !== undefined }),
				];
				if (pending) lines.push(...operationCardStatusLines("pending", APPROVAL_OPTIONS, undefined, undefined, request.locale));
				return lines;
			});
		},
		renderResult(result, options, theme, context) {
			const details = (result.details ?? {}) as Partial<SandboxRequestDetails>;
			const text = approvalStrings(details.locale);
			// Keep the captured locale for a later redraw even if the live row was already evicted.
			rememberHistoricalApprovalLocale(details.toolCallId ?? context.toolCallId, details.locale);
			const card = new ApprovalCardComponent(theme, () =>
				resultCardLines({
					status: isApprovalStatus(details.decision) ? details.decision : "error",
					...(details.locale === undefined ? {} : { locale: details.locale }),
					...(details.option === undefined ? {} : { option: details.option }),
					...(details.decisionReason === undefined ? {} : { decisionReason: details.decisionReason }),
					executed: details.executed === true,
					...(details.cwd === undefined ? {} : { cwd: details.cwd }),
					...(details.mode === undefined ? {} : { mode: details.mode }),
					...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
					...(details.requestId === undefined ? {} : { requestId: details.requestId }),
					...(details.executionError === undefined ? {} : { detail: `${text.errorPrefix}${details.executionError}` }),
					extra: details.auditError === undefined ? [] : [`${text.auditWarningPrefix}${details.auditError}`],
				}),
			);
			const output = toolOutputComponent(result.content, options.expanded, theme, context);
			if (!output) return card;
			const container = new Container();
			container.addChild(card);
			container.addChild(output);
			return container;
		},
		parameters: sandboxRequestParameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const requestId = randomUUID();
			// Pinned for the whole request: the card, dock, decision, result and persisted details all
			// use this one value, so an approval cannot switch language halfway through.
			const locale = detectLocaleFromSession(ctx.sessionManager);
			const validated = validateInput(params);
			if (!validated.ok) {
				return errorResult(`参数无效：${validated.message}`, {
					requestId,
					toolCallId,
					source: "model-tool",
					locale,
					cwd: canonicalDir(ctx.cwd),
					mode: "workspace-write",
					decision: "error",
					executed: false,
					executionError: validated.message,
				});
			}
			const frozen = validated;
			const commandHash = sha256(frozen.command);
			const requestReasonHash = sha256(frozen.requestReason);

			let state: SessionState;
			try {
				state = getSessionState(pi, pluginRoot, ctx);
			} catch (error) {
				return errorResult(`无法读取会话沙盒状态，未执行：${errorMessage(error)}`, {
					requestId,
					toolCallId,
					source: "model-tool",
					locale,
					cwd: canonicalDir(ctx.cwd),
					mode: "workspace-write",
					decision: "error",
					executed: false,
					executionError: errorMessage(error),
				});
			}
			const captured = identityOf(state, ctx);
			const sourceLabel = approvalStrings(locale).modelSource(toolCallId);
			const baseDetails: SandboxRequestDetails = {
				requestId,
				toolCallId,
				source: "model-tool",
				locale,
				cwd: captured.root,
				mode: state.mode,
				decision: "cancelled",
				executed: false,
			};
			const effectiveSignal = signal ?? ctx.signal;
			if (state.runtime.configError) {
				return errorResult(`配置错误，未执行：${state.runtime.configError.message}`, {
					...baseDetails, decision: "error", executionError: state.runtime.configError.message,
				});
			}

			// Capture the exact request once. The same object feeds the approval UI, the yellow card in
			// the message stream (`renderCall` reads it back by tool call id) and the audit record.
			const request: OperationRequest = {
				requestId,
				toolCallId,
				source: "model-tool",
				sourceLabel,
				locale,
				command: frozen.command,
				requestReason: frozen.requestReason,
				cwd: captured.root,
				mode: state.mode,
				...(frozen.timeoutSeconds === undefined ? {} : { timeoutSeconds: frozen.timeoutSeconds }),
			};
			registerLiveApproval(request);
			const decision = await requestOperationApproval(ctx, request, {
				...(effectiveSignal ? { signal: effectiveSignal } : {}),
			});
			updateLiveApprovalPhase(request, livePhaseOf(decision.status));

			// The human's approval text is the instruction for this task, not commentary. It reaches the
			// model through this tool result: Pi's agent loop reads the returned content and continues,
			// so this path must not also push a user message (that would duplicate the instruction).
			const instruction = userInstructionOf(decision);
			const instructions = instructionDetails(instruction);
			const instructionContext: InstructionContext = {
				locale,
				sourceLabel,
				facts: [
					locale === "en"
						? `This command's cwd: ${captured.root} (pinned); session mode stays ${state.mode}.`
						: `本次命令的 cwd：${captured.root}（固定）；会话模式保持 ${state.mode}。`,
				],
			};
			const instructionTextFor = (outcome: InstructionOutcome): string | undefined =>
				instruction ? toolInstructionText(instruction, outcome, instructionContext) : undefined;

			const auditBase: AuditInput = {
				requestId,
				toolCallId,
				phase: "decision",
				decision: decision.status,
				locale,
				...(decision.option === undefined ? {} : { option: decision.option }),
				...(decision.decisionReason === undefined ? {} : { decisionReason: decision.decisionReason }),
				...(instruction === undefined ? {} : { reasonSource: instruction.source }),
				cwd: captured.root,
				mode: captured.mode,
				commandHash,
				requestReasonHash,
			};
			const decisionAuditError = writeAudit(pi, auditBase);

			const details: SandboxRequestDetails = {
				...baseDetails,
				decision: decision.status,
				...(decision.option === undefined ? {} : { option: decision.option }),
				...(decision.decisionReason === undefined ? {} : { decisionReason: decision.decisionReason }),
				...instructions,
				...(decisionAuditError === undefined ? {} : { auditError: decisionAuditError }),
			};

			if (decision.status !== "approved") {
				return errorResult(
					`未执行。${decisionNote(decision)}` +
						`\n申请的命令（未执行）：\n${frozen.command}` +
						(decisionAuditError ? `\n警告：审计记录写入失败：${decisionAuditError}` : ""),
					details,
					[instructionTextFor("declined")],
				);
			}

			// The user may have approved just as the turn/session was cancelled. A late "Yes" is not a
			// grant: check before execution and re-check identity after the dialog.
			if (effectiveSignal?.aborted) {
				writeAudit(pi, {
					...auditBase,
					phase: "result",
					decision: "cancelled",
					executed: false,
					executionError: "signal aborted after approval",
				});
				return errorResult(
					"未执行：审批通过后请求已被取消（晚到的批准无效）。",
					{ ...details, decision: "cancelled", executed: false, executionError: "aborted after approval" },
					[instructionTextFor("not-executed")],
				);
			}
			if (!identityStillMatches(pi, pluginRoot, ctx, captured)) {
				writeAudit(pi, {
					...auditBase,
					phase: "result",
					decision: "cancelled",
					executed: false,
					executionError: "session/root/runtime changed before execution",
				});
				return errorResult(
					"未执行：审批期间会话、授权根或扩展运行时已变化，或沙盒模式已切换，本次批准作废。",
					{
						...details,
						decision: "cancelled",
						executed: false,
						executionError: "stale session/root/runtime",
					},
					[instructionTextFor("not-executed")],
				);
			}
			if (decisionAuditError) {
				// Without a durable audit record we do not run an unrestricted command.
				return errorResult(
					`未执行：批准后的审计记录写入失败（fail-closed）：${decisionAuditError}`,
					{ ...details, executed: false, executionError: decisionAuditError },
					[instructionTextFor("not-executed")],
				);
			}

			const startedAt = Date.now();
			let execution: { result: AgentToolResult<unknown>; exitCode: number | null | undefined };
			try {
				execution = await executeCapturedCommand(
					frozen,
					captured.root,
					toolCallId,
					effectiveSignal,
					onUpdate,
					ctx,
					createOperations,
				);
			} catch (error) {
				const message = errorMessage(error);
				const durationMs = Date.now() - startedAt;
				const resultAuditError = writeAudit(pi, {
					...auditBase,
					phase: "result",
					executed: true,
					executionError: message,
				});
				return errorResult(
					`审批已通过，命令在 off 下开始执行，但执行未正常完成：${message}` +
						`\n命令（已尝试执行，可能已产生副作用，不会自动重试）：\n${frozen.command}` +
						(resultAuditError ? `\n警告：执行结果审计写入失败（命令已执行）：${resultAuditError}` : ""),
					{
						...details,
						executed: true,
						durationMs,
						executionError: message,
						...(resultAuditError === undefined ? {} : { auditError: resultAuditError }),
					},
					[instructionTextFor("execution-failed")],
				);
			}

			const native = execution.result;
			const durationMs = Date.now() - startedAt;
			const nativeDetails = (native.details ?? {}) as { truncation?: unknown; fullOutputPath?: string };
			const resultAuditError = writeAudit(pi, {
				...auditBase,
				phase: "result",
				executed: true,
				...(execution.exitCode === undefined ? {} : { exitCode: execution.exitCode }),
			});
			const summary = approvalSummary(decision, { cwd: captured.root, mode: state.mode });
			const warning = resultAuditError ? `警告：执行结果审计写入失败（命令已在 off 下执行）：${resultAuditError}` : undefined;
			const content = Array.isArray(native.content) ? [...native.content] : [];
			// Facts first, then the human's supplementary requirement (when they gave one), then the
			// native command output, so "report what happened, then do what the user asked" is explicit.
			const head: Array<{ type: "text"; text: string }> = [{ type: "text", text: summary }];
			const postExecutionInstruction = instructionTextFor("executed");
			if (postExecutionInstruction !== undefined) head.push({ type: "text", text: postExecutionInstruction });
			content.unshift(...head);
			if (warning) content.push({ type: "text", text: warning });
			return {
				content,
				details: {
					...nativeDetails,
					...details,
					executed: true,
					durationMs,
					...(execution.exitCode === undefined ? {} : { exitCode: execution.exitCode }),
					...(resultAuditError === undefined ? {} : { auditError: resultAuditError }),
				},
				...(native.isError === undefined ? {} : { isError: native.isError }),
			} as AgentToolResult<SandboxRequestDetails>;
		},
	});
}
