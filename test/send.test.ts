import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { InotesClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");

const config = loadConfig({
  INOTES_BASE_URL: "https://mail.example.com",
  INOTES_MAIL_PATH: "/mail/user.nsf",
  INOTES_COOKIE: "DomAuthSessId=example; ShimmerS=ET:1&N:abc123nonce",
});

test("send_mail posts the iNotes memo form and requires the accept callback", async () => {
  const calls: Array<{ url: URL; method: string; body: string; userAgent: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : "",
      userAgent: headers.get("user-agent") ?? "",
    });
    if (method === "POST") return new Response(read("send-accepted.html"), { status: 200 });
    return new Response(read("compose-form.html"), { status: 200 });
  };
  try {
    const client = new InotesClient(config);
    const result = await client.sendMail({
      to: ["a@example.com"],
      subject: "Тест отправки",
      body: "Короткий текст.",
    });
    assert.equal(result.accepted, true);
    assert.match(result.message, /AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/);
    assert.equal(calls.length, 2);
    const [opened, posted] = calls;
    assert.equal(opened?.method, "GET");
    assert.match(decodeURIComponent(opened?.url.pathname ?? ""), /\/\(\$Drafts\)\/\$new\/$/);
    assert.match(opened?.url.search ?? "", /h_EditAction;h_New/);
    assert.match(opened?.userAgent ?? "", /Chrome/);
    assert.equal(posted?.method, "POST");
    assert.match(decodeURIComponent(posted?.url.pathname ?? ""), /\/\(\$Drafts\)\/\$new\/$/);
    assert.match(posted?.url.search ?? "", /h_EditAction;h_ShimmerEdit/);
    assert.match(posted?.url.search ?? "", /s_NotesForm;Memo/);
    const fields = new URLSearchParams(posted?.body ?? "");
    assert.equal(fields.get("SendTo"), "a@example.com");
    assert.equal(fields.get("CopyTo"), "");
    assert.equal(fields.get("Subject"), "Тест отправки");
    assert.equal(fields.get("Body"), "Короткий текст.");
    assert.equal(fields.get("s_UsePlainText"), "0");
    assert.equal(fields.get("s_PlainEditor"), "0");
    assert.equal(fields.get("h_SetCommand"), "h_ShimmerSendMail");
    assert.equal(fields.get("h_EditAction"), "h_Next");
    assert.equal(fields.get("h_SetSaveDoc"), "1");
    assert.equal(fields.get("MailOptions"), "1");
    assert.equal(fields.get("h_SetParentUnid"), "");
    assert.equal(fields.get("%%Nonce"), "abc123nonce");
    assert.equal(fields.get("h_SetReturnURL"), "[[./&Form=l_CallListenerWithUnid]]");
    assert.match(posted?.userAgent ?? "", /Chrome/);
  } finally {
    globalThis.fetch = original;
  }
});

test("send_mail does not treat a generic 200 page as acceptance", async () => {
  const original = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (_input, init) => {
    if ((init?.method ?? "GET") === "POST") {
      posts += 1;
      return new Response("<html><title>Mail</title><body>OK</body></html>", { status: 200 });
    }
    return new Response(read("compose-form.html"), { status: 200 });
  };
  try {
    const result = await new InotesClient(config).sendMail({
      to: ["a@example.com"],
      subject: "Тест отправки",
      body: "Короткий текст.",
    });
    assert.equal(result.accepted, false);
    assert.equal(result.httpStatus, 200);
    assert.equal(posts, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("reply_mail posts the parent reply on the shimmer send path", async () => {
  const calls: Array<{ url: URL; method: string; body: string }> = [];
  const original = globalThis.fetch;
  const parent = "0123456789ABCDEF0123456789ABCDEF";
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : "" });
    if (method === "POST") return new Response(read("send-accepted.html"), { status: 200 });
    const query = url.search;
    if (query.includes("Form=l_JSVars")) return new Response(read("reply-parent.js"), { status: 200 });
    if (query.includes("Form=s_MailMemoReadBodyContent")) return new Response(read("reply-body.html"), { status: 200 });
    return new Response(read("compose-form.html"), { status: 200 });
  };
  try {
    const result = await new InotesClient(config).replyMail({
      unid: parent,
      body: "Ответ из MCP получен, ветка на месте.",
    });
    assert.equal(result.accepted, true);
    const opened = calls.find((call) => call.method === "GET" && call.url.search.includes("h_PageUI"));
    assert.match(opened?.url.search ?? "", /s_MailActionType;h_ReplyTo/);
    assert.match(opened?.url.search ?? "", new RegExp(`s_MailParentUNID;${parent}`));
    const posted = calls.find((call) => call.method === "POST");
    assert.match(decodeURIComponent(posted?.url.pathname ?? ""), /\/\(\$Drafts\)\/\$new\/$/);
    assert.match(posted?.url.search ?? "", /h_EditAction;h_ShimmerEdit/);
    assert.match(posted?.url.search ?? "", /s_NotesForm;Memo/);
    const fields = new URLSearchParams(posted?.body ?? "");
    assert.equal(fields.get("SendTo"), "a@example.com");
    assert.equal(fields.get("CopyTo"), "");
    assert.equal(fields.get("Subject"), "Re: Проверка");
    assert.equal(
      fields.get("Body"),
      "Ответ из MCP получен, ветка на месте.<br><br>Исходный текст письма.",
    );
    assert.equal(fields.get("h_SetCommand"), "h_ShimmerSendMail");
    assert.equal(fields.get("h_SetParentUnid"), parent);
    assert.equal(fields.get("s_MailParentUNID"), parent);
    assert.equal(fields.get("s_MailActionType"), "h_ReplyTo");
    assert.equal(fields.get("In_Reply_To"), "<memo@example.com>");
    assert.equal(fields.get("%%Nonce"), "abc123nonce");
    assert.equal(fields.get("h_SetReturnURL"), "[[./&Form=l_CallListenerWithUnid]]");
  } finally {
    globalThis.fetch = original;
  }
});

test("send_mail keeps paragraph breaks in the rich-text Body field", async () => {
  const calls: Array<{ method: string; body: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, body: typeof init?.body === "string" ? init.body : "" });
    if (method === "POST") return new Response(read("send-accepted.html"), { status: 200 });
    return new Response(read("compose-form.html"), { status: 200 });
  };
  const body = "Строка один.\nСтрока два.\n\nПосле пустой строки третий абзац.\nИ ещё одна строка.";
  try {
    const result = await new InotesClient(config).sendMail({
      to: ["a@example.com"],
      subject: "Переносы",
      body,
    });
    assert.equal(result.accepted, true);
    const posted = calls.find((call) => call.method === "POST");
    const fields = new URLSearchParams(posted?.body ?? "");
    const stored = fields.get("Body") ?? "";
    assert.equal(
      stored,
      "Строка один.<br>Строка два.<br><br>После пустой строки третий абзац.<br>И ещё одна строка.",
    );
    assert.equal(stored.includes("\n") || stored.includes("\r"), false);
    assert.equal(fields.get("s_UsePlainText"), "0");
    assert.equal(fields.get("s_UsePlainTextAndHTML"), "0");
    assert.equal(fields.get("s_PlainEditor"), "0");
    const crlf = await postedBody(calls, "Строка один.\r\nСтрока два.\r\n\r\nПосле пустой строки третий абзац.\r\nИ ещё одна строка.");
    assert.equal(crlf, stored);
  } finally {
    globalThis.fetch = original;
  }
});

async function postedBody(
  calls: Array<{ method: string; body: string }>,
  body: string,
): Promise<string> {
  calls.length = 0;
  await new InotesClient(config).sendMail({
    to: ["a@example.com"],
    subject: "Переносы",
    body,
  });
  const posted = calls.find((call) => call.method === "POST");
  return new URLSearchParams(posted?.body ?? "").get("Body") ?? "";
}

test("send_mail does not post when iNotes returns an empty shell", async () => {
  const original = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (_input, init) => {
    if ((init?.method ?? "GET") === "POST") posts += 1;
    return new Response("<html><body onload=\"AAA.DSq.parent.location.reload()\"></body></html>", { status: 200 });
  };
  try {
    const result = await new InotesClient(config).sendMail({
      to: ["a@example.com"],
      subject: "Тест отправки",
      body: "Короткий текст.",
    });
    assert.equal(result.accepted, false);
    assert.match(result.message, /SendTo/);
    assert.equal(posts, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("read_event reloads the iNotes shell and reads appointment times", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  const unid = "0123456789ABCDEF0123456789ABCDEF";
  const shell = "<html><body><script>location.reload();</script></body></html>";
  const document = [
    '{"@name":"Subject","text":{"0":"Планёрка"}}',
    '{"@name":"STARTDATETIME","text":{"0":"20260929T110000,00Z"}}',
    '{"@name":"ENDDATETIME","text":{"0":"20260929T120000,00Z"}}',
    '{"@name":"STRoomName","text":{"0":"-"}}',
    '{"@name":"AppointmentType","text":{"0":"0"}}',
    '{"@name":"STUnyteConferenceURL","textlist":{"text":[{"0":"https://meet.example.com/room"}]}}',
  ].join(",");
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.search);
    if (calls.length === 1) return new Response(shell, { status: 200 });
    return new Response(`[${document}]`, { status: 200 });
  };
  try {
    const event = await new InotesClient(config).readEvent(unid);
    assert.equal(calls.length, 2);
    assert.equal(event.subject, "Планёрка");
    assert.equal(event.start, "2026-09-29T11:00:00Z");
    assert.equal(event.end, "2026-09-29T12:00:00Z");
    assert.equal(event.location, undefined);
    assert.equal(event.body, undefined);
    assert.equal(event.onlineMeetingUrl, "https://meet.example.com/room");
  } finally {
    globalThis.fetch = original;
  }
});

test("create_event saves an appointment with the conference URL and does not invite", async () => {
  const calls: Array<{ url: URL; method: string; body: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : "" });
    if (method === "POST") return new Response(read("send-accepted.html"), { status: 200 });
    return new Response(read("appointment-form.html"), { status: 200 });
  };
  try {
    const result = await new InotesClient(config).createEvent({
      subject: "Проверка ВКС",
      start: "2026-09-25T10:00:00+03:00",
      end: "2026-09-25T11:00:00+03:00",
      onlineMeetingUrl: "https://test.com/test",
    });
    assert.equal(result.accepted, true);
    const posted = calls.find((call) => call.method === "POST");
    assert.match(decodeURIComponent(posted?.url.pathname ?? ""), /\/\(\$Calendar\)\/\$new\/$/);
    assert.match(posted?.url.search ?? "", /h_EditAction;h_ShimmerEdit/);
    assert.match(posted?.url.search ?? "", /s_NotesForm;Appointment/);
    const fields = new URLSearchParams(posted?.body ?? "");
    assert.equal(fields.get("Subject"), "Проверка ВКС");
    assert.equal(fields.get("StartDate"), "20260925T070000,00Z");
    assert.equal(fields.get("EndDate"), "20260925T080000,00Z");
    assert.equal(fields.get("STUnyteConferenceURL"), "https://test.com/test");
    assert.equal(fields.get("s_NewSTUnyteConferenceURL"), "https://test.com/test");
    assert.equal(fields.get("OnlineMeeting"), "1");
    assert.equal(fields.get("h_SetCommand"), "h_ShimmerSave");
    assert.equal(fields.get("MailOptions"), "0");
    assert.equal(fields.get("s_SendNotice"), "0");
    assert.equal(fields.get("RequiredAttendees"), "");
    assert.equal(fields.get("EnterSendTo"), "");
    assert.equal(fields.get("$AlarmSendTo"), "");
    assert.equal(fields.get("Alarms"), "0");
  } finally {
    globalThis.fetch = original;
  }
});

test("create_event does not treat a generic 200 page as a saved appointment", async () => {
  const original = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (_input, init) => {
    if ((init?.method ?? "GET") === "POST") {
      posts += 1;
      return new Response("<html><title>Form processed</title><body><h1>Form processed</h1></body></html>", { status: 200 });
    }
    return new Response(read("appointment-form.html"), { status: 200 });
  };
  try {
    const result = await new InotesClient(config).createEvent({
      subject: "Проверка ВКС",
      start: "2026-09-25T10:00:00+03:00",
      end: "2026-09-25T11:00:00+03:00",
      onlineMeetingUrl: "https://meet.example.com/room",
    });
    assert.equal(result.accepted, false);
    assert.equal(posts, 1);
    assert.match(result.message, /DhU\.onDatasetComplete|Form processed/);
  } finally {
    globalThis.fetch = original;
  }
});
