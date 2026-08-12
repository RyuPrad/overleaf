import { expect, vi } from "vitest";

const modulePath =
  "../../../../app/src/Features/WhiteboardAi/WhiteboardAiManager.mjs";
const sessionId = "aaaaaaaaaaaaaaaaaaaaaaaa";

const query = (value) => ({ exec: vi.fn().mockResolvedValue(value) });

describe("WhiteboardAiManager", function () {
  beforeEach(async function (ctx) {
    vi.resetModules();
    ctx.mongoSession = {
      withTransaction: vi.fn(async (callback) => await callback()),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    ctx.WhiteboardAiThread = {
      find: vi.fn(),
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      create: vi.fn(),
      deleteOne: vi.fn(),
      startSession: vi.fn().mockResolvedValue(ctx.mongoSession),
    };
    ctx.WhiteboardAiTransaction = {
      find: vi.fn(),
      findOne: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    };
    ctx.ProjectEntityHandler = {
      promises: {
        getAllDocs: vi.fn().mockResolvedValue({}),
        getAllFiles: vi.fn().mockResolvedValue({}),
      },
    };
    ctx.DocumentUpdaterHandler = {
      promises: { setDocument: vi.fn() },
    };

    vi.doMock("../../../../app/src/models/WhiteboardAiThread.mjs", () => ({
      WhiteboardAiThread: ctx.WhiteboardAiThread,
    }));
    vi.doMock("../../../../app/src/models/WhiteboardAiTransaction.mjs", () => ({
      WhiteboardAiTransaction: ctx.WhiteboardAiTransaction,
    }));
    vi.doMock("@overleaf/settings", () => ({
      default: { apis: { chatgptWeb: { url: "http://sidecar" } } },
    }));
    vi.doMock(
      "../../../../app/src/Features/Project/ProjectEntityHandler.mjs",
      () => ({ default: ctx.ProjectEntityHandler }),
    );
    vi.doMock(
      "../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs",
      () => ({ default: ctx.DocumentUpdaterHandler }),
    );

    ctx.Manager = (await import(modulePath)).default;
  });

  afterEach(function () {
    vi.unstubAllGlobals();
  });

  it("creates a new session with the selected session settings", async function (ctx) {
    ctx.WhiteboardAiThread.findOne.mockReturnValue(
      query({ mode: "direct", linkedDocId: "bbbbbbbbbbbbbbbbbbbbbbbb" }),
    );
    ctx.WhiteboardAiThread.create.mockImplementation(async (value) => value);

    const created = await ctx.Manager.createSession({
      projectId: "project",
      boardId: "board",
      inheritFromSessionId: sessionId,
    });

    expect(created).to.include({ title: "New chat", mode: "direct" });
    expect(created.linkedDocId).to.equal("bbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("keys a first turn to the Overleaf session and sends its screenshot", async function (ctx) {
    const thread = {
      _id: sessionId,
      mode: "suggest",
      linkedDocId: null,
      titleIsCustom: false,
      messages: [],
    };
    const updated = { ...thread, title: "Draw a square" };
    mockProposalPersistence(ctx, thread, updated);
    const fetch = mockSidecar(ctx);

    const result = await ctx.Manager.propose({
      projectId: "project",
      boardId: "board",
      sessionId,
      userId: "user",
      prompt: "  Draw   a square  ",
      scene: [],
      image: "data:image/png;base64,AA==",
      mode: "suggest",
      linkedDocId: null,
    });

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.conversation_key).to.equal(`overleaf:${sessionId}`);
    expect(body.conversation_delta_start).to.equal(1);
    expect(body.messages[1].content).to.be.an("array");
    expect(
      ctx.WhiteboardAiThread.findOneAndUpdate.mock.calls[1][1].$set.title,
    ).to.equal("Draw a square");
    expect(result.session).to.equal(updated);
  });

  it("continues a session with refreshed text context but no later screenshot", async function (ctx) {
    const thread = {
      _id: sessionId,
      mode: "suggest",
      linkedDocId: null,
      titleIsCustom: false,
      messages: [
        { role: "user", text: "First request" },
        { role: "assistant", text: "First response" },
      ],
    };
    mockProposalPersistence(ctx, thread, thread);
    const fetch = mockSidecar(ctx);

    await ctx.Manager.propose({
      projectId: "project",
      boardId: "board",
      sessionId,
      userId: "user",
      prompt: "Second request",
      scene: [{ id: "shape:one" }],
      image: "data:image/png;base64,AA==",
      mode: "suggest",
      linkedDocId: null,
    });

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.conversation_delta_start).to.equal(3);
    expect(body.messages[3].content).to.be.a("string");
    expect(body.messages[3].content).not.to.contain("image_url");
    expect(
      ctx.WhiteboardAiThread.findOneAndUpdate.mock.calls[1][1].$set,
    ).not.to.have.property("title");
  });

  it("prioritizes explicitly mentioned documents and identifies uploaded files", async function (ctx) {
    const thread = {
      _id: sessionId,
      mode: "suggest",
      linkedDocId: null,
      titleIsCustom: false,
      messages: [],
    };
    mockProposalPersistence(ctx, thread, thread);
    ctx.ProjectEntityHandler.promises.getAllDocs.mockResolvedValue({
      "chapters/methods.tex": {
        _id: "bbbbbbbbbbbbbbbbbbbbbbbb",
        lines: ["Explicit methods content"],
      },
      "main.tex": {
        _id: "dddddddddddddddddddddddd",
        lines: ["General project content"],
      },
    });
    ctx.ProjectEntityHandler.promises.getAllFiles.mockResolvedValue({
      "figures/result.png": {
        _id: "eeeeeeeeeeeeeeeeeeeeeeee",
        hash: "hash",
      },
    });
    const fetch = mockSidecar(ctx);

    await ctx.Manager.propose({
      projectId: "project",
      boardId: "board",
      sessionId,
      userId: "user",
      prompt: "Use the mentioned sources",
      scene: [],
      image: null,
      mode: "suggest",
      linkedDocId: null,
      fileReferences: [
        { id: "bbbbbbbbbbbbbbbbbbbbbbbb", kind: "doc" },
        { id: "eeeeeeeeeeeeeeeeeeeeeeee", kind: "file" },
      ],
    });

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const content = JSON.parse(body.messages[1].content);
    expect(content.referencedFiles).to.deep.equal([
      {
        path: "chapters/methods.tex",
        content: "Explicit methods content",
        access: "read-only",
      },
      {
        path: "figures/result.png",
        access: "read-only",
        contentAvailable: false,
        note: "Uploaded project file; path and metadata only",
      },
    ]);
    expect(content.projectContext).to.deep.equal([
      {
        path: "main.tex",
        content: "General project content",
        access: "read-only",
      },
    ]);
  });

  it("rejects references that are not part of the project", async function (ctx) {
    const thread = {
      _id: sessionId,
      mode: "suggest",
      linkedDocId: null,
      titleIsCustom: false,
      messages: [],
    };
    ctx.WhiteboardAiThread.findOneAndUpdate.mockReturnValue(query(thread));

    await expect(
      ctx.Manager.propose({
        projectId: "project",
        boardId: "board",
        sessionId,
        userId: "user",
        prompt: "Use a missing file",
        scene: [],
        image: null,
        mode: "suggest",
        linkedDocId: null,
        fileReferences: [{ id: "ffffffffffffffffffffffff", kind: "doc" }],
      }),
    ).to.be.rejectedWith("A referenced project file was not found");
  });
});

function mockProposalPersistence(ctx, thread, updated) {
  ctx.WhiteboardAiThread.findOneAndUpdate
    .mockReturnValueOnce(query(thread))
    .mockReturnValueOnce(query(updated));
  ctx.WhiteboardAiTransaction.create.mockResolvedValue([
    {
      _id: "cccccccccccccccccccccccc",
      title: "Proposal",
      explanation: "Done",
    },
  ]);
}

function mockSidecar(ctx) {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "propose_transaction",
                  arguments: JSON.stringify({
                    title: "Proposal",
                    explanation: "Done",
                    boardActions: [],
                    texEdits: [],
                  }),
                },
              },
            ],
          },
        },
      ],
    }),
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
