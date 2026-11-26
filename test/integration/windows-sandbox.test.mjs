/**
 * Real Windows integration tests.
 *
 * Every case runs the actual `@deepseek-ai/dsh-sandbox-windows-acl` runner (restricted token +
 * Low integrity label) against a throw-away workspace created for this file only. Nothing here
 * touches the session workspace or any user directory: the workspace root, the runner temp root
 * and the "outside" target all live under one `%TEMP%\pidsbx-it-*` directory that is deleted at the
 * end, which also removes the standing ACEs and the Low label with the tree.
 *
 * These tests are Windows-only by construction (the runner requires Win32).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../../src/classify.ts";
import { SandboxError } from "../../src/errors.ts";
import { disposeMutationChannel } from "../../src/ipc.ts";
import { kernelWriteOperations, runMutation } from "../../src/mutation.ts";
import { defaultGlobalRoots, locateRunner, runRunner } from "../../src/runner.ts";
import { composePowerShellCommand } from "../../src/shell-command.ts";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const helperPath = join(pluginRoot, "src", "kernel-helper.mjs");
const located = locateRunner({ runnerModule: null, dshRoot: null, pluginRoot, globalRoots: defaultGlobalRoots() });
const location = located.location;

const skip = process.platform !== "win32" ? "Windows only" : location ? false : "sandbox runner not installed";

const base = mkdtempSync(join(tmpdir(), "pidsbx-it-测试 "));
const workspace = join(base, "工作 区");
const temp = join(base, "temp 根");
const outside = join(base, "外部");
mkdirSync(workspace, { recursive: true });
mkdirSync(temp, { recursive: true });
mkdirSync(outside, { recursive: true });
const ipcRoot = join(base, "ipc");

test.after(() => {
	rmSync(base, { recursive: true, force: true });
});

function invoke(mode, argv) {
	return { location, root: workspace, temp, mode, argv };
}

function nodeEval(code) {
	return [process.execPath, "-e", code];
}

async function shellProbe(mode, code, options = {}) {
	const result = await runRunner(invoke(mode, nodeEval(code)), { cwd: workspace, collectStdout: true, ...options });
	return { ...result, classification: classify({ exitCode: result.exitCode, stderr: result.stderrTail, output: result.stdout + result.stderrTail }) };
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(predicate, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return true;
		if (Date.now() > deadline) return false;
		await new Promise((done) => setTimeout(done, 100));
	}
}

test("the runner is located from the package's vendored backend", { skip }, () => {
	assert.equal(location.source, "vendor");
	assert.match(location.modulePath, /vendor[\\/]dsh-sandbox-windows-acl[\\/]lib[\\/]runner\.js$/);
	assert.match(location.version ?? "", /^0\.2\.2-rc\.5\+pi-dsh\.\d+$/);
	assert.equal(existsSync(helperPath), true);
});

test("read-only denies a write inside the workspace", { skip }, async () => {
	const target = join(workspace, "readonly-inside.txt");
	const result = await shellProbe("read-only", `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'x')`);
	assert.notEqual(result.exitCode, 0);
	assert.equal(existsSync(target), false);
	assert.equal(result.classification.kind, "denied");
});

test("workspace-write allows a write inside, with Chinese path and content", { skip }, async () => {
	const target = join(workspace, "中文 目录", "文件 名.txt");
	const content = "第一行\r\n第二行 \"quoted\"\r\n";
	const result = await shellProbe(
		"workspace-write",
		`const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(dirname(target))},{recursive:true});fs.writeFileSync(${JSON.stringify(target)},${JSON.stringify(content)})`,
	);
	assert.equal(result.exitCode, 0, result.stderrTail);
	assert.equal(readFileSync(target, "utf8"), content);
});

test("workspace-write denies a write outside the workspace", { skip }, async () => {
	const target = join(outside, "outside.txt");
	const result = await shellProbe("workspace-write", `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'nope')`);
	assert.notEqual(result.exitCode, 0);
	assert.equal(existsSync(target), false);
	assert.equal(result.classification.kind, "denied");
	assert.equal(result.classification.signature, "eperm");
});

test("workspace-write denies a delete outside the workspace", { skip }, async () => {
	const victim = join(outside, "victim.txt");
	writeFileSync(victim, "keep");
	const result = await shellProbe("workspace-write", `require('node:fs').rmSync(${JSON.stringify(victim)})`);
	assert.notEqual(result.exitCode, 0);
	assert.equal(existsSync(victim), true);
	assert.equal(result.classification.kind, "denied");
});

test("a junction inside the workspace cannot escape to the outside", { skip }, async () => {
	const junction = join(workspace, "jump");
	rmSync(junction, { recursive: true, force: true });
	// A real NTFS junction (no admin rights needed) pointing at a directory outside the grant.
	symlinkSync(outside, junction, "junction");
	const target = join(junction, "escape.txt");
	const result = await shellProbe("workspace-write", `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'nope')`);
	assert.notEqual(result.exitCode, 0);
	assert.equal(existsSync(join(outside, "escape.txt")), false);
	assert.equal(result.classification.kind, "denied");
	const victim = join(outside, "junction-victim.txt");
	writeFileSync(victim, "keep");
	const deletion = await shellProbe("workspace-write", `require('node:fs').unlinkSync(${JSON.stringify(join(junction, "junction-victim.txt"))})`);
	assert.notEqual(deletion.exitCode, 0);
	assert.equal(readFileSync(victim, "utf8"), "keep");
});

test("exit codes are mirrored exactly", { skip }, async () => {
	const result = await shellProbe("workspace-write", "process.exit(42)");
	assert.equal(result.exitCode, 42);
	assert.equal(result.classification.kind, "command-failed");
});

test("PowerShell runs confined: UTF-8 output, inner write allowed, outer write denied", { skip }, async () => {
	const { getPowerShellConfig } = await import("@earendil-works/pi-coding-agent");
	const shell = getPowerShellConfig();
	const inside = join(workspace, "pwsh-inside.txt");
	const outer = join(outside, "pwsh-outside.txt");
	rmSync(outer, { force: true });
	const quote = (path) => path.replace(/'/g, "''");
	const command = [
		`Set-Content -LiteralPath '${quote(inside)}' -Value '中文 OK' -Encoding UTF8`,
		// A non-terminating cmdlet error does not hit catch; make the denial terminating.
		"$ErrorActionPreference = 'Stop'",
		`try { Set-Content -LiteralPath '${quote(outer)}' -Value 'nope' -ErrorAction Stop; Write-Output 'WRITE-SUCCEEDED' } catch { Write-Output ('DENIED: ' + $_.Exception.Message) }`,
		`Get-Content -LiteralPath '${quote(inside)}'`,
	].join("; ");
	const argv = [shell.shell, ...shell.args, composePowerShellCommand(command, shell.shell)];
	const result = await runRunner(invoke("workspace-write", argv), { cwd: workspace, collectStdout: true });
	// The exit code reflects the LAST statement (PowerShell -Command semantics), which succeeded.
	assert.equal(result.exitCode, 0, result.stderrTail);
	assert.match(result.stdout, /中文 OK/);
	assert.match(result.stdout, /DENIED: Access to the path/);
	assert.equal(result.stdout.includes("WRITE-SUCCEEDED"), false);
	assert.equal(existsSync(outer), false);
	// The denial still shows up in the merged stream, so the tool layer can flag it.
	assert.equal(classify({ exitCode: 0, output: result.stdout }).kind, "denied");
});

test("a timeout rejects with the built-in contract and leaves no orphan", { skip }, async () => {
	const beforeTemp = readdirSync(temp).sort();
	const pidFile = join(workspace, "timeout.pid");
	rmSync(pidFile, { force: true });
	const code = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(() => {}, 1000)`;
	await assert.rejects(
		runRunner(invoke("workspace-write", nodeEval(code)), { cwd: workspace, timeoutSeconds: 3 }),
		(error) => {
			assert.match(error.message, /^timeout:3$/);
			return true;
		},
	);
	assert.equal(await waitFor(() => existsSync(pidFile)), true, "probe never started");
	const pid = Number(readFileSync(pidFile, "utf8"));
	assert.equal(Number.isInteger(pid) && pid > 0, true);
	assert.equal(await waitFor(() => !isAlive(pid)), true, `orphan process ${pid} survived the timeout`);
	assert.deepEqual(readdirSync(temp).sort(), beforeTemp, "timeout left a private temp directory");
});

test("aborting rejects with the built-in contract and leaves no orphan", { skip }, async () => {
	const beforeTemp = readdirSync(temp).sort();
	const pidFile = join(workspace, "abort.pid");
	rmSync(pidFile, { force: true });
	const code = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(() => {}, 1000)`;
	const controller = new AbortController();
	const running = runRunner(invoke("workspace-write", nodeEval(code)), { cwd: workspace, signal: controller.signal });
	assert.equal(await waitFor(() => existsSync(pidFile)), true, "probe never started");
	controller.abort();
	await assert.rejects(running, (error) => {
		assert.equal(error.message, "aborted");
		return true;
	});
	const pid = Number(readFileSync(pidFile, "utf8"));
	assert.equal(await waitFor(() => !isAlive(pid)), true, `orphan process ${pid} survived the abort`);
	assert.deepEqual(readdirSync(temp).sort(), beforeTemp, "abort left a private temp directory");
});

test("two live grants cannot write each other's workspace or private temp", { skip }, async () => {
	const otherRoot = join(base, "other-granted-workspace");
	mkdirSync(otherRoot);
	const roots = [workspace, otherRoot];
	const controllers = roots.map(() => new AbortController());
	const infoPaths = roots.map((root) => join(root, "live-temp.json"));
	const running = roots.map((root, index) => {
		const code = `const fs=require('node:fs');fs.writeFileSync(require('node:path').join(process.env.TEMP,'victim.txt'),'keep');fs.writeFileSync(${JSON.stringify(infoPaths[index])},JSON.stringify({temp:process.env.TEMP}));setInterval(()=>{},1000)`;
		return runRunner({ location, root, temp, mode: "workspace-write", argv: nodeEval(code) },
			{ cwd: root, signal: controllers[index].signal }).catch((error) => error);
	});
	try {
		assert.equal(await waitFor(() => infoPaths.every((path) => existsSync(path))), true);
		const info = infoPaths.map((path) => JSON.parse(readFileSync(path, "utf8")));
		for (let index = 0; index < roots.length; index++) {
			const other = 1 - index;
			for (const target of [infoPaths[other], join(info[other].temp, "victim.txt")]) {
				const original = readFileSync(target, "utf8");
				for (const operation of ["writeFileSync", "unlinkSync"]) {
					const result = await runRunner({ location, root: roots[index], temp, mode: "workspace-write",
						argv: nodeEval(`require('node:fs').${operation}(${JSON.stringify(target)}${operation === "writeFileSync" ? ",'changed'" : ""})`) },
						{ cwd: roots[index], collectStdout: true });
					assert.notEqual(result.exitCode, 0, `${operation} crossed a live grant`);
					assert.equal(readFileSync(target, "utf8"), original);
				}
			}
		}
	} finally {
		controllers.forEach((controller) => controller.abort());
		await Promise.all(running);
	}
});

test("a hard-link alias outside the root retains the writable file object's authority (known partial boundary)", { skip }, async () => {
	const inside = join(workspace, "hardlink-source.txt");
	const alias = join(outside, "hardlink-alias.txt");
	const created = await shellProbe("workspace-write", `require('node:fs').writeFileSync(${JSON.stringify(inside)},'original')`);
	assert.equal(created.exitCode, 0, created.stderrTail);
	linkSync(inside, alias);
	const result = await shellProbe("workspace-write", `require('node:fs').writeFileSync(${JSON.stringify(alias)},'changed')`);
	assert.equal(result.exitCode, 0, result.stderrTail);
	assert.equal(readFileSync(inside, "utf8"), "changed");
});

test("an already aborted signal never starts a process", { skip }, async () => {
	const pidFile = join(workspace, "preabort.pid");
	rmSync(pidFile, { force: true });
	const controller = new AbortController();
	controller.abort();
	const code = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`;
	await assert.rejects(runRunner(invoke("workspace-write", nodeEval(code)), { cwd: workspace, signal: controller.signal }), (error) => {
		assert.equal(error.message, "aborted");
		return true;
	});
	assert.equal(existsSync(pidFile), false);
});

test("concurrent restricted mutations stay isolated and clean up their channels", { skip }, async () => {
	const context = { runner: location, root: workspace, temp, ipcRoot, mode: "workspace-write", helperPath };
	const names = ["并发-1.txt", "并发-2.txt", "并发-3.txt", "并发-4.txt"];
	await Promise.all(names.map((name) => runMutation(context, { op: "write", path: join(workspace, name), content: name })));
	for (const name of names) {
		assert.equal(readFileSync(join(workspace, name), "utf8"), name);
	}
	assert.deepEqual(readdirSync(ipcRoot), []);
});

test("the mutation path writes through the runner and preserves CRLF and Chinese text", { skip }, async () => {
	const context = { runner: location, root: workspace, temp, ipcRoot, mode: "workspace-write", helperPath };
	const target = join(workspace, "mutation 中文.txt");
	const content = "a\r\nb\r\n中文 \"quoted\"\r\n";
	await runMutation(context, { op: "write", path: target, content });
	assert.equal(readFileSync(target, "utf8"), content);
	assert.deepEqual(readdirSync(ipcRoot), []);
});

test("the mutation path creates missing parent directories inside the root", { skip }, async () => {
	const context = { runner: location, root: workspace, temp, ipcRoot, mode: "workspace-write", helperPath };
	const operations = kernelWriteOperations(context);
	const nested = join(workspace, "deep", "nested", "dir");
	await operations.mkdir(nested);
	assert.equal(existsSync(nested), true);
});

test("a mutation outside the root is denied by the kernel", { skip }, async () => {
	const context = { runner: location, root: workspace, temp, ipcRoot, mode: "workspace-write", helperPath };
	const target = join(outside, "mutation-outside.txt");
	await assert.rejects(runMutation(context, { op: "write", path: target, content: "nope" }), (error) => {
		assert.equal(error instanceof SandboxError, true);
		assert.equal(error.code, "SANDBOX_DENIED");
		return true;
	});
	assert.equal(existsSync(target), false);
	assert.deepEqual(readdirSync(ipcRoot), []);
});

test("a read-only mutation is denied by the kernel", { skip }, async () => {
	const context = { runner: location, root: workspace, temp, ipcRoot, mode: "read-only", helperPath };
	const target = join(workspace, "readonly-mutation.txt");
	await assert.rejects(runMutation(context, { op: "write", path: target, content: "nope" }), (error) => {
		assert.equal(error instanceof SandboxError, true);
		assert.equal(error.code, "SANDBOX_DENIED");
		return true;
	});
	assert.equal(existsSync(target), false);
});

test("a missing runner fails closed instead of writing anything", { skip }, async () => {
	const context = {
		runner: { ...location, modulePath: join(outside, "missing-runner.js") },
		root: workspace,
		temp,
		ipcRoot,
		mode: "workspace-write",
		helperPath,
	};
	const target = join(workspace, "must-not-exist.txt");
	await assert.rejects(runMutation(context, { op: "write", path: target, content: "nope" }), (error) => {
		assert.equal(error instanceof SandboxError, true);
		assert.equal(error.code, "SANDBOX_RUNNER_FAILURE");
		return true;
	});
	assert.equal(existsSync(target), false);
});

test("a temp root inside the workspace is a runner failure, not a silent success", { skip }, async () => {
	const badTemp = join(workspace, "temp-inside");
	mkdirSync(badTemp, { recursive: true });
	const result = await runRunner(
		{ location, root: workspace, temp: badTemp, mode: "workspace-write", argv: nodeEval("0") },
		{ cwd: workspace, collectStdout: true },
	);
	assert.equal(result.exitCode, 127);
	assert.match(result.stderrTail, /windows-acl-run: Windows ACL temp root must be outside the workspace/);
	assert.equal(classify({ exitCode: result.exitCode, stderr: result.stderrTail }).kind, "runner-failure");
});

test("a missing temp root is a runner failure", { skip }, async () => {
	const result = await runRunner(
		{ location, root: workspace, temp: join(outside, "no-such-temp"), mode: "read-only", argv: nodeEval("0") },
		{ cwd: workspace, collectStdout: true },
	);
	assert.equal(result.exitCode, 127);
	assert.match(result.stderrTail, /windows-acl-run: --temp is not an existing directory/);
});

test("channels are removed even when a mutation fails", { skip }, async () => {
	const context = { runner: location, root: workspace, temp, ipcRoot, mode: "workspace-write", helperPath };
	const channel = { dir: join(ipcRoot, "manual-probe") };
	mkdirSync(channel.dir, { recursive: true });
	disposeMutationChannel(channel);
	assert.equal(existsSync(channel.dir), false);
});

/** Run `icacls` and return its combined output plus the exit code. */
function icacls(path, ...args) {
	const result = spawnSync("icacls", [path, ...args], { encoding: "utf8", windowsHide: true });
	return { status: result.status, text: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Escape one account name for use inside a RegExp. */
function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regression for the reported fault: a workspace root whose parent grants the running account full
 * control WITHOUT an inheritance flag, and whose root therefore carries only the inherited
 * group/capability ACEs. The backend's grant must complete there without any ACL change and still
 * keep the kernel boundary (inside writes allowed, outside writes and deletes denied).
 *
 * This layout needs DACL edits to build, so it runs in a normal terminal (see CONTRIBUTING): the
 * plugin's own confined shell cannot write security descriptors. Every directory used here lives
 * under this file's throw-away `%TEMP%` tree.
 */
test("a workspace root that only inherits the Low label is granted without an ACL change", { skip }, async (t) => {
	const parent = join(base, "acl 父目录");
	const child = join(parent, "acl 子目录");
	const childTemp = join(base, "acl temp 根");
	mkdirSync(parent, { recursive: true });
	mkdirSync(childTemp, { recursive: true });
	const account = `${process.env.USERDOMAIN || "."}\\${process.env.USERNAME}`;
	const accountPattern = new RegExp(escapeRegex(account), "i");

	// The layout has to be CONSTRUCTED, not inherited: every directory under %TEMP% inherits an
	// account full-control ACE from the user profile, which would grant WRITE_OWNER and mask the very
	// condition under test. Drop the inherited ACEs, then give the parent exactly what the real parent
	// directory carries: the account's full control on that folder only (no OI/CI), the ambient
	// Authenticated-Users Modify the real workspace root inherits, the world ambient-delete deny, and
	// an inheritable Low label.
	const strip = icacls(parent, "/inheritance:r");
	assert.equal(strip.status, 0, strip.text);
	const grant = icacls(parent, "/grant:r", `${account}:(F)`);
	assert.equal(grant.status, 0, grant.text);
	const ambient = icacls(parent, "/grant", "*S-1-5-11:(OI)(CI)(M)");
	assert.equal(ambient.status, 0, ambient.text);
	const deny = icacls(parent, "/deny", "*S-1-1-0:(CI)(DC)");
	assert.equal(deny.status, 0, deny.text);
	const label = icacls(parent, "/setintegritylevel", "(OI)(CI)L");
	assert.equal(label.status, 0, label.text);
	// The stripped parent must carry no inherited ACE any more, otherwise the layout under test cannot
	// be built at all. GitHub's Windows runner keeps an owner/SYSTEM/Administrators full-control
	// bridge on the local %TEMP% that survives /inheritance:r and then hands the child the very ACE
	// this test forbids. That is a host ACL difference, not a backend defect: skip with the evidence
	// instead of reporting a failure the plugin has no say in.
	const parentAcl = icacls(parent);
	assert.equal(parentAcl.status, 0, parentAcl.text);
	// The temporary deny must be removed even when an assertion below throws, or the throw-away
	// tree cannot be deleted by the file-level `after` hook.
	try {
	mkdirSync(child, { recursive: true });

	const before = icacls(child);
	assert.equal(before.status, 0, before.text);
	// The precondition under test: the child did NOT inherit the account's full control. A host whose
	// %TEMP% carries an explicit CREATOR OWNER ACE (GitHub's Windows runner does) instantiates it as
	// the creating account, so the child gets full control even though the parent was stripped. The
	// precondition cannot be built there, so skip with both ACLs as evidence instead of failing.
	if (accountPattern.test(before.text)) {
		t.skip(
			`this host grants ${account} full control to a new child of the stripped parent:\n--- child ---\n${before.text}\n--- parent ---\n${parentAcl.text}`,
		);
		return;
	}
	// ... but it did inherit a Low no-write-up label. `(NW)` and the `OI`/`CI` tokens are the ACE
	// rights letters icacls prints verbatim in every locale, so this line identifies a mandatory label
	// ACE that propagates - not a capability SID and not a localized label name.
	assert.match(before.text, /\(OI\)\(CI\)\(NW\)/i, `child should inherit a no-write-up label ACE:\n${before.text}`);
	const parentLabels = icacls(parent);
	assert.match(parentLabels.text, /\(OI\)\(CI\)\(NW\)/i, `parent should carry the label ACE:\n${parentLabels.text}`);

	const probe = await runRunner(
		{ location, root: child, temp: childTemp, mode: "workspace-write", argv: nodeEval("process.stdout.write('granted')") },
		{ cwd: child, collectStdout: true },
	);
	assert.equal(probe.exitCode, 0, probe.stderrTail);
	assert.equal(probe.stdout, "granted");

	const after = icacls(child);
	assert.equal(after.status, 0, after.text);
	// A capability ACE for THIS workspace SID was added ...
	assert.match(after.text, /S-1-4-\d+-\d+/);
	// ... the inherited no-write-up label ACE is unchanged ...
	assert.match(after.text, /\(OI\)\(CI\)\(NW\)/i);
	// ... and no WRITE_OWNER/full-control ACE for the account was needed to get there.
	assert.equal(accountPattern.test(after.text), false, `the grant must not have to add an account ACE:\n${after.text}`);

	// The kernel boundary still holds with this root.
	const inside = join(child, "inside.txt");
	const insideWrite = await runRunner(
		{ location, root: child, temp: childTemp, mode: "workspace-write", argv: nodeEval(`require('node:fs').writeFileSync(${JSON.stringify(inside)}, 'ok')`) },
		{ cwd: child },
	);
	// The confined child runs at Low integrity: this write succeeding also proves the root's
	// EFFECTIVE mandatory label is Low (a Medium-or-higher label with no-write-up would deny it).
	assert.equal(insideWrite.exitCode, 0, insideWrite.stderrTail);
	assert.equal(readFileSync(inside, "utf8"), "ok");

	const outsideTarget = join(outside, "acl-outside.txt");
	const outsideWrite = await runRunner(
		{ location, root: child, temp: childTemp, mode: "workspace-write", argv: nodeEval(`require('node:fs').writeFileSync(${JSON.stringify(outsideTarget)}, 'nope')`) },
		{ cwd: child },
	);
	assert.notEqual(outsideWrite.exitCode, 0);
	assert.equal(existsSync(outsideTarget), false);
	assert.equal(classify({ exitCode: outsideWrite.exitCode, stderr: outsideWrite.stderrTail }).kind, "denied");

	const victim = join(outside, "acl-victim.txt");
	writeFileSync(victim, "keep");
	const outsideDelete = await runRunner(
		{ location, root: child, temp: childTemp, mode: "workspace-write", argv: nodeEval(`require('node:fs').rmSync(${JSON.stringify(victim)})`) },
		{ cwd: child },
	);
	assert.notEqual(outsideDelete.exitCode, 0);
	assert.equal(existsSync(victim), true);
	assert.equal(classify({ exitCode: outsideDelete.exitCode, stderr: outsideDelete.stderrTail }).kind, "denied");
	} finally {
		const removed = icacls(parent, "/remove:d", "*S-1-1-0", "/T", "/C", "/Q");
		if (removed.status !== 0) process.stderr.write(`cleanup: removing the temporary deny failed:\n${removed.text}\n`);
	}
});
