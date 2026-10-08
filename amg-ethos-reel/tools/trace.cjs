// Trace black-on-white PNGs into single-path SVGs (fill set later via CSS/props).
const potrace = require('potrace');
const fs = require('fs');
const [,, input, output] = process.argv;
potrace.trace(input, { threshold: 128, turdSize: 20, optTolerance: 0.3, color: 'currentColor', background: 'transparent' }, (err, svg) => {
  if (err) throw err;
  fs.writeFileSync(output, svg);
  console.log(output, svg.length);
});
