import { expect } from "chai";
import {
  activeSessionStorageKey,
  selectSessionId,
} from "@/features/whiteboard/assistant/session-selection";

describe("whiteboard assistant session selection", function () {
  const sessions = [{ id: "newest" }, { id: "older" }];

  it("keeps the active chat separate for each project and board", function () {
    expect(activeSessionStorageKey("project-a", "board-a")).to.equal(
      "whiteboard-ai-active-session:project-a:board-a",
    );
    expect(activeSessionStorageKey("project-a", "board-b")).not.to.equal(
      activeSessionStorageKey("project-a", "board-a"),
    );
  });

  it("prefers an explicit valid session, then a stored session", function () {
    expect(selectSessionId(sessions, "older", "newest")).to.equal("older");
    expect(selectSessionId(sessions, "deleted", "older")).to.equal("older");
  });

  it("falls back to the most recent session when a collaborator deleted the selection", function () {
    expect(selectSessionId(sessions, null, "deleted")).to.equal("newest");
    expect(selectSessionId([], null, "deleted")).to.equal(null);
  });
});
