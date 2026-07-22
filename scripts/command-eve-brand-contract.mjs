/** Shared pixel thresholds for icon generation and release verification. */
export const OPAQUE_ALPHA_MIN = 250;
export const OPAQUE_WHITE_RGB_MIN = 245;

export function isOpaqueWhitePixel(red, green, blue, alpha) {
  return (
    alpha >= OPAQUE_ALPHA_MIN &&
    red >= OPAQUE_WHITE_RGB_MIN &&
    green >= OPAQUE_WHITE_RGB_MIN &&
    blue >= OPAQUE_WHITE_RGB_MIN
  );
}
