import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { Home, Link2, ShieldCheck, Sprout } from 'lucide-react';
import { AmgLogo, EthosWordmark } from '../components/Logos';
import { DarkStage, MaskLine, display, ui } from '../components/Kit';
import { C, easeInOut } from '../theme';
import { lerp, pop, rise } from '../motion';
import { INVITE_URL } from './Cta';

// Closing lockup: both brands, the promise, three values, and the link.
export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lock = pop(frame, fps, 6, { damping: 18, stiffness: 120, mass: 0.9 });
  const divider = lerp(frame, [10, 26], [0, 1], easeInOut);

  return (
    <DarkStage>
      <AbsoluteFill style={{ alignItems: 'center' }}>
        <div style={{ marginTop: 420, display: 'flex', alignItems: 'center', gap: 44, transform: `scale(${0.85 + lock * 0.15})`, opacity: Math.min(1, lock * 1.4) }}>
          <AmgLogo height={88} dotProgress={(i) => pop(frame, fps, 4 + i)} />
          <div style={{ width: 3, height: 110 * divider, background: 'rgba(255,255,255,0.35)', borderRadius: 3 }} />
          <EthosWordmark height={70} color={C.white} />
        </div>

        <div style={{ marginTop: 130, textAlign: 'center' }}>
          <MaskLine at={18} style={display(86, 800)}>
            More than insurance.
          </MaskLine>
          <MaskLine at={24} style={display(86, 800, C.lime)}>
            A brighter tomorrow.
          </MaskLine>
        </div>

        <div style={{ marginTop: 110, display: 'flex', gap: 22 }}>
          {[
            { icon: Home, a: 'Protect your', b: 'loved ones' },
            { icon: Sprout, a: 'Build a stronger', b: 'tomorrow' },
            { icon: ShieldCheck, a: 'Peace of mind', b: 'today' },
          ].map(({ icon: Icon, a, b }, i) => {
            const s = pop(frame, fps, 36 + i * 6);
            return (
              <div
                key={a}
                style={{
                  width: 266,
                  padding: '34px 16px 30px',
                  borderRadius: 34,
                  background: 'rgba(255,255,255,0.07)',
                  border: '2px solid rgba(255,255,255,0.14)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 20,
                  transform: `translateY(${(1 - s) * 60}px) scale(${0.8 + s * 0.2})`,
                  opacity: Math.min(1, s * 1.4),
                }}
              >
                <div style={{ width: 96, height: 96, borderRadius: '50%', background: C.lime, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon size={50} color={C.deep} strokeWidth={2.3} />
                </div>
                <div style={{ ...ui(29, 600, C.white), textAlign: 'center', lineHeight: 1.25 }}>
                  {a}
                  <br />
                  <span style={{ color: 'rgba(255,255,255,0.7)' }}>{b}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            marginTop: 90,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '22px 36px',
            borderRadius: 999,
            background: C.lime,
            ...ui(32, 700, C.deep),
            transform: `scale(${pop(frame, fps, 58)})`,
            boxShadow: `0 0 ${30 + Math.sin(frame / 6) * 12}px rgba(188,240,49,0.45)`,
          }}
        >
          <Link2 size={34} color={C.deep} strokeWidth={2.6} />
          {INVITE_URL}
        </div>
        <div style={{ marginTop: 26, opacity: rise(frame, 66, 14), ...ui(28, 600, 'rgba(255,255,255,0.7)'), letterSpacing: '0.04em' }}>
          or send us a DM — we're here to help
        </div>
      </AbsoluteFill>
    </DarkStage>
  );
};
