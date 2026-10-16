// The pixel art of the office, drawn in code: people as palette maps (16 by 24,
// one character per pixel), furniture and floors as painted rectangles. The
// maps are plain data; painting needs a canvas, and each piece is painted once
// into its own small canvas and reused. At night (the dark theme) every piece
// is dimmed, and what gives light (screens, lamps, the vending machine) is not.
import type { Area, Door, Prop, PropKind } from "./layout.ts";
import { FACE, WALL } from "./layout.ts";

export const CHAR_W = 16;
export const CHAR_H = 24;
export type View = "down" | "up" | "right" | "left";
export type Frame = "stand" | "walkA" | "walkB" | "sit" | "typeA" | "typeB" | "rest";
export const HAIR_STYLES = ["short", "long", "bun", "curly", "spiky"] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];

// k outline, e eye, s skin, t skin shade, m blush, h hair, g hair shade, l hair light,
// c shirt, d shirt shade, w collar, p trousers, q trousers shade, b shoes.
const HEAD: Record<"down" | "up" | "right", string[]> = {
  down: [
    "................",
    "....kkkkkkkk....",
    "...khhhhhhhhk...",
    "..khhlllhhhhhk..",
    "..khhhhhhhhhhk..",
    "..khhhhhhhhhgk..",
    "..khssssssssgk..",
    "..khsessssesgk..",
    "..khsessssesgk..",
    "..ksmssssssmsk..",
    "...ksssttsssk...",
  ],
  up: [
    "................",
    "....kkkkkkkk....",
    "...khhhhhhhhk...",
    "..khhlllhhhhhk..",
    "..khhhhhhhhhhk..",
    "..khhhhhhhhhhk..",
    "..khhhhhhhhhgk..",
    "..kghhhhhhhhgk..",
    "..kgghhhhhhggk..",
    "..ksggggggggsk..",
    "...kssssssssk...",
  ],
  right: [
    "................",
    ".....kkkkkkk....",
    "....khhhhhhhk...",
    "...khhhlllhhhk..",
    "...khhhhhhhhhk..",
    "...khhhhhhhhhhk.",
    "...khhhhhgsssk..",
    "...khhhhgsssesk.",
    "...khhhtssssesk.",
    "...kggsssssssk..",
    "....kgssssssk...",
  ],
};

const LEGS = {
  stand: ["...kpppkkpppk...", "...kqqqkkqqqk...", "...kbbbkkbbbk...", "....kkk..kkk...."],
  walkA: ["...kpppkkpppk...", "...kqqqkkbbbk...", "...kbbbk.kkk....", "....kkk........."],
  walkB: ["...kpppkkpppk...", "...kbbbkkqqqk...", "....kkk.kbbbk...", ".........kkk...."],
  sit: ["..kqqqqqqqqqqk..", "...kbbbkkbbbk...", "....kkk..kkk....", "................"],
};
const BLANK = "................";

const BODY_DOWN = [
  "....kkttttkk....",
  "...kkcwwwwckk...",
  "..kccccwwcccck..",
  ".kdccccccccccdk.",
  ".kdccccccccccdk.",
  ".ksdccccccccdsk.",
  "..kkddddddddkk..",
  "...kppppppppk...",
  "...kppppppppk...",
];
const BODY_UP = [
  "....kksssskk....",
  "...kkcccccckk...",
  "..kcccccccccck..",
  ".kdccccddccccdk.",
  ".kdccccddccccdk.",
  ".ksdccccccccdsk.",
  "..kkddddddddkk..",
  "...kppppppppk...",
  "...kppppppppk...",
];
/** Seated at a desk, seen from behind: the elbows move as they type; the chair hides the rest. */
const BODY_TYPE = {
  typeA: [".kdccccddccccdk.", "kddccccddccccdk.", ".kkdccccccccdkk.", "..kkddddddddkk.."],
  typeB: [".kdccccddccccdk.", ".kdccccddccccddk", ".kkdccccccccdkk.", "..kkddddddddkk.."],
  rest: [".kdccccddccccdk.", ".kdccccddccccdk.", ".kkdccccccccdkk.", "..kkddddddddkk.."],
};
const BODY_RIGHT = [
  ".....kkssk......",
  ".....kcccck.....",
  "....kccccccck...",
  "....kccddccck...",
  "....kccddccck...",
  "....kccssccck...",
  "....kkddddddk...",
  ".....kppppk.....",
];
const LEGS_RIGHT = {
  stand: [".....kppppk.....", ".....kppppk.....", ".....kqqqqk.....", ".....kbbbbbk....", "......kkkkk....."],
  walkA: ["....kppkppk.....", "...kppk.kppk....", "...kqqk.kqqk....", "..kbbbk.kbbbk...", "...kkk...kkk...."],
};

/** Hair laid over the head, per style and view: the first row it covers, then rows; "." keeps what is under. */
const HAIR: Record<HairStyle, Partial<Record<"down" | "up" | "right", { from: number; rows: string[] }>>> = {
  short: {},
  long: {
    down: {
      from: 5,
      rows: [
        ".k............k.",
        ".kh..........hk.",
        ".kh..........hk.",
        ".kh..........hk.",
        ".khh........hhk.",
        ".khh........hhk.",
        ".kgh........hgk.",
        ".kgh........hgk.",
        "..kk........kk..",
      ],
    },
    up: {
      from: 5,
      rows: [
        ".k............k.",
        ".kh..........hk.",
        ".kh..........hk.",
        ".kh..........hk.",
        ".khhhhhhhhhhhhk.",
        ".khhhhhhhhhhhhk.",
        ".khhhhhhhhhhhhk.",
        ".kghhhhhhhhhhgk.",
        "..kggggggggggk..",
      ],
    },
    right: {
      from: 6,
      rows: [
        "..kh............",
        "..kh............",
        "..kh............",
        "..khg...........",
        "..khg...........",
        "..kgg...........",
        "..kgg...........",
        "...kk...........",
      ],
    },
  },
  bun: {
    down: { from: 0, rows: ["......kkkk......", ".....khlhhk....."] },
    up: { from: 0, rows: ["......kkkk......", ".....khlhhk....."] },
    right: {
      from: 1,
      rows: ["..kkk...........", ".khlhk..........", ".khhgk..........", "..kkk..........."],
    },
  },
  curly: {
    down: {
      from: 0,
      rows: [
        "...k.kkkkkk.k...",
        "..khkhhhhhhkhk..",
        ".khhhhhhhhhhhhk.",
        ".khhllhhhhhhhhk.",
        ".khhhhhhhhhhhhk.",
        ".khhhhhhhhhhhgk.",
        ".khh........hgk.",
        ".kgh........ggk.",
        "..kg........gk..",
      ],
    },
    up: {
      from: 0,
      rows: [
        "...k.kkkkkk.k...",
        "..khkhhhhhhkhk..",
        ".khhhhhhhhhhhhk.",
        ".khhllhhhhhhhhk.",
        ".khhhhhhhhhhhhk.",
        ".khhhhhhhhhhhhk.",
        ".khhhhhhhhhhhhk.",
        ".kghhhhhhhhhhgk.",
        "..kgghhhhhhggk..",
      ],
    },
    right: {
      from: 0,
      rows: [
        "....k.kkkkk.k...",
        "...khkhhhhhkhk..",
        "..khhhhhhhhhhhk.",
        "..khhhlllhhhhhk.",
        "..khhhhhhhhhhhk.",
        "..khhhhhhhhhhhk.",
        "..khhhhhh.......",
        "..kghhhh........",
        "..kggh..........",
        "...kk...........",
      ],
    },
  },
  spiky: {
    down: { from: 0, rows: ["....k.k..k.k....", "...khkhkkhkhk..."] },
    up: { from: 0, rows: ["....k.k..k.k....", "...khkhkkhkhk..."] },
    right: { from: 0, rows: ["....k.k.k.......", "...khkhkhk......"] },
  },
};

/** A person's pixels: 24 rows of 16, for a hair style, a view and a frame. Left is right, mirrored by the painter. */
export function characterRows(style: HairStyle, view: View, frame: Frame): string[] {
  const v = view === "left" ? "right" : view;
  let body: string[];
  if (v === "right") {
    const legs = frame === "walkA" || frame === "walkB" ? LEGS_RIGHT.walkA : LEGS_RIGHT.stand;
    body = [...BODY_RIGHT, ...(frame === "walkB" ? LEGS_RIGHT.stand : legs)];
  } else if (frame === "typeA" || frame === "typeB" || frame === "rest") {
    body = [...BODY_UP.slice(0, 3), ...BODY_TYPE[frame], BLANK, BLANK, BLANK, BLANK, BLANK, BLANK];
  } else {
    const legs =
      frame === "walkA"
        ? LEGS.walkA
        : frame === "walkB"
          ? LEGS.walkB
          : frame === "sit"
            ? LEGS.sit
            : LEGS.stand;
    const top = v === "up" ? BODY_UP : BODY_DOWN;
    body = frame === "sit" ? [...top.slice(0, 8), ...legs, BLANK] : [...top, ...legs];
  }
  const head = HEAD[v];
  const rows = [...head, ...body];
  const hair = HAIR[style][v];
  if (hair)
    hair.rows.forEach((over, i) => {
      const at = hair.from + i;
      const under = rows[at]!;
      let out = "";
      for (let c = 0; c < CHAR_W; c++) out += over[c] === "." ? under[c] : over[c];
      rows[at] = out;
    });
  return rows;
}

export interface Look {
  style: HairStyle;
  skin: [string, string];
  hair: [string, string, string];
  shirt: [string, string];
  trousers: [string, string];
}

const SKINS: [string, string][] = [
  ["#f6d3b3", "#e2ae8a"],
  ["#eab893", "#d0936c"],
  ["#c98d61", "#aa7049"],
  ["#915d3d", "#754830"],
  ["#f2c6a2", "#d9a079"],
];
const HAIRS: [string, string, string][] = [
  ["#2d2330", "#1d1620", "#4c3d53"],
  ["#6b4029", "#4f2e1d", "#8f5a3a"],
  ["#9a6a3c", "#7a512c", "#bd8a55"],
  ["#e0b04e", "#bf8f35", "#f3d27a"],
  ["#c0552f", "#963f22", "#e07a4a"],
  ["#8d8b94", "#6d6b74", "#b4b2ba"],
  ["#34385e", "#262947", "#4c5285"],
  ["#d77a9c", "#b35a7c", "#ef9fbc"],
];
const TROUSERS: [string, string][] = [
  ["#3d4260", "#2d3149"],
  ["#4b3b33", "#382b25"],
  ["#5a6170", "#454b57"],
  ["#2f3b4d", "#222c3a"],
];

/** A colour darker by a fraction. */
export function shade(hex: string, by: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * (1 - by))));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => f(v).toString(16).padStart(2, "0")).join("")}`;
}

/** A carpet in a room's colour: its pastel, deepened and saturated; border, field and flecks. */
export function carpetOf(hex: string): [string, string, string] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const sat = Math.min(30, Math.round(s * 100 * 0.4 + (d === 0 ? 0 : 10)));
  const hue = Math.round((h * 60 + 360) % 360);
  return [`hsl(${hue} ${sat}% 55%)`, `hsl(${hue} ${sat}% 64%)`, `hsl(${hue} ${sat}% 70%)`];
}

/** How someone looks: picked from a stable number (their handle's hash), the shirt in their avatar colour. */
export function lookFor(seed: number, shirt: string): Look {
  const pick = <T>(xs: readonly T[], salt: number) =>
    xs[((seed >>> salt) ^ (seed >>> (salt + 7))) % xs.length]!;
  return {
    style: pick(HAIR_STYLES, 3),
    skin: pick(SKINS, 9),
    hair: pick(HAIRS, 13),
    shirt: [shirt, shade(shirt, 0.25)],
    trousers: pick(TROUSERS, 19),
  };
}

const OUTLINE = "#2a1f2d";

function paletteOf(look: Look): Record<string, string> {
  return {
    k: OUTLINE,
    e: OUTLINE,
    s: look.skin[0],
    t: look.skin[1],
    m: "#eba08e",
    h: look.hair[0],
    g: look.hair[1],
    l: look.hair[2],
    c: look.shirt[0],
    d: look.shirt[1],
    w: "#f4f1ea",
    p: look.trousers[0],
    q: look.trousers[1],
    b: "#3a2e3d",
  };
}

type Ctx = CanvasRenderingContext2D;

/** Paints a palette map at a point, mirrored when asked. */
export function paintMap(
  c: Ctx,
  rows: string[],
  pal: Record<string, string>,
  x: number,
  y: number,
  flip = false,
) {
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const ch = row[i]!;
      if (ch === ".") continue;
      const col = pal[ch];
      if (!col) continue;
      c.fillStyle = col;
      c.fillRect(x + (flip ? row.length - 1 - i : i), y + j, 1, 1);
    }
  });
}

const R = (c: Ctx, x: number, y: number, w: number, h: number, col: string) => {
  c.fillStyle = col;
  c.fillRect(x, y, w, h);
};

/** A small repeatable sequence of numbers in [0, 1). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PLANT = [
  ".....G...G....",
  "...G.GG.GG.G..",
  "..GGgGGgGGgG..",
  ".GgGGLgGGgGGG.",
  ".GGgLGGgLGgGG.",
  "GgGGGgGGGGgGGG",
  "GGLgGGgLGGGgLG",
  ".GgGGGGgGGgGG.",
  ".GGgLGGGGLgGG.",
  "..GgGGgGgGGG..",
  "...GGgGGGgG...",
  "....GGdGGG....",
  "......dd......",
  "......dd......",
  "..kkkkkkkkkk..",
  "..kppppppppk..",
  "...kPPPPPPk...",
  "...kPPPPPPk...",
  "...kPpPPPPk...",
  "....kPPPPk....",
  "....kkkkkk....",
  "..............",
];
const PLANT_PAL = {
  G: "#4e9a4a",
  g: "#346f35",
  L: "#77c267",
  d: "#5a4a2a",
  k: "#5b3325",
  p: "#d0845f",
  P: "#b8694a",
};

const WOODS = [
  { base: "#c69868", alt: "#bd8e5f", seam: "#a0754b", grain: "#b28453" },
  { base: "#d2a673", alt: "#c99c69", seam: "#ab7f52", grain: "#bf915f" },
  { base: "#a8764c", alt: "#9f6e45", seam: "#7f5534", grain: "#91623e" },
];
const BOOKS = [
  "#c0503a",
  "#4f6bd8",
  "#e0b04e",
  "#2a8c8c",
  "#7a4fa8",
  "#d77a9c",
  "#6b8e3a",
  "#e8e1d0",
  "#2d3a5c",
];
const SOFAS = [
  ["#7c64b0", "#654f95", "#9580c6"],
  ["#c56f8f", "#a55675", "#d98aa7"],
  ["#4f9aa0", "#3c7e84", "#6ab4ba"],
];
const OUT = "#3a2a30";

/** Paints the floor of an area, or part of it (a doorway) in that area's floor. */
export function paintFloor(
  c: Ctx,
  a: Pick<Area, "floor" | "seed">,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  if (a.floor === "stone") {
    // Large slabs, every other row offset by half.
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const gx = x + i;
        const gy = y + j;
        const row = Math.floor(gy / 12);
        const sx = gx + (row % 2) * 6;
        const edge = gy % 12 === 0 || sx % 12 === 0;
        const odd = (Math.floor(sx / 12) + row) % 3 === 0;
        c.fillStyle = edge
          ? "#bfb7a7"
          : odd
            ? "#d1cabd"
            : (gx * 7 + gy * 13) % 29 === 0
              ? "#c9c1b3"
              : "#dad4c8";
        c.fillRect(gx, gy, 1, 1);
      }
    return;
  }
  if (a.floor === "tile") {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const gx = x + i;
        const gy = y + j;
        const odd = (Math.floor(gx / 8) + Math.floor(gy / 8)) % 2 === 1;
        const edge = gx % 8 === 0 || gy % 8 === 0;
        c.fillStyle = edge ? "#d3ccbe" : odd ? "#e2dcd0" : "#efebe3";
        c.fillRect(gx, gy, 1, 1);
      }
    return;
  }
  const wood = WOODS[a.seed % WOODS.length]!;
  R(c, x, y, w, h, wood.base);
  const PH = 6;
  const PL = 26;
  for (let py = Math.floor(y / PH) * PH; py < y + h; py += PH) {
    const row = py / PH;
    const off = (row * 11) % PL;
    for (let px = Math.floor(x / PL) * PL - off; px < x + w; px += PL) {
      const k = Math.abs(Math.floor(px / PL) * 7 + row * 13);
      const x0 = Math.max(x, px);
      const x1 = Math.min(x + w, px + PL);
      const y0 = Math.max(y, py);
      const y1 = Math.min(y + h, py + PH);
      if (x1 <= x0 || y1 <= y0) continue;
      R(c, x0, y0, x1 - x0, y1 - y0, k % 3 === 0 ? wood.alt : wood.base);
      if (py + PH - 1 >= y && py + PH - 1 < y + h) R(c, x0, py + PH - 1, x1 - x0, 1, wood.seam);
      if (px >= x && px < x + w) R(c, px, y0, 1, y1 - y0, wood.seam);
      const gx = px + 5 + (k % 13);
      const gy = py + 2 + (k % 3);
      if (gx >= x && gx + 4 <= x + w && gy >= y && gy < y + h) R(c, gx, gy, 4, 1, wood.grain);
    }
  }
}

/** The wall you see above a room: wallpaper, a trim, a skirting board; tiles behind the kitchen counter. */
export function paintWallFace(c: Ctx, a: Area, x: number, w: number) {
  const y = a.y;
  R(c, x, y, w, FACE, a.wall);
  if (a.kind === "kitchen") {
    for (let j = 0; j < FACE - 4; j++)
      for (let i = 0; i < w; i++) {
        const gx = x + i;
        const gy = y + j;
        if (gx % 8 === 0 || gy % 6 === 0) {
          c.fillStyle = "#d9ddd9";
          c.fillRect(gx, gy, 1, 1);
        }
      }
  } else {
    const stripe = shade(a.wall, 0.045);
    for (let i = 0; i < w; i++) if ((x + i) % 6 === 0) R(c, x + i, y + 2, 1, FACE - 6, stripe);
  }
  R(c, x, y, w, 2, shade(a.wall, -0.06));
  R(c, x, y + 2, w, 1, shade(a.wall, 0.12));
  R(c, x, y + FACE - 4, w, 1, "#a58c6c");
  R(c, x, y + FACE - 3, w, 3, "#8a7055");
}

export const WALL_TOP = "#2f3552";

/** The room outlines: walls between everything, each room's floor and wall face, and the doorways through. */
export function paintRooms(c: Ctx, W: number, H: number, areas: Area[], doors: Door[]) {
  R(c, 0, 0, W, H, WALL_TOP);
  for (const a of areas) {
    paintFloor(c, a, a.x, a.y + FACE, a.w, a.h - FACE);
    paintWallFace(c, a, a.x, a.w);
    // The wall's shadow on the floor, and the cap's light edge.
    c.fillStyle = "rgba(40,28,20,0.16)";
    c.fillRect(a.x, a.y + FACE, a.w, 3);
    c.fillRect(a.x, a.y + FACE, 2, a.h - FACE);
    R(c, a.x - 1, a.y - 1, a.w + 2, 1, "#434b72");
  }
  const below = (d: Door) =>
    areas.find((a) =>
      d.side === "top"
        ? a.y === d.at && d.x >= a.x && d.x < a.x + a.w
        : a.x === d.at && d.y >= a.y && d.y < a.y + a.h,
    );
  for (const d of doors) {
    const a = below(d);
    if (!a) continue;
    if (d.side === "top") {
      paintFloor(c, a, d.x, d.at - WALL, d.w, WALL + FACE);
      c.fillStyle = "rgba(40,28,20,0.18)";
      c.fillRect(d.x, d.at - WALL, d.w, 3);
      R(c, d.x - 2, d.at - WALL, 2, WALL + FACE, "#6e4b30");
      R(c, d.x + d.w, d.at - WALL, 2, WALL + FACE, "#6e4b30");
      R(c, d.x - 2, d.at - WALL, 1, WALL + FACE, "#8a6440");
    } else {
      paintFloor(c, a, d.at - WALL, d.y, WALL, d.h);
      R(c, d.at - WALL, d.y - 2, WALL, 2, "#6e4b30");
      R(c, d.at - WALL, d.y + d.h, WALL, 1, "#6e4b30");
    }
  }
}

/** A rug on the floor: a border, a field, a pattern. */
export function paintRug(c: Ctx, p: Prop, area: Area) {
  const tones =
    area.kind === "lounge"
      ? ["#3f5f99", "#5b7fb8", "#6f93c9"]
      : area.kind === "reception"
        ? ["#2e6b6f", "#3f8a8e", "#58a2a5"]
        : area.kind === "office"
          ? ["#8e3f37", "#b5544a", "#c96b5f"]
          : carpetOf(area.wall);
  R(c, p.x, p.y, p.w, p.h, tones[0]!);
  R(c, p.x + 2, p.y + 2, p.w - 4, p.h - 4, tones[1]!);
  for (let j = 4; j < p.h - 4; j += 4)
    for (let i = 4 + ((j / 4) % 2) * 2; i < p.w - 4; i += 4) R(c, p.x + i, p.y + j, 1, 1, tones[2]!);
  R(c, p.x + 3, p.y + 3, p.w - 6, 1, tones[2]!);
  R(c, p.x + 3, p.y + p.h - 4, p.w - 6, 1, tones[0]!);
}

type Painter = (c: Ctx, p: Prop, r: () => number) => void;

/** Each kind of furniture, painted at 0,0 in a canvas its own size. */
const PAINT: Partial<Record<PropKind, Painter>> = {
  desk(c, p, r) {
    const D = 8;
    R(c, 1, D + 17, 2, 5, "#5a3d27");
    R(c, 29, D + 17, 2, 5, "#5a3d27");
    R(c, 0, D, 32, 18, OUT);
    R(c, 1, D + 1, 30, 10, "#c99a68");
    R(c, 1, D + 1, 30, 1, "#dcb383");
    R(c, 1, D + 11, 30, 1, "#a67a4c");
    R(c, 1, D + 12, 30, 5, "#8f6340");
    R(c, 21, D + 13, 8, 3, "#a0724a");
    R(c, 24, D + 14, 2, 1, "#e2c28e");
    // Keyboard and mouse.
    R(c, 9, D + 7, 13, 3, "#e9ecf1");
    R(c, 9, D + 9, 13, 1, "#c3c9d4");
    for (let i = 10; i < 21; i += 2) R(c, i, D + 8, 1, 1, "#c3c9d4");
    R(c, 24, D + 8, 2, 3, "#e9ecf1");
    const v = Math.floor(r() * 4);
    if (v === 0) {
      R(c, 3, D + 3, 3, 4, "#f2efe8");
      R(c, 3, D + 3, 3, 1, "#6b4a36");
      R(c, 6, D + 4, 1, 2, "#f2efe8");
    } else if (v === 1) {
      R(c, 2, D + 2, 6, 7, "#f7f5ef");
      R(c, 3, D + 3, 4, 1, "#c9c4b8");
      R(c, 3, D + 5, 3, 1, "#c9c4b8");
      R(c, 3, D + 7, 4, 1, "#c9c4b8");
    } else if (v === 2) {
      R(c, 3, D + 5, 4, 4, "#b8694a");
      R(c, 4, D + 1, 2, 4, "#4e9a4a");
      R(c, 3, D + 2, 1, 2, "#4e9a4a");
    } else {
      R(c, 2, D + 4, 5, 3, "#4f6bd8");
      R(c, 2, D + 6, 5, 1, "#f4f1ea");
    }
    // The monitor: a bezel on a stand; the screen is drawn live.
    R(c, 7, 0, 18, 12, OUT);
    R(c, 8, 1, 16, 10, "#2f323c");
    R(c, 15, 12, 2, 2, "#4a4d57");
    R(c, 12, 13, 8, 2, "#4a4d57");
    R(c, 12, 13, 8, 1, "#5f6370");
  },
  chair(c, _p, r) {
    const tones = r() < 0.7 ? ["#4b5169", "#626a86", "#3e4357"] : ["#8e4b4b", "#a86262", "#733c3c"];
    R(c, 2, 0, 12, 8, OUT);
    R(c, 3, 1, 10, 6, tones[0]!);
    R(c, 3, 1, 10, 1, tones[1]!);
    R(c, 4, 4, 8, 1, tones[2]!);
    R(c, 1, 7, 14, 3, OUT);
    R(c, 2, 7, 12, 2, tones[2]!);
    R(c, 7, 10, 2, 2, "#5b5f6b");
    R(c, 2, 12, 12, 1, "#2e3038");
    R(c, 2, 13, 2, 2, "#23252c");
    R(c, 7, 13, 2, 2, "#23252c");
    R(c, 12, 13, 2, 2, "#23252c");
  },
  bossChair(c, p) {
    // Yours in plum leather, Peter's at reception in teal.
    const [base, light, dark] =
      p.seed % 2 ? ["#3f6468", "#557f83", "#31504f"] : ["#5a4460", "#735a7b", "#443349"];
    R(c, 1, 0, 16, 16, OUT);
    R(c, 2, 1, 14, 14, base!);
    R(c, 2, 1, 14, 2, light!);
    for (const [x, y] of [
      [5, 5],
      [9, 5],
      [13, 5],
      [7, 9],
      [11, 9],
    ])
      R(c, x!, y!, 1, 1, dark!);
    R(c, 0, 10, 3, 7, OUT);
    R(c, 15, 10, 3, 7, OUT);
    R(c, 3, 15, 12, 3, dark!);
    R(c, 8, 18, 2, 2, "#5b5f6b");
    R(c, 3, 20, 12, 2, "#2e3038");
  },
  bossDesk(c) {
    R(c, 2, 18, 3, 6, "#4a2f1d");
    R(c, 51, 18, 3, 6, "#4a2f1d");
    R(c, 0, 0, 56, 20, OUT);
    R(c, 1, 1, 54, 11, "#8c5a3a");
    R(c, 1, 1, 54, 1, "#a36d49");
    R(c, 1, 12, 54, 1, "#6e4429");
    R(c, 1, 13, 54, 6, "#6a4128");
    R(c, 4, 14, 14, 4, "#77492e");
    R(c, 38, 14, 14, 4, "#77492e");
    R(c, 10, 15, 3, 1, "#d8b77f");
    R(c, 44, 15, 3, 1, "#d8b77f");
    // A laptop, from behind; a lamp; a mug; the tray for what waits on you (its papers are live).
    R(c, 20, 2, 16, 9, OUT);
    R(c, 21, 3, 14, 7, "#c8ccd4");
    R(c, 21, 3, 14, 1, "#dde1e7");
    R(c, 27, 5, 2, 2, "#eef1f5");
    R(c, 5, 4, 7, 2, "#e0b04e");
    R(c, 7, 6, 2, 4, "#4a4d57");
    R(c, 5, 10, 6, 1, "#4a4d57");
    R(c, 14, 6, 3, 3, "#f2efe8");
    R(c, 14, 6, 3, 1, "#6b4a36");
    R(c, 40, 7, 12, 5, OUT);
    R(c, 41, 8, 10, 3, "#b88a4a");
  },
  bookshelf(c, p, r) {
    R(c, 0, 0, p.w, p.h, OUT);
    R(c, 1, 1, p.w - 2, p.h - 2, "#8a5d3b");
    R(c, 3, 3, p.w - 6, p.h - 5, "#5e3d26");
    for (const sy of [13, 25, 37]) {
      R(c, 1, sy, p.w - 2, 2, "#9c6b45");
      R(c, 1, sy, p.w - 2, 1, "#b0804f");
      let x = 3;
      while (x < p.w - 4) {
        const bw = 2 + Math.floor(r() * 2);
        if (x + bw > p.w - 3) break;
        if (r() < 0.12) {
          x += bw + 1;
          continue;
        }
        const bh = 6 + Math.floor(r() * 4);
        const col = BOOKS[Math.floor(r() * BOOKS.length)]!;
        R(c, x, sy - bh, bw, bh, col);
        R(c, x, sy - bh, bw, 1, shade(col, -0.2));
        if (bh > 7) R(c, x, sy - bh + 3, bw, 1, shade(col, 0.3));
        x += bw;
      }
    }
  },
  plant(c) {
    paintMap(c, PLANT, PLANT_PAL, 0, 0);
  },
  window(c, p) {
    const { w, h } = p;
    R(c, 0, 0, w, h - 2, "#8f95a3");
    R(c, 1, 1, w - 2, h - 4, "#f3f1ec");
    R(c, 3, 3, w - 6, h - 8, "#8ccbee");
    R(c, 3, 3 + Math.floor((h - 8) / 2), w - 6, Math.ceil((h - 8) / 2), "#b3def5");
    R(c, 6, 5, 5, 1, "#ffffff");
    R(c, 5, 6, 8, 1, "#ffffff");
    R(c, w - 12, 9, 6, 1, "#eef8fd");
    R(c, Math.floor(w / 2) - 1, 3, 2, h - 8, "#f3f1ec");
    R(c, 3, Math.floor((h - 4) / 2), w - 6, 1, "#f3f1ec");
    R(c, 0, h - 3, w, 3, "#e3ded3");
    R(c, 0, h - 1, w, 1, "#b9b2a4");
  },
  whiteboard(c, p, r) {
    const { w } = p;
    R(c, 0, 0, w, 18, OUT);
    R(c, 1, 1, w - 2, 16, "#c9ced8");
    R(c, 2, 2, w - 4, 14, "#fbfcfd");
    R(c, 4, 4, 11, 1, "#4f6bd8");
    R(c, 4, 6, 8, 1, "#4f6bd8");
    R(c, 4, 9, 6, 1, "#c0503a");
    for (let i = 0; i < 4; i++) {
      const bh = 2 + Math.floor(r() * 5);
      R(c, 5 + i * 3, 15 - bh, 2, bh, "#1f7a5c");
    }
    R(c, 18, 5, 1, 7, "#8d95a1");
    R(c, 18, 11, 7, 1, "#8d95a1");
    R(c, w - 12, 3, 5, 5, "#f6d860");
    R(c, w - 18, 9, 5, 5, "#f3a6c0");
    R(c, w - 10, 10, 5, 5, "#9fd0f0");
    R(c, 6, 18, w - 12, 2, "#9aa1ad");
  },
  painting(c) {
    R(c, 0, 0, 36, 20, "#7a5518");
    R(c, 1, 1, 34, 18, "#d4a53f");
    R(c, 1, 1, 34, 1, "#e8c268");
    R(c, 3, 3, 30, 14, "#9fd4f2");
    R(c, 3, 3, 30, 4, "#8cc6ea");
    R(c, 25, 5, 3, 3, "#fff1a8");
    for (let i = 0; i < 30; i++) {
      const hb = 5 + Math.round(3 * Math.sin((i + 3) / 5));
      R(c, 3 + i, 17 - hb, 1, hb, "#7fb069");
      const hf = 3 + Math.round(2 * Math.sin((i + 14) / 4));
      R(c, 3 + i, 17 - hf, 1, hf, "#4f8a4f");
    }
    R(c, 12, 14, 9, 2, "#5b9bd5");
  },
  clock(c) {
    for (let j = 0; j < 12; j++)
      for (let i = 0; i < 12; i++) {
        const d = Math.hypot(i - 5.5, j - 5.5);
        if (d <= 5.6) R(c, i, j, 1, 1, d > 4.6 ? OUT : "#fbfaf6");
      }
    for (const [x, y] of [
      [5, 1],
      [10, 5],
      [5, 10],
      [1, 5],
    ])
      R(c, x!, y!, 2, 2 - (x === 5 ? 1 : 0), "#8d95a1");
  },
  frame(c, p) {
    R(c, 0, 0, p.w, p.h, "#6e4b30");
    R(c, 1, 1, p.w - 2, p.h - 2, "#f4f1ea");
    R(c, 2, 2, p.w - 4, p.h - 4, p.w > 11 ? "#9fc7a8" : "#e8c9a0");
    R(c, 3, p.h - 4, p.w - 6, 1, p.w > 11 ? "#4f8a4f" : "#c0503a");
  },
  cabinets(c, p) {
    R(c, 0, 0, p.w, 12, OUT);
    R(c, 1, 1, p.w - 2, 10, "#d7b98f");
    for (let x = 1; x < p.w - 2; x += 18) {
      R(c, x + 1, 2, 16, 8, "#e2c69e");
      R(c, x + 1, 2, 16, 1, "#ecd6b4");
      R(c, x + (x % 36 === 1 ? 14 : 2), 5, 1, 3, "#8a6a45");
    }
  },
  counter(c, p) {
    const { w } = p;
    R(c, 0, 0, w, 24, OUT);
    R(c, 1, 1, w - 2, 8, "#e6e1d7");
    R(c, 1, 1, w - 2, 1, "#f5f2ec");
    R(c, 1, 9, w - 2, 1, "#c9c2b4");
    R(c, 1, 10, w - 2, 13, "#bf9a70");
    for (let x = 2; x < w - 4; x += 17) {
      R(c, x, 11, 16, 11, "#caa77c");
      R(c, x, 11, 16, 1, "#d8b88f");
      R(c, x + 7, 15, 2, 1, "#7a5a3a");
    }
    R(c, 28, 2, 16, 6, "#a3abb6");
    R(c, 29, 3, 14, 4, "#8b95a3");
    R(c, 35, 0, 2, 3, "#8d95a1");
  },
  microwave(c) {
    R(c, 0, 0, 18, 11, OUT);
    R(c, 1, 1, 16, 9, "#dfe2e7");
    R(c, 2, 2, 10, 7, "#2b303a");
    R(c, 3, 3, 3, 1, "#46505f");
    R(c, 13, 2, 3, 7, "#c7ccd4");
    R(c, 14, 3, 1, 1, "#3fbf6f");
    R(c, 14, 5, 1, 1, "#8d95a1");
    R(c, 14, 7, 1, 1, "#8d95a1");
  },
  coffee(c) {
    R(c, 0, 0, 12, 16, OUT);
    R(c, 1, 1, 10, 14, "#3b3f4a");
    R(c, 1, 1, 10, 3, "#4a4f5c");
    R(c, 4, 4, 4, 2, "#23262e");
    R(c, 3, 8, 6, 6, "#9fb6c9");
    R(c, 3, 11, 6, 3, "#5a3825");
    R(c, 3, 8, 6, 1, "#c9d6e2");
    R(c, 9, 5, 1, 1, "#e54b4b");
  },
  fridge(c) {
    R(c, 0, 0, 20, 38, OUT);
    R(c, 1, 1, 18, 36, "#eef1f4");
    R(c, 15, 1, 3, 36, "#d7dce2");
    R(c, 1, 13, 18, 1, "#aab2bd");
    R(c, 3, 4, 1, 7, "#9aa3af");
    R(c, 3, 16, 1, 10, "#9aa3af");
    R(c, 10, 4, 2, 2, "#e05d5d");
    R(c, 13, 7, 2, 2, "#f6d860");
    R(c, 8, 18, 4, 4, "#fbf6d0");
    R(c, 8, 18, 4, 1, "#9fd0f0");
  },
  cooler(c) {
    R(c, 2, 0, 8, 11, OUT);
    R(c, 3, 1, 6, 9, "#a9dcf7");
    R(c, 4, 2, 1, 7, "#d8f1fc");
    R(c, 3, 1, 6, 2, "#8cc9ee");
    R(c, 0, 10, 12, 18, OUT);
    R(c, 1, 11, 10, 16, "#f0f2f5");
    R(c, 9, 11, 1, 16, "#d8dce2");
    R(c, 3, 15, 2, 2, "#4f8ad8");
    R(c, 7, 15, 2, 2, "#e05d5d");
    R(c, 2, 20, 8, 2, "#b9c0ca");
  },
  vending(c, _p, r) {
    R(c, 0, 0, 26, 42, OUT);
    R(c, 1, 1, 24, 40, "#c8473b");
    R(c, 1, 1, 24, 2, "#dd6a5e");
    R(c, 3, 4, 15, 26, "#1f2a3a");
    const snacks = ["#f6d860", "#e05d5d", "#7fd1a8", "#9ec5ff", "#f3a6c0", "#f09a4a"];
    for (let row = 0; row < 4; row++) {
      R(c, 3, 10 + row * 6, 15, 1, "#46505f");
      for (let i = 0; i < 4; i++)
        R(c, 4 + i * 4, 6 + row * 6, 3, 4, snacks[Math.floor(r() * snacks.length)]!);
    }
    R(c, 19, 4, 5, 12, "#2b2f38");
    for (let j = 0; j < 3; j++) for (let i = 0; i < 2; i++) R(c, 20 + i * 2, 6 + j * 3, 1, 1, "#c7ccd4");
    R(c, 20, 18, 3, 1, "#111");
    R(c, 3, 32, 15, 6, "#2b2f38");
    R(c, 4, 33, 13, 1, "#46505f");
  },
  sofa(c, p) {
    const [base, dark, light] = SOFAS[p.seed % SOFAS.length]!;
    R(c, 4, 0, 56, 13, OUT);
    R(c, 5, 1, 54, 11, base!);
    R(c, 5, 1, 54, 2, light!);
    R(c, 22, 3, 1, 9, dark!);
    R(c, 41, 3, 1, 9, dark!);
    R(c, 0, 6, 8, 20, OUT);
    R(c, 56, 6, 8, 20, OUT);
    R(c, 1, 7, 6, 18, base!);
    R(c, 57, 7, 6, 18, base!);
    R(c, 1, 7, 6, 2, light!);
    R(c, 57, 7, 6, 2, light!);
    R(c, 7, 12, 50, 13, OUT);
    R(c, 7, 12, 50, 8, base!);
    R(c, 7, 12, 50, 1, light!);
    R(c, 23, 12, 1, 8, dark!);
    R(c, 40, 12, 1, 8, dark!);
    R(c, 7, 20, 50, 5, dark!);
    R(c, 3, 26, 3, 2, "#4a2f1d");
    R(c, 58, 26, 3, 2, "#4a2f1d");
  },
  armchair(c, p) {
    const [base, dark, light] = SOFAS[(p.seed + 1) % SOFAS.length]!;
    R(c, 3, 0, 16, 12, OUT);
    R(c, 4, 1, 14, 10, base!);
    R(c, 4, 1, 14, 2, light!);
    R(c, 0, 6, 5, 16, OUT);
    R(c, 17, 6, 5, 16, OUT);
    R(c, 1, 7, 3, 14, base!);
    R(c, 18, 7, 3, 14, base!);
    R(c, 5, 11, 12, 11, OUT);
    R(c, 5, 11, 12, 6, base!);
    R(c, 5, 11, 12, 1, light!);
    R(c, 5, 17, 12, 4, dark!);
    R(c, 2, 22, 2, 2, "#4a2f1d");
    R(c, 18, 22, 2, 2, "#4a2f1d");
  },
  coffeeTable(c) {
    R(c, 2, 9, 2, 5, "#5a3d27");
    R(c, 32, 9, 2, 5, "#5a3d27");
    R(c, 0, 0, 36, 10, OUT);
    R(c, 1, 1, 34, 7, "#a8744a");
    R(c, 1, 1, 34, 1, "#bd8a5c");
    R(c, 1, 8, 34, 1, "#83573a");
    R(c, 6, 2, 3, 3, "#f2efe8");
    R(c, 6, 2, 3, 1, "#6b4a36");
    R(c, 13, 2, 10, 5, "#4f6bd8");
    R(c, 13, 6, 10, 1, "#f4f1ea");
    R(c, 26, 2, 6, 4, "#2f323c");
    R(c, 27, 3, 4, 2, "#9ec5ff");
  },
  roundTable(c) {
    const rows = [
      "....kkkkkkkkkkkkkkkk....",
      "..kkwwwwwwwwwwwwwwwwkk..",
      ".kwwwwwwwwwwwwwwwwwwwwk.",
      "kwwwwwwwwwwwwwwwwwwwwwwk",
      "kwwwwwwwwwwwwwwwwwwwwwwk",
      ".kvvvvvvvvvvvvvvvvvvvvk.",
      "..kkvvvvvvvvvvvvvvvvkk..",
      "....kkkkkkkkkkkkkkkk....",
    ];
    paintMap(c, rows, { k: OUT, w: "#efe7da", v: "#d6cab7" }, 0, 0);
    R(c, 11, 8, 2, 6, "#5b5f6b");
    R(c, 7, 14, 10, 2, "#3e424c");
    R(c, 6, 2, 3, 3, "#f2efe8");
    R(c, 6, 2, 3, 1, "#6b4a36");
    R(c, 15, 3, 3, 2, "#e05d5d");
  },
  stool(c) {
    R(c, 0, 0, 8, 3, OUT);
    R(c, 1, 0, 6, 2, "#c0503a");
    R(c, 1, 3, 1, 5, "#5a5f6b");
    R(c, 6, 3, 1, 5, "#5a5f6b");
    R(c, 1, 6, 6, 1, "#5a5f6b");
  },
  filing(c) {
    R(c, 0, 0, 14, 26, OUT);
    R(c, 1, 1, 12, 24, "#9aa2ae");
    for (const y of [2, 10, 18]) {
      R(c, 2, y, 10, 7, "#aab2bd");
      R(c, 2, y, 10, 1, "#bcc3cc");
      R(c, 5, y + 3, 4, 1, "#6b7280");
    }
  },
  printer(c) {
    R(c, 4, 0, 12, 5, "#ffffff");
    R(c, 5, 1, 8, 1, "#c9c4b8");
    R(c, 0, 3, 20, 13, OUT);
    R(c, 1, 4, 18, 11, "#dfe3e8");
    R(c, 1, 4, 18, 3, "#c8ced6");
    R(c, 3, 11, 14, 1, "#8d95a1");
    R(c, 16, 8, 1, 1, "#3fbf6f");
  },
  lamp(c) {
    R(c, 0, 0, 10, 8, OUT);
    R(c, 1, 1, 8, 6, "#f5e6b8");
    R(c, 1, 5, 8, 2, "#e8d49a");
    R(c, 4, 8, 2, 19, "#4a4d57");
    R(c, 2, 27, 6, 3, "#3a3d46");
  },
  meetingTable(c) {
    R(c, 3, 13, 2, 7, "#5a3d27");
    R(c, 43, 13, 2, 7, "#5a3d27");
    R(c, 0, 0, 48, 14, OUT);
    R(c, 1, 1, 46, 10, "#b58558");
    R(c, 1, 1, 46, 1, "#c99a6b");
    R(c, 1, 11, 46, 2, "#8f6340");
    R(c, 6, 3, 9, 6, "#2f323c");
    R(c, 7, 4, 7, 4, "#9ec5ff");
    R(c, 20, 3, 7, 6, "#f7f5ef");
    R(c, 21, 4, 5, 1, "#c9c4b8");
    R(c, 21, 6, 4, 1, "#c9c4b8");
    R(c, 33, 4, 3, 3, "#f2efe8");
    R(c, 33, 4, 3, 1, "#6b4a36");
  },
  frontDesk(c, p) {
    const { w } = p;
    // The counter from the visitors' side: a work top, a tall front with a band, a kick at the floor.
    R(c, 0, 0, w, 26, OUT);
    R(c, 1, 1, w - 2, 8, "#dcc099");
    R(c, 1, 1, w - 2, 1, "#ead3b0");
    R(c, 1, 9, w - 2, 1, "#b8986e");
    R(c, 1, 10, w - 2, 13, "#8f6340");
    R(c, 1, 10, w - 2, 1, "#a47650");
    R(c, 1, 14, w - 2, 3, "#2f7a7e");
    R(c, 1, 14, w - 2, 1, "#4a9ca0");
    R(c, Math.floor(w / 2) - 5, 18, 10, 3, "#a47650");
    R(c, Math.floor(w / 2) - 4, 19, 8, 1, "#e0b04e");
    R(c, 1, 23, w - 2, 2, "#5a3d27");
    // On the top: a laptop from behind, a stack of papers, a bell.
    R(c, 17, 1, 14, 7, OUT);
    R(c, 18, 2, 12, 5, "#c8ccd4");
    R(c, 18, 2, 12, 1, "#dde1e7");
    R(c, 23, 4, 2, 1, "#eef1f5");
    R(c, 4, 3, 8, 4, "#f7f5ef");
    R(c, 5, 4, 6, 1, "#c9c4b8");
    R(c, 4, 6, 8, 1, "#e6e1d7");
    R(c, 37, 4, 5, 3, "#d9a93c");
    R(c, 38, 3, 3, 1, "#f0cf6e");
    R(c, 39, 2, 1, 1, "#8a6420");
    R(c, 36, 7, 7, 1, "#8a6420");
  },
  bench(c) {
    R(c, 2, 0, 32, 10, OUT);
    R(c, 3, 1, 30, 8, "#4d5a70");
    R(c, 3, 1, 30, 2, "#63718a");
    R(c, 18, 2, 1, 7, "#3e495c");
    R(c, 0, 8, 36, 10, OUT);
    R(c, 1, 9, 34, 5, "#4d5a70");
    R(c, 1, 9, 34, 1, "#63718a");
    R(c, 18, 9, 1, 5, "#3e495c");
    R(c, 1, 14, 34, 3, "#3e495c");
    R(c, 3, 18, 2, 2, "#5a3d27");
    R(c, 31, 18, 2, 2, "#5a3d27");
  },
  taskBoard(c, p) {
    const { w } = p;
    R(c, 0, 0, w, 19, OUT);
    R(c, 1, 1, w - 2, 17, "#c9ced8");
    R(c, 2, 2, w - 4, 15, "#fbfcfd");
    BOARD_COLUMNS.forEach((col, i) => {
      const x = 3 + i * 10;
      R(c, x, 3, 8, 1, col.head);
      if (i > 0) R(c, x - 1, 3, 1, 13, "#e6e8ee");
    });
    R(c, 8, 19, w - 16, 2, "#9aa1ad");
  },
  shelf(c, _p, r) {
    R(c, 0, 8, 26, 2, "#8a5d3b");
    R(c, 0, 8, 26, 1, "#a8744a");
    let x = 1;
    for (let i = 0; i < 4; i++) {
      const bh = 4 + Math.floor(r() * 3);
      R(c, x, 8 - bh, 2, bh, BOOKS[Math.floor(r() * BOOKS.length)]!);
      x += 2;
    }
    R(c, 12, 5, 4, 3, "#b8694a");
    R(c, 12, 2, 1, 3, "#4e9a4a");
    R(c, 14, 1, 1, 4, "#4e9a4a");
    R(c, 15, 3, 1, 2, "#77c267");
    R(c, 20, 3, 3, 5, "#e0b04e");
    R(c, 19, 7, 5, 1, "#bf8f35");
  },
};

/** What gives light at night, as rectangles of the piece: kept at full brightness. */
const GLOWS: Partial<Record<PropKind, [number, number, number, number][]>> = {
  vending: [[3, 4, 15, 26]],
  lamp: [[1, 1, 8, 6]],
  window: [],
  coffee: [[9, 5, 1, 1]],
  printer: [[16, 8, 1, 1]],
};

function canvas(w: number, h: number): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.width = Math.max(1, w);
  el.height = Math.max(1, h);
  return el;
}

/** Dims a piece for the night, leaving its lights as they were. */
export function nightOf(day: HTMLCanvasElement, kind?: PropKind, amount = 0.46): HTMLCanvasElement {
  const out = canvas(day.width, day.height);
  const c = out.getContext("2d")!;
  c.drawImage(day, 0, 0);
  c.globalCompositeOperation = "source-atop";
  c.fillStyle = `rgba(14,16,40,${amount})`;
  c.fillRect(0, 0, out.width, out.height);
  c.globalCompositeOperation = "source-over";
  for (const [x, y, w, h] of (kind && GLOWS[kind]) ?? []) c.drawImage(day, x, y, w, h, x, y, w, h);
  return out;
}

/** Every piece painted once per look and per time of day, then reused. */
export class ArtCache {
  private props = new Map<string, HTMLCanvasElement>();
  private people = new Map<string, HTMLCanvasElement>();

  constructor(readonly night: boolean) {}

  prop(p: Prop): HTMLCanvasElement | null {
    const paint = PAINT[p.kind];
    if (!paint) return null;
    const key = `${p.kind}:${p.w}x${p.h}:${p.seed}`;
    let el = this.props.get(key);
    if (!el) {
      el = canvas(p.w, p.h);
      paint(el.getContext("2d")!, p, rng(p.seed));
      if (this.night) el = nightOf(el, p.kind);
      this.props.set(key, el);
    }
    return el;
  }

  person(look: Look, view: View, frame: Frame): HTMLCanvasElement {
    const key = `${look.style}|${look.skin[0]}|${look.hair[0]}|${look.shirt[0]}|${look.trousers[0]}|${view}|${frame}`;
    let el = this.people.get(key);
    if (!el) {
      el = canvas(CHAR_W, CHAR_H);
      paintMap(
        el.getContext("2d")!,
        characterRows(look.style, view, frame),
        paletteOf(look),
        0,
        0,
        view === "left",
      );
      if (this.night) el = nightOf(el, undefined, 0.3);
      this.people.set(key, el);
    }
    return el;
  }
}

/** What a monitor shows: code while building, a page while reading, a warning when blocked, dark when away. */
export type Screen = "code" | "doc" | "alert" | "ask" | "idle" | "off";

const CODE = ["#7fd1a8", "#9ec5ff", "#f6d860", "#e6a1f0", "#c9d1e0", "#f09a4a"];

/** Paints a 14 by 8 screen at a point, for a moment in time (ms) and a seed per desk. */
export function paintScreen(c: Ctx, x: number, y: number, what: Screen, t: number, seed: number) {
  if (what === "off") {
    R(c, x, y, 14, 8, "#252932");
    R(c, x + 9, y + 1, 1, 1, "#343946");
    R(c, x + 10, y + 2, 1, 1, "#343946");
    return;
  }
  if (what === "code") {
    R(c, x, y, 14, 8, "#1b2130");
    const tick = Math.floor(t / 320);
    for (let i = 0; i < 4; i++) {
      const r = rng(seed + (tick + i) * 977);
      const indent = Math.floor(r() * 3) * 2;
      const len = 3 + Math.floor(r() * (9 - indent));
      R(c, x + 1 + indent, y + 1 + i * 2, len, 1, CODE[Math.floor(r() * CODE.length)]!);
      if (r() < 0.5 && len < 8)
        R(c, x + 2 + indent + len, y + 1 + i * 2, 2, 1, CODE[Math.floor(r() * CODE.length)]!);
    }
    if (Math.floor(t / 400) % 2) R(c, x + 12, y + 7, 1, 1, "#e9ecf1");
    return;
  }
  if (what === "doc") {
    R(c, x, y, 14, 8, "#eef2f7");
    const tick = Math.floor(t / 900);
    R(c, x + 1, y + 1, 7, 1, "#4f6bd8");
    for (let i = 0; i < 3; i++) {
      const r = rng(seed + (tick + i) * 131);
      R(c, x + 1, y + 3 + i * 2, 6 + Math.floor(r() * 6), 1, "#9aa3b2");
    }
    return;
  }
  if (what === "alert") {
    R(c, x, y, 14, 8, "#40202a");
    if (Math.floor(t / 500) % 2 === 0) {
      R(c, x + 6, y + 1, 2, 4, "#ff6b5e");
      R(c, x + 6, y + 6, 2, 1, "#ff6b5e");
    }
    return;
  }
  if (what === "ask") {
    R(c, x, y, 14, 8, "#3a3020");
    R(c, x + 5, y + 1, 4, 1, "#f2b441");
    R(c, x + 8, y + 2, 1, 2, "#f2b441");
    R(c, x + 6, y + 4, 2, 1, "#f2b441");
    R(c, x + 6, y + 6, 2, 1, "#f2b441");
    return;
  }
  // Idle at the desk: a slow screensaver.
  R(c, x, y, 14, 8, "#20242e");
  const k = Math.floor(t / 180 + seed) % 40;
  const px = k < 20 ? k : 40 - k;
  const py = Math.floor(t / 260 + seed) % 12;
  R(c, x + 1 + Math.floor((px * 11) / 20), y + 1 + (py < 6 ? py : 12 - py), 2, 1, "#4f6bd8");
}

/** The board's five columns, as the wall board in reception shows them: a heading colour and a sticky colour. */
export const BOARD_COLUMNS = [
  { status: "todo", head: "#9aa3b2", sticky: "#f6d860" },
  { status: "doing", head: "#1f7a5c", sticky: "#a8e0c4" },
  { status: "blocked", head: "#b3261e", sticky: "#f3aaa3" },
  { status: "review", head: "#4f6bd8", sticky: "#a9c3f2" },
  { status: "done", head: "#c9c4b8", sticky: "#e6e1d6" },
] as const;

/** The stickies on the reception board: one per task in each column, up to eight. */
export function paintTaskBoard(c: Ctx, x: number, y: number, counts: Record<string, number>) {
  BOARD_COLUMNS.forEach((col, i) => {
    const n = Math.min(8, counts[col.status] ?? 0);
    for (let k = 0; k < n; k++)
      R(c, x + 3 + i * 10 + (k % 2) * 4, y + 5 + Math.floor(k / 2) * 3, 3, 2, col.sticky);
  });
}

/** The papers in your tray: one sheet per write waiting on you, up to eight. */
export function paintTray(c: Ctx, x: number, y: number, pending: number) {
  const n = Math.min(8, pending);
  for (let i = 0; i < n; i++) {
    R(c, x, y - i, 10, 1, i % 2 ? "#f4f1ea" : "#ffffff");
    R(c, x + 9, y - i, 1, 1, "#c9c4b8");
  }
  if (n) R(c, x + 7, y - n - 1, 3, 2, "#c98a1c");
}

/** Steam from the coffee machine and the clock's hands. */
export function paintCoffeeSteam(c: Ctx, x: number, y: number, t: number) {
  for (let i = 0; i < 3; i++) {
    const k = (t / 90 + i * 7) % 20;
    const py = y - Math.floor(k / 2);
    const px = x + Math.round(Math.sin((t / 300 + i) * 1.3));
    c.fillStyle = `rgba(255,255,255,${0.55 - k / 40})`;
    c.fillRect(px, py, 1, 1);
  }
}

export function paintClockHands(c: Ctx, x: number, y: number, date: Date) {
  const cx = x + 5.5;
  const cy = y + 5.5;
  const hand = (turn: number, len: number, col: string) => {
    for (let i = 1; i <= len; i++) {
      c.fillStyle = col;
      c.fillRect(
        Math.round(cx + Math.sin(turn * 2 * Math.PI) * i - 0.5),
        Math.round(cy - Math.cos(turn * 2 * Math.PI) * i - 0.5),
        1,
        1,
      );
    }
  };
  const m = date.getMinutes() / 60;
  hand(((date.getHours() % 12) + m) / 12, 2.5, OUTLINE);
  hand(m, 3.8, "#c0503a");
}

/** A little speech balloon over a head: a mark for blocked, waiting on you, or answering. */
export function paintMark(c: Ctx, x: number, y: number, mark: "!" | "?" | "..." | "z", t: number) {
  const w = mark === "..." ? 13 : 9;
  const bx = Math.round(x - w / 2);
  const by = Math.round(y - 11 - (Math.floor(t / 400) % 2));
  R(c, bx, by, w, 9, OUTLINE);
  R(c, bx + 1, by + 1, w - 2, 7, "#ffffff");
  R(c, bx + Math.floor(w / 2) - 1, by + 9, 3, 1, OUTLINE);
  R(c, bx + Math.floor(w / 2), by + 10, 1, 1, OUTLINE);
  R(c, bx + Math.floor(w / 2), by + 8, 1, 1, "#ffffff");
  if (mark === "!") {
    R(c, bx + 4, by + 2, 1, 3, "#b3261e");
    R(c, bx + 4, by + 6, 1, 1, "#b3261e");
  } else if (mark === "?") {
    R(c, bx + 3, by + 2, 3, 1, "#c98a1c");
    R(c, bx + 5, by + 3, 1, 1, "#c98a1c");
    R(c, bx + 4, by + 4, 1, 1, "#c98a1c");
    R(c, bx + 4, by + 6, 1, 1, "#c98a1c");
  } else if (mark === "z") {
    R(c, bx + 3, by + 2, 3, 1, "#6b675f");
    R(c, bx + 4, by + 3, 1, 1, "#6b675f");
    R(c, bx + 3, by + 4, 1, 1, "#6b675f");
    R(c, bx + 3, by + 5, 3, 1, "#6b675f");
  } else {
    const k = Math.floor(t / 250) % 4;
    for (let i = 0; i < 3; i++) R(c, bx + 3 + i * 3, by + 4 - (i === k ? 1 : 0), 1, 1, "#4f6bd8");
  }
}

/** A packet in flight: a small envelope. */
export function paintEnvelope(c: Ctx, x: number, y: number, col: string) {
  const bx = Math.round(x - 4);
  const by = Math.round(y - 3);
  R(c, bx, by, 9, 7, OUTLINE);
  R(c, bx + 1, by + 1, 7, 5, "#ffffff");
  R(c, bx + 1, by + 1, 1, 1, col);
  R(c, bx + 7, by + 1, 1, 1, col);
  R(c, bx + 2, by + 2, 1, 1, col);
  R(c, bx + 6, by + 2, 1, 1, col);
  R(c, bx + 3, by + 3, 3, 1, col);
}
