import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMutationChannel,
	disposeMutationChannel,
	parseHelperResult,
	RESULT_MARKER,
} from "../../src/ipc.ts";

const ipcRoot = mkdtempSync(join(tmpdir(), "pidsbx-ipc-"));

test.after(() => {
	rmSync(ipcRoot, { recursive: true, force: true });
});

test("the channel is unique per call and holds the request", () => {
	const first = createMutationChannel(ipcRoot, { op: "write", path: "C:\\a.txt", content: "hello" });
	const second = createMutationChannel(ipcRoot, { op: "mkdir", path: "C:\\b" });
	try {
		assert.notEqual(first.dir, second.dir);
		assert.equal(readdirSync(first.dir).length, 1);
		assert.deepEqual(JSON.parse(readFileSync(first.requestPath, "utf8")), {
			op: "write",
			path: "C:\\a.txt",
			content: "hello",
		});
		assert.deepEqual(JSON.parse(readFileSync(second.requestPath, "utf8")), { op: "mkdir", path: "C:\\b" });
	} finally {
		disposeMutationChannel(first);
		disposeMutationChannel(second);
	}
});

test("dispose removes the whole per-call directory", () => {
	const channel = createMutationChannel(ipcRoot, { op: "write", path: "C:\\x", content: "" });
	disposeMutationChannel(channel);
	assert.equal(readdirSync(ipcRoot).includes(channel.dir.split("\\").pop()), false);
});

test("dispose tolerates a missing directory", () => {
	const channel = createMutationChannel(ipcRoot, { op: "write", path: "C:\\x", content: "" });
	disposeMutationChannel(channel);
	assert.doesNotThrow(() => disposeMutationChannel(channel));
	assert.doesNotThrow(() => disposeMutationChannel(undefined));
});

test("parseHelperResult reads the last result line", () => {
	const stdout = `${RESULT_MARKER}{"ok":true}\n`;
	assert.deepEqual(parseHelperResult(stdout), { ok: true });
});

test("parseHelperResult reports failures with code and message", () => {
	const stdout = `noise\n${RESULT_MARKER}${JSON.stringify({ ok: false, code: "EPERM", message: "operation not permitted" })}\n`;
	const parsed = parseHelperResult(stdout);
	assert.equal(parsed.ok, false);
	assert.equal(parsed.code, "EPERM");
});

test("parseHelperResult returns null without a protocol line", () => {
	assert.equal(parseHelperResult(""), null);
	assert.equal(parseHelperResult("random output"), null);
	assert.equal(parseHelperResult(`${RESULT_MARKER}not json`), null);
	assert.equal(parseHelperResult(`${RESULT_MARKER}{"nope":1}`), null);
});

test("request files are written with content that round-trips", () => {
	const content = "中文 + 引号 \" ' + CRLF\r\nline2\r\n";
	const channel = createMutationChannel(ipcRoot, { op: "write", path: "C:\\带 空格\\文件.txt", content });
	try {
		const parsed = JSON.parse(readFileSync(channel.requestPath, "utf8"));
		assert.equal(parsed.content, content);
		assert.equal(parsed.path, "C:\\带 空格\\文件.txt");
		writeFileSync(channel.requestPath, readFileSync(channel.requestPath));
	} finally {
		disposeMutationChannel(channel);
	}
});