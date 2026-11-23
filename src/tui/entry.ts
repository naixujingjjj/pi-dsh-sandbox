/**
 * Yellow approval cards for session entries (TUI-only, no LLM context).
 *
 * The model-facing `sandbox_request` tool already renders its card as the tool row. The human
 * `/sandbox exec` path and the sandbox-mode widening confirmation have no tool row, so they append
 * a custom entry and render it with `registerEntryRenderer`: the same card component, the same
 * yellow palette, drawn in the message stream where the transcript can be scrolled.
 *
 * Entries do not participate in LLM context, so the model context and the audit trail only ever
 * see plain data here — never an ANSI escape.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ApprovalCardComponent } from "./card.ts";
import type { ApprovalRole, ApprovalTextLine } from "./theme.ts";

export const APPROVAL_CARD_ENTRY = "pi-dsh-sandbox/approval-card";

const ROLES: readonly ApprovalRole[] = [
	"title",
	"label",
	"body",
	"command",
	"option",
	"status",
	"hint",
	"frame",
	"selected",
];

export interface ApprovalCardEntryData {
	/** Stable, plain-text identity of the card ("operation" / "mode-widening"). */
	kind: "operation" | "mode-widening";
	lines: readonly ApprovalTextLine[];
}

/** Rebuild the lines from stored session data, ignoring anything malformed. */
export function normalizeCardEntryData(data: unknown): ApprovalTextLine[] {
	if (data === null || typeof data !== "object") return [];
	const raw = (data as { lines?: unknown }).lines;
	if (!Array.isArray(raw)) return [];
	const lines: ApprovalTextLine[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object") continue;
		const role = (item as { role?: unknown }).role;
		const text = (item as { text?: unknown }).text;
		if (typeof text !== "string") continue;
		const known = typeof role === "string" && (ROLES as readonly string[]).includes(role);
		lines.push({ role: known ? (role as ApprovalRole) : "body", text });
	}
	return lines;
}

/** Register the entry renderer once per extension load. */
export function registerApprovalCardRenderer(pi: ExtensionAPI): void {
	if (typeof pi.registerEntryRenderer !== "function") return;
	pi.registerEntryRenderer<ApprovalCardEntryData>(APPROVAL_CARD_ENTRY, (entry, _options, theme) => {
		const lines = normalizeCardEntryData(entry.data);
		if (lines.length === 0) return undefined;
		return new ApprovalCardComponent(theme, () => lines);
	});
}

/**
 * Append a card to the transcript. A failure here must not decide anything: the approval itself is
 * unaffected, so this only reports through the return value.
 */
export function appendApprovalCard(pi: ExtensionAPI, data: ApprovalCardEntryData): boolean {
	try {
		if (typeof pi.appendEntry !== "function") return false;
		pi.appendEntry(APPROVAL_CARD_ENTRY, data);
		return true;
	} catch {
		return false;
	}
}