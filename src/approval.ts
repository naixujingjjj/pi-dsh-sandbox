/**
 * One-shot operation approval, shared by the model-facing `sandbox_request` tool and the human
 * `/sandbox exec` command.
 *
 * Design rules:
 *
 * - Every request is approved through four explicit choices. A bare "Yes" never becomes a grant
 *   for anything else: the caller captures the exact command and cwd before waiting, and the
 *   approval object it gets back is only a value it can use for that one execution.
 * - The approval text (`decisionReason`) is the human's instruction to the agent, not a passive
 *   remark: "No, and reason…" both refuses this operation and hands the model a new direction for
 *   the current task; "Yes, and reason…" approves this operation and states what the model must do
 *   after it finishes. It is authored only by the human approval UI — never derived from the
 *   model's `requestReason` — and it never rewrites the command or becomes part of the command
 *   string (see `src/reason.ts`).
 * - There is no persistent grant, no global "approved once" flag and no mode change here. Two
 *   concurrent approvals each hold their own request object; nothing is shared.
 * - Cancellation, a missing UI, a dialog error, ESC/undefined, a blank reason, or an abort before or
 *   during the dialog all resolve to "not approved". A late "Yes" after the signal fired is ignored.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { operationCardText } from "./tui/card.ts";
import {
	approvalStrings,
	reasonWording,
	resolveLocale,
	type Locale,
	type ReasonKey,
} from "./i18n.ts";
import { canOpenTuiPanel, requestTuiPanel, type PanelReasonSpec, type PanelSpec, type RunMode } from "./tui/panel.ts";
import type { SandboxMode } from "./policy.ts";

/** The four choices shown for every operation request. Order matters for tests and users. */
export const APPROVAL_OPTIONS = ["Yes", "No", "Yes, and reason…", "No, and reason…"] as const;
export type ApprovalOption = (typeof APPROVAL_OPTIONS)[number];

/** The two options that collect human text; used by `src/reason.ts` and the dialog wording. */
export const APPROVAL_APPROVE_REASON = "Yes, and reason…" satisfies ApprovalOption;
export const APPROVAL_DECLINE_REASON = "No, and reason…" satisfies ApprovalOption;
export type ApprovalReasonOption = typeof APPROVAL_APPROVE_REASON | typeof APPROVAL_DECLINE_REASON;

/**
 * Field wording per intent. The two inputs mean different things, so they must not share a label.
 */
export const APPROVAL_REASON_COMMENTS: Record<ApprovalReasonOption, { title: string; placeholder: string; description: string }> = {
	[APPROVAL_APPROVE_REASON]: reasonWording("zh", "approve"),
	[APPROVAL_DECLINE_REASON]: reasonWording("zh", "decline"),
};

/** True when the option is one of the two that collect human text. */
export function isReasonOption(value: unknown): value is ApprovalReasonOption {
	return value === APPROVAL_APPROVE_REASON || value === APPROVAL_DECLINE_REASON;
}

export const APPROVAL_AUDIT_ENTRY = "pi-dsh-sandbox/approval";

export type ApprovalStatus = "approved" | "declined" | "cancelled" | "no-ui" | "unavailable" | "error";
export type ApprovalSource = "model-tool" | "human-command";

export interface OperationRequest {
	/** Unique id for this request; also recorded in the audit entry. */
	requestId: string;
	/** Pi tool call id when the request came from the model tool. */
	toolCallId?: string;
	source: ApprovalSource;
	/** Shown verbatim in the dialog, for example "模型工具 sandbox_request". */
	sourceLabel: string;
	/** The exact command shown to the user and executed after approval (never rewritten). */
	command: string;
	/** Why the request exists. Model-authored text; displayed as data, never as an instruction. */
	requestReason: string;
	/** Canonical session root: the only cwd used for the approved execution. */
	cwd: string;
	/** Sandbox mode at request time (display only; the request never changes it). */
	mode: SandboxMode;
	/** Optional requested timeout in seconds. */
	timeoutSeconds?: number;
	/**
	 * UI language captured from the conversation branch when the request was made. Pinned onto the
	 * live card, the decision and the result so one approval cannot change language mid-flight.
	 * Optional for requests created before 0.4.0; missing means Chinese.
	 */
	locale?: Locale;
}

export interface ApprovalDecision {
	status: ApprovalStatus;
	/** The selected label, when the user made a recognizable choice. */
	option?: ApprovalOption;
	/**
	 * Text the human typed into the approval UI. It is the agent's instruction (new direction after
	 * a decline, supplementary requirement after an approval); it never modifies the command.
	 */
	decisionReason?: string;
	/** Short human-readable explanation of the outcome. */
	detail: string;
	/** Locale captured with the request; legacy/absent decisions are reported in Chinese. */
	locale?: Locale;
}

/** The minimal UI surface this module needs. Structural so unit tests need no Pi runtime. */
export interface ApprovalUiContext {
	/** Pi run mode; the floating TUI panel is only used for `"tui"`. */
	mode?: RunMode;
	hasUI?: boolean;
	ui?: Partial<
		Pick<ExtensionUIContext, "select" | "input" | "custom" | "setWidget" | "onTerminalInput">
	>;
}

export interface ApprovalPromptOptions {
	signal?: AbortSignal;
}

/** Do not depend on every UI transport honoring its dialog signal. Late replies are ignored. */
function awaitDialog<T>(open: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const onAbort = () => {
			cleanup();
			reject(new Error("approval cancelled"));
		};
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		Promise.resolve().then(() => {
			if (signal?.aborted) throw new Error("approval cancelled");
			return open();
		}).then((value) => {
			cleanup();
			resolve(value);
		}, (error) => {
			cleanup();
			reject(error);
		});
	});
}

function isApprovalOption(value: unknown): value is ApprovalOption {
	return typeof value === "string" && (APPROVAL_OPTIONS as readonly string[]).includes(value);
}

/**
 * Render the complete request as plain text. The command is placed between literal markers and is
 * never truncated; the reason is labelled as request text so a model cannot make it look like a
 * system instruction.
 *
 * This is also the title of the plain `ui.select` used by RPC/print, so it is pure text: the TUI
 * card adds its color on top and the RPC protocol never sees an ANSI escape.
 */
export function renderApprovalMessage(request: OperationRequest): string {
	return operationCardText(request);
}

/**
 * Ask the user for a decision. Never executes anything and never stores a grant.
 *
 * In the interactive TUI the four choices are asked in a small floating dock while the full request
 * is a yellow card in the message stream (`src/tui/`). RPC, JSON and print keep the plain
 * `select`/`input` protocol, so their behavior, wording and transport stay byte-identical and never
 * carry ANSI escapes. If the TUI panel cannot be created, the plain dialogs are used as a visible,
 * explicit fallback — never an automatic approval.
 */
export async function requestOperationApproval(
	ctx: ApprovalUiContext,
	request: OperationRequest,
	options: ApprovalPromptOptions = {},
): Promise<ApprovalDecision> {
	const locale = resolveLocale(request.locale);
	const text = approvalStrings(locale);
	const signal = options.signal;
	if (signal?.aborted) {
		return { status: "cancelled", locale, detail: text.cancelledBefore };
	}
	if (ctx.hasUI !== true) {
		return {
			status: "no-ui",
			locale,
			detail: text.noUi,
		};
	}
	if (canOpenTuiPanel(ctx)) {
		const decision = await requestTuiOperationApproval(ctx, request, signal);
		if (decision !== undefined) return decision;
	}
	return requestNativeOperationApproval(ctx, request, signal);
}

/**
 * Map one panel outcome to the same `ApprovalDecision` values the plain picker produces, so the
 * audit trail, tool result and notification wording cannot diverge between transports.
 */
async function requestTuiOperationApproval(
	ctx: ApprovalUiContext,
	request: OperationRequest,
	signal: AbortSignal | undefined,
): Promise<ApprovalDecision | undefined> {
	const locale = resolveLocale(request.locale);
	const text = approvalStrings(locale);
	const outcome = await requestTuiPanel(ctx, approvalPanelSpec(request), {
		...(signal ? { signal } : {}),
	});
	if (outcome.kind === "unavailable") return undefined;
	if (signal?.aborted) {
		return { status: "cancelled", locale, detail: text.lateCancelled };
	}
	if (outcome.kind === "cancelled") {
		return { status: "cancelled", locale, detail: text.escCancelled };
	}
	if (outcome.kind === "reason-cancelled") {
		const choice = APPROVAL_OPTIONS[outcome.index];
		const wording = choice === undefined || !isReasonOption(choice)
			? undefined
			: reasonWording(locale, reasonKeyOf(choice));
		return {
			status: "cancelled",
			locale,
			...(choice === undefined ? {} : { option: choice }),
			detail: text.reasonCancelled(wording?.title ?? text.titleShort),
		};
	}
	const choice = APPROVAL_OPTIONS[outcome.index];
	if (!isApprovalOption(choice)) {
		return {
			status: "error",
			locale,
			detail: `${text.unknownChoicePrefix}${JSON.stringify(outcome.index)}${text.unknownChoiceSuffix}`,
		};
	}
	const reason = outcome.reason;
	return decisionForChoice(choice, locale, reason === undefined || reason.length === 0 ? undefined : reason);
}

/** The dock content for one operation request: choices only; the card carries the details. */
export function approvalPanelSpec(request: OperationRequest): PanelSpec {
	const locale = resolveLocale(request.locale);
	const text = approvalStrings(locale);
	const timeout = request.timeoutSeconds === undefined ? "" : ` · ${text.timeoutPrefix}${request.timeoutSeconds}${text.timeoutSuffix}`;
	return {
		title: text.title,
		header: [
			`${text.panelSourcePrefix}${request.sourceLabel}`,
			text.panelCardPointer,
			`${text.cwdPrefix}${request.cwd} · ${text.panelRunOff} · ${text.panelModeHeld}${request.mode}${timeout}`,
		],
		options: [...APPROVAL_OPTIONS],
		defaultIndex: 0,
		reasonFor: {
			2: panelReasonSpec(APPROVAL_APPROVE_REASON, locale),
			3: panelReasonSpec(APPROVAL_DECLINE_REASON, locale),
		},
		panelKey: `${APPROVAL_PANEL_KEY_PREFIX}${request.requestId}`,
		blockedMessage: `${text.title}${text.panelBlockedSuffix}`,
		locale,
	};
}

export const APPROVAL_PANEL_KEY_PREFIX = "pi-dsh-sandbox-approval:";

function reasonKeyOf(option: ApprovalReasonOption): ReasonKey {
	return option === APPROVAL_APPROVE_REASON ? "approve" : "decline";
}

function panelReasonSpec(option: ApprovalReasonOption, locale: Locale): PanelReasonSpec {
	const wording = reasonWording(locale, reasonKeyOf(option));
	return { title: wording.title, placeholder: wording.placeholder, note: wording.note };
}

function decisionForChoice(choice: ApprovalOption, locale: Locale, decisionReason?: string): ApprovalDecision {
	const text = approvalStrings(locale);
	if (choice === "Yes" || choice === APPROVAL_APPROVE_REASON) {
		return {
			status: "approved",
			option: choice,
			...(decisionReason === undefined ? {} : { decisionReason }),
			detail: text.approvedDetail,
			locale,
		};
	}
	return {
		status: "declined",
		option: choice,
		...(decisionReason === undefined ? {} : { decisionReason }),
		detail: text.declinedDetail,
		locale,
	};
}

/** The plain picker path used by RPC/JSON/print, and as the fallback when no TUI panel exists. */
async function requestNativeOperationApproval(
	ctx: ApprovalUiContext,
	request: OperationRequest,
	signal: AbortSignal | undefined,
): Promise<ApprovalDecision> {
	const locale = resolveLocale(request.locale);
	const text = approvalStrings(locale);
	const select = ctx.ui?.select;
	const input = ctx.ui?.input;
	if (typeof select !== "function" || typeof input !== "function") {
		return {
			status: "unavailable",
			locale,
			detail: text.unavailable,
		};
	}

	let choice: string | undefined;
	try {
		choice = await awaitDialog(() => select.call(ctx.ui, renderApprovalMessage(request), [...APPROVAL_OPTIONS], {
			...(signal ? { signal } : {}),
		}), signal);
	} catch (error) {
		if (signal?.aborted) return { status: "cancelled", locale, detail: text.cancelledWhileWaiting };
		return { status: "error", locale, detail: `${text.dialogFailedPrefix}${errorText(error)}` };
	}
	if (signal?.aborted) {
		return { status: "cancelled", locale, detail: text.lateCancelled };
	}
	if (choice === undefined) {
		return { status: "cancelled", locale, detail: text.escCancelled };
	}
	if (!isApprovalOption(choice)) {
		return { status: "error", locale, detail: `${text.unknownChoicePrefix}${JSON.stringify(choice)}${text.unknownChoiceSuffix}` };
	}

	let decisionReason: string | undefined;
	if (isReasonOption(choice)) {
		const wording = reasonWording(locale, reasonKeyOf(choice));
		let answer: string | undefined;
		try {
			answer = await awaitDialog(
				() => input.call(ctx.ui, wording.description, wording.placeholder, { ...(signal ? { signal } : {}) }),
				signal,
			);
		} catch (error) {
			if (signal?.aborted) return { status: "cancelled", option: choice, locale, detail: text.cancelledWhileWaiting };
			return { status: "error", option: choice, locale, detail: `${text.inputFailedPrefix}${errorText(error)}` };
		}
		if (signal?.aborted) {
			return {
				status: "cancelled",
				option: choice,
				locale,
				detail: text.lateCancelled,
			};
		}
		if (typeof answer !== "string" || answer.trim().length === 0) {
			return {
				status: "cancelled",
				option: choice,
				locale,
				detail: text.reasonCancelled(wording.title),
			};
		}
		decisionReason = answer.trim();
	}

	return decisionForChoice(choice, locale, decisionReason);
}

/** Compact summary for notifications and tool output. */
export function describeDecision(decision: ApprovalDecision): string {
	const text = approvalStrings(decision.locale);
	const parts: string[] = [decision.status];
	if (decision.option) parts.push(decision.option);
	if (decision.decisionReason !== undefined) parts.push(`${text.humanInstructionPrefix}${decision.decisionReason}`);
	return parts.join(text.listSeparator);
}

/** One-line detail for a tool result / notification. */
export function decisionNote(decision: ApprovalDecision): string {
	const text = approvalStrings(decision.locale);
	const suffix = decision.option === undefined ? "" : `${text.optionWrapOpen}${decision.option}`;
	if (decision.decisionReason !== undefined) {
		return `${decision.detail}${suffix}${decision.option === undefined ? text.optionWrapOpen : text.reasonSeparator}${text.humanInstructionPrefix}${decision.decisionReason}${text.optionWrapClose}`;
	}
	return decision.option === undefined ? decision.detail : `${decision.detail}${suffix}${text.optionWrapClose}`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
