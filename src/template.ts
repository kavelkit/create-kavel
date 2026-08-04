import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

/** The private template repo. Override with KAVEL_REPO (e.g. an https URL). */
export const TEMPLATE_REPO = process.env.KAVEL_REPO ?? "git@github.com:kavelkit/kavel.git";

/**
 * The ref to clone. Override with KAVEL_REF (e.g. `main` to try unreleased work).
 *
 * `release` rather than the default branch on purpose. Cloning the default branch
 * made whatever was last pushed to `main` the thing every buyer downloaded: two
 * people could scaffold the same declared kit version and get different code, and
 * a dependency bump merged on a Monday morning shipped with no soak time at all.
 *
 * `release` is advanced deliberately, with `git push origin main:release`, so
 * `main` is a working branch again. Publishing a kit release is: bump the version
 * in kit.json, tag it, then move this ref.
 */
export const TEMPLATE_REF = process.env.KAVEL_REF ?? "release";

export const PURCHASE_URL = "https://createkavel.com";

/** A local template checkout to use instead of cloning (dev/testing). */
export const LOCAL_TEMPLATE = process.env.KAVEL_TEMPLATE_DIR;

// Never let git block on an interactive credential, host-key, or passphrase
// prompt, fail fast instead of hanging until the timeout.
const GIT_ENV = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
};

export class AccessError extends Error {}

/** True if `git` is on PATH. */
async function hasGit(): Promise<boolean> {
	try {
		await execa("git", ["--version"]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Verify the current git credentials can reach the private template repo.
 * Throws AccessError (with guidance) when they can't.
 */
export async function checkAccess(repo = TEMPLATE_REPO): Promise<void> {
	if (!(await hasGit())) {
		throw new AccessError("git is not installed or not on PATH. Install git, then try again.");
	}
	try {
		await execa("git", ["ls-remote", repo, "HEAD"], { env: GIT_ENV, timeout: 30_000 });
	} catch {
		throw new AccessError(
			`Couldn't reach the Kavel template repo:\n  ${repo}\n\n` +
				`If you haven't bought Kavel yet, get access at ${PURCHASE_URL}\n\n` +
				"If you have access, this is usually one of:\n" +
				"  • not signed in to GitHub for this repo (check your SSH key or `gh auth`)\n" +
				"  • using HTTPS creds with the default SSH URL, set KAVEL_REPO to the https:// URL\n" +
				"  • no network connection",
		);
	}
}

/**
 * Shallow-clone the template into a temp directory. Caller must call the
 * returned cleanup() when done.
 */
export async function cloneTemplate(
	repo = TEMPLATE_REPO,
	ref = TEMPLATE_REF,
): Promise<{ dir: string; cleanup: () => void }> {
	const dir = mkdtempSync(join(tmpdir(), "kavel-"));
	try {
		await execa("git", ["clone", "--depth", "1", "--branch", ref, repo, dir], {
			env: GIT_ENV,
			timeout: 120_000,
		});
	} catch (err) {
		rmSync(dir, { recursive: true, force: true });
		// git's own message for a missing ref ("Remote branch release not found in
		// upstream origin") does not hint at what to do, and this is the one code
		// path every buyer depends on, so say it plainly.
		const detail = err instanceof Error ? err.message : String(err);
		if (/not found in upstream|Remote branch/i.test(detail)) {
			throw new Error(
				`The template ref "${ref}" does not exist in ${repo}.\n` +
					`Publish it with: git push origin main:${ref}\n` +
					`Or point somewhere else for now: KAVEL_REF=main`,
			);
		}
		throw err;
	}
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** The commit SHA checked out in a git working tree, or undefined if not a repo. */
export async function templateCommit(dir: string): Promise<string | undefined> {
	try {
		const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: dir, env: GIT_ENV });
		return stdout.trim();
	} catch {
		return undefined;
	}
}
