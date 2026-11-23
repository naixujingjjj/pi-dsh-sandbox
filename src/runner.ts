/**
 * Locating and spawning the DSH Windows ACL confinement runner.
 *
 * The runner (`@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js`) is an argv-prefix wrapper:
 *
 *   node runner.js --workspace <dir> --temp <dir> --mode <read-only|workspace-write> -- <argv...>
 *
 * It duplicates the caller's token into a WRITE_RESTRICTED token, lowers it to Low integrity,
 * spawns the wrapped argv with the caller's stdio inherited, mirrors the exit code, and prints
 * `windows-acl-run: <detail>` + exit 127 for every runner-side failure. The child is never
 * spawned unrestricted.
 *
 * Every failure in this module is fail-closed: we never fall back to an unconfined spawn.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, win32 } from "node:path";
import { SandboxError } from "./errors.ts";
import type { ConfinedMode } from "./policy.ts";

export const ACL_PACKAGE = "@deepseek-ai/dsh-sandbox-windows-acl";
const ACL_RUNNER_RELATIVE = ["node_modules", ACL_PACKAGE, "lib", "runner.js"] as const;

export type RunnerSource = "config:runnerModule" | "config:dshRoot" | "plugin" | "installed-dsh";

export interface RunnerLocation {
	/** Absolute path of `lib/runner.js`. */
	modulePath: string;
	/** Version of the sandbox package, when its package.json sits next to the runner. */
	version: string | null;
	source: RunnerSource;
}

export interface LocateRunnerInput {
	runnerModule: string | null;
	dshRoot: string | null;
	/** Root of this plugin (used for its own bundled dependency). */
	pluginRoot: string;
	/** Global npm roots to probe for an installed `@deepseek-ai/dsh`; computed lazily. */
	globalRoots?: string[] | (() => string[]);
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function readVersion(modulePath: string): string | null {
	try {
		const manifest = resolve(modulePath, "..", "..", "package.json");
		const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
}

/**
 * Global npm roots worth probing. `%APPDATA%\npm\node_modules` is where `npm i -g` puts packages
 * on Windows; `npm root -g` is asked once as a second opinion (it can differ with a custom prefix).
 */
export function defaultGlobalRoots(): string[] {
	const roots: string[] = [];
	const appData = process.env.APPDATA;
	if (appData) roots.push(join(appData, "npm", "node_modules"));

	try {
		const npmRoot = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm root -g"], {
			encoding: "utf8",
			timeout: 10_000,
			windowsHide: true,
		});
		if (npmRoot.status === 0 && typeof npmRoot.stdout === "string") {
			const first = npmRoot.stdout.trim().split(/\r?\n/)[0];
			if (first && existsSync(first) && !roots.includes(first)) roots.push(first);
		}
	} catch {
		// npm missing or slow: the APPDATA probe above still covers the default install.
	}
	return roots;
}

/** Candidate `lib/runner.js` paths inside a global npm root. */
function globalCandidates(globalRoot: string): string[] {
	return [
		// `npm i -g @deepseek-ai/dsh` (the DSH CLI nests its dependencies)
		join(globalRoot, "@deepseek-ai", "dsh", ...ACL_RUNNER_RELATIVE),
		// `npm i -g @deepseek-ai/dsh-sandbox-windows-acl` (installed directly)
		join(globalRoot, ...ACL_RUNNER_RELATIVE.slice(1)),
	];
}

export interface LocateResult {
	location: RunnerLocation | null;
	/** Every path that was tried, for diagnostics. */
	attempted: string[];
}

/**
 * Resolve the runner. An explicitly configured path is authoritative: when it is invalid the
 * result is a hard failure (the caller raises SANDBOX_UNAVAILABLE) instead of a silent switch to
 * another installation.
 */
export function locateRunner(input: LocateRunnerInput): LocateResult {
	const attempted: string[] = [];

	if (input.runnerModule) {
		attempted.push(input.runnerModule);
		if (!isFile(input.runnerModule)) {
			throw new SandboxError(
				"SANDBOX_UNAVAILABLE",
				`配置的 runnerModule 不存在或不是文件：${input.runnerModule}。` +
					`显式配置的路径不会被自动替换（避免在用户不知情时改用别的运行器）。`,
				"This is not an unrestricted fallback: fix the path in ~/.pi/agent/settings.json (piDshSandbox.runnerModule) or unset it to let the plugin probe.",
			);
		}
		return {
			location: { modulePath: input.runnerModule, version: readVersion(input.runnerModule), source: "config:runnerModule" },
			attempted,
		};
	}

	if (input.dshRoot) {
		const candidate = join(input.dshRoot, ...ACL_RUNNER_RELATIVE);
		attempted.push(candidate);
		if (!isFile(candidate)) {
			throw new SandboxError(
				"SANDBOX_UNAVAILABLE",
				`配置的 dshRoot 下找不到运行器：${candidate}。` +
					`显式配置的路径不会被自动替换（避免在用户不知情时改用别的运行器）。`,
				"Fix ~/.pi/agent/settings.json (piDshSandbox.dshRoot) or install the DSH CLI globally.",
			);
		}
		return { location: { modulePath: candidate, version: readVersion(candidate), source: "config:dshRoot" }, attempted };
	}

	const bundled = join(input.pluginRoot, ...ACL_RUNNER_RELATIVE);
	attempted.push(bundled);
	if (isFile(bundled)) {
		return { location: { modulePath: bundled, version: readVersion(bundled), source: "plugin" }, attempted };
	}

	// npm may hoist the dependency beside this package rather than inside it. Resolve from the
	// installed plugin, never from the session cwd, before considering unrelated global installs.
	try {
		const requireFromPlugin = createRequire(join(resolve(input.pluginRoot), "package.json"));
		const dependency = requireFromPlugin.resolve(`${ACL_PACKAGE}/runner`);
		if (!attempted.includes(dependency)) attempted.push(dependency);
		if (isFile(dependency)) {
			return { location: { modulePath: dependency, version: readVersion(dependency), source: "plugin" }, attempted };
		}
	} catch {
		// An absent/unresolvable package still follows the existing fail-closed lookup path.
	}

	const globalRoots = typeof input.globalRoots === "function" ? input.globalRoots() : (input.globalRoots ?? []);
	for (const root of globalRoots) {
		for (const candidate of globalCandidates(root)) {
			attempted.push(candidate);
			if (isFile(candidate)) {
				return { location: { modulePath: candidate, version: readVersion(candidate), source: "installed-dsh" }, attempted };
			}
		}
	}

	return { location: null, attempted };
}

export function describeRunner(location: RunnerLocation): string {
	return `${location.modulePath}（${ACL_PACKAGE} ${location.version ?? "版本未知"}，来源：${location.source}）`;
}

export function runnerLookupFailure(attempted: string[]): SandboxError {
	return new SandboxError(
		"SANDBOX_UNAVAILABLE",
		"找不到 Windows ACL 沙盒运行器（@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js）。" +
			"沙盒不可用时不会以未受限方式执行命令。",
		[
			"Tried:",
			...attempted.map((path) => `  - ${path}`),
			"Fix: install the DSH CLI globally (npm i -g @deepseek-ai/dsh) or run `npm install --include=optional` in the plugin directory,",
			"or set piDshSandbox.runnerModule / --sandbox-runner to the absolute path of lib/runner.js.",
		].join("\n"),
	);
}

export interface RunnerInvocation {
	location: RunnerLocation;
	/** Canonical workspace root (the only writable root). */
	root: string;
	/** Existing directory that must be outside `root`. */
	temp: string;
	mode: ConfinedMode;
	/** The wrapped argv (shell + args, or node + helper). */
	argv: string[];
}

export function buildRunnerArgv(invocation: RunnerInvocation): string[] {
	if (!win32.isAbsolute(invocation.root)) {
		throw new SandboxError("SANDBOX_CONFIG", `工作区根必须是绝对路径：${invocation.root}`);
	}
	if (!win32.isAbsolute(invocation.temp)) {
		throw new SandboxError("SANDBOX_CONFIG", `runner temp 根必须是绝对路径：${invocation.temp}`);
	}
	if (invocation.argv.length === 0) {
		throw new SandboxError("SANDBOX_CONFIG", "runner 需要一个被包裹的命令");
	}
	return [
		process.execPath,
		invocation.location.modulePath,
		"--workspace",
		invocation.root,
		"--temp",
		invocation.temp,
		"--mode",
		invocation.mode,
		"--",
		...invocation.argv,
	];
}

export function isTempInsideWorkspace(root: string, temp: string): boolean {
	const normalize = (value: string) => win32.resolve(value).toLowerCase().replace(/[\\/]+$/, "");
	const r = normalize(root);
	const t = normalize(temp);
	return t === r || t.startsWith(`${r}\\`);
}

/** Kill a process and its descendants (the runner also holds a KILL_ON_JOB_CLOSE job). */
export function killProcessTree(pid: number): void {
	try {
		const taskkill = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
		const child = spawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		});
		child.once("error", () => {});
	} catch {
		// Best effort: the runner's Job object still kills the confined child when it exits.
	}
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_STDERR_TAIL = 8 * 1024;
const DEFAULT_STDOUT_CAP = 1024 * 1024;

export interface RunRunnerOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	/** Timeout in seconds, matching the shell tool contract. */
	timeoutSeconds?: number;
	/** Receives both streams (merged), like the built-in shell operations. */
	onData?: (chunk: Buffer) => void;
	/** Collect stdout (used by the IPC helper protocol). */
	collectStdout?: boolean;
	stdoutCap?: number;
	stderrTailLimit?: number;
}

export interface RunnerRunResult {
	exitCode: number | null;
	stdout: string;
	stderrTail: string;
}

function resolveTimeoutMs(timeoutSeconds: number | undefined): number | undefined {
	if (timeoutSeconds === undefined) return undefined;
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeoutSeconds * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
	}
	return timeoutMs;
}

function mapSpawnError(error: unknown): Error {
	const code = (error as { code?: unknown } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
		return new SandboxError("SANDBOX_UNAVAILABLE", `无法启动沙盒运行器：${message}`);
	}
	return error instanceof Error ? error : new Error(message);
}

/**
 * Spawn the runner and wait for it.
 *
 * Cancellation and timeouts mirror the built-in shell operations: `Error("aborted")`,
 * `Error("timeout:<seconds>")`, and the exit code is passed through untouched. An already
 * aborted signal never starts a process.
 */
export function runRunner(invocation: RunnerInvocation, options: RunRunnerOptions = {}): Promise<RunnerRunResult> {
	const timeoutMs = resolveTimeoutMs(options.timeoutSeconds);
	if (options.signal?.aborted) {
		return Promise.reject(new Error("aborted"));
	}

	// The host owns this per-call parent so it can remove the runner's private temp even when
	// timeout/abort kills the runner before its finally block runs. Never sweep the shared root.
	let ownedTemp: string | undefined;
	if (invocation.mode === "workspace-write" && !isTempInsideWorkspace(invocation.root, invocation.temp)) {
		try {
			if (statSync(invocation.temp).isDirectory()) {
				ownedTemp = mkdtempSync(join(invocation.temp, "call-"));
			}
		} catch {
			// Preserve the runner's diagnostic contract for missing/unusable temp roots.
		}
	}
	const cleanup = () => {
		if (!ownedTemp) return;
		try {
			rmSync(ownedTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch {
			// A crashed host or a locked directory can still leave residue; never remove other calls.
		}
	};
	let argv: string[];
	try {
		argv = buildRunnerArgv(ownedTemp ? { ...invocation, temp: ownedTemp } : invocation);
	} catch (error) {
		cleanup();
		return Promise.reject(error);
	}
	const stderrTailLimit = options.stderrTailLimit ?? DEFAULT_STDERR_TAIL;
	const stdoutCap = options.stdoutCap ?? DEFAULT_STDOUT_CAP;

	return new Promise<RunnerRunResult>((resolvePromise, rejectPromise) => {
		let settled = false;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(argv[0] as string, argv.slice(1), {
				cwd: options.cwd,
				env: options.env ?? process.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			cleanup();
			rejectPromise(mapSpawnError(error));
			return;
		}

		const stderrChunks: Buffer[] = [];
		let stderrBytes = 0;
		const stdoutChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let aborted = false;
		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (options.signal) options.signal.removeEventListener("abort", onAbort);
			cleanup();
			fn();
		};

		const kill = () => {
			if (child.pid !== undefined) killProcessTree(child.pid);
		};

		function onAbort(): void {
			aborted = true;
			kill();
		}

		const pushStderr = (chunk: Buffer) => {
			stderrChunks.push(chunk);
			stderrBytes += chunk.length;
			while (stderrBytes > stderrTailLimit && stderrChunks.length > 1) {
				const dropped = stderrChunks.shift();
				if (!dropped) break;
				stderrBytes -= dropped.length;
			}
			if (stderrBytes > stderrTailLimit && stderrChunks.length === 1) {
				const only = stderrChunks[0];
				if (only && only.length > stderrTailLimit) {
					stderrChunks[0] = only.subarray(only.length - stderrTailLimit);
					stderrBytes = stderrTailLimit;
				}
			}
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			options.onData?.(chunk);
			if (options.collectStdout && stdoutBytes < stdoutCap) {
				stdoutChunks.push(chunk);
				stdoutBytes += chunk.length;
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			pushStderr(chunk);
			options.onData?.(chunk);
		});
		child.once("error", (error) => settle(() => rejectPromise(mapSpawnError(error))));

		if (timeoutMs !== undefined) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				kill();
			}, timeoutMs);
		}
		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		child.once("close", (code) => {
			settle(() => {
				const stderrTail = Buffer.concat(stderrChunks).toString("utf8");
				if (aborted) {
					rejectPromise(new Error("aborted"));
					return;
				}
				if (timedOut) {
					rejectPromise(new Error(`timeout:${options.timeoutSeconds ?? 0}`));
					return;
				}
				const stdout = options.collectStdout ? Buffer.concat(stdoutChunks).toString("utf8") : "";
				resolvePromise({ exitCode: code, stdout, stderrTail });
			});
		});
	});
}
