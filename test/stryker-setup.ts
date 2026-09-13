// Stryker activates a mutant by setting __STRYKER_ACTIVE_MUTANT__ in the env of
// the test process. Instrumented code reads it via `process.env`, which does not
// exist inside workerd — so vitest.config.ts injects the id at build time and we
// hand it to the instrumentation's global namespace before any source is loaded.
declare const __STRYKER_MUTANT_ID__: string | null;

if (typeof __STRYKER_MUTANT_ID__ === "string") {
	(globalThis as { __stryker__?: { activeMutant?: string } }).__stryker__ = {
		activeMutant: __STRYKER_MUTANT_ID__,
	};
}
