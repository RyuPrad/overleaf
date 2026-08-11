import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import RailPanelHeader from "@/features/ide-react/components/rail/rail-panel-header";
import { usePermissionsContext } from "@/features/ide-react/context/permissions-context";
import { useProjectContext } from "@/shared/context/project-context";
import { useFileTreeData } from "@/shared/context/file-tree-data-context";
import {
  deleteJSON,
  FetchError,
  getJSON,
  postJSON,
  putJSON,
} from "@/infrastructure/fetch-json";
import customLocalStorage from "@/infrastructure/local-storage";
import { useWhiteboardEditor } from "../whiteboard-editor-context";
import { WhiteboardSceneAction } from "../scene-actions";
import { WhiteboardRecordPatch } from "../whiteboard-editor-context";
import { activeSessionStorageKey, selectSessionId } from "./session-selection";

type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  transactionId: string | null;
  createdAt: string;
};

type AssistantTransaction = {
  id: string;
  boardId: string;
  title: string;
  explanation: string;
  boardActions: WhiteboardSceneAction[];
  boardPatch: WhiteboardRecordPatch[];
  hasTexChange: boolean;
  requestedMode: "direct" | "suggest";
  effectiveMode: "direct" | "suggest";
  forcedSuggest: boolean;
  status: "proposed" | "applied" | "undone" | "rejected";
  createdAt: string;
};

type AssistantSessionSummary = {
  id: string;
  title: string;
  boardId: string;
  linkedDocId: string | null;
  mode: "direct" | "suggest";
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

type AssistantSession = AssistantSessionSummary & {
  messages: AssistantMessage[];
};

type AssistantState = {
  session: AssistantSession;
  transactions: AssistantTransaction[];
};

export default function WhiteboardAssistantPane() {
  const { projectId } = useProjectContext();
  const { write } = usePermissionsContext();
  const { docs } = useFileTreeData();
  const {
    activeBoardId,
    capture,
    apply,
    preview,
    clearPreview,
    exportTikz,
    importTikz,
    canUndo,
    undo,
  } = useWhiteboardEditor();
  const [sessions, setSessions] = useState<AssistantSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [state, setState] = useState<AssistantState | null>(null);
  const [mode, setMode] = useState<"direct" | "suggest">("suggest");
  const [linkedDocId, setLinkedDocId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSequence = useRef(0);

  const texDocs = useMemo(
    () =>
      docs?.filter((item) => item.path.toLowerCase().endsWith(".tex")) ?? [],
    [docs],
  );

  const basePath = activeBoardId
    ? `/project/${projectId}/whiteboard-ai/${activeBoardId}`
    : null;
  const storageKey = activeBoardId
    ? activeSessionStorageKey(projectId, activeBoardId)
    : null;
  const sessionPath =
    basePath && activeSessionId
      ? `${basePath}/sessions/${activeSessionId}`
      : null;

  const selectSessionState = useCallback((next: AssistantState) => {
    setState(next);
    setMode(next.session.mode);
    setLinkedDocId(next.session.linkedDocId ?? "");
  }, []);

  const rememberSelection = useCallback(
    (sessionId: string | null) => {
      if (!storageKey) return;
      if (sessionId) customLocalStorage.setItem(storageKey, sessionId);
      else customLocalStorage.removeItem(storageKey);
    },
    [storageKey],
  );

  const mergeSessionSummary = useCallback((session: AssistantSession) => {
    setSessions((current) =>
      [
        summaryFromSession(session),
        ...current.filter((item) => item.id !== session.id),
      ].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    );
  }, []);

  const loadBoard = useCallback(
    async (preferredSessionId?: string | null, retryMissing = true) => {
      const sequence = ++loadSequence.current;
      clearPreview();
      if (!basePath) {
        setSessions([]);
        setActiveSessionId(null);
        setState(null);
        return;
      }

      const response = await getJSON<{ sessions: AssistantSessionSummary[] }>(
        `${basePath}/sessions`,
      );
      if (sequence !== loadSequence.current) return;

      let nextSessions = response.sessions;
      let storedSessionId: string | null = null;
      if (storageKey) {
        const stored = customLocalStorage.getItem(storageKey);
        storedSessionId = typeof stored === "string" ? stored : null;
      }
      let selectedId = selectSessionId(
        nextSessions,
        preferredSessionId,
        storedSessionId,
      );

      if (!selectedId && write) {
        const created = await postJSON<{ session: AssistantSession }>(
          `${basePath}/sessions`,
          { body: {} },
        );
        if (sequence !== loadSequence.current) return;
        nextSessions = [summaryFromSession(created.session)];
        selectedId = created.session.id;
      }

      setSessions(nextSessions);
      setActiveSessionId(selectedId ?? null);
      rememberSelection(selectedId ?? null);
      if (!selectedId) {
        setState(null);
        return;
      }

      try {
        const next = await getJSON<AssistantState>(
          `${basePath}/sessions/${selectedId}`,
        );
        if (sequence !== loadSequence.current) return;
        selectSessionState(next);
      } catch (cause) {
        if (retryMissing && isNotFound(cause)) {
          await loadBoard(null, false);
          return;
        }
        throw cause;
      }
    },
    [
      basePath,
      clearPreview,
      rememberSelection,
      selectSessionState,
      storageKey,
      write,
    ],
  );

  const loadSession = useCallback(
    async (sessionId = activeSessionId) => {
      if (!basePath || !sessionId) return;
      const sequence = ++loadSequence.current;
      try {
        const next = await getJSON<AssistantState>(
          `${basePath}/sessions/${sessionId}`,
        );
        if (sequence !== loadSequence.current) return;
        selectSessionState(next);
        mergeSessionSummary(next.session);
      } catch (cause) {
        if (isNotFound(cause)) {
          await loadBoard(null);
          return;
        }
        throw cause;
      }
    },
    [
      activeSessionId,
      basePath,
      loadBoard,
      mergeSessionSummary,
      selectSessionState,
    ],
  );

  useEffect(() => {
    setError(null);
    setState(null);
    setSessions([]);
    setActiveSessionId(null);
    loadBoard().catch((cause) => setError(errorMessage(cause)));
    return () => {
      loadSequence.current += 1;
    };
  }, [loadBoard]);

  const switchSession = useCallback(
    async (sessionId: string) => {
      if (!sessionId || sessionId === activeSessionId || busy) return;
      setBusy(true);
      setError(null);
      clearPreview();
      setState(null);
      setActiveSessionId(sessionId);
      rememberSelection(sessionId);
      try {
        await loadSession(sessionId);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [activeSessionId, busy, clearPreview, loadSession, rememberSelection],
  );

  const newSession = useCallback(async () => {
    if (!basePath || !write || busy) return;
    setBusy(true);
    setError(null);
    clearPreview();
    try {
      const response = await postJSON<{ session: AssistantSession }>(
        `${basePath}/sessions`,
        {
          body: {
            ...(activeSessionId
              ? { inheritFromSessionId: activeSessionId }
              : {}),
          },
        },
      );
      setActiveSessionId(response.session.id);
      rememberSelection(response.session.id);
      selectSessionState({ session: response.session, transactions: [] });
      mergeSessionSummary(response.session);
      setPrompt("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [
    activeSessionId,
    basePath,
    busy,
    clearPreview,
    mergeSessionSummary,
    rememberSelection,
    selectSessionState,
    write,
  ]);

  const renameActiveSession = useCallback(async () => {
    if (!sessionPath || !state || !write || busy) return;
    const title = window.prompt("Rename this chat", state.session.title);
    if (title == null) return;
    const normalized = title.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length > 80) {
      setError("Chat title must be between 1 and 80 characters");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await putJSON<{ session: AssistantSession }>(
        `${sessionPath}/title`,
        { body: { title: normalized } },
      );
      setState((current) =>
        current ? { ...current, session: response.session } : current,
      );
      mergeSessionSummary(response.session);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, mergeSessionSummary, sessionPath, state, write]);

  const deleteActiveSession = useCallback(async () => {
    if (!sessionPath || !state || !write || busy) return;
    if (
      !window.confirm(
        `Delete “${state.session.title}”?\n\nThis permanently removes its local chat and proposals. It does not delete ChatGPT account history or undo changes already applied to the board or TeX files.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    clearPreview();
    try {
      await deleteJSON(sessionPath);
      rememberSelection(null);
      setState(null);
      setActiveSessionId(null);
      await loadBoard(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    clearPreview,
    loadBoard,
    rememberSelection,
    sessionPath,
    state,
    write,
  ]);

  const saveSettings = useCallback(
    async (nextMode: "direct" | "suggest", nextLinkedDocId: string) => {
      if (!sessionPath || !write) return;
      const response = await putJSON<{ session: AssistantSession }>(
        `${sessionPath}/settings`,
        {
          body: {
            mode: nextMode,
            linkedDocId: nextLinkedDocId || null,
          },
        },
      );
      setState((current) =>
        current ? { ...current, session: response.session } : current,
      );
      mergeSessionSummary(response.session);
    },
    [mergeSessionSummary, sessionPath, write],
  );

  const applyTransaction = useCallback(
    async (transaction: AssistantTransaction) => {
      if (!sessionPath || !write) return;
      const patch = apply(transaction.boardActions, transaction.id);
      try {
        await postJSON(`${sessionPath}/transactions/${transaction.id}/commit`, {
          body: { boardPatch: patch },
        });
      } catch (cause) {
        undo(patch, transaction.id);
        throw cause;
      }
      await loadSession();
    },
    [apply, loadSession, sessionPath, undo, write],
  );

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!sessionPath || !prompt.trim() || busy || !write) return;
      setBusy(true);
      setError(null);
      try {
        const snapshot = await capture();
        const response = await postJSON<{
          session: AssistantSession;
          transaction: AssistantTransaction;
        }>(`${sessionPath}/proposals`, {
          body: {
            prompt: prompt.trim(),
            scene: snapshot.scene,
            image:
              (state?.session.messages.length ?? 0) === 0
                ? snapshot.image
                : null,
            mode,
            linkedDocId: linkedDocId || null,
          },
        });
        setPrompt("");
        selectSessionState({
          session: response.session,
          transactions: [response.transaction, ...(state?.transactions ?? [])],
        });
        mergeSessionSummary(response.session);
        if (response.transaction.effectiveMode === "direct") {
          await applyTransaction(response.transaction);
        }
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [
      applyTransaction,
      busy,
      capture,
      linkedDocId,
      mergeSessionSummary,
      mode,
      prompt,
      selectSessionState,
      sessionPath,
      state,
      write,
    ],
  );

  const runTransactionAction = useCallback(
    async (
      transaction: AssistantTransaction,
      action: "accept" | "preview" | "reject" | "undo",
    ) => {
      if (!sessionPath || busy || !write) return;
      setBusy(true);
      setError(null);
      try {
        if (action === "accept") {
          await applyTransaction(transaction);
        } else if (action === "preview") {
          preview(transaction.boardActions, transaction.id);
        } else if (action === "reject") {
          clearPreview();
          await postJSON(
            `${sessionPath}/transactions/${transaction.id}/reject`,
            { body: {} },
          );
          await loadSession();
        } else {
          canUndo(transaction.boardPatch);
          const updated = await postJSON<AssistantTransaction>(
            `${sessionPath}/transactions/${transaction.id}/undo`,
            { body: {} },
          );
          undo(updated.boardPatch, transaction.id);
          await loadSession();
        }
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
    },
    [
      applyTransaction,
      busy,
      canUndo,
      clearPreview,
      loadSession,
      preview,
      sessionPath,
      undo,
      write,
    ],
  );

  const downloadTikz = useCallback(() => {
    try {
      const blob = new Blob([exportTikz()], { type: "text/x-tex" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `whiteboard-${activeBoardId ?? "board"}.tikz.tex`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [activeBoardId, exportTikz]);

  const uploadTikz = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      if (file.size > 2_000_000) {
        setError("TikZ imports are limited to 2 MB");
        return;
      }
      if (!window.confirm("Replace the current board with this TikZ import?")) {
        return;
      }
      try {
        const warnings = importTikz(await file.text());
        setError(warnings.length > 0 ? warnings.join(" ") : null);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [importTikz],
  );

  return (
    <div className="whiteboard-assistant-panel d-flex flex-column h-100">
      <RailPanelHeader title="Whiteboard Assistant" />
      <div className="d-flex gap-2 align-items-center p-2 border-bottom">
        <label className="visually-hidden" htmlFor="whiteboard-ai-session">
          Chat session
        </label>
        <select
          id="whiteboard-ai-session"
          className="form-select form-select-sm flex-grow-1"
          value={activeSessionId ?? ""}
          disabled={!activeBoardId || sessions.length === 0 || busy}
          onChange={(event) => switchSession(event.target.value)}
        >
          {sessions.length === 0 && <option value="">No chats</option>}
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.title} · {shortDate(session.updatedAt)}
            </option>
          ))}
        </select>
        {write && (
          <button
            type="button"
            className="btn btn-outline-primary btn-sm text-nowrap"
            disabled={!activeBoardId || busy}
            onClick={newSession}
          >
            New Chat
          </button>
        )}
        {write && activeSessionId && (
          <details className="dropdown">
            <summary
              className="btn btn-outline-secondary btn-sm list-unstyled"
              aria-label="Chat actions"
            >
              ⋯
            </summary>
            <div className="dropdown-menu dropdown-menu-end show">
              <button
                type="button"
                className="dropdown-item"
                disabled={busy}
                onClick={renameActiveSession}
              >
                Rename
              </button>
              <button
                type="button"
                className="dropdown-item text-danger"
                disabled={busy}
                onClick={deleteActiveSession}
              >
                Delete
              </button>
            </div>
          </details>
        )}
      </div>

      <div className="p-3 border-bottom">
        <label className="form-label" htmlFor="whiteboard-ai-mode">
          Apply mode
        </label>
        <select
          id="whiteboard-ai-mode"
          className="form-select form-select-sm mb-3"
          value={mode}
          disabled={!state || busy || !write}
          onChange={(event) => {
            const next = event.target.value as "direct" | "suggest";
            setMode(next);
            saveSettings(next, linkedDocId).catch((cause) =>
              setError(errorMessage(cause)),
            );
          }}
        >
          <option value="suggest">Suggest</option>
          <option value="direct">Direct</option>
        </select>
        <label className="form-label" htmlFor="whiteboard-ai-linked-doc">
          Linked writable TeX file
        </label>
        <select
          id="whiteboard-ai-linked-doc"
          className="form-select form-select-sm"
          value={linkedDocId}
          disabled={!state || busy || !write}
          onChange={(event) => {
            const next = event.target.value;
            setLinkedDocId(next);
            saveSettings(mode, next).catch((cause) =>
              setError(errorMessage(cause)),
            );
          }}
        >
          <option value="">Board only</option>
          {texDocs.map((item) => (
            <option key={item.doc.id} value={item.doc.id}>
              {item.path}
            </option>
          ))}
        </select>
        <div className="form-text">
          Other project files are sent as read-only context. Deletions always
          require review.
        </div>
        <div className="d-flex gap-2 mt-3">
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            disabled={!activeBoardId || busy}
            onClick={downloadTikz}
          >
            Export TikZ
          </button>
          {write && (
            <label className="btn btn-outline-secondary btn-sm mb-0">
              Import TikZ
              <input
                type="file"
                className="visually-hidden"
                accept=".tex,.tikz,text/plain,text/x-tex"
                disabled={!activeBoardId || busy}
                onChange={uploadTikz}
              />
            </label>
          )}
        </div>
      </div>

      <div className="flex-grow-1 overflow-auto p-3" aria-live="polite">
        {!activeBoardId && (
          <p className="text-muted">
            Open a whiteboard to view shared AI chats.
          </p>
        )}
        {activeBoardId && !state && sessions.length === 0 && !write && (
          <p className="text-muted">There are no AI chats for this board.</p>
        )}
        {state?.session.messages.map((message) => (
          <div key={message.id} className="mb-3">
            <div className="small fw-bold">
              {message.role === "user" ? "You" : "Assistant"}
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{message.text}</div>
          </div>
        ))}
        {state?.transactions.map((transaction) => (
          <TransactionCard
            key={transaction.id}
            transaction={transaction}
            busy={busy || !write}
            onAction={(action) => runTransactionAction(transaction, action)}
          />
        ))}
      </div>

      {error && (
        <div className="alert alert-danger m-2 py-2" role="alert">
          {error}
        </div>
      )}
      <form className="border-top p-3" onSubmit={submit}>
        <label className="visually-hidden" htmlFor="whiteboard-ai-prompt">
          Ask the whiteboard assistant
        </label>
        <textarea
          id="whiteboard-ai-prompt"
          className="form-control mb-2"
          rows={3}
          maxLength={16000}
          placeholder="Create, explain, plot, or update the linked TeX…"
          value={prompt}
          disabled={!state || busy || !write}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <button
          type="submit"
          className="btn btn-primary btn-sm w-100"
          disabled={!state || !prompt.trim() || busy || !write}
        >
          {busy
            ? "Working…"
            : mode === "direct"
              ? "Ask and apply"
              : "Ask for draft"}
        </button>
      </form>
    </div>
  );
}

function TransactionCard({
  transaction,
  busy,
  onAction,
}: {
  transaction: AssistantTransaction;
  busy: boolean;
  onAction: (action: "accept" | "preview" | "reject" | "undo") => void;
}) {
  return (
    <section className="card mb-3" aria-label={transaction.title}>
      <div className="card-body p-3">
        <div className="d-flex justify-content-between gap-2">
          <strong>{transaction.title}</strong>
          <span className="badge text-bg-secondary">{transaction.status}</span>
        </div>
        {transaction.forcedSuggest && (
          <p className="small text-warning mt-2 mb-0">
            Review required because this proposal removes content.
          </p>
        )}
        <p className="small mt-2 mb-2">
          {transaction.boardActions.length} board action(s)
          {transaction.hasTexChange ? " and a linked TeX edit" : ""}
        </p>
        {transaction.status === "proposed" && (
          <div className="d-flex gap-2">
            <button
              type="button"
              className="btn btn-outline-primary btn-sm"
              disabled={busy}
              onClick={() => onAction("preview")}
            >
              Preview
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => onAction("accept")}
            >
              Accept
            </button>
            <button
              type="button"
              className="btn btn-outline-secondary btn-sm"
              disabled={busy}
              onClick={() => onAction("reject")}
            >
              Reject
            </button>
          </div>
        )}
        {transaction.status === "applied" && (
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            disabled={busy}
            onClick={() => onAction("undo")}
          >
            Undo transaction
          </button>
        )}
      </div>
    </section>
  );
}

function summaryFromSession(
  session: AssistantSession,
): AssistantSessionSummary {
  return {
    id: session.id,
    title: session.title,
    boardId: session.boardId,
    linkedDocId: session.linkedDocId,
    mode: session.mode,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function shortDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isNotFound(cause: unknown) {
  return cause instanceof FetchError && cause.response?.status === 404;
}

function errorMessage(cause: unknown) {
  return cause instanceof FetchError
    ? cause.getUserFacingMessage()
    : cause instanceof Error
      ? cause.message
      : "The assistant request failed";
}
