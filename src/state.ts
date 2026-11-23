/**
 * Per-process configuration and per-session sandbox state.
 *
 * Security-relevant rules implemented here:
 *
 * - The root is the canonical real path of the session `cwd`, pinned once per session. A command
 *   that `cd`s somewhere else changes neither the runner's `--workspace` argument nor the grant.
 * - The mode comes from explicit user configuration (global settings or a CLI flag). Project
 *   settings are never read, so a repository cannot widen the sandbox.
 * - Only a human command (`/sandbox mode`) changes the mode of a live session. Nothing restores a
 *   wider mode from session history, and no model-facing tool can change it.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, getShellConfig, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_KEY, parseConfig, type SandboxConfig } from "./config.ts";
import { SandboxError, errorMessage, isSandboxError } from "./errors.ts";
import {
	POLICY_CHECK_NOTE,
	canonicalDir,
	containment,
	describeMode,
	modeAllowsWrite,
	type SandboxMode,
} from "./policy.ts";
import {
	defaultGlobalRoots,
	isTempInsideWorkspace,
	locateRunner,
	runnerLookupFailure,
	type RunnerLocation,
} from "./runner.ts";

export const PLUGIN_NAME = "pi-dsh-sandbox";

export interface SandboxRuntime {
	config: SandboxConfig;
	configError: SandboxError | null;
	runner: RunnerLocation | null;
	runnerError: SandboxError | null;
	runnerAttempted: string[];
	tempRoot: string | null;
	tempError: SandboxError | null;
	dataRoot: string;
	ipcRoot: string;
	pluginRoot: string;
	pluginVersion: string;
}

export type BashResolution =
	| { status: "ok"; shell: string; args: string[] }
	| { status: "wsl"; shell: string; detail: string }
	| { status: "missing"; detail: string };

export interface SessionState {
	sessionId: string;
	/** Raw session cwd (as reported by Pi). */
	cwd: string;
	/** Canonical real path of the session cwd: the only writable root. */
	root: string;
	mode: SandboxMode;
	modeSource: string;
	runtime: SandboxRuntime;
	bash: BashResolution | undefined;
}

function dataDirectory(): string {
	const base = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? process.cwd();
	return join(base, PLUGIN_NAME);
}

function globalSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function readGlobalSettings(): string | null {
	const path = globalSettingsPath();
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new SandboxError(
			"SANDBOX_CONFIG",
			`无法读取全局设置 ${path}：${errorMessage(error)}`,
			"沙盒配置只从全局设置与显式 CLI 参数读取（不读取项目内配置）。",
		);
	}
}

/**
 * Load the runtime once per process. Called again on `session_start`, so a settings edit + /reload
 * is picked up without restarting Pi.
 */
export function loadRuntime(pi: ExtensionAPI, pluginRoot: string): SandboxRuntime {
	const dataRoot = dataDirectory();
	const ipcRoot = join(dataRoot, "ipc");
	const runtime: SandboxRuntime = {
		config: {
			mode: "workspace-write",
			modeSource: "default",
			runnerModule: null,
			dshRoot: null,
			tempRoot: null,
			fatal: [],
			warnings: [],
		},
		configError: null,
		runner: null,
		runnerError: null,
		runnerAttempted: [],
		tempRoot: null,
		tempError: null,
		dataRoot,
		ipcRoot,
		pluginRoot,
		pluginVersion: readPluginVersion(pluginRoot),
	};

	try {
		runtime.config = parseConfig({
			settingsText: readGlobalSettings(),
			flags: {
				"sandbox-mode": pi.getFlag("sandbox-mode"),
				"sandbox-runner": pi.getFlag("sandbox-runner"),
				"sandbox-dsh-root": pi.getFlag("sandbox-dsh-root"),
				"sandbox-temp": pi.getFlag("sandbox-temp"),
			},
		});
	} catch (error) {
		runtime.configError = isSandboxError(error)
			? error
			: new SandboxError("SANDBOX_CONFIG", `读取沙盒配置失败：${errorMessage(error)}`);
		return runtime;
	}

	if (runtime.config.fatal.length > 0) {
		runtime.configError = new SandboxError(
			"SANDBOX_CONFIG",
			`配置不被支持：${runtime.config.fatal.join("；")}`,
			`修复 ~/.pi/agent/settings.json 的 ${CONFIG_KEY} 配置段。`,
		);
		return runtime;
	}

	try {
		const located = locateRunner({
			runnerModule: runtime.config.runnerModule,
			dshRoot: runtime.config.dshRoot,
			pluginRoot,
			globalRoots: defaultGlobalRoots,
		});
		runtime.runner = located.location;
		runtime.runnerAttempted = located.attempted;
		if (!located.location) runtime.runnerError = runnerLookupFailure(located.attempted);
	} catch (error) {
		runtime.runnerError = isSandboxError(error)
			? error
			: new SandboxError("SANDBOX_UNAVAILABLE", `定位沙盒运行器失败：${errorMessage(error)}`);
	}

	const tempBase = runtime.config.tempRoot ?? join(dataRoot, "tmp");
	try {
		mkdirSync(tempBase, { recursive: true });
		runtime.tempRoot = win32.resolve(tempBase);
	} catch (error) {
		runtime.tempError = new SandboxError(
			"SANDBOX_CONFIG",
			`无法创建 runner 的 temp 根目录 ${tempBase}：${errorMessage(error)}`,
			"设置 piDshSandbox.tempRoot 或 --sandbox-temp 为一个可写目录（必须位于工作区之外）。",
		);
	}

	return runtime;
}

const sessionStates = new Map<string, SessionState>();
let currentRuntime: SandboxRuntime | null = null;

export function getRuntime(pi: ExtensionAPI, pluginRoot: string): SandboxRuntime {
	if (!currentRuntime) currentRuntime = loadRuntime(pi, pluginRoot);
	return currentRuntime;
}

export function invalidateRuntime(): void {
	currentRuntime = null;
}

/** Drop every session state (called on reload and at session end). */
export function invalidateSessions(): void {
	sessionStates.clear();
}

export function forgetSession(sessionId: string): void {
	sessionStates.delete(sessionId);
}

export function getSessionState(
	pi: ExtensionAPI,
	pluginRoot: string,
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): SessionState {
	const sessionId = ctx.sessionManager.getSessionId();
	const runtime = getRuntime(pi, pluginRoot);
	const existing = sessionStates.get(sessionId);
	if (existing && existing.runtime === runtime) return existing;

	const state: SessionState = {
		sessionId,
		cwd: ctx.cwd,
		root: canonicalDir(ctx.cwd),
		mode: runtime.config.mode,
		modeSource: runtime.config.modeSource,
		runtime,
		bash: undefined,
	};
	sessionStates.set(sessionId, state);
	return state;
}

export function setSessionMode(state: SessionState, mode: SandboxMode, source: string): void {
	state.mode = mode;
	state.modeSource = source;
}

/**
 * Fail-closed readiness check. Every tool that executes something throws this before touching the
 * filesystem or spawning anything.
 */
export function assertReady(state: SessionState): void {
	if (process.platform !== "win32") {
		throw new SandboxError(
			"SANDBOX_UNAVAILABLE",
			`本插件只有 Windows 后端（受限令牌 + Low 完整性标签），当前平台是 ${process.platform}。` +
				"confined 模式下不会以未受限方式执行任何命令。",
			"在非 Windows 平台把 /sandbox 切到 off 才会回到 Pi 的内置执行路径（那是用户显式选择，不是插件降级）。",
		);
	}
	if (state.runtime.configError) throw state.runtime.configError;
	if (state.runtime.runnerError) throw state.runtime.runnerError;
	if (state.runtime.runner === null) {
		throw runnerLookupFailure(state.runtime.runnerAttempted);
	}
	if (state.runtime.tempError) throw state.runtime.tempError;
	const tempRoot = state.runtime.tempRoot;
	if (!tempRoot) {
		throw new SandboxError("SANDBOX_CONFIG", "runner 的 temp 根目录未就绪");
	}
	if (isTempInsideWorkspace(state.root, tempRoot)) {
		throw new SandboxError(
			"SANDBOX_CONFIG",
			`runner 的 temp 根目录不能位于工作区内：${tempRoot}（工作区根：${state.root}）`,
			"设置 piDshSandbox.tempRoot / --sandbox-temp 到工作区之外，例如 %LOCALAPPDATA%\\pi-dsh-sandbox\\tmp。",
		);
	}
}

/** The runner location, after {@link assertReady}. */
export function requireRunner(state: SessionState): RunnerLocation {
	assertReady(state);
	const runner = state.runtime.runner;
	if (!runner) throw runnerLookupFailure(state.runtime.runnerAttempted);
	return runner;
}

export function tempRootOf(state: SessionState): string {
	const tempRoot = state.runtime.tempRoot;
	if (!tempRoot) {
		throw new SandboxError("SANDBOX_CONFIG", "runner 的 temp 根目录未就绪");
	}
	return tempRoot;
}

/** True when the configured bash is the WSL launcher (it runs in another kernel). */
export function isWslBashLauncher(shell: string): boolean {
	const normalized = win32.normalize(shell).toLowerCase();
	const systemRoot = process.env.SystemRoot;
	if (systemRoot && /^[a-z]:[\\/]/i.test(systemRoot)) {
		const candidates = ["System32", "Sysnative"].map((dir) =>
			win32.join(systemRoot, dir, "bash.exe").toLowerCase(),
		);
		return candidates.includes(normalized);
	}
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

export function resolveBash(state: SessionState, pi: ExtensionAPI): BashResolution {
	if (state.bash) return state.bash;
	let resolution: BashResolution;
	try {
		const settings = pi.getSettings() as { shellPath?: string };
		const config = getShellConfig(settings.shellPath) as {
			shell: string;
			args: string[];
			commandTransport?: "stdin" | undefined;
		};
		if (config.commandTransport === "stdin" || isWslBashLauncher(config.shell)) {
			resolution = {
				status: "wsl",
				shell: config.shell,
				detail:
					`检测到 WSL bash 启动器（${config.shell}）。它把命令交给 Linux 虚拟机执行，` +
					"Windows 受限令牌与 Low 完整性标签无法约束它，因此本插件拒绝把它当作沙盒后端。",
			};
		} else {
			resolution = { status: "ok", shell: config.shell, args: config.args };
		}
	} catch (error) {
		resolution = {
			status: "missing",
			detail: `找不到可用的 bash：${errorMessage(error)}`,
		};
	}
	state.bash = resolution;
	return resolution;
}

export function bashUnavailableMessage(resolution: BashResolution): string {
	if (resolution.status === "ok") return `bash 可用：${resolution.shell}`;
	if (resolution.status === "wsl") {
		return (
			`${resolution.detail}\n` +
			"bash/! 命令已被拒绝（不会退回到未受限执行）。" +
			"可选方案：安装 Git for Windows（https://git-scm.com/download/win）并在 ~/.pi/agent/settings.json 设置 shellPath 指向 Git 的 bash.exe，或改用 powershell 工具。"
		);
	}
	return (
		`${resolution.detail}\n` +
		"bash/! 命令已被拒绝（不会退回到未受限执行）。可选方案：安装 Git for Windows 或设置 shellPath。"
	);
}

/**
 * Early refusal for `write`/`edit`, so a doomed mutation fails before any filesystem call.
 *
 * `read-only` refuses everything, including `mkdir`. In `workspace-write`, a target outside the
 * canonical root is refused with the same message the kernel would produce, but the kernel remains
 * the authority: this check only improves the error.
 */
export function assertMutationAllowed(
	state: SessionState,
	toolName: string,
	rawPath: string,
	baseDir: string,
): void {
	if (state.mode === "off") return;
	if (!modeAllowsWrite(state.mode)) {
		throw new SandboxError(
			"SANDBOX_READ_ONLY",
			`${toolName} 在 ${describeMode(state.mode)} 下被拒绝：${rawPath}（未创建任何目录或文件）`,
			"切换到 workspace-write 需要由人类执行 /sandbox mode workspace-write（会要求确认）。",
		);
	}
	const verdict = containment(rawPath, baseDir, state.root);
	if (!verdict.inside) {
		throw new SandboxError(
			"SANDBOX_DENIED",
			`${toolName} 拒绝写入 ${verdict.target}：${verdict.reason ?? "不在授权根内"}。授权根（规范真实路径）：${state.root}`,
			`${POLICY_CHECK_NOTE}；如确需这一次越界写入，可调用 sandbox_request 提交一条精确 PowerShell 命令与理由（需人类四项审批，只执行一次）`,
		);
	}
}

export function stateSummary(state: SessionState): string[] {
	const { runtime } = state;
	const lines: string[] = [];
	lines.push(`${PLUGIN_NAME} ${runtime.pluginVersion}`);
	lines.push(`mode: ${describeMode(state.mode)}（来源：${state.modeSource}）`);
	lines.push(`root（规范真实路径）: ${state.root}`);
	lines.push(`session cwd: ${state.cwd}`);
	lines.push("enforcement: partial（只限制写入/删除；读、网络、进程可见性不受限）");
	lines.push("sandbox_request: 模型可申请一次性 off 执行；每次都要人类四选项审批，不改模式、不授予后续权限");
	lines.push("审批文字: 人类在审批窗口填写的内容会作为补充指令交给代理（No=新方向继续，Yes=操作完成后完成要求）");
	lines.push(`platform: ${process.platform}`);
	if (runtime.configError) lines.push(`config: 错误 ${runtime.configError.message}`);
	if (runtime.runner) {
		lines.push(`runner: ${runtime.runner.modulePath}`);
		lines.push(`backend: @deepseek-ai/dsh-sandbox-windows-acl ${runtime.runner.version ?? "版本未知"}（来源：${runtime.runner.source}）`);
	} else if (runtime.runnerError) {
		lines.push(`runner: 不可用（${runtime.runnerError.message}）`);
	}
	lines.push(`temp: ${runtime.tempRoot ?? "未就绪"}`);
	lines.push(`ipc: ${runtime.ipcRoot}`);
	const bash = state.bash;
	if (bash) {
		lines.push(
			bash.status === "ok"
				? `bash: ${bash.shell}`
				: `bash: 不可用于沙盒（${bash.status === "wsl" ? "WSL 启动器被拒绝" : "未找到 bash"}）`,
		);
	}
	for (const warning of runtime.config.warnings) lines.push(`warning: ${warning}`);
	return lines;
}

export function pluginRootOf(moduleUrl: string): string {
	// <pkg>/src/state.ts -> <pkg>
	return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

function readPluginVersion(pluginRoot: string): string {
	try {
		const manifest = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as { version?: unknown };
		return typeof manifest.version === "string" ? manifest.version : "unknown";
	} catch {
		return "unknown";
	}
}