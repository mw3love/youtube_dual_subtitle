// SVG 원본을 16/32/48/128 PNG로 변환해 public/icons/에 저장.
// Chrome Web Store 등록 시 사용. SVG 수정하고 다시 돌리면 됨.
//
// 실행: npm run icons

import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(here, '../design/icon-source.svg');
const outDir = resolve(here, '../public/icons');

mkdirSync(outDir, { recursive: true });

const svgBuffer = readFileSync(svgPath);
const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  const out = resolve(outDir, `icon-${size}.png`);
  await sharp(svgBuffer).resize(size, size).png().toFile(out);
  console.log(`✓ ${size}x${size} → ${out}`);
}

console.log(`Done — ${sizes.length} icons written.`);
