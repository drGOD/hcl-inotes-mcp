import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { InotesClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { dateColumnNumber, parseViewEntries, toMailList, type ViewEntry } from "../src/parse.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");

test("inbox date column is not the size column", () => {
  const view = parseViewEntries(read("inbox.json"));
  assert.equal(dateColumnNumber(view.entries), 3);
  const size = view.entries[0]?.columns.find((column) => column.name === "$106");
  assert.equal(size?.column, 4);
  assert.notEqual(dateColumnNumber(view.entries), size?.column);
});

test("sent date column is $62 even when size is the next column", () => {
  const view = parseViewEntries(read("sent.xml"));
  const list = toMailList("($Sent)", 1, view);
  assert.equal(dateColumnNumber(view.entries), 4);
  assert.equal(list.messages[0]?.subject, "Протокол планёрки");
  assert.equal(list.messages[0]?.date, "2026-09-24T09:48:00Z");
  assert.equal(list.messages[0]?.from, "Иван Петров");
  assert.equal(list.messages[0]?.size, 4096);
});

test("an unnamed datetime column is used and size is not", () => {
  const entries: ViewEntry[] = [
    {
      unid: "A1B2C3D4E5F60718293A4B5C6D7E8F90",
      unread: false,
      columns: [
        { column: 5, name: "$106", type: "number", value: "99999999" },
        { column: 2, name: "When", type: "datetime", value: "20260924T060000,00Z" },
      ],
    },
  ];
  assert.equal(dateColumnNumber(entries), 2);
});

test("list and search sort by the view date column, not by size", async () => {
  const calls: URL[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    const folder = decodeURIComponent(url.searchParams.get("PresetFields") ?? "");
    const body = folder.includes("($Sent)") ? read("sent.xml") : read("inbox.xml");
    return new Response(body, { status: 200, headers: { "content-type": "text/xml" } });
  };
  try {
    const client = new InotesClient(
      loadConfig({
        INOTES_BASE_URL: "https://mail.example.com",
        INOTES_MAIL_PATH: "/mail/user.nsf",
        INOTES_COOKIE: "DomAuthSessId=example",
      }),
    );
    const inbox = await client.listMessages({ folder: "($Inbox)", limit: 5 });
    const found = await client.searchMail({ query: "планёрка", folder: "($Inbox)", limit: 5 });
    const sent = await client.listMessages({ folder: "($Sent)", limit: 5 });
    assert.equal(inbox.messages[0]?.date, "2026-09-24T06:00:00Z");
    assert.equal(found.messages[0]?.subject, "Протокол планёрки");
    assert.equal(sent.messages[0]?.subject, "Протокол планёрки");
    assert.equal(sent.messages[0]?.date, "2026-09-24T09:48:00Z");
    const sorts = calls.map((url) => url.searchParams.get("resortdescending"));
    assert.equal(sorts.includes("5"), false);
    assert.ok(sorts.includes("3"));
    assert.ok(sorts.includes("4"));
    const search = calls.find((url) => (url.searchParams.get("PresetFields") ?? "").includes("SearchString"));
    assert.equal(search?.searchParams.get("resortdescending"), "3");
  } finally {
    globalThis.fetch = original;
  }
});

test("read_message uses Domino browser form headers and parses its body response", async () => {
  const calls: Array<{ url: URL; headers: Headers }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    calls.push({ url, headers });
    return url.searchParams.get("Form") === "s_MailMemoReadBodyContent"
      ? new Response("<html><body><p>Текст живого письма.</p></body></html>", { status: 200 })
      : new Response('{"Subject":"Тест","From":"sender@example.com"}', { status: 200 });
  };
  try {
    const client = new InotesClient(
      loadConfig({
        INOTES_BASE_URL: "https://mail.example.com",
        INOTES_MAIL_PATH: "/mail/user.nsf",
        INOTES_COOKIE: "DomAuthSessId=example",
      }),
    );
    const message = await client.readMessage("A1B2C3D4E5F60718293A4B5C6D7E8F90");
    assert.equal(message.body, "Текст живого письма.");
    assert.equal(message.bodyAvailable, true);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.url.searchParams.get("PresetFields"), "s_NoMarkRead;1");
      assert.match(call.headers.get("accept") ?? "", /text\/html/);
      assert.match(call.headers.get("referer") ?? "", /iNotes\/Mail/);
      assert.equal(call.headers.get("sec-fetch-dest"), "iframe");
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("read_message retries Domino's reload shell before parsing message headers", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const form = url.searchParams.get("Form") ?? "";
    calls.push(form);
    if (form === "s_MailMemoReadBodyContent") {
      return new Response("<html><body><p>Текст письма.</p></body></html>", { status: 200 });
    }
    return calls.length === 1
      ? new Response('<html><script>location.reload();</script></html>', { status: 200 })
      : new Response('{"Subject":"Ландшафт","From":"sender@example.com","PostedDate":"2026-09-27T10:00:00Z"}', { status: 200 });
  };
  try {
    const client = new InotesClient(
      loadConfig({
        INOTES_BASE_URL: "https://mail.example.com",
        INOTES_MAIL_PATH: "/mail/user.nsf",
        INOTES_COOKIE: "DomAuthSessId=example",
      }),
    );
    const message = await client.readMessage("A1B2C3D4E5F60718293A4B5C6D7E8F90");
    assert.deepEqual(calls, ["l_JSVars", "l_JSVars", "s_MailMemoReadBodyContent"]);
    assert.equal(message.subject, "Ландшафт");
    assert.equal(message.from, "sender@example.com");
    assert.equal(message.date, "2026-09-27T10:00:00Z");
    assert.equal(message.body, "Текст письма.");
  } finally {
    globalThis.fetch = original;
  }
});

test("mark_message_unread posts the iNotes mark-unread command for one UNID", async () => {
  const calls: Array<{ url: URL; method: string; body: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
    return new Response("{}", { status: 200 });
  };
  try {
    const client = new InotesClient(
      loadConfig({
        INOTES_BASE_URL: "https://mail.example.com",
        INOTES_MAIL_PATH: "/mail/user.nsf",
        INOTES_COOKIE: "DomAuthSessId=example; ShimmerS=ET:1&N:abc123nonce",
      }),
    );
    const unid = "A1B2C3D4E5F60718293A4B5C6D7E8F90";
    assert.deepEqual(await client.markMessageUnread(unid), { unid, unread: true });
    assert.equal(calls[0]?.method, "POST");
    assert.match(calls[0]?.url.search ?? "", /EditDocument/);
    assert.match(calls[0]?.url.search ?? "", /PresetFields=s_NoMarkRead;1/);
    const fields = new URLSearchParams(calls[0]?.body ?? "");
    assert.equal(fields.get("h_SetCommand"), "h_ShimmerMarkUnread");
    assert.equal(fields.get("h_SetDeleteList"), unid);
    assert.equal(fields.get("Form"), "l_HaikuErrorStatusJSON");
    assert.equal(fields.get("%%Nonce"), "abc123nonce");
  } finally {
    globalThis.fetch = original;
  }
});
