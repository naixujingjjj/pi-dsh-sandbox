/**
 * Palette/width helpers for the approval-surface unit tests.
 *
 * Kept separate from `tui.mjs` (the interactive harness) so the card tests stay self-contained and
 * do not depend on the TUI harness while that harness is being changed.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

const hostEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const themeDir = dirname(dirname(hostEntry)) + "/dist/modes/interactive/theme";

/** Build a real bundled theme so assertions go through the host's own color conversion. */
export function makeTheme(mode = "truecolor", name = "dark") {
	const json = JSON.parse(readFileSync(`${themeDir}/${name}.json`, "utf8"));
	const resolveVar = (value) => (typeof value === "string" && json.vars[value] ? json.vars[value] : value);
	const colors = Object.fromEntries(Object.entries(json.colors).map(([token, value]) => [token, resolveVar(value)]));
	return new Theme(colors, {}, mode);
}

const ANSI_PATTERN = /^\u001b\[[0-9;]*[A-Za-z]|^\u001b\]8;;[^\u0007]*\u0007|^\u001b_pi:[^\u0007]*\u0007/;

export function stripAnsi(text) {
	let out = "";
	let index = 0;
	while (index < text.length) {
		if (text[index] === "\u001b") {
			const match = text.slice(index).match(ANSI_PATTERN);
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

export function hasAnsi(text) {
	return text.includes("\u001b");
}

const YELLOW_FG = [
	[255, 199, 0],
	[255, 226, 82],
	[172, 133, 0],
	[128, 99, 0],
];
const YELLOW_BG = [[255, 199, 0]];

function isPaletteRgb(list, [r, g, b]) {
	return list.some(([pr, pg, pb]) => pr === r && pg === g && pb === b);
}

export function hasYellow(line) {
	for (const [r, g, b] of [...YELLOW_FG, ...YELLOW_BG]) {
		if (line.includes(`\u001b[38;2;${r};${g};${b}m`) || line.includes(`\u001b[48;2;${r};${g};${b}m`)) return true;
	}
	return false;
}

/** Visible characters painted outside the approval palette (empty string = the whole line is yellow). */
export function nonYellowText(line) {
	let fgYellow = false;
	let bgYellow = false;
	let out = "";
	let index = 0;
	while (index < line.length) {
		if (line[index] === "\u001b") {
			const match = line.slice(index).match(ANSI_PATTERN);
			if (match) {
				if (match[0].startsWith("\u001b[")) {
					const params = match[0].slice(2, -1).split(";").map(Number);
					for (let cursor = 0; cursor < params.length; cursor += 1) {
						const code = params[cursor];
						if (code === 0) {
							fgYellow = false;
							bgYellow = false;
						} else if (code === 39) {
							fgYellow = false;
						} else if (code === 49) {
							bgYellow = false;
						} else if (code === 38 && params[cursor + 1] === 2) {
							fgYellow = isPaletteRgb(YELLOW_FG, [params[cursor + 2], params[cursor + 3], params[cursor + 4]]);
							cursor += 4;
						} else if (code === 48 && params[cursor + 1] === 2) {
							bgYellow = isPaletteRgb(YELLOW_BG, [params[cursor + 2], params[cursor + 3], params[cursor + 4]]);
							cursor += 4;
						}
					}
				}
				index += match[0].length;
				continue;
			}
		}
		if (!(fgYellow || bgYellow) && !/\s/.test(line[index])) out += line[index];
		index += 1;
	}
	return out;
}

export { visibleWidth } from "@earendil-works/pi-tui";

/** The host's keybinding manager shape, for components that take one as an argument. */
export function makeKeybindings() {
	return new KeybindingsManager(TUI_KEYBINDINGS);
}