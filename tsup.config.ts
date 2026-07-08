import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	target: "node18",
	platform: "node",
	banner: { js: "#!/usr/bin/env node" },
	clean: true,
	minify: false,
	dts: false,
	// @clack/prompts, execa and picocolors are dependencies installed alongside
	// the CLI, so leave them external rather than bundling.
	external: ["@clack/prompts", "execa", "picocolors"],
});
