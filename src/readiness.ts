/**
 * Runner-initialization diagnosis: turn the backend's `windows-acl-run:` failure line into a
 * statement of what is wrong with the WORKSPACE, not with the command.
 *
 * The distinction is the whole point. A runner that cannot materialize its ACEs or its Low
 * integrity label never spawned anything, so the command did not run and no kernel denial
 * happened. Such a failure is not "the command needs more permissions": escalating it through
 * `sandbox_request` cannot repair a directory ACL, and repeating the ordinary tool only repeats
 * the same initialization failure. This module produces the actionable text for that case.
 *
 * Epistemic rule: `SetNamedSecurityInfoW` returning Win32 5 is NOT proof that the directory lacks
 * WRITE_OWNER. Only the backend's own `WRITE_OWNER` detail establishes the label-write cause; every
 * other Win32 5 is reported with the possible causes (DACL rights, a protected descriptor, an
 * owner/group/SACL edit, a policy) and a read-only check, never with a confident single diagnosis.
 *
 * Every message is advisory. The kernel remains the boundary, and nothing here changes a mode, an
 * ACL, or an approval; the plugin never edits an ACL automatically.
 */

/** One parsed backend failure about an ACL edit the runner performs on a directory. */
export interface RunnerGrantFailure {
	/** The Win32 call that failed, e.g. `SetNamedSecurityInfoW`. */
	api: string;
	/** The Win32 error code, when the backend reported one. */
	win32Code: number | null;
	/** The backend operation that failed (the runner prints `grantWrite(<path>)`). */
	operation: "grantWrite" | "revokeWrite" | null;
	/** The directory the operation targeted, when the backend named it. */
	path: string | null;
	/** True when the backend itself explained that the label needs WRITE_OWNER. */
	labelNeedsWriteOwner: boolean;
	/** The raw `windows-acl-run:` detail after the signature. */
	detail: string;
}

/** Which directory a failure concerns. */
export type ReadinessTarget = "workspace" | "temp" | "other";

/** A workspace/temp readiness verdict with its remediation text. */
export interface ReadinessDiagnosis {
	target: ReadinessTarget;
	/** Directory whose security descriptor could not be edited. */
	path: string;
	api: string;
	win32Code: number | null;
	/** One compact paragraph for a tool result. */
	note: string;
	/** Full diagnosis and remediation steps, for doctor/status output. */
	lines: string[];
}

const RUNNER_SIGNATURE = "windows-acl-run:";
const ERROR_ACCESS_DENIED = 5;

function normalizePath(value: string): string {
	return value.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "").toLowerCase();
}

function samePath(left: string, right: string): boolean {
	return normalizePath(left) === normalizePath(right);
}

/** True when `child` is `parent` itself or a descendant path. */
function sameOrInside(child: string, parent: string): boolean {
	const normalizedChild = normalizePath(child).replace(/\//g, "\\");
	const normalizedParent = normalizePath(parent).replace(/\//g, "\\");
	if (normalizedChild === normalizedParent) return true;
	return normalizedChild.startsWith(`${normalizedParent}\\`);
}

/**
 * Split `<operation>(<path>)<rest>` without assuming a path has no parentheses. The configured
 * roots are tried first as an exact anchor (Windows paths may contain `)`), and a balanced-parens
 * scan is the fallback for any other directory the backend names.
 * @param detail - the text after `windows-acl-run: <api> failed (Win32 <code>): `.
 * @param knownPaths - configured roots/temp roots to anchor on first.
 * @returns the operation, its path, and the trailing explanation; or null.
 */
function parseOperation(
	detail: string,
	knownPaths: readonly string[],
): { operation: "grantWrite" | "revokeWrite"; path: string; explanation: string } | null {
	const head = /^(grantWrite|revokeWrite)\s*\(/.exec(detail);
	if (!head) return null;
	const operation = head[1] as "grantWrite" | "revokeWrite";
	const after = detail.slice(head[0].length);
	const acceptTail = (tail: string): string | null => {
		if (tail.length === 0) return "";
		if (!tail.startsWith(":")) return null;
		return tail.slice(1).trim();
	};

	for (const known of knownPaths) {
		const candidate = known.replace(/[\\/]+$/, "");
		if (candidate.length === 0) continue;
		if (after.length < candidate.length + 1) continue;
		const printed = after.slice(0, candidate.length);
		if (printed.toLowerCase() !== candidate.toLowerCase()) continue;
		if (after[candidate.length] !== ")") continue;
		const explanation = acceptTail(after.slice(candidate.length + 1));
		if (explanation !== null) return { operation, path: candidate, explanation };
	}

	let depth = 0;
	for (let index = 0; index < after.length; index++) {
		const character = after[index];
		if (character === "(") {
			depth++;
		} else if (character === ")") {
			if (depth > 0) {
				depth--;
				continue;
			}
			const explanation = acceptTail(after.slice(index + 1));
			if (explanation === null) return null;
			const path = after.slice(0, index).trim();
			return path.length === 0 ? null : { operation, path, explanation };
		}
	}
	return null;
}

/**
 * Parse the backend's failure line. The runner prints
 * `windows-acl-run: <api> failed (Win32 <code>): <operation>(<path>)[: <explanation>]`, and older
 * builds omit the trailing explanation.
 * @param signature - the `windows-acl-run:` line from stderr, if any.
 * @param knownPaths - session root/temp root, used to anchor paths that contain parentheses.
 * @returns the parsed failure, or null when the line has another shape.
 */
export function parseRunnerGrantFailure(signature: string | undefined, knownPaths: readonly string[] = []): RunnerGrantFailure | null {
	if (!signature) return null;
	const text = signature.trim();
	const body = text.toLowerCase().startsWith(RUNNER_SIGNATURE)
		? text.slice(RUNNER_SIGNATURE.length).trim()
		: text;
	const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+failed\s+\(Win32\s+(\d+)\)\s*(?::\s*([\s\S]*))?$/.exec(body);
	if (!match) return null;
	const api = match[1] as string;
	const win32Code = Number(match[2]);
	const detail = (match[3] ?? "").trim();
	const operation = parseOperation(detail, knownPaths);
	if (!operation) {
		return { api, win32Code: Number.isFinite(win32Code) ? win32Code : null, operation: null, path: null, labelNeedsWriteOwner: false, detail };
	}
	return {
		api,
		win32Code: Number.isFinite(win32Code) ? win32Code : null,
		operation: operation.operation,
		path: operation.path,
		labelNeedsWriteOwner: /WRITE_OWNER/i.test(operation.explanation),
		detail,
	};
}

/** The account string an `icacls` remediation line should name. */
export function currentAccountHint(): string {
	const domain = process.env.USERDOMAIN;
	const user = process.env.USERNAME;
	if (user && domain) return `${domain}\\${user}`;
	if (user) return user;
	return "<当前账户>";
}

/** Shell-safe single-quoted PowerShell literal. */
function psQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function workspaceNote(path: string, win32Code: number | null, labelNeedsWriteOwner: boolean): string {
	const cause = labelNeedsWriteOwner
		? "后端报告这次失败发生在写入 Low 完整性标签（SACL）时，写标签需要 WRITE_OWNER。"
		: "后端没有说明具体成因（可能是 DACL 权限、所有者/WRITE_OWNER、受保护的安全描述符或策略），不能一律断定为缺少 WRITE_OWNER。";
	return (
		`沙盒初始化失败：无法写入工作区根 ${path} 的安全描述符（Win32 ${win32Code ?? "?"}）。${cause}` +
		"命令没有执行（fail-closed），这不是命令越界，也不是目录内权限不足。" +
		"这类故障不能靠 sandbox_request 绕过；请把这行诊断报告给人类，修复工作区后再重试。"
	);
}

function remediationBlock(path: string, account: string, confident: boolean): string[] {
	const assignment = `$root = ${psQuote(path)}`;
	return [
		"",
		"首选：先把插件升级到带 vendored 后端的版本（本包 0.4.2 起在包内自带该后端）。当工作区根已经通过继承处于",
		"Low no-write-up 时，它只改 DACL，不重写现有 Low 标签，因此不需要额外修复权限。",
		"注意：正常授权仍会写能力 SID 允许 ACE 和 Everyone 删除子项拒绝 ACE（这是沙盒授权本身），",
		"“无需修复权限”指的是不需要额外的 WRITE_OWNER/(WO) 补丁，不是完全不改 ACL。0.4.2 之前发布的上游",
		"0.2.2-rc.5 后端没有这个修复，升级到它并不能解决，必须换成本包的 vendored 后端。",
		"",
		confident
			? "若后端确凿报告标签写入需要 WRITE_OWNER（本行即如此），且只读检查确认当前账户确实缺少该权限，"
			: "只有在只读检查确认当前账户在根上确实缺少必需权限后，才考虑最小修复；不要把它当通用修复。",
		"人类可在普通 PowerShell（不是受限沙盒）里先备份，再加一条最小 ACE（不继承、不扩散、不涉及 Everyone）：",
		"",
		`  ${assignment}`,
		"  $backup = Join-Path $env:TEMP 'pi-dsh-sandbox-root-dacl.sddl'",
		"  $access = [System.Security.AccessControl.AccessControlSections]::Access",
		"  (Get-Acl -LiteralPath $root).GetSecurityDescriptorSddlForm($access) | Set-Content -LiteralPath $backup",
		`  icacls $root /grant \"${account}:(WO)\"`,
		"",
		"回滚：把保存的 DACL 原样写回（只替换 DACL，不碰 owner/group/SACL 与完整性标签）：",
		"",
		"  $acl = [System.Security.AccessControl.DirectorySecurity]::new()",
		"  $acl.SetSecurityDescriptorSddlForm((Get-Content -LiteralPath $backup -Raw).Trim(), $access)",
		"  Set-Acl -LiteralPath $root -AclObject $acl",
		"",
		"不要用 `icacls /restore` 当 DACL 回滚：实测在非管理员下可能处理 0 个文件并报 1300，",
		"且 `icacls /save` 的备份里带 SACL 段（会把完整性标签一起写回，需要额外特权）。",
		"上面的 Get-Acl/Set-Acl 只读写 Access（DACL）一节，实测能精确还原原 DACL 且标签不变。",
		"禁止 `icacls /reset /T`、禁止给 Everyone 写权限、不要重置整棵目录树。插件不会自动执行上面任何改动。",
		"",
		"替代方案：把会话换到一个当前账户已具备可继承完全控制（或已继承 Low 标签）的目录。",
		"",
		"修复后：/reload，然后 /sandbox doctor（其中「工作区就绪」一项探测真实工作区根）。",
		"不要用 sandbox_request 绕过初始化失败：它只执行一条一次性命令，不会修复工作区。",
	];
}

function inspectBlock(path: string): string[] {
	return [
		"",
		"只读检查（不改 ACL）：",
		`  icacls ${psQuote(path)}`,
		"  看当前账户是否有显式或继承的完全控制；若只有组权限、且父目录的当前账户 ACE 没有继承标志，",
		"  根本身可能只有所有者隐含的 READ_CONTROL + WRITE_DAC。",
		"  也可以运行 /sandbox doctor 的「工作区就绪（真实根）」一项复现同一故障。",
	];
}

function workspaceLines(path: string, api: string, win32Code: number | null, account: string, labelNeedsWriteOwner: boolean): string[] {
	const header = [
		`工作区根的安全描述符无法写入：${api} failed (Win32 ${win32Code ?? "?"}) on ${path}。`,
	];
	if (labelNeedsWriteOwner) {
		header.push(
			"",
			"成因（后端错误详情明确说明）：这次 SetNamedSecurityInfoW 在写 Low 完整性标签（SACL），写标签需要 WRITE_OWNER。",
			"若父目录把「当前账户完全控制」限制在自己一层（ACE 没有继承标志），工作区根只继承到普通组权限与能力 SID 的允许项，",
			"当前账户只有 DACL 写入权（WRITE_DAC，所有者隐含），没有 WRITE_OWNER，整个调用失败且什么都没改（fail-closed）。",
		);
	} else {
		header.push(
			"",
			"可能原因（后端没有给出确凿成因，以下都只是可能，不能据此直接断定缺 WRITE_OWNER）：",
			"  1) 当前账户在根上没有 WRITE_DAC（既不是所有者，也没有被授予写 DACL 的权限）；",
			"  2) 后端这次需要写 Low 完整性标签（SACL），写标签需要 WRITE_OWNER；若根已通过继承具备 Low no-write-up，",
			"     0.4.2 起的 vendored 后端会跳过这次标签写入；",
			"  3) 安全描述符受保护（受保护 DACL、防篡改/策略），或当前账户不是所有者且没有 owner 写权限；",
			"  4) SetNamedSecurityInfoW 的其它组件（owner/group/SACL）写入被拒。",
		);
	}
	return [
		...header,
		...inspectBlock(path),
		...remediationBlock(path, account, labelNeedsWriteOwner),
	];
}

function tempNote(path: string, win32Code: number | null): string {
	return (
		`沙盒初始化失败：无法为运行器私有 temp 目录 ${path} 写入安全描述符（Win32 ${win32Code ?? "?"}）。` +
		"命令没有执行（fail-closed）。这属于 temp 根/配置问题，不是命令越界，sandbox_request 也无法修复；" +
		"请报告人类并检查 piDshSandbox.tempRoot。"
	);
}

function tempLines(path: string, api: string, win32Code: number | null, tempRoot: string | null): string[] {
	return [
		`runner 的私有 temp 目录无法授权：${api} failed (Win32 ${win32Code ?? "?"}) on ${path}。`,
		"",
		`根因在 temp 根${tempRoot ? `（配置值：${tempRoot}）` : ""}：运行器会在其下创建自己的私有子目录（例如 dsh-*），`,
		"失败可能来自 temp 根不可写、被策略/受保护描述符限制，或不在当前账户可授权的目录下。",
		"处理：把 piDshSandbox.tempRoot / --sandbox-temp 改到当前账户自己的可写目录（必须在工作区之外），然后 /reload。",
		"不要用 sandbox_request 绕过：一次性执行不会修复 temp 授权。",
	];
}

export interface DiagnoseInput {
	/** The `windows-acl-run:` line the runner printed. */
	signature: string | undefined;
	/** The session's canonical workspace root. */
	root: string;
	/** The configured temp root, when known. */
	tempRoot?: string | null;
	/** Account string used in remediation commands (defaults to the current account). */
	account?: string;
}

/**
 * Classify a runner failure as a workspace/temp readiness fault and produce its text.
 * @param input - the runner signature, the session root, and the temp root.
 * @returns the diagnosis, or null when the failure is about something else.
 */
export function diagnoseRunnerFailure(input: DiagnoseInput): ReadinessDiagnosis | null {
	const knownPaths = [input.root, ...(input.tempRoot ? [input.tempRoot] : [])];
	const failure = parseRunnerGrantFailure(input.signature, knownPaths);
	if (!failure || failure.path === null) return null;
	// A runner failure that is not an ACL edit by the backend (token, spawn, argv) keeps the
	// generic note: the plugin must not claim a cause it has not established.
	if (failure.operation === null) return null;

	const isWorkspace = samePath(failure.path, input.root);
	// The runner grants its own PRIVATE child of --temp (dsh-*), and the plugin passes a private
	// call-* directory as --temp. A failure there is a temp-root fault even though its path is a
	// descendant of the configured root, not an equal string.
	const isTemp = !isWorkspace && Boolean(input.tempRoot) && sameOrInside(failure.path, input.tempRoot as string);
	const target: ReadinessTarget = isWorkspace ? "workspace" : isTemp ? "temp" : "other";
	const win32Code = failure.win32Code;

	if (target === "workspace" && failure.api === "SetNamedSecurityInfoW" && win32Code === ERROR_ACCESS_DENIED) {
		const account = input.account ?? currentAccountHint();
		return {
			target,
			path: failure.path,
			api: failure.api,
			win32Code,
			note: workspaceNote(failure.path, win32Code, failure.labelNeedsWriteOwner),
			lines: workspaceLines(failure.path, failure.api, win32Code, account, failure.labelNeedsWriteOwner),
		};
	}
	if (target === "workspace" && failure.api === "GetNamedSecurityInfoW" && win32Code === ERROR_ACCESS_DENIED) {
		return {
			target,
			path: failure.path,
			api: failure.api,
			win32Code,
			note:
				`沙盒初始化失败：无法读取工作区根 ${failure.path} 的安全描述符（Win32 ${win32Code}，命令未执行）。` +
				"这是工作区就绪问题，不是命令越界；sandbox_request 不能修复它，请报告人类。",
			lines: [
				`无法读取工作区根的安全描述符：GetNamedSecurityInfoW failed (Win32 ${win32Code}) on ${failure.path}。`,
				"可能原因：当前账户没有该目录的 READ_CONTROL，或路径被策略保护。",
				"只读检查：",
				`  icacls ${psQuote(failure.path)}`,
				"处理：确认当前账户至少有该目录的读取控制权限，或更换工作区。不要用 sandbox_request 绕过。",
			],
		};
	}
	if (target === "temp") {
		return {
			target,
			path: failure.path,
			api: failure.api,
			win32Code,
			note: tempNote(failure.path, win32Code),
			lines: tempLines(failure.path, failure.api, win32Code, input.tempRoot ?? null),
		};
	}
	return null;
}

const notified = new Set<string>();

/**
 * True exactly once per session/root/fault: the TUI turns the first occurrence into a notification
 * so the human sees the workspace fault instead of only the model reading it.
 * @param sessionId - the Pi session id.
 * @param root - the canonical workspace root.
 * @param fault - the failing directory, from {@link diagnoseRunnerFailure}.
 * @returns whether the caller should notify now.
 */
export function shouldNotifyReadiness(sessionId: string, root: string, fault: ReadinessDiagnosis): boolean {
	const key = `${sessionId}\u0000${normalizePath(root)}\u0000${normalizePath(fault.path)}\u0000${fault.api}`;
	if (notified.has(key)) return false;
	notified.add(key);
	return true;
}

/** Drop the per-session notification memory (called on reload and at session end). */
export function resetReadinessNotifications(): void {
	notified.clear();
}