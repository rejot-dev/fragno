/** Recognizes raster signatures rather than trusting user-controlled filenames or MIME metadata. */
export function rasterImageContentType(
  prefix: Uint8Array,
): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => prefix[index] === byte)) {
    return "image/png";
  }
  if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) {
    return "image/jpeg";
  }
  const signature = new TextDecoder("ascii").decode(prefix.subarray(0, 12));
  if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}
