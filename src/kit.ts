import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface KitModule {
	description: string;
	requires: string[];
	default?: boolean;
	/** "planned" modules exist in kit.json but aren't built yet — never offered. */
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
