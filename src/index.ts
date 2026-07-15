import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { execa } from "execa";
import pc from "picocolors";
import { HELP_TEXT, parseCliArgs } from "./args.js";
import { assemble } from "./engine.js";
import {
	availableLocales,
	availableModules,
	DEFAULT_LOCALES,
	defaultModules,
	type KitJson,
	LOCALE_LABELS,
	readKit,
	resolveModules,
} from "./kit.js";
import {
	AccessError,
	checkAccess,
	cloneTemplate,
	LOCAL_TEMPLATE,
	TEMPLATE_REPO,
	templateCommit,
} from "./template.js";

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Cleanup for the temp clone; module-scoped so cancel()/signals can run it too. */
let cleanup: (() => void) | undefined;
function runCleanup() {
	try {
		cleanup?.();
	} catch {
		// best effort
	}
	cleanup = undefined;
}

// process.exit (via cancel) and signals skip finally blocks, clean up here.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		runCleanup();
		process.exit(130);
	});
}

function pkgVersion(): string {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function validateName(name: string): string | undefined {
	if (!NAME_RE.test(name))
		return "Use lowercase letters, digits and dashes; must start with a letter.";
	return undefined;
}

function dirIsUsable(dir: string): boolean {
	return !existsSync(dir) || readdirSync(dir).length === 0;
}

/** Seed .dev.vars from each workspace's .dev.vars.example so cf-typegen/dev work. */
function seedDevVars(outDir: string) {
	for (const group of ["apps", "packages"]) {
		const groupDir = join(outDir, group);
		if (!existsSync(groupDir)) continue;
		for (const ws of readdirSync(groupDir)) {
			const example = join(groupDir, ws, ".dev.vars.example");
			const target = join(groupDir, ws, ".dev.vars");
			if (existsSync(example) && !existsSync(target)) copyFileSync(example, target);
		}
	}
}

async function hasBun(): Promise<boolean> {
	try {
		await execa("bun", ["--version"]);
		return true;
	} catch {
		return false;
	}
}

function cancel(message: string): never {
	runCleanup();
	p.cancel(message);
	process.exit(1);
}

async function main() {
	const args = parseCliArgs(process.argv.slice(2));

	if (args.help) {
		console.log(HELP_TEXT);
		return;
	}
	if (args.version) {
		console.log(pkgVersion());
		return;
	}

	const repo = args.repo ?? TEMPLATE_REPO;
	const localTemplate = args.template ?? LOCAL_TEMPLATE;

	console.log("");
	p.intro(pc.bgMagenta(pc.black(" 🌷 create-kavel ")));

	// --- project name ---
	let projectName: string;
	if (args.name) {
		const err = validateName(args.name);
		if (err) cancel(`Invalid project name "${args.name}": ${err}`);
		projectName = args.name;
	} else if (args.yes) {
		projectName = "my-kavel-app";
		p.log.info(`No name given, using ${pc.cyan(projectName)}.`);
	} else {
		const answer = await p.text({
			message: "Project name?",
			placeholder: "my-kavel-app",
			defaultValue: "my-kavel-app",
			validate: (v) => (v ? validateName(v) : undefined),
		});
		if (p.isCancel(answer)) cancel("Cancelled.");
		projectName = (answer || "my-kavel-app").trim();
	}

	const outDir = resolve(process.cwd(), projectName);
	if (!dirIsUsable(outDir))
		cancel(`Directory ${pc.cyan(projectName)} already exists and isn't empty.`);

	// --- acquire template ---
	let templateDir: string;

	if (localTemplate) {
		templateDir = isAbsolute(localTemplate) ? localTemplate : resolve(process.cwd(), localTemplate);
		if (!existsSync(join(templateDir, "kit.json"))) {
			cancel(`No kit.json found in template dir ${pc.cyan(templateDir)}.`);
		}
	} else {
		const s = p.spinner();
		s.start("Checking kit access");
		try {
			await checkAccess(repo);
		} catch (err) {
			s.stop("No access to the Kavel template");
			if (err instanceof AccessError) cancel(err.message);
			throw err;
		}
		s.stop("Access confirmed");

		const s2 = p.spinner();
		s2.start("Fetching template");
		try {
			const cloned = await cloneTemplate(repo);
			templateDir = cloned.dir;
			cleanup = cloned.cleanup;
		} catch (err) {
			s2.stop("Couldn't fetch the template");
			throw err;
		}
		s2.stop("Template fetched");
	}

	try {
		const kit: KitJson = readKit(templateDir);

		// --- module selection ---
		let requested: string[];
		if (args.modules !== undefined) {
			requested = args.modules;
		} else if (args.yes) {
			requested = defaultModules(kit);
		} else {
			const available = availableModules(kit);
			const selection = await p.multiselect({
				message: "Which modules? (space to toggle, enter to confirm)",
				options: available.map((name) => ({
					value: name,
					label: name,
					hint: kit.modules[name].description,
				})),
				initialValues: defaultModules(kit),
				required: false,
			});
			if (p.isCancel(selection)) cancel("Cancelled.");
			requested = selection as string[];
		}

		let ordered: string[];
		try {
			ordered = resolveModules(kit, requested);
		} catch (err) {
			cancel(err instanceof Error ? err.message : String(err));
		}

		const autoAdded = ordered.filter((m) => !requested.includes(m));
		if (autoAdded.length)
			p.log.info(`Added required dependencies: ${pc.cyan(autoAdded.join(", "))}`);
		p.log.step(`Modules: ${ordered.length ? pc.cyan(ordered.join(", ")) : pc.dim("(base only)")}`);

		// --- language selection (i18n only) ---
		let locales: string[] | undefined;
		if (ordered.includes("i18n")) {
			const available = availableLocales(templateDir);
			if (available.length) {
				if (args.locales !== undefined) {
					const unknown = args.locales.filter((l) => !available.includes(l));
					if (unknown.length)
						cancel(
							`Unknown language(s): ${unknown.join(", ")}. Available: ${available.join(", ")}`,
						);
					locales = args.locales; // caller's order, first is the base locale
				} else if (args.yes) {
					locales = DEFAULT_LOCALES.filter((l) => available.includes(l));
				} else {
					const selection = await p.multiselect({
						message: "Which languages? (space to toggle, enter to confirm)",
						options: available.map((code) => ({
							value: code,
							label: LOCALE_LABELS[code] ?? code,
							hint: code,
						})),
						initialValues: DEFAULT_LOCALES.filter((l) => available.includes(l)),
						required: true,
					});
					if (p.isCancel(selection)) cancel("Cancelled.");
					// Normalize to available order (English first) so the base is deterministic.
					locales = available.filter((l) => (selection as string[]).includes(l));
				}
				if (locales?.length)
					p.log.step(
						`Languages: ${pc.cyan(locales.map((l) => LOCALE_LABELS[l] ?? l).join(", "))} ${pc.dim(`(base: ${locales[0]})`)}`,
					);
			}
		} else if (args.locales !== undefined) {
			p.log.warn("--locales ignored (i18n module not selected).");
		}

		// --- assemble ---
		const commit = await templateCommit(templateDir);
		const s = p.spinner();
		s.start(`Assembling ${pc.cyan(projectName)}`);
		let nextSteps: string[];
		try {
			({ nextSteps } = assemble({
				templateDir,
				outDir,
				projectName,
				modules: ordered,
				locales,
				kit,
				templateCommit: commit,
			}));
		} catch (err) {
			s.stop("Assembly failed");
			// Roll back the partially-written project so a retry isn't blocked.
			rmSync(outDir, { recursive: true, force: true });
			throw err;
		}
		s.stop(`Assembled ${pc.cyan(projectName)}`);

		// --- install ---
		let doInstall = args.install;
		if (doInstall === undefined) {
			if (args.yes) {
				doInstall = true;
			} else {
				const answer = await p.confirm({
					message: "Install dependencies with bun?",
					initialValue: true,
				});
				if (p.isCancel(answer)) cancel("Cancelled.");
				doInstall = answer;
			}
		}

		let installed = false;
		if (doInstall) {
			if (await hasBun()) {
				const s2 = p.spinner();
				s2.start("Installing dependencies (bun install)");
				try {
					await execa("bun", ["install"], { cwd: outDir });
					installed = true;
					s2.stop("Dependencies installed");
				} catch {
					s2.stop("bun install failed, run it yourself later");
				}
			} else {
				p.log.warn(
					"bun not found, skipping install. Install bun (https://bun.sh) then run `bun install`.",
				);
			}
		}

		if (installed) {
			// Seed .dev.vars and generate Cloudflare types so the scaffold typechecks
			// and runs before the user has filled in any secrets.
			seedDevVars(outDir);
			const s3 = p.spinner();
			s3.start("Generating types");
			try {
				await execa("bun", ["run", "cf-typegen"], { cwd: outDir });
				s3.stop("Types generated");
			} catch {
				s3.stop("Skipped type generation (run `bun cf-typegen` later)");
			}

			// Marker injections leave imports out of order and a stray `export {};`;
			// biome --write repairs them so the scaffold is clean on first `bun check`.
			const s4 = p.spinner();
			s4.start("Formatting");
			try {
				await execa("bun", ["run", "check"], { cwd: outDir });
				s4.stop("Formatted");
			} catch {
				s4.stop("Skipped formatting (run `bun check` later)");
			}
		}

		// --- git ---
		if (args.git !== false) {
			try {
				await execa("git", ["init"], { cwd: outDir });
				await execa("git", ["add", "-A"], { cwd: outDir });
				await execa("git", ["commit", "-m", "Initial commit from Kavel"], {
					cwd: outDir,
					env: {
						GIT_AUTHOR_NAME: "Kavel",
						GIT_AUTHOR_EMAIL: "noreply@createkavel.com",
						GIT_COMMITTER_NAME: "Kavel",
						GIT_COMMITTER_EMAIL: "noreply@createkavel.com",
					},
				});
				p.log.step("Initialized git repository");
			} catch {
				p.log.warn("git init failed, skipped.");
			}
		}

		// --- outro ---
		const steps: string[] = [`${pc.cyan("cd")} ${projectName}`];
		if (!installed) steps.push(pc.cyan("bun install"));
		for (const line of nextSteps) steps.push(pc.dim(line));
		steps.push(pc.cyan("bun dev"));
		p.note(steps.join("\n"), "Next steps");
		p.outro(`Done! Built ${pc.magenta(projectName)} 🌷`);
	} finally {
		runCleanup();
	}
}

main().catch((err) => {
	runCleanup();
	p.log.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
