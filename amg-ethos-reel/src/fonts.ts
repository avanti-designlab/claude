import { loadFont } from '@remotion/fonts';
import { staticFile } from 'remotion';

const faces: Array<[string, number, string]> = [
  ['Poppins', 600, 'poppins-latin-600-normal.woff2'],
  ['Poppins', 700, 'poppins-latin-700-normal.woff2'],
  ['Poppins', 800, 'poppins-latin-800-normal.woff2'],
  ['Poppins', 900, 'poppins-latin-900-normal.woff2'],
  ['Inter', 400, 'inter-latin-400-normal.woff2'],
  ['Inter', 500, 'inter-latin-500-normal.woff2'],
  ['Inter', 600, 'inter-latin-600-normal.woff2'],
  ['Inter', 700, 'inter-latin-700-normal.woff2'],
];

// loadFont() blocks rendering (delayRender) until each face is ready.
for (const [family, weight, file] of faces) {
  loadFont({ family, weight: String(weight), url: staticFile(`fonts/${file}`) });
}
