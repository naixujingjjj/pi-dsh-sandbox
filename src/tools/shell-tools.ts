/**
 * `powershell` and `bash` tools routed through the DSH Windows ACL runner.
 *
 * The tool definitions themselves (prompt text, renderers, truncation, timeout/abort wording,
 * PI_* environment exposure) come from Pi's built-in factories; only `operations` is replaced, so
 * everything the model and the UI see stays identical to a native Pi session.
 *
 * PowerShell command shape is byte-identical to Pi's local backend, including the UTF-8 console
 * prefix and the Windows PowerShell 5.1 exit-code suffix.
 */
import {
	createBashToolDefinition,
	createPowerShellToolDefinition,
	getPowerShellConfig,
	type BashOperations,
	type ExtensionAPI,
	type ExtensionToolContext,
	type PowerShellOperations,
} from "@earendil-works/pi-coding-agent";
import { classify } from "../classify.ts";
import { SandboxError, errorMessage } from "../errors.ts";
import { composePowerShellCommand } from "../shell-command.ts";
import type { AgentToolResultLike } from "./types.ts";
import { runRunner, type RunnerInvocation } from "../runner.ts";
import {
	assertReady,
	bashUnavailableMessage,
	getSessionState,
	requireRunner,
	resolveBash,
	tempRootOf,
	type SessionState,
} from "../state.ts";

const OUTPUT_TAIL_LIMIT = 8 * 1024;

/** Last bytes of the merged stream, kept only to classify a denial for the error message. */
export interface OutputTail {
	bytes: Buffer[];
	size: number;
}

export function createOutputTail(): OutputTail {
	return { bytes: [], size: 0 };
}

export function appendOutputTail(tail: OutputTail, chunk: Buffer, limit = OUTPUT_TAIL_LIMIT): void {
	tail.bytes.push(chunk);
	tail.size += chunk.length;
	while (tail.size > limit && tail.bytes.length > 1) {
		const dropped = tail.bytes.shift();
		if (!dropped) break;
		tail.size -= dropped.length;
	}
	const first = tail.bytes[0];
	if (tail.bytes.length === 1 && first && first.length > limit) {
		tail.bytes[0] = first.subarray(first.length - limit);
		tail.size = limit;
	}
}

export function outputTailText(tail: OutputTail): string {
	return Buffer.concat(tail.bytes).toString("utf8");
}

function confinedInvocation(state: SessionState, argv: string[]): RunnerInvocation {
	const location = requireRunner(state);
	if (state.mode === "off") {
		throw new SandboxError("SANDBOX_CONFIG", "off 模式不应进入受限执行路径");
	}
	return { location, root: state.root, temp: tempRootOf(state), mode: state.mode, argv };
}

function shellMissing(what: string, error: unknown): SandboxError {
	return new SandboxError(
		"SANDBOX_UNAVAILABLE",
		`找不到 ${what}：${errorMessage(error)}。沙盒不会以未受限方式执行命令。`,
	);
}

/** Shell operations that spawn the runner instead of the shell directly. */
export function confinedPowerShellOperations(state: SessionState, tail: OutputTail): PowerShellOperations {
	return {
		async exec(command, _cwd, options): Promise<{ exitCode: number | null }> {
			assertReady(state);
			let shellConfig: { shell: string; args: string[] };
			try {
				shellConfig = getPowerShellConfig();
			} catch (error) {
				throw shellMissing("PowerShell", error);
			}
			const fullCommand = composePowerShellCommand(command, shellConfig.shell);
			const invocation = confinedInvocation(state, [shellConfig.shell, ...shellConfig.args, fullCommand]);
			const result = await runRunner(invocation, {
				cwd: state.root,
				env: options.env,
				signal: options.signal,
				timeoutSeconds: options.timeout,
				onData: (chunk) => {
					appendOutputTail(tail, chunk);
					options.onData(chunk);
				},
			});
			return { exitCode: result.exitCode };
		},
	};
}

/** Bash operations for a non-WSL bash (Git Bash / MSYS2 / Cygwin). */
export function confinedBashOperations(
	state: SessionState,
	tail: OutputTail,
	shell: { shell: string; args: string[] },
): BashOperations {
	return {
		async exec(command, _cwd, options): Promise<{ exitCode: number | null }> {
			assertReady(state);
			const invocation = confinedInvocation(state, [shell.shell, ...shell.args, command]);
			const result = await runRunner(invocation, {
				cwd: state.root,
				env: options.env,
				signal: options.signal,
				timeoutSeconds: options.timeout,
				onData: (chunk) => {
					appendOutputTail(tail, chunk);
					options.onData(chunk);
				},
			});
			return { exitCode: result.exitCode };
		},
	};
}

function sandboxNote(state: SessionState, kind: "denied" | "runner-failure", signature?: string): string {
	if (kind === "denied") {
		return (
			`\n\n[sandbox: ${state.mode}] 写操作被 Windows 内核拒绝（匹配：${signature ?? "denied"}）。` +
			`只能写授权根 ${state.root} 与其私有 temp；读、网络不受限，enforcement=partial。` +
			"若确实需要这一次越界操作，可调用 sandbox_request 提交具体命令与你的申请理由（人类四项审批：批准只执行这一次；拒绝时可给出新的执行方向，代理据新方向继续）。"
		);
	}
	return (
		`\n\n[sandbox: runner-failure] 沙盒运行器自身失败（${signature ?? "windows-acl-run"}），命令没有被执行。` +
		"这是 fail-closed：插件不会退回未受限执行。运行 /sandbox doctor 检查运行器。"
	);
}

export function annotateShellResult<T extends AgentToolResultLike>(
	result: T,
	state: SessionState,
	tail: OutputTail,
): T {
	if (!result.isError) return result;
	const output = outputTailText(tail);
	// The tail is the merged stream, so feed it to both fields: the runner's own failure signature
	// and the denial texts can appear on either side.
	const classification = classify({ exitCode: 1, stderr: output, output });
	if (classification.kind === "none" || classification.kind === "command-failed") return result;
	const note = sandboxNote(state, classification.kind, classification.signature);
	const content = Array.isArray(result.content) ? [...result.content] : [];
	for (let index = content.length - 1; index >= 0; index -= 1) {
		const block = content[index] as { type?: string; text?: string } | undefined;
		if (block && block.type === "text" && typeof block.text === "string") {
			content[index] = { ...block, text: block.text + note };
			return { ...result, content } as T;
		}
	}
	return result;
}

export function registerPowerShellTool(pi: ExtensionAPI, pluginRoot: string): void {
	const base = createPowerShellToolDefinition(process.cwd());
	pi.registerTool({
		...base,
		async execute(id, params, signal, onUpdate, ctx: ExtensionToolContext) {
			const state = getSessionState(pi, pluginRoot, ctx);
			if (state.runtime.configError) throw state.runtime.configError;
			if (state.mode === "off") {
				return createPowerShellToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			}
			assertReady(state);
			const tail = createOutputTail();
			const definition = createPowerShellToolDefinition(ctx.cwd, {
				operations: confinedPowerShellOperations(state, tail),
			});
			const result = await definition.execute(id, params, signal, onUpdate, ctx);
			return annotateShellResult(result, state, tail);
		},
	});
}

export function registerBashTool(pi: ExtensionAPI, pluginRoot: string): void {
	const base = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...base,
		// A same-name registration activates the tool unless it says otherwise. `bash` is disabled
		// in this machine's settings (`defaultTools: ["-bash", "+powershell"]`); overriding it must
		// not add it back to the active set. An allowlist entry (`+bash`, `--tools bash`) still
		// activates it, and an already active bash stays active.
		defaultActive: false,
		async execute(id, params, signal, onUpdate, ctx: ExtensionToolContext) {
			const state = getSessionState(pi, pluginRoot, ctx);
			if (state.runtime.configError) throw state.runtime.configError;
			const settings = pi.getSettings() as { shellCommandPrefix?: string };
			const commandPrefix = settings.shellCommandPrefix;
			if (state.mode === "off") {
				return createBashToolDefinition(ctx.cwd, { commandPrefix }).execute(id, params, signal, onUpdate, ctx);
			}
			assertReady(state);
			const bash = resolveBash(state, pi);
			if (bash.status !== "ok") {
				throw new SandboxError("SANDBOX_UNAVAILABLE", bashUnavailableMessage(bash));
			}
			const tail = createOutputTail();
			const definition = createBashToolDefinition(ctx.cwd, {
				operations: confinedBashOperations(state, tail, bash),
				commandPrefix,
			});
			const result = await definition.execute(id, params, signal, onUpdate, ctx);
			return annotateShellResult(result, state, tail);
		},
	});
}

/**
 * `!` / `!!` commands. Pi runs them through bash semantics by default; with the sandbox on we
 * either confine them or block them. Blocking (throwing) is the documented behaviour: a thrown
 * `user_bash` handler stops the command instead of falling through to local execution.
 */
export function registerUserBash(pi: ExtensionAPI, pluginRoot: string): void {
	pi.on("user_bash", (_event, ctx) => {
		const state = getSessionState(pi, pluginRoot, ctx);
		if (state.runtime.configError) throw state.runtime.configError;
		if (state.mode === "off") return undefined;
		assertReady(state);
		const bash = resolveBash(state, pi);
		if (bash.status !== "ok") {
			throw new SandboxError("SANDBOX_UNAVAILABLE", bashUnavailableMessage(bash));
		}
		const tail = createOutputTail();
		return {
			operations: {
				async exec(command: string, _cwd: string, options: {
					onData: (data: Buffer) => void;
					signal?: AbortSignal;
					timeout?: number;
					env?: NodeJS.ProcessEnv;
				}) {
					const invocation = confinedInvocation(state, [bash.shell, ...bash.args, command]);
					const result = await runRunner(invocation, {
						// Always the canonical authorized root: a `!` command cannot relocate the grant.
						cwd: state.root,
						env: options.env,
						signal: options.signal,
						timeoutSeconds: options.timeout,
						onData: (chunk) => {
							appendOutputTail(tail, chunk);
							options.onData(chunk);
						},
					});
					return { exitCode: result.exitCode };
				},
			},
		};
	});
}
