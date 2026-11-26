/**
 * SDK registration smoke — keyless and execution-free.
 *
 * Loads this extension through Pi's own jiti resource loader, then checks that `sandbox_request`
 * is registered and active (without activating the disabled `bash` tool), and that its no-UI,
 * declined and blank-reason approval paths refuse without spawning a shell. The native execution
 * paths need new anonymous pipes, which a DSH-restricted agent shell blocks (`spawn EPERM`); run
 * `npm run test:pi` from a normal terminal for those.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
// Canonical, not the %TEMP% 8.3 spelling: src/policy.ts resolves the root with realpathSync.native.
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "pidsbx-register-")));
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
			getSessionId: () => "register-smoke",
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

function approvalContext(cwd, selected, reason) {
	const ctx = toolContext(cwd);
	return {
		...ctx,
		hasUI: true,
		ui: {
			...ctx.ui,
			async select(title, options) {
				assert.deepEqual(options, ["Yes", "No", "Yes, and reason…", "No, and reason…"]);
				assert.ok(title.includes("----- BEGIN COMMAND -----"));
				return selected;
			},
			async input() { return reason; },
		},
	};
}

let session;
try {
	const settingsManager = SettingsManager.inMemory({
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
	assert.deepEqual(loaded.errors.map((error) => `${error.path}: ${error.error}`), []);
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
	assert.equal(active.includes("sandbox_request"), true, active.join(", "));
	assert.equal(active.includes("powershell"), true);
	assert.equal(active.includes("write"), true);
	assert.equal(active.includes("edit"), true);
	assert.equal(active.includes("bash"), false, `bash must stay inactive: ${active.join(", ")}`);
	ok("sandbox_request is active and bash stays inactive", active.join(", "));

	const tool = session.getToolDefinition("sandbox_request");
	assert.ok(tool, "sandbox_request definition");
	assert.match(tool.description, /The approval covers only this command/);
	assert.match(tool.promptSnippet ?? "", /Request one unrestricted one-shot execution/);
	assert.equal(
		/\p{Script=Han}/u.test(`${tool.description}\n${tool.promptSnippet}`),
		false,
		"model-facing tool metadata stays English",
	);
	assert.deepEqual(Object.keys(tool.parameters.properties ?? {}).sort(), ["command", "reason", "timeout"]);
	assert.equal(tool.parameters.properties.command.minLength, 1);
	assert.equal(tool.parameters.properties.reason.minLength, 1);
	ok("the SDK exposes the command/reason/timeout schema and approval description");

	const target = join(outside, "register-target.txt");
	const command = `Set-Content -LiteralPath '${target}' -Value 'NO' -Encoding ASCII`;

	const noUi = await tool.execute("register-1", { command, reason: "根外写入" }, undefined, undefined, toolContext(workspace));
	assert.equal(noUi.isError, true);
	assert.equal(noUi.details.decision, "no-ui");
	assert.equal(existsSync(target), false);
	ok("no-UI SDK call is refused without executing");

	const declined = await tool.execute(
		"register-2",
		{ command, reason: "根外写入" },
		undefined,
		undefined,
		approvalContext(workspace, "No", undefined),
	);
	assert.equal(declined.isError, true);
	assert.equal(declined.details.decision, "declined");
	assert.equal(existsSync(target), false);
	ok("declined SDK call returns the four-option decision without executing");

	const blank = await tool.execute(
		"register-3",
		{ command, reason: "根外写入" },
		undefined,
		undefined,
		approvalContext(workspace, "Yes, and reason…", "   "),
	);
	assert.equal(blank.isError, true);
	assert.equal(blank.details.decision, "cancelled");
	assert.equal(existsSync(target), false);
	ok("a blank approval reason cancels without executing");

	// The human text is an instruction for the agent, carried by this tool result (no execution).
	const declineDirection = "别写根外，改为工作区下";
	const prompted = [];
	const declineContext = approvalContext(workspace, "No, and reason…", declineDirection);
	declineContext.ui.input = async (title, placeholder) => {
		prompted.push({ title, placeholder });
		return declineDirection;
	};
	const declineWithReason = await tool.execute(
		"register-4",
		{ command, reason: "根外写入" },
		undefined,
		undefined,
		declineContext,
	);
	assert.equal(declineWithReason.isError, true);
	assert.equal(declineWithReason.details.decision, "declined");
	assert.equal(declineWithReason.details.executed, false);
	assert.equal(declineWithReason.details.decisionReason, declineDirection);
	assert.equal(declineWithReason.details.userInstruction, declineDirection);
	assert.equal(declineWithReason.details.continuation, "replan-from-user-direction");
	assert.equal(declineWithReason.details.reasonSource, "human-approval-ui");
	const declineText = declineWithReason.content.map((block) => block.text ?? "").join("\n");
	assert.match(declineText, /用户补充指令（请在当前任务中执行）/);
	assert.match(declineText, /别写根外，改为工作区下/);
	assert.match(declineText, /不要重新提交被拒绝的这条命令/);
	assert.match(declineText, /sandbox_request/);
	assert.doesNotMatch(declineText, /仅反馈|仅作为反馈|不会影响当前指令|只是意见/);
	assert.equal(prompted.length, 1);
	assert.match(prompted[0].title, /拒绝原因或新的执行方向/);
	assert.equal(prompted[0].placeholder, "");
	assert.equal(existsSync(target), false);
	ok("No+reason returns a new user direction in the tool result and never executes");

	const guidelines = (tool.promptGuidelines ?? []).join("\n");
	assert.match(guidelines, /No, and reason…/);
	assert.match(guidelines, /is a new user instruction for the current task/);
	assert.match(guidelines, /Yes, and reason…/);
	assert.match(guidelines, /first report the facts truthfully/);
	assert.equal(/\p{Script=Han}/u.test(guidelines), false, "prompt guidelines stay English");
	ok("the SDK exposes prompt guidelines for both reason options");

	const audit = session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "pi-dsh-sandbox/approval");
	assert.equal(audit.length, 4, `expected four audit entries, got ${audit.length}`);
	assert.deepEqual(audit.map((entry) => entry.data.decision), ["no-ui", "declined", "cancelled", "declined"]);
	assert.equal(audit.every((entry) => /^[a-f0-9]{64}$/.test(entry.data.commandHash)), true);
	assert.equal(audit[3].data.reasonSource, "human-approval-ui");
	assert.equal(audit[3].data.decisionReason, declineDirection);
	ok("approval decisions are recorded in the real session as hash-based custom entries");

	console.log(`\nSDK registration smoke: ${passed.length} checks passed`);
} finally {
	session?.dispose?.();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(base, { recursive: true, force: true });
}
