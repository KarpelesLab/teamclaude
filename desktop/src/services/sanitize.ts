// Redaction for anything the desktop shows or exports: backend stdout/stderr,
// CLI job output, error messages, diagnostic reports. The backend already
// keeps credentials out of its logs; this is the second line, so that a log
// line copied into an issue can never carry a token even if a future backend
// message slips one through.

const REDACTED = '[redacted]';

interface Rule {
  pattern: RegExp;
  replace: string | ((match: string, ...groups: string[]) => string);
}

const RULES: Rule[] = [
  // Anthropic keys and OAuth tokens: sk-ant-api03-…, sk-ant-oat01-…, sk-ant-ort01-…
  { pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // OpenAI-style and generic secret keys.
  { pattern: /\b(sk|rk|pk)-(proj-)?[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  // JWTs (Codex/ChatGPT access and id tokens are JWTs).
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // Authorization / x-api-key / cookie headers in any "name: value" or "name=value" form.
  {
    pattern: /\b(authorization|proxy-authorization|x-api-key|api[-_]?key|cookie|set-cookie)(["']?\s*[:=]\s*["']?)([^"'\s,;}]+(?:\s+[^"'\s,;}]+)?)/gi,
    replace: (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`,
  },
  // Bearer tokens anywhere.
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `Bearer ${REDACTED}` },
  // JSON fields that hold credentials.
  {
    pattern: /("(?:accessToken|refreshToken|idToken|access_token|refresh_token|id_token|apiKey|api_key|password|secret|clientSecret|client_secret|token)"\s*:\s*)"[^"]*"/gi,
    replace: (_m, prefix: string) => `${prefix}"${REDACTED}"`,
  },
  // OAuth authorization codes and tokens in query strings.
  {
    pattern: /([?&](?:code|access_token|refresh_token|id_token|token|api_key|key)=)[^&\s"']+/gi,
    replace: (_m, prefix: string) => `${prefix}${REDACTED}`,
  },
  // Passwords in URLs: scheme://user:password@host
  {
    pattern: /([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@/\s]+@/gi,
    replace: (_m, prefix: string) => `${prefix}${REDACTED}@`,
  },
];

// Terminal control sequences (colour, cursor movement, OSC titles). The
// renderer shows text, and an OSC sequence in a copied report is just noise.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Strip terminal escapes and redact anything that looks like a credential. */
export function sanitizeText(input: string): string {
  let text = input.replace(ANSI, '');
  for (const rule of RULES) {
    text = typeof rule.replace === 'string'
      ? text.replace(rule.pattern, rule.replace)
      : text.replace(rule.pattern, rule.replace as (substring: string, ...args: string[]) => string);
  }
  return text;
}

/** An error's message, sanitized, for showing in the UI. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return sanitizeText(err.message);
  return sanitizeText(String(err));
}
