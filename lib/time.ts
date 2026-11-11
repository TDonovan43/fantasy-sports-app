/**
 * Kickoffs are stored as Eastern wall-clock strings ("2026-11-15T13:00:00"). This converts one to a
 * real instant, honouring daylight saving time (EDT in September/October, EST after early November).
 */
export function easternToUtcMs(wallClock: string | null | undefined): number | null {
  if (!wallClock) return null;
  const asIfUtc = Date.parse(`${wallClock.slice(0, 19)}Z`);
  if (Number.isNaN(asIfUtc)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(asIfUtc));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // What New York's clock reads at that instant, read back as if it were UTC.
  const nyAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  // The difference is New York's offset; shift the wall-clock reading by it.
  return asIfUtc + (asIfUtc - nyAsUtc);
}
