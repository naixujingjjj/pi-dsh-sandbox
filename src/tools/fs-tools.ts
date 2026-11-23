/**
 * Registration for `write` and `edit`.
 *
 * Pi keeps every semantic that matters — path resolution against `ctx.cwd`, exact-text matching,
 * BOM/newline handling, the diff, the per-file mutation queue — and only the actual mutation
 * (`mkdir`, `writeFile`) is delegated to {@link runMutation}, which executes in the restricted
 * token. That is what makes "kernel mode" honest: the bytes are written by a Low-integrity
 * restricted process, so a denied write is denied by Windows, not by a plugin-side policy check.
 *
 * The early containment check only turns a doomed write into a clear message; it is not the
 * boundary.
 */
import { resolve } from "node:path";
import {
	createEditToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { SandboxError } from "../errors.ts";
import { kernelEditOperations, kernelWriteOperations, type MutationContext } from "../mutation.ts";
import {
	assertMutationAllowed,
	assertReady,
	getSessionState,
	requireRunner,
	tempRootOf,
	type SessionState,
} from "../state.ts";

export function mutationContextOf(state: SessionState): MutationContext {
	if (state.mode === "off") {
		throw new SandboxError("SANDBOX_CONFIG", "off 模式不应进入受限写路径");
	}
	return {
		runner: requireRunner(state),
		root: state.root,
		temp: tempRootOf(state),
		ipcRoot: state.runtime.ipcRoot,
		mode: state.mode,
		helperPath: resolve(state.runtime.pluginRoot, "src", "kernel-helper.mjs"),
	};
}

export function registerFsTools(pi: ExtensionAPI, pluginRoot: string): void {
	const writeBase = createWriteToolDefinition(process.cwd());
	pi.registerTool({
		...writeBase,
		async execute(id, params, signal, onUpdate, ctx: ExtensionToolContext) {
			const state = getSessionState(pi, pluginRoot, ctx);
			if (state.runtime.configError) throw state.runtime.configError;
			if (state.mode === "off") {
				return createWriteToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			}
			assertReady(state);
			assertMutationAllowed(state, "write", params.path, ctx.cwd);
			return createWriteToolDefinition(ctx.cwd, {
				operations: kernelWriteOperations(mutationContextOf(state)),
			}).execute(id, params, signal, onUpdate, ctx);
		},
	});

	const editBase = createEditToolDefinition(process.cwd());
	pi.registerTool({
		...editBase,
		async execute(id, params, signal, onUpdate, ctx: ExtensionToolContext) {
			const state = getSessionState(pi, pluginRoot, ctx);
			if (state.runtime.configError) throw state.runtime.configError;
			if (state.mode === "off") {
				return createEditToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			}
			assertReady(state);
			assertMutationAllowed(state, "edit", params.path, ctx.cwd);
			return createEditToolDefinition(ctx.cwd, {
				operations: kernelEditOperations(mutationContextOf(state)),
			}).execute(id, params, signal, onUpdate, ctx);
		},
	});
}
