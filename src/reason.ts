/**
 * The human approval text (`decisionReason`) as an instruction for the agent.
 *
 * The approval window has two text fields with different jobs:
 *
 * - `No, and reason…` → "拒绝原因或新的执行方向". The command is **not** executed and the text
 *   becomes a **new user instruction for the current task**: the model replans from it and keeps
 *   working, without the user retyping the task. If the new direction needs another out-of-bounds
 *   operation, that operation needs its own approval.
 * - `Yes, and reason…` → "本次操作完成后的补充要求". The displayed command is approved and
 *   executed exactly once, then the model must report what actually happened and fulfil the
 *   requirement (for example: explain the intent, effect and result of the operation).
 *
 * Rules encoded here:
 *
 * - The text is human-authored (approval UI only). It is never derived from the model's
 *   `requestReason`, and it never becomes part of the command string.
 * - The text only reaches the model as instruction text: in the tool result content/details for
 *   `sandbox_request`, and as one Pi user message (`pi.sendUserMessage`, `deliverAs: "followUp"`)
 *   for the human `/sandbox exec` path — where the model never sees a tool result at all.
 * - Nothing here executes anything; the modules that call it keep their own snapshot and approval
 *   checks.
 */
import { APPROVAL_APPROVE_REASON, APPROVAL_DECLINE_REASON, type ApprovalDecision } from "./approval.ts";
import { reasonStrings, type Locale } from "./i18n.ts";

export type UserInstructionKind = "decline-direction" | "approve-requirement";

/** How the model is expected to continue after the approval. */
export type Continuation = "replan-from-user-direction" | "complete-user-requirement";

/**
 * What actually happened to the approved/declined operation. The instruction text stays the same;
 * the report the model owes the user differs, so the wording differs.
 */
export type InstructionOutcome = "declined" | "executed" | "not-executed" | "execution-failed";

export interface UserInstruction {
	/** Text always comes from the human approval dialog, never from the model. */
	source: "human-approval-ui";
	kind: UserInstructionKind;
	/** Verbatim text the human typed (already trimmed, never empty). */
	text: string;
	/** The four-option label the human chose. */
	option: string;
	continuation: Continuation;
}

export interface InstructionContext {
	/** Language captured with the approval; the user's own text is never translated. */
	locale?: Locale;
	/** Human-facing description of where the approval came from. */
	sourceLabel: string;
	/** The exact command shown to the human (only needed when the model never saw it). */
	command?: string;
	/** Short fact lines such as cwd/mode/exit code, already formatted. */
	facts?: readonly string[];
	/** Output excerpt (already truncated) for the human-command path. */
	excerpt?: string;
}

export const INSTRUCTION_BEGIN = "----- BEGIN USER INSTRUCTION -----";
export const INSTRUCTION_END = "----- END USER INSTRUCTION -----";

/** `undefined` when the human chose a plain Yes/No or not one of the two "and reason…" options. */
export function userInstructionOf(decision: ApprovalDecision): UserInstruction | undefined {
	const text = typeof decision.decisionReason === "string" ? decision.decisionReason.trim() : "";
	if (text.length === 0) return undefined;
	if (decision.option === APPROVAL_DECLINE_REASON) {
		return {
			source: "human-approval-ui",
			kind: "decline-direction",
			text,
			option: decision.option,
			continuation: "replan-from-user-direction",
		};
	}
	if (decision.option === APPROVAL_APPROVE_REASON) {
		return {
			source: "human-approval-ui",
			kind: "approve-requirement",
			text,
			option: decision.option,
			continuation: "complete-user-requirement",
		};
	}
	return undefined;
}

function outcomeLine(instruction: UserInstruction, outcome: InstructionOutcome, locale: Locale): string {
	const text = reasonStrings(locale);
	if (instruction.kind === "decline-direction") {
		return text.declinedLine(instruction.option);
	}
	switch (outcome) {
		case "executed":
			return text.executedLine(instruction.option);
		case "execution-failed":
			return text.failedLine(instruction.option);
		case "not-executed":
			return text.notExecutedLine(instruction.option);
		default:
			return text.approvedLine(instruction.option);
	}
}

function requirementFollowUp(outcome: InstructionOutcome, locale: Locale): readonly string[] {
	const text = reasonStrings(locale);
	if (outcome === "executed") return text.requirementExecuted;
	if (outcome === "execution-failed") return text.requirementFailed;
	return text.requirementNotExecuted;
}

/**
 * Tool-result text for `sandbox_request`. This is the model's only carrier for the instruction, so
 * it must state its origin, the approval fact and what the model has to do next.
 */
export function toolInstructionText(
	instruction: UserInstruction,
	outcome: InstructionOutcome,
	context: InstructionContext,
): string {
	const locale = context.locale ?? "zh";
	const text = reasonStrings(locale);
	const heading =
		instruction.kind === "decline-direction" ? text.headingDecline : text.headingApprove;
	const lines = [
		heading,
		`${text.originPrefix}${context.sourceLabel}.`,
		`${text.resultPrefix}${outcomeLine(instruction, outcome, locale)}`,
		...(context.facts ?? []),
		"",
		text.verbatimLabel,
		INSTRUCTION_BEGIN,
		instruction.text,
		INSTRUCTION_END,
		"",
		text.followInstruction,
	];
	lines.push(...(instruction.kind === "decline-direction" ? text.declineFollowUp : requirementFollowUp(outcome, locale)));
	return lines.join("\n");
}

/**
 * One Pi user message for the human `/sandbox exec` path. The model never sees a tool result
 * there, so the message carries the approval facts, the exact command that was (or was not) run and
 * the human's instruction. It is delivered with `deliverAs: "followUp"`, so an approved command
 * that is already running is never cancelled or steered by it.
 */
export function humanFollowUpMessage(
	instruction: UserInstruction,
	outcome: InstructionOutcome,
	context: InstructionContext,
): string {
	const locale = context.locale ?? "zh";
	const text = reasonStrings(locale);
	const lines = [
		text.humanHeading,
		"",
		`${text.humanSourcePrefix}${context.sourceLabel}`,
		`${text.humanResultPrefix}${outcomeLine(instruction, outcome, locale)}`,
	];
	if (context.command !== undefined) {
		lines.push(
			"",
			text.humanCommandLabel,
			"----- BEGIN COMMAND -----",
			context.command,
			"----- END COMMAND -----",
		);
	}
	lines.push(...(context.facts ?? []));
	if (context.excerpt !== undefined && context.excerpt.length > 0) {
		lines.push("", text.humanOutputLabel, context.excerpt);
	}
	lines.push(
		"",
		text.humanInstructionLabel,
		INSTRUCTION_BEGIN,
		instruction.text,
		INSTRUCTION_END,
		"",
		text.followInstruction,
	);
	if (instruction.kind === "decline-direction") {
		lines.push(...text.humanDeclineLines);
	} else if (outcome === "executed") {
		lines.push(...text.humanExecutedLines);
	} else {
		lines.push(text.humanNotExecutedLine);
	}
	return lines.join("\n");
}

/** Structured fields copied into tool `details` so the UI/session record keeps the instruction. */
export function instructionDetails(instruction: UserInstruction | undefined): {
	reasonSource?: "human-approval-ui";
	userInstruction?: string;
	continuation?: Continuation;
} {
	if (instruction === undefined) return {};
	return {
		reasonSource: instruction.source,
		userInstruction: instruction.text,
		continuation: instruction.continuation,
	};
}
