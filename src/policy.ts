/**
 * Policy vocabulary and the containment check used for diagnostics.
 *
 * This module is a *policy* helper: it decides what the user was told the sandbox allows, so a
 * doomed write inside one of Pi's in-process file tools can fail early with a clear message.
 * It is NOT the security boundary. The boundary is the Windows restricted token + Low integrity
 * label created by the DSH runner, which checks every write and delete in the kernel.
 */
import { realpathSync } from "node:fs";
import { win32 } from "node:path";
import { modeDescriptionEn, type Locale } from "./i18n.ts";

export const SANDBOX_MODES = ["off", "read-only", "workspace-write"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/** Mode the runner accepts on the command line. `off` never reaches the runner. */
export type ConfinedMode = "read-only" | "workspace-write";

export const DEFAULT_MODE: SandboxMode = "workspace-write";

export function isSandboxMode(value: unknown): value is SandboxMode {
	return typeof value === "string" && (SANDBOX_MODES as readonly string[]).includes(value);
}

export function isConfinedMode(value: SandboxMode): value is ConfinedMode {
	return value === "read-only" || value === "workspace-write";
}

/** True when `mode` grants write authority at all. */
export function modeAllowsWrite(mode: SandboxMode): boolean {
	return mode === "workspace-write";
}

/** Rank for "is this a widening change?" (`off` is widest). */
export function modeRank(mode: SandboxMode): number {
	switch (mode) {
		case "read-only":
			return 1;
		case "workspace-write":
			return 2;
		case "off":
			return 3;
	}
}

export function describeMode(mode: SandboxMode, locale: Locale = "zh"): string {
	if (locale === "en") return modeDescriptionEn(mode);
	switch (mode) {
		case "read-only":
			return "read-only（只读：任何写入/删除都被内核拒绝）";
		case "workspace-write":
			return "workspace-write（只能写工作区根与运行器私有 temp）";
		case "off":
			return "off（不介入：工具以未受限方式执行）";
	}
}

/** Diagnostics-only marker so early refusals are never mistaken for the kernel boundary. */
export const POLICY_CHECK_NOTE = "策略检查只用于提前报错；实际边界在受限进程内的内核 ACL";

const EXTENDED_UNC = /^\\\\\?\\UNC\\/i;
const EXTENDED_DRIVE = /^\\\\\?\\[a-zA-Z]:[\\/]/;
const ANY_EXTENDED = /^\\\\[?.]\\/;
const UNC_PREFIX = /^\\\\[^\\]/;
const DRIVE_RELATIVE = /^[a-zA-Z]:(?![\\/])/i;

/**
 * Canonical real path of a directory: resolves junctions, symlinks and 8.3 short names.
 * The sandbox root must be canonical, because the runner derives the workspace capability SID
 * from the exact string it is given.
 */
export function canonicalDir(dir: string): string {
	try {
		return win32.resolve(realpathSync.native(dir));
	} catch {
		return win32.resolve(dir);
	}
}

export interface NormalizedTarget {
	/** Absolute, lexically normalized path with every existing ancestor resolved through links. */
	path: string;
	/** Set when the raw path cannot be checked reliably (device path, drive-relative path). */
	problem?: string;
}

/**
 * Normalize a tool-supplied path the way the filesystem would, then resolve links for the part
 * of the path that exists. Missing trailing segments stay lexical, so a write that creates a new
 * directory still lands inside the root it names.
 */
export function normalizeTarget(rawPath: string, baseDir: string): NormalizedTarget {
	let raw = rawPath.trim();
	if (raw.length === 0) return { path: "", problem: "路径为空" };

	if (EXTENDED_UNC.test(raw)) {
		raw = `\\\\${raw.slice(8)}`;
	} else if (EXTENDED_DRIVE.test(raw)) {
		raw = raw.slice(4);
	} else if (ANY_EXTENDED.test(raw)) {
		return { path: raw, problem: `不支持设备路径或卷路径: ${rawPath}` };
	}

	if (DRIVE_RELATIVE.test(raw)) {
		return {
			path: raw,
			problem: `不支持驱动器相对路径（形如 C:foo，含义取决于该驱动器各自的当前目录）: ${rawPath}`,
		};
	}

	const absolute = win32.isAbsolute(raw) ? win32.resolve(raw) : win32.resolve(baseDir, raw);
	return { path: resolveExistingAncestors(absolute) };
}

/**
 * Join the real path of the deepest existing ancestor with the not-yet-existing tail.
 * `realpathSync` fails on a missing path, so a plain `realpath(target)` cannot answer
 * "would this write land inside the root?" for a new file.
 */
function resolveExistingAncestors(absolute: string): string {
	const tail: string[] = [];
	let current = absolute;
	for (;;) {
		try {
			const real = win32.resolve(realpathSync.native(current));
			return tail.length === 0 ? real : win32.join(real, ...tail.slice().reverse());
		} catch {
			// Missing or unreadable: walk up one segment.
		}
		const parent = win32.dirname(current);
		if (parent === current) return absolute;
		tail.push(win32.basename(current));
		current = parent;
	}
}

function stripTrailingSep(path: string): string {
	if (path.length > 3 && (path.endsWith("\\") || path.endsWith("/"))) return path.slice(0, -1);
	return path;
}

function comparable(path: string): string {
	return stripTrailingSep(path).toLowerCase();
}

/** True when `target` is `root` itself or strictly below it (case-insensitive, boundary-safe). */
export function isInsideRoot(target: string, root: string): boolean {
	const t = comparable(target);
	const r = comparable(root);
	if (t === r) return true;
	const prefix = r.endsWith("\\") ? r : `${r}\\`;
	return t.startsWith(prefix);
}

/** True for `\\server\share` style paths. */
export function isUncPath(path: string): boolean {
	return UNC_PREFIX.test(path);
}

export interface ContainmentVerdict {
	inside: boolean;
	/** Absolute path that was checked. */
	target: string;
	/** Why it is outside/undecidable, when applicable. */
	reason?: string;
}

export function containment(rawPath: string, baseDir: string, root: string): ContainmentVerdict {
	const normalized = normalizeTarget(rawPath, baseDir);
	if (normalized.problem) return { inside: false, target: normalized.path, reason: normalized.problem };
	if (isInsideRoot(normalized.path, root)) return { inside: true, target: normalized.path };
	if (isUncPath(normalized.path) !== isUncPath(root)) {
		return { inside: false, target: normalized.path, reason: "UNC 路径与本地授权根属于不同命名空间" };
	}
	return { inside: false, target: normalized.path };
}