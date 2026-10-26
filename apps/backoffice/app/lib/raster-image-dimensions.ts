/**
 * The width and height a PNG, JPEG, or WebP image declares in its header, without decoding it;
 * null when the header is cut short or malformed.
 */
export function rasterImageDimensions(
  bytes: Uint8Array,
  mimeType: "image/png" | "image/jpeg" | "image/webp",
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fits = (offset: number, length: number) => offset + length <= bytes.byteLength;

  switch (mimeType) {
    case "image/png":
      // The IHDR chunk always comes first, right after the signature.
      return fits(16, 8) ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
    case "image/jpeg": {
      let offset = 2;
      while (fits(offset, 4) && bytes[offset] === 0xff) {
        const marker = bytes[offset + 1];
        if (marker === 0xff) {
          offset += 1;
          continue;
        }
        // Start-of-frame markers, apart from DHT, JPG, and DAC, which share the range.
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          return fits(offset + 5, 4)
            ? { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
            : null;
        }
        // Restart markers, start of image, and TEM stand alone; every other segment declares its length.
        const standalone = (marker >= 0xd0 && marker <= 0xd8) || marker === 0x01;
        offset += standalone ? 2 : 2 + view.getUint16(offset + 2);
      }
      return null;
    }
    case "image/webp": {
      if (!fits(12, 18)) {
        return null;
      }
      const chunk = new TextDecoder("ascii").decode(bytes.subarray(12, 16));
      if (chunk === "VP8 ") {
        return {
          width: view.getUint16(26, true) & 0x3fff,
          height: view.getUint16(28, true) & 0x3fff,
        };
      }
      if (chunk === "VP8L") {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8X") {
        const uint24 = (offset: number) =>
          view.getUint8(offset) |
          (view.getUint8(offset + 1) << 8) |
          (view.getUint8(offset + 2) << 16);
        return { width: uint24(24) + 1, height: uint24(27) + 1 };
      }
      return null;
    }
    default:
      throw new Error("Unsupported image type.", { cause: mimeType satisfies never });
  }
}
