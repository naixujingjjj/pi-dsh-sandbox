/**
 * CLI-level smoke test — keyless.
 *
 * Starts the real `pi` binary in RPC mode with `-e <this package>`, then asks it for its registered
 * commands and runs one `!`-style bash command. No model request is made.
 *
 * What it proves at the CLI (not just SDK) layer:
 *  - the extension file loads through Pi's own loader (`--extension <dir>`);
 *  - the `/sandbox` command is registered;
 *  - the `user_bash` hook is wired: a command is either confined (Git Bash) or refused with the WSL
 *    explanation, and never silently executed unconfined.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Canonical, not the %TEMP% 8.3 spelling: the CLI reports the canonical root, and src/policy.ts
// resolves it with realpathSync.native.
const work = realpathSync.native(mkdtempSync(join(tmpdir(), "pidsbx-cli-")));
const agentDir = join(work, "isolated-agent");
mkdirSync(agentDir);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["-bash", "+powershell"] }));
const contextPath = join(work, "provider-context.jsonl");
const localProvider = join(pluginRoot, "test", "fixtures", "local-provider.ts");

// The `pi` shim is a .cmd wrapper; run the CLI entry directly so arguments stay unescaped.
const piEntry = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
assert.equal(existsSync(piEntry), true, `expected the Pi CLI entry at ${piEntry}`);

const child = spawn(process.execPath, [piEntry, "--mode", "rpc", "--no-session", "--provider", "sandbox-smoke", "--model", "smoke",
	"-e", localProvider, "-e", pluginRoot], {
	cwd: work,
	stdio: ["pipe", "pipe", "pipe"],
	windowsHide: true,
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SANDBOX_SMOKE_CONTEXT_PATH: contextPath },
});

async function modelContextAfter(count) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (existsSync(contextPath)) {
			const lines = readFileSync(contextPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
			if (lines.length >= count) return JSON.parse(lines[count - 1]);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`local provider did not receive follow-up ${count}`);
}

let stdoutBuffer = "";
let stderrBuffer = "";
const pending = new Map();
const records = [];
const notifications = [];
const confirmAnswers = [];
const confirmed = [];
const selectAnswers = [];
const selections = [];
const approvalAnswers = [];
const approvalReasons = [];
const approvalDialogs = [];
const inputRequests = [];

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	stdoutBuffer += chunk;
	let index = stdoutBuffer.indexOf("\n");
	while (index >= 0) {
		const line = stdoutBuffer.slice(0, index).replace(/\r$/, "");
		stdoutBuffer = stdoutBuffer.slice(index + 1);
		if (line.trim().length > 0) {
			try {
				const record = JSON.parse(line);
				records.push(record);
				if (record.type === "extension_ui_request") {
					if (record.method === "notify") {
						notifications.push(String(record.message ?? ""));
					} else if (record.method === "confirm") {
						const answer = confirmAnswers.shift() ?? false;
						confirmed.push({ title: String(record.title ?? ""), message: String(record.message ?? ""), answer });
						child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, confirmed: answer })}\n`);
					} else if (record.method === "select") {
						if (String(record.title ?? "").startsWith("模型正在请求一次工作区外的操作")) {
							const answer = approvalAnswers.shift();
							approvalDialogs.push({
								title: String(record.title ?? ""),
								options: record.options ?? [],
								answer,
							});
							child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id,
								...(answer === undefined ? { cancelled: true } : { value: answer }) })}\n`);
						} else {
							const mode = selectAnswers.shift();
							selections.push(record);
							const value = record.options.find((option) => option.replace(/^\[当前\] /, "").startsWith(`${mode}（`));
							child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id,
								...(value === undefined ? { cancelled: true } : { value }) })}\n`);
						}
					} else if (record.method === "input") {
						const value = approvalReasons.shift();
						inputRequests.push({ title: String(record.title ?? ""), value });
						child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id,
							...(value === undefined ? { cancelled: true } : { value }) })}\n`);
					} else {
						child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true })}\n`);
					}
				} else if (record.id !== undefined && pending.has(record.id)) {
					pending.get(record.id)(record);
					pending.delete(record.id);
				}
			} catch {
				// Diagnostics are not protocol records; ignore noise.
			}
		}
		index = stdoutBuffer.indexOf("\n");
	}
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	stderrBuffer += chunk;
});

function send(command, timeoutMs = 20_000) {
	return new Promise((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => {
			pending.delete(command.id);
			rejectPromise(new Error(`timeout waiting for ${command.id}\nstdout: ${stdoutBuffer.slice(0, 2000)}\nstderr: ${stderrBuffer.slice(0, 4000)}`));
		}, timeoutMs);
		pending.set(command.id, (record) => {
			clearTimeout(timer);
			resolvePromise(record);
		});
		child.stdin.write(`${JSON.stringify(command)}\n`);
	});
}

const exitPromise = new Promise((resolvePromise) => child.once("exit", (code, signal) => resolvePromise({ code, signal })));

function ok(name, detail = "") {
	console.log(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
}

try {
	const state = await send({ id: "cli-1", type: "get_state" });
	assert.equal(state.success, true, JSON.stringify(state));
	ok("pi --mode rpc starts with the extension", `session ${state.data?.sessionId ?? "?"}`);

	const commands = await send({ id: "cli-2", type: "get_commands" });
	assert.equal(commands.success, true, JSON.stringify(commands));
	const names = (commands.data?.commands ?? []).map((entry) => entry.name);
	assert.ok(names.includes("sandbox"), `extension commands: ${names.join(", ")}`);
	ok("the /sandbox command is registered by the CLI loader");

	const bash = await send({ id: "cli-3", type: "bash", command: "echo pidsbx-cli" });
	const output = JSON.stringify(bash);
	let confined = false;
	if (bash.success === true) {
		assert.match(bash.data?.output ?? "", /pidsbx-cli/, output);
		confined = true;
		ok("a `!` command ran (confined path)", `exitCode=${bash.data?.exitCode}`);
	} else {
		assert.match(output, /WSL|找不到可用的 bash|SANDBOX/, output);
		ok("a `!` command was refused instead of running unconfined (WSL launcher)", String(bash.error ?? "").split("\n")[0]);
	}

	// --- /sandbox command flows through the real CLI ------------------------------------------
	const prompt = async (id, message) => {
		const response = await send({ id, type: "prompt", message });
		assert.equal(response.success, true, JSON.stringify(response));
		return response.data?.disposition;
	};
	const lastNotification = () => notifications[notifications.length - 1] ?? "";

	assert.equal(await prompt("cli-4", "/sandbox status"), "handled");
	assert.match(lastNotification(), /mode: workspace-write/);
	assert.match(lastNotification(), /enforcement: partial/);
	assert.match(lastNotification(), /runner: .*runner\.js/);
	assert.match(lastNotification(), /sandbox_request: 模型可申请一次性/);
	ok("/sandbox status reports mode, canonical root, runner, sandbox_request and the partial boundary");

	assert.equal(await prompt("cli-5", "/sandbox mode danger-full-access"), "handled");
	assert.match(lastNotification(), /无效模式/);
	ok("/sandbox mode rejects an unknown mode");

	// Widening requires a confirm; a declined confirm must leave the mode untouched.
	confirmAnswers.push(false);
	assert.equal(await prompt("cli-6", "/sandbox mode off"), "handled");
	assert.equal(confirmed.length, 1, "the widening must ask for confirmation");
	assert.match(confirmed[0].message, /命令将以 off|off 表示插件不再介入|目标/);
	assert.match(confirmed[0].message, /授权根/);
	assert.match(lastNotification(), /已取消/);
	await prompt("cli-7", "/sandbox status");
	assert.match(lastNotification(), /mode: workspace-write/);
	ok("declining the widening confirmation keeps the mode");

	confirmAnswers.push(true);
	assert.equal(await prompt("cli-8", "/sandbox mode off"), "handled");
	assert.equal(confirmed.length, 2);
	assert.match(lastNotification(), /workspace-write → off/);
	await prompt("cli-9", "/sandbox status");
	assert.match(lastNotification(), /mode: off/);
	ok("confirming the widening switches the session mode to off");

	// Narrowing back needs no confirmation.
	assert.equal(await prompt("cli-10", "/sandbox mode workspace-write"), "handled");
	assert.equal(confirmed.length, 2, "narrowing must not prompt");
	await prompt("cli-11", "/sandbox status");
	assert.match(lastNotification(), /mode: workspace-write/);
	ok("narrowing back needs no confirmation", "confirmed dialogs: " + confirmed.length);

	// One-time exec uses the same four-option approval as the model tool. A harmless output-only
	// command exercises the real approved off path without filesystem effects.
	const execPrompt = "/sandbox exec Write-Output 'pidsbx-once'";
	approvalAnswers.push("No");
	await prompt("cli-exec-decline", execPrompt);
	assert.match(lastNotification(), /未执行/);
	assert.match(lastNotification(), /拒绝/);
	assert.equal(approvalDialogs.length, 1);
	assert.deepEqual(approvalDialogs[0].options, ["Yes", "No", "Yes, and reason…", "No, and reason…"]);
	assert.ok(approvalDialogs[0].title.includes("Write-Output 'pidsbx-once'"));
	assert.ok(approvalDialogs[0].title.includes("cwd："));
	ok("declining one-time exec shows the full command/four options and does not execute");

	approvalAnswers.push("Yes");
	await prompt("cli-exec-accept", execPrompt);
	assert.equal(approvalDialogs.length, 2);
	assert.match(lastNotification(), /exit=0/);
	assert.match(lastNotification(), /pidsbx-once/);
	await prompt("cli-exec-status", "/sandbox status");
	assert.match(lastNotification(), /mode: workspace-write/);
	ok("approved one-time exec runs once and preserves the session mode");

	approvalAnswers.push("Yes, and reason…");
	approvalReasons.push("完成后解释意图和作用");
	await prompt("cli-exec-reason-accept", execPrompt);
	assert.equal(inputRequests.length, 1);
	assert.match(inputRequests[0].title, /^批准/);
	assert.match(inputRequests[0].title, /本次操作完成后的补充要求/);
	assert.doesNotMatch(inputRequests[0].title, /例如：/);
	assert.doesNotMatch(inputRequests[0].title, /仅作为反馈|仅反馈|不会影响当前指令|只是意见|审批附言/);
	assert.match(lastNotification(), /exit=0/);
	assert.match(lastNotification(), /已作为新的用户消息交给代理继续/);
	const approvedContext = await modelContextAfter(1);
	assert.match(JSON.stringify(approvedContext.at(-1).content), /完成后解释意图和作用/);
	assert.match(JSON.stringify(approvedContext.at(-1).content), /exit=0/);
	ok("approving with a reason asks for the post-operation requirement and hands it to the agent");

	approvalAnswers.push("No, and reason…");
	approvalReasons.push("别写根外，改为工作区下");
	await prompt("cli-exec-reason-decline", execPrompt);
	assert.equal(inputRequests.length, 2);
	assert.match(inputRequests[1].title, /^拒绝/);
	assert.match(inputRequests[1].title, /拒绝原因或新的执行方向/);
	assert.doesNotMatch(inputRequests[1].title, /例如：/);
	assert.doesNotMatch(inputRequests[1].title, /仅作为反馈|仅反馈|不会影响当前指令|只是意见|审批附言/);
	assert.match(lastNotification(), /未执行/);
	assert.match(lastNotification(), /已作为新的用户消息交给代理继续/);
	assert.doesNotMatch(lastNotification(), /exit=0/);
	const declinedContext = await modelContextAfter(2);
	assert.match(JSON.stringify(declinedContext.at(-1).content), /别写根外，改为工作区下/);
	assert.match(JSON.stringify(declinedContext.at(-1).content), /没有执行/);
	ok("declining with a reason hands the new direction to the agent and does not execute");

	approvalAnswers.push("Yes, and reason…");
	approvalReasons.push(undefined);
	await prompt("cli-exec-reason-cancel", execPrompt);
	assert.match(lastNotification(), /原因必填|为空/);
	assert.doesNotMatch(lastNotification(), /exit=0/);
	assert.doesNotMatch(lastNotification(), /已作为新的用户消息交给代理继续/, "a cancelled reason must not start a model turn");
	ok("cancelling the required approval reason does not execute and hands nothing to the agent");

	selectAnswers.push("read-only");
	await prompt("cli-picker-open", "/sandbox");
	assert.equal(selections.length, 1);
	assert.equal(selections[0].options.length, 3);
	assert.match(selections[0].options[0], /^\[当前\] workspace-write/);
	await prompt("cli-picker-state", "/sandbox status");
	assert.match(lastNotification(), /mode: read-only/);
	ok("/sandbox opens a three-mode picker and applies the selected narrower mode");
	selectAnswers.push("workspace-write");
	confirmAnswers.push(false);
	await prompt("cli-picker-decline", "/sandbox mode");
	assert.equal(confirmed.length, 3);
	await prompt("cli-picker-decline-state", "/sandbox status");
	assert.match(lastNotification(), /mode: read-only/);
	ok("declining approval after mode selection preserves read-only");
	selectAnswers.push("workspace-write");
	confirmAnswers.push(true);
	await prompt("cli-picker-accept", "/sandbox mode");
	assert.equal(confirmed.length, 4);
	await prompt("cli-picker-accept-state", "/sandbox status");
	assert.match(lastNotification(), /mode: workspace-write/);
	ok("/sandbox mode opens the picker and widens only after approval");
	await prompt("cli-picker-cancel", "/sandbox");
	await prompt("cli-picker-cancel-state", "/sandbox status");
	assert.match(lastNotification(), /mode: workspace-write/);
	assert.equal(confirmed.length, 4);
	ok("cancelling the picker preserves the current mode");

	child.stdin.end();
	const exit = await Promise.race([exitPromise, new Promise((done) => setTimeout(() => done({ code: "timeout" }), 20_000))]);	assert.notEqual(exit.code, "timeout", `pi did not exit after stdin closed\nstderr: ${stderrBuffer.slice(0, 2000)}`);
	assert.equal(exit.code, 0, `pi exited ${exit.code}\nstderr: ${stderrBuffer.slice(0, 2000)}`);
	ok("pi shuts down cleanly", `exit=${exit.code}${confined ? "" : ""}`);
} finally {
	if (!child.killed) child.kill();
	// Windows keeps the exited child's cwd handle for a moment; retry instead of leaving residue.
	let removed = false;
	for (let attempt = 0; attempt < 40 && !removed; attempt += 1) {
		try {
			rmSync(work, { recursive: true, force: true });
			removed = true;
		} catch (error) {
			if (attempt === 39) console.warn(`cleanup warning: ${error.message}`);
			await new Promise((done) => setTimeout(done, 250));
		}
	}
}
