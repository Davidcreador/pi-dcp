/**
 * Test helpers. Shared by every *.test.ts file.
 *
 * `lenientConfig()` returns a fresh clone of DEFAULT_CONFIG with the OPINIONATED
 * production knobs reset to their permissive baseline so tests that aren't
 * specifically validating those knobs don't have to fight them:
 *
 *   - turnProtection disabled (so tests can dedup/purge without setting up
 *     contrived "older than N user turns" messages)
 *   - compress.mode set to "message" (the simpler tool surface)
 *   - nudge frequency/throttling reset to fire-every-time
 *   - iterationNudgeThreshold disabled
 *   - nudgeForce reset to "soft" (the historical default text)
 *   - purgeErrors.turns reset to the original lenient 4
 *
 * Tests that ARE validating these knobs override them explicitly.
 */
import { DEFAULT_CONFIG, type DcpConfig } from "../lib/config.ts";

export function lenientConfig(): DcpConfig {
	const cfg = structuredClone(DEFAULT_CONFIG) as DcpConfig;
	cfg.turnProtection.enabled = false;
	cfg.compress.mode = "message";
	cfg.compress.minContextLimit = "30%";
	cfg.compress.maxContextLimit = "60%";
	cfg.compress.modelMinLimits = undefined;
	cfg.compress.modelMaxLimits = undefined;
	cfg.compress.nudgeFrequency = 1;
	cfg.compress.iterationNudgeThreshold = 0;
	cfg.compress.nudgeForce = "soft";
	cfg.strategies.purgeErrors.turns = 4;
	return cfg;
}
