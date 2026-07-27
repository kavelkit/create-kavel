import { parseArgs } from "node:util";

export interface CliArgs {
	/** Positional project name / target directory, if given. */
	name?: string;
	/** Skip prompts, take defaults (or --modules). */
	yes: boolean;
	/** Explicit module list ("auth,email"); undefined = not passed. */
	modules?: string[];
	/** Explicit locale list ("en,de"; first = base) for i18n; undefined = not passed. */
	locales?: string[];
	install?: boolean;
	git?: boolean;
	/** Local template dir override (skips clone). */
	template?: string;
	/** Template repo override. */
	repo?: string;
	help: boolean;
	version: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
	try {
		const { values, positionals } = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				yes: { type: "boolean", short: "y", default: false },
				modules: { type: "string" },
				locales: { type: "string" },
				// --install force-runs install without the confirm prompt; --no-install skips it.
				install: { type: "boolean" },
				"no-install": { type: "boolean" },
				"no-git": { type: "boolean" },
				template: { type: "string" },
				repo: { type: "string" },
				help: { type: "boolean", short: "h", default: false },
				version: { type: "boolean", short: "v", default: false },
			},
		});

		return {
			name: positionals[0],
			yes: values.yes,
			modules:
				values.modules === undefined
					? undefined
					: values.modules
							.split(",")
							.map((m) => m.trim())
							.filter(Boolean),
			locales:
				values.locales === undefined
					? undefined
					: values.locales
							.split(",")
							.map((l) => l.trim())
							.filter(Boolean),
			install: values["no-install"] ? false : values.install ? true : undefined,
			git: values["no-git"] ? false : undefined,
			template: values.template,
			repo: values.repo,
			help: values.help,
			version: values.version,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`${msg}\nRun with --help to see available options.`);
	}
}

export const HELP_TEXT = `
create-kavel, scaffold a full-stack Cloudflare app

Usage:
  bun create kavel [name] [options]
  npm create kavel@latest [name] [options]

Options:
  -y, --yes             Skip prompts; use defaults (or --modules)
      --modules a,b,c   Modules to include (auth, payments, email, i18n, ui, marketing-pages)
      --locales en,de   Languages for i18n (first is the base/fallback)
      --no-install      Don't run the install step
      --no-git          Don't initialize a git repository
      --template <dir>  Use a local template checkout instead of cloning
      --repo <url>      Override the template repo URL
  -h, --help            Show this help
  -v, --version         Show the version
`;
