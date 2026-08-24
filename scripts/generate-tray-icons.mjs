import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

function createPng(width, height, pixelFn) {
  const rowLen = 1 + width * 4;
  const raw = Buffer.alloc(height * rowLen);
  
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowLen;
    raw[rowOffset] = 0; // Filter byte: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const pxOffset = rowOffset + 1 + x * 4;
      raw[pxOffset] = r;
      raw[pxOffset + 1] = g;
      raw[pxOffset + 2] = b;
      raw[pxOffset + 3] = a;
    }
  }
  
  const deflated = zlib.deflateSync(raw);
  
  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const combined = Buffer.concat([t, data]);
    const crc = crc32(combined);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc, 0);
    return Buffer.concat([len, t, data, crcBuf]);
  }
  
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }

  function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
  }
  
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8-bit
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  
  const ihdr = makeChunk('IHDR', ihdrData);
  const idat = makeChunk('IDAT', deflated);
  const iend = makeChunk('IEND', Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdr, idat, iend]);
}

fs.mkdirSync('resources', { recursive: true });

// 1. Desk (Green microphone badge)
const deskPng = createPng(32, 32, (x, y) => {
  const inBox = x >= 2 && x <= 29 && y >= 2 && y <= 29;
  const inCorner = (x <= 6 || x >= 25) && (y <= 6 || y >= 25);
  const cornerDist = Math.min(
    Math.hypot(x - 6, y - 6),
    Math.hypot(x - 25, y - 6),
    Math.hypot(x - 6, y - 25),
    Math.hypot(x - 25, y - 25)
  );
  if (!inBox || (inCorner && cornerDist > 4.5)) return [0, 0, 0, 0];
  
  // Microphone shape
  const isCap = (x >= 13 && x <= 18 && y >= 7 && y <= 16);
  const isRing = (Math.abs(x - 16) <= 5 && y >= 12 && y <= 18 && (Math.abs(x - 16) >= 4 || y >= 17));
  const isStem = (x >= 15 && x <= 17 && y >= 19 && y <= 22);
  const isBase = (x >= 11 && x <= 21 && y >= 23 && y <= 24);
  
  if (isCap || isRing || isStem || isBase) {
    return [255, 255, 255, 255];
  }
  
  // Emerald Green
  return [16, 185, 129, 255];
});
fs.writeFileSync('resources/tray-desk.png', deskPng);

// 2. Away (Amber / Orange Headphones)
const awayPng = createPng(32, 32, (x, y) => {
  const inBox = x >= 2 && x <= 29 && y >= 2 && y <= 29;
  const inCorner = (x <= 6 || x >= 25) && (y <= 6 || y >= 25);
  const cornerDist = Math.min(
    Math.hypot(x - 6, y - 6),
    Math.hypot(x - 25, y - 6),
    Math.hypot(x - 6, y - 25),
    Math.hypot(x - 25, y - 25)
  );
  if (!inBox || (inCorner && cornerDist > 4.5)) return [0, 0, 0, 0];
  
  const archDist = Math.hypot(x - 16, y - 16);
  const isArch = (archDist >= 8 && archDist <= 11 && y <= 16);
  const isLeftCup = (x >= 6 && x <= 9 && y >= 13 && y <= 21);
  const isRightCup = (x >= 22 && x <= 25 && y >= 13 && y <= 21);
  const isMicBoom = (x >= 9 && x <= 16 && y >= 21 && y <= 23);
  
  if (isArch || isLeftCup || isRightCup || isMicBoom) {
    return [255, 255, 255, 255];
  }
  
  // Amber / Orange
  return [245, 158, 11, 255];
});
fs.writeFileSync('resources/tray-away.png', awayPng);

// 3. Default / Grey
const defPng = createPng(32, 32, (x, y) => {
  const inBox = x >= 2 && x <= 29 && y >= 2 && y <= 29;
  const inCorner = (x <= 6 || x >= 25) && (y <= 6 || y >= 25);
  const cornerDist = Math.min(
    Math.hypot(x - 6, y - 6),
    Math.hypot(x - 25, y - 6),
    Math.hypot(x - 6, y - 25),
    Math.hypot(x - 25, y - 25)
  );
  if (!inBox || (inCorner && cornerDist > 4.5)) return [0, 0, 0, 0];
  
  const isCap = (x >= 13 && x <= 18 && y >= 7 && y <= 16);
  const isRing = (Math.abs(x - 16) <= 5 && y >= 12 && y <= 18 && (Math.abs(x - 16) >= 4 || y >= 17));
  const isStem = (x >= 15 && x <= 17 && y >= 19 && y <= 22);
  const isBase = (x >= 11 && x <= 21 && y >= 23 && y <= 24);
  
  if (isCap || isRing || isStem || isBase) {
    return [255, 255, 255, 255];
  }
  
  // Slate Grey
  return [100, 116, 139, 255];
});
fs.writeFileSync('resources/tray-default.png', defPng);
fs.writeFileSync('resources/icon.png', deskPng);

console.log('PNG Tray icons created in resources/');
