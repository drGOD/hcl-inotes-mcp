import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { InotesClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { parseDirectorySearch } from "../src/parse.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string) => readFileSync(join(fixtures, name), "utf8");

const exampleConfig = {
  INOTES_BASE_URL: "https://mail.example.com",
  INOTES_MAIL_PATH: "/mail/user.nsf",
  INOTES_COOKIE: "DomAuthSessId=example",
};

test("directory search HTML keeps OpenDocument names and drops duplicates", () => {
  const contacts = parseDirectorySearch(read("directory-search.html"));
  assert.equal(contacts.length, 2);
  assert.equal(contacts[0]?.unid, "AABBCCDDEEFF00112233445566778899");
  assert.equal(contacts[0]?.name, "Example Person/IT/Example Directory");
  assert.equal(contacts[1]?.name, "Other & Person");
});

test("INOTES_DIRECTORY searches that catalog instead of the personal book", async () => {
  const calls: URL[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    if (url.pathname.endsWith("/$about")) return new Response(read("directory-about.html"), { status: 200 });
    if (url.pathname.endsWith("/People") && url.search.includes("SearchView")) {
      return new Response(read("directory-search.html"), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  };
  try {
    const client = new InotesClient(loadConfig({ ...exampleConfig, INOTES_DIRECTORY: "Example Directory" }));
    const found = await client.listContacts({ query: "Example Person", limit: 10 });
    assert.equal(found.view, "Example Directory");
    assert.equal(found.contacts.length, 1);
    assert.equal(found.contacts[0]?.name, "Example Person/IT/Example Directory");
    assert.equal(calls.some((url) => url.pathname === "/names.nsf/$about"), true);
    const search = calls.find((url) => url.pathname === "/names.nsf/People");
    assert.equal(search?.search.includes("SearchView"), true);
    assert.equal(search?.searchParams.get("Query"), "Example Person");
    assert.equal(calls.some((url) => url.href.includes("($Contacts)")), false);
  } finally {
    globalThis.fetch = original;
  }
});

test("an empty directory name keeps the personal book", async () => {
  const calls: URL[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    return new Response(read("inbox.xml"), { status: 200, headers: { "content-type": "text/xml" } });
  };
  try {
    const client = new InotesClient(loadConfig({ ...exampleConfig, INOTES_DIRECTORY: "" }));
    const listed = await client.listContacts({ limit: 5 });
    assert.equal(listed.view, "($Contacts)");
    assert.equal(calls.some((url) => url.pathname.includes("names.nsf")), false);
    assert.equal(calls.some((url) => (url.searchParams.get("PresetFields") ?? "").includes("($Contacts)")), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("a directory name that does not match the catalog is not the personal book", async () => {
  const calls: URL[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    return new Response(read("directory-other.html"), { status: 200 });
  };
  try {
    const client = new InotesClient(loadConfig({ ...exampleConfig, INOTES_DIRECTORY: "Example Directory" }));
    await assert.rejects(() => client.listContacts({ query: "Example Person" }), /Example Directory/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.pathname, "/names.nsf/$about");
  } finally {
    globalThis.fetch = original;
  }
});

test("listing with INOTES_DIRECTORY reads the catalog view", async () => {
  const calls: URL[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    if (url.pathname.endsWith("/$about")) return new Response(read("directory-about.html"), { status: 200 });
    if (url.search.includes("ReadViewEntries")) return new Response(read("directory-people.json"), { status: 200 });
    return new Response("unexpected", { status: 500 });
  };
  try {
    const client = new InotesClient(loadConfig({ ...exampleConfig, INOTES_DIRECTORY: "example directory" }));
    const listed = await client.listContacts({ limit: 5 });
    assert.equal(listed.view, "example directory");
    assert.equal(listed.contacts[0]?.name, "Example Person");
    assert.equal(calls.some((url) => url.href.includes("($Contacts)")), false);
    const view = calls.find((url) => url.pathname === "/names.nsf/People");
    assert.equal(view?.search.includes("ReadViewEntries"), true);
  } finally {
    globalThis.fetch = original;
  }
});
