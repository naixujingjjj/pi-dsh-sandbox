/**
 * Build (or verify) the vendored patched Windows ACL runner.
 *
 * Delivery must not depend on a hand-edited `node_modules`: `npm ci`, `npm pack` and a clean install
 * all throw such edits away. This script produces a reviewable in-repo build instead:
 *
 *   upstream npm tarball (pinned version + SHA-256) -> extract src/ -> apply patches/ -> tsc -> lib/
 *
 * `PROVENANCE.json` records the input tarball, the patch hashes, the compiler version and the
 * SHA-256 of every committed file, so the shipped runner can be audited without rebuilding.
 *
 * Usage:
 *   node scripts/build-vendor-runner.mjs [--tarball <path to upstream .tgz>]
 *   node scripts/build-vendor-runner.mjs --check
 *
 * `--check` is offline: it re-hashes the committed tree against PROVENANCE.json. `--tarball` skips
 * the npm download (a tarball already on disk, still hash-checked).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCliPath, runInherited } from "./lib/npm.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = join(pluginRoot, "vendor", "dsh-sandbox-windows-acl");
const pinPath = join(vendorRoot, "pin.json");
const provenancePath = join(vendorRoot, "PROVENANCE.json");
const tscPath = join(pluginRoot, "node_modules", "typescript", "bin", "tsc");

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Every file under `root`, as POSIX-style paths relative to it (sorted). */
function listFiles(root, skip = () => false) {
	const found = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			const rel = relative(root, path).split(sep).join("/");
			if (skip(rel, entry)) continue;
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) found.push(rel);
		}
	};
	if (existsSync(root)) walk(root);
	return found.sort();
}

// --- unified diff application (the subset `git diff` emits for text patches) ------------------

function splitFileLines(text) {
	return text.split("\n");
}

function applyHunks(target, original, hunks, context) {
	const source = splitFileLines(original);
	const output = [];
	let cursor = 0;
	for (const hunk of hunks) {
		const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
		if (start < cursor || start > source.length) throw new Error(`${context}: hunk starts outside the file`);
		while (cursor < start) output.push(source[cursor++]);
		let consumed = 0;
		let produced = 0;
		for (const line of hunk.lines) {
			const tag = line[0];
			const body = line.slice(1);
			if (tag === " ") {
				if (source[cursor] !== body) throw new Error(`${context}: context mismatch at source line ${cursor + 1}`);
				output.push(body);
				cursor++;
				consumed++;
				produced++;
			} else if (tag === "-") {
				if (source[cursor] !== body) throw new Error(`${context}: removal mismatch at source line ${cursor + 1}`);
				cursor++;
				consumed++;
			} else if (tag === "+") {
				output.push(body);
				produced++;
			} else {
				throw new Error(`${context}: unexpected patch line ${JSON.stringify(line)}`);
			}
		}
		if (hunk.oldCount !== null && consumed !== hunk.oldCount) throw new Error(`${context}: hunk removed ${consumed}, header says ${hunk.oldCount}`);
		if (hunk.newCount !== null && produced !== hunk.newCount) throw new Error(`${context}: hunk produced ${produced}, header says ${hunk.newCount}`);
	}
	while (cursor < source.length) output.push(source[cursor++]);
	return output.join("\n");
}

/**
 * Apply a `git diff` patch to `files` (a Map of POSIX relative path -> text), mutating it.
 * @param {string} patchText - the patch contents.
 * @param {Map<string, string>} files - package-relative file contents.
 */
function applyPatch(patchText, files) {
	const lines = patchText.replace(/\r\n/g, "\n").split("\n");
	let index = 0;
	while (index < lines.length) {
		if (!lines[index].startsWith("diff --git ")) {
			index++;
			continue;
		}
		index++;
		let newPath = null;
		while (index < lines.length && !lines[index].startsWith("@@")) {
			if (lines[index].startsWith("+++ ")) newPath = lines[index].slice(4).split("\t")[0];
			index++;
		}
		if (newPath === null) throw new Error("patch section without a +++ header");
		const target = newPath.replace(/^b\//, "");
		if (!files.has(target)) throw new Error(`patch targets a file that is not in the package: ${target}`);
		const hunks = [];
		while (index < lines.length && lines[index].startsWith("@@")) {
			const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index]);
			if (!header) throw new Error(`bad hunk header: ${lines[index]}`);
			const hunk = {
				oldStart: Number(header[1]),
				oldCount: header[2] === undefined ? 1 : Number(header[2]),
				newStart: Number(header[3]),
				newCount: header[4] === undefined ? 1 : Number(header[4]),
				lines: [],
			};
			index++;
			while (index < lines.length && !lines[index].startsWith("@@") && !lines[index].startsWith("diff --git ")) {
				const line = lines[index];
				if (line === "") {
					// A trailing blank line from the final newline is not a patch line.
					index++;
					continue;
				}
				if (line.startsWith("\\")) {
					index++;
					continue;
				}
				hunk.lines.push(line);
				index++;
			}
			hunks.push(hunk);
		}
		files.set(target, applyHunks(target, files.get(target), hunks, target));
	}
}

// --- verification ------------------------------------------------------------------------------

function readPins() {
	const pin = JSON.parse(readFileSync(pinPath, "utf8"));
	assert.match(pin.package, /^@deepseek-ai\/dsh-sandbox-windows-acl$/, "pin.json names another package");
	assert.match(pin.upstreamVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "pin.json needs a pinned upstream version");
	assert.match(pin.upstreamTarballSha256, /^[0-9a-f]{64}$/, "pin.json needs the upstream tarball SHA-256");
	assert.ok(Array.isArray(pin.patches) && pin.patches.length > 0, "pin.json needs at least one patch");
	for (const patch of pin.patches) {
		assert.match(patch.sha256, /^[0-9a-f]{64}$/, `pin.json needs a SHA-256 for ${patch.file}`);
		const path = join(vendorRoot, patch.file);
		assert.equal(existsSync(path), true, `patch is missing: ${patch.file}`);
		assert.equal(sha256File(path), patch.sha256, `patch was edited without updating pin.json: ${patch.file}`);
	}
	return pin;
}

function verifyCommitted() {
	const pin = readPins();
	assert.equal(existsSync(provenancePath), true, "PROVENANCE.json is missing; run `npm run vendor:build`");
	const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
	assert.equal(provenance.package, pin.package);
	assert.equal(provenance.upstreamVersion, pin.upstreamVersion);
	assert.equal(provenance.upstreamTarballSha256, pin.upstreamTarballSha256);
	assert.deepEqual(provenance.patches, pin.patches);
	const outputs = provenance.outputs ?? {};
	const actual = listFiles(vendorRoot, (rel) => rel === "PROVENANCE.json").filter((rel) => rel !== "pin.json");
	const recorded = Object.keys(outputs).sort();
	const unexpected = actual.filter((rel) => !recorded.includes(rel));
	const missing = recorded.filter((rel) => !existsSync(join(vendorRoot, rel)));
	assert.deepEqual(unexpected, [], `unrecorded files in vendor/ (rebuild): ${unexpected.join(", ")}`);
	assert.deepEqual(missing, [], `PROVENANCE.json lists missing files: ${missing.join(", ")}`);
	const mismatched = recorded.filter((rel) => sha256File(join(vendorRoot, rel)) !== outputs[rel]);
	assert.deepEqual(mismatched, [], `vendored files edited without rebuilding: ${mismatched.join(", ")}`);
	for (const path of ["lib/runner.js", "lib/index.js", "src/acl.ts", "src/win32-abi.ts", "LICENSE", "package.json"]) {
		assert.equal(recorded.includes(path), true, `PROVENANCE.json is missing ${path}`);
	}
	const manifest = JSON.parse(readFileSync(join(vendorRoot, "package.json"), "utf8"));
	assert.equal(manifest.type, "module", "the vendored package must stay an ES module");
	assert.equal(manifest.private, true, "the vendored copy must never be publishable");
	assert.equal(manifest.piDshSandbox?.vendored, true, "the vendored copy must identify itself");
	assert.equal(manifest.name, pin.package);
	assert.match(manifest.version, new RegExp(`^${pin.upstreamVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\+pi-dsh\\.\\d+$`));
	console.log(`PASS  vendor: ${recorded.length} files match PROVENANCE.json (${provenance.build?.typescriptVersion ?? "typescript ?"}); pin ${pin.package}@${pin.upstreamVersion}`);
}

// --- build -------------------------------------------------------------------------------------

function extractTarball(tarball, destination) {
	runInherited("tar", ["-xzf", tarball, "-C", destination]);
}

function vendorManifest(upstream, pin) {
	const suffix = pin.vendoredVersionSuffix ?? "+pi-dsh.1";
	return {
		name: upstream.name,
		version: `${upstream.version}${suffix}`,
		private: true,
		description: upstream.description,
		type: "module",
		main: "lib/index.js",
		exports: {
			".": "./lib/index.js",
			"./runner": "./lib/runner.js",
			"./package.json": "./package.json",
		},
		files: ["lib", "src", "LICENSE", "PROVENANCE.json", "PATCH.md", "pin.json", "patches"],
		license: upstream.license,
		repository: upstream.repository,
		piDshSandbox: {
			vendored: true,
			upstream: `${upstream.name}@${upstream.version}`,
			upstreamTarballSha256: pin.upstreamTarballSha256,
			patches: pin.patches.map((patch) => patch.file),
			note: "Local build of the MIT upstream package with the low-label write guard and ACL walk bounds; the upstream release does not include it.",
		},
	};
}

function build(tarballOverride) {
	const pin = readPins();
	rmSync(provenancePath, { force: true });
	const work = mkdtempSync(join(tmpdir(), "pidsbx-vendor-"));
	try {
		// --- input tarball -------------------------------------------------------------------
		let tarball = tarballOverride;
		if (tarball) {
			assert.equal(existsSync(tarball), true, `tarball not found: ${tarball}`);
		} else {
			runInherited(process.execPath, [npmCliPath(), "pack", `${pin.package}@${pin.upstreamVersion}`, "--pack-destination", work], { cwd: pluginRoot });
			const downloaded = readdirSync(work).filter((name) => name.endsWith(".tgz"));
			assert.equal(downloaded.length, 1, "npm pack did not produce exactly one tarball");
			tarball = join(work, downloaded[0]);
		}
		const tarballHash = sha256File(tarball);
		assert.equal(tarballHash, pin.upstreamTarballSha256, `upstream tarball SHA-256 mismatch: got ${tarballHash}`);
		console.log(`PASS  upstream tarball ${pin.package}@${pin.upstreamVersion} sha256 ${tarballHash}`);

		// --- extract + patch -----------------------------------------------------------------
		const extract = join(work, "extract");
		mkdirSync(extract);
		extractTarball(tarball, extract);
		const pkg = join(extract, "package");
		const upstream = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
		assert.equal(upstream.name, pin.package);
		assert.equal(upstream.version, pin.upstreamVersion, "the tarball is not the pinned version");

		const srcFiles = listFiles(join(pkg, "src")).map((rel) => `src/${rel}`);
		assert.ok(srcFiles.includes("src/acl.ts") && srcFiles.includes("src/win32-abi.ts"), "the tarball carries no patched sources");
		const files = new Map(srcFiles.map((rel) => [rel, readFileSync(join(pkg, ...rel.split("/")), "utf8")]));
		for (const patch of pin.patches) {
			applyPatch(readFileSync(join(vendorRoot, patch.file), "utf8"), files);
			console.log(`PASS  applied ${patch.file}`);
		}

		// --- vendor sources + licence ---------------------------------------------------------
		rmSync(join(vendorRoot, "src"), { recursive: true, force: true });
		for (const [rel, text] of files) {
			const destination = join(vendorRoot, ...rel.split("/"));
			mkdirSync(dirname(destination), { recursive: true });
			writeFileSync(destination, text);
		}
		copyFileSync(join(pkg, "LICENSE"), join(vendorRoot, "LICENSE"));
		const manifest = vendorManifest(upstream, pin);
		writeFileSync(join(vendorRoot, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

		// --- compile -------------------------------------------------------------------------
		assert.equal(existsSync(tscPath), true, "TypeScript is not installed; run `npm ci --include=dev` first");
		for (const [rel, text] of files) writeFileSync(join(pkg, ...rel.split("/")), text);
		writeFileSync(join(pkg, "tsconfig.vendor.json"), JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				rewriteRelativeImportExtensions: true,
				allowImportingTsExtensions: true,
				skipLibCheck: true,
				noCheck: true,
				strict: true,
				declaration: false,
				sourceMap: false,
				rootDir: "src",
				outDir: "lib-vendor",
				newLine: "lf",
			},
			include: ["src"],
		}, null, 2) + "\n");
		const tsc = runInherited(process.execPath, [tscPath, "-p", join(pkg, "tsconfig.vendor.json")]);
		const emitted = listFiles(join(pkg, "lib-vendor"));
		for (const required of ["index.js", "runner.js", "acl.js", "ffi.js", "win32-abi.js"]) {
			assert.equal(emitted.includes(required), true, `tsc did not emit lib/${required}`);
		}
		rmSync(join(vendorRoot, "lib"), { recursive: true, force: true });
		for (const rel of emitted) {
			const destination = join(vendorRoot, "lib", ...rel.split("/"));
			mkdirSync(dirname(destination), { recursive: true });
			copyFileSync(join(pkg, "lib-vendor", rel), destination);
		}
		const typescriptVersion = JSON.parse(readFileSync(join(pluginRoot, "node_modules", "typescript", "package.json"), "utf8")).version;

		// --- provenance ----------------------------------------------------------------------
		const outputs = {};
		for (const rel of listFiles(vendorRoot, (candidate) => candidate === "PROVENANCE.json" || candidate === "pin.json")) {
			outputs[rel] = sha256File(join(vendorRoot, rel));
		}
		const provenance = {
			package: pin.package,
			upstreamVersion: pin.upstreamVersion,
			upstreamTarballSha256: pin.upstreamTarballSha256,
			license: pin.license,
			vendoredVersion: manifest.version,
			patches: pin.patches,
			build: {
				script: "scripts/build-vendor-runner.mjs",
				typescriptVersion,
				command: `node node_modules/typescript/bin/tsc -p tsconfig.vendor.json`,
				tsconfig: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					rewriteRelativeImportExtensions: true,
					allowImportingTsExtensions: true,
					noCheck: true,
					declaration: false,
					sourceMap: false,
				},
			},
			outputs,
		};
		writeFileSync(provenancePath, JSON.stringify(provenance, null, 2) + "\n");
		console.log(`PASS  rebuilt vendor/ (${Object.keys(outputs).length} files) and wrote PROVENANCE.json`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

const args = process.argv.slice(2);
if (args.includes("--check")) {
	verifyCommitted();
} else if (args.length === 0 || (args.length === 2 && args[0] === "--tarball")) {
	build(args.length === 2 ? resolve(args[1]) : undefined);
} else {
	throw new Error("Usage: node scripts/build-vendor-runner.mjs [--check | --tarball <upstream .tgz>]");
}