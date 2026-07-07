/**
 * Token definition — the default light chrome surface for the Signal theme
 * (F2 design decision, 2026-07-07): a cool paper that keeps the Signal
 * blue-slate temperature. The light-adapted palette in globals.css is
 * buildBrandKit output against this surface; the parity test recomputes it
 * from this constant.
 *
 * This file is allowlisted in no-hardcoded-colors.test.ts because it defines
 * a token INPUT — the same standing as the token blocks in globals.css.
 */
export const SIGNAL_LIGHT_SURFACE = "#f4f6f9";
