import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { ArrowRight, Link2, Lock, MessageCircle, RotateCw, Send } from 'lucide-react';
import { AmgMark, EthosWordmark } from '../components/Logos';
import { Cursor, DarkStage, LiveDot, MaskLine, Pill, Typed, display, ui } from '../components/Kit';
import { C } from '../theme';
import { AMG_IG } from './EndCard';
import { pop, rise } from '../motion';

export const INVITE_URL = 'agents.ethoslife.com/invite/24ef7';
const CLICK = 82;

// Call to action: the invite link as a browser card + a DM prompt.
export const Cta: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const card = pop(frame, fps, 22, { damping: 16, stiffness: 110, mass: 0.9 });
  const dm = pop(frame, fps, 98, { damping: 15, stiffness: 120, mass: 0.8 });
  const clicked = frame >= CLICK;

  return (
    <DarkStage>
      <AbsoluteFill style={{ alignItems: 'center' }}>
        <div style={{ marginTop: 250 }}>
          <Pill at={4}>
            <LiveDot /> Get started today
          </Pill>
        </div>
        <div style={{ marginTop: 40, textAlign: 'center' }}>
          <MaskLine at={8} style={display(112, 700)}>
            Your coverage
          </MaskLine>
          <MaskLine at={13} style={display(112, 700, C.lime)}>
            starts here.
          </MaskLine>
        </div>

        {/* browser card */}
        <div
          style={{
            marginTop: 70,
            width: 940,
            borderRadius: 40,
            background: C.white,
            overflow: 'hidden',
            boxShadow: '0 50px 100px rgba(0,0,0,0.45), 0 0 0 2px rgba(255,255,255,0.4)',
            transform: `translateY(${(1 - card) * 300}px) scale(${0.9 + card * 0.1})`,
            opacity: Math.min(1, card * 1.5),
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '24px 28px', background: '#EEF1EC' }}>
            <div style={{ display: 'flex', gap: 10 }}>
              {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => (
                <span key={c} style={{ width: 18, height: 18, borderRadius: '50%', background: c }} />
              ))}
            </div>
            <div
              style={{
                flex: 1,
                height: 70,
                borderRadius: 999,
                background: C.white,
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '0 24px',
                ...ui(30, 600, C.deep),
                border: `2px solid ${frame > 30 && frame < 70 ? C.green : 'transparent'}`,
                whiteSpace: 'nowrap',
              }}
            >
              <Lock size={26} color={C.green} strokeWidth={2.6} />
              <Typed text={INVITE_URL} at={32} cps={1.3} caret={frame < 70} />
            </div>
            <RotateCw size={30} color="#7A8A80" />
          </div>
          <div style={{ padding: '44px 48px 48px', position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <EthosWordmark height={46} />
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, ...ui(24, 600, C.forest) }}>
                <Link2 size={26} color={C.forest} /> Invite from AMG
              </span>
            </div>
            <div style={{ ...ui(40, 700, C.deep), marginTop: 30, letterSpacing: '-0.02em' }}>Protect what matters most.</div>
            <div style={{ ...ui(28, 500, '#5D6E64'), marginTop: 8 }}>Apply online with AMG Insurance Group.</div>
            <div
              style={{
                marginTop: 34,
                height: 104,
                borderRadius: 28,
                background: clicked ? C.lime : C.deep,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 16,
                ...ui(36, 700, clicked ? C.deep : C.lime),
                transform: `scale(${frame >= CLICK - 2 && frame <= CLICK + 4 ? 0.96 : 1})`,
                boxShadow: clicked ? '0 0 0 10px rgba(188,240,49,0.35)' : '0 16px 30px rgba(31,72,51,0.3)',
              }}
            >
              Get started <ArrowRight size={40} strokeWidth={2.8} style={{ transform: `translateX(${clicked ? Math.min(10, (frame - CLICK) * 2) : 0}px)` }} />
            </div>
          </div>
        </div>

        {/* or DM */}
        <div style={{ marginTop: 48, display: 'flex', alignItems: 'center', gap: 22, opacity: rise(frame, 94, 12), ...ui(26, 700, 'rgba(255,255,255,0.6)'), letterSpacing: '0.3em' }}>
          <span style={{ width: 120, height: 2, background: 'rgba(255,255,255,0.25)' }} />
          OR SEND US A DM
          <span style={{ width: 120, height: 2, background: 'rgba(255,255,255,0.25)' }} />
        </div>
        <div
          style={{
            marginTop: 32,
            width: 940,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 22,
            transform: `translateY(${(1 - dm) * 80}px)`,
            opacity: Math.min(1, dm * 1.4),
          }}
        >
          <div style={{ width: 92, height: 92, borderRadius: '50%', background: C.deep, border: `3px solid ${C.lime}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <AmgMark size={52} />
          </div>
          <div
            style={{
              flex: 1,
              padding: '24px 30px',
              borderRadius: '10px 36px 36px 36px',
              background: 'rgba(255,255,255,0.10)',
              border: '2px solid rgba(255,255,255,0.18)',
              ...ui(32, 500, C.white),
            }}
          >
            <div style={{ ...ui(24, 700, C.lime), marginBottom: 6, letterSpacing: '0.02em' }}>{AMG_IG}</div>
            {frame < 112 ? (
              <TypingDots />
            ) : (
              <span style={{ opacity: rise(frame, 112, 8) }}>Our team is here to help you every step of the way.</span>
            )}
          </div>
          <div style={{ width: 92, height: 92, borderRadius: '50%', background: C.lime, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transform: `scale(${pop(frame, fps, 118)})` }}>
            <Send size={42} color={C.deep} strokeWidth={2.4} />
          </div>
        </div>

        <Cursor
          path={[
            { f: 62, x: 1000, y: 1500 },
            { f: 78, x: 600, y: 1080 },
            { f: 100, x: 640, y: 1100 },
            { f: 120, x: 1060, y: 1700 },
          ]}
          clickAt={[CLICK]}
        />
      </AbsoluteFill>
    </DarkStage>
  );
};

const TypingDots: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', height: 44 }}>
      <MessageCircle size={30} color="rgba(255,255,255,0.6)" style={{ marginRight: 8 }} />
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: C.white,
            opacity: 0.4 + 0.6 * Math.max(0, Math.sin((frame - i * 4) / 4)),
            transform: `translateY(${-4 * Math.max(0, Math.sin((frame - i * 4) / 4))}px)`,
          }}
        />
      ))}
    </span>
  );
};
