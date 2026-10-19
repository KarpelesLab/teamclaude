# Sanitized deployment configuration

These snapshots describe the Europa and Windows gateway layouts using this branch's configuration format. Every key and token is replaced with `SET_LOCALLY`. Account identity metadata and credential expiry timestamps are omitted. The examples are documentation, not runnable production credentials.

Keep live configuration and credentials outside the checkout. Restore local credentials or import the Claude account before starting a gateway. Do not replace a live config with an example without first supplying the local credentials. DeepSeek's token is referenced by file path only. On Windows the native Node process reads the WSL-owned credential through its UNC path; set the distribution and username for your machine.

The examples retain endpoint model maps and route priority, `quotaAdmission`, `balanceSource`, and each endpoint's `usageDisplay`. DeepSeek defaults to Balance; Antigravity defaults to Session. Press `u` in the running gateway to choose another format for an individual endpoint. The display preference is independent of inference quota admission.

This branch includes the essential upstream Remote Control credential-isolation fix from KarpelesLab/teamclaude commit `15b33ff5a11ddd59c920d96570d5aeca416c5347`. It retains the local advisor, native quota, compatibility, and usage-reporting improvements.
