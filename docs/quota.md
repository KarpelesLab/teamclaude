# Quota

How TeamClaude learns each account's quota, the two optional background jobs, and what happens when everything is spent.

## How quota is observed

TeamClaude is **passive** by default: it reads `anthropic-ratelimit-unified-*` headers off the responses that flow through it. An account that hasn't served a request yet shows unknown quota until rotation first reaches it.

Observed quota is persisted to `teamclaude.state.json` next to the config, so rotation state survives a restart. Stale windows are discarded automatically, and the file is safe to delete — quota is simply re-learned from traffic.

### Accounts without a 5-hour window

Not every subscription meters both windows. Anthropic is removing the 5-hour limit from its **Ultra** plan (the former Max 20x) one verified account at a time, while the weekly limit stays; some Codex plans have never had one. Such an account rotates on its weekly window alone. TeamClaude records the fact per account (`sessionWindowStated: false` in `teamclaude status --json`), keeps it across restarts, and reads it from either source:

- A **response** that states the weekly window and carries no `anthropic-ratelimit-unified-5h-*` header at all. Only a response that was served counts: an error status, or a `rejected` overall, weekly or Fable status, is no evidence about the plan, since a weekly-rejection 429 on a metered account can carry the weekly headers alone. A 5-hour reading taken before the change is left in place and keeps gating until its own reset: one response is weaker evidence of absence than the usage endpoint. A reading with no reset is cleared instead, since nothing would ever expire it: an idle account reads 0% with no reset, which would otherwise show as a Session row at 0% for good. A reading that runs out on such an account counts as a session reset, the event that can move rotation onto an account whose weekly window ends sooner, only when it was holding the account out of rotation (at its `unified5h` switch threshold or `maxUsage` cap): its expiry then brings the account back just as a reset does. A reading below both kept nothing out, and no fresh 5-hour allowance follows it.
- The **[quota probe](#quota-probe)**, when its payload has a weekly reading and names no 5-hour window: `five_hour` carries neither a utilization nor a reset, and the `limits` list, where the payload has one, has no `session` entry. A payload that still names the window without a reading concludes nothing, the same as a response carrying a 5-hour reset without its utilization. The probe reads every limit at once, so it also clears a 5-hour reading left from before the change, along with a stored upstream `rejected` verdict, unless a weekly reading at its switch threshold still accounts for that verdict. Clearing a reading that was holding the account out of rotation counts as a session reset, by the same rule as a reading that runs out.

On the Anthropic side only a subscription records it from headers; a third-party backend that answers in Anthropic's header names does not. [Keep-warm](#keep-warm) skips the account from then on. Once no 5-hour reading is left (cleared as above, or run out at its reset), `teamclaude status`, the TUI and the dashboard drop the Session row (the TUI row draws the weekly bar alone: across both bar cells where the table draws two, in the one slot where it draws one; see [usage](usage.md)), and a `unified5h` switch threshold or `maxUsage` cap has nothing to apply to. Until then the old reading is still drawn, and still gates, as it would on any account. A response or probe that states a 5-hour window again (a downgrade, or the limit coming back) reverses all of it.

The wire shape after the change has not been seen on a live Ultra account yet. The rule above assumes the 5-hour headers are simply dropped and the usage endpoint reports `five_hour` as null or leaves it out, and drops the `session` entry from `limits`.

## Fleet quota endpoint

`GET /teamclaude/quota` returns the quota data intended for lightweight consumers such as a Claude Code status line. It includes every account's observed limits plus tier-weighted fleet aggregates for the shared 5-hour window, shared weekly window, Sonnet weekly window, and Fable weekly window. Sonnet and Fable fall back to the shared weekly bucket on accounts where Anthropic does not report a dedicated bucket. Windows reported by a third-party backend (see below) fill the `fiveHour`, `weeklyShared` and `monthly` buckets with a `backend*` source on accounts that have no Anthropic readings of their own; `monthly` exists only for such backends. Backend windows join only the per-account buckets: they are excluded from the aggregates by source, whatever tier the account claims. Each backend bucket also carries `observedAt`, the millisecond timestamp of the probe that read it: a probe that fails keeps the last good reading rather than clearing it, and a window with no reset never expires, so the age is what tells a fresh value from an old one. Its top-level `warmup` object reports whether keep-warm is off, interval-based, scheduled for a daily reset target, or running on an anchored five-hour cadence. Scheduled modes include the configured timezone, missed-run policy, and next warm-up/reset timestamps; rolling mode also includes `anchorResetAt`, `cadenceSeconds`, `nearResetToleranceSeconds`, and `postResetBufferSeconds`.

Subscription capacity is weighted relative to Claude Pro: Pro and Team Standard are `1`, Max 5x and Team tier 1 are `5`, and Max 20x and Team tier 2 are `20`. Anthropic renamed Max 20x to Ultra (at the same weekly limit) and Max 5x to Max on 2026-10-30, and the tier string a renamed account reports has not been observed yet. A rate-limit tier containing `ultra` is weighed as `20`; any other new string, such as one for the renamed Max plan that no longer contains `5x`, is reported under `unknownTiers` until it has been observed and added. The `fiveHour` aggregate covers the accounts that hold a 5-hour reading. An account [without that window](#accounts-without-a-5-hour-window) stops contributing to it once its last reading is gone, cleared by a probe, reaching its own reset, or carrying no reset at all; a response alone leaves the reading in place, so until then it still counts, as it still gates selection. It counts towards the weekly aggregates either way. Each entry under `accounts` carries `sessionWindow`: `false` when the plan meters no 5-hour window, `true` when it does, `null` before a reading has said; it tells "no limit" from "not reported yet", where `buckets.fiveHour` is null for both. The `fiveHour` aggregate also carries `exemptAccounts` and `exemptWeight`, the count and tier weight of the accounts it leaves out for that reason (only accounts with a tier weight: a Codex account has none, so a Codex plan without the window is in neither the aggregate nor these counts), so a consumer can tell a nearly spent session quota from one that applies to a small part of the fleet. When no account holds a 5-hour reading the aggregate is `null`, as before, and the per-account `sessionWindow` says why. TeamClaude reads the organization and seat tier from the OAuth profile. An unrecognized tier remains visible under `accounts` and `unknownTiers` but is excluded from the aggregate instead of being assigned a guessed weight. API-key token and request limits remain per-account because their units cannot be combined with subscription utilization.

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

It reads each OAuth account's utilization from its provider's read-only usage endpoint, which reports quota **without consuming any message quota**. Anthropic accounts use `/api/oauth/usage`; Codex accounts use ChatGPT's internal `/backend-api/wham/usage` endpoint and require their `ChatGPT-Account-Id`. API-key and third-party accounts are skipped. The Codex endpoint is not part of the public OpenAI API and may change without notice. Minimum interval is 30s. Changing it takes effect on a running server immediately.

Disabled accounts are skipped by default. Set [`probeDisabledAccounts`](configuration.md) to `true` (or **g** → Probe disabled in the TUI) to keep their quota fresh too. The probe then refreshes a disabled account's OAuth token when it is due, as it does for any other account.

The probe is also the only source for the **Sonnet 7-day** bucket, when your plan exposes it. The Fable weekly bucket arrives passively in the response headers (`anthropic-ratelimit-unified-7d_oi-*`), so Fable-aware routing works without turning the probe on. Both families are read from the payload's `limits[]`, where upstream enumerates the model-scoped weekly caps an account actually has.

It is likewise the only source for Claude's [banked usage-limit resets](accounts.md#claude-banked-usage-limit-resets), read from the same call.

For Anthropic accounts the probe also reads the OAuth profile (`/api/oauth/profile`, also zero-spend): on every cycle while the account has no plan or tier on record, then on the first cycle at least an hour after the last read. A profile that stops showing the account's Max or Pro plan is reported in status; see [When a plan lapses](accounts.md#when-a-plan-lapses).

### Revalidating a spent family bucket

Those `7d_oi` headers ride on **Fable responses only** — no other model's response carries them. That makes a spent Fable (or Sonnet) reading self-sealing: once it reads at or above the switch threshold, rotation stops sending that family to the account, which is also the only thing that could have refreshed the reading ([#167](https://github.com/KarpelesLab/teamclaude/issues/167)).

So a spent family reading is trusted for 30 minutes. After that it is dropped, the family falls back to the shared weekly bucket, and the next request of that family re-establishes the truth from real headers — a rejection re-arms the gate with a fresh reading for another 30 minutes, so a genuinely spent bucket costs at most one rejected request per account per window. Set `TEAMCLAUDE_FAMILY_STALE_MS` to tune the window. Readings with headroom are never dropped: they gate nothing.

Running the probe sidesteps this entirely — it refreshes the family buckets from the usage endpoint without spending quota, so a reset is picked up within one probe interval instead of within the staleness window.

A probe revalidates a family bucket in full, which includes concluding that there is no cap. When the payload enumerates an account's scoped weekly caps and a family is **not** among them, the cached reading is cleared and that family falls back to the shared weekly bucket — upstream retiring a cap must not leave the proxy gating on it. A payload that carries no such enumeration proves nothing, so nothing changes. Each reported bucket also carries its own reset, taken verbatim: an unstarted window has no reset, and the bar shows no date rather than the shared weekly one.

## Spend from outside the proxy

An account in the pool can also be used somewhere else — a local login, a credentials file on another machine — and that spend lands on the same weekly limit while none of the proxy's counters see it. `quota.outsideSpend` in `/teamclaude/status` reports how much of each weekly window was spent elsewhere, as a share of that week:

```json
"outsideSpend": {
  "unified7d": { "share": 0.04, "state": "measured", "since": "2026-10-05T08:00:00.000Z" },
  "unified7dFable": { "share": null, "state": "not_measurable", "since": "2026-10-05T08:00:00.000Z" }
}
```

`teamclaude status` and the dashboard show the same thing in one line: `4.0% of the week went elsewhere · Fable week: not measurable`.

How it is attributed. Between two fresh readings of one window on one account:

| the utilization rose and | attribution |
|---|---|
| the proxy served nothing on that account | **outside** — the whole rise |
| the proxy served at least one request | unattributable — not counted |

A request counts as served from the moment it is dispatched until its response has fully ended, so a long stream keeps the account busy for its whole length — and for a two-minute settle time after it, because the usage endpoint can trail a response, and a reading taken before our own spend has landed would otherwise show it as a rise across an "idle" interval. Only a rise above the highest reading of the window counts, so a reading that wobbles down and back up is never counted twice. The sum restarts when the window resets.

Two properties to keep in mind when reading it:

- **It is a floor, not an estimate.** Spend elsewhere while this proxy was also serving the account cannot be split out, so it is not counted. Reading more often does not tighten it; only the proxy being idle on the account more often does.
- **It depends on the probe for idle accounts.** A response only ever reports quota for a request this proxy served, so the idle intervals the figure is built from end in a [quota probe](#quota-probe) reading. With the probe off, an account the proxy is not routing to gets no fresh readings and its outside spend is invisible, not absent.

Each window is in one of three states, and only the first carries a number:

| `state` | meaning |
|---|---|
| `measured` | at least one idle interval was observed in this window; `share` is the outside spend over those intervals (`0` is a real answer: idle, and nothing moved) |
| `not_measurable` | there were fresh readings, but the proxy was serving the account across every interval between them |
| `not_observed` | fewer than two fresh readings in this window — typically the probe is off and the account was not routed to |

`since` is when tracking of the current window started (the first fresh reading of it). Only weekly windows are tracked — the all-models weekly and any family bucket the account reports. The 5h window rolls over too often for a floor to say anything. The sums persist in `teamclaude.state.json`; the interval spanning a restart is never attributed to the outside, since the proxy cannot know what it served while it was down.

## Burn-rate forecast

The burn-rate learner behind [adaptive distribution](routing.md#adaptive-distribution) runs in every mode. `quota.forecast` in `/teamclaude/status` reads it out per weekly window: the learned rate, and when the account reaches its switch threshold at that rate, next to when the window resets.

```json
"forecast": {
  "unified7d": { "ratePerHour": 0.0029, "threshold": 0.98, "reachesThresholdAt": 1780000000000, "resetAt": 1780090000000 }
}
```

`ratePerHour` is a share of the window per hour (`0.0029` is 0.29% an hour). `reachesThresholdAt` and `resetAt` are ms epoch, like the quota's own `*Reset` fields. `threshold` is the account's own [switch threshold](#switch-threshold) for that window. A family bucket that has no field of its own (`scoped:opus`) is gated against the shared weekly threshold, and is forecast against it too.

`teamclaude status` and the dashboard say something only when it matters: `week reaches 98% in ~31h, resets in 52h`. A window that resets before it reaches the threshold is the good case and gets no sentence.

`null` means "no answer", never "never":

| field | `null` when |
|---|---|
| `ratePerHour` | the learner has no rate for this window yet; the assumed starting rate (`initialBurnRate`) is never reported as one |
| `reachesThresholdAt` | no rate, a rate of zero, the account is already at or above its threshold, the window's reset has passed and the reading is from the old window, or the reach time is more than 14 days ahead. The learned rate decays toward zero on an idle account without reaching it, so without that limit an idle account would report a time centuries away, or one that is not a valid date. A weekly window resets within 7 days, so a time past 14 days never comes before a reset. It can lie in the past when the reading is old |
| `resetAt` | the window reports no reset, or it has passed |

What the rate is. It is the learner's moving average of how fast utilization rose, measured over windows of `burnWindowMs` between readings no more than `maxSampleAgeMs` apart (see [`adaptiveDistribution`](configuration.md)). It counts all spend on the account, the proxy's and [outside spend](#spend-from-outside-the-proxy) alike. Like any moving average it reflects the recent past: a burst that has stopped keeps the forecast short until flat readings bring the rate down, and an account with no fresh readings keeps its last rate. The projection starts when the utilization was read, not at the status read, so an old reading counts down rather than repeating the same distance; once its projected time has passed, the status text drops it. With the [quota probe](#quota-probe) off, an idle account gets no readings, so its forecast is as old as its last traffic.

## Fleet forecast

The burn-rate forecast answers for one account. The fleet forecast ([#550](https://github.com/KarpelesLab/teamclaude/issues/550)) answers for the whole pool: when is every account out at once, and when does the first one come back? `fleetForecast` in `/teamclaude/status`:

```json
"fleetForecast": { "allOutAt": 1780000000000, "firstBackAt": 1780014400000, "boundBy": "weekly", "ratePerDay": 1.38 }
```

`allOutAt` is the first moment every account is blocked (the current time when they all already are), and `firstBackAt` the first moment after it that one is usable again; both are ms epoch. `boundBy` is the bucket that blocks most of the fleet at `allOutAt`: `weekly` or `5h`. `ratePerDay` is the fleet's measured weekly spend, in shares of one account's week per day (`1.38` uses 138% of a week per day, spread over the accounts).

`teamclaude status` and the dashboard show it as one line, only when there is a forecast: `all accounts out in ~31h (weekly), first back 4h later`.

It is `null` until the proxy has 48 hours of samples, `null` when the samples cover too little of a rate window to trust (under 6 hours of the weekly window, or under 1 hour of the last 6 hours), and `null` when nothing runs out within 14 days.

How it works. Every 15 minutes the proxy stores one sample per account from the readings it already has: weekly and 5-hour utilization and when each window resets. It makes no extra upstream call, so an account is sampled only once the proxy has read it, from traffic or the [quota probe](#quota-probe). The forecast then simulates the fleet forward from the current readings:

- Each bucket has its own measured rate. The weekly rate is the fleet's summed weekly increase over the last 24 hours, or the last 7 days once the samples cover at least 6 of them, shaped by hour of day (UTC): a flat evening rate carried through the night would call the wall too early. The 5-hour rate is the summed increase over the last 6 hours, flat. Each rate is divided by the time the samples actually cover inside its window, not by the whole window: two samples more than 30 minutes apart are a gap, such as a stopped proxy, and a gap does not count as a quiet fleet.
- Spend goes to the fullest account still under its [switch thresholds](#switch-threshold), as rotation does, so the order in which accounts fill is the order they would be used.
- An account is blocked while either bucket is at or over its threshold, and comes back at that bucket's reset. A weekly reset is followed by the next one 7 days later, a 5-hour reset by the next one 5 hours later.

A window reset shows in the samples as a drop, or as an empty reading where the proxy had cleared the window at its reset; a drop is never counted as negative spend, and the first reading of the new window counts in full. The forecast covers Anthropic subscription accounts in rotation. Codex accounts are a separate pool, a disabled account is not in rotation, and an API key meters no window.

The samples are kept in `teamclaude.quota-series.json` next to the config, not in the state file. The file is written atomically, keeps 7 days and at most 800 samples per account, and drops the history of an account at the next sample after it is removed. A missing or corrupt file is empty history, so it is safe to delete; the forecast is `null` again until 48 hours of new samples accumulate.

## Keep-warm

The rolling **5-hour session window** only starts once an account sends a real message. So when your active account runs out and rotation moves to a cold account, that account's 5h window starts *then* — right when you need its full headroom. Keep-warm ([#76](https://github.com/KarpelesLab/teamclaude/issues/76)) starts the timer on idle accounts ahead of time, so the next account is already partway (or fully) through a fresh window when it's needed.

```bash
teamclaude warmup 600                                      # warm idle accounts every 600s
teamclaude warmup reset 15:30 --timezone Europe/Moscow     # target a daily 15:30 reset
teamclaude warmup rolling 15:30 --timezone Europe/Moscow   # anchor resets at 15:30, then every 5h
teamclaude warmup off                                      # disable either mode
teamclaude warmup                                          # show current setting
```

> ⚠️ **This spends a little quota — unlike the passive quota probe.** The 5h timer can't be started by a read-only call, so keep-warm sends a real (minimal) message: for each eligible idle account it spawns a one-shot `claude -p --bare --model haiku --output-format text "hi"` pointed at this proxy, pinned to that account. It only warms accounts whose 5h window is **not already running**, skips disabled/throttled/errored, third-party-backend and Codex accounts and any account that [meters no 5-hour window](#accounts-without-a-5-hour-window), and uses the cheapest model — but it does consume a few tokens and a slice of the 5h/weekly buckets per account per window. It looks for the `claude` CLI on `PATH`, then in `~/.local/bin`, which is where the native installer puts it. A proxy already running as a service finds that binary without another `service install`. Minimum interval 60s; changes apply live. Status shows under `warm` in `teamclaude status --json`.

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

### Per-account thresholds

The fleet-wide setting above is one number (or one table) for every account, which doesn't fit a mixed fleet: one account with extra usage bought and one without, or a Max 20x account next to a Pro one that should rotate off much sooner ([#409](https://github.com/KarpelesLab/teamclaude/issues/409)). `accounts[].switchThreshold` overrides it per account, same two shapes:

```json
{ "name": "extra-usage@example.com", "switchThreshold": 1.0 }
```

```json
{ "name": "small-plan@example.com", "switchThreshold": 0.9 }
```

Resolution is per bucket, not all-or-nothing: for a given bucket, TeamClaude checks the account table's entry for that bucket, then the account's own `default` (or a bare per-account number), and only then falls back to the fleet's own `switchThreshold` for that bucket. So a table that names only one bucket overrides just that one and inherits every other bucket from the fleet setting:

```json
{ "name": "b@example.com", "switchThreshold": { "unified7dFable": 0.8 } }
```

leaves `b`'s `unified5h` and `unified7d` on whatever the fleet has configured, and only rotates Fable off at 80%.

It is still a **preference**, exactly like the fleet setting: the all-exhausted revalidation probe can override it the same way, which is what keeps it a different setting from the hard `accounts[].maxUsage` cap above. The account's own value is what the bars, the `Models` row, and `teamclaude status` redden against for that account — see [Per-account usage caps](#per-account-usage-caps) for how the two ceilings are drawn together when both are set.

An override shows up wherever the account itself does — `teamclaude status`, the TUI (live and attach mode), and the web dashboard — but only where it actually moves something: an account with no `switchThreshold`, or one whose table happens to repeat the fleet's own numbers, draws no extra line. `teamclaude status` shows it as its own row:

```
  Weekly   [███████████░░░░░░] 62%
  Fable    [██░░░░░░░░░░░░░░░] 10%
  Models   Opus ✓   Fable ✓
  Switch   switch fable 80%
```

A bare-number override reads `switch at 100%` instead. The TUI and the dashboard show the identical compact text as a trailing tag / badge on the account's own row or card, rather than a mark on the bar — unlike `maxUsage`, `switchThreshold` was never drawn as a percentage on the bar itself (only as the point past which the bar goes red), so there was no existing mark to extend.

A bare number whose default matches the fleet's can still move a bucket, because it outranks the fleet's per-bucket entries: with a fleet `{ "default": 0.98, "unified7d": 0.85 }`, an account set to `0.98` rotates off the weekly bucket at 98%, not 85%, and is shown as `switch 7d 98%`.

No CLI editor for this one, matching `maxUsage`: hand-edit the config and let a running server pick it up on reload, or restart. Values are ratios: a number must be above 0 and at most 1 (`1.0` is valid, `98` is not). An out-of-range or non-numeric entry is ignored, the account falls back to the fleet value for it, and one log line names the account and the field. When any account is opted into `allowExtraUsage`, the fallback spends quota between this threshold and 100% before any account is billed; a reserve that must hold is `maxUsage`.

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
- a pinned request (`TC_ACCT`, `/tc-acct/<name>`) gets the exhausted answer rather than spending past the cap. A pin still never leaks to another account;
- the paid fallback, and the last-resort revival of a throttled account when nothing is available, skip it too;
- a request that waited in admission is checked again before it is sent, and moves elsewhere if a reading during the wait put the account at its cap;
- an advisor request also checks the advisor model's own family cap on every one of these paths (under `advisorEligibility: "prefer"` the advisor is a preference, so only the executor's caps apply).

A family reading (Fable, Sonnet) at or past the cap is kept until its window resets, or for a week when no reset time is known. An uncapped spent family reading is revalidated after 30 minutes instead, because only a request of that family can refresh it; for a capped one that request would go past the cap.

With [expiry-pressure routing](routing.md#expiry-pressure-routing) on, a capped account's pressure is the room left under its cap, not under 100%: an account at 0.6 with a 0.7 cap has 0.1 to spend before its reset. For a family window the shared weekly cap also bounds that room, since family spend counts against both.

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

## Per-account spend caps

A usage cap is about quota. On a seat with **extra usage** enabled the interesting ceiling is money: past 100% of its included quota such an account keeps serving and bills the organization for it. The switch threshold rotates away at 98%, and a `maxUsage` of `1.0` refuses the account at exactly 100%, but a reading is whole percents refreshed by the probe, and a request in flight when the bucket fills is billed. `accounts[].maxSpend` is the ceiling on that:

```json
{ "name": "work@example.com", "type": "oauth", "maxSpend": 20 }
```

Written in the account's billing currency (`20` is $20.00), and judged against the month-to-date extra-usage figure the usage endpoint reports — the same figure `teamclaude status` prints as `$14.35 of $10,000.00 used this month`. At the cap the account stops **billing**, not serving: for the rest of the month it is held to its included quota, as if every bucket a request meters had a hard `maxUsage` of `1.0`. A request is admitted only when it is provably free — the shared session (5h) and weekly readings both known and under 100%, and for a model with its own weekly bucket (Fable, Sonnet, or a route's `bucket`) that bucket under 100% too, since family usage meters into both. Anything else — a bucket at 100%, a shared reading not yet taken or past its reset, a fresh upstream `rejected` status — bars the request, because an unknown reading is no proof the request is free. A family bucket with no reading is the exception: most plans meter no Sonnet bucket, and a family window past its reset starts again from zero, so the shared buckets govern, as they do everywhere else. A plan that states it meters no weekly window (a Team seat) is judged on its session window alone. A barred request is skipped exactly like a usage cap: rotation skips the account, the exhausted-fleet probe skips it, the [extra-usage fallback](#extra-usage-fallback) never bills it, a pin gets the exhausted answer. So a Fable request can be barred while Opus still runs on the same account. When upstream's figure resets with the month, the next probe lifts the cap by itself.

**`maxSpend` requires the quota probe.** The spend figure comes only from probe readings — a response carries no month-to-date amount — so it is refreshed on the probe's schedule (`quotaProbeSeconds`, or `teamclaude probe N`; see [Quota probe](#quota-probe)) and by the TUI's **`p`** refresh, never by the request in flight. The cap therefore binds within one probe interval of the figure being reached, not on the request that crosses it: what one interval can bill is the slack to budget for, and with the probe off the figure only moves when you press **`p`**, so the cap effectively never binds.

- The cap binds at the level set (`>=`). `0` means "not one cent": an account that has billed nothing is still admitted, the first billed cent bars it.
- Only an account that **can** bill is judged. With extra usage off upstream no request costs money, and barring the account would only waste the quota it still has.
- It is a total, not a preference — nothing overrides it. Combine it with `"maxUsage": 1.0` to stop before billing can start, and keep `maxSpend` as the backstop: it bounds the month's total to the cap plus whatever one probe interval can bill, not to the cent. The same slack applies once the cap holds: the bucket readings are refreshed by responses and the probe, so a request in flight when a bucket fills is billed.

The TUI row shows the amount once anything has been billed, and the cap after it: `$14.35/20`. `teamclaude status` prints the same on the account's `Spend` line, and says `spend cap reached` there once the figure reaches it. The account's unavailable reason reads `extra-usage spend cap reached (maxSpend)` only while the cap bars it, judged on the shared session and weekly buckets; a bar on one model family alone (Fable, say) applies per request and does not show there.

No CLI editor, matching `maxUsage`: hand-edit the config and let a running server pick it up on reload (**`R`** in the TUI, or `POST /teamclaude/reload`).

## Extra-usage fallback

> **This spends real money.** An account with Anthropic's "extra usage" (paid overage) enabled does not stop at its plan limit — it keeps serving and bills for it. Opt in only for accounts whose overage you are prepared to pay for.

By default, once every account is past its switch threshold the proxy answers 429 (or holds the request, with `holdSeconds`), apart from the throttled revalidation probe. `accounts[].allowExtraUsage: true` lets the fleet keep serving instead — on the free quota any account still has past its threshold first, and on the opted-in account's overage only once no free quota is left anywhere:

```json
{
  "name": "team@example.com",
  "allowExtraUsage": true,
  "maxUsage": { "unified7d": 1.5 }
}
```

- **Rotation is unchanged.** An opted-in account rotates away at `switchThreshold` like any other, and the fallback never runs while any account can serve under the normal rules — a lower-priority one included.
- **Free quota first.** The switch threshold is a rotation preference, so an account between it and 100% — under a per-bucket `unified7d: 0.85`, that is 15% of the week — still has quota you already pay for. Once nothing is under its threshold, the fallback serves from the best such account, **opted in or not**, chosen by `priority` (lower first) and then the most free quota left. No money moves while any account can still serve for free.
- **Billing is the last resort.** An opted-in account is billed only when every account that could serve at all is at 100% of a governing bucket or carries upstream's own `rejected` verdict. Among several opted-in accounts: `priority`, then the least deep into overage. An account that cannot serve at all — `disabled`, over its `maxUsage` cap, in an `error` state, under an entitlement cooldown or a live 429 hold — is neither used nor waited for: it does not count as free quota, and the fallback proceeds without it.
- **Needs the whole partition spent.** An account that never reports quota — a third-party backend or an API key with no limits — always counts as able to serve, so with one configured an opted-in account is never billed.
- **After the free probe.** The fallback runs where the proxy would otherwise have nothing: after the normal walk, and after the free revalidation probe, which still goes first when it is due because headroom it finds costs nothing. If that probe is refused, the same request retries through the fallback rather than returning 429. The 429/5xx failover hops reach it too, but only when nothing in the fleet is under its threshold — a hop off an account that is merely rate-limited for a minute waits that out as before rather than spending quota, free or paid.
- **It goes back on its own.** As soon as any account's window resets — the paid one's included — selection returns to normal, and the "billing" mark clears even if no request for that model has come in since.
- **Only the quota verdicts are overridden** — the switch threshold (a spent Fable bucket included, for Fable requests only) and, for the paid tier, a remembered upstream `rejected` status. Everything else still binds: `disabled`, `maxUsage`, `maxSpend`, a live upstream 429 hold, an entitlement cooldown, an error state, routes and model ownership, and the Claude/Codex partition. An account whose usage probe reports overage switched off upstream is skipped, since it would only 429; with no probe data, upstream decides.

Utilization goes past 100% in overage, so `maxUsage` above 1.0 is a spend limit: `"maxUsage": 1.5` lets an account run to 150% of its plan and then stop, like any other cap. To bound the bill in money instead, set `maxSpend` — see [Per-account spend caps](#per-account-spend-caps) above; the fallback never bills an account at its spend cap (it may still use that account's free quota, like any other).

The switch onto the fallback and back off it is logged once each, per model scope (a Fable-only episode is not ended by Opus traffic that still has headroom), and a failover hop onto it is logged once per episode too — the free-quota and the paid step each get their own line. While an account is **billing** — at 100% of a governing bucket, or with its month's spend seen rising — `teamclaude status` marks it:

```
  Blocked  local switch threshold reached — serving on extra usage (paid overage), billing
```

and the status payload carries `allowExtraUsage` and `onExtraUsage` per account; `onExtraUsage` is false while the fallback is only serving free quota past a threshold. The opt-in itself is visible before it is ever used: `extra usage allowed` in the account header of `teamclaude status`, an `xu` tag (yellow) at the end of the TUI row that turns into a red `xu!` while billing, and an `extra usage allowed` / `on extra usage — billing` badge on the web dashboard. With the quota probe on, the `Spend` row shows what has been billed this month.

Edits apply live on config reload — turning it off stops the spending immediately.

## Third-party backend quota

A [third-party backend account](accounts.md#third-party-backend-accounts) has no Anthropic quota, so its bars read `unknown`. Where the provider publishes a figure of its own, the probe reads it on the same schedule and status shows it:

```
  deepseek (oauth, prio 200) active
  Balance  $25.81
  Probe    ok 2m ago, 210ms
```

The reading is normalized to `{ label, text, utilization }`, with a `windows` map when the provider reports distinct windows. The TUI draws those windows as the account row's Ses/Wk bars, plus a Mon bar when a monthly window exists; rotation thresholds do not apply to them, since nothing gates a backend on them. A row with probed windows draws them in place of the metered Tok/Req pair. A plan with a monthly window and no weekly one draws the month in the Wk slot. A provider that reports a 0-1 fraction gets a bar like any other bucket; one that reports money or credits shows its text. A provider that publishes nothing keeps reading `unknown` — nothing is invented.

With `synthesizeQuotaHeaders: true` the probed 5-hour and weekly windows are also stated to the client as `anthropic-ratelimit-unified-*` headers, so Claude Code shows them in its own `rate_limits` like an Anthropic account's. A monthly window has no such header and is only on `GET /teamclaude/quota`. See [configuration](configuration.md).

Provider support lives entirely in `src/backend-quota.js`, matched by the host of the account's `upstream`. Adding one is a single entry there (a path and a parse function, plus a header shape when the provider's monitor wants something other than a bearer, plus an optional balance hook); the prober, the quota field and the renderer never name a provider. Supported today:

- **DeepSeek** — the account balance, as money.
- **NanoGPT** (`api.nano-gpt.com`) — the subscription's daily and weekly token windows in one reading: the bar is the fuller of the two, the text names each with its reset, and NanoGPT's own billing advice is appended when it is not the ordinary case:

  ```
    nano-gpt (oauth, prio 100) active
    Plan     [██░░░░░░░░░░░░░░░░] 37% · day 12% (resets 5h10m) · week 37% (resets 3d4h)
    Plan     [██████████████████] 100% · day 104% (resets 1h) · week 37% (resets 3d4h) · billing balance
  ```

  `billing balance` means the subscription window is spent and the gateway will serve the next request from the pay-as-you-go balance instead of refusing it — the one line to watch on a metered plan. `balance not allowed` means your NanoGPT spend policy forbids that and requests will fail instead.
- **Z.ai GLM Coding Plan** (`api.z.ai`, and `open.bigmodel.cn` for the mainland plan) — the plan's two token windows as used-percentages, in one reading: the bar is the fuller of the two, the text names each with its reset. A pay-as-you-go balance, when the account carries one, is appended to the text; when the plan reports no usable windows, a non-zero balance is the reading instead. A zero balance never stands in for the windows: that is what a healthy subscription account reads, and it would mask a monitor outage. For the mainland plan the balance report lives on the console host `www.bigmodel.cn`, so the account's key goes there rather than to the API host.

  ```
    z.ai (oauth, prio 100) active
    Plan     [██░░░░░░░░░░░░░░░░] 12% · 5h 12% (resets 2h10m) · week 37% (resets 3d4h)
  ```
- **Kimi for Coding** (`api.kimi.com`, `api.kimi.ai`) — whichever of the 5-hour, weekly and monthly windows the plan reports, in one reading. Plans differ here (newer ones drop the weekly window for a monthly one), so any of the three may be absent, and an absent one is never filled in from Kimi's legacy counters. Kimi's ratio pools lag behind an active session and can read zero while the legacy counters move; a zero ratio beside a moved counter with the same reset is treated as a placeholder and the counter wins.
- **Moonshot Open Platform** (`api.moonshot.ai`, `api.moonshot.cn`) — the pay-as-you-go balance, as money in the region's currency.

## Hold on exhaustion

By default, when all accounts are exhausted TeamClaude returns a `429` immediately, which causes Claude Code to abort the current task. With `holdSeconds` set, the proxy **holds the HTTP connection open** instead and polls silently every ~60 seconds; the instant any account's quota resets, the request is forwarded and Claude Code resumes — the interruption never happens.

The refusal is still a `rate_limit_error` with the same message and `retry-after` header. Its body also carries `error.details`, so a client or a monitoring system can tell it from an upstream rate limit without reading the sentence. `error_code` is `pool_exhausted` when eligible accounts exist but are blocked, and `no_eligible_account` when none can serve the request at all (a configuration problem, not exhaustion). `retry_after_seconds` matches the header. `resets_at` is the ISO-8601 time the blocking window actually lifts, or `null` when no reset is known: a dead credential, an untimed block, or no eligible account.

Set it in the config file (`~/.config/teamclaude.json`):

```json
"holdSeconds": 3600
```

`teamclaude run` automatically raises `API_TIMEOUT_MS` on the spawned Claude Code process to `holdSeconds + 60` seconds, so the client-side timeout covers the full hold window. No manual Claude Code configuration is needed.

Useful for overnight or unattended runs: rather than waking up to a stopped task, the session resumes silently once a quota window opens.
