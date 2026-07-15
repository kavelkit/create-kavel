# create-kavel

The scaffolding CLI for [Kavel](https://createkavel.com), a full-stack Cloudflare
starter kit (Bun · TanStack Start · Hono · D1 · Drizzle · ORPC).

```bash
bun create kavel
# or
npm create kavel@latest
```

Pick your modules at scaffold time, **auth** (better-auth: email/password,
verification, OAuth, admin), **email** (React Email + Resend + a D1 queue),
**i18n** (Paraglide), and **ui** (a shadcn-style component library). Dependencies
between modules are resolved automatically.

## Usage

```bash
bun create kavel [name] [options]
```

| Option | Description |
|---|---|
| `-y, --yes` | Skip prompts; use defaults (or `--modules`) |
| `--modules a,b,c` | Modules to include (`auth`, `email`, `i18n`, `ui`) |
| `--no-install` | Don't run the install step |
| `--no-git` | Don't initialize a git repository |
| `--template <dir>` | Use a local template checkout instead of cloning |
| `--repo <url>` | Override the template repo URL |
| `-h, --help` | Show help |
| `-v, --version` | Show the version |

Non-interactive example:

```bash
bun create kavel my-app --yes --modules auth,i18n,ui
```

## Access

Kavel's templates live in a **private repo**; buying the kit grants your GitHub
account access. The CLI verifies access with `git ls-remote` and then clones the
template using your own git credentials, there are no license keys. If you don't
have access yet, buy the kit at [createkavel.com](https://createkavel.com).

Environment overrides: `KAVEL_REPO` (template repo URL) and `KAVEL_TEMPLATE_DIR`
(use a local checkout, skipping the clone, handy for development).

## Requirements

- [Bun](https://bun.sh), the scaffolded app is a Bun monorepo (the CLI itself
  runs under Node or Bun).
- A GitHub account with access to the Kavel template repo.
