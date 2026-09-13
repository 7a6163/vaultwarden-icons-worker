import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Set only while Stryker is verifying a mutant (see test/stryker-setup.ts).
const mutantId = process.env.__STRYKER_ACTIVE_MUTANT__ ?? null;

export default defineWorkersConfig({
	define: {
		__STRYKER_MUTANT_ID__: JSON.stringify(mutantId),
	},
	test: {
		setupFiles: mutantId === null ? [] : ["./test/stryker-setup.ts"],
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
			},
		},
		coverage: {
			// v8 coverage is unavailable inside workerd; istanbul instruments source.
			provider: "istanbul",
			include: ["src/**/*.ts"],
			// lcov is what Codecov reads; text keeps the summary in the CI log.
			reporter: ["text", "lcov"],
			thresholds: {
				lines: 100,
				functions: 100,
				branches: 100,
				statements: 100,
			},
		},
	},
});
