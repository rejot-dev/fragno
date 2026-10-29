import { z } from "zod";

import { formatNanoUsd } from "./nano-usd";

/**
 * Meters an owner's usage is limited on per UTC month, with the limit every owner has until an
 * administrator sets its own. Quantities are in the meter's recorded unit; administrators read and
 * write them in its display unit.
 */
const USAGE_LIMITED_METERS = {
  "ai.cost.total": {
    unit: "nano-usd",
    displayUnit: "USD",
    perDisplayUnit: 1_000_000_000n,
    format: formatNanoUsd,
    // $10.
    defaultQuantity: 10_000_000_000n,
  },
} as const;

export type UsageLimitedMeter = keyof typeof USAGE_LIMITED_METERS;

const USAGE_LIMITED_METER_NAMES = Object.keys(USAGE_LIMITED_METERS) as [
  UsageLimitedMeter,
  ...UsageLimitedMeter[],
];

export const usageLimitedMeterSchema = z.enum(USAGE_LIMITED_METER_NAMES);

/** An owner's monthly limit on a meter, in the meter's recorded unit. */
export type UsageLimit = { kind: "limited"; quantity: string } | { kind: "unlimited" };
type FiniteUsageLimit = Extract<UsageLimit, { kind: "limited" }>;

/** What an administrator sets an owner's limit to: the deployment default, or its own. */
export type UsageLimitSetting = { kind: "default" } | UsageLimit;

/** An owner's limit on one meter and what it has used of it this period. */
export type UsageLimitStatus = {
  meter: UsageLimitedMeter;
  unit: string;
  setting: "default" | "custom";
  limit: UsageLimit;
  used: string;
};

/** A finite limit and usage that has reached it. */
export type ExhaustedUsageLimit = UsageLimitStatus & { limit: FiniteUsageLimit };

/** An owner's limits and usage in the current UTC month, formatted YYYY-MM. */
export type UsageLimits = {
  period: string;
  limits: UsageLimitStatus[];
};

/** Resolves every limited meter's status from an owner's custom limits and its period trackers. */
export function usageLimitStatuses(input: {
  customLimits: readonly { meter: string; limit: UsageLimit }[];
  trackers: readonly { meter: string; quantity: bigint }[];
}): UsageLimitStatus[] {
  return USAGE_LIMITED_METER_NAMES.map((meter) => {
    const custom = input.customLimits.find((limit) => limit.meter === meter);
    const used = input.trackers
      .filter((tracker) => tracker.meter === meter)
      .reduce((sum, tracker) => sum + tracker.quantity, 0n);
    return {
      meter,
      unit: USAGE_LIMITED_METERS[meter].unit,
      setting: custom ? "custom" : "default",
      limit: custom
        ? custom.limit
        : { kind: "limited", quantity: USAGE_LIMITED_METERS[meter].defaultQuantity.toString() },
      used: used.toString(),
    };
  });
}

/**
 * The first of `meters` whose limit the owner has used up. Work is admitted while usage is below
 * the limit, so work already running can carry usage past it.
 */
export function exhaustedUsageLimit(
  limits: UsageLimits,
  meters: readonly UsageLimitedMeter[],
): ExhaustedUsageLimit | null {
  return (
    limits.limits.find(
      (status): status is ExhaustedUsageLimit =>
        meters.includes(status.meter) &&
        status.limit.kind === "limited" &&
        BigInt(status.used) >= BigInt(status.limit.quantity),
    ) ?? null
  );
}

/**
 * The limits that recording `measurements` on top of `statuses` uses up, with usage after them. A
 * limit used up already is not reached again, even when an administrator lowers it below usage.
 */
export function usageLimitsReachedBy(
  statuses: readonly UsageLimitStatus[],
  measurements: readonly { meter: string; quantity: number }[],
): ExhaustedUsageLimit[] {
  return statuses.flatMap((status) => {
    const measurement = measurements.find(({ meter }) => meter === status.meter);
    if (!measurement || status.limit.kind !== "limited") {
      return [];
    }
    const limit = BigInt(status.limit.quantity);
    const before = BigInt(status.used);
    const after = before + BigInt(measurement.quantity);
    return before < limit && after >= limit
      ? [{ ...status, limit: status.limit, used: after.toString() }]
      : [];
  });
}

/**
 * Reads an administrator's limit: `default`, `unlimited`, or an amount in the meter's display
 * unit, such as 25 or 2.50 USD.
 */
export function parseUsageLimitSetting(meter: UsageLimitedMeter, text: string): UsageLimitSetting {
  const value = text.trim().toLowerCase();
  if (value === "default" || value === "unlimited") {
    return { kind: value };
  }
  const { displayUnit, perDisplayUnit } = USAGE_LIMITED_METERS[meter];
  const fractionDigits = perDisplayUnit.toString().length - 1;
  const amount = new RegExp(`^(\\d+)(?:\\.(\\d{1,${fractionDigits}}))?$`, "u").exec(value);
  if (!amount) {
    throw new Error(
      `The ${meter} limit must be default, unlimited, or an amount of ${displayUnit} with at most ${fractionDigits} decimals, such as 25.`,
    );
  }
  const [, whole, fraction = ""] = amount;
  return {
    kind: "limited",
    quantity: (
      BigInt(whole) * perDisplayUnit +
      BigInt(fraction.padEnd(fractionDigits, "0"))
    ).toString(),
  };
}

/** Formats a quantity of a limited meter in its display unit, such as $10.00. */
export function formatUsageQuantity(meter: UsageLimitedMeter, quantity: string): string {
  return USAGE_LIMITED_METERS[meter].format(quantity);
}

export function formatUsageLimit(meter: UsageLimitedMeter, limit: UsageLimit): string {
  return limit.kind === "unlimited" ? "Unlimited" : formatUsageQuantity(meter, limit.quantity);
}

/** The first instant of the UTC month after `period`, when its limits start over. */
export function usageLimitResetAt(period: string): Date {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1));
}

/** Why work was refused, for whoever started it: a person, an automation, or an agent. */
export function usageLimitExhaustedMessage(
  owner: "org" | "user",
  period: string,
  status: ExhaustedUsageLimit,
): string {
  const ownerName = owner === "org" ? "This organization" : "This personal account";
  const resetsOn = usageLimitResetAt(period).toISOString().slice(0, 10);
  return `${ownerName} has used ${formatUsageQuantity(status.meter, status.used)} of its ${formatUsageQuantity(status.meter, status.limit.quantity)} monthly ${status.meter} limit. It resets on ${resetsOn} (UTC); an administrator can raise it.`;
}
