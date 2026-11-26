/** Real Pi SDK + extension loader with an invalid runner; isolated agent settings, no model calls. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Canonical, not the %TEMP% 8.3 spelling: src/policy.ts resolves the root with realpathSync.native.
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "pidsbx-failure-")));
const workspace = join(base, "workspace");
const agentDir = join(base, "agent");
mkdirSync(workspace);
mkdirSync(agentDir);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
let session;
try {
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getAgentDir } =
		await import("@earendil-works/pi-coding-agent");
	assert.equal(getAgentDir(), agentDir);
	const missingRunner = join(base, "missing-runner.js");
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ piDshSandbox: { runnerModule: missingRunner } }));
	const settingsManager = SettingsManager.inMemory({ defaultTools: ["-bash", "+powershell"] });
	const resourceLoader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager,
		additionalExtensionPaths: [resolve(import.meta.dirname, "..")],
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	({ session } = await createAgentSession({ cwd: workspace, agentDir, resourceLoader, settingsManager,
		sessionManager: SessionManager.inMemory() }));
	const ctx = { cwd: workspace, hasUI: false, ui: { notify() {} },
		sessionManager: { getSessionId: () => "failure-smoke" } };
	const target = join(workspace, "must-not-exist.txt");
	for (const [name, params] of [
		["powershell", { command: `Set-Content -LiteralPath '${target.replace(/'/g, "''")}' -Value 'forbidden'` }],
		["write", { path: target, content: "forbidden" }],
		["edit", { path: target, edits: [{ oldText: "a", newText: "b" }] }],
	]) {
		const tool = session.getToolDefinition(name);
		assert.ok(tool);
		await assert.rejects(tool.execute("failure-test", params, undefined, undefined, ctx), /SANDBOX_UNAVAILABLE/);
		assert.equal(existsSync(target), false);
		console.log(`PASS  real Pi ${name} rejects a missing runner without fallback`);
	}
	const requestTool = session.getToolDefinition("sandbox_request");
	assert.ok(requestTool);
	const requestResult = await requestTool.execute(
		"failure-request",
		{ command: `Set-Content -LiteralPath '${target.replace(/'/g, "''")}' -Value 'forbidden'`, reason: "must not run" },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(requestResult.isError, true);
	assert.equal(requestResult.details.decision, "no-ui");
	assert.equal(existsSync(target), false);
	console.log("PASS  real Pi sandbox_request stays registered and refuses without UI even when the runner is missing");
} finally {
	session?.dispose();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(base, { recursive: true, force: true });
}
