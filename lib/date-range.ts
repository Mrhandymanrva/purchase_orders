// Richmond calendar dates, independent of the browser's time zone and DST.
export function previousWeekRange(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)!.value);
  const sunday = new Date(
    Date.UTC(part("year"), part("month") - 1, part("day")),
  );
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay() - 7);
  const saturday = new Date(sunday);
  saturday.setUTCDate(saturday.getUTCDate() + 6);
  return {
    from: sunday.toISOString().slice(0, 10),
    to: saturday.toISOString().slice(0, 10),
  };
}
