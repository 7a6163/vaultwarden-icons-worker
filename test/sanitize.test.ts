import { describe, expect, test } from "vitest";
import { isAllowedImageType } from "../src/sanitize";

describe("isAllowedImageType", () => {
  test("accepts common raster favicon types", () => {
    for (const ct of [
      "image/png",
      "image/x-icon",
      "image/vnd.microsoft.icon",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/avif",
    ]) {
      expect(isAllowedImageType(ct)).toBe(true);
    }
  });

  test("ignores charset and other parameters", () => {
    expect(isAllowedImageType("image/png; charset=binary")).toBe(true);
    expect(isAllowedImageType("IMAGE/PNG")).toBe(true);
  });

  test("rejects SVG to avoid script injection", () => {
    expect(isAllowedImageType("image/svg+xml")).toBe(false);
    expect(isAllowedImageType("image/svg+xml; charset=utf-8")).toBe(false);
  });

  test("rejects non-image and empty content types", () => {
    expect(isAllowedImageType("text/html")).toBe(false);
    expect(isAllowedImageType("application/json")).toBe(false);
    expect(isAllowedImageType("")).toBe(false);
    expect(isAllowedImageType(null)).toBe(false);
  });
});
