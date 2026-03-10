type UploadKeySegmentInput = {
  label: string;
  value: string;
};

export const validateUploadKeySegment = (label: string, value: string): string | null => {
  if (value.length === 0) {
    return null;
  }

  if (value !== value.trim()) {
    return `${label} cannot start or end with whitespace.`;
  }

  if (value.includes("/")) {
    return `${label} cannot include '/'.`;
  }

  return null;
};

export const buildUploadKeyPrefix = (segments: readonly UploadKeySegmentInput[]) => {
  const normalizedSegments: string[] = [];

  for (const segment of segments) {
    const error = validateUploadKeySegment(segment.label, segment.value);
    if (error) {
      return { keyPrefix: "", error };
    }

    if (segment.value.length > 0) {
      normalizedSegments.push(segment.value);
    }
  }

  return {
    keyPrefix: normalizedSegments.length > 0 ? `${normalizedSegments.join("/")}/` : "",
    error: null,
  };
};

export const buildUploadFileKey = (keyPrefix: string, fileName: string) => {
  const error = validateUploadKeySegment("File name", fileName);
  if (error) {
    return { fileKey: null, error };
  }

  return {
    fileKey: `${keyPrefix}${fileName}`,
    error: null,
  };
};
