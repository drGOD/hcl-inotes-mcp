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

const WEEKDAYS_RU = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"] as const;
/** Notes zone label iNotes accepted for a UTC+3 appointment. */
const UTC_PLUS_3_ZONE = "Z=-3$DO=0$ZN=Arab/E. Africa/Russian";

export type InotesAppointmentClock = {
  zone: string;
  zoneLabel: string;
  start: string;
  end: string;
  intDate: string;
  intEndDate: string;
  intTime: string;
  intEndTime: string;
  intDur: string;
};

/** Wall-clock stamps in the shape the appointment UI posts, including the Notes zone suffix. */
export function inotesAppointmentClock(startIso: string, endIso: string, formZone = ""): InotesAppointmentClock {
  const start = wall(startIso);
  const end = wall(endIso);
  const zone = notesZone(startIso, formZone);
  return {
    zone,
    zoneLabel: zone.match(/\$ZN=(.*)$/)?.[1] ?? "",
    start: `${start.stamp}$${zone}`,
    end: `${end.stamp}$${zone}`,
    intDate: `${start.weekday} ${start.mdy}`,
    intEndDate: `${end.weekday} ${end.mdy}`,
    intTime: start.hm,
    intEndTime: end.hm,
    intDur: durationLabel(startIso, endIso),
  };
}

function notesZone(iso: string, formZone: string): string {
  if (/^Z=-?\d+\$DO=/.test(formZone)) return formZone;
  if (offsetMinutes(iso) === 180) return UTC_PLUS_3_ZONE;
  const hours = -offsetMinutes(iso) / 60;
  const whole = Number.isInteger(hours) ? String(hours) : String(-offsetMinutes(iso) / 60);
  return `Z=${whole}$DO=0`;
}

function offsetMinutes(iso: string): number {
  const match = iso.match(/([+-])(\d{2}):?(\d{2})?$/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? "0"));
}

function wall(iso: string): { stamp: string; weekday: string; mdy: string; hm: string } {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) throw new Error(`Некорректная дата: ${iso}`);
  const [, year, month, day, hour, minute, second = "00"] = match;
  const weekday = WEEKDAYS_RU[new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()] ?? "";
  return {
    stamp: `${year}${month}${day}T${hour}${minute}${second}`,
    weekday,
    mdy: `${month}.${day}.${year}`,
    hm: `${hour}:${minute}`,
  };
}

function durationLabel(startIso: string, endIso: string): string {
  const minutes = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000));
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${pad(minutes % 60)}m`;
}
