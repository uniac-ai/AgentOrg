// A picture the person sends with a message, as chat@1 carries it: its media type and its bytes in
// base64. One too large is drawn smaller until it fits, and the pictures of one message fit
// together within what one picture carries, so the frame a message travels in holds its words too.
import { PICTURE_MAX, type Picture } from "@agentorg/interfaces";
import type { z } from "zod";

export type Sent = z.output<typeof Picture>;
/** A picture put in a box: what is sent, and the file it came from, to fit it again beside others. */
export interface Put {
  file: Blob;
  picture: Sent;
}
const KINDS = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type Kind = (typeof KINDS)[number];

const sources = new WeakMap<Sent, string>();
/** A picture as a page shows it, made once for each. */
export function sourceOf(picture: Sent) {
  const made = sources.get(picture);
  if (made) return made;
  const source = `data:${picture.mediaType};base64,${picture.data}`;
  sources.set(picture, source);
  return source;
}

const base64 = (bytes: ArrayBuffer) => {
  let text = "";
  const all = new Uint8Array(bytes);
  for (let at = 0; at < all.length; at += 0x8000)
    text += String.fromCharCode(...all.subarray(at, at + 0x8000));
  return btoa(text);
};

/** A file's picture within `max`: as it is when it fits, else smaller, as a JPEG. None for what isn't a picture. */
export async function fit(file: Blob, max = PICTURE_MAX): Promise<Sent | undefined> {
  if (!file.type.startsWith("image/")) return undefined;
  if ((KINDS as readonly string[]).includes(file.type)) {
    const data = base64(await file.arrayBuffer());
    if (data.length <= max) return { mediaType: file.type as Kind, data };
  }
  const image = await createImageBitmap(file).catch(() => undefined);
  if (!image) return undefined;
  try {
    // Each pass draws it at three quarters of the size before, until it fits.
    for (let scale = 1; scale > 0.05; scale *= 0.75) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return undefined;
      // A JPEG has nothing clear: what is clear in the picture is drawn on white.
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      // A canvas too large to draw gives nothing back, and a smaller one is tried.
      const data = canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "";
      if (data && data.length <= max) return { mediaType: "image/jpeg", data };
    }
    return undefined;
  } finally {
    image.close();
  }
}

/** A message's pictures, fitted together within what one picture carries: each within its share. */
export async function together(put: readonly Put[]): Promise<Sent[]> {
  const share = Math.floor(PICTURE_MAX / Math.max(1, put.length));
  const fitted = await Promise.all(
    put.map(({ file, picture }) =>
      picture.data.length <= share ? picture : fit(file, share).catch(() => undefined),
    ),
  );
  return fitted.filter((one): one is Sent => !!one);
}
