/** Approval language: any Han character means Chinese; otherwise Latin text means English.
 * Read only real user messages on the current branch. Empty/non-text prompts keep searching
 * backwards; plugin-generated follow-ups never choose the language. No prose scoring or
 * language-request interpretation: mixed content always uses Chinese, including code and paths.
 */
import { DEFAULT_LOCALE, type Locale } from "./i18n.ts";

interface BranchEntryLike {
	type?: unknown;
	message?: { role?: unknown; content?: unknown };
}

export function detectLocaleFromText(text: string): Locale | undefined {
	if (typeof text !== "string" || text.trim().length === 0) return undefined;
	if (text.trimStart().startsWith("[pi-dsh-sandbox]")) return undefined;
	if (/\p{Script=Han}/u.test(text)) return "zh";
	if (/[A-Za-z]/.test(text)) return "en";
	return undefined;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
	}
	return parts.join("\n");
}

/**
 * Detect from branch entries (newest first walk). Only user messages are considered.
 */
export function detectLocaleFromBranch(entries: unknown): Locale | undefined {
	if (!Array.isArray(entries)) return undefined;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as BranchEntryLike | null;
		if (entry === null || typeof entry !== "object") continue;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message === null || typeof message !== "object" || message.role !== "user") continue;
		const locale = detectLocaleFromText(messageText(message.content));
		if (locale !== undefined) return locale;
	}
	return undefined;
}

/**
 * Detect for one approval. `sessionManager` is Pi's per-session manager (`getBranch()` is the
 * current leaf path only, never another session or an abandoned branch). Any missing or failing
 * manager falls back to Chinese, so old tests and non-session transports keep their behavior.
 */
export function detectLocaleFromSession(sessionManager: unknown): Locale {
	try {
		const manager = sessionManager as { getBranch?: () => unknown } | null | undefined;
		if (!manager || typeof manager.getBranch !== "function") return DEFAULT_LOCALE;
		return detectLocaleFromBranch(manager.getBranch()) ?? DEFAULT_LOCALE;
	} catch {
		return DEFAULT_LOCALE;
	}
}

/** Test/helper: detect from plain user texts, newest last. */
export function detectLocaleFromTexts(texts: readonly string[]): Locale | undefined {
	for (let index = texts.length - 1; index >= 0; index -= 1) {
		const locale = detectLocaleFromText(texts[index] ?? "");
		if (locale !== undefined) return locale;
	}
	return undefined;
}