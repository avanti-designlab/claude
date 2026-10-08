import React from 'react';
import { Composition } from 'remotion';
import { Reel } from './Reel';
import { FPS, HEIGHT, TOTAL, WIDTH } from './theme';

export const RemotionRoot: React.FC = () => (
  <Composition id="AmgEthosReel" component={Reel} durationInFrames={TOTAL} fps={FPS} width={WIDTH} height={HEIGHT} />
);
