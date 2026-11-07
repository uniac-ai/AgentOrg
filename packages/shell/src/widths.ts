/** The widgets' width beside an agent, in CSS pixels: a preference of this browser's, kept between visits. */
const KEY = "agentorg.widgets";
export const WIDGETS = { min: 280, max: 640, initial: 340 };

const clamp = (width: number) => Math.round(Math.min(WIDGETS.max, Math.max(WIDGETS.min, width)));

export function storedWidth(): number {
  try {
    const width = Number(localStorage.getItem(KEY));
    return width ? clamp(width) : WIDGETS.initial;
  } catch {
    return WIDGETS.initial;
  }
}

export function keepWidth(width: number) {
  try {
    localStorage.setItem(KEY, String(clamp(width)));
  } catch {
    // Not kept: it's only a preference.
  }
}
