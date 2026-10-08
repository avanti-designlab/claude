import { interpolate, spring } from 'remotion';
import { easeOut } from './theme';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** 0→1 over [start, start+dur] with expo-out easing. */
export const rise = (frame: number, start: number, dur = 20, easing = easeOut) =>
  interpolate(frame, [start, start + dur], [0, 1], { ...clamp, easing });

/** Linear-ish mapping with clamping. */
export const lerp = (frame: number, input: number[], output: number[], easing?: (t: number) => number) =>
  interpolate(frame, input, output, { ...clamp, easing });

/** Snappy spring that starts at `delay`. */
export const pop = (frame: number, fps: number, delay = 0, config = { damping: 13, stiffness: 170, mass: 0.7 }) =>
  spring({ frame: frame - delay, fps, config });

/** Soft spring with no overshoot. */
export const glide = (frame: number, fps: number, delay = 0) =>
  spring({ frame: frame - delay, fps, config: { damping: 200, stiffness: 120 } });
