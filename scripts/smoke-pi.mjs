/**
 * SDK-layer smoke test — keyless.
 *
 * Builds a real Pi `AgentSession` with this package loaded as an extension through Pi's own
 * resource loader, then inspects the tool registry and *executes* the registered tools directly.
 * No model request is made, so it costs nothing and needs no credentials.
 *
 * What it proves:
 *  - the extension loads through jiti with no load error and overrides the built-in tools;
 *  - `powershell` runs confined (a write outside the session root is denied by the kernel);
 *  - `write`/`edit` actually land through the restricted helper and are refused outside the root;
 *  - the `bash` override is registered but NOT active, and refuses the WSL launcher.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = mkdtempSync(join(tmpdir(), "pidsbx-smoke-"));
const workspace = join(base, "ws");
const outside = join(base, "out");
const agentDir = join(base, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(workspace, { recursive: true });
mkdirSync(outside, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const passed = [];
function ok(name, detail = "") {
	passed.push(name);
	console.log(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
}

function toolContext(cwd) {
	return {
		cwd,
		mode: "print",
		hasUI: false,
		ui: {
			notify() {},
			confirm: async () => false,
			select: async () => undefined,
			input: async () => undefined,
			setStatus() {},
		},
		sessionManager: {
			getSessionId: () => "smoke-session",
			getCwd: () => cwd,
			getSessionFile: () => undefined,
			getSessionDir: () => base,
			getLeafId: () => null,
			getBranch: () => [],
			getEntries: () => [],
		},
		isIdle: () => true,
		isProjectTrusted: () => false,
		signal: undefined,
		abort() {},
		shutdown() {},
		getSystemPrompt: () => "",
	};
}

async function runTool(definition, params, ctx) {
	return definition.execute("smoke-call", params, undefined, undefined, ctx);
}

let session;
try {
	const settingsManager = SettingsManager.inMemory({
		// Reproduce this machine's tool selection: bash disabled, powershell enabled.
		defaultTools: ["-bash", "+powershell"],
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: workspace,
		agentDir: getAgentDir(),
		settingsManager,
		additionalExtensionPaths: [pluginRoot],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();

	const loaded = resourceLoader.getExtensions();
	assert.deepEqual(
		loaded.errors.map((error) => `${error.path}: ${error.error}`),
		[],
		"the extension must load without errors",
	);
	assert.equal(
		loaded.extensions.some((extension) => extension.path.endsWith(join("src", "index.ts"))),
		true,
		`expected this package in the loaded extension list: ${loaded.extensions.map((ext) => ext.path).join(", ")}`,
	);
	ok("extension loads through Pi's jiti loader");

	const created = await createAgentSession({
		cwd: workspace,
		agentDir: getAgentDir(),
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(),
	});
	session = created.session;

	const active = session.getActiveToolNames();
	assert.equal(active.includes("powershell"), true, `powershell must be active: ${active.join(", ")}`);
	assert.equal(active.includes("write"), true);
	assert.equal(active.includes("edit"), true);
	assert.equal(active.includes("sandbox_request"), true, `sandbox_request must be active: ${active.join(", ")}`);
	assert.equal(active.includes("bash"), false, `bash must stay inactive: ${active.join(", ")}`);
	ok("powershell/write/edit/sandbox_request are active and bash stays inactive", active.join(", "));

	const all = session.getAllTools();
	assert.equal(all.some((tool) => tool.name === "bash"), true, "bash override must be registered");
	assert.equal(all.some((tool) => tool.name === "powershell"), true);
	ok("the bash override is registered but not activated");

	const ctx = toolContext(workspace);

	// --- powershell: inside allowed, outside denied by the kernel -----------------------------
	const powerShell = session.getToolDefinition("powershell");
	assert.ok(powerShell, "powershell definition");
	const inside = join(workspace, "pwsh-smoke.txt");
	const shellResult = await runTool(powerShell, { command: `Set-Content -LiteralPath '${inside}' -Value 'SMOKE' -Encoding UTF8; Get-Content -LiteralPath '${inside}'` }, ctx);
	assert.equal(shellResult.isError, undefined);
	assert.match(shellResult.content[0].text, /SMOKE/);
	assert.equal(existsSync(inside), true);
	ok("powershell writes inside the session root");

	const deniedTarget = join(outside, "pwsh-denied.txt");
	const denied = await runTool(powerShell, { command: `$ErrorActionPreference='Stop'; Set-Content -LiteralPath '${deniedTarget}' -Value 'nope' -ErrorAction Stop` }, ctx);
	assert.equal(denied.isError, true, "a denied write must be an error result");
	assert.match(denied.content[0].text, /denied/i);
	assert.match(denied.content[0].text, /\[sandbox: workspace-write\]/, "the sandbox fact line must be appended");
	assert.equal(existsSync(deniedTarget), false);
	ok("powershell refuses a write outside the session root (kernel denial + fact line)");

	// --- write: lands through the helper ----------------------------------------------------
	const writeTool = session.getToolDefinition("write");
	assert.ok(writeTool, "write definition");
	const written = join(workspace, "written.txt");
	const writeResult = await runTool(writeTool, { path: written, content: "第一行\r\n第二行\r\n" }, ctx);
	assert.match(writeResult.content[0].text, /Successfully wrote/);
	assert.equal(readFileSync(written, "utf8"), "第一行\r\n第二行\r\n");
	ok("write lands on disk through the restricted helper");

	await assert.rejects(runTool(writeTool, { path: join(outside, "write-denied.txt"), content: "nope" }, ctx), /SANDBOX_DENIED/);
	assert.equal(existsSync(join(outside, "write-denied.txt")), false);
	ok("write refuses a target outside the session root");

	// --- edit: keeps built-in matching, writes through the helper ----------------------------
	const editTool = session.getToolDefinition("edit");
	assert.ok(editTool, "edit definition");
	const editResult = await runTool(editTool, { path: written, edits: [{ oldText: "第二行", newText: "第二行（已改）" }] }, ctx);
	assert.match(editResult.content[0].text, /Successfully replaced 1 block/);
	assert.equal(readFileSync(written, "utf8"), "第一行\r\n第二行（已改）\r\n");
	assert.ok(editResult.details.patch.includes("第二行（已改）"), "edit must keep producing the built-in diff");
	ok("edit keeps built-in matching/diff semantics and writes through the helper");

	await assert.rejects(runTool(editTool, { path: join(outside, "write-denied.txt"), edits: [{ oldText: "a", newText: "b" }] }, ctx), /SANDBOX_DENIED|SANDBOX_READ_ONLY|Could not edit/);
	ok("edit refuses a target outside the session root");

	// Git Bash is available on many CI runners; machines with only WSL must fail closed.
	const bashTool = session.getToolDefinition("bash");
	assert.ok(bashTool, "bash definition");
	try {
		const bashResult = await runTool(bashTool, { command: "echo SANDBOX_BASH_SMOKE" }, ctx);
		assert.notEqual(bashResult.isError, true, JSON.stringify(bashResult.content));
		assert.match(bashResult.content.map((block) => block.text ?? "").join("\n"), /SANDBOX_BASH_SMOKE/);
		ok("bash runs through confinement when a native Windows bash is available");
	} catch (error) {
		assert.match(String(error), /WSL bash 启动器|找不到可用的 bash/);
		ok("bash refuses unavailable or WSL-only execution without fallback");
	}

	// --- sandbox_request: model-facing one-shot approval ------------------------------------
	const sandboxRequest = session.getToolDefinition("sandbox_request");
	assert.ok(sandboxRequest, "sandbox_request definition");
	const guidelines = (sandboxRequest.promptGuidelines ?? []).join("\n");
	assert.match(guidelines, /No, and reason…/);
	assert.match(guidelines, /is a new user instruction for the current task/);
	assert.match(guidelines, /Yes, and reason…/);
	assert.match(guidelines, /first report the facts truthfully/);
	assert.equal(/\p{Script=Han}/u.test(guidelines), false, "prompt guidelines stay English");
	ok("the SDK exposes prompt guidelines for the reason semantics");

	const approval = (command, selected, reason) => ({
		...ctx,
		hasUI: true,
		ui: {
			...ctx.ui,
			async select(title, options) {
				assert.deepEqual(options, ["Yes", "No", "Yes, and reason…", "No, and reason…"]);
				assert.ok(title.includes(command), "the full command must be shown in the dialog");
				assert.ok(title.includes(workspace), "the canonical root must be shown in the dialog");
				return selected;
			},
			async input() { return reason; },
		},
	});

	const requestTarget = join(outside, "request-target.txt");
	const requestCommand = `Set-Content -LiteralPath '${requestTarget}' -Value 'APPROVED' -Encoding ASCII`;

	// The ordinary confined tool denies this sibling directory first.
	const ordinaryDenied = await runTool(
		powerShell,
		{ command: `$ErrorActionPreference='Stop'; Set-Content -LiteralPath '${requestTarget}' -Value 'nope' -ErrorAction Stop` },
		ctx,
	);
	assert.equal(ordinaryDenied.isError, true);
	assert.equal(existsSync(requestTarget), false);

	const noUi = await runTool(sandboxRequest, { command: requestCommand, reason: "根外写入" }, { ...ctx, hasUI: false });
	assert.equal(noUi.isError, true);
	assert.equal(noUi.details.decision, "no-ui");
	assert.equal(existsSync(requestTarget), false);

	const declined = await runTool(sandboxRequest, { command: requestCommand, reason: "根外写入" }, approval(requestCommand, "No"));
	assert.equal(declined.isError, true);
	assert.equal(declined.details.decision, "declined");
	assert.equal(existsSync(requestTarget), false);
	ok("sandbox_request refuses without UI and on No, and the confined denial still holds");

	const declinedReason = await runTool(
		sandboxRequest,
		{ command: requestCommand, reason: "根外写入" },
		approval(requestCommand, "No, and reason…", "别写根外，改为工作区下"),
	);
	assert.equal(declinedReason.isError, true);
	assert.equal(declinedReason.details.decision, "declined");
	assert.equal(declinedReason.details.decisionReason, "别写根外，改为工作区下");
	assert.equal(declinedReason.details.userInstruction, "别写根外，改为工作区下");
	assert.equal(declinedReason.details.continuation, "replan-from-user-direction");
	const declinedText = declinedReason.content.map((block) => block.text ?? "").join("\n");
	assert.match(declinedText, /用户补充指令（请在当前任务中执行）/);
	assert.match(declinedText, /别写根外，改为工作区下/);
	assert.match(declinedText, /不要重新提交被拒绝的这条命令/);
	assert.equal(existsSync(requestTarget), false);
	ok("a rejected request hands the model a new user direction and does not execute");

	const approved = await runTool(sandboxRequest, { command: requestCommand, reason: "根外写入" }, approval(requestCommand, "Yes"));
	assert.equal(approved.isError, undefined, JSON.stringify(approved.content));
	assert.equal(approved.details.decision, "approved");
	assert.equal(approved.details.executed, true);
	assert.equal(readFileSync(requestTarget, "utf8"), "APPROVED\r\n");

	const stillDeniedTarget = join(outside, "still-denied.txt");
	const stillDenied = await runTool(
		powerShell,
		{ command: `$ErrorActionPreference='Stop'; Set-Content -LiteralPath '${stillDeniedTarget}' -Value 'nope' -ErrorAction Stop` },
		ctx,
	);
	assert.equal(stillDenied.isError, true, "the next ordinary call must still be confined");
	assert.equal(existsSync(stillDeniedTarget), false);
	ok("approved sandbox_request executes once; the next ordinary call is still denied (mode unchanged)");

	const opinionTarget = join(outside, "opinion-target.txt");
	const opinionCommand = `Set-Content -LiteralPath '${opinionTarget}' -Value 'ORIGINAL' -Encoding ASCII`;
	const requirement = "完成后解释意图和作用";
	const opinion = await runTool(
		sandboxRequest,
		{ command: opinionCommand, reason: "根外写入" },
		approval(opinionCommand, "Yes, and reason…", requirement),
	);
	assert.equal(opinion.isError, undefined);
	assert.equal(opinion.details.decisionReason, requirement);
	assert.equal(opinion.details.userInstruction, requirement);
	assert.equal(opinion.details.reasonSource, "human-approval-ui");
	assert.equal(opinion.details.continuation, "complete-user-requirement");
	const opinionText = opinion.content.map((block) => block.text ?? "").join("\n");
	assert.match(opinionText, /用户补充指令（请在本次操作完成后执行）/);
	assert.match(opinionText, /完成后解释意图和作用/);
	assert.match(opinionText, /先如实报告本次操作的执行事实/);
	assert.equal(readFileSync(opinionTarget, "utf8"), "ORIGINAL\r\n", "the human text must not rewrite the command");
	ok("an approval requirement reaches the model while the exact original command is executed once");

	const blankTarget = join(outside, "blank-reason.txt");
	const blankCommand = `Set-Content -LiteralPath '${blankTarget}' -Value 'NO' -Encoding ASCII`;
	const blank = await runTool(
		sandboxRequest,
		{ command: blankCommand, reason: "根外写入" },
		approval(blankCommand, "Yes, and reason…", "   "),
	);
	assert.equal(blank.isError, true);
	assert.equal(blank.details.decision, "cancelled");
	assert.equal(existsSync(blankTarget), false);
	ok("a blank approval reason cancels instead of approving");

	console.log(`\nSDK smoke: ${passed.length} checks passed`);
} finally {
	session?.dispose?.();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(base, { recursive: true, force: true });
}
