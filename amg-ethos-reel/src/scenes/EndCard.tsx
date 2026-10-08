import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { Globe, Home, Instagram, Phone, ShieldCheck, Sprout } from 'lucide-react';
import { AmgLogo, EthosWordmark } from '../components/Logos';
import { DarkStage, MaskLine, display, ui } from '../components/Kit';
import { C, easeInOut } from '../theme';
import { lerp, pop } from '../motion';

export const AMG_WEB = 'insuranceamg.com';
export const AMG_IG = '@amginsurance';
export const AMG_PHONE = '+1 (248) 592-0080';

// Closing lockup: both brands, the promise, three values, and AMG's contact info.
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
          <MaskLine at={18} style={display(86, 700)}>
            More than insurance.
          </MaskLine>
          <MaskLine at={24} style={display(86, 700, C.lime)}>
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
            marginTop: 80,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '24px 44px',
            borderRadius: 999,
            background: C.lime,
            ...ui(40, 700, C.deep),
            transform: `scale(${pop(frame, fps, 58)})`,
            boxShadow: `0 0 ${30 + Math.sin(frame / 6) * 12}px rgba(188,240,49,0.45)`,
          }}
        >
          <Globe size={40} color={C.deep} strokeWidth={2.4} />
          {AMG_WEB}
        </div>
        <div style={{ marginTop: 26, display: 'flex', gap: 18 }}>
          {[
            { icon: Instagram, label: AMG_IG },
            { icon: Phone, label: AMG_PHONE },
          ].map(({ icon: Icon, label }, i) => {
            const s = pop(frame, fps, 64 + i * 5);
            return (
              <div
                key={label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '18px 28px',
                  borderRadius: 999,
                  background: 'rgba(255,255,255,0.08)',
                  border: '2px solid rgba(255,255,255,0.18)',
                  ...ui(30, 600, C.white),
                  transform: `scale(${s})`,
                  opacity: Math.min(1, s * 1.4),
                }}
              >
                <Icon size={32} color={C.lime} strokeWidth={2.3} />
                {label}
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </DarkStage>
  );
};
