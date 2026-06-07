#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = packageJson.version;
const releaseDir = join(root, "release");
const expectedExe = `Clawd-Companion-Setup-${version}.exe`;
const expectedBlockmap = `${expectedExe}.blockmap`;
const latestPath = join(releaseDir, "latest.yml");
const exePath = join(releaseDir, expectedExe);
const blockmapPath = join(releaseDir, expectedBlockmap);

if (!existsSync(exePath)) {
  fail(`Missing installer: release/${expectedExe}`);
}

if (!existsSync(blockmapPath)) {
  fail(`Missing blockmap: release/${expectedBlockmap}`);
}

if (!existsSync(latestPath)) {
  fail("Missing release/latest.yml");
}

const latest = readFileSync(latestPath, "utf8");
const urlMatch = latest.match(/^\s*-?\s*url:\s*(.+)$/m);
const pathMatch = latest.match(/^path:\s*(.+)$/m);
const latestVersionMatch = latest.match(/^version:\s*(.+)$/m);

if (!latestVersionMatch || latestVersionMatch[1].trim() !== version) {
  fail(`latest.yml version mismatch: expected ${version}`);
}

if (!urlMatch || urlMatch[1].trim() !== expectedExe) {
  fail(`latest.yml url mismatch: expected ${expectedExe}`);
}

if (!pathMatch || pathMatch[1].trim() !== expectedExe) {
  fail(`latest.yml path mismatch: expected ${expectedExe}`);
}

console.log(`Validated release artifacts for ${version}: ${expectedExe}`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
