// Where everything in the pixel office stands, in world pixels (one pixel of
// art each). Pure: the rooms are the departments and the desks the teammates,
// placed per the company's saved office settings; the common rooms (your
// office, the kitchen, the lounge), the furniture, the doors and the walking
// grid are derived from them. Nothing here touches the DOM.
import type { CompanyData } from "../../api/types.ts";

export const ROOM_COLORS = ["#e8eef9", "#e6f2ec", "#f7ece2", "#efe8f6", "#fbf1dd", "#e3f0f3", "#ecebe6"];

/** Where the rooms and desks stand, as saved on the company; everything else is derived. */
export interface OfficeSettings {
  rooms?: Record<string, { slot?: number; color?: string }>;
  desks?: Record<string, { col: number; row: number }>;
}

/** The company's office settings when they are well formed; anything else is ignored. */
export function officeSettings(settings: Record<string, unknown> | null | undefined): OfficeSettings {
  const o = settings?.office;
  if (!o || typeof o !== "object") return {};
  const out: OfficeSettings = {};
  const rooms = (o as { rooms?: unknown }).rooms;
  if (rooms && typeof rooms === "object") {
    out.rooms = {};
    for (const [id, v] of Object.entries(rooms as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const { slot, color } = v as { slot?: unknown; color?: unknown };
      const r: { slot?: number; color?: string } = {};
      if (typeof slot === "number" && Number.isInteger(slot) && slot >= 0) r.slot = slot;
      if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) r.color = color;
      out.rooms[id] = r;
    }
  }
  const desks = (o as { desks?: unknown }).desks;
  if (desks && typeof desks === "object") {
    out.desks = {};
    for (const [id, v] of Object.entries(desks as Record<string, unknown>)) {
      const { col, row } = (v ?? {}) as { col?: unknown; row?: unknown };
      if (
        typeof col === "number" &&
        typeof row === "number" &&
        Number.isInteger(col) &&
        Number.isInteger(row) &&
        col >= 0 &&
        row >= 0
      )
        out.desks[id] = { col, row };
    }
  }
  return out;
}

export interface Pt {
  x: number;
  y: number;
}
export interface Rect extends Pt {
  w: number;
  h: number;
}
export type Facing = "up" | "down" | "left" | "right";

/** The world: 552 wide; walls 6 thick; the wall face (what you see of a room's top wall) 30 tall. */
export const WORLD_W = 552;
export const WALL = 6;
export const FACE = 30;
const STRIP_H = 100;
/** A desk is 32 by 20 from its corner; the stations sit 48 apart across and 56 down. */
export const STATION = { w: 32, h: 20, dx: 48, dy: 56 };
/** Where the sitter's feet are, from the desk's corner. */
export const SEAT = { x: 16, y: 31 };

export type AreaKind = "office" | "reception" | "kitchen" | "lounge" | "dept";
export type FloorKind = "wood" | "tile" | "stone";
export interface Area extends Rect {
  id: string;
  kind: AreaKind;
  floor: FloorKind;
  /** Wallpaper for the wall face. */
  wall: string;
  /** Picks the wood and the decoration. */
  seed: number;
}

export type PropKind =
  | "desk"
  | "chair"
  | "bossDesk"
  | "bossChair"
  | "bookshelf"
  | "plant"
  | "window"
  | "whiteboard"
  | "painting"
  | "clock"
  | "frame"
  | "cabinets"
  | "counter"
  | "coffee"
  | "microwave"
  | "fridge"
  | "cooler"
  | "vending"
  | "sofa"
  | "armchair"
  | "coffeeTable"
  | "roundTable"
  | "stool"
  | "filing"
  | "printer"
  | "lamp"
  | "meetingTable"
  | "shelf"
  | "frontDesk"
  | "bench"
  | "taskBoard"
  | "rug";

export interface Prop extends Rect {
  kind: PropKind;
  /** Draw order among people: a prop is drawn after anyone whose feet are above this line. Null: part of the room. */
  sort: number | null;
  /** The floor it takes from walkers. */
  block: Rect | null;
  seed: number;
  /** The teammate a desk or chair belongs to. */
  owner?: string;
}

/** Somewhere an idle teammate may go: to stand facing something, or to sit. */
export interface Spot extends Pt {
  pose: "stand" | "sit";
  face: Facing;
  area: string;
}

/** A doorway: a gap in a room's top wall (at is the room's top) or its left wall (at is its left). */
export interface Door extends Rect {
  side: "top" | "left";
  at: number;
}

/** The floor a doorway gives walkers: the gap and a little of each room's floor. */
export function doorWalk(d: Door): Rect {
  return d.side === "top"
    ? { x: d.x, y: d.at - WALL - 8, w: d.w, h: WALL + FACE + 16 }
    : { x: d.at - WALL - 8, y: d.y, w: WALL + 16, h: d.h };
}

export interface Room {
  d: { id: string; name: string; writePolicy: string };
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  /** Each desk's corner (the desk is 32 by 20 from it) and its cell. */
  desks: { id: string; x: number; y: number; col: number; row: number }[];
  door: Pt;
  /** The desk cells: cell (col, row) sits at (x0 + col * dx, y0 + row * dy). */
  grid: { cols: number; rows: number; x0: number; y0: number; dx: number; dy: number };
}

export interface Layout {
  W: number;
  H: number;
  rooms: Room[];
  /** Where you sit (your feet), behind your desk. */
  owner: Pt;
  ownerDesk: Rect;
  /** Where teammates wait on you, in order: in front of your desk, then on the reception bench, then standing in reception. */
  visitors: Spot[];
  /** The company's Peter, who sits at reception: everything goes through him. Null when there is none. */
  manager: string | null;
  /** Peter's seat (his feet) behind the reception desk, and the desk. */
  front: { seat: Pt; desk: Rect };
  single: boolean;
  areas: Area[];
  doors: Door[];
  props: Prop[];
  spots: Spot[];
}

/** A small stable hash, for picking variants. */
export function hashOf(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/** Each person's cell: the chosen one when it is on the grid and free, else their default cell or the next free one after it. */
function placeDesks(
  people: string[],
  chosen: OfficeSettings["desks"],
  cols: number,
  rows: number,
): Map<string, { col: number; row: number }> {
  const taken = new Set<string>();
  const out = new Map<string, { col: number; row: number }>();
  const key = (c: { col: number; row: number }) => `${c.col},${c.row}`;
  for (const id of people) {
    const c = chosen?.[id];
    if (c && c.col < cols && c.row < rows && !taken.has(key(c))) {
      out.set(id, { col: c.col, row: c.row });
      taken.add(key(c));
    }
  }
  // The rest keep their own default cell (their place in the department's order) when it is free, else the next free one after it.
  people.forEach((id, k) => {
    if (out.has(id)) return;
    let next = k;
    while (taken.has(key({ col: next % cols, row: Math.floor(next / cols) }))) next += 1;
    const c = { col: next % cols, row: Math.floor(next / cols) };
    out.set(id, c);
    taken.add(key(c));
  });
  return out;
}

const r4 = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/** The company's project manager, as the board picks him: handle peter, else the first whose role says so. */
export function companyManager(teammates: CompanyData["teammates"]): string | null {
  const peter = teammates.find((t) => t.handle === "peter");
  if (peter) return peter.id;
  const pms = teammates
    .filter((t) => /project manager/i.test(t.role))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return pms[0]?.id ?? null;
}

/** Your office: your desk against the wall, a window, a bookshelf, room in front for whoever waits on you. */
function furnishOffice(a: Area, props: Prop[]): { owner: Pt; ownerDesk: Rect; visitors: Spot[] } {
  const { x, y } = a;
  const bg = (kind: PropKind, px: number, py: number, w: number, h: number, block: Rect | null = null) =>
    props.push({ kind, x: px, y: py, w, h, sort: null, block, seed: a.seed });
  bg("rug", x + 22, y + 58, 96, 32);
  bg("window", x + 22, y + 5, 30, 18);
  bg("frame", x + 58, y + 8, 12, 10);
  bg("clock", x + 76, y + 6, 12, 12);
  bg("plant", x + 4, y + 24, 14, 22, r4(x + 3, y + 30, 16, 16));
  bg("filing", x + 86, y + 20, 14, 26, r4(x + 84, y + 30, 18, 18));
  bg("bookshelf", x + 104, y + 4, 30, 40, r4(x + 102, y + 30, 36, 16));
  const desk = r4(x + 40, y + 44, 56, 24);
  props.push({ kind: "bossChair", x: x + 59, y: y + 24, w: 18, h: 22, sort: y + 46, block: null, seed: 0 });
  props.push({
    kind: "bossDesk",
    ...desk,
    sort: desk.y + desk.h,
    block: r4(x + 36, y + 30, 64, 40),
    seed: a.seed,
  });
  const wait = (px: number, py: number): Spot => ({
    x: x + px,
    y: y + py,
    pose: "stand",
    face: "up",
    area: a.id,
  });
  return { owner: { x: x + 68, y: y + 50 }, ownerDesk: desk, visitors: [wait(56, 84), wait(80, 84)] };
}

/**
 * Reception, between your office and the rest: Peter's desk facing the door,
 * the board on the wall, a bench and a water cooler. Everything goes through
 * him, and the way to your office is through here.
 */
function furnishReception(a: Area, props: Prop[], spots: Spot[]): { seat: Pt; desk: Rect; visitors: Spot[] } {
  const { x, y } = a;
  const bg = (kind: PropKind, px: number, py: number, w: number, h: number, block: Rect | null = null) =>
    props.push({ kind, x: px, y: py, w, h, sort: null, block, seed: a.seed });
  const live = (kind: PropKind, px: number, py: number, w: number, h: number, block: Rect | null = null) =>
    props.push({ kind, x: px, y: py, w, h, sort: py + h, block, seed: a.seed });
  bg("rug", x + 10, y + 74, 104, 22);
  // The board on the wall, clear of the room's name plate; a shelf over the water cooler.
  live("taskBoard", x + 44, y + 3, 52, 21);
  bg("shelf", x + 98, y + 8, 22, 10);
  bg("cooler", x + 106, y + 20, 12, 28, r4(x + 104, y + 32, 16, 18));
  live("bench", x + 4, y + 26, 36, 20, r4(x + 2, y + 30, 40, 18));
  const desk = r4(x + 40, y + 44, 48, 26);
  props.push({ kind: "bossChair", x: x + 55, y: y + 24, w: 18, h: 22, sort: y + 46, block: null, seed: 1 });
  props.push({
    kind: "frontDesk",
    ...desk,
    sort: desk.y + desk.h,
    // The counter only: Peter gets in and out behind it.
    block: r4(x + 38, y + 44, 52, 28),
    seed: a.seed,
  });
  spots.push({ x: x + 112, y: y + 56, face: "up", pose: "stand", area: a.id });
  const at = (px: number, py: number, pose: Spot["pose"], face: Facing): Spot => ({
    x: x + px,
    y: y + py,
    pose,
    face,
    area: a.id,
  });
  return {
    seat: { x: x + 64, y: y + 50 },
    desk,
    visitors: [
      at(13, 42, "sit", "down"),
      at(31, 42, "sit", "down"),
      at(52, 84, "stand", "up"),
      at(76, 84, "stand", "up"),
    ],
  };
}

/** The kitchen: a counter with the coffee machine, the fridge, a vending machine, a table. */
function furnishKitchen(a: Area, props: Prop[], spots: Spot[]) {
  const { x, y } = a;
  const bg = (kind: PropKind, px: number, py: number, w: number, h: number, block: Rect | null = null) =>
    props.push({ kind, x: px, y: py, w, h, sort: null, block, seed: a.seed });
  const live = (kind: PropKind, px: number, py: number, w: number, h: number, block: Rect | null = null) =>
    props.push({ kind, x: px, y: py, w, h, sort: py + h, block, seed: a.seed });
  bg("cabinets", x + 4, y + 3, 64, 12);
  bg("counter", x + 4, y + 22, 64, 24, r4(x + 2, y + 30, 68, 18));
  bg("microwave", x + 46, y + 12, 18, 11);
  live("coffee", x + 8, y + 11, 12, 16);
  bg("fridge", x + 72, y + 10, 20, 38, r4(x + 70, y + 30, 24, 20));
  live("vending", x + 98, y + 6, 26, 42, r4(x + 96, y + 30, 30, 20));
  live("roundTable", x + 50, y + 64, 24, 16, r4(x + 48, y + 66, 28, 16));
  live("stool", x + 40, y + 72, 8, 8);
  live("stool", x + 76, y + 72, 8, 8);
  const at = (px: number, py: number, face: Facing) =>
    spots.push({ x: x + px, y: y + py, face, pose: "stand", area: a.id });
  at(14, 54, "up");
  at(82, 56, "up");
  at(111, 56, "up");
  at(36, 84, "right");
  at(88, 84, "left");
}

/** The lounge: a rug, a sofa, two armchairs, a coffee table, a lamp and a painting. */
function furnishLounge(a: Area, props: Prop[], spots: Spot[]) {
  const { x, y } = a;
  const bg = (kind: PropKind, px: number, py: number, w: number, h: number, block: Rect | null = null) =>
    props.push({ kind, x: px, y: py, w, h, sort: null, block, seed: a.seed });
  const live = (kind: PropKind, px: number, py: number, w: number, h: number, block: Rect | null = null) =>
    props.push({ kind, x: px, y: py, w, h, sort: py + h, block, seed: a.seed });
  bg("rug", x + 8, y + 42, 114, 44);
  bg("painting", x + 47, y + 4, 36, 20);
  bg("shelf", x + 8, y + 8, 26, 10);
  bg("shelf", x + 96, y + 8, 26, 10);
  bg("plant", x + 4, y + 24, 14, 22, r4(x + 3, y + 30, 16, 16));
  bg("plant", x + 112, y + 24, 14, 22, r4(x + 110, y + 30, 18, 16));
  live("sofa", x + 33, y + 22, 64, 28, r4(x + 31, y + 30, 68, 20));
  live("lamp", x + 100, y + 20, 10, 30, r4(x + 98, y + 42, 14, 8));
  live("coffeeTable", x + 47, y + 60, 36, 14, r4(x + 45, y + 60, 40, 16));
  live("armchair", x + 6, y + 48, 22, 24, r4(x + 4, y + 52, 26, 20));
  live("armchair", x + 102, y + 48, 22, 24, r4(x + 100, y + 52, 26, 20));
  const sit = (px: number, py: number) =>
    spots.push({ x: x + px, y: y + py, face: "down", pose: "sit", area: a.id });
  sit(49, 46);
  sit(65, 46);
  sit(81, 46);
  sit(17, 66);
  sit(113, 66);
}

/** A department: a bookshelf, a window and a whiteboard on the wall, the desks, and for a wide room a meeting corner. */
function furnishDept(a: Area, room: Room, props: Prop[], spots: Spot[]) {
  const { x, y, w } = a;
  const bg = (kind: PropKind, px: number, py: number, pw: number, ph: number, block: Rect | null = null) =>
    props.push({ kind, x: px, y: py, w: pw, h: ph, sort: null, block, seed: a.seed });
  const live = (kind: PropKind, px: number, py: number, pw: number, ph: number, block: Rect | null = null) =>
    props.push({ kind, x: px, y: py, w: pw, h: ph, sort: py + ph, block, seed: a.seed });
  // A carpet under the desks, in the room's colour.
  const g = room.grid;
  bg("rug", g.x0 - 6, g.y0 - 4, (g.cols - 1) * g.dx + STATION.w + 12, (g.rows - 1) * g.dy + 46);
  bg("plant", x + 4, y + 24, 14, 22, r4(x + 3, y + 30, 16, 16));
  bg("bookshelf", x + 20, y + 4, 30, 40, r4(x + 18, y + 30, 34, 16));
  bg("window", x + 58, y + 5, 28, 18);
  bg("whiteboard", x + 94, y + 4, 40, 20);
  for (const k of room.desks) {
    props.push({
      kind: "desk",
      x: k.x,
      y: k.y - 8,
      w: STATION.w,
      h: STATION.h + 10,
      sort: k.y + STATION.h,
      block: r4(k.x - 2, k.y - 8, STATION.w + 4, STATION.h + 3),
      seed: hashOf(k.id),
      owner: k.id,
    });
    props.push({
      kind: "chair",
      x: k.x + 8,
      y: k.y + 23,
      w: 16,
      h: 15,
      sort: k.y + SEAT.y + 0.5,
      block: r4(k.x + 8, k.y + 24, 16, 14),
      seed: hashOf(k.id),
      owner: k.id,
    });
  }
  const stand = (px: number, py: number, face: Facing) =>
    spots.push({ x: px, y: py, face, pose: "stand", area: a.id });
  stand(x + 35, y + 48, "up");
  stand(x + 114, y + 46, "up");
  // Past the desks: what the room has room for (the right-hand walkway and the bottom band stay clear).
  const gridRight = room.grid.x0 + (room.grid.cols - 1) * room.grid.dx + STATION.w;
  const free = x + w - 44 - gridRight;
  if (free >= 70) {
    const mx = gridRight + 14;
    bg("window", mx + 8, y + 5, 28, 18);
    bg("plant", mx + 44, y + 24, 14, 22, r4(mx + 43, y + 30, 16, 16));
    live("meetingTable", mx + 4, y + 70, 48, 20, r4(mx + 2, y + 70, 52, 22));
    for (const cx of [mx + 10, mx + 30])
      props.push({
        kind: "chair",
        x: cx,
        y: y + 92,
        w: 16,
        h: 15,
        sort: y + 99.5,
        block: r4(cx, y + 93, 16, 14),
        seed: a.seed,
      });
    stand(mx + 18, y + 106, "up");
    stand(mx + 38, y + 106, "up");
  }
  if (free >= 200) {
    const mx = gridRight + 90;
    bg("rug", mx, y + 44, 150, 58);
    live("sofa", mx + 30, y + 22, 64, 28, r4(mx + 28, y + 30, 68, 20));
    live("coffeeTable", mx + 44, y + 62, 36, 14, r4(mx + 42, y + 62, 40, 16));
    live("lamp", mx + 102, y + 20, 10, 30, r4(mx + 100, y + 42, 14, 8));
    bg("painting", mx + 112, y + 4, 36, 20);
    live("printer", mx + 124, y + 30, 20, 16, r4(mx + 122, y + 32, 24, 16));
    for (const px of [mx + 46, mx + 62, mx + 78])
      spots.push({ x: px, y: y + 46, face: "down", pose: "sit", area: a.id });
  }
}

/**
 * Rooms per department (plus one for teammates in none), desks per member,
 * under a strip of common rooms: your office, reception (where Peter sits),
 * the kitchen, the lounge. The settings say where: rooms with a slot come
 * first in slot order, the rest follow in department order; a desk takes its
 * chosen cell when it is free. Peter is at reception, not at a desk.
 */
export function officeLayout(
  data: Pick<CompanyData, "departments" | "teammates">,
  scope: string,
  office: OfficeSettings = {},
): Layout {
  const manager = companyManager(data.teammates);
  const rooms0: { d: Room["d"]; people: string[]; index: number }[] = data.departments.map((d, i) => ({
    d,
    people: [
      ...(d.leadTeammateId ? [d.leadTeammateId] : []),
      ...d.members.filter((m) => !m.isLead).map((m) => m.teammateId),
    ].filter((id) => id !== manager),
    index: i,
  }));
  const placed = new Set(rooms0.flatMap((r) => r.people));
  const loose = data.teammates.filter((t) => !placed.has(t.id) && t.id !== manager).map((t) => t.id);
  if (loose.length)
    rooms0.push({
      d: { id: "none", name: "No department", writePolicy: "readonly" },
      people: loose,
      index: rooms0.length,
    });
  const slotted = rooms0.map((r) => ({ ...r, slot: office.rooms?.[r.d.id]?.slot }));
  slotted.sort((a, b) => (a.slot ?? Infinity) - (b.slot ?? Infinity) || a.index - b.index);
  const depts = slotted.filter((r) => scope === "all" || r.d.id === scope);
  const W = WORLD_W;
  const single = depts.length === 1;
  const perRow = single ? 1 : Math.min(3, Math.max(1, depts.length));
  const roomW = Math.floor((W - WALL - perRow * WALL) / perRow);
  const deskCols = single ? 5 : 3;
  const deskRows = single ? 3 : 2;
  const roomH = FACE + 16 + deskRows * STATION.dy + 2;
  const top = WALL + STRIP_H + WALL;
  const rowsN = Math.ceil(Math.max(1, depts.length) / perRow);
  const H = top + rowsN * (roomH + WALL);

  const areas: Area[] = [];
  const props: Prop[] = [];
  const spots: Spot[] = [];
  const doors: Door[] = [];
  // The strip: your office, reception, the kitchen, the lounge, side by side.
  let sx = WALL;
  const strip = (w: number, id: string, kind: AreaKind, floor: FloorKind, wall: string): Area => {
    const a = { id, kind, floor, wall, seed: hashOf(id), x: sx, y: WALL, w, h: STRIP_H };
    sx += w + WALL;
    return a;
  };
  const officeArea = strip(140, "office", "office", "wood", "#e7dcc8");
  const reception = strip(124, "reception", "reception", "stone", "#e2e9e1");
  const kitchen = strip(128, "kitchen", "kitchen", "tile", "#eef0ee");
  const lounge = strip(W - sx - WALL, "lounge", "lounge", "wood", "#dfe6ee");
  areas.push(officeArea, reception, kitchen, lounge);
  const you = furnishOffice(officeArea, props);
  const front = furnishReception(reception, props, spots);
  furnishKitchen(kitchen, props, spots);
  furnishLounge(lounge, props, spots);
  // The common rooms open onto each other; your office only onto reception.
  for (const a of [reception, kitchen, lounge])
    doors.push({ side: "left", at: a.x, x: a.x - WALL, y: a.y + 66, w: WALL, h: 24 });

  const rooms: Room[] = depts.map((r, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const x = WALL + col * (roomW + WALL);
    const y = top + row * (roomH + WALL);
    const grid = {
      cols: deskCols,
      rows: deskRows,
      x0: x + 14,
      y0: y + FACE + 16,
      dx: STATION.dx,
      dy: STATION.dy,
    };
    const cells = placeDesks(r.people, office.desks, grid.cols, grid.rows);
    const desks = r.people.map((id) => {
      const c = cells.get(id)!;
      return { id, x: grid.x0 + c.col * grid.dx, y: grid.y0 + c.row * grid.dy, col: c.col, row: c.row };
    });
    const color = office.rooms?.[r.d.id]?.color ?? ROOM_COLORS[r.index % ROOM_COLORS.length]!;
    // The door is in the top wall, clear of the desks, as far right as opens onto a room above; never
    // straight into your office, which is through reception.
    const gridRight = grid.x0 + (grid.cols - 1) * grid.dx + STATION.w;
    const above = row === 0 ? [reception, kitchen, lounge] : [];
    const opens = (dx: number) => row > 0 || above.some((a) => dx >= a.x + 4 && dx + 20 <= a.x + a.w - 4);
    let dx = x + roomW - 32;
    while (dx > gridRight + 2 && !opens(dx)) dx -= 2;
    if (!opens(dx)) for (dx = x + roomW - 32; dx + 20 <= x + roomW - 6 && !opens(dx); dx += 2);
    const door: Door = { side: "top", at: y, x: dx, y: y - WALL, w: 20, h: WALL + FACE };
    doors.push(door);
    if (col > 0) doors.push({ side: "left", at: x, x: x - WALL, y: y + roomH - 26, w: WALL, h: 20 });
    return {
      d: r.d,
      x,
      y,
      w: roomW,
      h: roomH,
      color,
      desks,
      door: { x: door.x + 10, y: y + FACE + 4 },
      grid,
    };
  });
  rooms.forEach((room) => {
    const area: Area = {
      id: `room:${room.d.id}`,
      kind: "dept",
      floor: "wood",
      wall: room.color,
      seed: hashOf(room.d.id),
      x: room.x,
      y: room.y,
      w: room.w,
      h: room.h,
    };
    areas.push(area);
    furnishDept(area, room, props, spots);
  });
  return {
    W,
    H,
    rooms,
    owner: you.owner,
    ownerDesk: you.ownerDesk,
    visitors: [...you.visitors, ...front.visitors],
    manager: manager && data.teammates.some((t) => t.id === manager) ? manager : null,
    front: { seat: front.seat, desk: front.desk },
    single,
    areas,
    doors,
    props,
    spots,
  };
}

export const inRoom = (r: Rect, x: number, y: number) =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** The desk cell under a point in a room (a desk is 32 by 20 from its cell's corner). */
export function cellAt(r: Room, x: number, y: number): { col: number; row: number } {
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  return {
    col: clamp(Math.round((x - r.grid.x0 - STATION.w / 2) / r.grid.dx), r.grid.cols - 1),
    row: clamp(Math.round((y - r.grid.y0 - STATION.h / 2) / r.grid.dy), r.grid.rows - 1),
  };
}

/**
 * A desk dropped at a point in its own room takes that cell; a desk already
 * there takes the dropped one's old cell. Null when nothing changes (outside
 * the room, or the same cell).
 */
export function dropDesk(
  office: OfficeSettings,
  L: Layout,
  teammateId: string,
  x: number,
  y: number,
): OfficeSettings | null {
  const room = L.rooms.find((r) => r.desks.some((d) => d.id === teammateId));
  const mine = room?.desks.find((d) => d.id === teammateId);
  if (!room || !mine || !inRoom(room, x, y)) return null;
  const cell = cellAt(room, x, y);
  if (cell.col === mine.col && cell.row === mine.row) return null;
  const desks = { ...office.desks, [teammateId]: cell };
  const other = room.desks.find((d) => d.id !== teammateId && d.col === cell.col && d.row === cell.row);
  if (other) desks[other.id] = { col: mine.col, row: mine.row };
  return { ...office, desks };
}

/** A room dropped on another swaps their places. Null when nothing changes. */
export function dropRoom(
  office: OfficeSettings,
  L: Layout,
  deptId: string,
  x: number,
  y: number,
): OfficeSettings | null {
  const from = L.rooms.findIndex((r) => r.d.id === deptId);
  const to = L.rooms.findIndex((r) => inRoom(r, x, y));
  if (from < 0 || to < 0 || from === to) return null;
  const rooms: NonNullable<OfficeSettings["rooms"]> = { ...office.rooms };
  L.rooms.forEach((r, i) => {
    rooms[r.d.id] = { ...rooms[r.d.id], slot: i };
  });
  rooms[L.rooms[from]!.d.id] = { ...rooms[L.rooms[from]!.d.id], slot: to };
  rooms[L.rooms[to]!.d.id] = { ...rooms[L.rooms[to]!.d.id], slot: from };
  return { ...office, rooms };
}

/** The room's colour, one of the palette. */
export function recolorRoom(office: OfficeSettings, deptId: string, color: string): OfficeSettings {
  return { ...office, rooms: { ...office.rooms, [deptId]: { ...office.rooms?.[deptId], color } } };
}

/** Where someone sits, the room they call home, and where they stand when blocked. */
export interface Seat extends Pt {
  /** Behind the reception desk facing the room (Peter), or at a desk facing its screen. */
  front: boolean;
  home: string;
  beside: Pt;
}

/** Where a teammate sits: their feet on the chair in front of their desk, or Peter's behind reception. */
export function seatOf(L: Layout, id: string): Seat | null {
  if (id === L.manager) {
    const { seat, desk } = L.front;
    return { ...seat, front: true, home: "reception", beside: { x: desk.x + desk.w + 8, y: desk.y + 30 } };
  }
  for (const r of L.rooms) {
    const d = r.desks.find((k) => k.id === id);
    if (d)
      return {
        x: d.x + SEAT.x,
        y: d.y + SEAT.y,
        front: false,
        home: `room:${r.d.id}`,
        beside: { x: d.x + STATION.w + 6, y: d.y + 30 },
      };
  }
  return null;
}

/** The floor people may walk on, in cells of 4: room floors and doorways, less what the furniture stands on. */
export interface WalkGrid {
  cols: number;
  rows: number;
  cell: number;
  open: Uint8Array;
}
export const CELL = 4;

export function walkGrid(L: Layout): WalkGrid {
  const cols = Math.ceil(L.W / CELL);
  const rows = Math.ceil(L.H / CELL);
  const open = new Uint8Array(cols * rows);
  const mark = (r: Rect, v: 0 | 1) => {
    const c0 = Math.max(0, Math.floor(r.x / CELL));
    const c1 = Math.min(cols - 1, Math.floor((r.x + r.w - 0.01) / CELL));
    const r0 = Math.max(0, Math.floor(r.y / CELL));
    const r1 = Math.min(rows - 1, Math.floor((r.y + r.h - 0.01) / CELL));
    for (let row = r0; row <= r1; row++)
      for (let col = c0; col <= c1; col++) {
        const cx = col * CELL + CELL / 2;
        const cy = row * CELL + CELL / 2;
        if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) open[row * cols + col] = v;
      }
  };
  for (const a of L.areas) mark(r4(a.x + 4, a.y + FACE + 4, a.w - 8, a.h - FACE - 6), 1);
  for (const d of L.doors) mark(doorWalk(d), 1);
  for (const p of L.props) if (p.block) mark(p.block, 0);
  return { cols, rows, cell: CELL, open };
}

const cellOf = (g: WalkGrid, p: Pt) => ({
  col: Math.min(g.cols - 1, Math.max(0, Math.floor(p.x / g.cell))),
  row: Math.min(g.rows - 1, Math.max(0, Math.floor(p.y / g.cell))),
});

/** Is a point on open floor? */
export function walkable(g: WalkGrid, p: Pt): boolean {
  const c = cellOf(g, p);
  return g.open[c.row * g.cols + c.col] === 1;
}

/**
 * The way from one point to another along open floor, four ways only, as the
 * corners of the walk and then the point itself. The two ends may be on
 * furniture (a chair, a sofa): the walk leaves or reaches them from the
 * nearest open floor. Null when there is no way.
 */
export function findPath(g: WalkGrid, from: Pt, to: Pt): Pt[] | null {
  const s = cellOf(g, from);
  const t = cellOf(g, to);
  const start = s.row * g.cols + s.col;
  const goal = t.row * g.cols + t.col;
  if (start === goal) return [{ x: to.x, y: to.y }];
  const prev = new Int32Array(g.cols * g.rows).fill(-1);
  prev[start] = start;
  const queue = new Int32Array(g.cols * g.rows);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  // Off the floor at either end (on a chair), a few cells of furniture may be crossed to reach it.
  const nearEnd = (i: number) => {
    const col = i % g.cols;
    const row = (i - col) / g.cols;
    return (
      (Math.abs(col - s.col) <= 3 && Math.abs(row - s.row) <= 3) ||
      (Math.abs(col - t.col) <= 3 && Math.abs(row - t.row) <= 3)
    );
  };
  while (head < tail) {
    const i = queue[head++]!;
    if (i === goal) break;
    const col = i % g.cols;
    const row = (i - col) / g.cols;
    const next = [
      row > 0 ? i - g.cols : -1,
      row < g.rows - 1 ? i + g.cols : -1,
      col > 0 ? i - 1 : -1,
      col < g.cols - 1 ? i + 1 : -1,
    ];
    for (const n of next) {
      if (n < 0 || prev[n] !== -1) continue;
      if (!g.open[n] && n !== goal && !nearEnd(n)) continue;
      prev[n] = i;
      queue[tail++] = n;
    }
  }
  if (prev[goal] === -1) return null;
  const cells: number[] = [];
  for (let i = goal; i !== start; i = prev[i]!) cells.push(i);
  cells.reverse();
  const center = (i: number): Pt => {
    const col = i % g.cols;
    return { x: col * g.cell + g.cell / 2, y: ((i - col) / g.cols) * g.cell + g.cell / 2 };
  };
  // Keep the corners only.
  const pts: Pt[] = [];
  let last = center(start);
  let dir = "";
  for (const c of cells) {
    const p = center(c);
    const d = p.x !== last.x ? "h" : "v";
    if (dir && d !== dir) pts.push(last);
    dir = d;
    last = p;
  }
  pts.push({ x: to.x, y: to.y });
  return pts;
}
