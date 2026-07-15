import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface KitModule {
	description: string;
	requires: string[];
	default?: boolean;
	/** "planned" modules exist in kit.json but aren't built yet, never offered. */
	status?: string;
}

export interface KitJson {
	name: string;
	version: string;
	base: string;
	modules: Record<string, KitModule>;
}

export function readKit(templateDir: string): KitJson {
	return JSON.parse(readFileSync(join(templateDir, "kit.json"), "utf8"));
}

/** Human-readable names for the curated locales the kit ships. */
export const LOCALE_LABELS: Record<string, string> = {
	en: "English",
	nl: "Nederlands",
	de: "Deutsch",
	fr: "Français",
	es: "Español",
};

/** Locales pre-selected by default (kept minimal, buyers add the rest). */
export const DEFAULT_LOCALES = ["en", "nl"];

/**
 * Locales the kit ships translated catalogs for, discovered from the i18n
 * module's message files. English is listed first (the conventional base);
 * the rest are alphabetical. Empty if the template has no i18n catalogs.
 */
export function availableLocales(templateDir: string): string[] {
	const dir = join(templateDir, "modules", "i18n", "files", "messages");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(/\.json$/, ""))
		.sort((a, b) => (a === "en" ? -1 : b === "en" ? 1 : a.localeCompare(b)));
}

/** Modules that are actually built and can be selected. */
export function availableModules(kit: KitJson): string[] {
	return Object.keys(kit.modules).filter((name) => kit.modules[name].status !== "planned");
}

export function defaultModules(kit: KitJson): string[] {
	return availableModules(kit).filter((name) => kit.modules[name].default);
}

/**
 * Expand a set of requested modules into dependency-first order, pulling in
 * transitive `requires` and detecting cycles. Throws on unknown or unbuilt
 * modules.
 */
export function resolveModules(kit: KitJson, requested: string[]): string[] {
	const ordered: string[] = [];
	const visiting = new Set<string>();
	function visit(m: string) {
		if (ordered.includes(m)) return;
		// Validate every module we touch, including transitive dependencies.
		if (!kit.modules[m]) {
			throw new Error(`Unknown module "${m}". Available: ${availableModules(kit).join(", ")}`);
		}
		if (kit.modules[m].status === "planned") {
			throw new Error(`Module "${m}" is not built yet.`);
		}
		if (visiting.has(m)) throw new Error(`Dependency cycle involving "${m}"`);
		visiting.add(m);
		for (const dep of kit.modules[m].requires) visit(dep);
		visiting.delete(m);
		ordered.push(m);
	}
	for (const m of requested) visit(m);
	return ordered;
}
