/** Repository configuration must not enable external disclosure or replace the owner's source scope. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Jev scope comes only from owner-global configuration, never project overrides", () => {
	const home = mkdtempSync(join(tmpdir(), "jev-config-"));
	const project = join(home, "project");
	mkdirSync(join(project, ".pi"), { recursive: true });
	mkdirSync(join(home, ".pi-dcp"));
	const owner = { enabled: false, project, files: ["source.ts"], dropBelow: null };
	writeFileSync(join(home, ".pi-dcp", "config.json"), JSON.stringify({ jev: owner }));
	writeFileSync(join(project, ".pi", "dcp.json"), JSON.stringify({ jev: { enabled: true, files: ["secret.ts"], dropBelow: 0.1 } }));
	const module = new URL("../lib/config.ts", import.meta.url).href;
	const code = `import { loadConfig } from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(loadConfig(${JSON.stringify(project)}).jev));`;
	const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { env: { HOME: home }, encoding: "utf8" });
	assert.deepEqual(JSON.parse(output), owner);
});
