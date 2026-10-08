import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { AmgMark, EthosMark } from '../components/Logos';
import { DarkStage, MaskLine, WordPop, display, ui } from '../components/Kit';
import { C, easeInOut } from '../theme';
import { lerp, pop, rise } from '../motion';

// The announcement itself, as kinetic type on the dark stage.
export const Headline: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const chip = pop(frame, fps, 10);
  const sweep = lerp(frame, [44, 64], [0, 1], easeInOut);

  return (
    <DarkStage>
      <AbsoluteFill style={{ padding: '0 90px', justifyContent: 'center' }}>
        {/* glass partner chip */}
        <div
          style={{
            alignSelf: 'flex-start',
            display: 'flex',
            alignItems: 'center',
            gap: 22,
            padding: '20px 32px 20px 24px',
            borderRadius: 999,
            background: 'rgba(255,255,255,0.08)',
            border: '2px solid rgba(255,255,255,0.16)',
            boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
            transform: `scale(${chip})`,
            transformOrigin: 'left center',
            marginBottom: 64,
          }}
        >
          <AmgMark size={54} />
          <span style={{ ...ui(40, 500, 'rgba(255,255,255,0.6)') }}>+</span>
          <div style={{ width: 62, height: 62, borderRadius: '50%', background: C.white, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <EthosMark size={46} />
          </div>
          <span style={{ ...ui(30, 600, C.white), letterSpacing: '0.04em', marginLeft: 6 }}>Now partnered</span>
        </div>

        <MaskLine at={14} style={display(104, 800)}>
          AMG Insurance
        </MaskLine>
        <MaskLine at={18} style={display(104, 800)}>
          Group is now
        </MaskLine>
        <MaskLine at={22} style={display(104, 800)}>
          partnered with
        </MaskLine>
        <div style={{ position: 'relative', marginTop: 18, alignSelf: 'flex-start' }}>
          <div
            style={{
              position: 'absolute',
              left: -18,
              right: -18,
              top: 8,
              bottom: 0,
              background: C.lime,
              borderRadius: 18,
              transform: `scaleX(${sweep})`,
              transformOrigin: 'left',
            }}
          />
          <div style={{ position: 'relative' }}>
            <MaskLine at={30} style={{ ...display(104, 800, sweep > 0.5 ? C.deep : C.lime), padding: '6px 0 2px' }}>
              Ethos Life
            </MaskLine>
          </div>
        </div>
        <div style={{ position: 'relative', marginTop: 14, alignSelf: 'flex-start' }}>
          <div
            style={{
              position: 'absolute',
              left: -18,
              right: -18,
              top: 8,
              bottom: 0,
              background: C.lime,
              borderRadius: 18,
              transform: `scaleX(${lerp(frame, [50, 70], [0, 1], easeInOut)})`,
              transformOrigin: 'left',
            }}
          />
          <div style={{ position: 'relative' }}>
            <MaskLine at={34} style={{ ...display(104, 800, frame > 60 ? C.deep : C.lime), padding: '6px 0 2px' }}>
              Insurance!
            </MaskLine>
          </div>
        </div>

        <div style={{ marginTop: 70, opacity: rise(frame, 62, 10) }}>
          <WordPop
            at={64}
            gap={1}
            text="Another great way to help individuals and families protect what matters most — simple, fast, and convenient."
            style={{ ...ui(42, 500, 'rgba(255,255,255,0.82)'), maxWidth: 880 }}
          />
        </div>
      </AbsoluteFill>
    </DarkStage>
  );
};
