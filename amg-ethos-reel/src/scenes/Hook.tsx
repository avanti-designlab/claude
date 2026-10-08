import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { AmgMark } from '../components/Logos';
import { DarkStage, LiveDot, MaskLine, Pill, display } from '../components/Kit';
import { C, easeInOut } from '../theme';
import { lerp, pop } from '../motion';

// 0–2.8s: AMG's dot mark assembles out of nowhere, then lifts to make room
// for the "Exciting announcement" headline.
export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const lift = lerp(frame, [26, 44], [0, 1], easeInOut);
  const markSize = 300 - lift * 130;
  const markY = 860 - lift * 380;
  const spin = lerp(frame, [0, 30], [-40, 0], easeInOut);
  const glow = lerp(frame, [14, 30], [0, 1]);

  return (
    <DarkStage>
      <AbsoluteFill>
        <div
          style={{
            position: 'absolute',
            left: 540 - markSize / 2,
            top: markY - markSize / 2,
            width: markSize,
            height: markSize,
            transform: `rotate(${spin}deg)`,
            filter: `drop-shadow(0 0 ${40 * glow}px rgba(188,240,49,${0.45 * glow}))`,
          }}
        >
          <AmgMark size={markSize} dotProgress={(i) => pop(frame, fps, 2 + i * 1.6, { damping: 14, stiffness: 140, mass: 0.8 })} />
        </div>

        <div style={{ position: 'absolute', top: 700, left: 0, right: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <Pill at={38}>
            <LiveDot /> Big News
          </Pill>
          <div style={{ height: 40 }} />
          <MaskLine at={42} style={{ ...display(170, 800), textAlign: 'center', textTransform: 'uppercase' }}>
            Exciting
          </MaskLine>
          <MaskLine at={47} style={{ ...display(104, 800, C.lime), textAlign: 'center', textTransform: 'uppercase', letterSpacing: '-0.015em' }}>
            Announcement
          </MaskLine>
          <Underline at={58} />
        </div>
      </AbsoluteFill>
    </DarkStage>
  );
};

const Underline: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  const p = lerp(frame, [at, at + 16], [0, 1], easeInOut);
  return (
    <svg width={760} height={60} viewBox="0 0 760 60" style={{ marginTop: 18 }}>
      <path
        d="M10 40 C 200 10, 520 6, 750 30"
        fill="none"
        stroke={C.lime}
        strokeWidth={10}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - p}
      />
    </svg>
  );
};
