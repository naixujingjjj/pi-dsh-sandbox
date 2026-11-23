/**
 * The approval palette.
 *
 * Every approval surface (transcript card, floating panel, widget hint, tool call rows) uses these
 * concrete RGB colors through `theme.style(text, { fg })`. They are deliberately **not** theme
 * tokens: `theme.fg("warning", …)` is green-ish in the bundled dark theme and something else in
 * another theme, and an approval surface must not silently turn blue or green. Brightness and
 * boldness (never hue) mark the selected option, and the selected row is drawn on a yellow bar.
 *
 * The rest of the transcript keeps the user's normal theme; nothing here changes global theme
 * state.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { rgbColor } from "@earendil-works/pi-tui";

/** Fixed approval yellow (the one hue used by every approval element). */
export const APPROVAL_YELLOW = rgbColor(255, 199, 0);
/** Brighter yellow for titles, labels and the exact command text. */
export const APPROVAL_YELLOW_BRIGHT = rgbColor(255, 226, 82);
/** Darker yellow for secondary facts and hints; still the same hue. */
export const APPROVAL_YELLOW_DIM = rgbColor(172, 133, 0);
/** Deep yellow for frame characters only. */
export const APPROVAL_YELLOW_FAINT = rgbColor(128, 99, 0);
/** Ink used on top of the yellow selection bar. */
export const APPROVAL_YELLOW_INK = rgbColor(28, 21, 0);

/** How a line of approval text is painted. Roles differ only in intensity, never in hue. */
export type ApprovalRole =
	| "title"
	| "label"
	| "body"
	| "command"
	| "option"
	| "status"
	| "hint"
	| "frame"
	| "selected";

/**
 * Paint approval text. The selected role paints the row's own padding too, because the caller pads
 * the string before styling it (`truncateToWidth(..., "", true)` inside the call).
 */
export function paintApproval(theme: Theme, role: ApprovalRole, text: string): string {
	switch (role) {
		case "title":
			return theme.style(text, { fg: APPROVAL_YELLOW_BRIGHT, bold: true });
		case "label":
			return theme.style(text, { fg: APPROVAL_YELLOW, bold: true });
		case "command":
			return theme.style(text, { fg: APPROVAL_YELLOW_BRIGHT });
		case "option":
			return theme.style(text, { fg: APPROVAL_YELLOW });
		case "status":
			return theme.style(text, { fg: APPROVAL_YELLOW_BRIGHT, bold: true });
		case "hint":
			return theme.style(text, { fg: APPROVAL_YELLOW_DIM });
		case "frame":
			return theme.style(text, { fg: APPROVAL_YELLOW_FAINT });
		case "selected":
			return theme.style(text, { fg: APPROVAL_YELLOW_INK, bg: APPROVAL_YELLOW, bold: true });
		default:
			return theme.style(text, { fg: APPROVAL_YELLOW });
	}
}

/**
 * One line of approval content before any styling: pure text, so the same lines can feed the plain
 * `ui.select` title used by RPC and the TUI card, and so tests/audit records never see ANSI.
 */
export interface ApprovalTextLine {
	role: ApprovalRole;
	text: string;
}

export function joinApprovalLines(lines: readonly ApprovalTextLine[]): string {
	return lines.map((line) => line.text).join("\n");
}