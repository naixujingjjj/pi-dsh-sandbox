/** Fast, offline checks for the public source tree and relative documentation links. */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requiredPackageFiles } from "./lib/package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
assert.equal(manifest.version, lock.version, "package and lock versions must match");
assert.equal(manifest.version, lock.packages[""].version);
for (const name of [...requiredPackageFiles, "CONTRIBUTING.md", ".gitignore", ".github/workflows/ci.yml"]) {
	assert.ok(existsSync(join(root, name)), `Missing public project file: ${name}`);
}
assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tgz")), [], "Move release tarballs outside the source tree");
assert.equal(existsSync(join(root, "docs", "research.md")), false);
assert.equal(existsSync(join(root, "docs", "implementation.md")), false);
const files = [];
function walk(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (["node_modules", ".git", ".cache", ".npm"].includes(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) walk(path);
		else files.push(path);
	}
}
walk(root);
let links = 0;
for (const path of files) {
	if (!/\.(?:md|json|ts|mjs|ya?ml)$/.test(path)) continue;
	const text = readFileSync(path, "utf8");
	const normalized = text.replace(/\\\\/g, "\\").replace(/\\/g, "/").toLowerCase();
	const localParent = dirname(root).replace(/\\/g, "/").toLowerCase();
	assert.equal(normalized.includes(`${localParent}/pi-dsh-sandbox`), false, `Local workspace path in ${relative(root, path)}`);
	assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, `Private key in ${relative(root, path)}`);
	if (!path.endsWith(".md")) continue;
	assert.doesNotMatch(text, /[A-Z]:[\\/]+Users[\\/]+[0-9]{3,}/i, `Personal path in ${relative(root, path)}`);
	for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)) {
		const target = match[1].replace(/^<|>$/g, "").split("#")[0];
		if (!target || /^[a-z][\w+.-]*:/i.test(target)) continue;
		assert.equal(isAbsolute(target), false, `Absolute documentation link in ${relative(root, path)}`);
		assert.ok(existsSync(resolve(dirname(path), decodeURIComponent(target))), `Broken link ${match[1]} in ${relative(root, path)}`);
		links += 1;
	}
}
console.log(`PASS public tree, lock consistency, ${files.length} source files and ${links} relative documentation links`);
