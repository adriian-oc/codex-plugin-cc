// Environment hygiene and output redaction.

// Variables that would switch Claude Code to API-key billing or carry
// credentials for other services. Removed from worker and check environments.
const BILLING_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL|SESSION_KEY|ACCESS_KEY)/i;
const KEEP = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]);

export function scrubEnv(source = process.env, { allowApiBilling = false, extra = {}, keep = [] } = {}) {
  const env = {};
  const removed = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (BILLING_VARS.includes(key) && !allowApiBilling) {
      removed.push(key);
      continue;
    }
    if (!KEEP.has(key) && !keep.includes(key) && SECRET_NAME.test(key) && !(allowApiBilling && BILLING_VARS.includes(key))) {
      removed.push(key);
      continue;
    }
    // Never forward the coordinator's own control variables to children.
    if (key.startsWith("CCD_")) continue;
    env[key] = value;
  }
  return { env: { ...env, ...extra }, removed };
}

const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

export function redact(text) {
  let value = String(text ?? "");
  for (const re of PATTERNS) value = value.replace(re, "[REDACTED]");
  return value;
}
