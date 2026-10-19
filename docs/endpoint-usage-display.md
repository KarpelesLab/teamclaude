# Endpoint usage display

Press `u` on the gateway screen, or open Settings → Usage display. Select an endpoint with ↑/↓ and change its display with ←/→ or Enter. Each choice saves immediately.

- **Auto** shows account balance when a balance source has returned data, otherwise the existing quota display.
- **Session** shows session and weekly quota. An endpoint without those measurements shows unknown values.
- **Balance** shows the API credit in each currency. It does not invent a percentage or convert currencies.

DeepSeek can use Balance while Antigravity uses Session on the same screen. The display setting does not change routing, account priority, or quota admission. Switching back to Session preserves the existing session measurements.

Configure an account without placing a secret in this file:

```json
{
  "name": "deepseek-v4-pro",
  "usageDisplay": "balance",
  "balanceSource": {
    "type": "deepseek-balance",
    "tokenFile": "~/.deepseek-token"
  }
}
```

The token file remains outside Git. DeepSeek balance is read from its official `/user/balance` endpoint. Error bodies are never displayed because providers may echo credential material. Balances are separate from the session quota source and are refreshed by the existing quota probe; `p` also refreshes them on demand. A failed refresh retains the prior reading and labels it “last reading”; readings older than fifteen minutes carry the same label. An endpoint without a balance source displays “Balance unavailable”. The status API and text status command use the same per-account display preference.

Native Claude can opt into `quotaAdmission: "upstream"` when its rounded usage meter reports exhaustion but inference still allows requests. This delegates advisory percentage admission to inference responses for that account only; actual upstream 429 holds, authentication failures, disabled status, token budgets, and model-specific advisor limits remain enforced. The default for all other accounts remains usage-based admission.
