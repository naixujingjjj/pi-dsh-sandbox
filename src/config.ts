/**
 * Configuration parsing.
 *
 * Sources, in decreasing priority: extension CLI flags, then the **global** Pi settings file
 * (`~/.pi/agent/settings.json`, key `piDshSandbox`). Project settings are deliberately ignored:
 * a repository must not be able to widen a sandbox that the user configured, so a model that
 * writes `.pi/settings.json` cannot grant itself a wider mode or a different runner.
 *
 * This module is pure (no Pi imports, no I/O) so it can be unit-tested directly.
 */
import { win32 } from "node:path";
import { DEFAULT_MODE, SANDBOX_MODES, isSandboxMode, type SandboxMode } from "./policy.ts";

export const CONFIG_KEY = "piDshSandbox";

/** Settings keys that would imply extra write roots. Process-level confinement cannot honor them. */
export const UNSUPPORTED_WRITE_ROOT_KEYS = [
	"additionalWritableRoots",
	"writableRoots",
	"additionalRoots",
	"writeRoots",
	"extraRoots",
] as const;

export type ConfigSource = "flag" | "settings" | "default";

export interface SandboxConfig {
	mode: SandboxMode;
	modeSource: ConfigSource;
	/** Explicit runner module path; when set it is authoritative and never silently replaced. */
	runnerModule: string | null;
	/** Explicit DSH installation root; same rule as `runnerModule`. */
	dshRoot: string | null;
	/** Base directory for the runner's `--temp` root and for the plugin's private data. */
	tempRoot: string | null;
	/** Problems that must fail the sandbox closed (the user asked for something unsupported). */
	fatal: string[];
	/** Problems worth reporting that do not change the safety of the effective mode. */
	warnings: string[];
}

export interface ConfigInput {
	/** Raw text of the global settings file, or null when it does not exist. */
	settingsText: string | null;
	/** Extension flag values: `sandbox-mode`, `sandbox-runner`, `sandbox-temp`. */
	flags?: Record<string, unknown>;
}

const KNOWN_KEYS = new Set(["mode", "runnerModule", "dshRoot", "tempRoot"]);

function flagString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function parseConfig(input: ConfigInput): SandboxConfig {
	const fatal: string[] = [];
	const warnings: string[] = [];
	const flags = input.flags ?? {};

	let section: Record<string, unknown> = {};
	if (input.settingsText !== null) {
		try {
			const parsed = JSON.parse(input.settingsText) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const raw = (parsed as Record<string, unknown>)[CONFIG_KEY];
				if (raw !== undefined) {
					if (raw && typeof raw === "object" && !Array.isArray(raw)) {
						section = raw as Record<string, unknown>;
					} else {
						fatal.push(`${CONFIG_KEY} 必须是对象，请修复配置后重试`);
					}
				}
			} else {
				fatal.push("全局 settings.json 顶层必须是对象，请修复配置后重试");
			}
		} catch (error) {
			fatal.push(`无法解析全局 settings.json（${error instanceof Error ? error.message : String(error)}），请修复配置后重试`);
		}
	}

	for (const key of Object.keys(section)) {
		if ((UNSUPPORTED_WRITE_ROOT_KEYS as readonly string[]).includes(key)) {
			fatal.push(
				`配置项 ${CONFIG_KEY}.${key} 暂不支持：进程级沙盒只能授权一个工作区根（session cwd），` +
					`额外的可写根无法被受限令牌保证。请删除该配置项。`,
			);
			continue;
		}
		if (!KNOWN_KEYS.has(key)) {
			warnings.push(`未知配置项 ${CONFIG_KEY}.${key}，已忽略`);
		}
	}

	let mode: SandboxMode = DEFAULT_MODE;
	let modeSource: ConfigSource = "default";

	const settingsMode = section.mode;
	if (settingsMode !== undefined) {
		if (isSandboxMode(settingsMode)) {
			mode = settingsMode;
			modeSource = "settings";
		} else {
			fatal.push(
				`${CONFIG_KEY}.mode 的值 ${JSON.stringify(settingsMode)} 无效（可选 ${SANDBOX_MODES.join(" / ")}），` +
					`请修复配置后重试`,
			);
		}
	}

	const flagMode = flagString(flags["sandbox-mode"]);
	if (flagMode !== null) {
		if (isSandboxMode(flagMode)) {
			mode = flagMode;
			modeSource = "flag";
		} else {
			fatal.push(`--sandbox-mode 的值 ${JSON.stringify(flagMode)} 无效，请修复参数后重试`);
			mode = DEFAULT_MODE;
			modeSource = "default";
		}
	}

	const readPath = (flagName: string, key: "runnerModule" | "dshRoot" | "tempRoot"): string | null => {
		const candidates: Array<{ value: string; origin: string }> = [];
		const fromFlag = flagString(flags[flagName]);
		if (fromFlag !== null) candidates.push({ value: fromFlag, origin: `--${flagName}` });
		const fromSettings = section[key];
		if (typeof fromSettings === "string" && fromSettings.trim().length > 0) {
			candidates.push({ value: fromSettings.trim(), origin: `${CONFIG_KEY}.${key}` });
		}
		for (const candidate of candidates) {
			if (!win32.isAbsolute(candidate.value)) {
				fatal.push(`${candidate.origin} 必须是绝对路径：${candidate.value}`);
				return null;
			}
			return candidate.value;
		}
		return null;
	};

	return {
		mode,
		modeSource,
		runnerModule: readPath("sandbox-runner", "runnerModule"),
		dshRoot: readPath("sandbox-dsh-root", "dshRoot"),
		tempRoot: readPath("sandbox-temp", "tempRoot"),
		fatal,
		warnings,
	};
}
