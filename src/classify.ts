/**
 * Classification of confined-shell results.
 *
 * The runner prints `windows-acl-run: <detail>` and exits 127 for every runner-side failure
 * (bad args, missing directory, token/grant/spawn error, broken koffi). That signature means
 * the sandbox never ran the command, so it must be reported as a sandbox failure — never as a
 * denial and never retried without the sandbox.
 *
 * Denial signatures are a UX signal only. They classify an exit code we already received; they
 * never enforce anything. The kernel (restricted token + Low integrity label) is the boundary.
 */

/** Runner-side failure signature printed by `@deepseek-ai/dsh-sandbox-windows-acl/runner`. */
export const RUNNER_FAILURE_SIGNATURE = "windows-acl-run:";
/** Exit code the runner uses for its own failures (DSH `RUNNER_FAILURE_RULES`). */
export const RUNNER_FAILURE_EXIT = 127;

/**
 * Denial texts observed from a confined child on Windows (case-insensitive).
 *
 * - `node` / libuv: `EPERM: operation not permitted, open '…'` / `EACCES` (language independent,
 *   the strongest signal).
 * - .NET / pwsh: `Access to the path '…' is denied.` / `Permission denied`.
 * - Localized .NET / pwsh on zh-CN: `对路径“…”的访问被拒绝。`
 * - `cmd.exe` prints GBK `拒绝访问。` which does not survive UTF-8 decoding; it is listed for
 *   completeness but is not reliable.
 */
export const DENIAL_SIGNATURES: readonly string[] = [
	"eperm",
	"eacces",
	"access is denied",
	"access to the path",
	"permission denied",
	"operation not permitted",
	"unauthorizedaccessexception",
	"拒绝访问",
	"访问被拒绝",
	"没有访问权限",
	"权限不足",
	"对该路径的访问被拒绝",
];

export type ClassificationKind = "none" | "runner-failure" | "denied" | "command-failed";

export interface Classification {
	kind: ClassificationKind;
	/** The matched denial signature or the runner-failure detail line. */
	signature?: string;
}

export interface ClassifyInput {
	exitCode: number | null;
	/** stderr only, captured separately from the merged stream. */
	stderr?: string;
	/** merged stdout+stderr as the tool saw it. */
	output?: string;
}

/** Extract the runner's own failure detail (`windows-acl-run: <detail>`), if present. */
export function findRunnerFailure(stderr: string | undefined): string | undefined {
	if (!stderr) return undefined;
	const index = stderr.toLowerCase().indexOf(RUNNER_FAILURE_SIGNATURE);
	if (index < 0) return undefined;
	const line = stderr.slice(index).split(/\r?\n/, 1)[0];
	return line ?? RUNNER_FAILURE_SIGNATURE;
}

export function findDenialSignature(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const lower = text.toLowerCase();
	for (const signature of DENIAL_SIGNATURES) {
		if (lower.includes(signature)) return signature;
	}
	return undefined;
}

/**
 * Runner failures win over denials: a failure before the spawn produces no denial text, but a
 * runner cleanup line may accompany a genuine denial. Exit 127 alone is not enough — the wrapped
 * command itself may exit 127.
 */
export function classify(input: ClassifyInput): Classification {
	const runnerFailure = findRunnerFailure(input.stderr);
	if (runnerFailure) return { kind: "runner-failure", signature: runnerFailure };
	const denial = findDenialSignature(input.output) ?? findDenialSignature(input.stderr);
	if (denial) return { kind: "denied", signature: denial };
	if (input.exitCode !== 0 && input.exitCode !== null) return { kind: "command-failed" };
	return { kind: "none" };
}