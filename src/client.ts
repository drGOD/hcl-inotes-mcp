import { CookieJar } from "./cookies.js";
import type { InotesConfig } from "./config.js";
import { fromDominoDateTime, inotesAppointmentClock, toDominoKey } from "./dates.js";
import {
  extractNonce,
  htmlToText,
  internetAddress,
  interpretComposeResponse,
  parseDominoItems,
  replySubject,
  interpretEvent,
  interpretMessage,
  isLoginPage,
  parseComposeForm,
  parseJsVars,
  parseLoginForm,
  parseOutline,
  dateColumnNumber,
  parseViewEntries,
  summarizeServerText,
  toContacts,
  toEvents,
  toMailList,
  type ComposeResult,
  type Contact,
  type CalendarEvent,
  type EventDetails,
  type FolderInfo,
  type MailList,
  type MessageContent,
} from "./parse.js";
import { assertFolderName, assertUnid, inotesCommandUrl, presetFields } from "./urls.js";

export type SendMailInput = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
};

export type ReplyInput = {
  unid: string;
  body: string;
  replyAll?: boolean;
  folder?: string;
  to?: string[];
  subject?: string;
};

export type ForwardInput = {
  unid: string;
  to: string[];
  comment?: string;
  folder?: string;
};

export type CreateEventInput = {
  subject: string;
  start: string;
  end: string;
  body?: string;
  location?: string;
  kind?: "appointment" | "meeting";
  allDay?: boolean;
  attendees?: string[];
  onlineMeetingUrl?: string;
};

type HttpResult = { status: number; url: string; text: string };

type HttpOptions = { userAgent?: string; referer?: string; browserForm?: boolean };

/** iNotes returns the memo form only to a browser user agent. A custom agent gets an empty Haiku shell. */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const DWA_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const DWA_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
const OMITTED_APPOINTMENT_IDS = [
  "s_NewApptUNIDURL",
  "h_SetParentUnid",
  "tmpTargetUNID",
  "tmpTargetAPPTUNID",
  "ApptUNIDURL",
] as const;

export class InotesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InotesError";
  }
}

export class InotesClient {
  private readonly jar = new CookieJar();
  private readonly dateColumnByFolder = new Map<string, number>();
  private sessionReady = false;
  private sessionPromise: Promise<void> | undefined;
  private pageNonce: string | undefined;

  constructor(private readonly config: InotesConfig) {}

  async listFolders(): Promise<FolderInfo[]> {
    const outline = await this.authed(
      "GET",
      this.command("iNotes/Proxy/", "EditDocument", { Form: "l_GetOutline_JSON", charset: "UTF-8" }),
    );
    const folders = parseOutline(outline.text);
    if (folders.length > 0) return folders;

    const fallback = await this.authed(
      "GET",
      this.command("($Folders)", "ReadViewEntries", { OutputFormat: "JSON", Count: "200", Start: "1" }),
    );
    const view = parseViewEntries(fallback.text);
    if (!view.recognized) {
      throw new InotesError(`Не удалось получить список папок. ${summarizeServerText(outline.text) || `HTTP ${outline.status}`}`);
    }
    return view.entries
      .map((entry) => {
        const label = entry.columns.find((column) => column.type === "text" && column.value)?.value;
        return label ? { label, viewName: label, level: 0, dropTarget: true } : undefined;
      })
      .filter((folder): folder is FolderInfo => folder != null);
  }

  async listMessages(options: { folder?: string; start?: number; limit?: number; unreadOnly?: boolean }): Promise<MailList> {
    const folder = assertFolderName(options.folder ?? "($Inbox)");
    const start = positiveInt(options.start, 1);
    const limit = bounded(options.limit, 25, 1, 100);
    const pairs: Array<[string, string]> = [
      ["FolderName", folder],
      ["UnreadCountInfo", "1"],
    ];
    if (options.unreadOnly) pairs.push(["UnreadOnly", "1"]);
    const view = await this.readView(folder, pairs, start, limit, { sortByDate: true });
    return toMailList(folder, start, view);
  }

  async searchMail(options: { query: string; folder?: string; start?: number; limit?: number }): Promise<MailList> {
    const query = options.query.trim();
    if (!query || query.length > 200) throw new InotesError("Запрос поиска должен быть от 1 до 200 символов.");
    const folder = assertFolderName(options.folder ?? "($Inbox)");
    const start = positiveInt(options.start, 1);
    const limit = bounded(options.limit, 25, 1, 100);
    const view = await this.readView(
      folder,
      [
        ["FolderName", folder],
        ["SearchString", query],
      ],
      start,
      limit,
      { sortByDate: true },
    );
    return toMailList(folder, start, view);
  }

  async readMessage(unid: string): Promise<MessageContent> {
    const id = assertUnid(unid);
    const [fieldsRes, bodyRes] = await Promise.all([
      this.authed("GET", this.command(`0/${id}/`, "OpenDocument", { Form: "l_JSVars" })),
      this.authed("GET", this.command(`0/${id}/`, "OpenDocument", { Form: "s_MailMemoReadBodyContent" })),
    ]);
    return interpretMessage({
      unid: id,
      fields: parseJsVars(fieldsRes.text),
      bodyHtml: bodyRes.status < 400 ? bodyRes.text : undefined,
    });
  }

  async sendMail(input: SendMailInput): Promise<ComposeResult> {
    requireText(input.subject, "Тема");
    requireText(input.body, "Текст");
    if (input.to.length === 0) throw new InotesError("Укажите хотя бы одного получателя.");
    const openUrl = this.command("($Drafts)/$new/", "EditDocument", {
      Form: "h_PageUI",
      ui: "dwa_form",
      PresetFields: presetFields([
        ["h_EditAction", "h_New"],
        ["s_NotesForm", "Memo"],
        ["s_ViewName", "($Drafts)"],
      ]),
    });
    return this.submitMemo(openUrl, {
      to: input.to.join(", "),
      cc: (input.cc ?? []).join(", "),
      bcc: (input.bcc ?? []).join(", "),
      subject: input.subject,
      body: normalizeNewlines(input.body),
    });
  }

  async replyMail(input: ReplyInput): Promise<ComposeResult> {
    const id = assertUnid(input.unid);
    assertFolderName(input.folder ?? "($Inbox)");
    requireText(input.body, "Текст ответа");
    const actionType = input.replyAll ? "h_ReplyToAll" : "h_ReplyTo";
    const [itemsRes, bodyRes] = await Promise.all([
      this.authed("GET", this.command(`0/${id}/`, "OpenDocument", { Form: "l_JSVars" })),
      this.authed("GET", this.command(`0/${id}/`, "OpenDocument", { Form: "s_MailMemoReadBodyContent" })),
    ]);
    const items = parseDominoItems(itemsRes.text);
    const parentFrom = internetAddress(items.ReplyTo || items.From || items.INetFrom || "");
    const sendTo = input.to?.length ? input.to.join(", ") : parentFrom;
    if (!sendTo) {
      return { accepted: false, httpStatus: itemsRes.status, message: "Не удалось определить адрес для ответа." };
    }
    const subject = input.subject?.trim() || replySubject(items.Subject ?? "");
    const quoted = bodyRes.status < 400 ? htmlToText(bodyRes.text) : "";
    const body = quoted.trim()
      ? `${normalizeNewlines(input.body)}\r\n\r\n${normalizeNewlines(quoted)}`
      : normalizeNewlines(input.body);
    const messageId = items.x_MessageID ?? "";
    const references = [items.References, messageId].map((part) => part?.trim()).filter(Boolean).join(";");
    const openUrl = this.command("($Drafts)/$new/", "EditDocument", {
      Form: "h_PageUI",
      ui: "dwa_form",
      PresetFields: presetFields([
        ["h_EditAction", "h_New"],
        ["s_NotesForm", "Memo"],
        ["s_ViewName", "($Drafts)"],
        ["s_MailActionType", actionType],
        ["s_MailParentUNID", id],
      ]),
    });
    return this.submitMemo(
      openUrl,
      {
        to: sendTo,
        cc: input.replyAll ? replyAllCopy(items, parentFrom) : "",
        bcc: "",
        subject,
        body,
      },
      {
        h_SetParentUnid: id,
        s_MailParentUNID: id,
        s_MailActionType: actionType,
        In_Reply_To: messageId,
        References: references,
        s_SetReplyFlag: "1",
        s_SetRFSaveInfo: id,
      },
    );
  }

  async forwardMail(input: ForwardInput): Promise<ComposeResult> {
    const id = assertUnid(input.unid);
    const folder = assertFolderName(input.folder ?? "($Inbox)");
    if (input.to.length === 0) throw new InotesError("Укажите получателя пересылки.");
    const url = this.command(`0/${id}/`, "EditDocument", {
      Form: "h_PageUI",
      ui: "dwa_form",
      PresetFields: presetFields([
        ["h_EditAction", "h_Forward"],
        ["s_NotesForm", "Memo"],
        ["s_ViewName", folder],
      ]),
    });
    return this.submitCompose(
      url,
      {
        SendTo: input.to.join(", "),
        Body: normalizeNewlines(input.comment ?? ""),
        s_NotesForm: "Memo",
        s_ViewName: folder,
      },
      { prependBody: true },
    );
  }

  async listContacts(options: { query?: string; start?: number; limit?: number }): Promise<{ view: string; contacts: Contact[] }> {
    const query = options.query?.trim();
    if (query && query.length > 200) throw new InotesError("Запрос поиска контактов должен быть не длиннее 200 символов.");
    const start = positiveInt(options.start, 1);
    const limit = bounded(options.limit, query ? 50 : 50, 1, 100);
    const fetchCount = query ? Math.max(limit, 100) : limit;
    let lastSummary = "";
    for (const viewName of ["($Contacts)", "($People)"]) {
      const pairs: Array<[string, string]> = [["FolderName", viewName]];
      if (query) pairs.push(["SearchString", query]);
      const response = await this.authed("GET", this.viewUrl(pairs, start, fetchCount));
      const parsed = parseViewEntries(response.text);
      if (!parsed.recognized) {
        lastSummary = summarizeServerText(response.text) || `HTTP ${response.status}`;
        continue;
      }
      let contacts = toContacts(parsed);
      if (query) {
        const needle = query.toLowerCase();
        contacts = contacts.filter((contact) => contactHaystack(contact).includes(needle));
      }
      return { view: viewName, contacts: contacts.slice(0, limit) };
    }
    throw new InotesError(
      `Личная адресная книга недоступна через этот почтовый файл. ${lastSummary}`.trim(),
    );
  }

  async listEvents(options: { start: string; end: string; limit?: number }): Promise<CalendarEvent[]> {
    const startKey = toDominoKey(options.start);
    const endKey = toDominoKey(options.end);
    if (new Date(options.end).getTime() < new Date(options.start).getTime()) {
      throw new InotesError("Конец диапазона раньше начала.");
    }
    const limit = bounded(options.limit, 100, 1, 200);
    const response = await this.authed(
      "GET",
      this.command("iNotes/Proxy/", "OpenDocument", {
        Form: "s_ReadViewEntries",
        PresetFields: presetFields([
          ["FolderName", "($Calendar)"],
          ["hc", "$UserData"],
        ]),
        KeyType: "time",
        StartKey: startKey,
        UntilKey: endKey,
        Count: String(limit),
        TZType: "UTC",
        charset: "UTF-8",
      }),
    );
    const parsed = parseViewEntries(response.text);
    if (!parsed.recognized) {
      throw new InotesError(`Календарь не прочитан. ${summarizeServerText(response.text) || `HTTP ${response.status}`}`);
    }
    return toEvents(parsed);
  }

  async readEvent(unid: string, instanceStart?: string): Promise<EventDetails> {
    const id = assertUnid(unid);
    const params: Record<string, string> = { Form: "l_JSVars" };
    if (instanceStart) params.PresetFields = presetFields([["ThisStartDate", toDominoKey(instanceStart)]]);
    const url = this.command(`0/${id}/`, "OpenDocument", params);
    let response = await this.authed("GET", url);
    if (isReloadShell(response.text)) response = await this.authed("GET", url);
    return interpretEvent({ unid: id, fields: eventFields(response.text) });
  }

  async createEvent(input: CreateEventInput): Promise<ComposeResult> {
    requireText(input.subject, "Тема");
    const start = new Date(input.start);
    const end = new Date(input.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new InotesError("Нужны даты начала и окончания в ISO 8601.");
    if (end.getTime() < start.getTime()) throw new InotesError("Окончание события раньше начала.");
    const onlineMeetingUrl = input.onlineMeetingUrl?.trim() ?? "";
    if (onlineMeetingUrl && !/^https?:\/\//i.test(onlineMeetingUrl)) {
      throw new InotesError("Ссылка сетевого собрания должна начинаться с http:// или https://.");
    }
    const appointmentType = input.allDay ? "2" : onlineMeetingUrl || input.kind === "meeting" ? "3" : "0";
    const openUrl = this.command("($Calendar)/$new/", "EditDocument", {
      Form: "h_PageUI",
      ui: "dwa_form",
      PresetFields: presetFields([
        ["h_EditAction", "h_New"],
        ["s_NotesForm", "Appointment"],
      ]),
    });
    return this.submitAppointment(openUrl, {
      subject: input.subject,
      body: input.body ?? "",
      location: input.location ?? "",
      appointmentType,
      start: input.start,
      end: input.end,
      onlineMeetingUrl,
    });
  }

  private async readView(
    folder: string,
    pairs: Array<[string, string]>,
    start: number,
    limit: number,
    options: { sortByDate?: boolean },
  ) {
    const params: Record<string, string> = {
      Form: "s_ReadViewEntries",
      PresetFields: presetFields(pairs),
      Start: String(start),
      Count: String(limit),
      TZType: "UTC",
      charset: "UTF-8",
    };
    if (options.sortByDate) {
      const column = await this.dateColumn(folder, pairs);
      if (column != null) params.resortdescending = String(column);
    }
    const response = await this.authed("GET", this.command("iNotes/Proxy/", "OpenDocument", params));
    const parsed = parseViewEntries(response.text);
    if (!parsed.recognized) {
      throw new InotesError(`Представление ${folder} не прочитано. ${summarizeServerText(response.text) || `HTTP ${response.status}`}`);
    }
    return parsed;
  }

  private async dateColumn(folder: string, pairs: Array<[string, string]>): Promise<number | undefined> {
    const cached = this.dateColumnByFolder.get(folder);
    if (cached != null) return cached;
    const probePairs = pairs.filter(([key]) => key === "FolderName" || key === "UnreadCountInfo");
    const response = await this.authed("GET", this.viewUrl(probePairs.length > 0 ? probePairs : [["FolderName", folder]], 1, 5));
    const parsed = parseViewEntries(response.text);
    if (!parsed.recognized) return undefined;
    const column = dateColumnNumber(parsed.entries);
    if (column != null) this.dateColumnByFolder.set(folder, column);
    return column;
  }

  private viewUrl(pairs: Array<[string, string]>, start: number, limit: number) {
    return this.command("iNotes/Proxy/", "OpenDocument", {
      Form: "s_ReadViewEntries",
      PresetFields: presetFields(pairs),
      Start: String(start),
      Count: String(limit),
      TZType: "UTC",
      charset: "UTF-8",
    });
  }

  private async submitMemo(
    openUrl: URL,
    values: { to: string; cc: string; bcc: string; subject: string; body: string },
    extras: Record<string, string> = {},
  ): Promise<ComposeResult> {
    await this.ensureNonce();
    const browser = { userAgent: BROWSER_USER_AGENT };
    const page = await this.authed("GET", openUrl, undefined, browser);
    const nonce = extractNonce(page.text) ?? this.pageNonce ?? this.jar.nonce();
    const form = parseComposeForm(page.text);
    if (!form || !("SendTo" in form.fields) || !("Body" in form.fields) || !("Subject" in form.fields)) {
      return { accepted: false, httpStatus: page.status, message: "iNotes не отдал форму письма (нет SendTo, Subject или Body)." };
    }
    if (!nonce) {
      return { accepted: false, httpStatus: page.status, message: "iNotes не выдал %%Nonce для отправки." };
    }
    const fields: Record<string, string> = { ...form.fields };
    fields.SendTo = values.to;
    fields.CopyTo = values.cc;
    fields.BlindCopyTo = values.bcc;
    fields.Subject = values.subject;
    fields.Body = encodeMemoHtml(values.body);
    fields.h_Name = values.subject;
    fields.h_EditAction = "h_Next";
    fields.h_SetCommand = "h_ShimmerSendMail";
    fields.MailOptions = "1";
    fields.SaveOptions = "1";
    fields.h_SetSaveDoc = "1";
    fields.h_SetPublishAction = "h_Publish";
    fields.h_SetPublishToFolder = "";
    fields.h_SetEditNextScene = "";
    fields.s_ViewName = "($Drafts)";
    fields.Form = fields.Form || "Memo";
    for (const [key, value] of Object.entries(extras)) fields[key] = value;
    // The memo form defaults to rich text (s_UsePlainText=0). A plain Body
    // with CR/LF is stored as HTML, and the web UI collapses those breaks.
    // The editor writes the same Body field as HTML, with <br> between lines.
    fields.s_UsePlainText = "0";
    fields.s_UsePlainTextAndHTML = "0";
    fields.s_PlainEditor = "0";
    fields["%%Nonce"] = nonce;
    fields["%%PostCharset"] = "UTF-8";
    fields.h_SetReturnURL = "[[./&Form=l_CallListenerWithUnid]]";
    const postUrl = this.command("($Drafts)/$new/", "EditDocument", {
      Form: "h_PageUI",
      ui: "dwa_form",
      PresetFields: presetFields([
        ["h_EditAction", "h_ShimmerEdit"],
        ["s_ViewName", "($Drafts)"],
        ["s_NotesForm", fields.Form],
      ]),
    });
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) params.set(key, value);
    const posted = await this.authed("POST", postUrl, params, browser);
    return interpretComposeResponse(posted.status, posted.text);
  }

  private async submitAppointment(
    openUrl: URL,
    values: {
      subject: string;
      body: string;
      location: string;
      appointmentType: string;
      start: string;
      end: string;
      onlineMeetingUrl: string;
    },
  ): Promise<ComposeResult> {
    await this.ensureNonce();
    const browser = { userAgent: DWA_USER_AGENT };
    const page = await this.authed("GET", openUrl, undefined, browser);
    const nonce = extractNonce(page.text) || this.pageNonce || this.jar.nonce();
    const form = parseComposeForm(page.text);
    if (!form || !("Subject" in form.fields) || !("StartDate" in form.fields)) {
      return { accepted: false, httpStatus: page.status, message: "iNotes не отдал форму события (нет Subject или StartDate)." };
    }
    if (!nonce) {
      return { accepted: false, httpStatus: page.status, message: "iNotes не выдал %%Nonce для сохранения события." };
    }
    const fields: Record<string, string> = { ...form.fields };
    const set = (key: string, value: string) => {
      if (key in fields) fields[key] = value;
    };
    const clock = inotesAppointmentClock(values.start, values.end, fields.StartTimeZone || fields.LocalTimeZone || "");
    const place = values.onlineMeetingUrl || values.location;
    set("Subject", values.subject);
    set("h_Name", values.subject);
    set("$AlarmDescription", values.subject);
    if (values.body) set("Body", values.body);
    set("Location", place);
    fields.AppointmentType = values.appointmentType;
    set("StartDate", clock.start);
    set("EndDate", clock.end);
    set("ThisStartDate", clock.start);
    set("ThisEndDate", clock.end);
    set("ThisInstDate", clock.start);
    set("s_InstDate", clock.start);
    set("StartTimeZone", clock.zone);
    set("EndTimeZone", clock.zone);
    set("LocalTimeZone", clock.zone);
    set("IntDate", clock.intDate);
    set("IntEndDate", clock.intEndDate);
    set("IntTime", clock.intTime);
    set("IntEndTime", clock.intEndTime);
    set("IntDur", clock.intDur);
    if (clock.zoneLabel) {
      set("IntZoneAreaCtl", clock.zoneLabel);
      set("IntEndZoneAreaCtl", clock.zoneLabel);
    }
    set("s_SendNotice", "0");
    for (const key of [
      "RequiredAttendees",
      "OptionalAttendees",
      "FYIAttendees",
      "EnterSendTo",
      "EnterCopyTo",
      "EnterBlindCopyTo",
      "s_NewRequiredAttendees",
      "s_NewOptionalAttendees",
      "s_NewFYIAttendees",
      "s_NewAltRequiredAttendees",
      "s_NewAltOptionalAttendees",
      "s_NewAltFYIAttendees",
      "Resources",
      "RequiredResources",
    ]) {
      set(key, "");
    }
    if (!fields.h_SetCommand) fields.h_SetCommand = "h_ShimmerSave";
    if (!fields.h_SetSaveDoc) fields.h_SetSaveDoc = "1";
    if (!fields.h_SetReturnURL) fields.h_SetReturnURL = "[[./&Form=l_CallListener]]";
    if (!fields.h_EditAction || fields.h_EditAction === "h_New") fields.h_EditAction = "h_Next";
    if (!fields.h_SetPublishAction) fields.h_SetPublishAction = "h_Publish";
    if (!fields["%%PostCharset"]) fields["%%PostCharset"] = "UTF-8";
    fields["%%Nonce"] = nonce;
    for (const key of OMITTED_APPOINTMENT_IDS) delete fields[key];
    const postUrl = this.command("($Calendar)/$new/", "EditDocument", {
      Form: "h_PageUI",
      ui: "dwa_form",
      PresetFields: presetFields([
        ["h_EditAction", "h_New"],
        ["s_NotesForm", "Appointment"],
      ]),
    });
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) params.set(key, value);
    const posted = await this.authed("POST", postUrl, params, {
      ...browser,
      browserForm: true,
      referer: this.mailFrameReferer(),
    });
    return interpretComposeResponse(posted.status, posted.text);
  }

  private mailFrameReferer(): string {
    const url = new URL(this.config.baseUrl);
    const prefix = this.config.mailPath.replace(/\/+$/, "");
    url.pathname = `${prefix}/iNotes/Mail/`;
    url.search =
      "?OpenDocument&ui=dwa_frame&l=ru&gz&CR&MX&TSF=20240716T090629,88Z&TS=20260920T220506,43Z&charset=UTF-8&charset=UTF-8&KIC&ua=safari&pt&gn";
    return url.href;
  }

  private async submitCompose(
    url: URL,
    overrides: Record<string, string>,
    options: { prependBody?: boolean } = {},
  ): Promise<ComposeResult> {
    await this.ensureNonce();
    const page = await this.authed("GET", url);
    const nonce = extractNonce(page.text) ?? this.pageNonce ?? this.jar.nonce();
    if (nonce) this.pageNonce = nonce;
    const form = parseComposeForm(page.text);
    const fields: Record<string, string> = { ...(form?.fields ?? {}) };
    const previousBody = fields.Body ?? "";
    for (const [key, value] of Object.entries(overrides)) fields[key] = value;
    if (options.prependBody && previousBody.trim() && overrides.Body != null) {
      fields.Body = `${overrides.Body}\r\n\r\n${previousBody}`;
    }
    const openAction = fields.h_EditAction;
    if (!openAction || /^(h_New|h_ShimmerEdit|h_Reply|h_ReplyAll|h_Forward)$/i.test(openAction)) {
      fields.h_EditAction = "h_Next";
    }
    if (nonce) fields["%%Nonce"] = nonce;
    if (!fields["%%PostCharset"]) fields["%%PostCharset"] = "UTF-8";
    const action = form?.action ? new URL(form.action, page.url) : url;
    this.assertSameOrigin(action);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) params.set(key, value);
    const posted = await this.authed("POST", action, params);
    const interpreted = interpretMessage({ bodyHtml: posted.text, fields: parseJsVars(posted.text) });
    if (interpreted.encrypted && !interpreted.bodyAvailable && !form) {
      return { accepted: false, httpStatus: posted.status, message: interpreted.hint ?? "Письмо зашифровано." };
    }
    return interpretComposeResponse(posted.status, posted.text);
  }

  private async ensureNonce(): Promise<void> {
    await this.ensureSession();
    if (this.jar.nonce() || this.pageNonce) return;
    const home = await this.authed("GET", this.command("iNotes/Mail/", "OpenDocument", { Form: "m_HomeView" }));
    this.pageNonce = extractNonce(home.text) ?? this.jar.nonce();
  }

  private async authed(method: "GET" | "POST", url: URL, body?: URLSearchParams, options?: HttpOptions): Promise<HttpResult> {
    await this.ensureSession();
    let response = await this.request(method, url, body, options);
    if (isLoginPage(response.text) && this.config.username && this.config.password && !this.config.cookie) {
      this.sessionReady = false;
      this.sessionPromise = undefined;
      await this.ensureSession();
      response = await this.request(method, url, body, options);
    }
    if (isLoginPage(response.text)) {
      throw new InotesError("iNotes вернул страницу входа. Сессия недействительна или не хватает прав.");
    }
    return response;
  }

  private ensureSession(): Promise<void> {
    if (this.sessionReady) return Promise.resolve();
    if (!this.sessionPromise) {
      this.sessionPromise = this.openSession().catch((error: unknown) => {
        this.sessionPromise = undefined;
        throw error;
      });
    }
    return this.sessionPromise;
  }

  private async openSession(): Promise<void> {
    if (this.config.cookie) {
      this.jar.loadHeader(this.config.cookie);
      this.sessionReady = true;
      return;
    }
    const home = this.command("iNotes/Mail/", "OpenDocument", { Form: "m_HomeView" });
    const first = await this.request("GET", home);
    if (this.jar.hasSession() && !isLoginPage(first.text)) {
      this.pageNonce = extractNonce(first.text) ?? this.jar.nonce();
      this.sessionReady = true;
      return;
    }
    const login = parseLoginForm(first.text);
    if (!login) throw new InotesError("Форма входа Domino не найдена, а сессионной cookie нет.");
    const action = new URL(login.action, first.url);
    this.assertSameOrigin(action);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(login.fields)) params.set(key, value);
    params.set(login.usernameField, this.config.username ?? "");
    params.set(login.passwordField, this.config.password ?? "");
    if (login.redirectField && !params.get(login.redirectField)) {
      params.set(login.redirectField, `${this.config.mailPath}/iNotes/Mail/?OpenDocument&Form=m_HomeView`);
    }
    const posted = await this.request("POST", action, params);
    if (!this.jar.hasSession() || isLoginPage(posted.text)) {
      throw new InotesError("Вход в Domino не выполнен. Проверьте имя и пароль с формы iNotes.");
    }
    this.pageNonce = extractNonce(posted.text) ?? this.jar.nonce();
    this.sessionReady = true;
  }

  private async request(method: "GET" | "POST", url: URL, body?: URLSearchParams, options?: HttpOptions): Promise<HttpResult> {
    let current = url;
    let verb = method;
    let payload = body;
    for (let hop = 0; hop < 5; hop += 1) {
      this.assertSameOrigin(current);
      const headers = new Headers();
      headers.set("Accept", options?.browserForm ? DWA_ACCEPT : "text/html,application/json,application/xml;q=0.9,*/*;q=0.8");
      headers.set("User-Agent", options?.userAgent ?? "inotes-mcp/1.0");
      if (options?.browserForm) {
        headers.set("Accept-Language", "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7");
        headers.set("Cache-Control", "no-cache");
        headers.set("Pragma", "no-cache");
        headers.set("Origin", new URL(this.config.baseUrl).origin);
        if (options.referer) headers.set("Referer", options.referer);
        headers.set("Sec-Fetch-Dest", "iframe");
        headers.set("Sec-Fetch-Mode", "navigate");
        headers.set("Sec-Fetch-Site", "same-origin");
        headers.set("Sec-Fetch-User", "?1");
        headers.set("Upgrade-Insecure-Requests", "1");
        headers.set("sec-ch-ua", '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"');
        headers.set("sec-ch-ua-mobile", "?0");
        headers.set("sec-ch-ua-platform", '"macOS"');
      }
      const cookie = this.jar.header();
      if (cookie) headers.set("Cookie", cookie);
      let reqBody: string | undefined;
      if (verb === "POST" && payload) {
        headers.set("Content-Type", options?.browserForm ? "application/x-www-form-urlencoded" : "application/x-www-form-urlencoded; charset=UTF-8");
        reqBody = payload.toString();
      }
      const response = await fetch(current, {
        method: verb,
        headers,
        body: reqBody,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      this.jar.absorb(response.headers);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { status: response.status, url: current.href, text: "" };
        current = new URL(location, current);
        if (response.status !== 307 && response.status !== 308) {
          verb = "GET";
          payload = undefined;
        }
        continue;
      }
      const text = await readLimited(response);
      return { status: response.status, url: current.href, text };
    }
    throw new InotesError("Слишком много перенаправлений при обращении к iNotes.");
  }

  private command(suffix: string, command: string, params: Record<string, string>): URL {
    return inotesCommandUrl(this.config.baseUrl, this.config.mailPath, suffix, command, params);
  }

  private assertSameOrigin(url: URL): void {
    if (url.origin !== new URL(this.config.baseUrl).origin) {
      throw new InotesError("Отказ: iNotes вернул адрес на другом хосте.");
    }
  }
}

async function readLimited(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new InotesError("Смещение start должно быть целым числом от 1.");
  return value;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < min || chosen > max) {
    throw new InotesError(`Количество записей должно быть целым от ${min} до ${max}.`);
  }
  return chosen;
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new InotesError(`${label} не может быть пустым.`);
}

function isReloadShell(html: string): boolean {
  return html.length < 1500 && /location\.reload\s*\(/.test(html) && !/"@name"/.test(html);
}

function eventFields(source: string): Record<string, unknown> {
  const items = parseDominoItems(source);
  const fields: Record<string, unknown> = { ...parseJsVars(source) };
  const assign = (key: string, value: string | undefined) => {
    if (!value?.trim()) return;
    fields[key] = value;
  };
  assign("Subject", items.Subject);
  assign("StartDateTime", firstDominoDate(items.StartDateTime, items.STARTDATETIME, items.StartDate));
  assign("EndDateTime", firstDominoDate(items.EndDateTime, items.ENDDATETIME, items.EndDate));
  assign("AppointmentType", items.AppointmentType);
  assign("Form", items.Form);
  assign("Location", firstPlace(items.Location, items.Room, items.STRoomName));
  assign("STUnyteConferenceURL", items.STUnyteConferenceURL);
  assign("Body", items.Body);
  return fields;
}

function firstDominoDate(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && /^\d{8}T\d{6}/.test(value.trim())) return fromDominoDateTime(value);
  }
  return undefined;
}

function firstPlace(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || trimmed === "-" || trimmed === "—") continue;
    return trimmed;
  }
  return undefined;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

function encodeMemoHtml(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map(escapeHtmlText)
    .join("<br>");
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function replyAllCopy(items: Record<string, string>, parentFrom: string): string {
  const seen = new Set<string>();
  const own = parentFrom.toLowerCase();
  const addresses: string[] = [];
  for (const raw of [items.SendTo, items.CopyTo]) {
    if (!raw) continue;
    for (const part of raw.split(/[;,]/)) {
      const address = internetAddress(part) || (part.includes("@") ? part.trim() : "");
      const key = address.toLowerCase();
      if (!address || key === own || seen.has(key)) continue;
      seen.add(key);
      addresses.push(address);
    }
  }
  return addresses.join(", ");
}

function contactHaystack(contact: Contact): string {
  return [contact.name, contact.email, contact.company, ...Object.values(contact.fields)].filter(Boolean).join(" ").toLowerCase();
}
