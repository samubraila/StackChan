// SPDX-License-Identifier: MIT
// Packs the PNG sizes in build/icons/ into build/icon.ico (PNG-compressed ICO entries).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const buildDir = path.join(__dirname, '..', 'build');
const sizes = [16, 24, 32, 48, 64, 128, 256];

const images = sizes.map((size) => {
  const data = fs.readFileSync(path.join(buildDir, 'icons', `${size}.png`));
  return { size, data };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);

const entries = [];
let offset = 6 + images.length * 16;
for (const { size, data } of images) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2); // palette colours
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += data.length;
}

fs.writeFileSync(path.join(buildDir, 'icon.ico'), Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
console.log(`build/icon.ico geschrieben (${sizes.join(', ')} px)`);
