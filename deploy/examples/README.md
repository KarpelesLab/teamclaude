# Sanitized deployment configuration

These snapshots describe the Europa and Windows gateway layouts using this branch's configuration format. Every key and token is replaced with `SET_LOCALLY`. Account identity metadata and credential expiry timestamps are omitted. The examples are documentation, not runnable production credentials.

Keep live configuration and credentials outside the checkout. Restore local credentials or import the Claude account before starting a gateway. Do not replace a live config with an example without first supplying the local credentials. DeepSeek's token is referenced by file path only. On Windows the native Node process reads the WSL-owned credential through its UNC path; set the distribution and username for your machine.

The examples retain endpoint model maps and route priority, `quotaAdmission`, `balanceSource`, and each endpoint's `usageDisplay`. DeepSeek defaults to Balance; Antigravity defaults to Session. Press `u` in the running gateway to choose another format for an individual endpoint. The display preference is independent of inference quota admission.

This branch includes the essential upstream Remote Control credential-isolation fix from KarpelesLab/teamclaude commit `15b33ff5a11ddd59c920d96570d5aeca416c5347`. It retains the local advisor, native quota, compatibility, and usage-reporting improvements.

The gateway launch examples load source from the clean `gh/teamclaude` main checkout. Europa uses Node 24; Windows uses the installed native Node. The Windows agent launch wrapper should likewise point its `src/index.js` path at `$env:USERPROFILE\gh\teamclaude`. Configuration, logs and credentials stay outside that checkout.

## Educational example: account priority

This example illustrates one operator's preference, not a recommended setup step or a default provider order. With `routingPolicy.mode` set to `priority-first`, lower numeric account priorities are preferred among eligible accounts. For example:

| Account | Example priority |
| --- | ---: |
| `codex-gpt56` | -30 |
| `deepseek-v4-pro` | -20 |
| `deepseek-v4-flash` | -10 |
| Another eligible account | 0 |

In this case, Codex is preferred, followed by DeepSeek Pro and DeepSeek Flash. These are partial account settings for explanation, not a complete configuration. Route restrictions, model support, disabled accounts, quota limits, and temporary failures still determine eligibility. Priority alone does not add a model mapping or allow an account onto a restricted route. This numeric order describes `priority-first`; dynamic routing uses additional ranking rules.

Choose priorities for your own provider preferences and available capacity. The deployment snapshots above are separate examples and do not apply this order automatically.
