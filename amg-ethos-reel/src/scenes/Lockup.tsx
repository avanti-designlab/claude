import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { Handshake, Plus } from 'lucide-react';
import { AmgLogo, AMG_WORD_RATIO, ETHOS_O, ETHOS_WORD_RATIO, EthosMark, EthosWordmark } from '../components/Logos';
import { LightStage, Pill, ui } from '../components/Kit';
import { C, easeInOut, easeOut } from '../theme';
import { lerp, pop, rise } from '../motion';

const AMG_H = 140;
const ETHOS_H = 150;
const AMG_Y = 520;
const BADGE_Y = 880;
const ETHOS_Y = 1110;

// Partnership lockup on AMG's light stage: AMG assembles, a "+" badge links
// the two brands, and the Ethos swoosh spins in and lands as the "O".
export const Lockup: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // AMG logo
  const amgW = AMG_H * (86.7 / 93) + (AMG_H * 4.3) / 93 + AMG_H * AMG_WORD_RATIO;
  const wordReveal = rise(frame, 16, 22);

  // Connector + badge
  const line = lerp(frame, [28, 44], [0, 1], easeInOut);
  const badge = pop(frame, fps, 36);

  // Ethos mark → "O" in the wordmark
  const ethosW = ETHOS_H * ETHOS_WORD_RATIO;
  const ethosLeft = 540 - ethosW / 2;
  const oCx = ethosLeft + ((ETHOS_O.x0 + ETHOS_O.x1) / 2 / 2000) * ethosW;
  const oCy = ETHOS_Y + ETHOS_H / 2;
  const markFinal = (ETHOS_H * 509) / 470;
  const enter = pop(frame, fps, 42, { damping: 16, stiffness: 120, mass: 0.9 });
  const land = lerp(frame, [58, 76], [0, 1], easeInOut);
  const markSize = (380 + (markFinal - 380) * land) * enter;
  const markCx = 540 + (oCx - 540) * land;
  const markCy = oCy;
  const markRot = (1 - enter) * -360 + lerp(frame, [42, 76], [-200, 0], easeOut);
  const wordP = lerp(frame, [70, 90], [0, 1], easeOut);
  const markFade = 1 - lerp(frame, [80, 86], [0, 1]);
  // reveal the wordmark outward from the "O"
  const oPct = ((ETHOS_O.x0 + ETHOS_O.x1) / 2 / 2000) * 100;
  const clipL = oPct * (1 - wordP);
  const clipR = (100 - oPct) * (1 - wordP);

  const tag = rise(frame, 84, 20);

  return (
    <LightStage>
      <AbsoluteFill>
        {/* AMG */}
        <div style={{ position: 'absolute', top: AMG_Y, left: 540 - amgW / 2 }}>
          <AmgLogo
            height={AMG_H}
            word={C.deep}
            colorA={C.green}
            colorB={C.deep}
            dotProgress={(i) => pop(frame, fps, 4 + i * 1.4)}
            wordStyle={{ clipPath: `inset(0 ${(1 - wordReveal) * 100}% 0 0)`, transform: `translateX(${(1 - wordReveal) * -40}px)` }}
          />
        </div>

        {/* connector */}
        <div style={{ position: 'absolute', left: 538, top: AMG_Y + AMG_H + 50, width: 4, height: (BADGE_Y - 75 - (AMG_Y + AMG_H + 50)) * line, background: C.deep, borderRadius: 4 }} />
        <div
          style={{
            position: 'absolute',
            left: 538,
            top: BADGE_Y + 75,
            width: 4,
            height: (ETHOS_Y - 70 - (BADGE_Y + 75)) * line,
            background: C.deep,
            borderRadius: 4,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 540 - 72,
            top: BADGE_Y - 72,
            width: 144,
            height: 144,
            borderRadius: '50%',
            background: C.deep,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: `scale(${badge}) rotate(${(1 - badge) * 180}deg)`,
            boxShadow: `0 0 0 ${14 * badge}px rgba(188,240,49,0.55), 0 24px 50px rgba(13,36,25,0.25)`,
          }}
        >
          <Plus size={80} color={C.lime} strokeWidth={3.2} />
        </div>

        {/* Ethos */}
        <div style={{ position: 'absolute', top: ETHOS_Y, left: ethosLeft, clipPath: `inset(-10px ${clipR}% -10px ${clipL}%)`, opacity: wordP > 0 ? 1 : 0 }}>
          <EthosWordmark height={ETHOS_H} />
        </div>
        {markFade > 0 && enter > 0.01 && (
          <div
            style={{
              position: 'absolute',
              left: markCx - markSize / 2,
              top: markCy - markSize / 2,
              opacity: markFade,
              transform: `rotate(${markRot}deg)`,
              filter: `drop-shadow(0 20px 40px rgba(5,72,67,${0.3 * (1 - land)}))`,
            }}
          >
            <EthosMark size={markSize} />
          </div>
        )}
        <div
          style={{
            position: 'absolute',
            top: ETHOS_Y + ETHOS_H + 34,
            left: 0,
            right: 0,
            textAlign: 'center',
            ...ui(34, 600, C.ethos),
            letterSpacing: `${0.3 + (1 - tag) * 0.3}em`,
            opacity: tag,
          }}
        >
          LIFE INSURANCE
        </div>

        <div style={{ position: 'absolute', top: 1470, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
          <Pill at={92} dark={false}>
            <Handshake size={36} color={C.green} strokeWidth={2.4} /> Official Partnership
          </Pill>
        </div>
      </AbsoluteFill>
    </LightStage>
  );
};
