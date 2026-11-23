/** Offline check of a release manifest and its matching tarball checksum. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPackageFiles } from "./lib/package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(process.argv[2] ?? join(root, "..", "pi-dsh-sandbox-pkg"));
const current = JSON.parse(readFileSync(join(destination, "latest.json"), "utf8"));
assert.match(current.filename, /^pi-dsh-sandbox-[\w.+-]+\.tgz$/);
const tarball = join(destination, current.filename);
const manifest = JSON.parse(readFileSync(`${tarball}.manifest.json`, "utf8"));
const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
assert.equal(sha256, current.sha256);
assert.equal(sha256, manifest.sha256);
assert.equal(manifest.version, current.version);
assertPackageFiles(manifest.files.map((file) => file.path));
assert.equal(readFileSync(`${tarball}.sha256`, "utf8").trim(), `${sha256}  ${current.filename}`);
console.log(`PASS ${current.filename}: checksum and ${manifest.files.length} manifest entries verified`);
