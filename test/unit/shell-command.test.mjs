import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	composePowerShellCommand,
	POWERSHELL_UTF8_OUTPUT_PREFIX,
	WINDOWS_POWERSHELL_EXIT_SUFFIX,
} from "../../src/shell-command.ts";

function distFile(relative) {
	const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
	return join(dirname(fileURLToPath(entry)), relative);
}

function literalInFile(file, value) {
	// Compare the decoded constant with the escaped literal that appears in Pi's source.
	const escaped = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/'/g, "\\'");
	return readFileSync(file, "utf8").includes(escaped);
}

test("the PowerShell UTF-8 prefix matches Pi's built-in backend", () => {
	const file = distFile("core/tools/powershell.js");
	const source = readFileSync(file, "utf8");
	assert.match(source, /UTF8_OUTPUT_PREFIX/);
	assert.equal(literalInFile(file, POWERSHELL_UTF8_OUTPUT_PREFIX), true);
});

test("the Windows PowerShell exit suffix matches Pi's built-in backend", () => {
	const file = distFile("core/tools/powershell.js");
	const source = readFileSync(file, "utf8");
	assert.match(source, /WINDOWS_POWERSHELL_EXIT_SUFFIX/);
	assert.equal(literalInFile(file, WINDOWS_POWERSHELL_EXIT_SUFFIX), true);
});

test("composePowerShellCommand adds the prefix and the 5.1 suffix", () => {
	const composed = composePowerShellCommand("Write-Output hi", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.equal(composed.startsWith(POWERSHELL_UTF8_OUTPUT_PREFIX), true);
	assert.equal(composed.includes("Write-Output hi"), true);
	assert.equal(composed.endsWith(WINDOWS_POWERSHELL_EXIT_SUFFIX), true);
});

test("PowerShell 7 keeps the prefix but not the 5.1 suffix", () => {
	const composed = composePowerShellCommand("Write-Output hi", "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
	assert.equal(composed, `${POWERSHELL_UTF8_OUTPUT_PREFIX}Write-Output hi`);
});

test("a trailing backtick never swallows the suffix", () => {
	const composed = composePowerShellCommand("Write-Output `", "C:\\pwsh\\powershell.exe");
	assert.equal(composed.endsWith("`"), true);
});

test("only runner.ts spawns processes, and only through the runner argv", () => {
	// Regression guard: no code path may spawn the shell directly when the sandbox is on.
	const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) files.push(path);
		}
	};
	walk(srcRoot);
	const stripComments = (source) =>
		source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
	const offenders = files.filter(
		(file) =>
			!file.endsWith("runner.ts") &&
			/\bspawn(Sync)?\s*\(/.test(stripComments(readFileSync(file, "utf8"))),
	);
	assert.deepEqual(offenders, [], `unexpected spawn() outside runner.ts: ${offenders.join(", ")}`);
});