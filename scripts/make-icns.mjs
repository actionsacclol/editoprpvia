// Build resources/krypt.icns from build/icon.png. The icns format is a plain
// container of PNG blobs, so this works from any OS — no iconutil needed.
// Entry types: ic09 = 512px PNG, ic10 = 1024px (512@2x) PNG.
import { Jimp } from 'jimp';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function pngAt(size) {
  const img = await Jimp.read(`${ROOT}/build/icon.png`);
  img.resize({ w: size, h: size });
  return img.getBuffer('image/png');
}

function entry(type, png) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(8 + png.length, 4);
  return Buffer.concat([head, png]);
}

const entries = [entry('ic10', await pngAt(1024)), entry('ic09', await pngAt(512))];
const body = Buffer.concat(entries);
const header = Buffer.alloc(8);
header.write('icns', 0, 'ascii');
header.writeUInt32BE(8 + body.length, 4);
fs.writeFileSync(`${ROOT}/resources/krypt.icns`, Buffer.concat([header, body]));
console.log(`wrote resources/krypt.icns (${8 + body.length} bytes)`);
