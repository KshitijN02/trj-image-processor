export interface Size {
  width: number;
  height: number;
}

/**
 * Size that fits the longest edge within `cap`. Never upscales, and keeps the
 * aspect ratio (the short edge is rounded, with a minimum of 1px).
 */
export function fitWithinCap(src: Size, cap: number): Size {
  const longest = Math.max(src.width, src.height);
  if (longest <= cap) return { width: src.width, height: src.height };
  const scale = cap / longest;
  if (src.width >= src.height) {
    return { width: cap, height: Math.max(1, Math.round(src.height * scale)) };
  }
  return { width: Math.max(1, Math.round(src.width * scale)), height: cap };
}

/** Size with the given width, keeping the aspect ratio. Never upscales. */
export function fitToWidth(src: Size, width: number): Size {
  if (width >= src.width) return { width: src.width, height: src.height };
  return { width, height: Math.max(1, Math.round((src.height * width) / src.width)) };
}
