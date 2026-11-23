/**
 * Test harness for the TUI approval surfaces.
 *
 * Two layers:
 *
 * - `makeTheme()` builds a real Pi `Theme` from the bundled dark palette, so ANSI assertions exercise
 *   the same `theme.style()` path the extension uses in production (no hand-rolled colors in tests).
 * - `createHarness()` wires a real `TuiAltScreen` to a fake terminal plus the documented overlay,
 *   widget and terminal-input APIs, so a test drives keys through the *real* TUI dispatch
 *   (input listeners → focused overlay → editor) and reads the composited screen lines. This is an
 *   in-process equivalent of a local interactive run: no PTY, but the same components and routing.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	KeybindingsManager,
	TUI_KEYBINDINGS,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";

const hostEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const hostRoot = dirname(dirname(hostEntry));

/** Build the bundled dark theme so tests use the host's real color conversion. */
export function makeTheme(mode = "truecolor", name = "dark") {
	const json = JSON.parse(readFileSync(join(hostRoot, "dist", "modes", "interactive", "theme", `${name}.json`), "utf8"));
	const resolveVar = (value) => (typeof value === "string" && json.vars[value] ? json.vars[value] : value);
	const colors = Object.fromEntries(Object.entries(json.colors).map(([token, value]) => [token, resolveVar(value)]));
	return new Theme(colors, {}, mode);
}

export function makeKeybindings() {
	return new KeybindingsManager(TUI_KEYBINDINGS);
}

/** The one approval hue family: any of these foregrounds, or the yellow selection bar. */
const YELLOW_FG = [
	[255, 199, 0],
	[255, 226, 82],
	[172, 133, 0],
	[128, 99, 0],
];
const YELLOW_BG = [[255, 199, 0]];

function sameRgb(list, triple) {
	return list.some(([r, g, b]) => r === triple[0] && g === triple[1] && b === triple[2]);
}

const ANSI_PATTERN = /^\u001b\[[0-9;]*[A-Za-z]|^\u001b\]8;;[^\u0007]*\u0007|^\u001b_pi:[^\u0007]*\u0007/;

/** Remove every escape sequence this extension and the host can emit. */
export function stripAnsi(text) {
	let out = "";
	let index = 0;
	while (index < text.length) {
		if (text[index] === "\u001b") {
			const rest = text.slice(index);
			const match = rest.match(ANSI_PATTERN);
			if (match) {
				index += match[0].length;
				continue;
			}
		}
		out += text[index];
		index += 1;
	}
	return out;
}

/**
 * Visible characters painted with a non-yellow color. An empty string proves "everything on this line
 * is yellow" — the requirement for every approval surface.
 */
export function nonYellowText(line) {
	let fgYellow = false;
	let bgYellow = false;
	let out = "";
	let index = 0;
	while (index < line.length) {
		if (line[index] === "\u001b") {
			const match = line.slice(index).match(ANSI_PATTERN);
			if (match) {
				const sequence = match[0];
				if (sequence.startsWith("\u001b[")) {
					const params = sequence.slice(2, -1).split(";").map((part) => Number(part));
					for (let index2 = 0; index2 < params.length; index2 += 1) {
						const code = params[index2];
						if (code === 0) {
							fgYellow = false;
							bgYellow = false;
						} else if (code === 39) {
							fgYellow = false;
						} else if (code === 49) {
							bgYellow = false;
						} else if (code === 38 && params[index2 + 1] === 2) {
							fgYellow = sameRgb(YELLOW_FG, [params[index2 + 2], params[index2 + 3], params[index2 + 4]]);
							index2 += 4;
						} else if (code === 48 && params[index2 + 1] === 2) {
							bgYellow = sameRgb(YELLOW_BG, [params[index2 + 2], params[index2 + 3], params[index2 + 4]]);
							index2 += 4;
						}
					}
				}
				index += sequence.length;
				continue;
			}
		}
		const char = line[index];
		if (!(fgYellow || bgYellow) && !/\s/.test(char)) out += char;
		index += 1;
	}
	return out;
}

/** True when the line carries at least one yellow escape (foreground or selection background). */
export function hasYellow(line) {
	for (const triple of [...YELLOW_FG, ...YELLOW_BG]) {
		const [r, g, b] = triple;
		if (
			line.includes(`\u001b[38;2;${r};${g};${b}m`) ||
			line.includes(`\u001b[48;2;${r};${g};${b}m`)
		) {
			return true;
		}
	}
	return false;
}

/** True when the text contains no escape sequence at all (RPC payloads, audit records, entry data). */
export function hasAnsi(text) {
	return text.includes("\u001b");
}

class FakeTerminal {
	constructor(width, height) {
		this.columns = width;
		this.rows = height;
		this.kittyProtocolActive = false;
		this.written = "";
		this.started = false;
	}

	start(onInput, onResize) {
		this.started = true;
		this.onInput = onInput;
		this.onResize = onResize;
	}

	stop() {
		this.started = false;
	}

	write(data) {
		this.written += data;
	}

	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	setProgramStatus() {}
	async drainInput() {}
}

/** A stand-in for Pi's editor: Focusable, records what reaches it, keeps its draft. */
export function makeEditor(initial = "") {
	return {
		focused: false,
		text: initial,
		handleInput(data) {
			if (data === "\r") {
				this.text = "";
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32) this.text += data;
		},
		invalidate() {},
		render(width) {
			return [this.text.length > 0 ? this.text : "(editor empty)"];
		},
	};
}

function placeWidget(root, children, component, placement) {
	if (placement === "belowEditor") {
		root.children.push(component);
		return;
	}
	const editorIndex = root.children.indexOf(children.editor);
	root.children.splice(editorIndex < 0 ? root.children.length : editorIndex, 0, component);
}

/**
 * A host emulation around a real `TuiAltScreen`: `ctx.ui.custom` shows a real overlay, `setWidget`
 * renders a real widget above/below the editor, `onTerminalInput` registers a real input listener.
 */
export function createHarness(options = {}) {
	const theme = options.theme ?? makeTheme();
	const width = options.width ?? 70;
	const rows = options.rows ?? 24;
	const terminal = new FakeTerminal(width, rows);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	const editor = makeEditor(options.draft ?? "");
	const root = new Container();
	root.addChild(editor);
	tui.addChild(root);

	const state = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		theme,
		customCalls: [],
		selectCalls: [],
		inputCalls: [],
		confirmCalls: [],
		widgets: new Map(),
		widgetsAbove: [],
		listeners: new Set(),
		panel: undefined,
		handle: undefined,
		outcome: undefined,
		settled: false,
		pending: undefined,
		overlayOptions: undefined,
		failCustom: false,
		selectAnswer: undefined,
		inputAnswer: undefined,
		confirmAnswer: false,
	};

	function removeWidgets(key) {
		const entry = state.widgets.get(key);
		if (!entry) return;
		const index = root.children.indexOf(entry.component);
		if (index >= 0) root.children.splice(index, 1);
		state.widgets.delete(key);
		state.widgetsAbove = state.widgetsAbove.filter((candidate) => candidate !== entry.component);
	}

	const ui = {
		theme,
		mode: state.mode,
		hasUI: state.hasUI,
		custom(factory, customOptions) {
			state.customCalls.push(customOptions);
			if (state.failCustom) return Promise.reject(new Error("custom UI unavailable"));
			state.overlayOptions = customOptions?.overlayOptions;
			const promise = new Promise((resolvePromise) => {
				const done = (value) => {
					if (state.settled) return;
					state.settled = true;
					state.outcome = value;
					state.handle?.hide();
					resolvePromise(value);
				};
				const component = factory(tui, theme, makeKeybindings(), done);
				state.panel = component;
				state.handle = tui.showOverlay(component, customOptions?.overlayOptions);
				customOptions?.onHandle?.(state.handle);
				state.handle.focus();
				tui.requestRender();
				tui.renderNow(true);
			});
			state.pending = promise;
			return promise;
		},
		setWidget(key, content, widgetOptions = {}) {
			removeWidgets(key);
			if (content === undefined) return;
			const component =
				typeof content === "function" ? content(tui, theme) : new Container();
			if (Array.isArray(content)) {
				for (const line of content) component.addChild({ render: () => [line], invalidate() {} });
			}
			state.widgets.set(key, { component, options: widgetOptions });
			placeWidget(root, { editor, above: state.widgetsAbove }, component, widgetOptions.placement);
			tui.requestRender();
		},
		onTerminalInput(handler) {
			state.listeners.add(handler);
			const unsubscribe = tui.addInputListener(handler);
			return () => {
				state.listeners.delete(handler);
				unsubscribe();
			};
		},
		async select(title, choices) {
			state.selectCalls.push({ title, choices });
			return state.selectAnswer;
		},
		async input(title, placeholder) {
			state.inputCalls.push({ title, placeholder });
			return state.inputAnswer;
		},
		async confirm(title, message) {
			state.confirmCalls.push({ title, message });
			return state.confirmAnswer;
		},
		notify() {},
	};

	const subject = {
		mode: state.mode,
		hasUI: state.hasUI,
		ui,
	};

	return {
		state,
		subject,
		ui,
		terminal,
		tui,
		editor,
		overlay: () => state.overlayOptions,
		press(data) {
			terminal.onInput(data);
			tui.renderNow(true);
		},
		type(text) {
			for (const char of text) terminal.onInput(char);
			tui.renderNow(true);
		},
		paste(text) {
			terminal.onInput(`\u001b[200~${text}\u001b[201~`);
			tui.renderNow(true);
		},
		render() {
			tui.renderNow(true);
		},
		/** Visible screen lines with escape sequences removed. */
		screen() {
			return tui.getScreenLines().map((line) => stripAnsi(line).replace(/\s+$/g, ""));
		},
		rawScreen() {
			return tui.getScreenLines();
		},
		async settle() {
			if (state.pending) await state.pending;
		},
		start() {
			tui.start();
			tui.setFocus(editor);
			tui.requestRender();
			tui.renderNow(true);
		},
		stop() {
			tui.stop();
		},
	};
}

export { visibleWidth };
export const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");