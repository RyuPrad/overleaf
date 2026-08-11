export function activeSessionStorageKey(projectId: string, boardId: string) {
  return `whiteboard-ai-active-session:${projectId}:${boardId}`;
}

export function selectSessionId(
  sessions: ReadonlyArray<{ id: string }>,
  preferredSessionId?: string | null,
  storedSessionId?: string | null,
) {
  for (const candidate of [preferredSessionId, storedSessionId]) {
    if (candidate && sessions.some((session) => session.id === candidate)) {
      return candidate;
    }
  }
  return sessions[0]?.id ?? null;
}
