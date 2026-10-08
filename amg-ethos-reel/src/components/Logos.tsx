import React from 'react';
import { C } from '../theme';
import { amgWord, ethosMark, ethosWord } from '../logoPaths';

// AMG dot mark, rebuilt from the logo geometry: a 4x4 grid where the lime
// group (top-left) and the white group (bottom-right) mirror each other.
type Dot = { x: number; y: number; shape: 'c' | 's'; group: 'a' | 'b' };
export const AMG_DOTS: Dot[] = [
  { x: 1, y: 0, shape: 'c', group: 'a' },
  { x: 2, y: 0, shape: 'c', group: 'a' },
  { x: 0, y: 1, shape: 'c', group: 'a' },
  { x: 1, y: 1, shape: 's', group: 'a' },
  { x: 0, y: 2, shape: 'c', group: 'a' },
  { x: 3, y: 1, shape: 'c', group: 'b' },
  { x: 2, y: 2, shape: 's', group: 'b' },
  { x: 3, y: 2, shape: 'c', group: 'b' },
  { x: 1, y: 3, shape: 'c', group: 'b' },
  { x: 2, y: 3, shape: 'c', group: 'b' },
];

// Where each dot flies in from (in grid units) during the assemble animation.
const SCATTER: Array<[number, number]> = [
  [-3, -5], [4, -6], [-6, -1], [-2, 3], [-7, 4], [7, -2], [3, 5], [8, 3], [-3, 7], [5, 8],
];

export const AmgMark: React.FC<{
  size: number;
  colorA?: string;
  colorB?: string;
  /** Per-dot progress 0→1 (assemble). Defaults to fully assembled. */
  dotProgress?: (i: number) => number;
  style?: React.CSSProperties;
}> = ({ size, colorA = C.lime, colorB = C.white, dotProgress, style }) => (
  <svg width={size} height={size} viewBox="0 0 4 4" style={{ overflow: 'visible', ...style }}>
    {AMG_DOTS.map((d, i) => {
      const p = dotProgress ? dotProgress(i) : 1;
      const [sx, sy] = SCATTER[i];
      const tx = (1 - p) * sx;
      const ty = (1 - p) * sy;
      const fill = d.group === 'a' ? colorA : colorB;
      const transform = `translate(${tx} ${ty}) translate(${d.x + 0.5} ${d.y + 0.5}) scale(${Math.max(p, 0)}) rotate(${(1 - p) * 180})`;
      return d.shape === 'c' ? (
        <circle key={i} r={0.5} fill={fill} transform={transform} />
      ) : (
        <rect key={i} x={-0.5} y={-0.5} width={1} height={1} fill={fill} transform={transform} />
      );
    })}
  </svg>
);

const [, , AW, AH] = amgWord.viewBox.split(' ').map(Number);
export const AMG_WORD_RATIO = AW / AH;

export const AmgWordmark: React.FC<{ height: number; color?: string; style?: React.CSSProperties }> = ({
  height,
  color = C.white,
  style,
}) => (
  <svg height={height} width={height * AMG_WORD_RATIO} viewBox={amgWord.viewBox} style={style}>
    <path d={amgWord.d} fill={color} fillRule="evenodd" />
  </svg>
);

/** Full AMG Insurance Group lockup (mark + wordmark), proportioned like the original logo. */
export const AmgLogo: React.FC<{
  height: number;
  word?: string;
  colorA?: string;
  colorB?: string;
  dotProgress?: (i: number) => number;
  wordStyle?: React.CSSProperties;
}> = ({ height, word = C.white, colorA, colorB, dotProgress, wordStyle }) => {
  const mark = (height * 86.7) / 93;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', height }}>
      <AmgMark
        size={mark}
        colorA={colorA}
        colorB={colorB}
        dotProgress={dotProgress}
        style={{ marginTop: (height * 5) / 93, flexShrink: 0 }}
      />
      <AmgWordmark height={height} color={word} style={{ marginLeft: (height * 4.3) / 93, ...wordStyle }} />
    </div>
  );
};

const [, , EW, EH] = ethosWord.viewBox.split(' ').map(Number);
export const ETHOS_WORD_RATIO = EW / EH;
// The "O" swoosh inside the Ethos wordmark, in wordmark viewBox units.
export const ETHOS_O = { x0: 1228, x1: 1600, y0: 0, y1: 373 };

export const EthosWordmark: React.FC<{ height: number; color?: string; style?: React.CSSProperties }> = ({
  height,
  color = C.ethos,
  style,
}) => (
  <svg height={height} width={height * ETHOS_WORD_RATIO} viewBox={ethosWord.viewBox} style={style}>
    <path d={ethosWord.d} fill={color} fillRule="evenodd" />
  </svg>
);

export const EthosMark: React.FC<{ size: number; color?: string; style?: React.CSSProperties }> = ({
  size,
  color = C.ethos,
  style,
}) => (
  <svg width={size} height={size} viewBox={ethosMark.viewBox} style={style}>
    <path d={ethosMark.d} fill={color} fillRule="evenodd" />
  </svg>
);
