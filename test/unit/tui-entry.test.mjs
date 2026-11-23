/**
 * Session-entry cards: the TUI-only record of a human approval request/outcome.
 *
 * These entries do not enter the model context, so the data must be pure text; the renderer adds the
 * yellow. A malformed or empty entry must render nothing rather than throw inside the transcript.
 */
import test from "node:test";
import assert from "node:assert/strict";
import extension from "../../src/index.ts";
import {
	APPROVAL_CARD_ENTRY,
	appendApprovalCard,
	normalizeCardEntryData,
	registerApprovalCardRenderer,
} from "../../src/tui/entry.ts";
import { operationCardLines } from "../../src/tui/card.ts";
import { hasAnsi, hasYellow, makeTheme, nonYellowText, stripAnsi } from "../fixtures/palette.mjs";

const TEST = { timeout: 10000 };
const theme = makeTheme();

function request() {
	return {
		requestId: "req-entry",
		source: "human-command",
		sourceLabel: "人类命令 /sandbox exec",
		command: "Write-Output 'ENTRY'",
		requestReason: "人类直接在 /sandbox 中输入的一次性命令（没有模型申请理由）。",
		cwd: "C:\\work\\root",
		mode: "workspace-write",
	};
}

function piMock() {
	const registered = {};
	return {
		registered,
		pi: {
			registerTool() {},
			registerFlag() {},
			registerCommand() {},
			on() {},
			getFlag() {},
			getSettings() {
				return {};
			},
			registerEntryRenderer(type, renderer) {
				registered.entry = { type, renderer };
			},
			registerMessageRenderer(type, renderer) {
				registered.message = { type, renderer };
			},
		},
	};
}

test("the extension registers the approval card entry renderer on load", TEST, () => {
	const { pi, registered } = piMock();
	extension(pi);
	assert.ok(registered.entry, "an entry renderer must be registered");
	assert.equal(registered.entry.type, APPROVAL_CARD_ENTRY);
});

test("a stored card entry renders as the same yellow block, from plain data only", TEST, () => {
	const { pi, registered } = piMock();
	registerApprovalCardRenderer(pi);
	const lines = operationCardLines(request());
	const data = { kind: "operation", lines };
	const rendered = registered.entry.renderer({ customType: APPROVAL_CARD_ENTRY, data }, { expanded: false }, theme);
	const output = rendered.render(80);
	const text = output.map((line) => stripAnsi(line)).join("\n");
	assert.match(text, /模型正在请求一次工作区外的操作/);
	assert.match(text, /Write-Output 'ENTRY'/);
	assert.match(text, /cwd：C:\\work\\root/);
	for (const line of output) {
		assert.ok(hasYellow(line));
		assert.equal(nonYellowText(line), "");
	}
	// The stored data itself is plain text: no ANSI reaches the session file.
	assert.equal(hasAnsi(JSON.stringify(data)), false);
});

test("malformed entry data renders nothing instead of throwing", TEST, () => {
	const { pi, registered } = piMock();
	registerApprovalCardRenderer(pi);
	assert.deepEqual(normalizeCardEntryData(undefined), []);
	assert.deepEqual(normalizeCardEntryData({ lines: "nope" }), []);
	assert.deepEqual(
		normalizeCardEntryData({ lines: [{ role: "title", text: "ok" }, { role: 42, text: "x" }, { text: "y" }, { role: "body" }] }),
		[
			{ role: "title", text: "ok" },
			{ role: "body", text: "x" },
			{ role: "body", text: "y" },
		],
	);
	const renderer = registered.entry.renderer;
	assert.equal(renderer({ customType: APPROVAL_CARD_ENTRY, data: undefined }, { expanded: false }, theme), undefined);
	assert.equal(renderer({ customType: APPROVAL_CARD_ENTRY, data: { lines: [] } }, { expanded: false }, theme), undefined);
});

test("an unknown role falls back to the body role so it still renders yellow", TEST, () => {
	const { pi, registered } = piMock();
	registerApprovalCardRenderer(pi);
	const data = { kind: "operation", lines: normalizeCardEntryData({ lines: [{ role: "rainbow", text: "文字" }] }) };
	assert.deepEqual(data.lines, [{ role: "body", text: "文字" }]);
	const output = registered.entry.renderer({ customType: APPROVAL_CARD_ENTRY, data }, { expanded: false }, theme).render(40);
	assert.equal(nonYellowText(output.join("")), "");
});

test("a failure to append the card never throws (the approval itself is unaffected)", TEST, () => {
	const failures = [];
	const broken = {
		appendEntry() {
			throw new Error("session is read-only");
		},
	};
	assert.equal(appendApprovalCard(broken, { kind: "operation", lines: [] }), false);
	assert.equal(
		appendApprovalCard(
			{
				appendEntry(type, data) {
					failures.push({ type, data });
				},
			},
			{ kind: "operation", lines: [{ role: "title", text: "x" }] },
		),
		true,
	);
	assert.equal(failures[0].type, APPROVAL_CARD_ENTRY);
	assert.deepEqual(failures[0].data.lines, [{ role: "title", text: "x" }]);
});