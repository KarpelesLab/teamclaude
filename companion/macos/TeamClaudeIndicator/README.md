# TeamClaude Indicator for macOS

A small native companion that follows Claude Desktop and shows the TeamClaude
account and quota windows assigned to the currently focused SSH task.

It does not modify Claude Desktop. The companion:

1. reads the most recently focused task from Claude's local
   `claude-code-sessions` metadata;
2. resolves that task's `cliSessionId`;
3. runs the installed `teamclaude session <uuid> --json` command over
   non-interactive `ssh dev`; and
4. displays the credential-free result in a floating pill near Claude's Usage
   control.

No OAuth tokens, prompts, or thread content are read or returned.

## Build

```bash
./build-app.sh
open ".build/TeamClaude Indicator.app"
```

The app is a menu-bar accessory. It appears only while Claude is frontmost and
the focused task uses the `dev` SSH host. It requests macOS Accessibility
permission so it can dock to Claude's real Usage control across multiple
monitors; without permission it falls back to Claude's window edge. Click the
pill to expand the three quota bars.
