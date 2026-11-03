// Gera os ícones PNG (apple-touch-icon e PWA) desenhando o radar à mão, sem dependências.
'use strict';
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

function png(w, h, px) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// cor de um ponto (coordenadas 0..64, como o icon.svg); fundo cheio para o iPhone
function color(x, y, maskable) {
  const bg = [11, 15, 21], red = [239, 68, 68];
  const cx = 32, cy = 32, d = Math.hypot(x - cx, y - cy);
  const s = maskable ? 0.8 : 1; // ícone "maskable": margem de segurança
  const R = 22 * s, ring = 2 * s, dot = 7 * s;
  if (d <= dot) return red;
  if (Math.abs(d - R) <= ring) return red;
  const a = Math.atan2(x - cx, -(y - cy)); // 0 = para cima, sentido horário
  if (d < R && a >= 0 && a <= Math.PI / 3) return bg.map((c, i) => Math.round(c + (red[i] - c) * 0.55));
  return bg;
}

function icon(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
      const c = color(((x + (i + 0.5) / ss) / size) * 64, ((y + (j + 0.5) / ss) / size) * 64, maskable);
      r += c[0]; g += c[1]; b += c[2];
    }
    const o = (y * size + x) * 4, n = ss * ss;
    px[o] = r / n; px[o + 1] = g / n; px[o + 2] = b / n; px[o + 3] = 255;
  }
  return png(size, size, px);
}

const out = path.join(__dirname, '..', 'public');
fs.writeFileSync(path.join(out, 'icon-180.png'), icon(180, false));
fs.writeFileSync(path.join(out, 'icon-192.png'), icon(192, false));
fs.writeFileSync(path.join(out, 'icon-512.png'), icon(512, false));
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), icon(512, true));
console.log('ícones gerados');
