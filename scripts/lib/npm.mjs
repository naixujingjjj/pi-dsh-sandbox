/** Invoke npm's JavaScript entry without shell quoting or Windows .cmd handling. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function runNpm(args, options = {}) {
	const candidates = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")];
	const entry = candidates.find((path) => path && /\.(?:c?js|mjs)$/.test(path) && existsSync(path));
	if (!entry) throw new Error("Cannot locate npm-cli.js. Run this script through its npm run command.");
	const result = spawnSync(process.execPath, [entry, ...args], {
		encoding: "utf8", timeout: 180_000, windowsHide: true, ...options,
	});
	if (result.error || result.status !== 0) {
		throw new Error(`npm ${args.join(" ")} failed: ${result.error?.message ?? result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	}
	return result;
}
