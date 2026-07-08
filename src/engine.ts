import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { KitJson } from "./kit.js";

/** Local dev artifacts that may sit in the template working tree — never scaffolded. */
const COPY_EXCLUDE = new Set([
	".DS_Store",
	".git",
	".wrangler",
	"node_modules",
	".turbo",
	".output",
	".tanstack",
	"dist",
]);

/**
 * Real local secret files that must never be copied into a scaffold (they may be
 * present on the --template/KAVEL_TEMPLATE_DIR path). `.example` templates are kept.
 */
function isSecretFile(name: string): boolean {
	if (name.endsWith(".example")) return false;
	return (
		name === ".dev.vars" || name === ".env" || name.startsWith(".env.") || name.endsWith(".env")
	);
}

/** Text file extensions, plus dotfiles, that get PROJECT_NAME substitution. */
const TEXT_EXT = /\.(ts|tsx|js|jsx|json|jsonc|md|css|html|txt|example|yml|yaml|toml)$/;
const TEXT_DOTFILE = new Set([".gitignore", ".dev.vars.example"]);

function isTextFile(path: string): boolean {
	return TEXT_EXT.test(path) || TEXT_DOTFILE.has(basename(path));
}

interface Manifest {
	name: string;
	requires?: string[];
	packageJson?: Record<string, Record<string, unknown>>;
	wrangler?: Record<string, Record<string, unknown>>;
	env?: Record<string, { name: string; example?: string; comment?: string }[]>;
	combined?: Record<string, string>;
	nextSteps?: string[];
	notes?: string[];
}

interface PatchSection {
	marker: string;
	snippet: string;
}

export interface AssembleOptions {
	templateDir: string;
	outDir: string;
	projectName: string;
	/** Modules in dependency-first order (see resolveModules). */
	modules: string[];
	kit: KitJson;
	/** Commit SHA of the template the scaffold was built from (for kit.lock). */
	templateCommit?: string;
}

export interface AssembleResult {
	/** Next-step lines, prefixed by module, PROJECT_NAME already substituted. */
	nextSteps: string[];
}

function walkFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === ".DS_Store") continue;
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) out.push(...walkFiles(p));
		else out.push(p);
	}
	return out;
}

function deepMerge(
	target: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	for (const [key, value] of Object.entries(patch)) {
		const existing = target[key];
		if (Array.isArray(existing) && Array.isArray(value)) {
			target[key] = [
				...existing,
				...value.filter((v) => !existing.some((e) => JSON.stringify(e) === JSON.stringify(v))),
			];
		} else if (
			existing &&
			typeof existing === "object" &&
			!Array.isArray(existing) &&
			value &&
			typeof value === "object" &&
			!Array.isArray(value)
		) {
			deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
		} else {
			target[key] = value;
		}
	}
	return target;
}

/** Strip // and block comments so wrangler.jsonc parses as JSON. */
function parseJsonc(text: string): Record<string, unknown> {
	const noComments = text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(noComments);
}

function mergeJsonFile(path: string, patch: Record<string, unknown>, jsonc = false) {
	const current = jsonc
		? parseJsonc(readFileSync(path, "utf8"))
		: JSON.parse(readFileSync(path, "utf8"));
	deepMerge(current, patch);
	writeFileSync(path, `${JSON.stringify(current, null, "\t")}\n`);
}

function parsePatchFile(text: string): PatchSection[] {
	const sections: PatchSection[] = [];
	let current: { marker: string; lines: string[] } | null = null;
	for (const line of text.split("\n")) {
		const m = line.match(/^>>> (.+)$/);
		if (m) {
			if (current) {
				sections.push({
					marker: current.marker,
					snippet: current.lines.join("\n").replace(/\n+$/, ""),
				});
			}
			current = { marker: m[1].trim(), lines: [] };
		} else if (current) {
			current.lines.push(line);
		}
	}
	if (current) {
		sections.push({
			marker: current.marker,
			snippet: current.lines.join("\n").replace(/\n+$/, ""),
		});
	}
	return sections;
}

function applyPatch(
	outDir: string,
	targetPath: string,
	sections: PatchSection[],
	moduleName: string,
) {
	let content = readFileSync(targetPath, "utf8");
	for (const { marker, snippet } of sections) {
		const lines = content.split("\n");
		const idx = lines.findIndex((l) => l.includes(marker) && !l.startsWith(">>>"));
		if (idx === -1) {
			throw new Error(
				`[${moduleName}] marker "${marker}" not found in ${relative(outDir, targetPath)}`,
			);
		}
		lines.splice(idx, 0, snippet);
		content = lines.join("\n");
	}
	writeFileSync(targetPath, content);
}

function applyOverlay(outDir: string, overlayRoot: string, moduleName: string) {
	const filesDir = join(overlayRoot, "files");
	if (existsSync(filesDir)) {
		for (const src of walkFiles(filesDir)) {
			const rel = relative(filesDir, src);
			const dest = join(outDir, rel);
			mkdirSync(dirname(dest), { recursive: true });
			cpSync(src, dest);
		}
	}
	const patchesDir = join(overlayRoot, "patches");
	if (existsSync(patchesDir)) {
		for (const patchFile of walkFiles(patchesDir)) {
			const rel = relative(patchesDir, patchFile).replace(/\.patch$/, "");
			const target = join(outDir, rel);
			if (!existsSync(target)) throw new Error(`[${moduleName}] patch target missing: ${rel}`);
			applyPatch(outDir, target, parsePatchFile(readFileSync(patchFile, "utf8")), moduleName);
		}
	}
}

/**
 * Assemble a project from base/ + the given modules (in dependency-first order)
 * into outDir. Mirrors the reference implementation in the template's
 * scripts/assemble.ts; see docs/module-format.md for the format.
 */
export function assemble(opts: AssembleOptions): AssembleResult {
	const { templateDir, outDir, projectName, modules, kit, templateCommit } = opts;

	if (existsSync(outDir) && readdirSync(outDir).length > 0) {
		throw new Error(`Output directory ${outDir} exists and is not empty.`);
	}
	mkdirSync(outDir, { recursive: true });

	// 1. base
	cpSync(join(templateDir, kit.base), outDir, {
		recursive: true,
		filter: (src) => {
			const name = basename(src);
			return !COPY_EXCLUDE.has(name) && !isSecretFile(name);
		},
	});

	const nextSteps: string[] = [];
	const manifests = new Map<string, Manifest>();

	// 2. modules in dependency order
	for (const moduleName of modules) {
		const moduleRoot = join(templateDir, "modules", moduleName);
		const manifest: Manifest = JSON.parse(readFileSync(join(moduleRoot, "manifest.json"), "utf8"));
		manifests.set(moduleName, manifest);

		// kit.json is the source of truth for dependencies; fail loudly on drift.
		const kitRequires = [...kit.modules[moduleName].requires].sort();
		const manifestRequires = [...(manifest.requires ?? [])].sort();
		if (JSON.stringify(kitRequires) !== JSON.stringify(manifestRequires)) {
			throw new Error(
				`[${moduleName}] manifest.requires ${JSON.stringify(manifestRequires)} disagrees with kit.json ${JSON.stringify(kitRequires)}`,
			);
		}

		applyOverlay(outDir, moduleRoot, moduleName);

		for (const [workspace, patch] of Object.entries(manifest.packageJson ?? {})) {
			mergeJsonFile(join(outDir, workspace === "." ? "" : workspace, "package.json"), patch);
		}
		for (const [workspace, patch] of Object.entries(manifest.wrangler ?? {})) {
			mergeJsonFile(join(outDir, workspace, "wrangler.jsonc"), patch, true);
		}
		for (const [workspace, vars] of Object.entries(manifest.env ?? {})) {
			const envPath = join(outDir, workspace, ".dev.vars.example");
			if (!existsSync(envPath)) {
				mkdirSync(dirname(envPath), { recursive: true });
				writeFileSync(
					envPath,
					"# Copy this file to .dev.vars for local development\n\n# @kit:env-vars\n",
				);
			}
			const block = vars
				.map((v) => `${v.comment ? `# ${v.comment}\n` : ""}${v.name}=${v.example ?? ""}`)
				.join("\n");
			applyPatch(
				outDir,
				envPath,
				[{ marker: "@kit:env-vars", snippet: `# --- ${moduleName} ---\n${block}\n` }],
				moduleName,
			);
		}
		nextSteps.push(
			...(manifest.nextSteps ?? []).map(
				(s) => `[${moduleName}] ${s.replaceAll("PROJECT_NAME", projectName)}`,
			),
		);
	}

	// 3. combined overlays (after all selected modules applied)
	for (const moduleName of modules) {
		const moduleRoot = join(templateDir, "modules", moduleName);
		const manifest = manifests.get(moduleName);
		for (const [other, dir] of Object.entries(manifest?.combined ?? {})) {
			if (modules.includes(other))
				applyOverlay(outDir, join(moduleRoot, dir), `${moduleName}+${other}`);
		}
	}

	// 4. PROJECT_NAME replacement (file contents only)
	for (const file of walkFiles(outDir)) {
		if (!isTextFile(file)) continue;
		const content = readFileSync(file, "utf8");
		if (content.includes("PROJECT_NAME"))
			writeFileSync(file, content.replaceAll("PROJECT_NAME", projectName));
	}

	// 5. kit.lock — records what was assembled, for a future `add` command.
	writeFileSync(
		join(outDir, "kit.lock"),
		`${JSON.stringify({ kit: kit.name, kitVersion: kit.version, templateCommit: templateCommit ?? null, projectName, modules }, null, "\t")}\n`,
	);

	return { nextSteps };
}
