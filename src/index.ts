/**
 * pi-dsh-sandbox — Windows write confinement for Pi.
 *
 * What it does:
 *  - `powershell` (and `bash`, when a non-WSL bash exists) run inside the DSH Windows ACL
 *    restricted-token runner: writes and deletes outside the session root are denied by the
 *    kernel, `!` / `!!` commands included.
 *  - `write` / `edit` keep every built-in semantic, but the bytes are written by a helper that runs
 *    inside that same restricted process.
 *
 * What it does not do: it does not confine reads, the network, or process visibility, and it never
 * silently falls back to an unconfined execution when the sandbox is unavailable.
 */
import { errorMessage } from "./errors.ts";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSandboxCommand } from "./commands.ts";
import {
	PLUGIN_NAME,
	getSessionState,
	invalidateRuntime,
	invalidateSessions,
	pluginRootOf,
} from "./state.ts";
import { registerFsTools } from "./tools/fs-tools.ts";
import { registerSandboxRequestTool } from "./tools/sandbox-request.ts";
import { registerBashTool, registerPowerShellTool, registerUserBash } from "./tools/shell-tools.ts";
import { registerApprovalCardRenderer } from "./tui/entry.ts";
import { clearLiveApprovals, restoreHistoricalApprovalLocales } from "./tui/live.ts";
import { resetReadinessNotifications } from "./readiness.ts";

const pluginRoot = pluginRootOf(import.meta.url);

/** Tools this build can confine. They are blocked outright if initialization fails. */
const CONFINEABLE_TOOLS = ["powershell", "bash", "write", "edit", "sandbox_request"] as const;

export default function piDshSandbox(pi: ExtensionAPI): void {
	try {
		pi.registerFlag("sandbox-mode", {
			description: "pi-dsh-sandbox 模式：off | read-only | workspace-write（默认 workspace-write）",
			type: "string",
		});
		pi.registerFlag("sandbox-runner", {
			description: "沙盒运行器 lib/runner.js 的绝对路径（覆盖自动探测）",
			type: "string",
		});
		pi.registerFlag("sandbox-dsh-root", {
			description: "DSH 安装根的绝对路径（覆盖自动探测）",
			type: "string",
		});
		pi.registerFlag("sandbox-temp", {
			description: "runner 的 --temp 根目录（必须是工作区之外的绝对路径）",
			type: "string",
		});

		registerPowerShellTool(pi, pluginRoot);
		registerBashTool(pi, pluginRoot);
		registerFsTools(pi, pluginRoot);
		registerSandboxRequestTool(pi, pluginRoot);
		registerUserBash(pi, pluginRoot);
		registerSandboxCommand(pi, pluginRoot);
		// Yellow approval cards for the human `/sandbox exec` and widening-confirm paths. Registered
		// after the tools so a load failure above never leaves a half-configured entry renderer.
		registerApprovalCardRenderer(pi);
	} catch (error) {
		// A load-time failure would otherwise leave Pi's built-in tools running unconfined without
		// anyone noticing, so refuse the tools this build was supposed to confine.
		const message =
			`${PLUGIN_NAME} 初始化失败：${errorMessage(error)}。` +
			`为避免未受限执行，已阻止 ${CONFINEABLE_TOOLS.join(" / ")} 工具。沙盒不可用意味着没有沙盒，而不是降级为直通。`;
		try {
			pi.on("tool_call", (event) => {
				if ((CONFINEABLE_TOOLS as readonly string[]).includes(event.toolName)) {
					return { block: true, reason: message };
				}
				return undefined;
			});
			pi.on("user_bash", () => {
				throw new Error(message);
			});
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.notify(message, "error");
			});
		} catch {
			// Nothing else can be done from inside a broken extension load.
		}
		return;
	}

	const notified = new Set<string>();

	pi.on("session_start", (event, ctx) => {
		// Re-read the global settings and reset the mode from configuration. A resumed, forked or
		// reloaded session never inherits a wider mode from history.
		invalidateRuntime();
		resetReadinessNotifications();
		if (event.reason !== "reload") {
			invalidateSessions();
			clearLiveApprovals();
		}
		// A restored sandbox_request row only has its arguments; the locale was saved with the tool
		// result. Rebuild the row -> locale map from the current branch so a reloaded card keeps the
		// language it was approved in instead of falling back to Chinese next to an English result.
		try {
			restoreHistoricalApprovalLocales(ctx.sessionManager.getBranch());
		} catch {
			restoreHistoricalApprovalLocales([]);
		}
		const state = getSessionState(pi, pluginRoot, ctx);
		if (notified.has(state.sessionId)) return;
		notified.add(state.sessionId);
		for (const warning of state.runtime.config.warnings) {
			ctx.ui.notify(`${PLUGIN_NAME}: ${warning}`, "warning");
		}
		if (state.runtime.configError) {
			ctx.ui.notify(`${PLUGIN_NAME}: ${state.runtime.configError.message}`, "error");
		} else if (state.runtime.runnerError) {
			ctx.ui.notify(
				`${PLUGIN_NAME}: ${state.runtime.runnerError.message}\n运行 /sandbox status 查看探测过的路径。`,
				"error",
			);
		} else if (state.mode !== "off") {
			ctx.ui.notify(
				`${PLUGIN_NAME}: ${state.mode}，根 ${state.root}，enforcement=partial（只限写入/删除）。/sandbox status 查看详情。`,
				"info",
			);
		}
	});
}
