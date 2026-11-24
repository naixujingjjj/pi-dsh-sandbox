/** Invoke npm's JavaScript entry without shell quoting or Windows .cmd handling. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Absolute path of npm's JavaScript entry. Running it through the current `node` avoids the
 * Windows `.cmd` shim and any shell quoting.
 * @returns the entry path.
 */
export function npmCliPath() {
	const candidates = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")];
	const entry = candidates.find((path) => path && /\.(?:c?js|mjs)$/.test(path) && existsSync(path));
	if (!entry) throw new Error("Cannot locate npm-cli.js. Run this script through its npm run command.");
	return entry;
}

export function runNpm(args, options = {}) {
	const result = spawnSync(process.execPath, [npmCliPath(), ...args], {
		encoding: "utf8", timeout: 180_000, windowsHide: true, ...options,
	});
	if (result.error || result.status !== 0) {
		throw new Error(`npm ${args.join(" ")} failed: ${result.error?.message ?? result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	}
	return result;
}

/**
 * Run a command with inherited stdio (no pipes). Used by maintenance scripts that must also work
 * inside the confined shell, where creating the pipes a `spawnSync` capture needs is denied.
 * @param command - the executable.
 * @param args - its arguments.
 * @param options - extra spawn options.
 * @returns the spawn result.
 */
export function runInherited(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true, timeout: 600_000, ...options });
	if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
	return result;
}