/**
 * Shared redaction utilities for sensitive credential patterns.
 * Used by both workspace memory normalization and extraction rejection logging.
 */

// Password labels in multiple languages
const PASSWORD_LABELS = /password|passwd|pwd|密碼|密码|パスワード|비밀번호|contraseña|mot de passe|passwort/i;

// Username labels in multiple languages
const USERNAME_LABELS = /username|user name|用戶名|用户名|ユーザー名|사용자명|usuario|utilisateur|benutzer/i;

// Sensitive key labels
const SENSITIVE_LABELS = /api[_-]?key|token|bearer|secret|credential|auth|auth[_-]?key|private[_-]?key/i;

// Secret value pattern (excludes common delimiters and brackets)
const SECRET_VALUE = String.raw`[^` + "`" + String.raw`'",，,\s\[]+`;

// Prefix patterns for different credential types
const PIN_PREFIX = String.raw`(\bPIN\b(?:\s*(?:是|=|:|：)\s*|\s+(?![是=:：])))`;
const PASSWORD_PREFIX = String.raw`((?:${PASSWORD_LABELS.source})(?:\s*(?:是|=|:|：)\s*|\s+(?![是=:：])))`;
const USERNAME_PREFIX = String.raw`((?:${USERNAME_LABELS.source})(?:\s*(?:是|=|:|：)\s*|\s+(?![是=:：])))`;
const SENSITIVE_PREFIX = String.raw`((?:${SENSITIVE_LABELS.source})(?:\s*(?:推|是|=|:|：)\s*|[:：]\s*))`;
const BEARER_PREFIX = String.raw`(Bearer\s+)`;

/**
 * Redacts sensitive credentials from text.
 * Handles:
 * - PINs in multiple formats
 * - Username/password pairs
 * - Standalone passwords
 * - Bearer tokens
 * - API keys, secrets, credentials, auth tokens, private keys
 * 
 * Supports multiple languages and delimiters (ASCII and CJK).
 */
export function redactCredentials(text: string): string {
  let result = text;

  // 1. PIN
  result = result.replace(
    new RegExp(String.raw`${PIN_PREFIX}[\`'"]?(${SECRET_VALUE})`, "gi"),
    "$1[REDACTED]",
  );

  // 2. Username+password pair
  result = result.replace(
    new RegExp(
      String.raw`${USERNAME_PREFIX}[\`'"]?(${SECRET_VALUE})((?:，|,)\s*)${PASSWORD_PREFIX}[\`'"]?(${SECRET_VALUE})`,
      "gi",
    ),
    "$1[REDACTED]$3$4[REDACTED]",
  );

  // 3. Standalone password
  result = result.replace(
    new RegExp(String.raw`${PASSWORD_PREFIX}[\`'"]?(${SECRET_VALUE})`, "gi"),
    "$1[REDACTED]",
  );

  // 4. Bearer tokens (but not "bearer token:" labels)
  result = result.replace(
    new RegExp(String.raw`${BEARER_PREFIX}(?!token\s*[:=：])[\`'"]?(${SECRET_VALUE})`, "gi"),
    "$1[REDACTED]",
  );

  // 5. Sensitive keys/tokens
  result = result.replace(
    new RegExp(String.raw`${SENSITIVE_PREFIX}[\`'"]?(${SECRET_VALUE})`, "gi"),
    "$1[REDACTED]",
  );

  return result;
}