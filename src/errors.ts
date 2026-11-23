/**
 * Sandbox error taxonomy.
 *
 * Every failure the plugin raises is one of these codes, so the model and the user can tell
 * "the sandbox could not run" (fail-closed) apart from "the command failed" and "the kernel
 * denied the write".
 */
export type SandboxErrorCode =
	| "SANDBOX_UNAVAILABLE"
	| "SANDBOX_RUNNER_FAILURE"
	| "SANDBOX_CONFIG"
	| "SANDBOX_DENIED"
	| "SANDBOX_READ_ONLY";

export class SandboxError extends Error {
	readonly code: SandboxErrorCode;
	readonly hint: string | undefined;

	constructor(code: SandboxErrorCode, message: string, hint?: string) {
		super(`${code}: ${message}`);
		this.name = "SandboxError";
		this.code = code;
		this.hint = hint;
	}
}

export function isSandboxError(error: unknown): error is SandboxError {
	return error instanceof SandboxError;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}