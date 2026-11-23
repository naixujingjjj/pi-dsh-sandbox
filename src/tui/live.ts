/**
 * Live request facts for tool rows.
 *
 * `renderCall` receives only the tool arguments (command + reason). The canonical cwd, the sandbox
 * mode at request time and the timeout were captured by `execute()`, so they are kept here, keyed by
 * tool call id, and read back by the card renderer while the row is drawn. Everything is plain
 * data: no component, no theme, no ANSI.
 *
 * The map is capped: an approval row must not grow process memory without bound in a long session.
 * A missing entry (for example after a reload) only means the card cannot show the captured facts;
 * the result card carries them from the tool result details.
 */
import type { OperationRequest } from "../approval.ts";
import { resolveLocale, type Locale } from "../i18n.ts";

export type LiveApprovalPhase = "pending" | "approved" | "declined" | "cancelled" | "error";

export interface LiveApproval {
	request: OperationRequest;
	phase: LiveApprovalPhase;
}

const MAX_ENTRIES = 100;
const entries = new Map<string, LiveApproval>();
const invalidators = new Map<string, () => void>();

/**
 * Locale per restored `sandbox_request` tool call, rebuilt from the current branch at session start.
 *
 * `renderCall` receives only the tool arguments (which deliberately never contain a locale), so a
 * row restored from history needs the locale that was saved with its result. Without this map the
 * request row would be drawn in the default language next to an English result card. The map is
 * rebuilt from tool-result details, is branch-local (session_start passes the current branch) and
 * is capped like the live map.
 */
const historicalLocales = new Map<string, Locale>();

interface HistoricalEntryLike {
	type?: unknown;
	message?: {
		role?: unknown;
		toolCallId?: unknown;
		toolName?: unknown;
		details?: { locale?: unknown } | null;
	};
}

/** Rebuild the restored-row locale map from session entries (oldest to newest, newest wins). */
export function restoreHistoricalApprovalLocales(branch: unknown): void {
	historicalLocales.clear();
	if (!Array.isArray(branch)) return;
	for (const item of branch) {
		const entry = item as HistoricalEntryLike | null;
		if (entry === null || typeof entry !== "object" || entry.type !== "message") continue;
		const message = entry.message;
		if (!message || typeof message !== "object" || message.role !== "toolResult") continue;
		if (message.toolName !== "sandbox_request") continue;
		if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) continue;
		const locale = message.details?.locale;
		if (locale !== "zh" && locale !== "en") continue;
		historicalLocales.set(message.toolCallId, resolveLocale(locale));
		while (historicalLocales.size > MAX_ENTRIES) {
			const oldest = historicalLocales.keys().next();
			if (oldest.done) break;
			historicalLocales.delete(oldest.value);
		}
	}
}

/** Locale saved with a restored request row, or undefined when the row predates 0.4.0. */
export function historicalApprovalLocale(toolCallId: string | undefined): Locale | undefined {
	return toolCallId === undefined ? undefined : historicalLocales.get(toolCallId);
}

/** Keep a settled row's locale available even after its live entry is evicted. */
export function rememberHistoricalApprovalLocale(toolCallId: string | undefined, locale: unknown): void {
	if (toolCallId === undefined || (locale !== "zh" && locale !== "en")) return;
	historicalLocales.set(toolCallId, resolveLocale(locale));
	while (historicalLocales.size > MAX_ENTRIES) {
		const oldest = historicalLocales.keys().next();
		if (oldest.done) break;
		historicalLocales.delete(oldest.value);
	}
}

/** Tool rows can be created before execute() captures the request. Refresh when facts arrive. */
export function watchLiveApproval(key: string | undefined, invalidate: () => void): void {
	if (key === undefined) return;
	invalidators.set(key, invalidate);
	while (invalidators.size > MAX_ENTRIES) {
		const oldest = invalidators.keys().next();
		if (oldest.done) break;
		invalidators.delete(oldest.value);
	}
}

function notify(key: string): void {
	try { invalidators.get(key)?.(); }
	catch { /* Rendering never authorizes or prevents an approval decision. */ }
}

function keyOf(request: OperationRequest): string {
	return request.toolCallId ?? request.requestId;
}

export function registerLiveApproval(request: OperationRequest, phase: LiveApprovalPhase = "pending"): void {
	entries.set(keyOf(request), { request, phase });
	while (entries.size > MAX_ENTRIES) {
		const oldest = entries.keys().next();
		if (oldest.done) break;
		entries.delete(oldest.value);
	}
	notify(keyOf(request));
}

export function updateLiveApprovalPhase(request: OperationRequest, phase: LiveApprovalPhase): void {
	const key = keyOf(request);
	const existing = entries.get(key);
	if (!existing) return;
	existing.phase = phase;
	notify(key);
	if (phase !== "pending") invalidators.delete(key);
}

export function getLiveApproval(key: string | undefined): LiveApproval | undefined {
	return key === undefined ? undefined : entries.get(key);
}

/** Test hook: forget every captured request. */
export function clearLiveApprovals(): void {
	entries.clear();
	invalidators.clear();
	historicalLocales.clear();
}
