# Quota

How TeamClaude learns each account's quota, the two optional background jobs, and what happens when everything is spent.

## How quota is observed

TeamClaude is **passive** by default: it reads `anthropic-ratelimit-unified-*` headers off the responses that flow through it. An account that hasn't served a request yet shows unknown quota until rotation first reaches it.

Observed quota is persisted to `teamclaude.state.json` next to the config, so rotation state survives a restart. Stale windows are discarded automatically, and the file is safe to delete — quota is simply re-learned from traffic.

## Fleet quota endpoint

`GET /teamclaude/quota` returns the quota data intended for lightweight consumers such as a Claude Code status line. It includes every account's observed limits plus tier-weighted fleet aggregates for the shared 5-hour window, shared weekly window, Sonnet weekly window, and Fable weekly window. Sonnet and Fable fall back to the shared weekly bucket on accounts where Anthropic does not report a dedicated bucket. Its top-level `warmup` object reports whether keep-warm is off, interval-based, scheduled for a daily reset target, or running on an anchored five-hour cadence. Scheduled modes include the configured timezone, missed-run policy, and next warm-up/reset timestamps; rolling mode also includes `anchorResetAt`, `cadenceSeconds`, `nearResetToleranceSeconds`, and `postResetBufferSeconds`.

Subscription capacity is weighted relative to Claude Pro: Pro and Team Standard are `1`, Max 5x and Team tier 1 are `5`, and Max 20x and Team tier 2 are `20`. TeamClaude reads the organization and seat tier from the OAuth profile. An unrecognized tier remains visible under `accounts` and `unknownTiers` but is excluded from the aggregate instead of being assigned a guessed weight. API-key token and request limits remain per-account because their units cannot be combined with subscription utilization.

Remote callers authenticate exactly like the other control endpoints:

```bash
curl -H "x-api-key: $TEAMCLAUDE_API_KEY" https://proxy.example.com/teamclaude/quota
```

The optional quota probe also fills missing tier metadata on its first successful refresh. Tier metadata is persisted with observed quota in `teamclaude.state.json`, so it survives subsequent restarts.

## Quota probe

If you'd rather keep idle accounts' quota fresh, enable the background probe:

```bash
teamclaude probe 300    # refresh every 300s
teamclaude probe off    # back to passive (default)
teamclaude probe        # show current setting
```

The **Quota probe** row on the TUI settings screen (`g`) does the same thing, and `p` on the main screen is a one-shot refresh of every account.

It reads each OAuth account's utilization from Anthropic's usage endpoint (`/api/oauth/usage`), which reports quota **without consuming any message quota**. API-key and third-party accounts are skipped. Minimum interval is 30s. Changing it takes effect on a running server immediately.

The probe is also the only source for the **Sonnet 7-day** bucket, when your plan exposes it. The Fable weekly bucket arrives passively in the response headers (`anthropic-ratelimit-unified-7d_oi-*`), so Fable-aware routing works without turning the probe on. Both families are read from the payload's `limits[]`, where upstream enumerates the model-scoped weekly caps an account actually has.

### Revalidating a spent family bucket

Those `7d_oi` headers ride on **Fable responses only** — no other model's response carries them. That makes a spent Fable (or Sonnet) reading self-sealing: once it reads at or above the switch threshold, rotation stops sending that family to the account, which is also the only thing that could have refreshed the reading ([#167](https://github.com/KarpelesLab/teamclaude/issues/167)).

So a spent family reading is trusted for 30 minutes. After that it is dropped, the family falls back to the shared weekly bucket, and the next request of that family re-establishes the truth from real headers — a rejection re-arms the gate with a fresh reading for another 30 minutes, so a genuinely spent bucket costs at most one rejected request per account per window. Set `TEAMCLAUDE_FAMILY_STALE_MS` to tune the window. Readings with headroom are never dropped: they gate nothing.

Running the probe sidesteps this entirely — it refreshes the family buckets from the usage endpoint without spending quota, so a reset is picked up within one probe interval instead of within the staleness window.

A probe revalidates a family bucket in full, which includes concluding that there is no cap. When the payload enumerates an account's scoped weekly caps and a family is **not** among them, the cached reading is cleared and that family falls back to the shared weekly bucket — upstream retiring a cap must not leave the proxy gating on it. A payload that carries no such enumeration proves nothing, so nothing changes. Each reported bucket also carries its own reset, taken verbatim: an unstarted window has no reset, and the bar shows no date rather than the shared weekly one.

## Keep-warm

The rolling **5-hour session window** only starts once an account sends a real message. So when your active account runs out and rotation moves to a cold account, that account's 5h window starts *then* — right when you need its full headroom. Keep-warm ([#76](https://github.com/KarpelesLab/teamclaude/issues/76)) starts the timer on idle accounts ahead of time, so the next account is already partway (or fully) through a fresh window when it's needed.

```bash
teamclaude warmup 600                                      # warm idle accounts every 600s
teamclaude warmup reset 15:30 --timezone Europe/Moscow     # target a daily 15:30 reset
teamclaude warmup rolling 15:30 --timezone Europe/Moscow   # anchor resets at 15:30, then every 5h
teamclaude warmup off                                      # disable either mode
teamclaude warmup                                          # show current setting
```

> ⚠️ **This spends a little quota — unlike the passive quota probe.** The 5h timer can't be started by a read-only call, so keep-warm sends a real (minimal) message: for each eligible idle account it spawns a one-shot `claude -p --bare --model haiku --output-format text "hi"` pointed at this proxy, pinned to that account. It only warms accounts whose 5h window is **not already running**, skips disabled/throttled/errored and third-party-backend accounts, and uses the cheapest model — but it does consume a few tokens and a slice of the 5h/weekly buckets per account per window. Requires the `claude` CLI on `PATH`. Minimum interval 60s; changes apply live. Status shows under `warm` in `teamclaude status --json`.

Reset mode stores the target wall time and IANA timezone in the config, then subtracts Anthropic's fixed five-hour window to find each warm-up. It recalculates the next calendar occurrence after startup, config reload, and every run, so daylight-saving changes do not drift the schedule. It follows cron semantics: if TeamClaude was stopped at the scheduled time, that run is skipped and the server waits for the next future occurrence. The CLI confirmation prints the resolved local time, UTC time, timezone offset, and next occurrence.

Rolling mode uses the requested local time to save the next reset whose warm-up time has not passed, then schedules warm-ups on the same absolute five-hour cadence indefinitely. The saved anchor keeps the phase stable across service restarts and config reloads. Missed slots are skipped with no catch-up request; TeamClaude waits for the next point on the original cadence. If Anthropic reports that an account's current window resets within two minutes of a rolling slot, TeamClaude waits until ten seconds after that reset and retries only that account. It rechecks the account first, so normal usage that already started a new window suppresses the delayed warm-up. The retry is also skipped if its timer or token refresh runs beyond the following minute. This short per-account delay handles clock and reset-reporting imprecision without moving the global cadence or replaying a missed slot after restart. Because 24 hours is not divisible by 5, only the anchor reset occurs at the requested wall time: later reset times move around the local clock, and daylight-saving changes can shift their displayed local time as well. The CLI prints each rolling instant with its own UTC offset and ISO timestamp so repeated DST wall times remain unambiguous. This is best effort: an account with a live five-hour window outside the tolerance or an ineligible state is skipped at that slot.

Keep-warm has nothing to do with the prompt cache — see [Prompt caching across rotation](routing.md#prompt-caching-across-rotation).

## Switch threshold

`switchThreshold` is the utilization at which an account is taken out of rotation. A single number governs every bucket:

```json
"switchThreshold": 0.98
```

That conflates two different risks, though: 98% of a 5-hour window that refills in two hours is a nuisance, while 98% of a weekly window with six days left means the account is spent for the rest of the week. To rotate off one bucket earlier than another, give a table instead:

```json
"switchThreshold": { "default": 0.98, "unified7d": 0.9 }
```

Keys are the quota field names — `unified5h`, `unified7d`, `unified7dFable`, `unified7dSonnet`, `tokens`, `requests`. Anything unlisted takes `default`, and a bare number behaves exactly as before. The TUI's ±1% control edits the single-number form; when a table is configured the settings row shows it read-only, so the ± control can't silently flatten your per-bucket values.

Either form can be set without a terminal attached:

```bash
teamclaude threshold                  # show the effective table
teamclaude threshold 90               # one number for every bucket
teamclaude threshold unified7d=90     # add or change one bucket
teamclaude threshold unified7d=default  # drop it again
```

A running server picks the change up on the reload the command sends it. This is the only way to edit a per-bucket table in place: the TUI shows it read-only, and the single-number form there would flatten it.

## Per-account usage caps

`switchThreshold` is fleet-wide, and it is a *preference*: at that level rotation prefers another account, but when every account is over it the proxy still sends one revalidating request, because a threshold decision can rest on a stale reading and refusing forever is worse. That makes it the wrong tool for "this account may spend only part of its quota".

`accounts[].maxUsage` is that tool. Same shapes, per account:

```json
{
  "name": "spare@example.com",
  "maxUsage": { "unified5h": 0.6, "unified7d": 0.6, "unified7dFable": 0.8 }
}
```

A bare number caps every bucket. Keys are the same quota field names as `switchThreshold`, and `default` covers the ones a table does not list — but a bucket that is neither listed nor covered by `default` is **uncapped**, so a cap is only ever what you asked for.

At the cap, that account receives **nothing**:

- rotation skips it, reporting `capped` (or `advisor-capped`) in `teamclaude status`;
- the all-exhausted revalidation probe skips it, unlike a `switchThreshold` decision;
- a pinned request (`TC_ACCT`, `/tc-acct/<name>`) gets the exhausted answer rather than spending past the cap. A pin still never leaks to another account.

Caps are model-scoped exactly like thresholds. `unified5h` and `unified7d` stop every model; `unified7dFable` stops only Fable, so the example above keeps serving Opus and Sonnet from the same account after Fable is done. The cap binds at the level you set (`>=`), and a window that has reset is never capped on the old reading.

A cap shows on the status screen before it binds — marked on the bar it applies to, named in percent beside it, and reflected in the `Models` row:

```
  Session  [██░░░░░░░░░┃░░░░░░] 10% cap 60%
  Weekly   [███████████┃░░░░░░] 62% cap 60%
  Fable    [██░░░░░░░░░░░░┃░░░] 10% cap 80%
  Models   Opus ✗   Fable ✗
  Blocked  account usage cap reached (maxUsage)
```

The mark stays inside the bar rather than widening it, so capped and uncapped rows still line up. In the TUI the bar reddens at the cap instead of at the switch threshold.

Edits apply live on config reload — no restart.

## Hold on exhaustion

By default, when all accounts are exhausted TeamClaude returns a `429` immediately, which causes Claude Code to abort the current task. With `holdSeconds` set, the proxy **holds the HTTP connection open** instead and polls silently every ~60 seconds; the instant any account's quota resets, the request is forwarded and Claude Code resumes — the interruption never happens.

Set it in the config file (`~/.config/teamclaude.json`):

```json
"holdSeconds": 3600
```

`teamclaude run` automatically raises `API_TIMEOUT_MS` on the spawned Claude Code process to `holdSeconds + 60` seconds, so the client-side timeout covers the full hold window. No manual Claude Code configuration is needed.

Useful for overnight or unattended runs: rather than waking up to a stopped task, the session resumes silently once a quota window opens.
