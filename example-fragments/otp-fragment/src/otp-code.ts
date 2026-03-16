export interface OtpCodeConfig {
  codeLength?: number;
  alphabet?: string;
}

export const DEFAULT_CODE_LENGTH = 8;
export const DEFAULT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const MAX_CODE_ALPHABET_LENGTH = 256;
const MAX_RANDOM_VALUES_BYTE_LENGTH = 65_536;

export const validateOtpCodeConfig = (config: OtpCodeConfig) => {
  if (config.alphabet !== undefined) {
    if (config.alphabet.length === 0) {
      throw new Error("OTP alphabet must not be empty.");
    }

    if (config.alphabet.length > MAX_CODE_ALPHABET_LENGTH) {
      throw new Error(
        `OTP alphabet length must not exceed ${MAX_CODE_ALPHABET_LENGTH} characters.`,
      );
    }
  }

  if (config.codeLength !== undefined) {
    if (!Number.isInteger(config.codeLength) || config.codeLength <= 0) {
      throw new Error("OTP codeLength must be a positive integer.");
    }
  }
};

export const resolveCodeAlphabet = (config: Pick<OtpCodeConfig, "alphabet">) => {
  const alphabet =
    config.alphabet && config.alphabet.length > 0 ? config.alphabet : DEFAULT_ALPHABET;

  if (alphabet.length > MAX_CODE_ALPHABET_LENGTH) {
    throw new Error(`OTP alphabet length must not exceed ${MAX_CODE_ALPHABET_LENGTH} characters.`);
  }

  return alphabet;
};

export const resolveCodeLength = (config: Pick<OtpCodeConfig, "codeLength">) => {
  const length = config.codeLength ?? DEFAULT_CODE_LENGTH;
  return Number.isInteger(length) && length > 0 ? length : DEFAULT_CODE_LENGTH;
};

const fillRandomValues = (values: Uint8Array) => {
  for (let offset = 0; offset < values.length; offset += MAX_RANDOM_VALUES_BYTE_LENGTH) {
    crypto.getRandomValues(
      values.subarray(offset, offset + MAX_RANDOM_VALUES_BYTE_LENGTH) as Parameters<
        typeof crypto.getRandomValues
      >[0],
    );
  }

  return values;
};

export const generateOtpCode = (config: Pick<OtpCodeConfig, "alphabet" | "codeLength">) => {
  const alphabet = resolveCodeAlphabet(config);
  const targetLength = resolveCodeLength(config);
  const acceptedUpperBound =
    Math.floor(MAX_CODE_ALPHABET_LENGTH / alphabet.length) * alphabet.length;

  let code = "";
  while (code.length < targetLength) {
    const values = fillRandomValues(new Uint8Array(targetLength - code.length));

    for (const value of values) {
      if (value >= acceptedUpperBound) {
        continue;
      }

      code += alphabet[value % alphabet.length]!;
      if (code.length === targetLength) {
        break;
      }
    }
  }

  return code;
};

export const normalizeOtpCode = (value: string, config: Pick<OtpCodeConfig, "alphabet">) => {
  const trimmed = value.trim();
  const alphabet = resolveCodeAlphabet(config);

  return /[a-z]/.test(alphabet) ? trimmed : trimmed.toUpperCase();
};
