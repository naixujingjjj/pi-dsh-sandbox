/**
 * The approval card: the full, untruncated request rendered **in the message stream**.
 *
 * Why it lives here and not in the dialog:
 *
 * - The user needs to re-read the preceding model output while approving. A dialog replaces the
 *   editor and its title is the only place the request fits; the transcript-owned card keeps the
 *   request where the conversation already is, so the terminal's own scrolling (wheel, PageUp, or
 *   the fullscreen viewport) shows both the model output and the request.
 * - The floating panel (see `panel.ts`) only carries the four choices and the key hints.
 *
 * The text of the card is built here once as plain strings and reused for:
 *
 * 1. the TUI card (`ApprovalCardComponent`),
 * 2. the plain `ui.select` title used by RPC/print transports (`renderApprovalMessage()`), and
 * 3. session entries, so a reloaded session can redraw the card from stored data.
 *
 * Rendering is ANSI-aware and width-safe (`wrapTextWithAnsi`/`truncateToWidth`), and every shown
 * string is stripped of terminal escape sequences and control characters: a command or reason is
 * data authored by the model, so it must not be able to paint the UI or fake a boundary marker.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	replaceControlCharacters,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { paintApproval, type ApprovalRole, type ApprovalTextLine } from "./theme.ts";
import { approvalStrings, type Locale } from "../i18n.ts";
import type { ApprovalSource, ApprovalStatus, OperationRequest } from "../approval.ts";

/** Widest line any approval surface draws; wider terminals get a readable block, not a full row. */
export const APPROVAL_MAX_WIDTH = 100;

/** Left gutter that makes the card a highlighted block without a heavyweight box. */
export const CARD_GUTTER = "▏ ";

/** Chinese title, kept as the documented default and for transports without a locale. */
export const APPROVAL_TITLE = approvalStrings("zh").title;

/**
 * Make model/human authored text safe to draw on **one** line: remove ANSI/OSC sequences (they would
 * let a command paint the terminal), then remaining control characters, and expand tabs so width math
 * holds. Newlines become spaces here; use {@link splitLines} to keep a multi-line block.
 * The executed command is still the original string; only the *display* is normalized.
 */
export function displayText(text: string): string {
	const expanded = text.replace(/\r\n|[\r\n]/g, " ").replace(/\t/g, "    ");
	return replaceControlCharacters(stripTerminalSequences(expanded));
}

function splitLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/).map((line) => displayText(line));
}

/**
 * The complete request, as plain role-tagged lines. Joining the texts with `\n` produces exactly
 * the message 0.2.2 showed in its `ui.select` title, so RPC keeps the same wording while the TUI
 * card adds its own status line.
 *
 * `facts: false` is used for a row restored from session history, where the captured cwd/mode/超时
 * were not persisted in the call arguments; the result row right below carries them instead of
 * inventing values.
 */
export function operationCardLines(
	request: OperationRequest,
	options: { facts?: boolean } = {},
): ApprovalTextLine[] {
	const facts = options.facts !== false;
	const text = approvalStrings(request.locale);
	const lines: ApprovalTextLine[] = [];
	lines.push({ role: "title", text: text.title });
	lines.push({ role: "body", text: "" });
	lines.push({ role: "label", text: `${text.sourcePrefix}${request.sourceLabel}` });
	lines.push({ role: "label", text: text.requestReasonLabel });
	for (const line of splitLines(request.requestReason.length > 0 ? request.requestReason : text.notProvided)) {
		lines.push({ role: "body", text: line });
	}
	lines.push({ role: "body", text: "" });
	lines.push({ role: "label", text: text.fullCommandLabel });
	lines.push({ role: "command", text: "----- BEGIN COMMAND -----" });
	for (const line of splitLines(request.command)) lines.push({ role: "command", text: line });
	lines.push({ role: "command", text: "----- END COMMAND -----" });
	lines.push({ role: "body", text: "" });
	if (facts) {
		lines.push({ role: "body", text: `${text.cwdPrefix}${displayText(request.cwd)}` });
		lines.push({ role: "body", text: `${text.sandboxModePrefix}${request.mode}${text.sandboxModeSuffix}` });
		if (request.timeoutSeconds !== undefined) {
			lines.push({ role: "body", text: `${text.timeoutPrefix}${request.timeoutSeconds}${text.timeoutSuffix}` });
		}
	} else {
		lines.push({ role: "hint", text: text.historyHint });
	}
	return lines;
}

/** The four choices, spelled exactly as the RPC picker spells them. */
export function optionLines(options: readonly string[], locale: Locale = "zh"): string {
	return `${approvalStrings(locale).optionsPrefix}${options.join(" · ")}`;
}

/** Extra lines the TUI card appends: what is happening now and where to answer. */
export function operationCardStatusLines(
	status: "pending" | "decided",
	options: readonly string[],
	decidedNote?: string,
	pendingNote?: string,
	locale: Locale = "zh",
): ApprovalTextLine[] {
	const text = approvalStrings(locale);
	if (status === "pending") {
		return [
			{
				role: "status",
				text: `${text.approvalStatusPrefix}${pendingNote ?? text.pendingChoice}`,
			},
			{ role: "option", text: optionLines(options, locale) },
			{ role: "hint", text: text.panelHint },
		];
	}
	return [
		{ role: "status", text: `${text.approvalStatusPrefix}${decidedNote ?? text.decidedFallback}` },
		{ role: "option", text: optionLines(options, locale) },
	];
}

export interface ResultCardInput {
	status: ApprovalStatus;
	/** Approval locale captured with the request; legacy results default to Chinese. */
	locale?: Locale;
	option?: string;
	source?: ApprovalSource;
	decisionReason?: string;
	executed: boolean;
	cwd?: string;
	mode?: string;
	exitCode?: number | null;
	requestId?: string;
	detail?: string;
	extra?: readonly string[];
}

/** Compact outcome card, appended below the request card once the request is settled. */
export function resultCardLines(input: ResultCardInput): ApprovalTextLine[] {
	const text = approvalStrings(input.locale);
	const lines: ApprovalTextLine[] = [];
	const option = input.option === undefined ? "" : `${text.optionWrapOpen}${input.option}${text.optionWrapClose}`;
	lines.push({ role: "title", text: `${text.resultTitlePrefix}${text.status[input.status]}${option}` });
	if (input.executed) {
		lines.push({
			role: "body",
			text: `${text.executedPrefix}${input.exitCode === undefined || input.exitCode === null ? "" : `${text.executedExit}${input.exitCode}`}`,
		});
	} else {
		lines.push({ role: "body", text: text.notExecuted });
	}
	if (input.cwd !== undefined) lines.push({ role: "body", text: `${text.cwdPrefix}${displayText(input.cwd)}` });
	if (input.mode !== undefined) lines.push({ role: "body", text: `${text.modeHeldPrefix}${input.mode}` });
	if (input.detail !== undefined && input.detail.length > 0) lines.push({ role: "body", text: input.detail });
	if (input.decisionReason !== undefined && input.decisionReason.length > 0) {
		lines.push({ role: "label", text: text.decisionReasonLabel });
		for (const line of splitLines(input.decisionReason)) lines.push({ role: "body", text: line });
	}
	if (input.requestId !== undefined) lines.push({ role: "hint", text: `${text.requestIdPrefix}${input.requestId}` });
	for (const line of input.extra ?? []) lines.push({ role: "body", text: line });
	return lines;
}

/** Card for a sandbox-mode widening confirmation (same yellow treatment, two options). */
export function modeWidenCardLines(input: {
	current: string;
	target: string;
	root: string;
	note: string;
	options: readonly string[];
	status: "pending" | "confirmed" | "cancelled";
	locale?: Locale;
}): ApprovalTextLine[] {
	const text = approvalStrings(input.locale);
	const lines: ApprovalTextLine[] = [];
	lines.push({ role: "title", text: text.widenTitle });
	lines.push({ role: "body", text: "" });
	lines.push({ role: "body", text: `${text.currentPrefix}${input.current}` });
	lines.push({ role: "body", text: `${text.targetPrefix}${input.target}` });
	lines.push({ role: "body", text: `${text.rootPrefix}${displayText(input.root)}` });
	lines.push({ role: "body", text: "" });
	for (const line of splitLines(input.note)) lines.push({ role: "body", text: line });
	lines.push({ role: "body", text: text.widenScope });
	lines.push({ role: "option", text: optionLines(input.options, input.locale) });
	if (input.status === "pending") {
		lines.push({ role: "status", text: text.widenPending });
		lines.push({ role: "hint", text: text.widenHint });
	} else {
		lines.push({
			role: "status",
			text: input.status === "confirmed" ? text.widenConfirmed : text.widenCancelled,
		});
	}
	return lines;
}

/**
 * Draw role-tagged lines as a width-safe yellow card. Each content line is painted first, then
 * wrapped (ANSI carried over by `wrapTextWithAnsi`) and padded to the inner width.
 */
export function renderApprovalCard(
	theme: Theme,
	lines: readonly ApprovalTextLine[],
	width: number,
	maxWidth = APPROVAL_MAX_WIDTH,
): string[] {
	const total = Math.max(12, Math.min(Math.floor(width) || 12, maxWidth));
	const inner = Math.max(1, total - visibleWidth(CARD_GUTTER));
	const rule = paintApproval(theme, "frame", "─".repeat(total));
	const gutter = paintApproval(theme, "frame", CARD_GUTTER);
	const out: string[] = [rule];
	for (const line of lines) {
		if (line.text.length === 0) {
			out.push(gutter + " ".repeat(inner));
			continue;
		}
		const wrapped = wrapTextWithAnsi(paintApproval(theme, line.role, line.text), inner);
		for (const wrappedLine of wrapped) {
			out.push(gutter + truncateToWidth(wrappedLine, inner, "", true));
		}
	}
	out.push(rule);
	return out;
}

/**
 * A component around a line provider, so a card can follow live state (tool rows re-render on
 * invalidate) while staying cheap when nothing changed.
 */
export class ApprovalCardComponent implements Component {
	private readonly provider: () => readonly ApprovalTextLine[];
	private readonly theme: Theme;
	private cachedWidth: number | undefined;
	private cachedRevision = -1;
	private cachedLines: readonly string[] | undefined;
	private revision = 0;

	constructor(theme: Theme, provider: () => readonly ApprovalTextLine[]) {
		this.theme = theme;
		this.provider = provider;
	}

	/** Bump when the provider's output changed without a re-render from the host. */
	touch(): void {
		this.revision += 1;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): readonly string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width && this.cachedRevision === this.revision) {
			return this.cachedLines;
		}
		let lines: readonly ApprovalTextLine[];
		try {
			lines = this.provider();
		} catch {
			lines = [{ role: "body", text: "(approval card render failed)" }];
		}
		this.cachedWidth = width;
		this.cachedRevision = this.revision;
		this.cachedLines = renderApprovalCard(this.theme, lines, width);
		return this.cachedLines;
	}
}

/** Plain text of the request card, used by `renderApprovalMessage()` for non-TUI transports. */
export function operationCardText(request: OperationRequest): string {
	return operationCardLines(request).map((line) => line.text).join("\n");
}