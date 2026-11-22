import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const iconsDir = path.resolve(projectRoot, "icons");

function makeChunk(type, data) {
  const len = data.length;
  const chunk = Buffer.alloc(4 + 4 + len + 4);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  const typeAndData = chunk.subarray(4, 8 + len);
  const crc = zlib.crc32(typeAndData);
  chunk.writeUInt32BE(crc >>> 0, 8 + len);
  return chunk;
}

function encodePng(width, height, rgbaBuffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8-bit depth
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0; // Deflate
  ihdrData[11] = 0; // Filter method
  ihdrData[12] = 0; // Interlace method
  const ihdr = makeChunk("IHDR", ihdrData);

  const scanlineLength = 1 + width * 4;
  const rawData = Buffer.alloc(height * scanlineLength);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * scanlineLength;
    rawData[rowOffset] = 0; // Filter 0 (None)
    const srcOffset = y * width * 4;
    rgbaBuffer.copy(rawData, rowOffset + 1, srcOffset, srcOffset + width * 4);
  }

  const idat = makeChunk("IDAT", zlib.deflateSync(rawData, { level: 9 }));
  const iend = makeChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

/**
 * Renders the GlowX Swiss Optical target/reticle mark (#f4f4f6 on transparent background)
 * with 16x16 subpixel supersampling for crisp anti-aliased geometry.
 */
function renderReticleIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const scale = size / 23;
  const rOuter = 8.5 * scale;
  const sw = 1.6 * scale;
  const rDot = 2.8 * scale;
  const swHalf = sw / 2;

  const N = 16;
  const totalSamples = N * N;

  const rColor = 0xf4;
  const gColor = 0xf4;
  const bColor = 0xf6;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < N; sy++) {
        const subY = py + (sy + 0.5) / N;
        const dy = subY - cy;
        for (let sx = 0; sx < N; sx++) {
          const subX = px + (sx + 0.5) / N;
          const dx = subX - cx;
          const d = Math.sqrt(dx * dx + dy * dy);

          if (d <= rDot || Math.abs(d - rOuter) <= swHalf) {
            hits++;
          }
        }
      }

      const idx = (py * size + px) * 4;
      if (hits > 0) {
        const alpha = Math.round((hits / totalSamples) * 255);
        buf[idx] = rColor;
        buf[idx + 1] = gColor;
        buf[idx + 2] = bColor;
        buf[idx + 3] = alpha;
      } else {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
      }
    }
  }

  return encodePng(size, size, buf);
}

export function generateIcons() {
  fs.mkdirSync(iconsDir, { recursive: true });

  const icon23 = renderReticleIcon(23);
  const path23 = path.resolve(iconsDir, "icon_23.png");
  fs.writeFileSync(path23, icon23);
  console.log(`[IconGen] Generated ${path23} (${icon23.length} bytes)`);

  const icon46 = renderReticleIcon(46);
  const path46 = path.resolve(iconsDir, "icon_46.png");
  fs.writeFileSync(path46, icon46);
  console.log(`[IconGen] Generated ${path46} (${icon46.length} bytes)`);
}

generateIcons();
