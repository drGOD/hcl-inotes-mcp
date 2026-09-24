import { fromDominoDateTime } from "./dates.js";

export type ColumnValue = {
  column: number;
  name?: string;
  type: "text" | "number" | "datetime";
  value: string;
};

export type ViewEntry = {
  unid: string;
  noteId?: string;
  position?: string;
  unread: boolean;
  columns: ColumnValue[];
};

export type ViewEntries = {
  recognized: boolean;
  total?: number;
  entries: ViewEntry[];
};

export type MailMessageSummary = {
  unid: string;
  noteId?: string;
  position?: string;
  unread: boolean;
  from?: string;
  subject?: string;
  date?: string;
  size?: number;
};

export type MailList = {
  folder: string;
  start: number;
  total?: number;
  messages: MailMessageSummary[];
};

export type Contact = {
  unid: string;
  name?: string;
  email?: string;
  company?: string;
  fields: Record<string, string>;
};

export type CalendarEvent = {
  unid: string;
  noteId?: string;
  subject?: string;
  start?: string;
  end?: string;
  location?: string;
};

export type MessageContent = {
  unid?: string;
  subject?: string;
  from?: string;
  to: string[];
  cc: string[];
  date?: string;
  encrypted: boolean;
  bodyAvailable: boolean;
  body?: string;
  hint?: string;
};

export type EventDetails = MessageContent & {
  location?: string;
  start?: string;
  end?: string;
  appointmentType?: string;
};

export type FolderInfo = {
  label: string;
  viewName: string;
  level: number;
  dropTarget: boolean;
};

export type HtmlForm = {
  action: string;
  fields: Record<string, string>;
};

export type LoginForm = {
  action: string;
  usernameField: string;
  passwordField: string;
  redirectField?: string;
  fields: Record<string, string>;
};

export type ComposeResult = {
  accepted: boolean;
  httpStatus: number;
  message: string;
};

const ENCRYPTION_NOTICE = [
  /this message is encrypted/i,
  /the message is encrypted/i,
  /document is encrypted/i,
  /encrypted and cannot be displayed/i,
  /cannot be read because it is encrypted/i,
  /enter (?:your |the )?notes id password/i,
  /password for your notes id/i,
  /notes id file/i,
  /unlock your notes id/i,
  /сообщение зашифровано/i,
  /документ зашифрован/i,
  /введите пароль (?:файла )?notes id/i,
  /пароль файла id/i,
];

const ENCRYPTION_FLAGS = ["Encrypt", "IsEncrypted", "h_IsEncrypted", "s_IsEncrypted", "Encrypted"];

const UNLOCK_HINT =
  "Письмо зашифровано (Notes или S/MIME), и веб-сессия не вернула текст. Откройте его в iNotes и введите пароль файла Notes ID — как в браузере, когда ID ещё не разблокирован. После разблокировки ID в этой же сессии прочитайте письмо снова: сервер отдаст тело обычным ответом. Подбор ключей и обход шифрования не выполняются. This message is encrypted and the web session did not return the body. Unlock your Notes ID in iNotes, then read the message again.";

export function parseViewEntries(payload: string): ViewEntries {
  const trimmed = payload.trim();
  if (!trimmed) return { recognized: false, entries: [] };
  if (trimmed.startsWith("<") || /<viewentr/i.test(trimmed)) {
    const xml = parseViewEntriesXml(trimmed);
    if (xml.recognized) return xml;
  }
  const jsonText = extractJsonValue(trimmed);
  if (jsonText) {
    try {
      const parsed = parseViewEntriesJson(JSON.parse(jsonText));
      if (parsed.recognized) return parsed;
    } catch {
      return { recognized: false, entries: [] };
    }
  }
  return { recognized: false, entries: [] };
}

const DATE_COLUMN_NAMES = ["$70", "$62", "$146", "PostedDate", "DeliveredDate"];
const SIZE_COLUMN_NAMES = new Set(["$106", "size"]);

export function dateColumnNumber(entries: ViewEntry[]): number | undefined {
  for (const name of DATE_COLUMN_NAMES) {
    for (const entry of entries) {
      const column = entry.columns.find((item) => item.name?.toLowerCase() === name.toLowerCase());
      if (column && Number.isFinite(column.column)) return column.column;
    }
  }
  for (const entry of entries) {
    const dated = entry.columns.find(
      (item) => item.type === "datetime" && !SIZE_COLUMN_NAMES.has((item.name ?? "").toLowerCase()) && Number.isFinite(item.column),
    );
    if (dated) return dated.column;
  }
  return undefined;
}

export function toMailList(folder: string, start: number, view: ViewEntries): MailList {
  return {
    folder,
    start,
    total: view.total,
    messages: view.entries.filter((entry) => entry.unid).map((entry) => ({
      unid: entry.unid,
      noteId: entry.noteId,
      position: entry.position,
      unread: entry.unread,
      from: columnByName(entry, ["$93", "$98", "From", "$23", "$82"]),
      subject: columnByName(entry, ["$73", "Subject", "$65"]),
      date: normalizeMaybeDate(columnByName(entry, ["$70", "$62", "$146", "PostedDate", "DeliveredDate"])),
      size: toSize(columnByName(entry, ["$106", "Size"])),
    })),
  };
}

export function toContacts(view: ViewEntries): Contact[] {
  return view.entries.filter((entry) => entry.unid).map((entry) => {
    const fields: Record<string, string> = {};
    for (const column of entry.columns) {
      if (!column.value) continue;
      fields[column.name || `column${column.column}`] = column.value;
    }
    const values = entry.columns.map((column) => column.value).filter(Boolean);
    const email = values.find((value) => /^[^\s@]+@[^\s@]+$/.test(value));
    const name = columnByName(entry, ["FullName", "$23", "$26", "LastName"]) ?? values.find((value) => value !== email);
    const company = columnByName(entry, ["CompanyName", "Company", "$27"]);
    return { unid: entry.unid, name, email, company, fields };
  });
}

export function toEvents(view: ViewEntries): CalendarEvent[] {
  return view.entries.filter((entry) => entry.unid).map((entry) => {
    const extra = parseUserData(columnByName(entry, ["$UserData"]));
    const datetimes = entry.columns
      .filter((column) => column.type === "datetime")
      .map((column) => fromDominoDateTime(column.value));
    return {
      unid: entry.unid,
      noteId: entry.noteId,
      subject: columnByName(entry, ["$73", "Subject", "$147"]) ?? extra.Subject,
      start: normalizeMaybeDate(columnByName(entry, ["StartDateTime", "$144"])) ?? normalizeMaybeDate(extra.StartDateTime) ?? datetimes[0],
      end: normalizeMaybeDate(columnByName(entry, ["EndDateTime", "$145"])) ?? normalizeMaybeDate(extra.EndDateTime) ?? datetimes[1],
      location: columnByName(entry, ["Location", "Room"]) ?? extra.Location,
    };
  });
}

export function parseOutline(payload: string): FolderInfo[] {
  for (const value of extractObjects(payload)) {
    const outline = value.outline;
    if (!Array.isArray(outline)) continue;
    const folders: FolderInfo[] = [];
    for (const row of outline) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const label = String(row[2] ?? "").trim();
      const url = String(row[4] ?? "");
      const viewName = viewNameFromOutlineUrl(url);
      if (!label || !viewName) continue;
      const level = Number(row[1]);
      folders.push({
        label,
        viewName,
        level: Number.isFinite(level) ? level : 0,
        dropTarget: Number(row[5] ?? 0) > 0,
      });
    }
    if (folders.length > 0) return folders;
  }
  return [];
}

export function parseJsVars(source: string): Record<string, unknown> {
  let best: Record<string, unknown> | undefined;
  let bestScore = 0;
  for (const value of extractObjects(source)) {
    const score = ["Subject", "From", "Body", "Form", "Encrypt", "SendTo", "StartDateTime"].reduce(
      (count, key) => count + (key in value ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      best = value;
      bestScore = score;
    }
  }
  if (best && bestScore > 0) return best;
  return extractLoosePairs(source);
}

export function interpretMessage(input: { unid?: string; fields?: Record<string, unknown>; bodyHtml?: string }): MessageContent {
  const fields = input.fields ?? {};
  const htmlText = readableHtmlText(input.bodyHtml);
  const fieldBody = fieldString(fields, "Body") ?? fieldString(fields, "body") ?? "";
  const encrypted = encryptionFlag(fields) || looksLikeEncryptionNotice(fieldBody) || looksLikeEncryptionNotice(htmlText);
  const body = chooseBody(fieldBody, htmlText);
  const content: MessageContent = {
    unid: input.unid,
    subject: fieldString(fields, "Subject"),
    from: fieldString(fields, "From") ?? fieldString(fields, "INetFrom"),
    to: splitAddresses(fieldString(fields, "SendTo")),
    cc: splitAddresses(fieldString(fields, "CopyTo")),
    date: fieldString(fields, "PostedDate") ?? fieldString(fields, "DeliveredDate"),
    encrypted,
    bodyAvailable: body.length > 0,
  };
  if (body) content.body = body.length > 100_000 ? `${body.slice(0, 100_000)}…` : body;
  if (encrypted && !content.bodyAvailable) content.hint = UNLOCK_HINT;
  return content;
}

export function interpretEvent(input: { unid?: string; fields?: Record<string, unknown>; bodyHtml?: string }): EventDetails {
  const fields = input.fields ?? {};
  return {
    ...interpretMessage(input),
    location: fieldString(fields, "Location") ?? fieldString(fields, "Room"),
    start: fieldString(fields, "StartDateTime") ?? fieldString(fields, "StartDate"),
    end: fieldString(fields, "EndDateTime") ?? fieldString(fields, "EndDate"),
    appointmentType: fieldString(fields, "AppointmentType"),
  };
}

export function isLoginPage(html: string): boolean {
  return /<form\b/i.test(html) && /names\.nsf\?login/i.test(html) && /name=["']Username["']/i.test(html) && /name=["']Password["']/i.test(html);
}

export function parseLoginForm(html: string): LoginForm | undefined {
  const form = parseForms(html).find((candidate) => /names\.nsf\?login/i.test(candidate.action));
  if (!form) return undefined;
  const usernameField = Object.keys(form.fields).find((name) => name.toLowerCase() === "username");
  const passwordField = Object.keys(form.fields).find((name) => name.toLowerCase() === "password");
  if (!usernameField || !passwordField) return undefined;
  const redirectField = Object.keys(form.fields).find((name) => name.toLowerCase() === "redirectto");
  return { action: form.action, usernameField, passwordField, redirectField, fields: form.fields };
}

export function parseComposeForm(html: string): HtmlForm | undefined {
  const forms = parseForms(html);
  return (
    forms.find((form) => "%%Nonce" in form.fields || "h_EditAction" in form.fields || "SendTo" in form.fields || "Subject" in form.fields) ??
    forms.find((form) => !/names\.nsf\?login/i.test(form.action))
  );
}

export function extractNonce(html: string): string | undefined {
  const named =
    html.match(/name=["']%%Nonce["'][^>]*value=["']([^"']*)["']/i) ??
    html.match(/value=["']([^"']*)["'][^>]*name=["']%%Nonce["']/i);
  if (named?.[1]) return decodeHtml(named[1]);
  const fromCookie = html.match(/(?:^|[&?])N:([^&"'<\s]+)/);
  return fromCookie?.[1];
}

const SEND_ACCEPTED = /setTimeout\(\s*(?:function\s*\(\)\s*\{\s*)?DhU\.onDatasetComplete\b/;

export function interpretComposeResponse(status: number, text: string): ComposeResult {
  const summary = summarizeServerText(text);
  if (isLoginPage(text)) {
    return { accepted: false, httpStatus: status, message: "Сервер вернул страницу входа." };
  }
  if (status >= 400 || /unknown command/i.test(text) || /<title>[^<]*error[^<]*<\/title>/i.test(text)) {
    return { accepted: false, httpStatus: status, message: summary || `HTTP ${status}` };
  }
  const jsonError = text.match(/"(?:errorMessage|errorText|errMsg|sErrorProblem|sErrorStatus)"\s*:\s*"([^"]+)"/i);
  if (jsonError?.[1]) return { accepted: false, httpStatus: status, message: decodeHtml(jsonError[1]) };
  if (!SEND_ACCEPTED.test(text)) {
    return {
      accepted: false,
      httpStatus: status,
      message: summary
        ? `iNotes не подтвердил отправку. ${summary}`
        : "iNotes не подтвердил отправку: в ответе нет DhU.onDatasetComplete.",
    };
  }
  const unid = text.match(/\bsUnid\s*=\s*['"]([0-9A-Fa-f]{32})['"]/i)?.[1]?.toUpperCase();
  return {
    accepted: true,
    httpStatus: status,
    message: unid
      ? `iNotes принял письмо (${unid}). Это не квитанция о доставке.`
      : "iNotes принял письмо (ответ с onDatasetComplete). Это не квитанция о доставке.",
  };
}

export function summarizeServerText(text: string, limit = 240): string {
  const plain = htmlToText(text).replace(/\s+/g, " ").trim();
  const redacted = plain
    .replace(/DomAuthSessId=[^;\s]+/gi, "DomAuthSessId=***")
    .replace(/LtpaToken2?=[^;\s]+/gi, "LtpaToken=***");
  if (!redacted) return "";
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

export function htmlToText(html: string): string {
  const withoutCode = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const withBreaks = withoutCode.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "");
  return decodeHtml(withBreaks).replace(/\n{3,}/g, "\n\n").trim();
}

function parseViewEntriesXml(xml: string): ViewEntries {
  if (!/<viewentries\b/i.test(xml) && !/<viewentry\b/i.test(xml)) return { recognized: false, entries: [] };
  const totalMatch = xml.match(/<viewentries\b[^>]*\btoplevelentries=["']([^"']+)["']/i);
  const entries: ViewEntry[] = [];
  const entryRe = /<viewentry\b([^>]*)>([\s\S]*?)<\/viewentry>/gi;
  for (const match of xml.matchAll(entryRe)) {
    entries.push(viewEntryFromXml(match[1] ?? "", match[2] ?? ""));
  }
  return {
    recognized: true,
    total: totalMatch?.[1] != null ? Number(totalMatch[1]) : undefined,
    entries,
  };
}

function viewEntryFromXml(attrText: string, body: string): ViewEntry {
  const attrs = parseAttrs(attrText);
  const columns: ColumnValue[] = [];
  const dataRe = /<entrydata\b([^>]*)>([\s\S]*?)<\/entrydata>/gi;
  let index = 0;
  for (const match of body.matchAll(dataRe)) {
    const dataAttrs = parseAttrs(match[1] ?? "");
    const inner = match[2] ?? "";
    const typed = typedXmlValue(inner);
    if (!typed) continue;
    columns.push({
      column: dataAttrs.columnnumber != null ? Number(dataAttrs.columnnumber) : index,
      name: dataAttrs.name,
      type: typed.type,
      value: typed.value,
    });
    index += 1;
  }
  return {
    unid: (attrs.unid ?? "").toUpperCase(),
    noteId: attrs.noteid,
    position: attrs.position,
    unread: attrs.unread === "true" || attrs.read === "false",
    columns,
  };
}

function typedXmlValue(inner: string): { type: ColumnValue["type"]; value: string } | undefined {
  const datetime = inner.match(/<datetime>([\s\S]*?)<\/datetime>/i);
  if (datetime?.[1]) return { type: "datetime", value: decodeHtml(datetime[1].trim()) };
  const number = inner.match(/<number>([\s\S]*?)<\/number>/i);
  if (number?.[1]) return { type: "number", value: decodeHtml(number[1].trim()) };
  const texts = [...inner.matchAll(/<text>([\s\S]*?)<\/text>/gi)].map((match) => decodeHtml((match[1] ?? "").trim()));
  if (texts.length > 0) return { type: "text", value: texts.filter(Boolean).join(", ") };
  return undefined;
}

function parseViewEntriesJson(data: unknown): ViewEntries {
  if (!data || typeof data !== "object") return { recognized: false, entries: [] };
  const root = data as Record<string, unknown>;
  if (!("viewentry" in root) && !("@toplevelentries" in root)) return { recognized: false, entries: [] };
  const rawEntries = root.viewentry == null ? [] : Array.isArray(root.viewentry) ? root.viewentry : [root.viewentry];
  const entries = rawEntries.map((item, index) => viewEntryFromJson(item, index)).filter((entry): entry is ViewEntry => entry != null);
  const totalRaw = root["@toplevelentries"];
  const total = typeof totalRaw === "string" || typeof totalRaw === "number" ? Number(totalRaw) : undefined;
  return { recognized: true, total: Number.isFinite(total) ? total : undefined, entries };
}

function viewEntryFromJson(item: unknown, index: number): ViewEntry | undefined {
  if (!item || typeof item !== "object") return undefined;
  const rec = item as Record<string, unknown>;
  const rawData = rec.entrydata == null ? [] : Array.isArray(rec.entrydata) ? rec.entrydata : [rec.entrydata];
  const columns = rawData
    .map((column, columnIndex) => columnFromJson(column, columnIndex))
    .filter((column): column is ColumnValue => column != null);
  return {
    unid: stringAttr(rec["@unid"]).toUpperCase(),
    noteId: stringAttr(rec["@noteid"]) || undefined,
    position: stringAttr(rec["@position"]) || undefined,
    unread: stringAttr(rec["@unread"]).toLowerCase() === "true" || stringAttr(rec["@read"]).toLowerCase() === "false",
    columns,
  };
}

function columnFromJson(item: unknown, index: number): ColumnValue | undefined {
  if (!item || typeof item !== "object") return undefined;
  const rec = item as Record<string, unknown>;
  const typed = firstTyped(rec);
  if (!typed) return undefined;
  const columnNumber = Number(rec["@columnnumber"]);
  return {
    column: Number.isFinite(columnNumber) ? columnNumber : index,
    name: typeof rec["@name"] === "string" ? rec["@name"] : undefined,
    type: typed.type,
    value: typed.value,
  };
}

function firstTyped(rec: Record<string, unknown>): { type: ColumnValue["type"]; value: string } | undefined {
  if ("datetime" in rec) return { type: "datetime", value: flattenText(rec.datetime) };
  if ("number" in rec) return { type: "number", value: flattenText(rec.number) };
  if ("text" in rec) return { type: "text", value: flattenText(rec.text) };
  if ("textlist" in rec) return { type: "text", value: flattenText(rec.textlist) };
  return undefined;
}

function flattenText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => flattenText(item)).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if ("text" in rec) return flattenText(rec.text);
    return Object.keys(rec)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => flattenText(rec[key]))
      .filter(Boolean)
      .join(", ");
  }
  return "";
}

function columnByName(entry: ViewEntry, names: string[]): string | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const found = entry.columns.find((column) => column.name && wanted.has(column.name.toLowerCase()) && column.value);
  return found?.value;
}

function parseUserData(value: string | undefined): Record<string, string> {
  if (!value || !value.includes("=")) return {};
  const out: Record<string, string> = {};
  for (const part of value.split(/\^|\|/)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) && val) out[key] = val;
  }
  return out;
}

function normalizeMaybeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^\d{8}T\d{6}/.test(value) ? fromDominoDateTime(value) : value;
}

function toSize(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function viewNameFromOutlineUrl(url: string): string | undefined {
  const match = url.match(/s_ViewName;([^,&]+)/i);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function extractObjects(source: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const limited = source.length > 1_500_000 ? source.slice(0, 1_500_000) : source;
  for (let i = 0; i < limited.length; i += 1) {
    if (limited[i] !== "{") continue;
    const end = findMatching(limited, i);
    if (end < 0) continue;
    const slice = limited.slice(i, end + 1);
    if (slice.length > 400_000) {
      i = end;
      continue;
    }
    try {
      const value = JSON.parse(slice) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        results.push(value as Record<string, unknown>);
        i = end;
      }
    } catch {
      // Keep scanning. Domino pages mix markup with JSON objects.
    }
  }
  return results;
}

function extractJsonValue(source: string): string | undefined {
  const start = source.indexOf("{");
  if (start < 0) return undefined;
  const end = findMatching(source, start);
  if (end < 0) return undefined;
  return source.slice(start, end + 1);
}

function findMatching(source: string, start: number): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractLoosePairs(source: string): Record<string, string> {
  const keys = ["Form", "Subject", "From", "SendTo", "CopyTo", "Body", "Encrypt", "PostedDate", "Location", "StartDateTime", "EndDateTime"];
  const out: Record<string, string> = {};
  for (const key of keys) {
    const match = source.match(new RegExp(`["']?${key}["']?\\s*[:=]\\s*"((?:\\\\.|[^"\\\\])*)"`, "i"));
    if (!match?.[1]) continue;
    try {
      out[key] = JSON.parse(`"${match[1]}"`) as string;
    } catch {
      out[key] = match[1];
    }
  }
  return out;
}

function encryptionFlag(fields: Record<string, unknown>): boolean {
  for (const key of ENCRYPTION_FLAGS) {
    if (truthyFlag(fields[key])) return true;
  }
  return "$Seal" in fields || "$SealData" in fields;
}

function truthyFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return false;
  return /^(1|true|yes)$/i.test(value.trim());
}

function looksLikeEncryptionNotice(text: string): boolean {
  if (!text) return false;
  const sample = text.slice(0, 2000);
  return ENCRYPTION_NOTICE.some((pattern) => pattern.test(sample));
}

function chooseBody(fieldBody: string, htmlText: string): string {
  if (fieldBody.trim() && !looksLikeEncryptionNotice(fieldBody)) return fieldBody.trim();
  if (htmlText.trim() && !looksLikeEncryptionNotice(htmlText)) return htmlText.trim();
  return "";
}

function readableHtmlText(html: string | undefined): string {
  if (!html || isApplicationShell(html)) return "";
  return htmlToText(extractMailBodyHtml(html));
}

function isApplicationShell(html: string): boolean {
  return /<html[\s>]/i.test(html) && html.length > 4000 && /h_PageUI|com_ibm_dwa|l_GetOutline_JSON/i.test(html);
}

function extractMailBodyHtml(html: string): string {
  const marked =
    html.match(/<div[^>]+id=["']messageBody["'][^>]*>([\s\S]*?)<\/div>/i) ??
    html.match(/<div[^>]+class=["'][^"']*memo-body[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  return marked?.[1] ?? html;
}

function fieldString(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const joined = value.map((item) => (typeof item === "string" ? item : "")).filter(Boolean).join(", ");
    return joined || undefined;
  }
  return undefined;
}

function splitAddresses(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const trimmed = value.trim();
  if (trimmed.includes(";")) return trimmed.split(";").map((part) => part.trim()).filter(Boolean);
  const atSigns = trimmed.match(/@/g)?.length ?? 0;
  if (atSigns > 1) return trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  return [trimmed];
}

function parseForms(html: string): HtmlForm[] {
  const forms: HtmlForm[] = [];
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  for (const match of html.matchAll(formRe)) {
    forms.push({ action: attr(match[1] ?? "", "action") ?? "", fields: fieldsFromForm(match[2] ?? "") });
  }
  return forms;
}

function fieldsFromForm(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of body.matchAll(/<input\b([^>]*)>/gi)) {
    const tag = match[1] ?? "";
    const name = attr(tag, "name");
    if (!name) continue;
    const type = (attr(tag, "type") ?? "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "image" || type === "file") continue;
    if ((type === "checkbox" || type === "radio") && !/\bchecked\b/i.test(tag)) continue;
    fields[name] = attr(tag, "value") ?? "";
  }
  for (const match of body.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const name = attr(match[1] ?? "", "name");
    if (!name) continue;
    fields[name] = decodeHtml(match[2] ?? "");
  }
  return fields;
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const key = (match[1] ?? "").toLowerCase();
    if (!key) continue;
    attrs[key] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  if (!match) return undefined;
  return decodeHtml(match[1] ?? match[2] ?? match[3] ?? "");
}

function stringAttr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function decodeHtml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return named[entity.toLowerCase()] ?? all;
  });
}
