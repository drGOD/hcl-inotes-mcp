/** Domino view keys look like 20100928T040000Z. */
export function toDominoKey(iso: string): string {
  return `${formatUtc(requireDate(iso))}Z`;
}

/** Notes datetime items often use 20260924T100000,00Z. */
export function toDominoDateTime(iso: string): string {
  return `${formatUtc(requireDate(iso))},00Z`;
}

export function toDatePart(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Некорректная дата: ${iso}`);
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  return `${y}-${m}-${d}`;
}

export function toTimePart(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Некорректная дата: ${iso}`);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export function fromDominoDateTime(value: string): string {
  const match = value.trim().match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:,\d+)?(Z|[+-]\d{2}:?\d{0,2})?$/);
  if (!match) return value;
  const [, year, month, day, hour, minute, second, zone] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${normalizeZone(zone)}`;
}

function requireDate(iso: string): Date {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Некорректная дата: ${iso}`);
  return date;
}

function formatUtc(date: Date): string {
  const stamp = [date.getUTCFullYear(), pad(date.getUTCMonth() + 1), pad(date.getUTCDate())].join("");
  const time = [pad(date.getUTCHours()), pad(date.getUTCMinutes()), pad(date.getUTCSeconds())].join("");
  return `${stamp}T${time}`;
}

function normalizeZone(zone: string | undefined): string {
  if (!zone || zone === "Z") return "Z";
  const match = zone.match(/^([+-])(\d{2}):?(\d{2})?$/);
  if (!match) return "Z";
  return `${match[1]}${match[2]}:${match[3] ?? "00"}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
