import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { Check, FileCheck2, Lock, ShieldCheck, Users, Zap, BatteryFull, Wifi, Signal } from 'lucide-react';
import { EthosWordmark } from '../components/Logos';
import { Cursor, LightStage, MaskLine, Typed, display, ui } from '../components/Kit';
import { C, FONT_UI, easeInOut, easeOut } from '../theme';
import { lerp, pop, rise } from '../motion';

const PHONE = { x: 290, y: 520, w: 500, h: 1030 };
const SCALE = 0.86; // phone is laid out at 500px wide, displayed at 430px
const BUTTON_Y = PHONE.y + (PHONE.h - 16 - 60 - 44) * SCALE;
const SCREEN_PAD = 16;

// Scene-local beats
const STEP2 = 78;
const STEP3 = 124;
const CLICK = 146;
const DONE = 152;

// SaaS-style product hero: a phone running a (generic) online application
// flow, with the four partnership benefits popping in as feature cards.
export const Product: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const phoneIn = pop(frame, fps, 8, { damping: 18, stiffness: 90, mass: 1 });
  const float = Math.sin(frame / 22) * 6;

  return (
    <LightStage>
      <AbsoluteFill>
        <div style={{ position: 'absolute', top: 250, left: 0, right: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <MaskLine at={8} style={{ ...display(92, 800, C.deep), textAlign: 'center' }}>
            Life insurance,
          </MaskLine>
          <MaskLine at={13} style={{ ...display(92, 800, C.green), textAlign: 'center' }}>
            made simple.
          </MaskLine>
        </div>

        {/* phone */}
        <div
          style={{
            position: 'absolute',
            left: PHONE.x,
            top: PHONE.y,
            width: PHONE.w,
            height: PHONE.h,
            transformOrigin: 'top center',
            transform: `translateY(${(1 - phoneIn) * 900 + float}px) perspective(2000px) rotateX(${(1 - phoneIn) * 25}deg) scale(${SCALE})`,
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 78,
              background: 'linear-gradient(145deg, #2A3B33, #0B1712)',
              boxShadow: '0 60px 120px rgba(13,36,25,0.35), 0 0 0 3px rgba(255,255,255,0.08) inset',
            }}
          />
          <div style={{ position: 'absolute', inset: SCREEN_PAD, borderRadius: 64, overflow: 'hidden', background: '#FAFBF8' }}>
            <PhoneScreen />
          </div>
          <div style={{ position: 'absolute', top: 30, left: PHONE.w / 2 - 70, width: 140, height: 38, borderRadius: 30, background: '#0B1712' }} />
        </div>

        <FeatureCard at={40} x={22} y={640} icon={<FileCheck2 size={46} color={C.lime} strokeWidth={2.2} />} title="Simple online" sub="application" />
        <FeatureCard at={86} x={768} y={700} icon={<ShieldCheck size={46} color={C.lime} strokeWidth={2.2} />} title="Convenient &" sub="secure process" />
        <FeatureCard at={DONE + 2} x={22} y={1090} icon={<Zap size={46} color={C.lime} strokeWidth={2.2} />} title="Quick decisions" sub="for many" />
        <FeatureCard at={DONE + 16} x={768} y={950} icon={<Users size={46} color={C.lime} strokeWidth={2.2} />} title="Coverage for" sub="your family's future" />

        <Cursor
          path={[
            { f: 112, x: 980, y: 1700 },
            { f: 138, x: 560, y: BUTTON_Y },
            { f: 160, x: 600, y: BUTTON_Y + 16 },
            { f: 190, x: 980, y: 1720 },
          ]}
          clickAt={[CLICK]}
        />
      </AbsoluteFill>
    </LightStage>
  );
};

const FeatureCard: React.FC<{ at: number; x: number; y: number; icon: React.ReactNode; title: string; sub: string }> = ({ at, x, y, icon, title, sub }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = pop(frame, fps, at, { damping: 12, stiffness: 160, mass: 0.7 });
  const bob = Math.sin((frame + at * 3) / 18) * 5;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y + bob,
        width: 290,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 16,
        padding: '24px 24px 26px',
        borderRadius: 32,
        background: 'rgba(255,255,255,0.92)',
        border: '2px solid rgba(31,72,51,0.08)',
        boxShadow: '0 30px 60px rgba(13,36,25,0.18), 0 6px 14px rgba(13,36,25,0.08)',
        transform: `scale(${s}) translateY(${(1 - s) * 40}px)`,
        opacity: Math.min(1, s * 1.4),
      }}
    >
      <div style={{ width: 80, height: 80, flexShrink: 0, borderRadius: 24, background: C.deep, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </div>
      <div>
        <div style={{ ...ui(29, 700, C.deep), lineHeight: 1.15 }}>{title}</div>
        <div style={{ ...ui(27, 500, C.forest), lineHeight: 1.2 }}>{sub}</div>
      </div>
    </div>
  );
};

/* ---------- Phone UI ---------- */

const W = PHONE.w - SCREEN_PAD * 2;

const PhoneScreen: React.FC = () => {
  const frame = useCurrentFrame();
  const step = frame < STEP2 ? 1 : frame < STEP3 ? 2 : 3;
  const progress = lerp(frame, [20, STEP2, STEP3, DONE], [0.12, 0.45, 0.8, 1], easeInOut);

  return (
    <div style={{ width: W, height: '100%', fontFamily: FONT_UI, color: C.deep, position: 'relative' }}>
      {/* status bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '24px 40px 0 44px', height: 60, ...ui(22, 600, C.deep) }}>
        <span>9:41</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Signal size={22} color={C.deep} />
          <Wifi size={22} color={C.deep} />
          <BatteryFull size={26} color={C.deep} />
        </span>
      </div>
      {/* app bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '36px 34px 0' }}>
        <EthosWordmark height={30} />
        <span style={{ ...ui(20, 600, C.forest), background: 'rgba(30,145,93,0.1)', padding: '8px 14px', borderRadius: 999 }}>
          {frame < DONE ? `Step ${step} of 3` : 'Complete'}
        </span>
      </div>
      <div style={{ margin: '24px 34px 0', height: 10, borderRadius: 10, background: '#E5EAE3', overflow: 'hidden' }}>
        <div style={{ width: `${progress * 100}%`, height: '100%', borderRadius: 10, background: `linear-gradient(90deg, ${C.green}, ${C.lime})` }} />
      </div>

      <div style={{ position: 'absolute', top: 210, left: 34, right: 34, bottom: 0 }}>
        <Panel from={0} to={STEP2}>
          <StepAbout />
        </Panel>
        <Panel from={STEP2} to={STEP3}>
          <StepCoverage />
        </Panel>
        <Panel from={STEP3} to={DONE}>
          <StepReview />
        </Panel>
        <Panel from={DONE} to={9999}>
          <StepDone />
        </Panel>
      </div>
    </div>
  );
};

/** Slides a panel in from the right and out to the left. */
const Panel: React.FC<{ from: number; to: number; children: React.ReactNode }> = ({ from, to, children }) => {
  const frame = useCurrentFrame();
  if (frame < from - 1 || frame > to + 10) return null;
  const inP = from === 0 ? 1 : lerp(frame, [from + 5, from + 17], [0, 1], easeOut);
  const outP = lerp(frame, [to, to + 6], [0, 1], easeInOut);
  return (
    <div style={{ position: 'absolute', inset: 0, transform: `translateX(${(1 - inP) * 120 - outP * 120}px)`, opacity: Math.min(inP, 1 - outP) }}>
      {children}
    </div>
  );
};

const H: React.FC<{ title: string; sub: string }> = ({ title, sub }) => (
  <div style={{ marginBottom: 30 }}>
    <div style={{ ...ui(38, 700, C.deep), letterSpacing: '-0.02em', lineHeight: 1.15 }}>{title}</div>
    <div style={{ ...ui(22, 500, '#6B7C72'), marginTop: 8 }}>{sub}</div>
  </div>
);

const Field: React.FC<{ label: string; value: string; at: number }> = ({ label, value, at }) => {
  const frame = useCurrentFrame();
  const active = frame >= at && frame < at + value.length / 1.4 + 6;
  const done = frame >= at + value.length / 1.4;
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ ...ui(19, 600, '#6B7C72'), marginBottom: 8, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</div>
      <div
        style={{
          height: 74,
          borderRadius: 18,
          border: `2px solid ${active ? C.green : '#DDE3DB'}`,
          boxShadow: active ? '0 0 0 5px rgba(30,145,93,0.15)' : 'none',
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 22px',
          ...ui(26, 600, C.deep),
        }}
      >
        <Typed text={value} at={at} caret={active} />
        {done && <Check size={26} color={C.green} strokeWidth={3} />}
      </div>
    </div>
  );
};

const PrimaryButton: React.FC<{ label: string; pressedAt?: number }> = ({ label, pressedAt }) => {
  const frame = useCurrentFrame();
  const press = pressedAt !== undefined && frame >= pressedAt - 2 && frame <= pressedAt + 4 ? 0.95 : 1;
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 60,
        height: 88,
        borderRadius: 24,
        background: C.deep,
        color: C.lime,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...ui(28, 700, C.lime),
        transform: `scale(${press})`,
        boxShadow: '0 16px 30px rgba(31,72,51,0.3)',
      }}
    >
      {label}
    </div>
  );
};

const StepAbout: React.FC = () => (
  <div style={{ position: 'relative', height: '100%' }}>
    <H title="Tell us about you" sub="Takes just a few minutes" />
    <Field label="Full name" value="Alex Rivera" at={26} />
    <Field label="Date of birth" value="05 / 14 / 1988" at={40} />
    <Field label="ZIP code" value="48038" at={58} />
    <PrimaryButton label="Continue" />
  </div>
);

const StepCoverage: React.FC = () => {
  const frame = useCurrentFrame();
  const s = lerp(frame, [STEP2 + 8, STEP2 + 34], [0.15, 0.62], easeInOut);
  const amount = Math.round((100000 + s * 650000) / 25000) * 25000;
  const term = frame > STEP2 + 30 ? 1 : 0;
  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <H title="Choose your coverage" sub="Adjust anytime before you apply" />
      <div style={{ ...ui(66, 800, C.deep), letterSpacing: '-0.03em', marginBottom: 26 }}>${amount.toLocaleString('en-US')}</div>
      <div style={{ position: 'relative', height: 12, borderRadius: 10, background: '#E5EAE3', marginBottom: 46 }}>
        <div style={{ width: `${s * 100}%`, height: '100%', borderRadius: 10, background: C.green }} />
        <div
          style={{
            position: 'absolute',
            left: `calc(${s * 100}% - 22px)`,
            top: -16,
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: '#fff',
            border: `4px solid ${C.green}`,
            boxShadow: '0 6px 14px rgba(0,0,0,0.15)',
          }}
        />
      </div>
      <div style={{ ...ui(19, 600, '#6B7C72'), marginBottom: 12, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Term length</div>
      <div style={{ display: 'flex', gap: 14 }}>
        {['10 yrs', '20 yrs', '30 yrs'].map((t, i) => (
          <div
            key={t}
            style={{
              flex: 1,
              height: 70,
              borderRadius: 18,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              ...ui(24, 700, i === term ? C.deep : '#6B7C72'),
              background: i === term ? C.lime : '#fff',
              border: `2px solid ${i === term ? C.lime : '#DDE3DB'}`,
            }}
          >
            {t}
          </div>
        ))}
      </div>
      <PrimaryButton label="Continue" />
    </div>
  );
};

const StepReview: React.FC = () => (
  <div style={{ position: 'relative', height: '100%' }}>
    <H title="Review & submit" sub="Almost done — one quick check" />
    {['About you', 'Coverage', 'Beneficiaries'].map((r) => (
      <div key={r} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 0', borderBottom: '2px solid #E9EDE7', ...ui(26, 600, C.deep) }}>
        {r}
        <span style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(30,145,93,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Check size={24} color={C.green} strokeWidth={3} />
        </span>
      </div>
    ))}
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 28, ...ui(20, 500, '#6B7C72') }}>
      <Lock size={20} color={C.forest} /> Convenient &amp; secure
    </div>
    <PrimaryButton label="Submit application" pressedAt={CLICK} />
  </div>
);

const StepDone: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ring = pop(frame, fps, DONE + 2, { damping: 11, stiffness: 150, mass: 0.7 });
  const draw = lerp(frame, [DONE + 8, DONE + 20], [0, 1], easeOut);
  const burst = lerp(frame, [DONE + 4, DONE + 26], [0, 1], easeOut);
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 70 }}>
      <div style={{ position: 'relative', width: 200, height: 200 }}>
        {Array.from({ length: 10 }).map((_, i) => {
          const a = (i / 10) * Math.PI * 2;
          const d = 80 + burst * 70;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: 100 + Math.cos(a) * d - 8,
                top: 100 + Math.sin(a) * d - 8,
                width: 16,
                height: 16,
                borderRadius: i % 2 ? '50%' : 3,
                background: i % 2 ? C.lime : C.green,
                opacity: burst > 0 ? 1 - burst : 0,
              }}
            />
          );
        })}
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: C.deep, transform: `scale(${ring})`, boxShadow: `0 0 0 ${16 * ring}px rgba(188,240,49,0.35)` }} />
        <svg width={200} height={200} viewBox="0 0 200 200" style={{ position: 'absolute', inset: 0 }}>
          <path d="M60 104 L88 130 L142 74" fill="none" stroke={C.lime} strokeWidth={16} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
        </svg>
      </div>
      <div style={{ ...ui(38, 700, C.deep), marginTop: 50, textAlign: 'center', opacity: rise(frame, DONE + 10, 12), letterSpacing: '-0.02em' }}>Application submitted!</div>
      <div style={{ ...ui(24, 500, '#6B7C72'), marginTop: 14, textAlign: 'center', opacity: rise(frame, DONE + 14, 12), maxWidth: 360 }}>
        Quick decisions for many applicants.
      </div>
    </div>
  );
};
