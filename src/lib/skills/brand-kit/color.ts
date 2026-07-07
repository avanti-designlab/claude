/**
 * Hand-rolled color math for the brand-kit skill (doc 06 §2, §7).
 *
 * Pure functions, no dependencies, no DOM. WCAG 2.x relative luminance and
 * contrast ratio are implemented from first principles so the theming engine
 * can validate contrast on every tenant theme without trusting a library.
 */

export interface Rgb {
  /** 0–255 */
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  /** Hue in degrees, [0, 360). */
  h: number;
  /** Saturation, [0, 100]. */
  s: number;
  /** Lightness, [0, 100]. */
  l: number;
}

const HEX_DIGITS = /^[0-9a-f]+$/i;

/**
 * Normalize a hex color to lowercase `#rrggbb`.
 *
 * Accepts 3-digit (`#abc`), 4-digit (`#abcf`, alpha dropped), 6-digit
 * (`#aabbcc`) and 8-digit (`#aabbccdd`, alpha dropped) forms, with or
 * without the leading `#`. Throws on anything else — named colors, rgb()
 * strings, wrong lengths, non-hex digits.
 */
export function normalizeHex(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError(`Invalid hex color: expected a string, got ${typeof input}`);
  }
  const raw = input.trim().replace(/^#/, "");
  if (raw.length === 0 || !HEX_DIGITS.test(raw)) {
    throw new Error(`Invalid hex color: "${input}"`);
  }
  let six: string;
  switch (raw.length) {
    case 3:
      six = raw
        .split("")
        .map((c) => c + c)
        .join("");
      break;
    case 4:
      // #rgba — expand rgb, drop alpha.
      six = raw
        .slice(0, 3)
        .split("")
        .map((c) => c + c)
        .join("");
      break;
    case 6:
      six = raw;
      break;
    case 8:
      // #rrggbbaa — drop alpha.
      six = raw.slice(0, 6);
      break;
    default:
      throw new Error(
        `Invalid hex color: "${input}" (expected 3, 4, 6, or 8 hex digits)`
      );
  }
  return `#${six.toLowerCase()}`;
}

/** Parse a hex color (any accepted form) into 0–255 RGB channels. */
export function hexToRgb(hex: string): Rgb {
  const n = normalizeHex(hex);
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  };
}

/** Serialize 0–255 RGB channels to lowercase `#rrggbb`. Channels are clamped and rounded. */
export function rgbToHex(rgb: Rgb): string {
  const channel = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

/**
 * WCAG 2.x relative luminance of a color, [0, 1].
 *
 * Per https://www.w3.org/TR/WCAG22/#dfn-relative-luminance:
 * each sRGB channel is linearized (c/12.92 below the 0.04045 knee, else
 * ((c+0.055)/1.055)^2.4), then weighted 0.2126 R + 0.7152 G + 0.0722 B.
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * WCAG 2.x contrast ratio between two colors, [1, 21].
 *
 * (L_lighter + 0.05) / (L_darker + 0.05) — symmetric in its arguments.
 * Reference points: white on black = 21:1; #767676 on white ≈ 4.54:1 (AA
 * pass); #777777 on white ≈ 4.48:1 (AA fail).
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Convert 0–255 RGB to HSL (h in degrees, s/l in percent). */
export function rgbToHsl(rgb: Rgb): Hsl {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

/** Convert HSL (h degrees, s/l percent) to 0–255 RGB. */
export function hslToRgb(hsl: Hsl): Rgb {
  const h = ((hsl.h % 360) + 360) % 360;
  const s = Math.max(0, Math.min(100, hsl.s)) / 100;
  const l = Math.max(0, Math.min(100, hsl.l)) / 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

/** HSL lightness of a hex color, [0, 100]. */
export function lightnessOf(hex: string): number {
  return rgbToHsl(hexToRgb(hex)).l;
}

/** Return the color with its HSL lightness set to an absolute value (clamped to [0, 100]). Hue and saturation are preserved. */
export function setLightness(hex: string, lightness: number): string {
  const { h, s } = rgbToHsl(hexToRgb(hex));
  return rgbToHex(hslToRgb({ h, s, l: Math.max(0, Math.min(100, lightness)) }));
}

/** Shift the color's HSL lightness by `delta` percentage points (clamped to [0, 100]). */
export function adjustLightness(hex: string, delta: number): string {
  return setLightness(hex, lightnessOf(hex) + delta);
}

/** Hue of a hex color in degrees, [0, 360). Achromatic colors report 0. */
export function hueOf(hex: string): number {
  return rgbToHsl(hexToRgb(hex)).h;
}

/** Shortest angular separation between two colors' hues, [0, 180]. */
export function hueSeparationDeg(a: string, b: string): number {
  const diff = Math.abs(hueOf(a) - hueOf(b)) % 360;
  return diff > 180 ? 360 - diff : diff;
}
