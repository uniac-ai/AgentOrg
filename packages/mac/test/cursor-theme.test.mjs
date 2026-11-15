// The agents' pointer as the theme's source holds it: the approved drawing's numbers, every action
// the driver names, one paint per layer, and an archive that is the same bytes each time. The
// driver's own compiler checks the rest when the app is assembled.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dotLottie, THEME, themeFiles } from "../scripts/cursor-theme.mjs";

const files = themeFiles();
const theme = files["cua/theme.json"];
const frame = files["a/pointer.json"];
const paints = (layer) => layer.shapes.filter((shape) => shape.ty === "fl" || shape.ty === "st");

test("the pointer is v20's path at 3.3 times, its tip on a whole hotspot, in every action", () => {
  assert.equal(theme.id, THEME);
  assert.deepEqual(theme.canvas, { width: 128, height: 128, fps: 30 });
  assert.deepEqual(theme.hotspot, { x: 12, y: 10 });
  // The approved drawing, moved by (0.45, 0.76) so that its tip is whole.
  const path = frame.layers[0].shapes[0].ks.k;
  assert.deepEqual(path.v, [
    [12, 10],
    [12, 62.14],
    [26.52, 48.94],
    [36.09, 69.4],
    [45.33, 65.44],
    [36.09, 45.31],
    [55.23, 44.65],
  ]);
  assert.equal(path.c, true);
  // Every action the driver names draws the one frame, which it paints as `idle`.
  assert.deepEqual(Object.keys(theme.actions).sort(), [
    "app",
    "click",
    "drag",
    "idle",
    "key",
    "navigate",
    "observe",
    "record",
    "scroll",
    "system",
    "text",
    "transfer",
  ]);
  for (const action of Object.values(theme.actions))
    assert.deepEqual(action, { animation: "pointer", still_frame: 0 });
  assert.deepEqual(
    files["manifest.json"].animations.map((one) => one.id),
    ["pointer"],
  );
  assert.deepEqual([frame.ip, frame.op, frame.w, frame.h, frame.fr], [0, 1, 128, 128, 30]);
});

test("the outline is on top, then the body, then the shadow, a fill and twelve strokes, each with one paint", () => {
  const layers = frame.layers;
  assert.equal(layers.length, 15);
  for (const layer of layers) {
    assert.equal(paints(layer).length, 1, layer.nm);
    assert.deepEqual([layer.ty, layer.ip, layer.op], [4, 0, 1], layer.nm);
  }
  const [outline, body, shadow, ...edges] = layers.map((layer) => ({
    paint: paints(layer)[0],
    down: layer.ks.p.k[1],
  }));
  assert.deepEqual(
    [outline.paint.ty, outline.paint.c.k, outline.paint.w.k, outline.paint.lj, outline.down],
    ["st", [1, 1, 1, 1], 5.94, 2, 0],
  );
  assert.deepEqual(
    [body.paint.ty, body.paint.c.k.map((c) => Math.round(c * 255)), body.down],
    ["fl", [17, 17, 17, 255], 0],
  );
  assert.deepEqual(
    [shadow.paint.ty, shadow.paint.c.k, shadow.paint.o.k, shadow.down],
    ["fl", [0, 0, 0, 1], 10, 6.6],
  );
  assert.deepEqual(
    edges.map(({ paint, down }) => [paint.ty, paint.o.k, down]),
    Array(12).fill(["st", 2.2, 6.6]),
  );
  assert.deepEqual(
    edges.map(({ paint }) => paint.w.k),
    [19.8, 18.15, 16.5, 14.85, 13.2, 11.55, 9.9, 8.25, 6.6, 4.95, 3.3, 1.65],
  );
});

test("the source is a ZIP of the three files, the same bytes each time", (t) => {
  const bytes = dotLottie();
  assert.deepEqual(dotLottie(), bytes);
  const folder = mkdtempSync(join(tmpdir(), "theme-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const archive = join(folder, `${THEME}.lottie`);
  writeFileSync(archive, bytes);
  // Stored, dated 1980-01-01, each file as its JSON.
  const listing = execFileSync("unzip", ["-Z", "-l", archive], { encoding: "utf8" });
  const names = Object.keys(files);
  for (const name of names) assert.match(listing, new RegExp(` stor 80-Jan-01 00:00 ${name}\\n`));
  for (const name of names)
    assert.deepEqual(
      JSON.parse(execFileSync("unzip", ["-p", archive, name], { encoding: "utf8" })),
      files[name],
    );
});
