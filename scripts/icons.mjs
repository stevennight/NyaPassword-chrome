// Renders the extension icons from the shared logo (common/web/public/favicon.svg).
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const svg = readFileSync(new URL('../../common/web/public/favicon.svg', import.meta.url), 'utf8');
mkdirSync(new URL('../src/public/icon/', import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 96, 128]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(new URL(`../src/public/icon/${size}.png`, import.meta.url), png);
}
console.log('icons written');
