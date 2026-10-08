import React from 'react';
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Heart } from 'lucide-react';
import { MaskLine, display, ui } from '../components/Kit';
import { C, easeInOut } from '../theme';
import { lerp, pop } from '../motion';

// Emotional beat: golden-hour family footage with the brand promise.
export const Family: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const zoom = lerp(frame, [0, durationInFrames], [1.12, 1.0]);
  const line = lerp(frame, [36, 54], [0, 1], easeInOut);

  return (
    <AbsoluteFill style={{ background: C.ink }}>
      <AbsoluteFill style={{ transform: `scale(${zoom})` }}>
        <OffthreadVideo src={staticFile('family.mp4')} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </AbsoluteFill>
      {/* brand grade: deep green from the top for type, warm vignette at the bottom */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(180deg, rgba(13,36,25,0.88) 0%, rgba(21,56,42,0.55) 30%, rgba(21,56,42,0) 50%, rgba(13,36,25,0) 70%, rgba(13,36,25,0.75) 100%)`,
        }}
      />

      <div style={{ position: 'absolute', top: 250, left: 90, right: 90 }}>
        <MaskLine at={8} style={display(132, 800)}>
          Protect
        </MaskLine>
        <MaskLine at={13} style={display(132, 800)}>
          what matters
        </MaskLine>
        <div style={{ display: 'flex', alignItems: 'center', gap: 26 }}>
          <MaskLine at={18} style={display(132, 800, C.lime)}>
            most.
          </MaskLine>
          <div style={{ transform: `scale(${pop(frame, fps, 30)})`, marginTop: 10 }}>
            <Heart size={92} color={C.lime} fill={C.lime} />
          </div>
        </div>
        <svg width={420} height={40} viewBox="0 0 420 40" style={{ marginTop: 6 }}>
          <path d="M6 26 C 120 6, 300 4, 414 20" fill="none" stroke={C.lime} strokeWidth={9} strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - line} />
        </svg>
      </div>

      <div style={{ position: 'absolute', bottom: 380, left: 90, display: 'flex', gap: 16, flexWrap: 'wrap', width: 900 }}>
        {['Your family.', 'Your future.', 'Our priority.'].map((t, i) => {
          const s = pop(frame, fps, 48 + i * 7);
          return (
            <div
              key={t}
              style={{
                padding: '16px 28px',
                borderRadius: 999,
                background: i === 2 ? C.lime : 'rgba(255,255,255,0.14)',
                border: i === 2 ? 'none' : '2px solid rgba(255,255,255,0.35)',
                backdropFilter: 'blur(12px)',
                ...ui(34, 700, i === 2 ? C.deep : C.white),
                transform: `scale(${s}) translateY(${(1 - s) * 20}px)`,
                opacity: Math.min(1, s * 1.4),
              }}
            >
              {t}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
