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
