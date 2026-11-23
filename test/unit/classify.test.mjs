import test from "node:test";
import assert from "node:assert/strict";
import {
	classify,
	DENIAL_SIGNATURES,
	findDenialSignature,
	findRunnerFailure,
	RUNNER_FAILURE_EXIT,
	RUNNER_FAILURE_SIGNATURE,
} from "../../src/classify.ts";
import { SandboxError, isSandboxError } from "../../src/errors.ts";

test("runner failure signature wins over a denial", () => {
	const classification = classify({
		exitCode: RUNNER_FAILURE_EXIT,
		stderr: "windows-acl-run: --temp is not an existing directory: C:\\nope\r\nAccess is denied.",
		output: "Access is denied.",
	});
	assert.equal(classification.kind, "runner-failure");
	assert.match(classification.signature ?? "", /^windows-acl-run: --temp is not an existing directory/);
});

test("runner failure is detected regardless of exit code", () => {
	const classification = classify({ exitCode: 1, stderr: "windows-acl-run: CreateRestrictedToken failed (Win32 5)" });
	assert.equal(classification.kind, "runner-failure");
});

test("EPERM from node counts as a denial", () => {
	const classification = classify({
		exitCode: 1,
		stderr: "",
		output: "node:fs:1904 EPERM: operation not permitted, open 'C:\\secret\\x.txt'",
	});
	assert.equal(classification.kind, "denied");
	assert.equal(classification.signature, "eperm");
});

test("EACCES counts as a denial", () => {
	assert.equal(classify({ exitCode: 1, output: "fs.js EACCES: permission denied" }).kind, "denied");
});

test(".NET access error counts as a denial", () => {
	assert.equal(
		classify({ exitCode: 1, output: "Access to the path 'C:\\x' is denied." }).kind,
		"denied",
	);
});

test("localized denial text counts as a denial", () => {
	assert.equal(classify({ exitCode: 1, output: "对路径“C:\\x”的访问被拒绝。" }).kind, "denied");
});

test("a plain nonzero exit is a command failure, not a denial", () => {
	const classification = classify({ exitCode: 3, stderr: "", output: "some output" });
	assert.equal(classification.kind, "command-failed");
	assert.equal(classification.signature, undefined);
});

test("exit 127 without the signature is a command failure", () => {
	assert.equal(classify({ exitCode: 127, stderr: "not found", output: "" }).kind, "command-failed");
});

test("zero exit classifies as none", () => {
	assert.equal(classify({ exitCode: 0, output: "" }).kind, "none");
});

test("null exit code with no output classifies as none", () => {
	assert.equal(classify({ exitCode: null, output: "" }).kind, "none");
});

test("findRunnerFailure returns undefined without the signature", () => {
	assert.equal(findRunnerFailure("plain stderr"), undefined);
	assert.equal(findRunnerFailure(undefined), undefined);
	assert.match(findRunnerFailure("x windows-acl-run: boom\ny") ?? "", /boom/);
});

test("findDenialSignature is case-insensitive", () => {
	assert.equal(findDenialSignature("ACCESS IS DENIED"), "access is denied");
	assert.equal(findDenialSignature("nothing here"), undefined);
	assert.ok(DENIAL_SIGNATURES.includes("eperm"));
	assert.equal(RUNNER_FAILURE_SIGNATURE, "windows-acl-run:");
});

test("SandboxError carries a code", () => {
	const error = new SandboxError("SANDBOX_UNAVAILABLE", "no runner");
	assert.equal(error.code, "SANDBOX_UNAVAILABLE");
	assert.match(error.message, /^SANDBOX_UNAVAILABLE: no runner$/);
	assert.equal(isSandboxError(error), true);
	assert.equal(isSandboxError(new Error("x")), false);
});