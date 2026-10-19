# Deploy readiness — teamclaude db33b4f + TUI fleet-agent-name

**Prepared by:** tc-fugu-24, 2026-08-05T04:4xZ. **Status: STAGED, RESTART GATED.**
Authorization to build+deploy is on record (Eddie via harness #5674). The actual
**cutover (restarting the shared proxy the whole fleet routes through) is gated
on an explicit go** — I will not autonomously restart it from a just-revived
session while Eddie is mid-triage on another escalation.

## What ships
- **db33b4f** `feat(quota): native account.quotaSource probes (agy/codex/sakana) + dynrank model fidelity` — the fix for the live `QUOTA_ISSUES` nulls (harness #5638, gap-logged TEAMCLAUDE_UNDEPLOYED_QUOTA_FIX).
- **13f854d** `feat(tui): render fleet agent name from x-fleet-agent header` (my commit on branch `feat/tui-fleet-agent-name`, off db33b4f).

## Verification done (all green)
- `db33b4f` prober.js is a clean **superset** of the live hot-patch: keeps `probeCommandAccount`/`_cmdRuns`/`probeCommand`, adds `quotaSource`. Deploy extends, does not regress, the live prober.
- Live `index.js.bak` == live `index.js` → the index.js backup was never applied; no index hot-patch to preserve. Only real live divergence is prober.js, which db33b4f supersets.
- Import graph loads: `node src/index.js --help` exit 0 (no doubled-brace/ESM-require regression — the c416d0c boot fix is present in db33b4f's lineage).
- Real boot + feature live: build-identity status test boots `createProxyServer`, fetches `/teamclaude/status`, asserts `fleet-agent-name` in `build.features` — PASS.
- Full suite **817 pass / 0 fail** (+9 new `fleet-agent-name.test.js`).
- Guardrail: `fleetAgent` is display-only — never enters `ctx`/routing/quota/history; `sessionId` stays the rotation key. Sanitized `[A-Za-z0-9._-]{1,32}` (ANSI/control/traversal neutralized).

## Live state
- Proxy: `~/.teamclaude-deploy` @ detached `c416d0c` (**divergent history** — c416d0c is not an object in the fork clone; content upstreamed under different SHAs via PR #2), pid **1048689** (`node .../src/index.js server --auto-fallback --log-to ~/.teamclaude`).
- 2 untracked backups in deploy: `src/{index.js,prober.js}.bak-20260802T051608Z` (pre-patch originals; safe to leave).
- Active workers routing through it now: pids 1041726, 1045790, 1053900 (incl. the `-n tc-fugu` opus launcher).

## Cutover (rename-install, Text-file-busy safe) — RUN ONLY ON GO
```
# 1. Fresh deploy checkout at the target (divergent histories → fresh, not fetch-merge)
git -C ~/gh/teamclaude worktree add /tmp/tc-deploy-stage feat/tui-fleet-agent-name   # == db33b4f + 13f854d
# (or: cp -a a clean checkout; ensure src/ matches branch feat/tui-fleet-agent-name @ 13f854d)
# 2. Carry forward runtime state that lives in the deploy dir but not git:
cp ~/.teamclaude-deploy/src/*.bak-* /tmp/tc-deploy-stage/src/ 2>/dev/null || true   # keep backups
# 3. Stop live proxy
kill 1048689   # graceful; teamclaude --auto-fallback lets workers retry
# 4. Rename-swap (avoids Text-file-busy on running node)
mv ~/.teamclaude-deploy ~/.teamclaude-deploy-old-c416d0c
mv /tmp/tc-deploy-stage ~/.teamclaude-deploy
# 5. Restart with the EXACT live invocation
nohup node ~/.teamclaude-deploy/src/index.js server --auto-fallback --log-to ~/.teamclaude >/dev/null 2>&1 &
# 6. Verify
sleep 3
curl -s http://127.0.0.1:3456/teamclaude/status | python3 -c "import sys,json;d=json.load(sys.stdin);f=d['build']['features'];print('fleet-agent-name',' fleet-agent-name' in f or 'fleet-agent-name' in f);print('quotaSource dynrank',[x for x in f if 'dynrank' in x])"
# watch QUOTA_ISSUES nulls clear in the gap log / TUI Ses/Wk bars; confirm fleet names render in the Activity log
```

## Rollback (instant)
```
kill <new pid>
mv ~/.teamclaude-deploy ~/.teamclaude-deploy-failed
mv ~/.teamclaude-deploy-old-c416d0c ~/.teamclaude-deploy
nohup node ~/.teamclaude-deploy/src/index.js server --auto-fallback --log-to ~/.teamclaude >/dev/null 2>&1 &
```

## Recommendation
GO — verification is strong and rollback is one rename. But **restart on Eddie's/harness's explicit go and a coordinated window** (workers not mid-critical-request; Eddie not mid-cutover on another lane). The `QUOTA_ISSUES` degradation is non-fatal and 72h-old; a coordinated cutover beats a rushed autonomous one. sakana-fugu tier stays disabled until ~Aug 9 regardless (weekly quota, Eddie-confirmed) — the quota fix will correctly show its nulls resolving for codex-gpt56 first.

---
## DEPLOYED 2026-08-05T08:42:58Z by tc-fugu-24
- **Deployed HEAD sha:** 13f854da44aa4ef1dee058ad96cce803ec065abd (== db33b4f + 13f854d)
- **Live:** :3456 pid 1691784, build v1.1.11; features include fleet-agent-name + native-quota-sources + dynrank-model-fidelity.
- **Pre-flight correction:** live pid at cutover was 1672607 (proxy auto-restarted 08:32:09Z during revival), NOT the 1048689 in "Live state" above — re-resolved dynamically via pgrep.
- **Verified:** (a) in_flight=0 at cutover; (b) same-fs atomic rename-swap; (c) fleet-agent-name in features + unpinned/default+fable OAuth-first (empirical opus->yongbing oauth 08:43:19Z); (d) codex-gpt56 quotaStateFile fresh (u5h=0.95), sakana dashed until 08-09.
- **Rollback:** old build at ~/.teamclaude-deploy-old-20260805T084258Z (one rename + restart). Cutover script: ~/.harness/tc-cutover.sh (auto-rollback armed). Log: ~/.harness/tc-cutover-20260805T084258Z.log.
- **Bus report:** posted to harness (cc eddie) 08:46Z — detached-HEAD/undeployed-feature ledger closed.
