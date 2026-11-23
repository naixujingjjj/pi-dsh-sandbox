/**
 * The mutation path for `write` and `edit`: a request file in, one result line out, everything
 * executed by {@link "kernel-helper"} inside the restricted token.
 *
 * Pi-free on purpose (only `import type` from the host), so the integration tests exercise exactly
 * this code without loading the whole Pi runtime.
 */
import { existsSync, statSync } from "node:fs";
import type { EditOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import { constants as fsConstants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { classify, RUNNER_FAILURE_SIGNATURE } from "./classify.ts";
import { SandboxError } from "./errors.ts";
import {
	createMutationChannel,
	disposeMutationChannel,
	parseHelperResult,
	type HelperRequest,
} from "./ipc.ts";
import { POLICY_CHECK_NOTE, type ConfinedMode } from "./policy.ts";
import { runRunner, type RunnerLocation } from "./runner.ts";

export interface MutationContext {
	runner: RunnerLocation;
	/** Canonical workspace root: the only writable root. */
	root: string;
	/** Runner `--temp` root (outside `root`). */
	temp: string;
	/** Plugin private directory for per-call channels. */
	ipcRoot: string;
	mode: ConfinedMode;
	/** Absolute path of `src/kernel-helper.mjs`. */
	helperPath: string;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Execute one mutation inside the restricted process and translate the result protocol.
 *
 * Fail-closed rules: a missing result line, a non-zero exit with `ok`, or the runner's own
 * `windows-acl-run:` signature is a sandbox failure, never a silent success.
 */
export async function runMutation(context: MutationContext, request: HelperRequest): Promise<void> {
	if (!existsSync(context.helperPath)) {
		throw new SandboxError(
			"SANDBOX_UNAVAILABLE",
			`找不到受限写 helper：${context.helperPath}（安装不完整，文件工具不会退回到进程内写盘）`,
		);
	}
	const channel = createMutationChannel(context.ipcRoot, request);
	try {
		const result = await runRunner(
			{
				location: context.runner,
				root: context.root,
				temp: context.temp,
				mode: context.mode,
				argv: [process.execPath, context.helperPath, channel.requestPath],
			},
			{ cwd: context.root, env: process.env, collectStdout: true },
		);

		if (result.stderrTail.includes(RUNNER_FAILURE_SIGNATURE)) {
			const detail = result.stderrTail.split(/\r?\n/).find((line) => line.includes(RUNNER_FAILURE_SIGNATURE));
			throw new SandboxError(
				"SANDBOX_RUNNER_FAILURE",
				`沙盒运行器失败（exit ${String(result.exitCode)}）：${detail ?? RUNNER_FAILURE_SIGNATURE}。写入没有发生。`,
				"这是 fail-closed：不会退回进程内写盘。运行 /sandbox doctor 检查运行器。",
			);
		}

		const helper = parseHelperResult(result.stdout);
		if (!helper) {
			throw new SandboxError(
				"SANDBOX_RUNNER_FAILURE",
				`受限 helper 没有返回结果协议（exit ${String(result.exitCode)}）。写入状态未知，按失败处理。` +
					`${result.stderrTail.trim() ? ` stderr: ${result.stderrTail.trim().slice(-400)}` : ""}`,
			);
		}
		if (helper.ok) {
			if (result.exitCode === 0) return;
			throw new SandboxError(
				"SANDBOX_RUNNER_FAILURE",
				`受限 helper 报告成功但进程退出码为 ${String(result.exitCode)}，按失败处理。`,
			);
		}

		const message = helper.message ?? "helper 报告失败";
		const classification = classify({
			exitCode: result.exitCode ?? 1,
			stderr: result.stderrTail,
			output: message,
		});
		if (classification.kind === "denied") {
			throw new SandboxError(
				"SANDBOX_DENIED",
				`${request.op === "mkdir" ? "创建目录" : "写入文件"}被 Windows 内核拒绝：${request.path}（${message}）`,
				`匹配拒绝签名：${classification.signature ?? "denied"}。只能写授权根 ${context.root} 与其私有 temp。${POLICY_CHECK_NOTE}`,
			);
		}
		throw new Error(`受限写入失败（${helper.code ?? "unknown"}）：${message}`);
	} finally {
		disposeMutationChannel(channel);
	}
}

/** Write tool operations: every filesystem mutation happens inside the restricted process. */
export function kernelWriteOperations(context: MutationContext): WriteOperations {
	return {
		mkdir: async (dir: string) => {
			// `mkdir(item, { recursive: true })` on an existing directory does nothing, so skipping it
			// costs no safety and keeps one runner spawn (≈150–300 ms) per write instead of two.
			if (isDirectory(dir)) return;
			await runMutation(context, { op: "mkdir", path: dir });
		},
		writeFile: async (absolutePath: string, content: string) => {
			await runMutation(context, { op: "write", path: absolutePath, content });
		},
	};
}

/**
 * Edit tool operations. Reads stay local on purpose: this backend does not restrict reads, so the
 * tool reads the same bytes it always did and only the write crosses into the sandbox.
 */
export function kernelEditOperations(context: MutationContext): EditOperations {
	return {
		readFile: (absolutePath: string) => fsReadFile(absolutePath),
		access: (absolutePath: string) => fsAccess(absolutePath, fsConstants.R_OK | fsConstants.W_OK),
		writeFile: async (absolutePath: string, content: string) => {
			await runMutation(context, { op: "write", path: absolutePath, content });
		},
	};
}