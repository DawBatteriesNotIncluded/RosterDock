// The pixel office: a canvas the size of the world (one pixel of art each),
// scaled up without smoothing, with the names and plates written over it at
// screen resolution, and what teammates say in speech bubbles over their heads
// (HTML, so the words read as words). People sit at their desks while they
// work, stand up when blocked, walk to your desk when they need you, and go to
// the kitchen or the lounge when they have nothing on. Everything they do is a
// projection of tasks, runs and events; only where the rooms and desks stand
// is stored.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CompanyData, Run, Teammate } from "../../api/types.ts";
import { cn } from "../../lib/cn.ts";
import {
  ArtCache,
  CHAR_H,
  CHAR_W,
  lookFor,
  paintClockHands,
  paintCoffeeSteam,
  paintEnvelope,
  paintMark,
  paintRooms,
  paintRug,
  paintScreen,
  paintTaskBoard,
  paintTray,
  nightOf,
  type Frame,
  type Look,
  type Screen,
  type View,
} from "./art.ts";
import {
  LINE_LABEL,
  newStage,
  shortAge,
  stepStage,
  type Line,
  type Playing,
  type Stage,
} from "./dialogue.ts";
import {
  FACE,
  STATION,
  cellAt,
  dropDesk,
  dropRoom,
  findPath,
  hashOf,
  inRoom,
  officeLayout,
  seatOf,
  walkGrid,
  type Facing,
  type Layout,
  type OfficeSettings,
  type Pt,
  type WalkGrid,
} from "./layout.ts";
import {
  KIND_COLOR,
  POLICY_LABEL,
  agentMode,
  pendingApprovals,
  roomImageName,
  spriteFrame,
  teammateColor,
  type Edge,
  type EdgeKind,
  type OfficePack,
  type SpriteMode,
} from "./model.ts";

export interface PixelOfficeProps {
  data: CompanyData;
  liveRuns: Run[];
  scope: string;
  edges: Edge[];
  /** What was said, oldest first, already narrowed to the scope. */
  lines: Line[];
  meName: string;
  isDark: boolean;
  office: OfficeSettings;
  pack: OfficePack;
  editing: boolean;
  onEdit(next: OfficeSettings): void;
  onScope(id: string): void;
  /** The lines over heads right now, for the conversation list to mark. */
  onSpeaking?(keys: string[]): void;
  onOpenTask(id: string): void;
  onOpenTeammate(id: string): void;
  onOpenDepartmentBoard(id: string): void;
  onGoApprovals(): void;
  imageUrl?(name: string, sha256: string): string;
}

interface Walker {
  id: string;
  x: number;
  y: number;
  path: Pt[];
  face: Facing;
  /** Walking or standing; on a seat; at a desk facing the screen; behind the reception desk facing the room. */
  pose: "stand" | "sit" | "desk" | "front";
  /** Where they are headed: desk, blocked, visit:<n>, spot:<n>. */
  goal: string;
  arrived: boolean;
  walked: number;
  restUntil: number;
  mode: SpriteMode;
  look: Look;
}

interface Packet {
  e: Edge;
  p: number;
  landed: boolean;
}
interface Tag {
  to: string;
  text: string;
  kind: EdgeKind;
  until: number;
}

const SPEED = 40; // world pixels a second
const STATUS_DOT: Partial<Record<SpriteMode, string>> = {
  typing: "#1f7a5c",
  reading: "#4f6bd8",
  blocked: "#b3261e",
  waiting: "#c98a1c",
};

/** A person's frame for how they stand and move. */
function frameFor(w: Walker, t: number): { view: View; frame: Frame } {
  if (w.pose === "desk")
    return {
      view: "up",
      frame: w.mode === "typing" ? (Math.floor((t + hashOf(w.id)) / 170) % 2 ? "typeA" : "typeB") : "rest",
    };
  if (w.pose === "sit") return { view: "down", frame: "sit" };
  if (w.pose === "front") return { view: "down", frame: "stand" };
  const moving = w.path.length > 0;
  const view: View = w.face;
  if (!moving) return { view, frame: "stand" };
  const k = Math.floor(w.walked / 4) % 4;
  if (view === "left" || view === "right") return { view, frame: k % 2 ? "stand" : "walkA" };
  return { view, frame: (["walkA", "stand", "walkB", "stand"] as const)[k]! };
}

/** The top of a person's head, in world pixels. */
function headOf(w: Pick<Walker, "x" | "y" | "pose">): Pt {
  return { x: w.x, y: w.y - (w.pose === "sit" ? 21 : 23) };
}

export function PixelOffice(p: PixelOfficeProps) {
  const { data, liveRuns, scope, office, editing } = p;
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layout = useMemo(
    () => officeLayout(data, scope, office),
    // The layout follows the departments, the teammates, the scope and the saved places.
    [
      JSON.stringify(
        data.departments.map((d) => [
          d.id,
          d.name,
          d.writePolicy,
          d.leadTeammateId,
          d.members.map((m) => m.teammateId),
        ]),
      ),
      data.teammates.map((t) => t.id).join(),
      scope,
      JSON.stringify(office),
    ],
  );
  const modes = useMemo(() => {
    const out = new Map<string, ReturnType<typeof agentMode>>();
    for (const t of data.teammates) out.set(t.id, agentMode(t, data.tasks, liveRuns));
    return out;
  }, [data.teammates, data.tasks, liveRuns]);
  const answering = useMemo(
    () =>
      new Set(liveRuns.filter((r) => r.kind === "turn" && r.status === "running").map((r) => r.teammateId)),
    [liveRuns],
  );
  const [talk, setTalk] = useState<Playing[]>([]);
  const bubbleEls = useRef(new Map<string, HTMLButtonElement>());
  const walkersRef = useRef<Map<string, Walker>>(new Map());
  const state = {
    data,
    layout,
    modes,
    answering,
    edges: p.edges,
    lines: p.lines,
    meName: p.meName,
    isDark: p.isDark,
    pack: p.pack,
    editing,
    onSpeaking: p.onSpeaking,
  };
  const stateRef = useRef(state);
  stateRef.current = state;
  // The pack's images, by name and hash; one is drawn once the browser has it, code stands in until then.
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const packKey = JSON.stringify(p.pack);
  const { imageUrl } = p;
  useEffect(() => {
    const next = new Map<string, HTMLImageElement>();
    for (const [name, im] of Object.entries(p.pack)) {
      const key = `${name}@${im.sha256}`;
      const have = imagesRef.current.get(key);
      if (have) next.set(key, have);
      else if (imageUrl) {
        const img = new Image();
        img.src = imageUrl(name, im.sha256);
        next.set(key, img);
      }
    }
    imagesRef.current = next;
  }, [packKey, imageUrl]);
  /** What the pointer is carrying in edit mode, in world coordinates. */
  const dragRef = useRef<{ kind: "desk" | "room"; id: string; x: number; y: number; moved: boolean } | null>(
    null,
  );
  const sizeRef = useRef({ w: 0, h: 0 });

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) sizeRef.current = { w: r.width, h: r.height };
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const px = document.createElement("canvas");
    const pc = px.getContext("2d")!;
    const arts = { day: new ArtCache(false), night: new ArtCache(true) };
    let bg: { key: string; layout: Layout; el: HTMLCanvasElement } | null = null;
    let grid: { layout: Layout; g: WalkGrid } | null = null;
    let stage: Stage | null = null;
    let lastTalk = "";
    let packets: Packet[] = [];
    let tags: Tag[] = [];
    let lastPacket = 0;
    let placedFor: Layout | null = null;
    let edgeIdx = 0;
    let raf = 0;
    let last = performance.now();
    const walkers = walkersRef.current;

    const imageOf = (name: string | null): HTMLImageElement | null => {
      const s0 = stateRef.current;
      const im = name ? s0.pack[name] : undefined;
      const img = im ? imagesRef.current.get(`${name}@${im.sha256}`) : undefined;
      return img && img.complete && img.naturalWidth ? img : null;
    };

    /** The rooms, the walls, the doorways and everything that never moves, painted once per layout and time of day. */
    const background = (L: Layout, night: boolean) => {
      const s0 = stateRef.current;
      const floors = L.rooms.map((r) => {
        const name = roomImageName(s0.pack, r.d.id);
        return imageOf(name) ? name : "";
      });
      const key = `${night}|${floors.join()}`;
      if (bg?.key === key && bg.layout === L) return bg.el;
      const el = document.createElement("canvas");
      el.width = L.W;
      el.height = L.H;
      const c = el.getContext("2d")!;
      paintRooms(c, L.W, L.H, L.areas, L.doors);
      L.rooms.forEach((r, i) => {
        const img = floors[i] ? imageOf(floors[i]!) : null;
        const tile = img ? c.createPattern(img, "repeat") : null;
        if (!tile) return;
        c.save();
        c.translate(r.x, r.y + FACE);
        c.fillStyle = tile;
        c.fillRect(0, 0, r.w, r.h - FACE);
        c.restore();
      });
      const day = arts.day;
      const areaOf = (x: number, y: number) => L.areas.find((a) => inRoom(a, x, y)) ?? L.areas[0]!;
      for (const pr of L.props) if (pr.kind === "rug") paintRug(c, pr, areaOf(pr.x + 1, pr.y + 1));
      for (const pr of [...L.props]
        .filter((q) => q.sort === null && q.kind !== "rug")
        .sort((a, b) => a.y + a.h - (b.y + b.h))) {
        const img = day.prop(pr);
        if (img) c.drawImage(img, pr.x, pr.y);
      }
      bg = { key, layout: L, el: night ? nightOf(el) : el };
      return bg.el;
    };

    const gridFor = (L: Layout) => {
      if (grid?.layout !== L) grid = { layout: L, g: walkGrid(L) };
      return grid.g;
    };

    /** Where a walker is headed, for what they are doing. */
    const target = (
      w: Walker,
      L: Layout,
      now: number,
      waitingOrder: string[],
    ): { goal: string; at: Pt; face: Facing; pose: Walker["pose"] } | null => {
      const seat = seatOf(L, w.id);
      if (!seat) return null;
      const desk = {
        goal: "desk",
        at: { x: seat.x, y: seat.y },
        face: (seat.front ? "down" : "up") as Facing,
        pose: seat.front ? ("front" as const) : ("desk" as const),
      };
      if (w.mode === "typing" || w.mode === "reading") return desk;
      if (w.mode === "blocked") return { goal: "blocked", at: seat.beside, face: "down", pose: "stand" };
      if (w.mode === "waiting") {
        // The queue for you: first in front of your desk, then the reception bench, then standing in reception.
        const k = Math.max(0, waitingOrder.indexOf(w.id)) % L.visitors.length;
        const v = L.visitors[k]!;
        return { goal: `visit:${k}`, at: v, face: v.face, pose: v.pose };
      }
      // Idle: stay where you are a while, then go somewhere free.
      const keep = w.goal === "desk" || w.goal.startsWith("spot:");
      if (keep && (!w.arrived || now < w.restUntil)) {
        if (w.goal === "desk") return desk;
        const s = L.spots[Number(w.goal.slice(5))];
        if (s) return { goal: w.goal, at: s, face: s.face, pose: s.pose };
      }
      if (reduce) return desk;
      const taken = new Set([...walkers.values()].filter((o) => o !== w).map((o) => o.goal));
      const home = seat.home;
      const free = L.spots
        .map((s, i) => ({ s, i }))
        .filter(({ s, i }) => !taken.has(`spot:${i}`) && (s.area === home || !s.area.startsWith("room:")));
      // Back to the desk now and then, and more often after a break.
      const toDesk = w.goal.startsWith("spot:") ? 0.55 : 0.3;
      if (!free.length || Math.random() < toDesk) return desk;
      const pick = free[Math.floor(Math.random() * free.length)]!;
      return { goal: `spot:${pick.i}`, at: pick.s, face: pick.s.face, pose: pick.s.pose };
    };

    const step = (now: number, dt: number) => {
      const s0 = stateRef.current;
      const L = s0.layout;
      const g = gridFor(L);
      const ids = new Set(L.rooms.flatMap((r) => r.desks.map((k) => k.id)));
      if (L.manager) ids.add(L.manager);
      for (const id of [...walkers.keys()]) if (!ids.has(id)) walkers.delete(id);
      const mates = new Map(s0.data.teammates.map((t) => [t.id, t]));
      for (const id of ids) {
        const seat = seatOf(L, id);
        const mate = mates.get(id);
        if (!seat || !mate) continue;
        if (!walkers.has(id))
          walkers.set(id, {
            id,
            x: seat.x,
            y: seat.y,
            path: [],
            face: "up",
            pose: "desk",
            goal: "desk",
            arrived: true,
            walked: 0,
            restUntil: now + 4000 + Math.random() * 9000,
            mode: "idle",
            look: lookFor(hashOf(mate.handle), teammateColor(mate)),
          });
      }
      // A new layout (another scope, a moved room): where people stood means nothing there, so they start seated.
      if (placedFor !== L) {
        placedFor = L;
        for (const w of walkers.values()) {
          const seat = seatOf(L, w.id);
          if (seat)
            Object.assign(w, {
              x: seat.x,
              y: seat.y,
              path: [],
              goal: "desk",
              arrived: true,
              pose: seat.front ? "front" : "desk",
              face: seat.front ? "down" : "up",
            });
        }
      }
      const waitingOrder = [...walkers.values()]
        .filter((w) => s0.modes.get(w.id)?.mode === "waiting")
        .map((w) => w.id)
        .sort();
      for (const w of walkers.values()) {
        w.mode = s0.editing ? "idle" : (s0.modes.get(w.id)?.mode ?? "idle");
        const seat = seatOf(L, w.id);
        if (!seat) continue;
        if (s0.editing) {
          Object.assign(w, {
            x: seat.x,
            y: seat.y,
            path: [],
            pose: seat.front ? "front" : "desk",
            goal: "desk",
            arrived: true,
            face: seat.front ? "down" : "up",
          });
          continue;
        }
        const tg = target(w, L, now, waitingOrder);
        if (!tg) continue;
        // The same place again: stay a while longer, sitting or standing as the place asks.
        if (tg.goal === w.goal && w.arrived && !w.path.length) {
          w.pose = tg.pose;
          w.face = tg.face;
          if (now >= w.restUntil) w.restUntil = now + 7000 + Math.random() * 11000;
        }
        if (
          tg.goal !== w.goal ||
          (w.arrived && (Math.abs(w.x - tg.at.x) > 1 || Math.abs(w.y - tg.at.y) > 1))
        ) {
          w.goal = tg.goal;
          w.arrived = false;
          w.pose = "stand";
          const path = reduce ? null : findPath(g, w, tg.at);
          w.path = path ?? [];
          if (!path) {
            w.x = tg.at.x;
            w.y = tg.at.y;
          }
        }
        // Walk.
        let budget = SPEED * dt;
        while (budget > 0 && w.path.length) {
          const next = w.path[0]!;
          const dx = next.x - w.x;
          const dy = next.y - w.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 0.01)
            w.face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
          if (dist <= budget) {
            w.x = next.x;
            w.y = next.y;
            w.walked += dist;
            budget -= dist;
            w.path.shift();
          } else {
            w.x += (dx / dist) * budget;
            w.y += (dy / dist) * budget;
            w.walked += budget;
            budget = 0;
          }
        }
        if (!w.path.length && !w.arrived) {
          w.arrived = true;
          w.x = tg.at.x;
          w.y = tg.at.y;
          w.pose = tg.pose;
          w.face = tg.face;
          w.restUntil = now + 7000 + Math.random() * 11000;
        }
      }
      // Handoffs travel between desks as envelopes; one leaves every couple of seconds.
      const edgesNow = s0.editing ? [] : s0.edges;
      if (edgesNow.length && now - lastPacket > 2600 && !reduce) {
        const e = edgesNow[edgeIdx % edgesNow.length]!;
        edgeIdx += 1;
        lastPacket = now;
        packets.push({ e, p: 0, landed: false });
      }
      for (const pk of packets) {
        pk.p += dt / 1.6;
        if (pk.p >= 1 && !pk.landed) {
          pk.landed = true;
          const fromName = pk.e.from === "you" ? "you" : (mates.get(pk.e.from)?.handle ?? "someone");
          tags = tags.filter((x) => x.to !== pk.e.to);
          tags.push({
            to: pk.e.to,
            kind: pk.e.kind,
            until: now + 1800,
            text:
              pk.e.kind === "task"
                ? "new task"
                : pk.e.kind === "mention"
                  ? `@${fromName}`
                  : pk.e.kind === "review"
                    ? "review"
                    : pk.e.kind === "approval"
                      ? "approve?"
                      : "blocked",
          });
        }
      }
      packets = packets.filter((pk) => pk.p < 1);
      tags = tags.filter((x) => x.until > now);
      // Who speaks.
      const wall = Date.now();
      if (!stage) stage = newStage(s0.lines, wall);
      if (s0.editing) stage = { ...stage, playing: [] };
      else stage = stepStage(stage, s0.lines, wall, (sp) => sp === "you" || walkers.has(sp));
      const keys = stage.playing.map((x) => `${x.key}@${x.start}`).join();
      if (keys !== lastTalk) {
        lastTalk = keys;
        const playing = stage.playing;
        setTalk(playing);
        s0.onSpeaking?.(playing.map((x) => x.key));
      }
      return L;
    };

    const posOf = (id: string, L: Layout): Pt | null => {
      if (id === "you") return { x: L.owner.x, y: L.owner.y };
      const w = walkers.get(id);
      if (w) return w;
      return L.rooms[0] ? L.rooms[0].door : null;
    };

    const draw = (L: Layout, now: number) => {
      const s0 = stateRef.current;
      const night = s0.isDark;
      const art = night ? arts.night : arts.day;
      if (px.width !== L.W || px.height !== L.H) {
        px.width = L.W;
        px.height = L.H;
      }
      pc.imageSmoothingEnabled = false;
      pc.drawImage(background(L, night), 0, 0);
      const glows: { x: number; y: number; r: number; col: string }[] = [];
      // Everything that stands on the floor, in order from the back.
      const items: { sort: number; draw: () => void }[] = [];
      const pending = pendingApprovals(s0.data);
      const boardCounts: Record<string, number> = {};
      for (const t of s0.data.tasks) boardCounts[t.status] = (boardCounts[t.status] ?? 0) + 1;
      for (const pr of L.props) {
        if (pr.sort === null) continue;
        const img = art.prop(pr);
        items.push({
          sort: pr.sort,
          draw: () => {
            if (img) pc.drawImage(img, pr.x, pr.y);
            if (pr.kind === "desk" && pr.owner) {
              const w = walkers.get(pr.owner);
              const atDesk = w?.pose === "desk" && w.arrived;
              const mode = w?.mode ?? "idle";
              const screen: Screen =
                mode === "blocked"
                  ? "alert"
                  : mode === "waiting"
                    ? "ask"
                    : atDesk
                      ? mode === "typing"
                        ? "code"
                        : mode === "reading"
                          ? "doc"
                          : "idle"
                      : "off";
              paintScreen(pc, pr.x + 9, pr.y + 2, screen, reduce ? 0 : now, pr.seed);
              if (night && screen !== "off")
                glows.push({ x: pr.x + 16, y: pr.y + 8, r: 20, col: "rgba(110,160,255,0.2)" });
            }
            if (pr.kind === "coffee" && !reduce) paintCoffeeSteam(pc, pr.x + 6, pr.y - 1, now);
            if (pr.kind === "clock") paintClockHands(pc, pr.x, pr.y, new Date());
            if (pr.kind === "bossDesk") paintTray(pc, pr.x + 41, pr.y + 8, pending);
            if (pr.kind === "taskBoard") paintTaskBoard(pc, pr.x, pr.y, boardCounts);
            if (night && pr.kind === "frontDesk") {
              const peter = L.manager ? walkers.get(L.manager) : undefined;
              if (peter?.pose === "front" && (peter.mode === "typing" || peter.mode === "reading"))
                glows.push({ x: pr.x + 24, y: pr.y + 2, r: 18, col: "rgba(110,160,255,0.22)" });
            }
            if (night && pr.kind === "lamp")
              glows.push({ x: pr.x + 5, y: pr.y + 8, r: 30, col: "rgba(255,210,130,0.26)" });
            if (night && pr.kind === "vending")
              glows.push({ x: pr.x + 10, y: pr.y + 18, r: 22, col: "rgba(255,120,90,0.14)" });
          },
        });
      }
      const drawPerson = (w: Walker) => {
        const img = imageOf(`sprite.${w.mode}`) ?? imageOf("sprite.idle");
        const x = Math.round(w.x);
        const y = Math.round(w.y);
        if (w.pose !== "desk" && w.pose !== "front") {
          pc.fillStyle = "rgba(20,14,10,0.2)";
          pc.fillRect(x - 5, y - 1, 10, 2);
        }
        if (img) {
          const f = spriteFrame(img.naturalWidth, img.naturalHeight, w.path.length > 0, Math.floor(w.walked));
          pc.drawImage(img, f.sx, 0, f.w, f.h, x - Math.floor(f.w / 2), y - f.h, f.w, f.h);
          return;
        }
        const { view, frame } = frameFor(w, reduce ? 0 : now);
        const sprite = art.person(w.look, view, frame);
        // Behind the reception desk, working: a nod over the laptop now and then.
        const nod =
          w.pose === "front" && w.mode === "typing" && !reduce && Math.floor(now / 420) % 3 === 0 ? 1 : 0;
        pc.drawImage(sprite, x - CHAR_W / 2, y - CHAR_H + (w.pose === "sit" ? 2 : 0) + nod);
      };
      for (const w of walkers.values())
        items.push({ sort: w.pose === "sit" ? w.y + 20 : w.y, draw: () => drawPerson(w) });
      // You, at your desk.
      const me: Walker = {
        id: "you",
        x: L.owner.x,
        y: L.owner.y,
        path: [],
        face: "down",
        pose: "stand",
        goal: "",
        arrived: true,
        walked: 0,
        restUntil: 0,
        mode: "idle",
        look: lookFor(hashOf(s0.meName || "you"), "#34384a"),
      };
      items.push({
        sort: L.owner.y,
        draw: () => pc.drawImage(art.person(me.look, "down", "stand"), me.x - 8, me.y - 24),
      });
      items.sort((a, b) => a.sort - b.sort);
      for (const it of items) it.draw();
      if (night && glows.length) {
        pc.globalCompositeOperation = "lighter";
        for (const gl of glows) {
          const grad = pc.createRadialGradient(gl.x, gl.y, 1, gl.x, gl.y, gl.r);
          grad.addColorStop(0, gl.col);
          grad.addColorStop(1, "rgba(0,0,0,0)");
          pc.fillStyle = grad;
          pc.fillRect(gl.x - gl.r, gl.y - gl.r, gl.r * 2, gl.r * 2);
        }
        pc.globalCompositeOperation = "source-over";
      }
      // Marks over heads: blocked, waiting on you, answering.
      if (!s0.editing)
        for (const w of walkers.values()) {
          const h = headOf(w);
          const mark =
            w.mode === "blocked" ? "!" : w.mode === "waiting" ? "?" : s0.answering.has(w.id) ? "..." : null;
          if (mark && w.arrived) paintMark(pc, h.x, h.y - 1, mark, now);
        }
      // Handoffs in flight.
      for (const pk of packets) {
        const a = posOf(pk.e.from, L);
        const b = posOf(pk.e.to, L);
        if (!a || !b) continue;
        const col = KIND_COLOR[pk.e.kind];
        const ax = a.x;
        const ay = a.y - 20;
        const bx = b.x;
        const by = b.y - 20;
        const cx = (ax + bx) / 2;
        const cy = Math.min(ay, by) - 30;
        const at = (t: number) => ({
          x: (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * cx + t * t * bx,
          y: (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * cy + t * t * by,
        });
        // A short trail behind the envelope, fading out.
        pc.fillStyle = col;
        for (let t = Math.max(0, pk.p - 0.3); t < pk.p; t += 0.012) {
          const q = at(t);
          pc.globalAlpha = 0.7 * (1 - (pk.p - t) / 0.3);
          pc.fillRect(Math.round(q.x), Math.round(q.y), 1, 1);
        }
        pc.globalAlpha = 1;
        const q = at(Math.min(1, pk.p));
        paintEnvelope(pc, q.x, q.y, col);
      }

      // Onto the screen: the pixels, then the words.
      const { w: cssW } = sizeRef.current;
      const width = cssW || canvas.clientWidth || L.W * 2;
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.max(1, Math.round(width * dpr));
      const bh = Math.max(1, Math.round((width * L.H * dpr) / L.W));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(px, 0, 0, bw, bh);
      const k = width / L.W;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      /** A room's name plate on its wall; the policy goes with it when there is room. */
      const plate = (x: number, y: number, max: number, text: string, sub0: string | null, badge: number) => {
        ctx.font = '600 10px "Schibsted Grotesk", system-ui, sans-serif';
        const tw = ctx.measureText(text).width;
        ctx.font = '400 9px "IBM Plex Mono", ui-monospace, monospace';
        const bwid = badge ? 16 : 0;
        const sw0 = sub0 ? ctx.measureText(sub0).width + 8 : 0;
        const sub = sub0 && tw + sw0 + bwid + 12 <= max ? sub0 : null;
        const sw = sub ? sw0 : 0;
        const w = tw + sw + bwid + 12;
        ctx.fillStyle = night ? "rgba(16,17,24,0.82)" : "rgba(28,27,25,0.8)";
        roundRect(ctx, x, y, w, 16, 4);
        ctx.fill();
        ctx.fillStyle = "#f6f5f2";
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.font = '600 10px "Schibsted Grotesk", system-ui, sans-serif';
        ctx.fillText(text, x + 6, y + 8.5);
        if (sub) {
          ctx.fillStyle = "#b9b5ab";
          ctx.font = '400 9px "IBM Plex Mono", ui-monospace, monospace';
          ctx.fillText(sub, x + 6 + tw + 8, y + 8.5);
        }
        if (badge) {
          const bx = x + w - 13;
          ctx.fillStyle = "#c98a1c";
          ctx.beginPath();
          ctx.arc(bx + 5, y + 8, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#fff";
          ctx.font = '700 9px "IBM Plex Mono", ui-monospace, monospace';
          ctx.textAlign = "center";
          ctx.fillText(String(Math.min(99, badge)), bx + 5, y + 8.5);
        }
      };
      for (const a of L.areas) {
        const room = L.rooms.find((r) => `room:${r.d.id}` === a.id);
        const label =
          a.kind === "office"
            ? `${s0.meName} · approvals`
            : a.kind === "reception"
              ? "Reception"
              : a.kind === "kitchen"
                ? "Kitchen"
                : a.kind === "lounge"
                  ? "Lounge"
                  : (room?.d.name ?? "");
        const sub =
          a.kind === "dept" && room
            ? (POLICY_LABEL[room.d.writePolicy] ?? room.d.writePolicy).toLowerCase()
            : null;
        plate(a.x * k + 5, a.y * k + 4, a.w * k - 10, label, sub, a.kind === "office" ? pending : 0);
      }
      // Names, under each person.
      ctx.textBaseline = "middle";
      for (const w of walkers.values()) {
        const mate = s0.data.teammates.find((m) => m.id === w.id);
        if (!mate) continue;
        const ny =
          (w.pose === "desk"
            ? w.y + 9
            : w.pose === "front"
              ? w.y + 24
              : w.pose === "sit"
                ? w.y + 4
                : w.y + 3) * k;
        nameTag(ctx, w.x * k, ny, mate.name, STATUS_DOT[w.mode] ?? null, night);
      }
      // Where a handoff landed.
      for (const tg of tags) {
        const at = posOf(tg.to, L);
        if (!at) continue;
        const w = walkers.get(tg.to);
        const head = w ? headOf(w) : { x: at.x, y: at.y - 23 };
        ctx.font = '600 9px "IBM Plex Mono", ui-monospace, monospace';
        const tw = ctx.measureText(tg.text).width + 10;
        const x = head.x * k - tw / 2;
        const y = head.y * k - 34;
        ctx.fillStyle = KIND_COLOR[tg.kind];
        roundRect(ctx, x, y, tw, 14, 7);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.fillText(tg.text, x + tw / 2, y + 7.5);
      }
      if (s0.editing) drawEditing(ctx, L, k, art);
      placeBubbles(L, k, width);
    };

    /** The editor's marks: the desk cells, the cell under a dragged desk, the room it would swap with. */
    const drawEditing = (c: CanvasRenderingContext2D, L: Layout, k: number, art: ArtCache) => {
      const dg = dragRef.current;
      const accent = "#1f7a5c";
      c.save();
      c.scale(k, k);
      c.lineWidth = 1 / k;
      for (const r of L.rooms) {
        c.strokeStyle = "rgba(255,255,255,0.85)";
        c.setLineDash([3 / k, 3 / k]);
        for (let row = 0; row < r.grid.rows; row++)
          for (let col = 0; col < r.grid.cols; col++)
            c.strokeRect(
              r.grid.x0 + col * r.grid.dx - 3,
              r.grid.y0 + row * r.grid.dy - 10,
              STATION.w + 6,
              50,
            );
        c.setLineDash([]);
      }
      if (dg?.kind === "desk" && dg.moved) {
        const room = L.rooms.find((r) => r.desks.some((d) => d.id === dg.id));
        if (room && inRoom(room, dg.x, dg.y)) {
          const cl = cellAt(room, dg.x, dg.y);
          c.strokeStyle = accent;
          c.lineWidth = 2 / k;
          c.strokeRect(
            room.grid.x0 + cl.col * room.grid.dx - 3,
            room.grid.y0 + cl.row * room.grid.dy - 10,
            STATION.w + 6,
            50,
          );
        }
        const deskProp = L.props.find((q) => q.kind === "desk" && q.owner === dg.id);
        const img = deskProp ? art.prop(deskProp) : null;
        if (img) {
          c.globalAlpha = 0.85;
          c.imageSmoothingEnabled = false;
          c.drawImage(img, Math.round(dg.x - STATION.w / 2), Math.round(dg.y - 18));
          c.globalAlpha = 1;
        }
      }
      if (dg?.kind === "room" && dg.moved) {
        const tgt = L.rooms.find((r) => inRoom(r, dg.x, dg.y));
        const src = L.rooms.find((r) => r.d.id === dg.id);
        c.lineWidth = 2 / k;
        c.strokeStyle = accent;
        if (src) c.strokeRect(src.x + 1, src.y + 1, src.w - 2, src.h - 2);
        if (tgt && tgt !== src) {
          c.strokeRect(tgt.x + 1, tgt.y + 1, tgt.w - 2, tgt.h - 2);
          c.restore();
          c.save();
          c.fillStyle = accent;
          c.font = '700 11px "Schibsted Grotesk", system-ui, sans-serif';
          c.textAlign = "center";
          c.fillText(`Swap with ${src?.d.name ?? ""}`, (tgt.x + tgt.w / 2) * k, (tgt.y + tgt.h / 2) * k);
        }
      }
      c.restore();
    };

    /** Puts each speech bubble over its speaker: above the head, inside the stage, clear of the others. */
    const placeBubbles = (L: Layout, k: number, width: number) => {
      const placed: { x: number; y: number; w: number; h: number }[] = [];
      const height = (width * L.H) / L.W;
      const ordered = [...bubbleEls.current.entries()].sort(
        (a, b) => Number(a[1].dataset.start ?? 0) - Number(b[1].dataset.start ?? 0),
      );
      for (const [, el] of ordered) {
        const speaker = el.dataset.speaker ?? "";
        const w0 = speaker === "you" ? null : walkers.get(speaker);
        const head = speaker === "you" ? { x: L.owner.x, y: L.owner.y - 23 } : w0 ? headOf(w0) : null;
        if (!head) {
          el.style.visibility = "hidden";
          continue;
        }
        const bw = el.offsetWidth;
        const bh = el.offsetHeight;
        const ax = head.x * k;
        const ay = head.y * k - (w0 && (w0.mode === "blocked" || w0.mode === "waiting") ? 14 : 4);
        let x = Math.min(Math.max(6, ax - bw / 2), width - bw - 6);
        let y = ay - bh - 8;
        let below = false;
        const overlaps = (yy: number) =>
          placed.find(
            (q) => x < q.x + q.w + 4 && x + bw + 4 > q.x && yy < q.y + q.h + 4 && yy + bh + 4 > q.y,
          );
        for (let i = 0; i < 4; i++) {
          const hit = overlaps(y);
          if (!hit) break;
          y = hit.y - bh - 6;
        }
        if (y < 4) {
          below = true;
          const feet = (w0 ? w0.y + 12 : L.owner.y + 26) * k;
          y = feet + 8;
          for (let i = 0; i < 4; i++) {
            const hit = overlaps(y);
            if (!hit) break;
            y = hit.y + hit.h + 6;
          }
          y = Math.min(y, height - bh - 4);
          x = Math.min(Math.max(6, ax - bw / 2), width - bw - 6);
        }
        placed.push({ x, y, w: bw, h: bh });
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        el.style.setProperty("--tail", `${Math.round(Math.min(bw - 12, Math.max(12, ax - x)))}px`);
        el.classList.toggle("below", below);
        el.style.visibility = "visible";
      }
    };

    const loop = (t: number) => {
      const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
      last = t;
      const L = step(t, dt);
      draw(L, t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  /** A pointer position in world coordinates. */
  const toWorld = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      sx: ((e.clientX - rect.left) / rect.width) * layout.W,
      sy: ((e.clientY - rect.top) / rect.height) * layout.H,
    };
  };

  /** What is under a point: you, a teammate, a room. */
  const hit = (sx: number, sy: number) => {
    const d = layout.ownerDesk;
    if (sx >= d.x - 4 && sx <= d.x + d.w + 4 && sy >= d.y - 26 && sy <= d.y + d.h)
      return { kind: "you" as const };
    for (const w of walkersRef.current.values())
      if (Math.abs(sx - w.x) <= 8 && sy >= w.y - 24 && sy <= w.y + 2)
        return { kind: "mate" as const, id: w.id };
    const room = layout.rooms.find((r) => inRoom(r, sx, sy));
    if (room) return { kind: "room" as const, id: room.d.id };
    return null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editing || !canvasRef.current) return;
    const { sx, sy } = toWorld(e);
    for (const r of layout.rooms)
      for (const k of r.desks)
        if (sx >= k.x - 2 && sx <= k.x + STATION.w + 2 && sy >= k.y - 8 && sy <= k.y + 38) {
          dragRef.current = { kind: "desk", id: k.id, x: sx, y: sy, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
    const room = layout.rooms.find((r) => inRoom(r, sx, sy));
    if (room) {
      dragRef.current = { kind: "room", id: room.d.id, x: sx, y: sy, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const dg = dragRef.current;
    if (!canvasRef.current) return;
    const { sx, sy } = toWorld(e);
    if (!dg) {
      if (!editing) e.currentTarget.style.cursor = hit(sx, sy) ? "pointer" : "default";
      return;
    }
    if (Math.hypot(sx - dg.x, sy - dg.y) > 2) dg.moved = true;
    dg.x = sx;
    dg.y = sy;
  };
  const onPointerUp = () => {
    const dg = dragRef.current;
    dragRef.current = null;
    if (!dg || !dg.moved) return;
    const next =
      dg.kind === "desk"
        ? dropDesk(office, layout, dg.id, dg.x, dg.y)
        : dropRoom(office, layout, dg.id, dg.x, dg.y);
    if (next) p.onEdit(next);
  };
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || editing) return;
    const { sx, sy } = toWorld(e);
    const h = hit(sx, sy);
    if (!h) return;
    if (h.kind === "you") p.onGoApprovals();
    else if (h.kind === "mate") {
      const st = modes.get(h.id);
      if (st?.task) p.onOpenTask(st.task.id);
      else p.onOpenTeammate(h.id);
    } else if (scope === "all") p.onScope(h.id);
    else if (h.id !== "none") p.onOpenDepartmentBoard(h.id);
  };

  const byKey = new Map(p.lines.map((l) => [l.key, l]));
  const mateOf = (id: string): Teammate | undefined => data.teammates.find((t) => t.id === id);
  return (
    <div
      ref={stageRef}
      className="office-stage pixel"
      style={{ aspectRatio: (layout.W / layout.H).toFixed(3), minHeight: 300 }}
    >
      <canvas
        ref={canvasRef}
        aria-label={editing ? "Pixel office, editing the layout" : "Pixel office"}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        style={editing ? { cursor: "move", touchAction: "none" } : undefined}
      />
      <div className="office-bubbles" aria-hidden="true">
        {talk.map((pl) => {
          const l = byKey.get(pl.key);
          if (!l) return null;
          const mate = l.speaker === "you" ? undefined : mateOf(l.speaker);
          return (
            <button
              key={`${pl.key}@${pl.start}`}
              type="button"
              tabIndex={-1}
              className={cn("office-bubble", l.kind)}
              data-speaker={l.speaker}
              data-start={pl.start}
              style={
                {
                  "--speaker": mate ? teammateColor(mate) : "var(--ink)",
                  "--life": `${Math.round(pl.until - pl.start)}ms`,
                } as React.CSSProperties
              }
              ref={(el) => {
                if (el) bubbleEls.current.set(`${pl.key}@${pl.start}`, el);
                else bubbleEls.current.delete(`${pl.key}@${pl.start}`);
              }}
              onClick={() =>
                l.taskId ? p.onOpenTask(l.taskId) : l.speaker !== "you" && p.onOpenTeammate(l.speaker)
              }
            >
              <span className="who">
                <b>{l.speakerName}</b>
                {l.to.length ? <span className="to">→ {l.to.map((t) => t.name).join(", ")}</span> : null}
                {l.kind !== "message" && l.kind !== "mention" ? (
                  <span className="what">{LINE_LABEL[l.kind]}</span>
                ) : null}
                <span className="when">
                  {l.number ? `#${l.number} · ` : ""}
                  {pl.replay ? shortAge(l.at) : "now"}
                </span>
              </span>
              <span className="text">{withMentions(l.text)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Text with each @handle set apart. */
export function withMentions(text: string) {
  return text.split(/(@[a-z0-9][a-z0-9_-]*)/gi).map((part, i) =>
    /^@[a-z0-9]/i.test(part) ? (
      <b key={i} className="at">
        {part}
      </b>
    ) : (
      part
    ),
  );
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function nameTag(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  name: string,
  dot: string | null,
  night: boolean,
) {
  c.font = '600 10px "Schibsted Grotesk", system-ui, sans-serif';
  const tw = c.measureText(name).width;
  const w = tw + 10 + (dot ? 9 : 0);
  const left = x - w / 2;
  c.fillStyle = night ? "rgba(20,21,28,0.78)" : "rgba(255,253,248,0.86)";
  roundRect(c, left, y - 7, w, 14, 7);
  c.fill();
  if (dot) {
    c.fillStyle = dot;
    c.beginPath();
    c.arc(left + 8, y, 3, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = night ? "#ecebe6" : "#1c1b19";
  c.textAlign = "left";
  c.fillText(name, left + 5 + (dot ? 9 : 0), y + 0.5);
}
