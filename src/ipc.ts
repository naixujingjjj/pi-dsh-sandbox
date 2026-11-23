/**
 * The file channel used to hand a mutation request to the confined helper.
 *
 * The helper runs inside the restricted token, so it must not receive its payload through argv
 * (command-line length limits, quoting) and must not create new pipes (a named pipe created by a
 * Low-integrity process is closed to the host; DSH documents `EPERM` for piped stdio of confined
 * grandchildren). Instead:
 *
 *   host  -> unique request file in the host's private temp directory (read is not restricted)
 *   helper-> one result line on inherited stdout (the runner passes its own stdio straight through)
 *
 * The directory is unique per call, so concurrent mutations do not overwrite each other's requests, and it is
 * removed in a `finally` block. Neither the request nor the result is ever logged.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Prefix of the single result line the helper prints on stdout. */
export const RESULT_MARKER = "PI-DSH-SANDBOX-RESULT:";

export interface MutationChannel {
	/** Unique per-call directory (removed by {@link disposeMutationChannel}). */
	dir: string;
	/** Absolute path of the request file the helper reads. */
	requestPath: string;
}

export interface HelperRequest {
	op: "write" | "mkdir";
	path: string;
	content?: string;
}

export interface HelperResult {
	ok: boolean;
	code?: string;
	message?: string;
}

export function createMutationChannel(ipcRoot: string, request: HelperRequest): MutationChannel {
	mkdirSync(ipcRoot, { recursive: true });
	const dir = mkdtempSync(join(ipcRoot, "ch-"));
	const requestPath = join(dir, "request.json");
	writeFileSync(requestPath, JSON.stringify(request), { encoding: "utf8", mode: 0o600 });
	return { dir, requestPath };
}

export function disposeMutationChannel(channel: MutationChannel | undefined): void {
	if (!channel) return;
	try {
		rmSync(channel.dir, { recursive: true, force: true });
	} catch {
		// Residue is a random directory under the plugin's private temp; never worth failing a write.
	}
}

/** Parse the helper's result line. Returns null when the protocol is missing or malformed. */
export function parseHelperResult(stdout: string): HelperResult | null {
	const lines = stdout.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line === undefined || !line.startsWith(RESULT_MARKER)) continue;
		try {
			const parsed = JSON.parse(line.slice(RESULT_MARKER.length)) as unknown;
			if (parsed && typeof parsed === "object" && typeof (parsed as HelperResult).ok === "boolean") {
				return parsed as HelperResult;
			}
		} catch {
			return null;
		}
	}
	return null;
}
