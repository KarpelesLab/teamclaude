# Contributing

Issues and pull requests are welcome. This page says what the project is for, since that decides what gets merged, and then what a pull request needs.

## What the project is for

TeamClaude serves **one person's work**: someone running many coding-agent sessions at once, across several accounts of their own, who needs the switch between accounts to happen without them. The "team" is the agents. [docs/compliance.md](docs/compliance.md) has the full statement.

That scope applies to every provider the proxy supports — Anthropic, OpenAI/Codex, and third-party backends alike — and to every provider added later.

### In scope

- Anything that makes one person's pool of their own accounts work better: rotation, quota tracking, routing, pinning, the TUI and dashboard, token upkeep, diagnostics.
- Reaching your own proxy from your own other machines and agents (client keys, non-loopback binding, token sync across your installs).
- New providers and backends, on the same terms as the existing ones: accounts the user holds, used through that provider's own client where it has one.

### Out of scope

A change is declined, however well made, when its purpose is one of these:

- **Sharing accounts between people.** Multi-tenant features, per-person onboarding or invitations, handing out credentials that let someone else spend the pool, making it easier to use accounts that are not the operator's own, billing or metering people against each other, running it as a service for others.
- **Other harnesses on subscription credentials.** Compatibility work whose point is to let a client other than the provider's own CLI (Claude Code for Claude accounts, the Codex CLI for Codex accounts) spend a subscription login.

If you are unsure which side an idea falls on, open an issue describing the use case before writing the code. A feature can be in scope for one use and out for another; say which you have in mind, and write the docs for that one. A description that talks about "users" or "a shared proxy" will be asked who those are.

## What a pull request needs

- **Open an issue first for anything sizeable.** Agreeing on the shape beforehand saves a rewrite.
- **Checks.** CI runs `npm test`, `npm run lint`, `npm run typecheck` and the strict typecheck ratchet (`npm run typecheck:strict -- --base <master sha>`): the count of strict-mode diagnostics per file may not grow. A fork's CI run waits for a maintainer to approve it.
- **Tests.** Follow [test/README.md](test/README.md). In short: assert the mechanism rather than the clock (no sleeps, no short deadlines — a test that fails on a loaded machine is testing the scheduler), spawn the real server only through `test-helpers/spawn-server.js`, and clean up in `finally`.
- **No runtime dependencies.** The proxy uses Node built-ins only, on Node 20 and later.
- **Say what you verified.** If a change rests on a provider's wire behaviour, say what you observed and against what, and say plainly what you could not check live. Never include tokens, account ids or anything else that identifies an account in an issue, a test or a log excerpt.
- **Document it.** A user-visible change updates the page under `docs/` that covers it, and a new config key gets a row in `docs/configuration.md` and `config.example.json`.
- **Defaults stay conservative.** Anything that makes calls on its own, spends quota or money, or changes what reaches the client is off unless the operator turns it on.

AI-assisted contributions are fine and common here. You are responsible for what you submit: read it, and be ready to explain it.

Pull requests are reviewed by reading the code and are squash-merged once CI is green. Security issues go through [SECURITY.md](SECURITY.md), not a public issue.
