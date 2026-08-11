import { expressify } from "@overleaf/promise-utils";
import SessionManager from "../Authentication/SessionManager.mjs";
import WhiteboardAiManager from "./WhiteboardAiManager.mjs";

async function listSessions(req, res) {
  const { project_id: projectId, board_id: boardId } = req.params;
  const sessions = await WhiteboardAiManager.listSessions(projectId, boardId);
  res.json({ sessions: sessions.map(formatSessionSummary) });
}

async function createSession(req, res) {
  const { project_id: projectId, board_id: boardId } = req.params;
  const session = await WhiteboardAiManager.createSession({
    projectId,
    boardId,
    inheritFromSessionId: req.body.inheritFromSessionId || null,
  });
  res.status(201).json({ session: formatSession(session) });
}

async function getSession(req, res) {
  const { project_id: projectId, board_id: boardId } = req.params;
  const state = await WhiteboardAiManager.getSessionState(
    projectId,
    boardId,
    req.params.session_id,
  );
  res.json({
    session: formatSession(state.session),
    transactions: state.transactions.map(formatTransaction),
  });
}

async function renameSession(req, res) {
  const session = await WhiteboardAiManager.renameSession({
    projectId: req.params.project_id,
    boardId: req.params.board_id,
    sessionId: req.params.session_id,
    title: req.body.title,
  });
  res.json({ session: formatSession(session) });
}

async function updateSettings(req, res) {
  const session = await WhiteboardAiManager.updateSessionSettings({
    projectId: req.params.project_id,
    boardId: req.params.board_id,
    sessionId: req.params.session_id,
    linkedDocId: req.body.linkedDocId || null,
    mode: req.body.mode,
  });
  res.json({ session: formatSession(session) });
}

async function deleteSession(req, res) {
  await WhiteboardAiManager.deleteSession({
    projectId: req.params.project_id,
    boardId: req.params.board_id,
    sessionId: req.params.session_id,
  });
  res.json({ ok: true });
}

async function propose(req, res) {
  const userId = requireUserId(req);
  const result = await WhiteboardAiManager.propose({
    projectId: req.params.project_id,
    boardId: req.params.board_id,
    sessionId: req.params.session_id,
    userId,
    prompt: req.body.prompt,
    scene: req.body.scene,
    image: req.body.image || null,
    mode: req.body.mode,
    linkedDocId: req.body.linkedDocId || null,
  });
  res.json({
    session: formatSession(result.session),
    transaction: formatTransaction(result.transaction),
  });
}

async function commit(req, res) {
  const transaction = await WhiteboardAiManager.commit({
    projectId: req.params.project_id,
    boardId: req.params.board_id,
    sessionId: req.params.session_id,
    transactionId: req.params.transaction_id,
    userId: requireUserId(req),
    boardPatch: req.body.boardPatch || [],
  });
  res.json(formatTransaction(transaction));
}

async function undo(req, res) {
  const transaction = await WhiteboardAiManager.undo({
    projectId: req.params.project_id,
    boardId: req.params.board_id,
    sessionId: req.params.session_id,
    transactionId: req.params.transaction_id,
    userId: requireUserId(req),
  });
  res.json(formatTransaction(transaction));
}

async function reject(req, res) {
  const transaction = await WhiteboardAiManager.reject({
    projectId: req.params.project_id,
    boardId: req.params.board_id,
    sessionId: req.params.session_id,
    transactionId: req.params.transaction_id,
  });
  res.json(formatTransaction(transaction));
}

function requireUserId(req) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  if (!userId) {
    const error = new Error("No logged-in user");
    error.statusCode = 401;
    throw error;
  }
  return userId;
}

function formatSessionSummary(session) {
  return {
    id: String(session._id),
    title: session.title || "New chat",
    boardId: String(session.boardId),
    linkedDocId: session.linkedDocId ? String(session.linkedDocId) : null,
    mode: session.mode,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function formatSession(session) {
  return {
    ...formatSessionSummary(session),
    messages: session.messages.map((message) => ({
      id: message.messageId,
      role: message.role,
      text: message.text,
      transactionId: message.transactionId
        ? String(message.transactionId)
        : null,
      createdAt: message.createdAt,
    })),
  };
}

function formatTransaction(transaction) {
  return {
    id: String(transaction._id),
    boardId: String(transaction.boardId),
    title: transaction.title,
    explanation: transaction.explanation,
    boardActions: transaction.boardActions,
    boardPatch: transaction.boardPatch,
    hasTexChange: Boolean(transaction.texChange?.docId),
    requestedMode: transaction.requestedMode,
    effectiveMode: transaction.effectiveMode,
    forcedSuggest: transaction.forcedSuggest,
    status: transaction.status,
    createdAt: transaction.createdAt,
    appliedAt: transaction.appliedAt,
    undoneAt: transaction.undoneAt,
  };
}

export default {
  listSessions: expressify(listSessions),
  createSession: expressify(createSession),
  getSession: expressify(getSession),
  renameSession: expressify(renameSession),
  updateSettings: expressify(updateSettings),
  deleteSession: expressify(deleteSession),
  propose: expressify(propose),
  commit: expressify(commit),
  undo: expressify(undo),
  reject: expressify(reject),
};
