// The 1200×630 share image (og:image, twitter:image), drawn pixel by pixel and encoded as a PNG with node:zlib:
// no image library, nothing downloaded or copied. Text is set in a 5×7 dot-matrix font, like a receipt
// printer's. The numbers are the home page's sample receipt (site/sample.prreceipt.json, feat/checkout-flow).
import { deflateSync } from 'node:zlib';

export const WIDTH = 1200;
export const HEIGHT = 630;

/** What the image's receipt says: site/sample.prreceipt.json, rounded to cents (a test keeps them in step). */
export const SHARE_RECEIPT = {
  branch: 'feat/checkout-flow',
  models: [
    ['SONNET 4.5', '$2.17'],
    ['OPUS 4.5', '$0.67'],
    ['GPT-5-CODEX', '$0.20'],
  ],
  total: '$3.03',
  sessions: '5',
  tokens: '3.1M',
  linesChanged: '370',
  perLine: '$0.0082',
} as const;

type Rgb = readonly [number, number, number];
const rgb = (hex: string): Rgb => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16)) as unknown as Rgb;

const COLORS = {
  background: rgb('#101418'),
  shadow: rgb('#080a0c'),
  headline: rgb('#f6f2e8'),
  accent: rgb('#3ddc84'),
  muted: rgb('#9aa4b2'),
  paper: rgb('#f6f2e8'),
  ink: rgb('#22262b'),
  inkMuted: rgb('#6b7280'),
  rule: rgb('#b9b2a3'),
  total: rgb('#0f7b4f'),
};

// 5×7 glyphs, one string per row, '#' = dot. Upper case only, as on a till roll.
const FONT: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  $: ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  '/': ['.....', '....#', '...#.', '..#..', '.#...', '#....', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
};

/** Columns per character: 5 for the glyph and 1 between characters. */
const CELL = 6;

/** Width in pixels of `text` at `scale` (no trailing gap). */
export const textWidth = (text: string, scale: number): number => (text.length * CELL - 1) * scale;

class Canvas {
  readonly width: number;
  readonly height: number;
  readonly pixels: Buffer;
  constructor(width: number, height: number, background: Rgb) {
    this.width = width;
    this.height = height;
    this.pixels = Buffer.alloc(width * height * 3);
    this.rect(0, 0, width, height, background);
  }

  rect(x: number, y: number, w: number, h: number, color: Rgb): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const i = (py * this.width + px) * 3;
        this.pixels[i] = color[0];
        this.pixels[i + 1] = color[1];
        this.pixels[i + 2] = color[2];
      }
    }
  }

  /** Each dot is a `scale`-sized square, minus `gap` pixels so the dots of a receipt printer show. */
  text(text: string, x: number, y: number, scale: number, color: Rgb, gap = 0): void {
    [...text].forEach((ch, i) => {
      const glyph = FONT[ch];
      if (!glyph) throw new Error(`share image: no glyph for ${JSON.stringify(ch)}`);
      glyph.forEach((row, gy) => {
        [...row].forEach((dot, gx) => {
          if (dot === '#') this.rect(x + (i * CELL + gx) * scale, y + gy * scale, scale - gap, scale - gap, color);
        });
      });
    });
  }

  /** `left` at x and `right` ending at x + width: a till-roll line. */
  line(left: string, right: string, x: number, width: number, y: number, scale: number, color: Rgb, gap = 0): void {
    this.text(left, x, y, scale, color, gap);
    this.text(right, x + width - textWidth(right, scale), y, scale, color, gap);
  }

  centered(text: string, x: number, width: number, y: number, scale: number, color: Rgb, gap = 0): void {
    this.text(text, x + Math.round((width - textWidth(text, scale)) / 2), y, scale, color, gap);
  }

  dashes(x: number, width: number, y: number, color: Rgb): void {
    for (let dx = 0; dx + 8 <= width; dx += 14) this.rect(x + dx, y, 8, 3, color);
  }
}

/** A receipt torn off the printer: a straight top edge above the image, a zigzag bottom edge. */
function paper(c: Canvas, x: number, w: number, bottom: number, color: Rgb): void {
  const tooth = 12;
  for (let px = 0; px < w; px += 1) {
    const phase = px % (2 * tooth);
    const depth = phase < tooth ? phase : 2 * tooth - phase;
    c.rect(x + px, 0, 1, bottom - tooth + depth, color);
  }
}

export function drawShareImage(): Buffer {
  const c = new Canvas(WIDTH, HEIGHT, COLORS.background);

  // Left: what it is.
  const left = 80;
  c.text('PR RECEIPT', left, 76, 4, COLORS.accent);
  ['WHAT DID THIS', 'PULL REQUEST', 'COST IN AI', 'TOKENS?'].forEach((l, i) => c.text(l, left, 148 + i * 72, 7, COLORS.headline));
  c.text('FREE CLI FOR CLAUDE CODE', left, 462, 3, COLORS.muted);
  c.text('AND CODEX. RUNS ON YOUR', left, 496, 3, COLORS.muted);
  c.text('MACHINE. POSTS ON THE PR.', left, 530, 3, COLORS.muted);

  // Right: the sample receipt.
  const px = 694;
  const pw = 426;
  const bottom = 590;
  paper(c, px + 10, pw, bottom + 10, COLORS.shadow);
  paper(c, px, pw, bottom, COLORS.paper);
  const x = px + 34;
  const w = pw - 68;
  const r = SHARE_RECEIPT;
  c.centered('PR RECEIPT', x, w, 42, 4, COLORS.ink, 1);
  c.centered(r.branch.toUpperCase(), x, w, 92, 3, COLORS.inkMuted);
  c.dashes(x, w, 134, COLORS.rule);
  r.models.forEach(([model, cost], i) => c.line(model, cost, x, w, 156 + i * 34, 3, COLORS.ink));
  c.dashes(x, w, 266, COLORS.rule);
  c.line('TOTAL', r.total, x, w, 290, 5, COLORS.total, 1);
  c.dashes(x, w, 348, COLORS.rule);
  c.line('SESSIONS', r.sessions, x, w, 370, 3, COLORS.ink);
  c.line('TOKENS', r.tokens, x, w, 404, 3, COLORS.ink);
  c.line('LINES CHANGED', r.linesChanged, x, w, 438, 3, COLORS.ink);
  c.line('PER LINE', r.perLine, x, w, 472, 3, COLORS.ink);
  c.dashes(x, w, 514, COLORS.rule);
  c.centered('API-EQUIVALENT ESTIMATE', x, w, 536, 2, COLORS.inkMuted);

  return encodePng(c.width, c.height, c.pixels);
}

// ── PNG ─────────────────────────────────────────────────────────────────────

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 8-bit RGB, no interlace, filter 0 on every row: plain and valid, and small since the image is flat colour. */
export function encodePng(width: number, height: number, pixels: Buffer): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
