/**
 * `/sandbox` — the only way a live session's mode changes.
 *
 * No model-facing tool can change the mode: the model can call `registerTool`-less commands never,
 * and `/sandbox` handlers only run from human input. Persistence is auditable but deliberately not
 * authoritative: mode changes are appended to the session as custom entries for the record, and a
 * resumed or forked session always starts from the configured mode, never from a wider one that
 * an old session happened to use.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	getPowerShellConfig,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./errors.ts";
import {
	APPROVAL_AUDIT_ENTRY,
	APPROVAL_OPTIONS,
	type OperationRequest,
	decisionNote,
	requestOperationApproval,
} from "./approval.ts";
import { approvalStrings, type Locale } from "./i18n.ts";
import { detectLocaleFromSession } from "./locale.ts";
import {
	modeWidenCardLines,
	operationCardLines,
	operationCardStatusLines,
	resultCardLines,
} from "./tui/card.ts";
import { appendApprovalCard } from "./tui/entry.ts";
import { canOpenTuiPanel, requestTuiPanel, type PanelSpec } from "./tui/panel.ts";
import {
	type InstructionContext,
	type InstructionOutcome,
	humanFollowUpMessage,
	userInstructionOf,
} from "./reason.ts";
import {
	SANDBOX_MODES,
	describeMode,
	isSandboxMode,
	modeRank,
	canonicalDir,
	type SandboxMode,
} from "./policy.ts";
import { runRunner, type RunnerInvocation } from "./runner.ts";
import {
	PLUGIN_NAME,
	assertReady,
	bashUnavailableMessage,
	getSessionState,
	requireRunner,
	resolveBash,
	stateSummary,
	type SessionState,
} from "./state.ts";

const USAGE =
	"用法：/sandbox（选择模式） | /sandbox status | /sandbox mode <" +
	SANDBOX_MODES.join("|") +
	"> | /sandbox doctor | /sandbox exec <exact command>（四选项审批） | /sandbox help";

const AUDIT_ENTRY = "pi-dsh-sandbox/mode";

function truncate(text: string, limit = 2000): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…（已截断）`;
}

export function registerSandboxCommand(pi: ExtensionAPI, pluginRoot: string): void {
	pi.registerCommand("sandbox", {
		description:
			"沙盒状态/模式/自检/一次性未受限执行：status | mode <off|read-only|workspace-write> | doctor | exec <command>",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			if (trimmed.startsWith("mode ")) {
				const modePrefix = trimmed.slice("mode ".length).trimStart();
				const modes = SANDBOX_MODES.filter((mode) => mode.startsWith(modePrefix)).map((mode) => ({
					value: `mode ${mode}`,
					label: mode,
					description: describeMode(mode),
				}));
				return modes.length > 0 ? modes : null;
			}
			const items = [
				{ value: "status", label: "status", description: "显示模式、规范根、runner/后端版本、partial 边界" },
				{ value: "mode", label: "mode", description: "切换本条会话的模式（放宽需要确认）" },
				{ value: "doctor", label: "doctor", description: "在独立临时工作区做真实自检（写内/拒外/拒删/只读）" },
				{ value: "exec", label: "exec", description: "一次性未受限执行一条精确命令（四选项审批；No+文字=拒绝并改方向，Yes+文字=批准并附加完成后的要求）" },
				{ value: "help", label: "help", description: "用法" },
			];
			const matched = items.filter((item) => item.value.startsWith(trimmed));
			return matched.length > 0 ? matched : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = tokens[0] ?? "mode";
			const state = getSessionState(pi, pluginRoot, ctx);

			switch (subcommand) {
				case "status":
					ctx.ui.notify(stateSummary(state).join("\n"), "info");
					return;
				case "help":
				case "--help":
					ctx.ui.notify(USAGE, "info");
					return;
				case "mode":
					await handleMode(pi, ctx, state, tokens[1]);
					return;
				case "doctor":
					await handleDoctor(pi, ctx, state);
					return;
				case "exec":
					await handleExecOnce(pi, ctx, state, args.trim().slice("exec".length).trim());
					return;
				default:
					ctx.ui.notify(`未知子命令 ${subcommand}。\n${USAGE}`, "warning");
			}
		},
	});
}

async function handleMode(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: SessionState,
	requested: string | undefined,
): Promise<void> {
	const locale = detectLocaleFromSession(ctx.sessionManager);
	const text = approvalStrings(locale);
	if (!requested) {
		if (!ctx.hasUI) {
			ctx.ui.notify(`${stateSummary(state).join("\n")}\n${USAGE}`, "info");
			return;
		}
		const modes: SandboxMode[] = [state.mode, ...SANDBOX_MODES.filter((mode) => mode !== state.mode)];
		const choices = modes.map((mode) => `${mode === state.mode ? text.currentTag : ""}${describeMode(mode, locale)}`);
		const selected = await ctx.ui.select(text.chooseModeTitle, choices);
		if (selected === undefined) return;
		const index = choices.indexOf(selected);
		if (index < 0) return;
		requested = modes[index];
	}
	if (!isSandboxMode(requested)) {
		ctx.ui.notify(`${text.invalidModePrefix}${JSON.stringify(requested)}。${text.availableModesPrefix}${SANDBOX_MODES.join(" / ")}`, "warning");
		return;
	}
	if (requested === state.mode) {
		ctx.ui.notify(`${text.modeUnchangedPrefix}${describeMode(state.mode, locale)}`, "info");
		return;
	}

	const widening = modeRank(requested) > modeRank(state.mode);
	if (widening) {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`${text.modeWidenNoUiPrefix}${state.mode} → ${requested}${text.modeWidenNoUiSuffix}`,
				"error",
			);
			return;
		}
		const lines = [
			`${text.currentPrefix}${describeMode(state.mode, locale)}`,
			`${text.targetPrefix}${describeMode(requested, locale)}`,
			`${text.rootPrefix}${state.root}`,
			"",
			wideningNote(requested, locale),
			"",
			text.widenScope,
		];
		const confirmed = await confirmWidening(pi, ctx, state, requested, lines, locale);
		if (!confirmed) {
			ctx.ui.notify(text.modeWidenCancelled, "info");
			return;
		}
	}

	const previous = state.mode;
	state.mode = requested;
	state.modeSource = "command";
	pi.appendEntry(AUDIT_ENTRY, {
		previous,
		mode: requested,
		at: new Date().toISOString(),
		widening,
		locale,
	});
	ctx.ui.notify(`${text.modeChangedPrefix}${previous} → ${requested}\n${describeMode(requested, locale)}`, "info");
}

/**
 * Confirm a mode widening. The TUI uses the same yellow dock/card pair as an operation approval;
 * RPC/print keep the plain `ui.confirm`. Cancel, Esc, an unavailable panel or an aborted turn all
 * mean "not widened" — the mode is never changed by a failure mode.
 */
async function confirmWidening(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: SessionState,
	requested: SandboxMode,
	lines: readonly string[],
	locale: Locale,
): Promise<boolean> {
	const text = approvalStrings(locale);
	const title = text.widenTitle;
	const options = [
		`${text.cancelKeepPrefix}${state.mode}${text.optionWrapClose}`,
		`${text.confirmWidenPrefix}${requested}`,
	];
	if (!canOpenTuiPanel(ctx)) {
		return ctx.ui.confirm(title, lines.join("\n"));
	}
	const card = (status: "pending" | "confirmed" | "cancelled") => ({
		kind: "mode-widening" as const,
		lines: modeWidenCardLines({
			current: describeMode(state.mode, locale),
			target: describeMode(requested, locale),
			root: state.root,
			note: wideningNote(requested, locale),
			options,
			status,
			locale,
		}),
	});
	appendApprovalCard(pi, card("pending"));
	const spec: PanelSpec = {
		title,
		header: [
			`${text.currentPrefix}${describeMode(state.mode, locale)}`,
			`${text.targetPrefix}${describeMode(requested, locale)}`,
			`${text.rootPrefix}${state.root}`,
			locale === "en"
				? "The full explanation (including side effects that remain on disk) is in the yellow card in the message stream."
				: "完整说明（包括留在磁盘上的副作用）见消息流里的黄色卡片。",
		],
		options,
		defaultIndex: 0,
		reasonFor: {},
		panelKey: `pi-dsh-sandbox-mode-widen:${state.sessionId}`,
		blockedMessage: `${title}${text.panelBlockedSuffix}`,
		locale,
	};
	const outcome = await requestTuiPanel(ctx, spec, { ...(ctx.signal ? { signal: ctx.signal } : {}) });
	if (outcome.kind === "unavailable") {
		appendApprovalCard(pi, {
			kind: "mode-widening",
			lines: [{ role: "status", text: text.widenFallback }],
		});
		return ctx.ui.confirm(title, lines.join("\n"));
	}
	const confirmed = outcome.kind === "selected" && outcome.index === 1;
	appendApprovalCard(pi, card(confirmed ? "confirmed" : "cancelled"));
	return confirmed;
}

function wideningNote(mode: SandboxMode, locale: Locale = "zh"): string {
	if (locale === "en") {
		switch (mode) {
			case "off":
				return (
					"off means this plugin steps out: the shell and write/edit run unrestricted, so any file can be modified. " +
					"This is equivalent to not having the plugin installed."
				);
			case "workspace-write":
				return (
					"workspace-write allows writes to the authorization root and its private temp. First use leaves a persistent " +
					"ACE and a Low integrity label on the root (see README, side effects and rollback); they are not undone when the session ends."
				);
			case "read-only":
				return "read-only only tightens permissions to read-only.";
		}
	}
	switch (mode) {
		case "off":
			return (
				"off 表示插件不再介入：shell 与 write/edit 都以未受限方式执行，任何文件都可能被修改。" +
				"这等价于没有安装本插件。"
			);
		case "workspace-write":
			return (
				"workspace-write 允许写授权根与其私有 temp。首次使用会在授权根上留下常驻 ACE 与 Low " +
				"完整性标签（见 README「副作用与回滚」），它们不会随会话结束自动撤销。"
			);
		case "read-only":
			return "read-only 只是收紧到只读。";
	}
}

interface DoctorStep {
	name: string;
	ok: boolean;
	detail: string;
}

async function probe(
	state: SessionState,
	root: string,
	temp: string,
	mode: "read-only" | "workspace-write",
	argv: string[],
): Promise<{ exitCode: number | null; stderrTail: string; stdout: string }> {
	const invocation: RunnerInvocation = { location: requireRunner(state), root, temp, mode, argv };
	return runRunner(invocation, {
		cwd: root,
		env: process.env,
		timeoutSeconds: 180,
		collectStdout: true,
	});
}

function nodeEval(code: string): string[] {
	return [process.execPath, "-e", code];
}

async function handleDoctor(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: SessionState): Promise<void> {
	const steps: DoctorStep[] = [];
	const record = (name: string, ok: boolean, detail: string) => {
		steps.push({ name, ok, detail });
	};

	record("platform", process.platform === "win32", process.platform);
	const bash = resolveBash(state, pi);
	record(
		"bash",
		true,
		bash.status === "ok" ? `可用：${bash.shell}` : `${bashUnavailableMessage(bash).split("\n")[0]}（bash 工具与 ! 命令会被拒绝）`,
	);

	try {
		assertReady(state);
		record("runner", true, `就绪：${state.runtime.runner?.modulePath ?? "?"}`);
	} catch (error) {
		record("runner", false, errorMessage(error));
		ctx.ui.notify(formatDoctor(steps), "error");
		return;
	}

	const doctorDir = mkdtempSync(join(state.runtime.dataRoot, "doctor-"));
	const workspace = join(doctorDir, "ws");
	const temp = join(doctorDir, "tp");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(temp, { recursive: true });

	const insideFile = join(workspace, "inside.txt");
	const nestedDir = join(workspace, "nested", "deep");
	const outsideFile = join(doctorDir, "outside.txt");
	const outsideVictim = join(doctorDir, "victim.txt");
	writeFileSync(outsideVictim, "keep", "utf8");

	try {
		// 1. read-only can start a process at all.
		const smoke = await probe(state, workspace, temp, "read-only", nodeEval("0"));
		record("read-only 启动", smoke.exitCode === 0, `exit=${String(smoke.exitCode)}`);

		// 2. read-only denies a write inside the workspace.
		const readOnlyWrite = await probe(
			state,
			workspace,
			temp,
			"read-only",
			nodeEval("require('node:fs').writeFileSync(" + JSON.stringify(insideFile) + ", 'x')"),
		);
		record(
			"read-only 拒绝写入",
			readOnlyWrite.exitCode !== 0 && !existsSync(insideFile),
			`exit=${String(readOnlyWrite.exitCode)}, file=${existsSync(insideFile) ? "存在（异常）" : "不存在"}`,
		);

		// 3. workspace-write allows a write inside the root (this is the write/edit helper path).
		const writeInside = await probe(
			state,
			workspace,
			temp,
			"workspace-write",
			nodeEval("require('node:fs').writeFileSync(" + JSON.stringify(insideFile) + ", 'doctor')"),
		);
		record(
			"workspace-write 允许写入根内",
			writeInside.exitCode === 0 && existsSync(insideFile),
			`exit=${String(writeInside.exitCode)}, file=${existsSync(insideFile) ? "存在" : "不存在"}`,
		);

		// 4. workspace-write allows recursive mkdir inside the root.
		const mkdirInside = await probe(
			state,
			workspace,
			temp,
			"workspace-write",
			nodeEval("require('node:fs').mkdirSync(" + JSON.stringify(nestedDir) + ", { recursive: true })"),
		);
		record(
			"workspace-write 允许根内建目录",
			mkdirInside.exitCode === 0 && existsSync(nestedDir),
			`exit=${String(mkdirInside.exitCode)}, dir=${existsSync(nestedDir) ? "存在" : "不存在"}`,
		);

		// 5. a write outside the root is denied by the kernel.
		const writeOutside = await probe(
			state,
			workspace,
			temp,
			"workspace-write",
			nodeEval("require('node:fs').writeFileSync(" + JSON.stringify(outsideFile) + ", 'nope')"),
		);
		record(
			"根外写入被拒绝",
			writeOutside.exitCode !== 0 && !existsSync(outsideFile),
			`exit=${String(writeOutside.exitCode)}, file=${existsSync(outsideFile) ? "存在（异常）" : "不存在"}`,
		);

		// 6. a delete outside the root is denied by the kernel.
		const deleteOutside = await probe(
			state,
			workspace,
			temp,
			"workspace-write",
			nodeEval("require('node:fs').rmSync(" + JSON.stringify(outsideVictim) + ")"),
		);
		record(
			"根外删除被拒绝",
			deleteOutside.exitCode !== 0 && existsSync(outsideVictim),
			`exit=${String(deleteOutside.exitCode)}, file=${existsSync(outsideVictim) ? "仍存在" : "被删除了（异常）"}`,
		);

		// 7. exit codes are mirrored exactly.
		const exitCode = await probe(state, workspace, temp, "workspace-write", nodeEval("process.exit(42)"));
		record("退出码透传", exitCode.exitCode === 42, `exit=${String(exitCode.exitCode)}（期望 42）`);
	} catch (error) {
		record("执行探测", false, errorMessage(error));
	} finally {
		try {
			rmSync(doctorDir, { recursive: true, force: true });
		} catch (error) {
			record("清理临时工作区", false, errorMessage(error));
		}
	}

	const failed = steps.filter((step) => !step.ok).length;
	ctx.ui.notify(formatDoctor(steps), failed === 0 ? "info" : "error");
}

function formatDoctor(steps: DoctorStep[]): string {
	const failed = steps.filter((step) => !step.ok).length;
	const lines = steps.map((step) => `${step.ok ? "PASS" : "FAIL"}  ${step.name}: ${step.detail}`);
	return [
		`${PLUGIN_NAME} doctor：${failed === 0 ? "全部通过" : `${failed} 项失败`}（${steps.length} 项）`,
		...lines,
		"",
		"说明：自检只在独立临时工作区里授权，结束后递归删除，不触碰会话工作区。",
	].join("\n");
}

async function handleExecOnce(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: SessionState,
	command: string,
): Promise<void> {
	if (command.length === 0) {
		ctx.ui.notify(`缺少命令。${USAGE}`, "warning");
		return;
	}
	const locale = detectLocaleFromSession(ctx.sessionManager);
	const text = approvalStrings(locale);
	let shell: { shell: string; args: string[] };
	try {
		shell = getPowerShellConfig();
	} catch (error) {
		ctx.ui.notify(`找不到 PowerShell，无法执行：${errorMessage(error)}`, "error");
		return;
	}

	const exact = String(command);
	const sessionId = ctx.sessionManager.getSessionId();
	const requestMode = state.mode;
	const requestId = randomUUID();
	const commandHash = createHash("sha256").update(exact, "utf8").digest("hex");
	const sourceLabel = text.humanSource;
	const request: OperationRequest = {
		requestId,
		source: "human-command",
		sourceLabel,
		locale,
		command: exact,
		requestReason: text.humanReason,
		cwd: state.root,
		mode: state.mode,
	};
	// In the TUI the request is also a yellow card in the message stream; the dock only asks the
	// question. Both are appended as plain data, so the transcript keeps an accurate record.
	if (ctx.mode === "tui") {
		appendApprovalCard(pi, {
			kind: "operation",
			lines: [
				...operationCardLines(request),
				...operationCardStatusLines(
					"pending",
					APPROVAL_OPTIONS,
					undefined,
					text.execPendingChoice,
					locale,
				),
			],
		});
	}
	const decision = await requestOperationApproval(ctx, request, {
		...(ctx.signal ? { signal: ctx.signal } : {}),
	});

	const cardResult = (extra: {
		executed?: boolean;
		exitCode?: number | null;
		detail?: string;
		auditError?: string;
	} = {}): void => {
		if (ctx.mode !== "tui") return;
		appendApprovalCard(pi, {
			kind: "operation",
			lines: resultCardLines({
				status: decision.status,
				locale,
				...(decision.option === undefined ? {} : { option: decision.option }),
				...(decision.decisionReason === undefined ? {} : { decisionReason: decision.decisionReason }),
				executed: extra.executed === true,
				cwd: state.root,
				mode: state.mode,
				requestId,
				...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }),
				...(extra.detail === undefined ? {} : { detail: extra.detail }),
				...(extra.auditError === undefined ? {} : { extra: [`${text.auditWarningPrefix}${extra.auditError}`] }),
			}),
		});
	};

	// The human's approval text is the agent's instruction. This path never produces a tool result,
	// so the instruction has to be delivered as one Pi user message (`sendUserMessage`, which Pi
	// queues as a follow-up while the agent is streaming) — never by re-running the command and
	// never as a steer that could cancel the approved execution.
	const instruction = userInstructionOf(decision);
	const facts = [
		locale === "en"
			? `cwd: ${state.root} (pinned); session mode stays ${state.mode}.`
			: `cwd：${state.root}（固定）；会话模式保持 ${state.mode}。`,
	];

	const audit = (phase: "decision" | "result", extra: Record<string, unknown> = {}) => {
		if (ctx.sessionManager.getSessionId() !== sessionId) return "会话已变化，旧审批不会写入新会话。";
		try {
			pi.appendEntry(APPROVAL_AUDIT_ENTRY, {
				requestId,
				source: "human-command",
				phase,
				status: decision.status,
				locale,
				...(decision.option === undefined ? {} : { option: decision.option }),
				...(decision.decisionReason === undefined ? {} : { decisionReason: decision.decisionReason }),
				...(instruction === undefined ? {} : { reasonSource: instruction.source }),
				cwd: state.root,
				mode: state.mode,
				commandHash,
				at: new Date().toISOString(),
				plugin: PLUGIN_NAME,
				...extra,
			});
			return undefined;
		} catch (error) {
			return errorMessage(error);
		}
	};

	const deliver = (outcome: InstructionOutcome, extra: Partial<InstructionContext> = {}): boolean => {
		if (instruction === undefined) return false;
		if (typeof pi.sendUserMessage !== "function") return false;
		try {
			if (ctx.signal?.aborted || ctx.sessionManager.getSessionId() !== sessionId ||
				getSessionState(pi, state.runtime.pluginRoot, ctx) !== state ||
				canonicalDir(ctx.cwd) !== state.root || state.mode !== requestMode) return false;
			// `followUp` while streaming; immediately and with one turn when idle. Pi handles the
			// promise internally, so nothing here can block or cancel the approved execution.
			pi.sendUserMessage(
				humanFollowUpMessage(instruction, outcome, { locale, sourceLabel, command: exact, facts, ...extra }),
				{ deliverAs: "followUp" },
			);
			return true;
		} catch {
			return false;
		}
	};

	const followUpNote = (delivered: boolean): string =>
		delivered ? text.execFollowUpNote : "";

	const decisionAuditError = audit("decision");
	if (decision.status !== "approved") {
		const level = decision.status === "declined" || decision.status === "cancelled" ? "info" : "error";
		const delivered = decision.status === "declined" ? deliver("declined") : false;
		cardResult({
			detail: decision.detail,
			...(decisionAuditError === undefined ? {} : { auditError: decisionAuditError }),
		});
		ctx.ui.notify(
			`${text.notExecutedPrefix}${decisionNote(decision)}` +
				followUpNote(delivered) +
				(decisionAuditError ? `\n${text.auditWarningPrefix}${decisionAuditError}` : ""),
			level,
		);
		return;
	}
	if (ctx.signal?.aborted) {
		audit("result", { executed: false, executionError: "aborted after approval" });
		const delivered = deliver("not-executed");
		cardResult({ detail: text.execAbortedAfterApproval });
		ctx.ui.notify(`${text.notExecutedPrefix}${text.execAbortedAfterApproval}` + followUpNote(delivered), "error");
		return;
	}
	if (ctx.sessionManager.getSessionId() !== sessionId ||
		getSessionState(pi, state.runtime.pluginRoot, ctx) !== state ||
		canonicalDir(ctx.cwd) !== state.root || state.mode !== requestMode) {
		audit("result", { executed: false, executionError: "stale session/root/runtime/mode" });
		const delivered = deliver("not-executed");
		cardResult({ detail: text.execStale });
		ctx.ui.notify(`${text.notExecutedPrefix}${text.execStale}` + followUpNote(delivered), "error");
		return;
	}
	if (decisionAuditError) {
		const delivered = deliver("not-executed");
		cardResult({ detail: `${text.execAuditFailedPrefix}${decisionAuditError}` });
		ctx.ui.notify(
			`${text.notExecutedPrefix}${text.execAuditFailedPrefix}${decisionAuditError}` + followUpNote(delivered),
			"error",
		);
		return;
	}

	try {
		const result = await pi.exec(shell.shell, [...shell.args, exact], { cwd: state.root, timeout: 600_000 });
		const resultAuditError = audit("result", {
			executed: true,
			...(typeof result.code === "number" ? { exitCode: result.code } : {}),
		});
		const parts = [`exit=${result.code}`];
		if (result.killed) parts.push(text.execKilled);
		if (result.truncated) parts.push(text.execTruncated);
		const body = [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0).join("\n");
		// Report the executed facts to the agent first; the user's requirement follows in the same message.
		const delivered = deliver("executed", { facts: [...facts, `${text.execResultPrefix}${parts.join(" ")}`], excerpt: truncate(body || text.execNoOutput, 2000) });
		cardResult({
			executed: true,
			exitCode: result.code,
			detail: `${text.execResultPrefix}${parts.join(" ")}`,
			...(resultAuditError === undefined ? {} : { auditError: resultAuditError }),
		});
		ctx.ui.notify(
			truncate(
				`${text.execCompletedPrefix}${parts.join(" ")}${followUpNote(delivered)}\n${body || text.execNoOutput}` +
					(resultAuditError ? `\n${text.execResultWarning}${resultAuditError}` : ""),
			),
			result.code === 0 ? "info" : "warning",
		);
	} catch (error) {
		const resultAuditError = audit("result", { executed: true, executionError: errorMessage(error) });
		const delivered = deliver("execution-failed", { excerpt: errorMessage(error) });
		cardResult({
			executed: true,
			detail: `${text.execFailedPrefix}${errorMessage(error)}`,
			...(resultAuditError === undefined ? {} : { auditError: resultAuditError }),
		});
		ctx.ui.notify(
			`${text.execFailedPrefix}${errorMessage(error)}` +
				followUpNote(delivered) +
				(resultAuditError ? `\n${text.execResultWarning}${resultAuditError}` : ""),
			"error",
		);
	}
}
