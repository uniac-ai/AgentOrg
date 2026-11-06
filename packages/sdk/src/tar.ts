/**
 * A deterministic ustar archive of regular files: entries in path order, mode 0644, uid and gid 0,
 * mtime 0 and no owner names, so equal trees give equal bytes.
 */
export function writeTar(files: Map<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const path of [...files.keys()].sort()) {
    const data = files.get(path) as Uint8Array;
    const name = new TextEncoder().encode(path);
    if (name.length > 100) throw new RangeError(`${path} is longer than a tar name allows.`);
    const header = new Uint8Array(512);
    header.set(name, 0);
    const field = (offset: number, length: number, value: number) =>
      header.set(
        new TextEncoder().encode(`${value.toString(8).padStart(length - 1, "0")}\0`),
        offset,
      );
    field(100, 8, 0o644);
    field(108, 8, 0);
    field(116, 8, 0);
    field(124, 12, data.length);
    field(136, 12, 0);
    header.set(new TextEncoder().encode("        "), 148);
    header[156] = "0".charCodeAt(0);
    header.set(new TextEncoder().encode("ustar\u000000"), 257);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

/** A plain relative path: `/`-separated, with no empty, `.` or `..` segments or backslashes. */
function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\\") &&
    !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** The regular files of a ustar archive, refusing anything else and any checksum mismatch. */
export function readTar(archive: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const text = (from: number, length: number) =>
    new TextDecoder().decode(archive.subarray(from, from + length)).replace(/\0.*$/s, "");
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return files;
    const sum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (Number.parseInt(text(offset + 148, 8).trim(), 8) !== sum)
      throw new Error(`Corrupt tar header at byte ${offset}.`);
    if (text(offset + 156, 1) !== "0")
      throw new Error(`Only regular files are allowed in a package.`);
    const path = text(offset, 100);
    const size = Number.parseInt(text(offset + 124, 12).trim(), 8);
    if (text(offset + 345, 155)) throw new Error("A package's tar uses no name prefix.");
    if (!safePath(path)) throw new Error(`Unsafe path ${JSON.stringify(path)} in a package.`);
    if (!Number.isInteger(size) || size < 0 || offset + 512 + size > archive.length)
      throw new Error(`${path}'s size runs past the end of the archive.`);
    if (files.has(path)) throw new Error(`${path} appears twice in a package.`);
    files.set(path, archive.slice(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("The tar archive ends without its end marker.");
}
