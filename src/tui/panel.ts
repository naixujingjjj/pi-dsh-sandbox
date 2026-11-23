/**
 * The floating approval dock.
 *
 * What it is: a small, focusable overlay that carries **only** the four choices and the key hints.
 * The request itself (reason, full command, cwd, mode, timeout) is rendered by the yellow card in
 * the message stream (see `card.ts`), so the dock never pushes the transcript out of the way and
 * the editor keeps its draft (it is never replaced or edited here).
 *
 * Interaction rules that matter for safety:
 *
 * - Only an explicit `Enter` on the highlighted option decides anything. Arrow/digit navigation,
 *   `F2` (hide), page keys, wheel scrolling and a lost focus never approve.
 * - `F2` hides the overlay **and** releases its keyboard focus, so the terminal's own scrolling
 *   (wheel / PageUp) and the fullscreen viewport work normally while the request stays pending.
 *   A one-line widget above the editor says how to return; a global terminal-input listener that
 *   only reacts to `F2` brings the panel back. Hiding is not an answer: the approval stays pending
 *   and nothing executes until the user answers.
 * - `Esc` cancels (nothing executes). A cancelled or blank reason cancels too.
 * - The panel settles exactly once, on abort/session teardown/dispose as well; every hook, widget
 *   and overlay it installed is removed in `cleanup()`, so one approval can never answer the next.
 * - RPC/print never open this panel (`mode !== "tui"`), so their select/input protocol and their
 *   plain-text titles are unchanged and never receive ANSI.
 */
import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";
import { APPROVAL_MAX_WIDTH, displayText } from "./card.ts";
import { paintApproval } from "./theme.ts";
import { approvalStrings, type Locale } from "../i18n.ts";

/** Pi's run modes; declared locally because the package index does not export the union. */
export type RunMode = "tui" | "rpc" | "json" | "print";

/** The wording for one "and reason…" option. */
export interface PanelReasonSpec {
	/** Short heading, e.g. "本次操作完成后的补充要求". */
	title: string;
	/** Placeholder shown in the empty editor. */
	placeholder: string;
	/** One or two sentences explaining what the text will be used for. */
	note: string;
}

export interface PanelSpec {
	/** Panel heading (yellow, bold). */
	title: string;
	/** Compact context lines; they point at the card in the message stream. */
	header: readonly string[];
	/** Choice labels, in display order. */
	options: readonly string[];
	/** Preselected option index (the first one, like the native picker). */
	defaultIndex: number;
	/** Options that collect human text before deciding. */
	reasonFor: Readonly<Record<number, PanelReasonSpec>>;
	/** Widget key used for the "panel hidden" hint; unique per request. */
	panelKey: string;
	/** Program-status text reported while the request waits (OSC 7501). */
	blockedMessage: string;
	/** UI language for the dock's own hints; missing/legacy specs are Chinese. */
	locale?: Locale;
}

export type PanelOutcome =
	| { kind: "selected"; index: number; reason?: string }
	| { kind: "reason-cancelled"; index: number }
	| { kind: "cancelled" }
	| { kind: "unavailable" };

/** The minimal UI surface a panel needs; structural so tests can drive it without Pi. */
export interface PanelUiSurface {
	readonly mode?: RunMode;
	readonly hasUI?: boolean;
	readonly ui?: Partial<Pick<ExtensionUIContext, "custom" | "setWidget" | "onTerminalInput">>;
}

/** TUI-only: the panel needs custom components and terminal input, never RPC/print. */
export function canOpenTuiPanel(subject: PanelUiSurface): boolean {
	return (
		subject.mode === "tui" &&
		subject.hasUI === true &&
		typeof subject.ui?.custom === "function" &&
		typeof subject.ui.setWidget === "function" &&
		typeof subject.ui.onTerminalInput === "function"
	);
}

const HIDDEN_KEY = "f2";

/**
 * Open the dock and wait for one answer. Never throws: a panel that cannot be created reports
 * `unavailable` so the caller can fall back to the plain select/input dialogs (and a fallback is
 * still an explicit human choice, never an automatic approval).
 */
export async function requestTuiPanel(
	subject: PanelUiSurface,
	spec: PanelSpec,
	options: { signal?: AbortSignal } = {},
): Promise<PanelOutcome> {
	const ui = subject.ui;
	if (!canOpenTuiPanel(subject) || !ui?.custom) return { kind: "unavailable" };
	const setWidget = ui.setWidget;
	const onTerminalInput = ui.onTerminalInput;
	if (!setWidget || !onTerminalInput) return { kind: "unavailable" };

	let panel: ApprovalPanel | undefined;
	let outcome: PanelOutcome;
	try {
		outcome = await ui.custom<PanelOutcome>(
			(tui, theme, keybindings, done) => {
				panel = new ApprovalPanel({
					tui,
					theme,
					keybindings,
					spec,
					done,
					setWidget,
					onTerminalInput,
					...(options.signal ? { signal: options.signal } : {}),
				});
				return panel;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "bottom-center",
					width: APPROVAL_MAX_WIDTH,
					minWidth: 24,
					margin: { bottom: 1 },
				},
				// `onHandle` runs right after `showOverlay()` created the overlay; the panel needs the
				// handle for the F2 hide/restore cycle.
				onHandle: (created) => panel?.attachHandle(created),
				blocked: { kind: "permission", message: spec.blockedMessage },
			},
		);
	} catch {
		return { kind: "unavailable" };
	}
	return outcome === undefined ? { kind: "unavailable" } : outcome;
}

interface PanelDeps {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	spec: PanelSpec;
	done: (outcome: PanelOutcome) => void;
	setWidget: ExtensionUIContext["setWidget"];
	onTerminalInput: ExtensionUIContext["onTerminalInput"];
	signal?: AbortSignal;
}

/**
 * The dock component. It owns exactly one interaction: `done()` is called at most once and every
 * exit path (answer, cancel, abort, host dispose) runs `cleanup()`.
 */
export class ApprovalPanel implements Component, Focusable {
	focused = false;

	private readonly deps: PanelDeps;
	private readonly spec: PanelSpec;
	private selected: number;
	private mode: "menu" | "reason" | "hidden" = "menu";
	private previousMode: "menu" | "reason" = "menu";
	private reasonSpec: PanelReasonSpec | null = null;
	private editor: Input | null = null;
	private handle: OverlayHandle | null = null;
	private unsubscribeInput: (() => void) | null = null;
	private widgetVisible = false;
	private finished = false;
	private cachedWidth: number | undefined;
	private cachedLines: readonly string[] | undefined;
	private readonly onAbort = () => {
		this.finish({ kind: "cancelled" });
	};

	constructor(deps: PanelDeps) {
		this.deps = deps;
		this.spec = deps.spec;
		const count = deps.spec.options.length;
		const clampIndex = (value: number) => Math.max(0, Math.min(Number.isInteger(value) ? value : 0, Math.max(0, count - 1)));
		this.selected = clampIndex(deps.spec.defaultIndex);
		deps.signal?.addEventListener("abort", this.onAbort, { once: true });
	}

	/** Called by `onHandle` as soon as the TUI created the overlay. */
	attachHandle(handle: OverlayHandle): void {
		this.handle = handle;
		// Some hosts await UI setup before calling the component factory. Do not miss an abort
		// that happened in that gap, before this instance could subscribe to the signal.
		if (this.deps.signal?.aborted) {
			this.finish({ kind: "cancelled" });
			return;
		}
		if (this.mode === "hidden") {
			handle.setHidden(true);
		}
	}

	// ---------------------------------------------------------------- input

	handleInput(data: string): void {
		if (this.finished || this.mode === "hidden") return;
		if (this.mode === "reason") {
			if (this.isHideKey(data)) {
				this.hidePanel();
				return;
			}
			this.editor?.handleInput(data);
			this.invalidate();
			return;
		}
		const kb = this.deps.keybindings;
		if (kb.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.choose();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.finish({ kind: "cancelled" });
			return;
		}
		if (this.isHideKey(data)) {
			this.hidePanel();
			return;
		}
		if (/^[1-9]$/.test(data)) {
			const index = Number(data) - 1;
			if (index < this.spec.options.length) this.select(index);
		}
	}

	private isHideKey(data: string): boolean {
		return matchesKey(data, HIDDEN_KEY);
	}

	private move(delta: number): void {
		const count = this.spec.options.length;
		if (count === 0) return;
		this.select((this.selected + delta + count) % count);
	}

	private select(index: number): void {
		if (index === this.selected) {
			this.invalidate();
			return;
		}
		this.selected = index;
		this.invalidate();
	}

	private choose(): void {
		const reasonSpec = this.spec.reasonFor[this.selected];
		if (reasonSpec) {
			this.reasonSpec = reasonSpec;
			const theme = this.deps.theme;
			const editor = new Input({
				prompt: "> ",
				placeholder: reasonSpec.placeholder,
				placeholderStyle: (text) => paintApproval(theme, "hint", text),
			});
			editor.focused = this.focused;
			editor.onSubmit = (value: string) => {
				const text = value.trim();
				if (text.length === 0) {
					this.finish({ kind: "reason-cancelled", index: this.selected });
					return;
				}
				this.finish({ kind: "selected", index: this.selected, reason: text });
			};
			editor.onEscape = () => this.finish({ kind: "reason-cancelled", index: this.selected });
			this.editor = editor;
			this.mode = "reason";
			this.invalidate();
			return;
		}
		this.finish({ kind: "selected", index: this.selected });
	}

	// ------------------------------------------------------- hide / restore

	/**
	 * Hide the dock so the user can read and scroll the transcript. It stays pending: no answer is
	 * recorded, the request still waits, and only `F2` brings it back.
	 */
	private hidePanel(): void {
		if (!this.handle || this.mode === "hidden") return;
		this.previousMode = this.mode === "reason" ? "reason" : "menu";
		this.mode = "hidden";
		this.handle.setHidden(true);
		this.showWidget();
		this.unsubscribeInput = this.deps.onTerminalInput((data) => {
			if (!this.isHideKey(data)) return undefined;
			this.restorePanel();
			return { consume: true };
		});
		this.deps.tui.requestRender();
	}

	private restorePanel(): void {
		if (this.finished) return;
		if (this.unsubscribeInput) {
			this.unsubscribeInput();
			this.unsubscribeInput = null;
		}
		this.hideWidget();
		this.mode = this.previousMode;
		this.handle?.setHidden(false);
		this.handle?.focus();
		this.invalidate();
		this.deps.tui.requestRender();
	}

	private showWidget(): void {
		if (this.widgetVisible) return;
		this.widgetVisible = true;
		const spec = this.spec;
		const theme = this.deps.theme;
		const reasonMode = this.previousMode === "reason";
		this.deps.setWidget(
			this.spec.panelKey,
			() => new HiddenPanelNotice(theme, spec, reasonMode),
			{ placement: "aboveEditor" },
		);
	}

	private hideWidget(): void {
		if (!this.widgetVisible) return;
		this.widgetVisible = false;
		this.deps.setWidget(this.spec.panelKey, undefined);
	}

	// ------------------------------------------------------------- lifecycle

	/** Settle the interaction exactly once. */
	private finish(outcome: PanelOutcome): void {
		if (this.finished) return;
		this.finished = true;
		this.cleanup();
		this.deps.done(outcome);
	}

	/** Host teardown (reload/session switch) without an answer: fail closed and settle. */
	dispose(): void {
		if (this.finished) {
			this.cleanup();
			return;
		}
		this.finish({ kind: "cancelled" });
	}

	private cleanup(): void {
		this.deps.signal?.removeEventListener("abort", this.onAbort);
		if (this.unsubscribeInput) {
			this.unsubscribeInput();
			this.unsubscribeInput = null;
		}
		this.hideWidget();
		this.editor = null;
		this.handle = null;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	// --------------------------------------------------------------- render

	render(width: number): readonly string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.renderPanel(width);
		return this.cachedLines;
	}

	private row(content: string, width: number): string {
		const inner = Math.max(1, width - 4);
		return (
			paintApproval(this.deps.theme, "frame", "│ ") +
			truncateToWidth(content, inner, "", true) +
			paintApproval(this.deps.theme, "frame", " │")
		);
	}

	private topBorder(width: number, title: string): string {
		const theme = this.deps.theme;
		const inner = Math.max(1, width - 2);
		const label = truncateToWidth(paintApproval(theme, "title", ` ${displayText(title)} `), Math.max(1, inner - 2), "", false);
		const fill = Math.max(0, inner - 2 - visibleWidth(label));
		return paintApproval(theme, "frame", "╭─") + label + paintApproval(theme, "frame", `${"─".repeat(fill)}╮`);
	}

	private bottomBorder(width: number): string {
		return paintApproval(this.deps.theme, "frame", `╰${"─".repeat(Math.max(1, width - 2))}╯`);
	}

	private separator(width: number): string {
		return paintApproval(this.deps.theme, "frame", `├${"─".repeat(Math.max(1, width - 2))}┤`);
	}

	private renderPanel(width: number): string[] {
		const theme = this.deps.theme;
		const text = approvalStrings(this.spec.locale);
		const total = Math.max(24, Math.min(Math.floor(width) || 24, APPROVAL_MAX_WIDTH));
		const inner = Math.max(1, total - 4);
		const out: string[] = [];
		const wrapRows = (text: string, role: "hint" | "body" | "option" | "label" = "hint") => {
			for (const line of wrapTextWithAnsi(paintApproval(theme, role, displayText(text)), inner)) {
				out.push(this.row(line, total));
			}
		};

		if (this.mode === "reason" && this.reasonSpec) {
			out.push(this.topBorder(total, this.reasonSpec.title));
			wrapRows(`${text.panelReasonChoicePrefix}[${this.selected + 1}] ${this.spec.options[this.selected] ?? ""}`, "option");
			wrapRows(this.reasonSpec.note, "hint");
			out.push(this.separator(total));
			const editor = this.editor;
			if (editor) {
				editor.focused = this.focused;
				const [line = ""] = editor.render(Math.max(1, inner - 2));
				// Paint the whole line (typed text and cursor) in the approval yellow.
				out.push(this.row(paintApproval(theme, "body", line), total));
			}
			out.push(this.separator(total));
			wrapRows(text.panelEditorHint, "hint");
			wrapRows(text.panelF2Hint, "hint");
			out.push(this.bottomBorder(total));
			return out;
		}

		out.push(this.topBorder(total, this.spec.title));
		for (const line of this.spec.header) wrapRows(line, "hint");
		out.push(this.separator(total));
		for (let index = 0; index < this.spec.options.length; index += 1) {
			const label = `[${index + 1}] ${this.spec.options[index] ?? ""}`;
			if (index === this.selected) {
				out.push(this.row(paintApproval(theme, "selected", truncateToWidth(`> ${label}`, inner, "", true)), total));
			} else {
				out.push(this.row(paintApproval(theme, "option", displayText(`  ${label}`)), total));
			}
		}
		out.push(this.separator(total));
		wrapRows(this.menuHint(text), "hint");
		wrapRows(text.panelF2Hint, "hint");
		out.push(this.bottomBorder(total));
		return out;
	}

	/** Keys actually handled by this dock; the digit range follows the number of choices. */
	private menuHint(text = approvalStrings(this.spec.locale)): string {
		const count = this.spec.options.length;
		const digits = count >= 2 && count <= 9 ? ` · 1-${count}${text.panelDigitHint}` : "";
		return `${text.panelMenuHint}${digits}${text.menuEscHint}`;
	}
}

/** One-line widget shown above the editor while the dock is hidden. */
class HiddenPanelNotice implements Component {
	private readonly theme: Theme;
	private readonly spec: PanelSpec;
	private readonly reasonMode: boolean;

	constructor(theme: Theme, spec: PanelSpec, reasonMode: boolean) {
		this.theme = theme;
		this.spec = spec;
		this.reasonMode = reasonMode;
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const text = approvalStrings(this.spec.locale);
		const message =
			`${text.panelHiddenPrefix}${this.spec.title}` +
			(this.reasonMode ? text.panelHiddenReason : "") +
			text.panelHiddenHint;
		const styled =
			paintApproval(this.theme, "label", "▏ ") +
			paintApproval(this.theme, "hint", displayText(message));
		return wrapTextWithAnsi(styled, Math.max(12, Math.floor(width) || 12)).slice(0, 3);
	}
}
