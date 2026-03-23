const NUMERIC_SECONDS_PATTERN = /^\d+$/;
const DURATION_PATTERN = /^(\d+)([smh])$/i;

type SleepAfterInput = string | number | undefined;

type SleepAfterParseSuccess = {
  ok: true;
  value: string | number | undefined;
};

type SleepAfterParseFailure = {
  ok: false;
  message: string;
};

export type SleepAfterParseResult = SleepAfterParseSuccess | SleepAfterParseFailure;

const INVALID_SLEEP_AFTER_MESSAGE =
  'Invalid "sleep after" value. Use seconds (for example `300`) or a duration like `30s`, `5m`, or `1h`.';

export function parseSleepAfterInput(value: SleepAfterInput): SleepAfterParseResult {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      return { ok: false, message: INVALID_SLEEP_AFTER_MESSAGE };
    }

    return { ok: true, value };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: undefined };
  }

  if (NUMERIC_SECONDS_PATTERN.test(trimmed)) {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      return { ok: false, message: INVALID_SLEEP_AFTER_MESSAGE };
    }

    return { ok: true, value: parsed };
  }

  const durationMatch = trimmed.match(DURATION_PATTERN);
  if (durationMatch) {
    const [, amount, unit] = durationMatch;
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || !Number.isInteger(amountNum) || amountNum < 0) {
      return { ok: false, message: INVALID_SLEEP_AFTER_MESSAGE };
    }

    return { ok: true, value: `${amountNum}${unit.toLowerCase()}` };
  }

  return { ok: false, message: INVALID_SLEEP_AFTER_MESSAGE };
}
