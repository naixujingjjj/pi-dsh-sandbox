import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerSandboxRequestTool } from "../../src/tools/sandbox-request.ts";
import { invalidateRuntime, invalidateSessions } from "../../src/state.ts";

/**
 * Real local execution through `createLocalPowerShellOperations`.
 *
 * A DSH-restricted process cannot create the anonymous pipes Pi's local shell backend needs
 * (`spawn EPERM`); that is the documented partial boundary, not a product failure. Detect it and
 * skip with an explicit reason so the rest of the suite still runs inside such a shell. Run the
 * suite from a normal terminal to execute these checks.
 */
function localPipesAvailable() {
	try {
		const result = spawnSync(process.execPath, ["-e", "0"], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 20_000,
			windowsHide: true,
		});
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

const pipeSkip = localPipesAvailable()
	? false
	: "spawn pipes are blocked in this sandboxed agent shell (documented DSH boundary); run from a normal terminal";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = mkdtempSync(join(tmpdir(), "pidsbx-native-"));
const agentDir = join(base, "agent");
const workspace = join(base, "ws");
const outside = join(base, "out");
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(outside, { recursive: true });
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

test.after(() => {
	invalidateRuntime();
	invalidateSessions();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(base, { recursive: true, force: true });
});

function setup(sessionId = "native-test") {
	invalidateRuntime();
	invalidateSessions();
	let definition;
	const audit = [];
	const pi = {
		registerTool(value) { definition = value; },
		registerFlag() {},
		registerCommand() {},
		on() {},
		getFlag() { return undefined; },
		getSettings() { return {}; },
		appendEntry(type, data) { audit.push({ type, data }); },
	};
	registerSandboxRequestTool(pi, pluginRoot);
	const ctx = {
		cwd: workspace,
		hasUI: true,
		mode: "print",
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => workspace,
			getSessionFile: () => undefined,
			getSessionDir: () => base,
			getLeafId: () => null,
			getBranch: () => [],
			getEntries: () => [],
		},
		ui: {
			select: async () => "Yes",
			input: async () => undefined,
			notify() {},
		},
		signal: undefined,
	};
	return { definition, ctx, audit };
}

function run(definition, params, ctx, signal, onUpdate) {
	return definition.execute("native-call", params, signal, onUpdate, ctx);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPid(path, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const text = readFileSync(path, "utf8").trim();
			if (/^\d+$/.test(text)) return Number(text);
		}
		await sleep(50);
	}
	throw new Error(`pid file was not written: ${path}`);
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function deadWithin(pid, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!alive(pid)) return true;
		await sleep(100);
	}
	return !alive(pid);
}

test("approved sandbox_request executes the real exact command outside the root", { skip: pipeSkip }, async () => {
	const target = join(outside, "native-approved.txt");
	const { definition, ctx } = setup();
	const command = `Set-Content -LiteralPath '${target}' -Value 'NATIVE' -Encoding ASCII`;
	const result = await run(definition, { command, reason: "真实写入根外测试目录" }, ctx);
	assert.equal(result.isError, undefined, JSON.stringify(result.content));
	assert.equal(result.details.executed, true);
	assert.equal(result.details.exitCode, 0);
	assert.equal(readFileSync(target, "utf8"), "NATIVE\r\n");
	assert.match(result.content[0].text, /审批通过/);
});

test("real native path preserves Chinese output, streaming, exit code 42 and truncation", { skip: pipeSkip }, async () => {
	const target = join(outside, "native-42.txt");
	const { definition, ctx } = setup("native-stream");
	const updates = [];
	const command =
		`1..3 | ForEach-Object { Write-Output ("行" + $_ + " 中文"); Start-Sleep -Milliseconds 200 }; ` +
		`Set-Content -LiteralPath '${target}' -Value 'DONE' -Encoding ASCII; exit 42`;
	const result = await run(definition, { command, reason: "验证流式与退出码" }, ctx, undefined, (update) => updates.push(update));
	assert.equal(result.isError, true, "a non-zero exit code is an error result");
	assert.equal(result.details.executed, true);
	assert.equal(result.details.exitCode, 42);
	const text = result.content.map((block) => block.text ?? "").join("\n");
	assert.match(text, /行1 中文/);
	assert.match(text, /行3 中文/);
	assert.equal(updates.length > 0, true, "streaming updates must reach onUpdate");

	const truncated = await run(
		definition,
		{ command: "1..3000 | ForEach-Object { \"line $_\" }", reason: "验证截断" },
		ctx,
	);
	assert.equal(truncated.details.executed, true);
	assert.equal(truncated.details.truncation?.truncated, true, "the native truncation details must survive");
	const fullOutputPath = truncated.details.fullOutputPath;
	assert.equal(typeof fullOutputPath, "string");
	assert.equal(existsSync(fullOutputPath), true);
	assert.match(truncated.content.map((block) => block.text ?? "").join("\n"), /Full output/);
});

test("approved timeout kills the real process tree and reports that execution was attempted", { skip: pipeSkip }, async () => {
	const pidFile = join(outside, "native-timeout.pid");
	const { definition, ctx } = setup("native-timeout");
	const command = `Set-Content -LiteralPath '${pidFile}' -Value $PID -Encoding ASCII; Start-Sleep -Seconds 30`;
	const result = await run(definition, { command, reason: "验证超时清理", timeout: 2 }, ctx);
	assert.equal(result.isError, true);
	assert.equal(result.details.executed, true);
	assert.match(result.content.map((block) => block.text ?? "").join("\n"), /timed out|timeout/i);
	assert.match(result.content.map((block) => block.text ?? "").join("\n"), /可能已产生副作用/);
	const pid = await readPid(pidFile);
	assert.equal(await deadWithin(pid), true, `timed-out process ${pid} must not be orphaned`);
});

test("an abort during approved execution kills the real process tree", { skip: pipeSkip }, async () => {
	const pidFile = join(outside, "native-abort.pid");
	const controller = new AbortController();
	const { definition, ctx } = setup("native-abort");
	const command = `Set-Content -LiteralPath '${pidFile}' -Value $PID -Encoding ASCII; Start-Sleep -Seconds 30`;
	const pending = run(definition, { command, reason: "验证取消清理" }, ctx, controller.signal);
	const pid = await readPid(pidFile);
	assert.equal(alive(pid), true);
	controller.abort();
	const result = await pending;
	assert.equal(result.isError, true);
	assert.equal(result.details.executed, true);
	assert.match(result.content.map((block) => block.text ?? "").join("\n"), /aborted/i);
	assert.equal(await deadWithin(pid), true, `aborted process ${pid} must not be orphaned`);
});
