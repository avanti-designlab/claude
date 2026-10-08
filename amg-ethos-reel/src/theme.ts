import { Easing } from 'remotion';

export const WIDTH = 1080;
export const HEIGHT = 1920;
export const FPS = 30;

// AMG brand colors, sampled from the client's approved IG posts.
export const C = {
  deep: '#1F4833', // AMG dark green (backgrounds, headline ink)
  deeper: '#15382A',
  ink: '#0D2419', // darkest shade for depth/vignettes
  green: '#1E915D', // AMG mid green (circle motif)
  forest: '#336043', // AMG footer green
  lime: '#BCF031', // AMG lime accent
  light: '#F1F1F1', // AMG light background
  white: '#FFFFFF',
  ethos: '#054843', // Ethos brand teal
};

export const FONT_DISPLAY = 'Poppins, sans-serif'; // stand-in for AMG's Gilroy
export const FONT_UI = 'Inter, sans-serif';

// Shared easing curves.
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1); // expo-out
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);
export const easeIn = Easing.bezier(0.7, 0, 0.84, 0);

// Scene timeline (frames @30fps). Scenes overlap by their wipe-in length.
export const T = {
  hook: { from: 0, dur: 84 },
  lockup: { from: 72, dur: 126 },
  headline: { from: 184, dur: 126 },
  product: { from: 296, dur: 210 },
  family: { from: 492, dur: 150 },
  cta: { from: 628, dur: 150 },
  end: { from: 764, dur: 116 },
};
export const TOTAL = T.end.from + T.end.dur; // 880 frames ≈ 29.3s
