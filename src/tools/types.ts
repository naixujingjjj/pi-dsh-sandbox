/** Structural view of a tool result, enough to append a sandbox fact line. */
export interface AgentToolResultLike {
	content: unknown;
	details?: unknown;
	isError?: boolean;
	structuredContent?: unknown;
}