import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const tempDirectory = mkdtempSync(join(tmpdir(), "overleaf-chat-sessions-"));
const storeFile = join(tempDirectory, "conversations.json");
process.env.CHATGPT_WEB_CONVERSATION_FILE = storeFile;
process.env.PERSIST_STORE = "1";
process.env.CHATGPT_WEB_NO_SERVER = "1";

const store = await import("../conversation-store.js");
const { conversationRoutingFromBody, messagesToPrompt, runWithToolRetry } =
  await import("../server.js");

after(() => rmSync(tempDirectory, { recursive: true, force: true }));

test("keyed sessions bypass signature matching and persist until forgotten", () => {
  const key = "overleaf:aaaaaaaaaaaaaaaaaaaaaaaa";
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "first turn" },
  ];
  const entry = store.rememberConversation(
    null,
    messages,
    { role: "assistant", content: "first reply" },
    "https://chatgpt.com/c/example",
    true,
    { key },
  );

  assert.equal(store.findConversationByKey(key, true), entry);
  assert.equal(
    store.findConversation(
      [
        ...messages,
        { role: "assistant", content: "first reply" },
        { role: "user", content: "next" },
      ],
      true,
    ),
    null,
  );
  const persisted = JSON.parse(readFileSync(storeFile, "utf8"));
  assert.equal(persisted.version, 4);
  assert.equal(persisted.entries[0].key, key);
  assert.equal(store.forgetConversationByKey(key), true);
  assert.equal(store.findConversationByKey(key), null);
  assert.equal(store.forgetConversationByKey(key), false);
});

test("routing accepts only scoped Overleaf keys and a valid delta index", () => {
  assert.deepEqual(
    conversationRoutingFromBody({
      conversation_key: "overleaf:bbbbbbbbbbbbbbbbbbbbbbbb",
      conversation_delta_start: 1,
      messages: [{ role: "system" }, { role: "user" }],
    }),
    {
      conversationKey: "overleaf:bbbbbbbbbbbbbbbbbbbbbbbb",
      conversationDeltaStart: 1,
    },
  );
  assert.throws(
    () =>
      conversationRoutingFromBody({
        conversation_key: "opencode:shared",
        conversation_delta_start: 0,
        messages: [{ role: "user" }],
      }),
    /Overleaf session key/,
  );
  assert.throws(
    () =>
      conversationRoutingFromBody({
        conversation_key: "overleaf:bbbbbbbbbbbbbbbbbbbbbbbb",
        conversation_delta_start: 2,
        messages: [{ role: "user" }],
      }),
    /must index/,
  );
});

test("a keyed follow-up reuses its ChatGPT URL and sends only the declared delta", async () => {
  const key = "overleaf:cccccccccccccccccccccccc";
  const calls = [];
  const backend = async (prompt, _onToken, _allowFallback, session) => {
    calls.push({ prompt, chatUrl: session.chatUrl || null });
    session.meta.chatUrl =
      session.chatUrl || "https://chatgpt.com/c/keyed-continuation";
    session.meta.rawCurrentNode = `node-${calls.length}`;
    return calls.length === 1 ? "First answer" : "Second answer";
  };
  const firstMessages = [
    { role: "system", content: "System context" },
    { role: "user", content: "First request" },
  ];
  await runWithToolRetry(
    messagesToPrompt(firstMessages),
    [],
    firstMessages,
    undefined,
    null,
    null,
    null,
    null,
    backend,
    { conversationKey: key, conversationDeltaStart: 1 },
  );

  const nextMessages = [
    ...firstMessages,
    { role: "assistant", content: "First answer" },
    { role: "user", content: "Only this is new" },
  ];
  await runWithToolRetry(
    messagesToPrompt(nextMessages),
    [],
    nextMessages,
    undefined,
    null,
    null,
    null,
    null,
    backend,
    { conversationKey: key, conversationDeltaStart: 3 },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].chatUrl, "https://chatgpt.com/c/keyed-continuation");
  assert.match(calls[1].prompt, /Only this is new/);
  assert.doesNotMatch(calls[1].prompt, /First request/);
});
