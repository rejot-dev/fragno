/** The coarse distance between `value` and `now`, such as `4h ago` or `in 12m`. */
export function formatRelativeTime(value: string | Date, now: number): string {
  const distance = new Date(value).getTime() - now;
  const minutes = Math.floor(Math.abs(distance) / 60_000);
  if (minutes < 1) {
    return "now";
  }
  const amount =
    minutes < 60
      ? `${minutes}m`
      : minutes < 24 * 60
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / (24 * 60))}d`;
  return distance > 0 ? `in ${amount}` : `${amount} ago`;
}
