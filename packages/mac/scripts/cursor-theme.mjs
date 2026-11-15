// The pointer the agents are drawn with on the screen: Cua Driver's cursor theme, made here as its
// source, a dotLottie archive. The driver draws it, for each agent, in place of its own dart; the
// app draws nothing of it. It is the window's own pointer, v20's path, black with a white outline,
// at about its size: the path ×3.3 on the theme's 128-unit canvas, which the driver shows at 42
// points. A theme can't blur, so the shadow is the path again, lower, filled faintly, under twelve
// faint strokes of falling width.
//
// The driver paints only a theme's `idle` animation, but a full theme names an animation for each
// of its twelve actions: every one here is the same single frame. Each layer has one paint, so that
// the driver and a Lottie player stack them alike, the first layer on top. The archive is stored,
// not deflated, with fixed dates and modes, so the same drawing makes the same bytes.
import { crc32 } from "node:zlib";

/** The theme's id, and the file's name the driver looks for: `<id>.cua-theme`. */
export const THEME = "ai.uniac.agentorg.pointer";

const CANVAS = 128;
const FPS = 30;
/** v20's pointer, in its own units, the tip first. */
const V20 = [
  [3.5, 2.8],
  [3.5, 18.6],
  [7.9, 14.6],
  [10.8, 20.8],
  [13.6, 19.6],
  [10.8, 13.5],
  [16.6, 13.3],
];
const SCALE = 3.3;
/** The tip, where the driver puts the target: whole units, as the driver's hotspot must be. */
const TIP = [12, 10];
const ACTIONS = [
  "idle",
  "observe",
  "click",
  "drag",
  "scroll",
  "text",
  "key",
  "navigate",
  "app",
  "transfer",
  "record",
  "system",
];

const round = (value) => Math.round(value * 100) / 100;
const fixed = (value) => ({ a: 0, k: value });
/** The path, scaled to the canvas and moved so that its tip is the hotspot. */
const points = V20.map(([x, y]) => [
  round(x * SCALE + TIP[0] - V20[0][0] * SCALE),
  round(y * SCALE + TIP[1] - V20[0][1] * SCALE),
]);
const path = {
  ty: "sh",
  nm: "Pointer",
  ks: fixed({ c: true, v: points, i: points.map(() => [0, 0]), o: points.map(() => [0, 0]) }),
};
const BLACK = [0, 0, 0, 1];
const WHITE = [1, 1, 1, 1];
/** #111, as Lottie's colours go, from 0 to 1. */
const BODY = [17 / 255, 17 / 255, 17 / 255, 1];

/** One shape layer of the one frame: the path, and one paint, `down` units lower. */
const layer = (index, name, paint, down = 0) => ({
  ddd: 0,
  ind: index,
  ty: 4,
  nm: name,
  sr: 1,
  ks: {
    o: fixed(100),
    r: fixed(0),
    p: fixed([0, round(down)]),
    a: fixed([0, 0]),
    s: fixed([100, 100]),
  },
  ao: 0,
  shapes: [path, paint],
  ip: 0,
  op: 1,
  st: 0,
  bm: 0,
});
const stroke = (color, width, opacity) => ({
  ty: "st",
  c: fixed(color),
  o: fixed(opacity),
  w: fixed(round(width)),
  lc: 2,
  lj: 2,
});
const fill = (color, opacity) => ({ ty: "fl", c: fixed(color), o: fixed(opacity), r: 1 });

/** The theme's three files: the dotLottie manifest, the driver's manifest, and the one frame. */
export function themeFiles() {
  const shadow = 2 * SCALE;
  const layers = [
    layer(1, "Outline", stroke(WHITE, 1.8 * SCALE, 100)),
    layer(2, "Body", fill(BODY, 100)),
    layer(3, "Shadow", fill(BLACK, 10), shadow),
    // Widest first, each 2.2 % black: together, a shadow with no step at real size.
    ...Array.from({ length: 12 }, (_, i) =>
      layer(4 + i, "Shadow edge", stroke(BLACK, (12 - i) * 0.5 * SCALE, 2.2), shadow),
    ),
  ];
  return {
    "manifest.json": {
      version: "2",
      generator: "AgentOrg",
      animations: [{ id: "pointer", name: "pointer" }],
    },
    "cua/theme.json": {
      schema: "cua.cursor-theme/2",
      id: THEME,
      name: "AgentOrg pointer",
      version: "1.0.0",
      author: "AgentOrg",
      license: "MIT",
      compatibility: { profile: "cua-driver-actions-v2", semantics: 2 },
      canvas: { width: CANVAS, height: CANVAS, fps: FPS },
      hotspot: { x: TIP[0], y: TIP[1] },
      actions: Object.fromEntries(
        ACTIONS.map((action) => [action, { animation: "pointer", still_frame: 0 }]),
      ),
    },
    "a/pointer.json": {
      v: "5.12.2",
      fr: FPS,
      ip: 0,
      op: 1,
      w: CANVAS,
      h: CANVAS,
      nm: "pointer",
      ddd: 0,
      assets: [],
      layers,
      markers: [],
    },
  };
}

/** A file's JSON as the archive holds it: compact, with a newline. */
const encoded = (value) => Buffer.from(`${JSON.stringify(value)}\n`);

/** The theme's source: a ZIP of its files, stored, each dated 1980-01-01 with mode 0644. */
export function dotLottie(files = themeFiles()) {
  const DATE = (1 << 5) | 1;
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const body = encoded(value);
    const title = Buffer.from(name);
    const sum = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(title.length, 26);
    local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(DATE, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(title.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, title, body);
    central.push(entry, title);
    offset += local.length + title.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
