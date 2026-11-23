#!/usr/bin/env node
/**
 * Mutation helper — runs INSIDE the restricted token, spawned by the DSH runner.
 *
 * This is the only place where a `write`/`edit` tool call actually touches the filesystem, so the
 * kernel (restricted token + Low integrity label) is what decides whether the write is allowed.
 * The request comes from a unique file; the result is one line on the inherited stdout.
 *
 * Plain ESM with no dependencies: it is executed by `node`, not by Pi's TypeScript loader.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const RESULT_MARKER = "PI-DSH-SANDBOX-RESULT:";

function report(payload) {
	process.stdout.write(`${RESULT_MARKER}${JSON.stringify(payload)}\n`);
}

function fail(error) {
	const code = typeof error?.code === "string" ? error.code : undefined;
	const message = error instanceof Error ? error.message : String(error);
	report({ ok: false, ...(code ? { code } : {}), message });
	process.exitCode = 1;
}

function main() {
	const requestPath = process.argv[2];
	if (typeof requestPath !== "string" || requestPath.length === 0) {
		report({ ok: false, code: "EINVAL", message: "missing request path" });
		process.exitCode = 1;
		return;
	}

	let request;
	try {
		request = JSON.parse(readFileSync(requestPath, "utf8"));
	} catch (error) {
		fail(error);
		return;
	}

	if (!request || typeof request !== "object" || typeof request.path !== "string" || request.path.length === 0) {
		report({ ok: false, code: "EINVAL", message: "malformed request" });
		process.exitCode = 1;
		return;
	}

	try {
		switch (request.op) {
			case "mkdir":
				mkdirSync(request.path, { recursive: true });
				break;
			case "write": {
				if (typeof request.content !== "string") {
					report({ ok: false, code: "EINVAL", message: "write request without content" });
					process.exitCode = 1;
					return;
				}
				writeFileSync(request.path, request.content, "utf8");
				break;
			}
			default:
				report({ ok: false, code: "EINVAL", message: `unknown op: ${String(request.op)}` });
				process.exitCode = 1;
				return;
		}
		report({ ok: true });
	} catch (error) {
		fail(error);
	}
}

main();