type RasterImageDimensions = { width: number; height: number };

/**
 * The width and height of a PNG, JPEG, or WebP image whose structure is complete, without decoding
 * it; null when the file is cut short or malformed. A decoder can still reject damaged pixel data
 * inside an intact structure.
 */
export function inspectRasterImage(
  bytes: Uint8Array,
  mimeType: "image/png" | "image/jpeg" | "image/webp",
): RasterImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fits = (offset: number, length: number) => offset + length <= bytes.byteLength;
  const ascii = (offset: number) =>
    String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 4, bytes.byteLength)));

  const dimensions = (() => {
    switch (mimeType) {
      case "image/png":
        return inspectPng(view, fits, ascii);
      case "image/jpeg":
        return inspectJpeg(bytes, view, fits);
      case "image/webp":
        return inspectWebp(view, fits, ascii);
      default:
        throw new Error("Unsupported image type.", { cause: mimeType satisfies never });
    }
  })();
  return dimensions && dimensions.width > 0 && dimensions.height > 0 ? dimensions : null;
}

// Chunks run from IHDR, which holds the dimensions, through at least one IDAT to IEND.
function inspectPng(
  view: DataView,
  fits: (offset: number, length: number) => boolean,
  ascii: (offset: number) => string,
): RasterImageDimensions | null {
  if (!fits(8, 25) || ascii(12) !== "IHDR" || view.getUint32(8) !== 13) {
    return null;
  }
  const dimensions = { width: view.getUint32(16), height: view.getUint32(20) };
  let hasPixels = false;
  let offset = 8;
  while (fits(offset, 12)) {
    // Each chunk is its length, type, data, and CRC.
    const chunkLength = 12 + view.getUint32(offset);
    if (!fits(offset, chunkLength)) {
      return null;
    }
    const type = ascii(offset + 4);
    hasPixels ||= type === "IDAT";
    if (type === "IEND") {
      return hasPixels ? dimensions : null;
    }
    offset += chunkLength;
  }
  return null;
}

// Segments run to the first scan, which follows a start of frame and ends at the end-of-image marker.
function inspectJpeg(
  bytes: Uint8Array,
  view: DataView,
  fits: (offset: number, length: number) => boolean,
): RasterImageDimensions | null {
  let dimensions: RasterImageDimensions | null = null;
  let offset = 2;
  while (fits(offset, 4) && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Restart markers, start of image, and TEM stand alone; every other segment declares its length.
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (!fits(offset + 2, length)) {
      return null;
    }
    // Start-of-frame markers, apart from DHT, JPG, and DAC, which share the range.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc &&
      length >= 7
    ) {
      dimensions = { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
    }
    if (marker === 0xda) {
      // Scan data escapes every 0xff byte, so the first 0xffd9 after it ends the image.
      for (let end = offset + 2 + length; fits(end, 2); end++) {
        if (bytes[end] === 0xff && bytes[end + 1] === 0xd9) {
          return dimensions;
        }
      }
      return null;
    }
    offset += 2 + length;
  }
  return null;
}

// A RIFF container whose chunks fill its declared size and include a still image.
function inspectWebp(
  view: DataView,
  fits: (offset: number, length: number) => boolean,
  ascii: (offset: number) => string,
): RasterImageDimensions | null {
  if (!fits(12, 18)) {
    return null;
  }
  const end = 8 + view.getUint32(4, true);
  if (!fits(0, end)) {
    return null;
  }
  let hasPixels = false;
  let offset = 12;
  while (offset + 8 <= end) {
    // Each chunk is its type, length, and data, padded to an even length.
    const dataLength = view.getUint32(offset + 4, true);
    if (offset + 8 + dataLength > end) {
      return null;
    }
    // An animated WebP holds its frames in ANMF chunks instead.
    hasPixels ||= ascii(offset) === "VP8 " || ascii(offset) === "VP8L";
    offset += 8 + dataLength + (dataLength % 2);
  }
  if (!hasPixels) {
    return null;
  }
  switch (ascii(12)) {
    // A key frame starts with the start code 9d 01 2a.
    case "VP8 ":
      return view.getUint8(23) === 0x9d && view.getUint8(24) === 0x01 && view.getUint8(25) === 0x2a
        ? { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
        : null;
    // A lossless bitstream starts with the signature 0x2f.
    case "VP8L": {
      const bits = view.getUint32(21, true);
      return view.getUint8(20) === 0x2f
        ? { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
        : null;
    }
    case "VP8X": {
      const uint24 = (offset: number) =>
        view.getUint8(offset) |
        (view.getUint8(offset + 1) << 8) |
        (view.getUint8(offset + 2) << 16);
      return { width: uint24(24) + 1, height: uint24(27) + 1 };
    }
    default:
      return null;
  }
}
