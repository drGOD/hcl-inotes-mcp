/**
 * Build an iNotes / Domino command URL.
 * PresetFields keeps the comma and semicolon separators Domino expects.
 * Values that themselves contain those characters are percent-encoded first.
 */
export function presetFields(pairs: Array<[string, string]>): string {
  return pairs.map(([key, value]) => `${key};${encodePresetValue(value)}`).join(",");
}

export function inotesCommandUrl(
  baseUrl: string,
  mailPath: string,
  suffix: string,
  command: string,
  params: Record<string, string>,
): URL {
  const origin = new URL(baseUrl).origin;
  const prefix = mailPath.replace(/\/+$/, "");
  const tail = suffix.replace(/^\/+/, "");
  const path = [prefix, tail].filter(Boolean).join("/");
  const pathname = path.split("/").map((segment, index) => (index === 0 ? segment : encodePathSegment(segment))).join("/");
  const query = [
    command,
    ...Object.entries(params).map(([key, value]) => `${encodeQueryKey(key)}=${encodeQueryValue(value)}`),
  ].join("&");
  return new URL(`${origin}${pathname.startsWith("/") ? pathname : `/${pathname}`}?${query}`);
}

export function assertUnid(unid: string): string {
  const value = unid.trim().toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(value)) {
    throw new Error("UNID должен состоять из 32 шестнадцатеричных символов.");
  }
  return value;
}

export function assertFolderName(folder: string): string {
  const value = folder.trim();
  if (!value || value.includes("..") || /[\\/?#&%]/.test(value) || !/^[\p{L}\p{N}$()_.\- ]+$/u.test(value)) {
    throw new Error("Некорректное имя папки или представления.");
  }
  return value;
}

function encodePresetValue(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/,/g, "%2C")
    .replace(/;/g, "%3B")
    .replace(/&/g, "%26")
    .replace(/\s/g, "%20");
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function encodeQueryKey(key: string): string {
  return encodeURIComponent(key);
}

function encodeQueryValue(value: string): string {
  return value.replace(/[&=#+?\s]/g, (ch) => encodeURIComponent(ch));
}
