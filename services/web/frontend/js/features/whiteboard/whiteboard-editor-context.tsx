import {
  FC,
  PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { Editor, TLRecord } from "tldraw";
import {
  WhiteboardSceneAction,
  applySceneActions,
  captureScenePng,
  serializeScene,
} from "./scene-actions";

type BoardHandle = {
  boardId: string;
  editor: Editor;
  apply: (
    actions: WhiteboardSceneAction[],
    transactionId: string,
  ) => WhiteboardRecordPatch[];
  preview: (actions: WhiteboardSceneAction[], transactionId: string) => void;
  clearPreview: () => void;
  focus: (patch: WhiteboardRecordPatch[]) => void;
  exportTikz: () => string;
  importTikz: (source: string) => string[];
  canUndo: (patch: WhiteboardRecordPatch[]) => void;
  undo: (patch: WhiteboardRecordPatch[], transactionId: string) => void;
};

export type WhiteboardRecordPatch = {
  id: string;
  before: TLRecord | null;
  after: TLRecord | null;
};

type WhiteboardEditorContextValue = {
  activeBoardId: string | null;
  registerBoard: (handle: BoardHandle) => () => void;
  capture: () => Promise<{
    boardId: string;
    scene: ReturnType<typeof serializeScene>;
    image: string | null;
  }>;
  apply: (
    actions: WhiteboardSceneAction[],
    transactionId: string,
  ) => WhiteboardRecordPatch[];
  preview: (actions: WhiteboardSceneAction[], transactionId: string) => void;
  clearPreview: () => void;
  focus: (patch: WhiteboardRecordPatch[]) => void;
  exportTikz: () => string;
  importTikz: (source: string) => string[];
  canUndo: (patch: WhiteboardRecordPatch[]) => void;
  undo: (patch: WhiteboardRecordPatch[], transactionId: string) => void;
};

const WhiteboardEditorContext = createContext<
  WhiteboardEditorContextValue | undefined
>(undefined);

export const WhiteboardEditorProvider: FC<PropsWithChildren> = ({
  children,
}) => {
  const [handle, setHandle] = useState<BoardHandle | null>(null);

  const registerBoard = useCallback((next: BoardHandle) => {
    setHandle(next);
    return () => setHandle((current) => (current === next ? null : current));
  }, []);

  const capture = useCallback(async () => {
    if (!handle)
      throw new Error("Open a whiteboard before asking the assistant");
    const image = await captureScenePng(handle.editor);
    return {
      boardId: handle.boardId,
      scene: serializeScene(handle.editor),
      image: image && image.length <= 900_000 ? image : null,
    };
  }, [handle]);

  const apply = useCallback(
    (actions: WhiteboardSceneAction[], transactionId: string) => {
      if (!handle) throw new Error("The target whiteboard is no longer open");
      return handle.apply(actions, transactionId);
    },
    [handle],
  );

  const preview = useCallback(
    (actions: WhiteboardSceneAction[], transactionId: string) => {
      if (!handle) throw new Error("The target whiteboard is no longer open");
      handle.preview(actions, transactionId);
    },
    [handle],
  );

  const clearPreview = useCallback(() => {
    handle?.clearPreview();
  }, [handle]);

  const focus = useCallback(
    (patch: WhiteboardRecordPatch[]) => {
      if (!handle) throw new Error("The target whiteboard is no longer open");
      handle.focus(patch);
    },
    [handle],
  );

  const exportTikz = useCallback(() => {
    if (!handle) throw new Error("Open a whiteboard before exporting TikZ");
    return handle.exportTikz();
  }, [handle]);

  const importTikz = useCallback(
    (source: string) => {
      if (!handle) throw new Error("Open a whiteboard before importing TikZ");
      return handle.importTikz(source);
    },
    [handle],
  );

  const undo = useCallback(
    (patch: WhiteboardRecordPatch[], transactionId: string) => {
      if (!handle) throw new Error("The target whiteboard is no longer open");
      handle.undo(patch, transactionId);
    },
    [handle],
  );

  const canUndo = useCallback(
    (patch: WhiteboardRecordPatch[]) => {
      if (!handle) throw new Error("The target whiteboard is no longer open");
      handle.canUndo(patch);
    },
    [handle],
  );

  const value = useMemo(
    () => ({
      activeBoardId: handle?.boardId ?? null,
      registerBoard,
      capture,
      apply,
      preview,
      clearPreview,
      focus,
      exportTikz,
      importTikz,
      canUndo,
      undo,
    }),
    [
      apply,
      canUndo,
      capture,
      clearPreview,
      exportTikz,
      focus,
      handle?.boardId,
      importTikz,
      preview,
      registerBoard,
      undo,
    ],
  );

  return (
    <WhiteboardEditorContext.Provider value={value}>
      {children}
    </WhiteboardEditorContext.Provider>
  );
};

export function useWhiteboardEditor() {
  const value = useContext(WhiteboardEditorContext);
  if (!value) {
    throw new Error(
      "useWhiteboardEditor must be used inside WhiteboardEditorProvider",
    );
  }
  return value;
}

export { applySceneActions };
