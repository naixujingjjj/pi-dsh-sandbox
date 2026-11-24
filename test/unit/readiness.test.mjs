/**
 * Runner-initialization diagnosis tests.
 *
 * These cover the reported failure shape — `SetNamedSecurityInfoW failed (Win32 5):
 * grantWrite(<workspace root>)` — and the rule that such a workspace-readiness fault is reported as
 * a sandbox initialization failure instead of an invitation to escalate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	currentAccountHint,
	diagnoseRunnerFailure,
	parseRunnerGrantFailure,
	resetReadinessNotifications,
	shouldNotifyReadiness,
} from "../../src/readiness.ts";
import { annotateShellResult, createOutputTail, appendOutputTail } from "../../src/tools/shell-tools.ts";

const ROOT = "C:\\work\\project";
const TEMP_ROOT = "C:\\Users\\me\\AppData\\Local\\pi-dsh-sandbox\\tmp";
const NEW_FORMAT =
	"windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\\work\\project): the Low integrity label needs WRITE_OWNER on this directory (for example Full control granted to the running user, inherited by the directory); a DACL-only edit needs just WRITE_DAC, which the owner has implicitly";
const OLD_FORMAT = "windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\\work\\project)";

function fakeState(overrides = {}) {
	return {
		sessionId: "s1",
		cwd: ROOT,
		root: ROOT,
		mode: "workspace-write",
		modeSource: "default",
		runtime: { tempRoot: TEMP_ROOT, config: {}, configError: null, runner: null, runnerError: null, runnerAttempted: [], dataRoot: "", ipcRoot: "", pluginRoot: "", pluginVersion: "test", tempError: null },
		bash: undefined,
		...overrides,
	};
}

function resultWith(text) {
	return { isError: true, content: [{ type: "text", text }] };
}

function tailOf(text) {
	const tail = createOutputTail();
	appendOutputTail(tail, Buffer.from(text, "utf8"));
	return tail;
}

test("parses the backend's grant failure with its WRITE_OWNER explanation", () => {
	const parsed = parseRunnerGrantFailure(NEW_FORMAT);
	assert.equal(parsed?.api, "SetNamedSecurityInfoW");
	assert.equal(parsed?.win32Code, 5);
	assert.equal(parsed?.operation, "grantWrite");
	assert.equal(parsed?.path, ROOT);
	assert.equal(parsed?.labelNeedsWriteOwner, true);
});

test("parses the older failure line without an explanation", () => {
	const parsed = parseRunnerGrantFailure(OLD_FORMAT);
	assert.equal(parsed?.operation, "grantWrite");
	assert.equal(parsed?.path, ROOT);
	assert.equal(parsed?.labelNeedsWriteOwner, false);
});

test("a non-grant runner failure parses as such (no operation, no path)", () => {
	const parsed = parseRunnerGrantFailure("windows-acl-run: CreateRestrictedToken failed (Win32 87): restricting SIDs: 2");
	assert.equal(parsed?.api, "CreateRestrictedToken");
	assert.equal(parsed?.operation, null);
	assert.equal(parsed?.path, null);
});

test("an unrelated line does not parse", () => {
	assert.equal(parseRunnerGrantFailure("boom"), null);
	assert.equal(parseRunnerGrantFailure(undefined), null);
});

test("a Win32 5 grant failure on the workspace root becomes a workspace-readiness diagnosis", () => {
	const diagnosis = diagnoseRunnerFailure({ signature: NEW_FORMAT, root: ROOT, tempRoot: TEMP_ROOT });
	assert.equal(diagnosis?.target, "workspace");
	assert.equal(diagnosis?.path, ROOT);
	assert.equal(diagnosis?.api, "SetNamedSecurityInfoW");
	const note = diagnosis?.note ?? "";
	assert.match(note, /沙盒初始化失败/);
	assert.match(note, /fail-closed/);
	assert.match(note, /不是命令越界/);
	assert.match(note, /sandbox_request/);
	assert.match(note, /报告给人类/);
	// The backend itself named WRITE_OWNER: only then may the note assert that cause.
	assert.match(note, /后端报告这次失败发生在写入 Low 完整性标签/);
	const lines = (diagnosis?.lines ?? []).join("\n");
	assert.match(lines, /成因（后端错误详情明确说明）/);
	assert.match(lines, /WRITE_OWNER/);
	assert.match(lines, /WRITE_DAC/);
	assert.match(lines, /\/grant "[^"]+:\(WO\)"/);
	assert.match(lines, /Set-Acl/);
	assert.match(lines, /GetSecurityDescriptorSddlForm/);
	assert.doesNotMatch(lines, /icacls \. \/restore/);
	assert.match(lines, /\/reset \/T/);
	assert.match(lines, /Everyone/);
});

test("a Win32 5 without the backend's WRITE_OWNER detail is reported as possible causes, not a verdict", () => {
	const signature = `windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(${ROOT})`;
	const diagnosis = diagnoseRunnerFailure({ signature, root: ROOT, tempRoot: TEMP_ROOT });
	assert.equal(diagnosis?.target, "workspace");
	const note = diagnosis?.note ?? "";
	assert.match(note, /后端没有说明具体成因/);
	assert.match(note, /不能一律断定为缺少 WRITE_OWNER/);
	const lines = (diagnosis?.lines ?? []).join("\n");
	assert.match(lines, /可能原因/);
	assert.match(lines, /不能据此直接断定缺 WRITE_OWNER/);
	assert.doesNotMatch(lines, /成因（后端错误详情明确说明）/);
	assert.match(lines, /\/grant "[^"]+:\(WO\)"/); // still a human option, never automatic
	assert.match(lines, /Set-Acl/);
	assert.doesNotMatch(lines, /icacls \. \/restore/);
});

test("a Win32 5 read failure is not turned into a DACL-write diagnosis", () => {
	const signature = `windows-acl-run: GetNamedSecurityInfoW failed (Win32 5): grantWrite(${ROOT})`;
	const diagnosis = diagnoseRunnerFailure({ signature, root: ROOT, tempRoot: TEMP_ROOT });
	assert.match(diagnosis?.note ?? "", /无法读取工作区根/);
	assert.doesNotMatch((diagnosis?.lines ?? []).join("\n"), /\/grant /);
});

test("a workspace path containing parentheses still maps to the workspace root", () => {
	const root = "C:\\work\\proj (地 区)";
	const signature = `windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(${root}): the Low integrity label needs WRITE_OWNER on this directory`;
	const parsed = parseRunnerGrantFailure(signature, [root]);
	assert.equal(parsed?.path, root);
	assert.equal(parsed?.labelNeedsWriteOwner, true);
	const diagnosis = diagnoseRunnerFailure({ signature, root, tempRoot: TEMP_ROOT });
	assert.equal(diagnosis?.target, "workspace");
});

test("an unknown path with balanced parentheses parses without a configured anchor", () => {
	const parsed = parseRunnerGrantFailure("windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\\a (b))");
	assert.equal(parsed?.path, "C:\\a (b)");
	assert.equal(parsed?.operation, "grantWrite");
});

test("a failure inside the runner's private temp subdirectory is a temp fault", () => {
	const privateTemp = `${TEMP_ROOT}\\call-abc123\\dsh-def456`;
	const signature = `windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(${privateTemp})`;
	const diagnosis = diagnoseRunnerFailure({ signature, root: ROOT, tempRoot: TEMP_ROOT });
	assert.equal(diagnosis?.target, "temp");
	assert.match(diagnosis?.note ?? "", /私有 temp 目录/);
	assert.match((diagnosis?.lines ?? []).join("\n"), /dsh-\*/);
	assert.match((diagnosis?.lines ?? []).join("\n"), /piDshSandbox\.tempRoot/);
});

test("the remediation names the account it was given", () => {
	const diagnosis = diagnoseRunnerFailure({ signature: NEW_FORMAT, root: ROOT, tempRoot: TEMP_ROOT, account: "BOX\\someone" });
	const lines = (diagnosis?.lines ?? []).join("\n");
	assert.match(lines, /icacls \$root \/grant "BOX\\someone:\(WO\)"/);
	assert.match(lines, /\$root = 'C:\\work\\project'/);
});

test("path spelling differences (case, trailing separator) still count as the workspace root", () => {
	const diagnosis = diagnoseRunnerFailure({
		signature: "windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(c:\\WORK\\project\\)",
		root: "C:\\work\\project",
		tempRoot: TEMP_ROOT,
	});
	assert.equal(diagnosis?.target, "workspace");
});

test("a grant failure on the configured temp root is reported as a temp-root fault", () => {
	const signature = `windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(${TEMP_ROOT})`;
	const diagnosis = diagnoseRunnerFailure({ signature, root: ROOT, tempRoot: TEMP_ROOT });
	assert.equal(diagnosis?.target, "temp");
	assert.match(diagnosis?.note ?? "", /temp/);
	assert.match(diagnosis?.note ?? "", /sandbox_request/);
	assert.match((diagnosis?.lines ?? []).join("\n"), /piDshSandbox\.tempRoot/);
});

test("a grant failure on an unrelated directory is left to the generic note", () => {
	const signature = "windows-acl-run: SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\\elsewhere)";
	assert.equal(diagnoseRunnerFailure({ signature, root: ROOT, tempRoot: TEMP_ROOT }), null);
});

test("reading the workspace security descriptor is diagnosed too", () => {
	const signature = `windows-acl-run: GetNamedSecurityInfoW failed (Win32 5): grantWrite(${ROOT})`;
	const diagnosis = diagnoseRunnerFailure({ signature, root: ROOT, tempRoot: TEMP_ROOT });
	assert.equal(diagnosis?.target, "workspace");
	assert.match(diagnosis?.note ?? "", /无法读取工作区根/);
	assert.match(diagnosis?.note ?? "", /sandbox_request/);
});

test("a non-ACL runner failure yields no readiness diagnosis", () => {
	const signature = "windows-acl-run: CreateRestrictedToken failed (Win32 87): restricting SIDs: 2";
	assert.equal(diagnoseRunnerFailure({ signature, root: ROOT, tempRoot: TEMP_ROOT }), null);
});

test("the one-shot notification fires once per session/root/fault", () => {
	resetReadinessNotifications();
	const diagnosis = diagnoseRunnerFailure({ signature: NEW_FORMAT, root: ROOT, tempRoot: TEMP_ROOT });
	assert.ok(diagnosis);
	assert.equal(shouldNotifyReadiness("s1", ROOT, diagnosis), true);
	assert.equal(shouldNotifyReadiness("s1", ROOT, diagnosis), false);
	assert.equal(shouldNotifyReadiness("s2", ROOT, diagnosis), true);
	resetReadinessNotifications();
	assert.equal(shouldNotifyReadiness("s1", ROOT, diagnosis), true);
});

test("currentAccountHint names the running account", () => {
	const hint = currentAccountHint();
	assert.equal(typeof hint, "string");
	assert.ok(hint.length > 0);
});

test("a runner failure on the workspace tells the model not to escalate", () => {
	const annotated = annotateShellResult(resultWith("windows-acl-run: ...\r\n"), fakeState(), tailOf(NEW_FORMAT));
	const text = annotated.content[0].text;
	assert.match(text, /\[sandbox: runner-failure\]/);
	assert.match(text, /沙盒初始化失败/);
	assert.match(text, /fail-closed/);
	assert.match(text, /sandbox_request/);
});

test("a kernel denial keeps the existing escalation wording", () => {
	const denied = "node:fs:1904\r\n  EPERM: operation not permitted, open 'C:\\\\secret\\\\x.txt'\r\n";
	const annotated = annotateShellResult(resultWith("failed\r\n"), fakeState(), tailOf(denied));
	const text = annotated.content[0].text;
	assert.match(text, /\[sandbox: workspace-write\] 写操作被 Windows 内核拒绝/);
	assert.match(text, /sandbox_request/);
});

test("a successful result is returned untouched", () => {
	const original = { isError: false, content: [{ type: "text", text: "ok" }] };
	assert.equal(annotateShellResult(original, fakeState(), tailOf("")), original);
});

test("a non-workspace runner failure keeps the generic fail-closed note", () => {
	const signature = "windows-acl-run: --temp is not an existing directory: C:\\nope";
	const annotated = annotateShellResult(resultWith("failed\r\n"), fakeState(), tailOf(signature));
	const text = annotated.content[0].text;
	assert.match(text, /\[sandbox: runner-failure\] 沙盒运行器自身失败/);
	assert.match(text, /fail-closed/);
	assert.match(text, /sandbox_request/);
});