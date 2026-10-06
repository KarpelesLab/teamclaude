# Compliance and terms of service

> This is the maintainer's good-faith understanding, **not legal advice.** Each provider's terms are theirs to interpret and to change; read the current ones and decide for yourself.

## Who it is for

TeamClaude is for **one person's work**. The "team" in the name is the agents: someone directing ten, or fifty, coding-agent sessions at once spends more than one subscription can carry, and when an account fills up every one of those sessions stops until somebody signs into another account by hand. The project exists to make that switch automatic. That is the whole of its purpose, and it has been from the start.

It is a **self-hosted local proxy**. You run it on your own machine, it holds *your own* credentials, and it forwards the requests that *your own* CLI makes to the provider. It is **not** a hosted service, it does not offer a login to anyone, and it never routes requests on behalf of third parties — it only moves your own traffic through accounts you control.

Two things it has never been for, on any provider:

- **Sharing accounts between people.** Not a pool for a group, a family or a company, and not something to resell access through. If several people need the tool, each uses their own subscription, or the organization buys the plan or API access made for that. Features such as `proxy.clientKeys`, a non-loopback `proxy.host` and the callback.net token sync exist so that *your* machines and agents can reach *your* proxy; none of them is a way to hand the pool to someone else.
- **Driving a subscription from another harness.** Claude accounts serve Claude Code; Codex accounts serve the Codex CLI. The proxy is not a bridge that lets a different client spend a subscription login.

## The same stance for every provider

TeamClaude started with Claude accounts and now also pools ChatGPT/Codex subscriptions and third-party backends. The scope above does not change with the provider:

- **Subscription accounts (Claude, ChatGPT/Codex):** your own subscriptions, used through the provider's own CLI, by you.
- **API keys:** keys issued to you, billed to you.
- **Third-party backends (DeepSeek, z.ai, Kimi and the like):** an account like any other — a key you were issued, used under that vendor's terms. Being a fallback does not make it exempt.

Where a provider's terms are stricter than this page, the provider's terms win.

## How you use it is your responsibility

In particular:

- **Use the provider's genuine CLI.** Pointing a third-party frontend (opencode and similar) at Pro/Max OAuth credentials is the pattern Anthropic explicitly restricts.
- **How much may run unattended is the client's call, not the proxy's.** Each provider decides what its own CLI may do without a person at the keyboard — background work, scheduled tasks, long runs — and builds those limits into that CLI. TeamClaude routes requests between your subscriptions and that client; it neither widens what the client allows nor narrows it. A long run the client permits can be carried across an account switch or a quota reset ([`holdSeconds`](quota.md#hold-on-exhaustion)); a run the client does not permit does not become permitted by going through a proxy.
- **The proxy's own background calls are off by default.** Two features make requests that no client asked for — [keep-warm](quota.md#keep-warm) and the [quota probe](quota.md#quota-probe) — and you turn them on yourself.
- **Only use subscriptions you legitimately purchased.**

## Anthropic: rotating across multiple subscriptions

This is the question people ask most. Note that Claude Code's own `/extra-usage` flow already offers signing into a *different* account when you hit a limit. "Switch to another account you own to get more usage" is a move the native client itself surfaces; TeamClaude automates that same switch. Anthropic hasn't explicitly blessed *automated* pooling, so weigh it against the current [Claude Code legal terms](https://code.claude.com/docs/en/legal-and-compliance) — but the idea that using more than one of your own subscriptions is inherently off-limits is hard to square with the first-party client offering to do the same thing by hand.

To the best of the maintainer's knowledge, using TeamClaude as intended — the real Claude Code CLI, used as it allows, on your own subscriptions — is consistent with Claude Code's Terms. See [#107](https://github.com/KarpelesLab/teamclaude/issues/107) for the full write-up.

## Other providers

No equivalent write-up exists yet for OpenAI's or the backend vendors' terms. The intended use is the same — your own accounts, the provider's own client, used as that client allows — and whether that satisfies a given provider's current terms is for you to check with that provider.
