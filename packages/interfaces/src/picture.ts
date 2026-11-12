import { z } from "zod";

/** The most one picture carries, in characters of base64: about 370 KB of image. */
export const PICTURE_MAX = 500_000;
/**
 * A picture, carried inside the message that has it: its media type, and its bytes in base64. The
 * cap's number is set by the frame a message travels in (1 MiB), not by what a model needs to read
 * a picture: whoever makes one fits it, and one over the cap is left out where it is made.
 */
export const Picture = z.object({
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z
    .string()
    .min(1)
    .max(PICTURE_MAX)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
/** The most pictures that go with one message. */
export const PICTURES_MAX = 8;
/** The pictures that go with one message: at most eight, and together within the frame it travels in. */
export const Pictures = z.array(Picture).max(PICTURES_MAX);
