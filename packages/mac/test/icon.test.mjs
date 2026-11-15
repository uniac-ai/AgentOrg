// The app's icon: what the bundle carries holds every size macOS draws, from 16 to 1024 px, beside
// the masters it is made from, and the window's own icon isn't the blank stand-in it replaced.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../src-tauri/${path}`, import.meta.url));

/** A PNG's width and height, from its header. */
const size = (png) => {
  assert.equal(png.subarray(0, 8).toString("latin1"), "\x89PNG\r\n\x1a\n");
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};

test("the bundle's icon holds every size from 16 to 1024 px, and the window's isn't the stand-in", () => {
  const config = JSON.parse(read("tauri.conf.json").toString("utf8"));
  assert.deepEqual(config.bundle.icon, ["icons/icon.icns", "icons/icon.png"]);

  const icns = read("icons/icon.icns");
  assert.equal(icns.subarray(0, 4).toString("latin1"), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  const held = {};
  for (let at = 8, length = 0; at < icns.length; at += length) {
    length = icns.readUInt32BE(at + 4);
    assert.ok(length >= 8 && at + length <= icns.length, `an entry at ${at} of ${length} bytes`);
    held[icns.subarray(at, at + 4).toString("latin1")] = icns.subarray(at + 8, at + length);
  }
  // Each kind macOS reads as a PNG, at its size in pixels; 16 and 32 px are also there in the
  // older form, ic04 and ic05.
  const kinds = {
    ic11: 32,
    ic12: 64,
    ic07: 128,
    ic13: 256,
    ic08: 256,
    ic14: 512,
    ic09: 512,
    ic10: 1024,
  };
  for (const [kind, pixels] of Object.entries(kinds)) {
    assert.ok(held[kind], `${kind} is missing`);
    assert.deepEqual(size(held[kind]), [pixels, pixels], kind);
  }
  assert.ok(held.ic04 && held.ic05);

  // The masters it is made from.
  assert.deepEqual(size(read("icons/icon-1024.png")), [1024, 1024]);
  assert.match(read("icons/icon.svg").toString("utf8"), /^<svg [^>]*viewBox="0 0 1024 1024"/);
  // The window's own icon: the picture at 128 px, where the stand-in was a blank one of 32, and
  // 8-bit RGBA, which Tauri's build requires of it.
  const png = read("icons/icon.png");
  assert.deepEqual(size(png), [128, 128]);
  assert.deepEqual([png[24], png[25]], [8, 6]);
});
