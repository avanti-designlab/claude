import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT_DISPLAY, FONT_UI, HEIGHT, WIDTH, easeInOut, easeOut } from '../theme';
import { lerp, pop, rise } from '../motion';

/* ---------- Backgrounds ---------- */

/** Deep-green stage: radial light, drifting dot grid, and slow brand circles. */
export const DarkStage: React.FC<{ children?: React.ReactNode; circles?: boolean }> = ({ children, circles = true }) => {
  const frame = useCurrentFrame();
  const drift = frame * 0.35;
  return (
    <AbsoluteFill style={{ background: `radial-gradient(120% 80% at 50% 30%, ${C.deep} 0%, ${C.deeper} 55%, ${C.ink} 100%)` }}>
      <svg width={WIDTH} height={HEIGHT} style={{ position: 'absolute', opacity: 0.18 }}>
        <defs>
          <pattern id="dots" width="44" height="44" patternUnits="userSpaceOnUse" patternTransform={`translate(0 ${-drift})`}>
            <circle cx="22" cy="22" r="2" fill={C.lime} />
          </pattern>
          <radialGradient id="fade" cx="50%" cy="45%" r="60%">
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id="fadeMask">
            <rect width={WIDTH} height={HEIGHT} fill="url(#fade)" />
          </mask>
        </defs>
        <rect width={WIDTH} height={HEIGHT} fill="url(#dots)" mask="url(#fadeMask)" />
      </svg>
      {circles && (
        <>
          <Orb x={-260 + Math.sin(frame / 60) * 30} y={-180} size={760} color={C.green} opacity={0.55} />
          <Orb x={640 + Math.cos(frame / 70) * 30} y={1380} size={820} color={C.green} opacity={0.45} />
          <Orb x={720} y={-120 + Math.sin(frame / 50) * 40} size={420} color={C.lime} opacity={0.10} blur={60} />
        </>
      )}
      {children}
    </AbsoluteFill>
  );
};

/** Light AMG stage (#F1F1F1) with lime brand circles, as in the client's posts. */
export const LightStage: React.FC<{ children?: React.ReactNode; grow?: number }> = ({ children, grow = 1 }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: C.light }}>
      <Orb x={-380} y={-300 + Math.sin(frame / 55) * 20} size={900 * grow} color={C.lime} opacity={1} />
      <Orb x={560} y={1340 + Math.cos(frame / 60) * 20} size={980 * grow} color={C.lime} opacity={1} />
      <svg width={WIDTH} height={HEIGHT} style={{ position: 'absolute', opacity: 0.06 }}>
        <defs>
          <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M60 0H0V60" fill="none" stroke={C.deep} strokeWidth="2" />
          </pattern>
        </defs>
        <rect width={WIDTH} height={HEIGHT} fill="url(#grid)" />
      </svg>
      {children}
    </AbsoluteFill>
  );
};

export const Orb: React.FC<{ x: number; y: number; size: number; color: string; opacity?: number; blur?: number }> = ({
  x,
  y,
  size,
  color,
  opacity = 1,
  blur = 0,
}) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: size,
      height: size,
      borderRadius: '50%',
      background: color,
      opacity,
      filter: blur ? `blur(${blur}px)` : undefined,
    }}
  />
);

/* ---------- Transitions ---------- */

/** Brand-circle wipe: the scene is revealed through a growing circle with a lime ring. */
export const CircleWipe: React.FC<{
  children: React.ReactNode;
  dur?: number;
  x?: number;
  y?: number;
  ring?: string;
}> = ({ children, dur = 18, x = WIDTH / 2, y = HEIGHT / 2, ring = C.lime }) => {
  const frame = useCurrentFrame();
  const maxR = Math.hypot(Math.max(x, WIDTH - x), Math.max(y, HEIGHT - y)) + 40;
  const p = lerp(frame, [0, dur], [0, 1], easeInOut);
  const r = p * maxR;
  if (p >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ clipPath: `circle(${r}px at ${x}px ${y}px)` }}>{children}</AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          left: x - r,
          top: y - r,
          width: r * 2,
          height: r * 2,
          borderRadius: '50%',
          border: `${18 * (1 - p) + 4}px solid ${ring}`,
          boxSizing: 'border-box',
        }}
      />
    </AbsoluteFill>
  );
};

/** Fade + slight zoom out at the end of a scene. */
export const SceneOut: React.FC<{ children: React.ReactNode; dur: number; out?: number }> = ({ children, dur, out = 14 }) => {
  const frame = useCurrentFrame();
  const p = lerp(frame, [dur - out, dur], [0, 1], easeInOut);
  return <AbsoluteFill style={{ transform: `scale(${1 - p * 0.06})`, filter: p > 0 ? `blur(${p * 8}px)` : undefined }}>{children}</AbsoluteFill>;
};

/* ---------- Typography ---------- */

/** A line of text that slides up out of a mask. */
export const MaskLine: React.FC<{
  children: React.ReactNode;
  at: number;
  dur?: number;
  style?: React.CSSProperties;
}> = ({ children, at, dur = 22, style }) => {
  const frame = useCurrentFrame();
  const p = rise(frame, at, dur);
  return (
    <div style={{ overflow: 'hidden', paddingBottom: '0.08em', marginBottom: '-0.08em' }}>
      <div style={{ transform: `translateY(${(1 - p) * 110}%) rotate(${(1 - p) * 4}deg)`, transformOrigin: 'left bottom', ...style }}>
        {children}
      </div>
    </div>
  );
};

/** Words that pop in one by one. */
export const WordPop: React.FC<{ text: string; at: number; gap?: number; style?: React.CSSProperties; wordStyle?: (i: number) => React.CSSProperties }> = ({
  text,
  at,
  gap = 3,
  style,
  wordStyle,
}) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: '0.28em', ...style }}>
      {text.split(' ').map((w, i) => {
        const p = rise(frame, at + i * gap, 16);
        return (
          <span key={i} style={{ display: 'inline-block', opacity: p, transform: `translateY(${(1 - p) * 30}px)`, filter: `blur(${(1 - p) * 6}px)`, ...wordStyle?.(i) }}>
            {w}
          </span>
        );
      })}
    </div>
  );
};

/** Characters typed out with a blinking caret. */
export const Typed: React.FC<{ text: string; at: number; cps?: number; caret?: boolean; caretColor?: string }> = ({
  text,
  at,
  cps = 1.4,
  caret = true,
  caretColor = C.green,
}) => {
  const frame = useCurrentFrame();
  const n = Math.max(0, Math.min(text.length, Math.floor((frame - at) * cps)));
  const typing = frame >= at && n < text.length;
  const blinkOn = typing || Math.floor(frame / 8) % 2 === 0;
  return (
    <span>
      {text.slice(0, n)}
      {caret && frame >= at && (
        <span style={{ display: 'inline-block', width: '0.08em', height: '1em', marginLeft: 2, verticalAlign: '-0.12em', background: caretColor, opacity: blinkOn ? 1 : 0 }} />
      )}
    </span>
  );
};

/* ---------- UI bits ---------- */

export const Pill: React.FC<{ children: React.ReactNode; at: number; dark?: boolean; style?: React.CSSProperties }> = ({ children, at, dark = true, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = pop(frame, fps, at);
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 14,
        padding: '16px 30px',
        borderRadius: 999,
        fontFamily: FONT_UI,
        fontWeight: 700,
        fontSize: 28,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color: dark ? C.lime : C.deep,
        background: dark ? 'rgba(188,240,49,0.10)' : C.white,
        border: dark ? '2px solid rgba(188,240,49,0.45)' : `2px solid rgba(31,72,51,0.12)`,
        boxShadow: dark ? '0 0 40px rgba(188,240,49,0.18)' : '0 12px 30px rgba(13,36,25,0.10)',
        transform: `scale(${s})`,
        opacity: Math.min(1, s * 1.5),
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** Pulsing "live" dot used inside pills. */
export const LiveDot: React.FC<{ color?: string }> = ({ color = C.lime }) => {
  const frame = useCurrentFrame();
  const pulse = (frame % 30) / 30;
  return (
    <span style={{ position: 'relative', width: 16, height: 16, display: 'inline-block' }}>
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: color }} />
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: color, opacity: 1 - pulse, transform: `scale(${1 + pulse * 1.6})` }} />
    </span>
  );
};

/** Mac-style pointer that glides between points and "clicks". */
export const Cursor: React.FC<{ path: Array<{ f: number; x: number; y: number }>; clickAt?: number[] }> = ({ path, clickAt = [] }) => {
  const frame = useCurrentFrame();
  const xs = path.map((p) => p.x);
  const ys = path.map((p) => p.y);
  const fs = path.map((p) => p.f);
  const x = lerp(frame, fs, xs, easeInOut);
  const y = lerp(frame, fs, ys, easeInOut);
  const appear = rise(frame, fs[0] - 8, 10);
  let press = 0;
  let ripple = -1;
  for (const c of clickAt) {
    if (frame >= c - 3 && frame <= c + 4) press = 1 - Math.abs(frame - c) / 4;
    if (frame >= c && frame < c + 22) ripple = (frame - c) / 22;
  }
  return (
    <>
      {ripple >= 0 && (
        <div
          style={{
            position: 'absolute',
            left: x - 60,
            top: y - 60,
            width: 120,
            height: 120,
            borderRadius: '50%',
            border: `4px solid ${C.lime}`,
            transform: `scale(${0.3 + easeOut(ripple) * 1.2})`,
            opacity: 1 - ripple,
          }}
        />
      )}
      <svg
        width={64}
        height={64}
        viewBox="0 0 24 24"
        style={{ position: 'absolute', left: x - 8, top: y - 4, opacity: appear, transform: `scale(${1 - press * 0.18})`, filter: 'drop-shadow(0 6px 10px rgba(0,0,0,0.35))' }}
      >
        <path d="M4 2.5 L4 19.5 L8.6 15.4 L11.6 22 L14.6 20.7 L11.7 14.2 L18 14.2 Z" fill="#fff" stroke="#0D2419" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </>
  );
};

export const display = (size: number, weight = 800, color = C.white): React.CSSProperties => ({
  fontFamily: FONT_DISPLAY,
  fontWeight: weight,
  fontSize: size,
  lineHeight: 1.02,
  letterSpacing: '-0.025em',
  color,
});

export const ui = (size: number, weight = 500, color = C.white): React.CSSProperties => ({
  fontFamily: FONT_UI,
  fontWeight: weight,
  fontSize: size,
  lineHeight: 1.35,
  color,
});
