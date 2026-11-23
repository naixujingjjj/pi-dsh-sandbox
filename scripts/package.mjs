/** Create a release outside the source tree, with a manifest and SHA256 for local verification. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runNpm } from "./lib/npm.mjs";
import { assertPackageFiles } from "./lib/package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 0 && !(args.length === 2 && args[0] === "--out-dir")) {
	throw new Error("Usage: npm run pack -- [--out-dir <directory outside the source tree>]");
}
const destination = resolve(args[1] ?? join(root, "..", "pi-dsh-sandbox-pkg"));
const fromSource = relative(root, destination);
if (!(isAbsolute(fromSource) || fromSource === ".." || fromSource.startsWith(`..${sep}`))) {
	throw new Error("Release output must be outside the source directory.");
}
mkdirSync(destination, { recursive: true });
const [packed] = JSON.parse(runNpm(["pack", "--json", "--pack-destination", destination], { cwd: root }).stdout);
assertPackageFiles(packed.files.map((file) => file.path));
const tarball = join(destination, packed.filename);
const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
writeFileSync(`${tarball}.sha256`, `${sha256}  ${packed.filename}\n`);
writeFileSync(`${tarball}.manifest.json`, JSON.stringify({ ...packed, sha256 }, null, 2) + "\n");

// Updating the current release must not discard previously generated packages.
const previousIndex = join(destination, "latest.json");
if (existsSync(previousIndex)) {
	const previous = JSON.parse(readFileSync(previousIndex, "utf8"));
	if (previous.filename !== packed.filename && /^pi-dsh-sandbox-[\w.+-]+\.tgz$/.test(previous.filename)) {
		const archive = join(destination, "archive");
		mkdirSync(archive, { recursive: true });
		for (const suffix of ["", ".sha256", ".manifest.json"]) {
			const source = join(destination, previous.filename + suffix);
			const target = join(archive, previous.filename + suffix);
			if (existsSync(source) && !existsSync(target)) renameSync(source, target);
		}
	}
}
writeFileSync(previousIndex, JSON.stringify({ version: packed.version, filename: packed.filename, sha256 }, null, 2) + "\n");
console.log(`Created ${tarball}\nSHA256 ${sha256}\nFiles ${packed.files.length}`);
