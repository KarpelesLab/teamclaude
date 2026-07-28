# Compliance and terms of service

> This is the maintainer's good-faith understanding, **not legal advice.** Anthropic's Terms are theirs to interpret and to change; read the current [Claude Code legal terms](https://code.claude.com/docs/en/legal-and-compliance) and decide for yourself.

TeamClaude is a **self-hosted local proxy**. You run it on your own machine, it holds *your own* credentials, and it forwards the requests that *your own* Claude Code CLI makes to Anthropic. It is **not** a hosted service, it does not offer "Claude.ai login" to anyone, and it never routes requests on behalf of third parties — it only moves your own traffic through accounts you control.

How you use it is your responsibility. In particular:

- **Use the genuine Claude Code CLI.** Pointing a third-party frontend (opencode and similar) at Pro/Max OAuth credentials is the pattern Anthropic explicitly restricts.
- **Keep a human in the loop.** The terms expect interactive, human-present use rather than fully unattended automation. The two features that make background calls on their own — [keep-warm](quota.md#keep-warm) and the [quota probe](quota.md#quota-probe) — are **off by default**.
- **Only use subscriptions you legitimately purchased.**

On **rotating across multiple subscriptions** — the question people ask most — note that Claude Code's own `/extra-usage` flow already offers signing into a *different* account when you hit a limit. "Switch to another account you own to get more usage" is a move the native client itself surfaces; TeamClaude automates that same switch. Anthropic hasn't explicitly blessed *automated* pooling, so weigh it against the current terms — but the idea that using more than one of your own subscriptions is inherently off-limits is hard to square with the first-party client offering to do the same thing by hand.

To the best of the maintainer's knowledge, using TeamClaude as intended — the real Claude Code CLI, your own subscriptions, a human present — is consistent with Claude Code's Terms. See [#107](https://github.com/KarpelesLab/teamclaude/issues/107) for the full write-up.
