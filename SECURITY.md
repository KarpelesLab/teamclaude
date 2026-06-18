# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in TeamClaude, please report it
privately rather than opening a public issue.

- Use GitHub's [private vulnerability reporting](https://github.com/KarpelesLab/teamclaude/security/advisories/new)
  ("Report a vulnerability" under the **Security** tab), or
- Email the maintainers at the address listed on the
  [KarpelesLab organization page](https://github.com/KarpelesLab).

Please include enough detail to reproduce the issue (affected version, steps,
and impact). We aim to acknowledge reports within a few days.

## Supported versions

Only the latest published release on the `master` branch and the
[`@karpeleslab/teamclaude`](https://www.npmjs.com/package/@karpeleslab/teamclaude)
npm package receive security fixes.

## Verifying you have the genuine project

TeamClaude has been impersonated by malicious soft-forks that preserve the
original commit history (and even the `@karpeleslab/teamclaude` package name)
while bundling malware — typically a binary hidden in the repository and an
install step that runs it.

Only the following sources are canonical:

- **Repository:** https://github.com/KarpelesLab/teamclaude
- **npm package:** `@karpeleslab/teamclaude` (published by KarpelesLab)

Treat any other copy with caution. In particular:

- **Do not** download and run "TeamClaude" archives (`.zip`, etc.) linked from
  third-party repositories or READMEs. TeamClaude is distributed via npm and the
  canonical GitHub repository only — it is never shipped as a downloadable
  binary archive.
- Install with `npm install -g @karpeleslab/teamclaude` and verify the package
  scope is `@karpeleslab`.
- Be suspicious of any fork that instructs you to extract an archive and then
  run `npm install` / `npm start` against its contents.

If you believe you have found a malicious copy, please report it to GitHub and,
if convenient, let us know via the channels above so we can warn other users.
