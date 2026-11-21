---
name: switch
description: Move this Claude Code session to another teamclaude account, or review usage and the move advice for this session.
argument-hint: "[account]"
disable-model-invocation: true
allowed-tools: Bash(teamclaude switch --session *)
---

Current state of this session:

!`teamclaude switch --session`

Arguments: $ARGUMENTS

Never move the session without the user's answer.

If arguments are given, they are one account name, spaces included. Run `teamclaude switch --session --to '$ARGUMENTS'`, keeping the single quotes so the whole name is one word (write a `'` inside the name as `'\''`). Do nothing else.

If no arguments are given, show the account, per-account usage and advice above. If that output is empty, run `teamclaude switch --session` with the shell tool and use its output. Then ask the user to choose one:

1. Move to the recommended account (only when the report has a `move command:` line).
2. Move to another named account.
3. Stay. Run `teamclaude switch --session --stay`.

Ask with the AskUserQuestion tool. If it is not available, list the choices as plain text and wait for the reply.

If the user chooses the recommended account, run the command after `move command:` in the report exactly as printed, character for character. Never rebuild it from the account name: the name comes from the server and the printed command already quotes it.

If the user names another account, run `teamclaude switch --session --to '<account>'`, the name single-quoted as above.

Report each command's output verbatim. Say the session moved only when the command printed `pinned to` and no `Warning:` or error; otherwise say it did not move, and show why.
