import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CookieJar } from "../src/cookies.js";
import { loadConfig } from "../src/config.js";
import { fromDominoDateTime, inotesAppointmentClock, toDominoDateTime, toDominoKey } from "../src/dates.js";
import {
  internetAddress,
  interpretComposeResponse,
  parseDominoItems,
  forwardSubject,
  replySubject,
  interpretEvent,
  interpretMessage,
  isLoginPage,
  parseJsVars,
  parseLoginForm,
  parseOutline,
  parseViewEntries,
  toEvents,
  toMailList,
} from "../src/parse.js";
import { inotesCommandUrl, presetFields } from "../src/urls.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");

test("parses a Domino ReadViewEntries JSON inbox", () => {
  const view = parseViewEntries(read("inbox.json"));
  const list = toMailList("($Inbox)", 1, view);
  assert.equal(view.recognized, true);
  assert.equal(list.total, 2);
  assert.equal(list.messages.length, 2);
  assert.deepEqual(list.messages[0], {
    unid: "A1B2C3D4E5F60718293A4B5C6D7E8F90",
    noteId: "12A",
    position: "1",
    unread: true,
    from: "Иван Петров",
    subject: "Протокол планёрки",
    date: "2026-09-24T06:00:00Z",
    size: 4096,
  });
  assert.equal(list.messages[1]?.unread, false);
  assert.equal(list.messages[1]?.from, "Анна Смирнова");
  assert.equal(list.messages[1]?.subject, "Счёт, за сентябрь");
  assert.equal(list.messages[1]?.date, "2026-09-23T15:00:00Z");
  assert.equal(list.messages[1]?.size, 12000);
});

test("parses an iNotes s_ReadViewEntries XML inbox", () => {
  const list = toMailList("($Inbox)", 1, parseViewEntries(read("inbox.xml")));
  assert.equal(list.total, 1);
  assert.equal(list.messages[0]?.unid, "A1B2C3D4E5F60718293A4B5C6D7E8F90");
  assert.equal(list.messages[0]?.unread, true);
  assert.equal(list.messages[0]?.subject, "Протокол планёрки");
  assert.equal(list.messages[0]?.date, "2026-09-24T06:00:00Z");
});

test("reads a plain l_JSVars message and keeps the body", () => {
  const message = interpretMessage({ unid: "A1B2C3D4E5F60718293A4B5C6D7E8F90", fields: parseJsVars(read("plain-message.html")) });
  assert.equal(message.encrypted, false);
  assert.equal(message.bodyAvailable, true);
  assert.equal(message.subject, "Протокол планёрки");
  assert.equal(message.body, "Коллеги, протокол во вложении.");
  assert.deepEqual(message.to, ["User <user@example.com>", "Анна Смирнова <anna@example.com>"]);
  assert.equal(message.hint, undefined);
});

test("detects a Notes-encrypted message when the session did not return the body", () => {
  const fromFields = interpretMessage({ fields: parseJsVars(read("encrypted-locked.json")) });
  assert.equal(fromFields.encrypted, true);
  assert.equal(fromFields.bodyAvailable, false);
  assert.equal(fromFields.body, undefined);
  assert.match(fromFields.hint ?? "", /Notes ID/);
  assert.match(fromFields.hint ?? "", /не вернула текст/);

  const fromHtml = interpretMessage({ unid: "ABCDEF0123456789ABCDEF0123456789", bodyHtml: read("encrypted-body.html") });
  assert.equal(fromHtml.encrypted, true);
  assert.equal(fromHtml.bodyAvailable, false);

  const russian = interpretMessage({
    fields: { Subject: "Секретно", Body: "Это сообщение зашифровано. Введите пароль Notes ID." },
  });
  assert.equal(russian.encrypted, true);
  assert.equal(russian.bodyAvailable, false);
});

test("returns the body of an encrypted message when the web session already unlocked it", () => {
  const message = interpretMessage({ fields: parseJsVars(read("encrypted-unlocked.json")) });
  assert.equal(message.encrypted, true);
  assert.equal(message.bodyAvailable, true);
  assert.equal(message.body, "Сумма уже расшифрована этой веб-сессией.");
  assert.equal(message.hint, undefined);

  const sealed = interpretMessage({
    fields: { Subject: "Секретно", $Seal: "1", Body: "Текст после разблокировки ID." },
  });
  assert.equal(sealed.encrypted, true);
  assert.equal(sealed.bodyAvailable, true);
  assert.equal(sealed.body, "Текст после разблокировки ID.");
});

test("does not treat a discussion of encryption as an encrypted message", () => {
  const message = interpretMessage({
    fields: { Subject: "Архив", Encrypt: "0", Body: "Пришлите зашифрованный архив до пятницы." },
  });
  assert.equal(message.encrypted, false);
  assert.equal(message.bodyAvailable, true);
  assert.match(message.body ?? "", /зашифрованный архив/);
});

test("parses the folder outline and the Domino login form", () => {
  const folders = parseOutline(read("outline.js"));
  assert.deepEqual(
    folders.map((folder) => folder.viewName),
    ["($Inbox)", "($Sent)", "ABCDEF0123456789ABCDEF0123456789"],
  );
  assert.equal(folders[0]?.label, "Входящие");
  assert.equal(folders[0]?.dropTarget, true);
  assert.equal(folders[1]?.dropTarget, false);

  const html = read("login.html");
  assert.equal(isLoginPage(html), true);
  const form = parseLoginForm(html);
  assert.equal(form?.action, "/names.nsf?Login");
  assert.equal(form?.usernameField, "Username");
  assert.equal(form?.passwordField, "Password");
  assert.equal(form?.redirectField, "RedirectTo");
  assert.equal(form?.fields.RedirectTo, "/mail/user.nsf/iNotes/Mail/?OpenDocument&Form=m_HomeView");
  assert.equal(form?.fields["%%ModDate"], "0000000000000000");
});

test("reads the iNotes nonce from ShimmerS and keeps session cookies", () => {
  const jar = new CookieJar();
  jar.loadHeader("Cookie: DomAuthSessId=session-value; ShimmerS=S:1&N:nonce-value&T:2");
  assert.equal(jar.hasSession(), true);
  assert.equal(jar.nonce(), "nonce-value");
  assert.match(jar.header(), /DomAuthSessId=session-value/);
});

test("builds a ReadViewEntries URL with literal PresetFields separators", () => {
  const url = inotesCommandUrl("https://mail.example.com", "/mail/user.nsf", "iNotes/Proxy/", "OpenDocument", {
    Form: "s_ReadViewEntries",
    PresetFields: presetFields([
      ["FolderName", "($Inbox)"],
      ["UnreadCountInfo", "1"],
      ["SearchString", "hello, world"],
    ]),
    Start: "1",
    Count: "25",
  });
  assert.equal(
    url.href,
    "https://mail.example.com/mail/user.nsf/iNotes/Proxy/?OpenDocument&Form=s_ReadViewEntries&PresetFields=FolderName;($Inbox),UnreadCountInfo;1,SearchString;hello%2C%20world&Start=1&Count=25",
  );
});

test("reads a calendar end time when the display column is a dash", () => {
  const events = toEvents({
    recognized: true,
    entries: [
      {
        unid: "0123456789ABCDEF0123456789ABCDEF",
        unread: false,
        columns: [
          { column: 0, name: "$134", type: "datetime", value: "20260929T110000,00Z" },
          { column: 2, name: "$144", type: "datetime", value: "20260929T110000,00Z" },
          { column: 3, name: "$145", type: "text", value: "-" },
          { column: 4, name: "$146", type: "datetime", value: "20260929T120000,00Z" },
          { column: 5, name: "$147", type: "text", value: "Планёрка" },
          { column: 6, name: "Room", type: "text", value: "-" },
        ],
      },
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.subject, "Планёрка");
  assert.equal(events[0]?.start, "2026-09-29T11:00:00Z");
  assert.equal(events[0]?.end, "2026-09-29T12:00:00Z");
  assert.equal(events[0]?.location, undefined);
});

test("reads the online meeting URL and ignores a field that is not a URL", () => {
  const event = interpretEvent({
    unid: "0123456789ABCDEF0123456789ABCDEF",
    fields: {
      Subject: "Планёрка",
      STUnyteConferenceURL: "https://meet.example.com/room",
    },
  });
  assert.equal(event.onlineMeetingUrl, "https://meet.example.com/room");
  const plain = interpretEvent({ fields: { STUnyteConferenceURL: "1", OnlineMeeting: "1" } });
  assert.equal(plain.onlineMeetingUrl, undefined);
  const located = interpretEvent({ fields: { Location: "https://test.com/test" } });
  assert.equal(located.onlineMeetingUrl, "https://test.com/test");
  assert.equal(located.location, "https://test.com/test");
});

test("converts Domino calendar datetimes", () => {
  assert.equal(toDominoKey("2026-09-24T06:00:00Z"), "20260924T060000Z");
  assert.equal(toDominoDateTime("2026-09-24T06:00:00Z"), "20260924T060000,00Z");
  assert.equal(fromDominoDateTime("20260924T060000,00+03"), "2026-09-24T06:00:00+03:00");
  const clock = inotesAppointmentClock("2026-09-25T10:00:00+03:00", "2026-09-25T11:00:00+03:00");
  assert.equal(clock.start, "20260925T100000$Z=-3$DO=0$ZN=Arab/E. Africa/Russian");
  assert.equal(clock.end, "20260925T110000$Z=-3$DO=0$ZN=Arab/E. Africa/Russian");
  assert.equal(clock.intDate, "Пт 09.25.2026");
  assert.equal(clock.intTime, "10:00");
  assert.equal(clock.intEndTime, "11:00");
  assert.equal(clock.intDur, "1h 00m");
});

test("config requires the host and does not invent one", () => {
  assert.throws(() => loadConfig({}), /INOTES_BASE_URL/);
  assert.throws(
    () => loadConfig({ INOTES_BASE_URL: "https://mail.example.com", INOTES_MAIL_PATH: "/mail/user.nsf" }),
    /INOTES_COOKIE|INOTES_USERNAME/,
  );
  const config = loadConfig({
    INOTES_BASE_URL: "https://mail.example.com/ignored",
    INOTES_MAIL_PATH: "/mail/user.nsf",
    INOTES_COOKIE: "DomAuthSessId=example",
  });
  assert.equal(config.baseUrl, "https://mail.example.com");
  assert.equal(config.mailPath, "/mail/user.nsf");
});

test("reads reply fields from Domino @name items", () => {
  const items = parseDominoItems(read("reply-parent.js"));
  assert.equal(internetAddress(items.From ?? ""), "a@example.com");
  assert.equal(replySubject(items.Subject ?? ""), "Re: Проверка");
  assert.equal(replySubject("Re: Проверка"), "Re: Проверка");
  assert.equal(forwardSubject(items.Subject ?? ""), "Fw: Проверка");
  assert.equal(forwardSubject("Fw: Проверка"), "Fw: Проверка");
  assert.equal(items.x_MessageID, "<memo@example.com>");
});

test("accepts a compose only when iNotes returns the send callback", () => {
  const rejected = interpretComposeResponse(200, "<html><title>Error</title><body>Unknown Command Exception</body></html>");
  assert.equal(rejected.accepted, false);
  const generic = interpretComposeResponse(200, "<html><title>Mail</title><body>OK</body></html>");
  assert.equal(generic.accepted, false);
  const processed = interpretComposeResponse(200, "<html><title>Form processed</title><body><h1>Form processed</h1></body></html>");
  assert.equal(processed.accepted, false);
  const shell = interpretComposeResponse(
    200,
    "<html><body onload=\"if (window.AAA){if (AAA.DSq.reloading) AAA.DSq.parent.location.reload();}\"></body></html>",
  );
  assert.equal(shell.accepted, false);
  const accepted = interpretComposeResponse(200, read("send-accepted.html"));
  assert.equal(accepted.accepted, true);
  assert.match(accepted.message, /AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/);
});
