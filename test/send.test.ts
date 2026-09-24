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
    assert.match(fields.get("Body") ?? "", /^Ответ из MCP получен, ветка на месте\./);
    assert.match(fields.get("Body") ?? "", /Исходный текст письма/);
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
