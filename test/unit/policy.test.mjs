import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalDir,
	containment,
	describeMode,
	isConfinedMode,
	isInsideRoot,
	isSandboxMode,
	isUncPath,
	modeAllowsWrite,
	modeRank,
	normalizeTarget,
} from "../../src/policy.ts";

const root = mkdtempSync(join(tmpdir(), "pidsbx-policy-"));

test.after(() => {
	rmSync(root, { recursive: true, force: true });
});

test("mode vocabulary is closed", () => {
	assert.equal(isSandboxMode("off"), true);
	assert.equal(isSandboxMode("read-only"), true);
	assert.equal(isSandboxMode("workspace-write"), true);
	assert.equal(isSandboxMode("danger-full-access"), false);
	assert.equal(isSandboxMode(undefined), false);
	assert.equal(isConfinedMode("off"), false);
	assert.equal(isConfinedMode("read-only"), true);
	assert.equal(modeAllowsWrite("read-only"), false);
	assert.equal(modeAllowsWrite("workspace-write"), true);
	assert.ok(modeRank("off") > modeRank("workspace-write"));
	assert.ok(modeRank("workspace-write") > modeRank("read-only"));
	assert.match(describeMode("off"), /off/);
});

test("isInsideRoot is boundary safe and case-insensitive", () => {
	const base = "C:\\work\\proj";
	assert.equal(isInsideRoot("C:\\work\\proj", base), true);
	assert.equal(isInsideRoot("C:\\WORK\\PROJ\\a.txt", base), true);
	assert.equal(isInsideRoot("C:\\WORK\\PROJ\\", base.replace(/\\$/, "")), true);
	assert.equal(isInsideRoot("C:\\work\\proj-other\\a.txt", base), false);
	assert.equal(isInsideRoot("C:\\work", base), false);
	assert.equal(isInsideRoot("D:\\work\\proj\\a.txt", base), false);
});

test("isInsideRoot handles a drive root", () => {
	assert.equal(isInsideRoot("C:\\anything", "C:\\"), true);
	assert.equal(isInsideRoot("C:\\", "C:\\"), true);
});

test("normalizeTarget resolves relative paths against the base directory", () => {
	const inside = normalizeTarget("sub\\file.txt", root);
	assert.equal(inside.problem, undefined);
	assert.equal(isInsideRoot(inside.path, canonicalDir(root)), true);

	const up = normalizeTarget("..\\escape.txt", root);
	assert.equal(isInsideRoot(up.path, canonicalDir(root)), false);
});

test("normalizeTarget keeps missing parents lexical", () => {
	const target = normalizeTarget("new-dir\\deep\\file.txt", root);
	assert.equal(target.problem, undefined);
	assert.equal(isInsideRoot(target.path, canonicalDir(root)), true);
	assert.ok(target.path.endsWith("new-dir\\deep\\file.txt"));
});

test("normalizeTarget rejects drive-relative paths", () => {
	const target = normalizeTarget("C:temp\\file.txt", root);
	assert.equal(target.problem !== undefined, true);
	assert.match(target.problem, /驱动器相对路径/);
});

test("normalizeTarget unwraps extended-length prefixes", () => {
	const local = normalizeTarget(`\\\\?\\${root}\\x.txt`, root);
	assert.equal(local.problem, undefined);
	assert.equal(local.path.startsWith("\\\\?\\"), false);
	const unc = normalizeTarget("\\\\?\\UNC\\server\\share\\x.txt", root);
	assert.equal(unc.problem, undefined);
	assert.equal(unc.path, "\\\\server\\share\\x.txt");
});

test("normalizeTarget rejects device paths", () => {
	const target = normalizeTarget("\\\\.\\PhysicalDrive0", root);
	assert.match(target.problem ?? "", /设备路径/);
});

test("normalizeTarget accepts spaces and Chinese characters", () => {
	const dir = join(root, "目录 有一 空格");
	mkdirSync(dir, { recursive: true });
	const target = normalizeTarget(join(dir, "文件 名.txt"), root);
	assert.equal(target.problem, undefined);
	assert.equal(isInsideRoot(target.path, canonicalDir(root)), true);
});

test("junction inside the root pointing outside is outside", () => {
	const outside = mkdtempSync(join(tmpdir(), "pidsbx-outside-"));
	try {
		const link = join(root, "jump");
		symlinkSync(outside, link, "junction");
		const verdict = containment("jump\\evil.txt", root, canonicalDir(root));
		assert.equal(verdict.inside, false);
		assert.equal(verdict.reason, undefined);
	} finally {
		rmSync(join(root, "jump"), { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("symlinked directory inside the root pointing inside stays inside", () => {
	const inner = join(root, "inner");
	mkdirSync(inner, { recursive: true });
	symlinkSync(inner, join(root, "inner-link"), "junction");
	try {
		const verdict = containment("inner-link\\ok.txt", root, canonicalDir(root));
		assert.equal(verdict.inside, true);
	} finally {
		rmSync(join(root, "inner-link"), { recursive: true, force: true });
	}
});

test("a UNC target never matches a local root", () => {
	assert.equal(isUncPath("\\\\server\\share\\x"), true);
	assert.equal(isUncPath("C:\\x"), false);
	const verdict = containment("\\\\server\\share\\x.txt", root, canonicalDir(root));
	assert.equal(verdict.inside, false);
	assert.match(verdict.reason ?? "", /UNC/);
});

test("canonicalDir resolves to an absolute real path", () => {
	const canonical = canonicalDir(root);
	assert.equal(canonical.includes(".."), false);
	writeFileSync(join(root, "probe.txt"), "x");
	assert.equal(canonicalDir(root), canonical);
});