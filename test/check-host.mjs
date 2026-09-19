/** Exercise the installed host's real loader aliases; run in a credential-free, network-isolated environment. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

assert.ok(process.argv[2], "Usage: node test/check-host.mjs <installed-pi-package-directory>");
const host = resolve(process.argv[2]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = mkdtempSync(join(tmpdir(), "pi-dcp-host-"));
const version = JSON.parse(readFileSync(join(host, "package.json"), "utf8")).version;
const loader = pathToFileURL(join(host, "dist/core/extensions/loader.js")).href;
const tests = readdirSync(join(root, "test")).filter(name => name.endsWith(".test.ts")).sort();
console.log(JSON.stringify({ host, version, artifacts, tests: tests.length }));
for (const target of ["index.ts", ...tests.map(name => `test/${name}`)]) {
	const directory = join(artifacts, target.replaceAll("/", "-"));
	mkdirSync(directory);
	const home = join(directory, "home");
	mkdirSync(home);
	const extension = join(directory, "extension.ts");
	writeFileSync(extension, target === "index.ts"
		? `export { default } from ${JSON.stringify(join(root, target))};\n`
		: `import ${JSON.stringify(join(root, target))};\nexport default function () {}\n`);
	const runner = join(directory, "runner.mjs");
	writeFileSync(runner, `
import assert from "node:assert/strict";
import { loadExtensions, clearExtensionCache } from ${JSON.stringify(loader)};
globalThis.fetch = async () => { throw new Error("Network forbidden in host checks"); };
const loaded = await loadExtensions([${JSON.stringify(extension)}], process.cwd());
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
${target === "index.ts" ? `
const extension = loaded.extensions[0];
assert.ok(extension.commands.has("dcp"));
assert.ok(extension.handlers.has("context"));
let notice;
await extension.commands.get("dcp").handler("jev stats", { ui: { notify: message => { notice = message; } } });
const stats = JSON.parse(notice);
assert.equal(stats.mode, "disabled");
assert.equal(stats.configurationValid, true);
assert.equal(stats.attempts, 0);
const { SessionManager } = await import(${JSON.stringify(pathToFileURL(join(host, "dist/index.js")).href)});
const { exerciseHost } = await import(${JSON.stringify(pathToFileURL(join(root, "test/host-integration.mjs")).href)});
const reload = async () => {
	clearExtensionCache();
	return loadExtensions([${JSON.stringify(extension)}], process.cwd());
};
for (const savedActive of [false, true]) {
	await exerciseHost(await reload(), SessionManager.inMemory(process.cwd()), reload, savedActive);
}
` : ""}
`);
	const result = spawnSync(process.execPath, ["--test", runner], {
		cwd: home, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi/agent"), JITI_FS_CACHE: "false" },
		encoding: "utf8", timeout: 60000, maxBuffer: 1048576,
	});
	writeFileSync(join(directory, "result.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`);
	process.stdout.write(`${target}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${target}: host-loader tests failed`);
}
