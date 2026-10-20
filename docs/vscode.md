# VS Code extension

Running the Claude Code extension for VS Code through TeamClaude.

In its chat panel, the extension starts its own Claude Code processes. `teamclaude run` and the shell alias never see them, so the extension gets the proxy settings from its own `claudeCode.environmentVariables` setting instead. This page sets that up in [MITM mode](proxy-modes.md#mitm-proxy-mode-default), the mode `teamclaude run` uses by default.

## 1. Keep the proxy running

The extension has no fallback: while the proxy is down, its requests fail. So run the proxy as a user service that starts at login and restarts on its own:

```bash
teamclaude service install
teamclaude service status
```

- **macOS:** a LaunchAgent. Logs go to `~/Library/Logs/teamclaude.log`.
- **Linux:** a `systemd --user` unit, `teamclaude.service`. Logs: `journalctl --user --unit teamclaude.service`. To keep it running with no session open, run `loginctl enable-linger $USER`.
- **Windows:** `teamclaude service` has no integration there. Start `teamclaude server --headless` yourself.

`teamclaude attach` opens the dashboard against the running service.

## 2. Get the values

```bash
teamclaude env --mitm
```

This prints the variables `teamclaude run` would set, and creates the local CA if it does not exist yet. `--mitm` gives MITM output even when `defaultClientMode` is `base-url`:

```bash
export HTTPS_PROXY=http://127.0.0.1:3456
export HTTP_PROXY=http://127.0.0.1:3456
export https_proxy=http://127.0.0.1:3456
export http_proxy=http://127.0.0.1:3456
export NO_PROXY='localhost,127.0.0.1,::1'
export no_proxy='localhost,127.0.0.1,::1'
export NODE_EXTRA_CA_CERTS='/Users/<you>/.config/teamclaude-ca.pem'
unset ANTHROPIC_BASE_URL
```

Your port and CA path can differ (`proxy.port`, `$XDG_CONFIG_HOME`, `TEAMCLAUDE_CONFIG`). Use what your own output says.

Check the proxy and the CA before you touch VS Code. The proxy answers this test host itself, so no account is involved:

```bash
curl --proxy http://127.0.0.1:3456 --cacert ~/.config/teamclaude-ca.pem https://www.example.org/
# {"teamclaude":"mitm-proxy-ok","host":"www.example.org","path":"/"}
```

## 3. Add them to VS Code

Run **Preferences: Open User Settings (JSON)** and add the key to the object already in that file:

```json
{
  "claudeCode.environmentVariables": [
    { "name": "HTTPS_PROXY", "value": "http://127.0.0.1:3456" },
    { "name": "HTTP_PROXY", "value": "http://127.0.0.1:3456" },
    { "name": "https_proxy", "value": "http://127.0.0.1:3456" },
    { "name": "http_proxy", "value": "http://127.0.0.1:3456" },
    { "name": "NO_PROXY", "value": "localhost,127.0.0.1,::1" },
    { "name": "no_proxy", "value": "localhost,127.0.0.1,::1" },
    { "name": "NODE_EXTRA_CA_CERTS", "value": "/Users/<you>/.config/teamclaude-ca.pem" }
  ]
}
```

- **Use an absolute path.** The extension passes each value through as written. It does not expand `~` or `${env:HOME}`. On Windows, write each `\` in the path as `\\`.
- **User settings only.** The setting is machine-scoped: VS Code does not read it from a workspace's `.vscode/settings.json`, and Settings Sync does not copy it to your other machines. Set it on each machine.
- **`NO_PROXY`** keeps local traffic, such as your dev servers, off the proxy, which refuses to forward to loopback. Add your own entries after the three if you need them, for example `.test`. Never add `*`: it sends `api.anthropic.com` around the proxy too, and rotation silently stops.
- **`API_TIMEOUT_MS`:** if `teamclaude env` prints it (it does when `holdSeconds` is set), add it too.
- **No `ANTHROPIC_BASE_URL`.** Remove any entry that sets it. MITM mode does not use it.

## 4. Open a new conversation

The extension reads the setting when it starts a Claude Code process. A conversation that is already open keeps the environment it started with, so it keeps going direct until you close and reopen it. Open a new conversation and ask Claude:

```text
Run env | grep -iE '_proxy|NODE_EXTRA_CA', then curl -sS -o /dev/null -w '%{http_code}\n' https://api.github.com, then git ls-remote origin HEAD in this repository, and tell me whether the ToolSearch tool is available.
```

You should see:

- the seven variables from step 3;
- `200` from GitHub: hosts other than Anthropic's go through a plain tunnel, untouched;
- one line with a commit hash (an HTTPS remote goes through the same tunnel; an SSH remote does not use the proxy at all);
- that ToolSearch is available.

On the proxy side, `teamclaude status` (or the TUI) counts the conversation under **Sessions**, and the request count on the account that served it goes up.

## Why MITM mode, not a base URL

`teamclaude env --no-mitm` gives `ANTHROPIC_BASE_URL=http://localhost:3456` (plus `API_TIMEOUT_MS` when `holdSeconds` is set), and the extension accepts that too. But Claude Code treats a base URL that is not Anthropic's as a gateway:

- [MCP tool search](https://code.claude.com/docs/en/mcp#configure-tool-search) is off by default (`ENABLE_TOOL_SEARCH=true` turns it back on).
- [Remote Control](https://code.claude.com/docs/en/remote-control#requirements) is off.
- Features that call `api.anthropic.com` directly, such as the Claude Design MCP, ignore the base URL and so skip the pool.

In MITM mode the API host stays `api.anthropic.com`, so none of that applies. [Proxy modes](proxy-modes.md#mitm-proxy-mode-default) has the details. In short:

- The proxy terminates only Anthropic's host (and `chatgpt.com` when the pool holds Codex accounts). Every other host goes through a blind `CONNECT` tunnel.
- Sign-in and token refresh, Remote Control, claude.ai file transfers and artifacts go upstream with the extension's own login, never a pooled account.
- The local CA is trusted only by processes that get `NODE_EXTRA_CA_CERTS`: here, the extension's Claude Code processes and what they start. It is never added to the system trust store.

## Notes

- **Claude Code still needs its own login.** Sign in to the extension as usual. The pool's accounts are what the proxy uses upstream; see [Run Claude Code through the proxy](usage.md#run-claude-code-through-the-proxy).
- **Terminal mode** (`claudeCode.useTerminal`) runs Claude Code in an integrated terminal, and that terminal does not get these variables. On macOS and Linux, and on Windows in a Git Bash or WSL terminal, it types `claude` into your shell, so the shell alias (`teamclaude alias --install`) routes it through the proxy there. This page covers the default chat panel.
- **Tools that Claude runs inherit the variables.** Their traffic to other hosts is tunneled untouched. A program that is not Node.js and calls `api.anthropic.com` itself does not read `NODE_EXTRA_CA_CERTS`, so it rejects the proxy's certificate.
- **Background sessions** (`/background`, `claude agents`) run in a shared supervisor process that may not have these variables. Claude Code's docs recommend the `env` block of `~/.claude/settings.json` for them ([network configuration](https://code.claude.com/docs/en/network-config#apply-network-settings-to-background-agents)). That file is shared with the CLI, so then every `claude` you start, in any terminal, goes through the proxy too, without the check `teamclaude run` makes that the proxy is up.
- **Remote Control:** if messages from your phone never arrive, set `mitm.http1Only` (see [Configuration](configuration.md) and [#164](https://github.com/KarpelesLab/teamclaude/issues/164)).

## After updating TeamClaude

The service keeps running the code it started with. After `teamclaude update` or an auto-update, restart it by re-running the install, which rewrites the LaunchAgent or `systemd --user` unit and restarts the proxy:

```bash
teamclaude service install
```

A restart drops requests in flight, so do it between tasks. `teamclaude version` names the installed version and `teamclaude status --json` names the running one (`server.version`). While they differ, the restart is still due.

A copy installed with pnpm is updated with pnpm (`pnpm add -g @karpeleslab/teamclaude@latest`, which `teamclaude update` prints for such a copy); one installed with another tool, such as Yarn or Bun, with that tool. Restart the service after that update too.

Restart it as well when `teamclaude env` or `teamclaude run` warns that the MITM certificate is due for renewal: it no longer names a host the proxy intercepts (such as `chatgpt.com` once the first Codex account is added) or has less than 30 days left. While the proxy runs they keep the certificate it presents, and a starting proxy renews it. The renewal comes with a new CA, so after the restart, run `teamclaude env --mitm` again and check that the `NODE_EXTRA_CA_CERTS` path is unchanged (it is, unless you moved the config); conversations opened before the restart need reopening.

## Turning it off

Remove the `claudeCode.environmentVariables` entries and open a new conversation. The extension then talks to Anthropic directly, on its own login. `teamclaude service uninstall` removes the service.
