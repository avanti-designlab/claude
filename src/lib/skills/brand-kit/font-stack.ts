/**
 * Font-stack validation — the anti-injection gate for the three typography
 * token strings (`display` / `body` / `mono`).
 *
 * Font stacks are the only free-text token values a tenant controls: colors
 * are re-parsed to normalized hex and spacing is numeric, but a font stack
 * flows verbatim into `toCssVariables` and from there is string-concatenated
 * into live stylesheets (`toCssBlock`, `tenantThemeCss` → an injected
 * `<style>` on the white-label path) and inline `style` attributes
 * (`TenantThemeScope`). A stored value containing `}` would close the
 * `:root[data-tenant-theme]` rule early and inject arbitrary app-wide CSS
 * for every viewer of that tenant — stored CSS injection (defacement,
 * attribute-selector exfiltration).
 *
 * The gate is a WHITELIST of the CSS font-family list grammar: family names
 * (quoted strings or unquoted idents/keywords) separated by commas. Anything
 * a legitimate stack needs — Unicode letters, digits, spaces, `_ , ' " -` —
 * passes through unchanged; every rule-breaking or escape-capable character
 * (`; { } < > ( ) / \`, control characters, and by extension `url(` and
 * `</style>`) is outside the whitelist and REJECTED with a descriptive
 * error, exactly like a malformed color. The theme engine's try/catch turns
 * that throw into the refused-theme Signal fallback, so a hostile theme is
 * never rendered — and never silently rewritten either (sanitize-by-strip
 * was deliberately not chosen: it would render an attacker-influenced theme
 * without surfacing the attack).
 */

/**
 * Characters a CSS font-family list may contain (Unicode-aware whitelist):
 * letters (incl. combining marks — "Söhne"), digits, spaces, `_ , ' " -`.
 */
const FONT_STACK_GRAMMAR = /^[\p{L}\p{M}\p{N}_ ,'"-]+$/u;

/** Render one offending character readably for the error/log message. */
function describeChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  // Control chars and other invisibles as code points, everything else quoted.
  return code < 0x20 || code === 0x7f
    ? `U+${code.toString(16).toUpperCase().padStart(4, "0")}`
    : JSON.stringify(ch);
}

/**
 * Validate one font-stack string against the font-family grammar.
 *
 * @param value the candidate stack (untrusted — from `tenants.theme.font` or
 *   brand-kit input).
 * @param field which typography token this is, for the error message
 *   (`display` / `body` / `mono`).
 * @returns the stack, byte-for-byte unchanged, when it is safe.
 * @throws Error naming the field and every offending character when it is
 *   not. Same contract as a malformed color: throw → `resolveTenantTheme`
 *   catches → Signal fallback with the reason logged (doc 06 §3, never
 *   silent).
 */
export function validateFontStack(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`typography.${field} must be a non-empty font stack`);
  }
  if (!FONT_STACK_GRAMMAR.test(value)) {
    const offending = [...new Set(Array.from(value))]
      .filter((ch) => !FONT_STACK_GRAMMAR.test(ch))
      .map(describeChar)
      .join(" ");
    throw new Error(
      `typography.${field} is not a valid CSS font-family list ` +
        `(offending character(s): ${offending}). Allowed: letters, digits, ` +
        `spaces, and _ , ' " -`
    );
  }
  return value;
}
