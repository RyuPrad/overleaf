import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Editor,
  RecordsDiff,
  TLRecord,
  TLShapeId,
  Tldraw,
  createShapeId,
  isShape,
  squashRecordDiffs,
} from 'tldraw'
import { getAssetUrlsByMetaUrl } from '@tldraw/assets/urls'
import 'tldraw/tldraw.css'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import { usePermissionsContext } from '@/features/ide-react/context/permissions-context'
import {
  createWhiteboardStore,
  reconcileWhiteboardStore,
  serializeWhiteboardDiff,
  serializeWhiteboardSnapshot,
  shouldCompactWhiteboard,
} from '@/features/whiteboard/persistence'
import { WHITEBOARD_SHAPE_UTILS } from '@/features/whiteboard/shapes'
import { focusSceneRecords } from '@/features/whiteboard/scene-actions'
import {
  applySceneActions,
  useWhiteboardEditor,
  WhiteboardRecordPatch,
} from '@/features/whiteboard/whiteboard-editor-context'
import {
  exportWhiteboardToTikz,
  importWhiteboardFromTikz,
  TikzImportItem,
} from '@/features/whiteboard/tikz'

const LOCAL_FLUSH_DELAY = 120
const TLDRAW_ASSET_URLS = getAssetUrlsByMetaUrl()

export default function TldrawEditor() {
  const { currentDocument, currentDocumentId } = useEditorOpenDocContext()
  const { write } = usePermissionsContext()
  const { registerBoard } = useWhiteboardEditor()
  const store = useMemo(() => createWhiteboardStore(), [])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [previewTransactionId, setPreviewTransactionId] = useState<
    string | null
  >(null)
  const pendingDiffs = useRef<RecordsDiff<TLRecord>[]>([])
  const flushTimer = useRef<number | null>(null)
  const writeRef = useRef(write)
  const activeTransactionId = useRef<string | null>(null)
  const previewPatch = useRef<WhiteboardRecordPatch[]>([])

  writeRef.current = write

  const clearFlushTimer = useCallback(() => {
    if (flushTimer.current !== null) {
      window.clearTimeout(flushTimer.current)
      flushTimer.current = null
    }
  }, [])

  const flushPendingDiffs = useCallback(() => {
    clearFlushTimer()
    if (!writeRef.current) {
      pendingDiffs.current = []
      return
    }

    if (!currentDocument || pendingDiffs.current.length === 0) {
      return
    }

    const diff = squashRecordDiffs(pendingDiffs.current)
    pendingDiffs.current = []
    const line = serializeWhiteboardDiff(diff, {
      source: activeTransactionId.current ? 'ai' : 'user',
      transactionId: activeTransactionId.current ?? undefined,
    })
    if (!line) {
      return
    }

    const snapshot = currentDocument.getSnapshot() ?? ''
    if (shouldCompactWhiteboard(`${snapshot}${line}`)) {
      currentDocument.submitOp({
        p: 0,
        d: snapshot,
        i: serializeWhiteboardSnapshot(store),
      })
    } else {
      currentDocument.submitOp({ p: snapshot.length, i: line })
    }
  }, [clearFlushTimer, currentDocument, store])

  useEffect(() => {
    if (!editor || !currentDocumentId) return
    const clearPreview = () => {
      if (previewPatch.current.length === 0) return
      store.mergeRemoteChanges(() => {
        restoreRecordPatch(editor, previewPatch.current, false)
      })
      previewPatch.current = []
      setPreviewTransactionId(null)
    }
    return registerBoard({
      boardId: currentDocumentId,
      editor,
      apply(actions, transactionId) {
        clearPreview()
        flushPendingDiffs()
        const before = new Map(
          editor.getCurrentPageShapes().map(shape => [shape.id, shape])
        )
        activeTransactionId.current = transactionId
        try {
          applySceneActions(editor, actions, {
            historyMark: `AI transaction ${transactionId}`,
          })
          flushPendingDiffs()
          const after = new Map(
            editor.getCurrentPageShapes().map(shape => [shape.id, shape])
          )
          return createRecordPatch(before, after)
        } finally {
          activeTransactionId.current = null
        }
      },
      preview(actions, transactionId) {
        clearPreview()
        const before = new Map(
          editor.getCurrentPageShapes().map(shape => [shape.id, shape])
        )
        store.mergeRemoteChanges(() => {
          applySceneActions(editor, actions, {
            historyMark: `AI draft ${transactionId}`,
          })
        })
        const after = new Map(
          editor.getCurrentPageShapes().map(shape => [shape.id, shape])
        )
        previewPatch.current = createRecordPatch(before, after)
        setPreviewTransactionId(transactionId)
        focusSceneRecords(
          editor,
          previewPatch.current.map(entry => entry.after)
        )
      },
      clearPreview,
      focus(patch) {
        focusSceneRecords(
          editor,
          patch.map(entry => entry.after)
        )
      },
      exportTikz() {
        clearPreview()
        return exportWhiteboardToTikz({
          boardId: currentDocumentId,
          records: Object.values(store.serialize('document')),
        })
      },
      importTikz(source) {
        clearPreview()
        const result = importWhiteboardFromTikz(source)
        flushPendingDiffs()
        activeTransactionId.current = `import:${crypto.randomUUID()}`
        try {
          const currentShapeIds = editor.getCurrentPageShapeIds()
          if (currentShapeIds.size > 0) {
            editor.deleteShapes([...currentShapeIds])
          }
          if (result.kind === 'round-trip') {
            const shapes = result.records.filter(isShape)
            if (shapes.length > 0) editor.store.put(shapes)
          } else {
            applySceneActions(editor, result.items.map(tikzItemToAction), {
              historyMark: 'Import TikZ',
            })
          }
          flushPendingDiffs()
        } finally {
          activeTransactionId.current = null
        }
        return result.warnings
      },
      canUndo(patch) {
        validateRecordPatch(editor, patch)
      },
      undo(patch, transactionId) {
        clearPreview()
        flushPendingDiffs()
        activeTransactionId.current = `undo:${transactionId}`
        try {
          restoreRecordPatch(editor, patch)
          flushPendingDiffs()
        } finally {
          activeTransactionId.current = null
        }
      },
    })
  }, [currentDocumentId, editor, flushPendingDiffs, registerBoard, store])

  const scheduleFlush = useCallback(() => {
    clearFlushTimer()
    flushTimer.current = window.setTimeout(flushPendingDiffs, LOCAL_FLUSH_DELAY)
  }, [clearFlushTimer, flushPendingDiffs])

  useEffect(() => {
    if (!editor) {
      return
    }

    editor.updateInstanceState({ isReadonly: !write || syncError !== null })
  }, [editor, syncError, write])

  useEffect(() => {
    if (!editor || !currentDocument) {
      return
    }

    const syncFromDocument = () => {
      try {
        reconcileWhiteboardStore(store, currentDocument.getSnapshot() ?? '')
        setSyncError(null)
        editor.updateInstanceState({ isReadonly: !write })
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Unable to load whiteboard data'
        setSyncError(message)
        editor.updateInstanceState({ isReadonly: true })
      }
    }

    syncFromDocument()

    const stopListening = store.listen(
      entry => {
        pendingDiffs.current.push(entry.changes)
        scheduleFlush()
      },
      { source: 'user', scope: 'document' }
    )

    const onRemoteOp = () => {
      // Persist any local changes first so canonical replay cannot erase edits
      // that are still waiting in the short batching window.
      flushPendingDiffs()
      previewPatch.current = []
      setPreviewTransactionId(null)
      syncFromDocument()
    }

    currentDocument.on('remoteop.tldraw', onRemoteOp)

    return () => {
      stopListening()
      currentDocument.off('remoteop.tldraw', onRemoteOp)
      previewPatch.current = []
      flushPendingDiffs()
      clearFlushTimer()
    }
  }, [
    clearFlushTimer,
    currentDocument,
    editor,
    flushPendingDiffs,
    scheduleFlush,
    store,
    write,
  ])

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Tldraw
        assetUrls={TLDRAW_ASSET_URLS}
        shapeUtils={WHITEBOARD_SHAPE_UTILS}
        store={store}
        onMount={mountedEditor => {
          setEditor(mountedEditor)
        }}
      />
      {syncError && (
        <div
          role="alert"
          style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            maxWidth: 560,
            padding: '8px 12px',
            borderRadius: 4,
            background: 'var(--bg-danger-01)',
            color: 'var(--content-primary)',
            boxShadow: '0 2px 8px rgb(0 0 0 / 20%)',
          }}
        >
          Whiteboard is read-only: {syncError}
        </div>
      )}
      {previewTransactionId && (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 1000,
            padding: '8px 12px',
            borderRadius: 4,
            background: '#fff7d6',
            color: '#553f00',
            boxShadow: '0 2px 8px rgb(0 0 0 / 20%)',
          }}
        >
          AI draft preview — not saved
        </div>
      )}
    </div>
  )
}

function createRecordPatch(
  before: Map<string, TLRecord>,
  after: Map<string, TLRecord>
): WhiteboardRecordPatch[] {
  const ids = new Set([...before.keys(), ...after.keys()])
  return [...ids].flatMap(id => {
    const previous = before.get(id) ?? null
    const next = after.get(id) ?? null
    if (JSON.stringify(previous) === JSON.stringify(next)) return []
    return [{ id, before: previous, after: next }]
  })
}

function restoreRecordPatch(
  editor: Editor,
  patch: WhiteboardRecordPatch[],
  recordHistory = true
) {
  validateRecordPatch(editor, patch)

  if (recordHistory) {
    editor.markHistoryStoppingPoint('Undo AI whiteboard transaction')
  }
  const remove = patch
    .filter(entry => entry.before === null)
    .map(entry => entry.id as TLShapeId)
  const put = patch.flatMap(entry => (entry.before ? [entry.before] : []))
  if (remove.length > 0) editor.store.remove(remove)
  if (put.length > 0) editor.store.put(put)
}

function validateRecordPatch(editor: Editor, patch: WhiteboardRecordPatch[]) {
  for (const entry of patch) {
    const current = editor.store.get(entry.id as TLRecord['id']) ?? null
    if (JSON.stringify(current) !== JSON.stringify(entry.after)) {
      throw new Error(`Shape ${entry.id} changed after the AI transaction`)
    }
  }
}

function tikzItemToAction(item: TikzImportItem) {
  if (item.type === 'geo') {
    return {
      type: 'create' as const,
      shape: {
        id: createShapeId(),
        type: 'geo' as const,
        x: item.x,
        y: item.y,
        props: { geo: item.geo, w: item.w, h: item.h },
      },
    }
  }
  if (item.type === 'arrow') {
    return {
      type: 'create' as const,
      shape: {
        id: createShapeId(),
        type: 'arrow' as const,
        x: item.x1,
        y: item.y1,
        props: {
          start: { x: 0, y: 0 },
          end: { x: item.x2 - item.x1, y: item.y2 - item.y1 },
        },
      },
    }
  }
  if (item.type === 'plot') {
    const { expression, xMin, xMax, yMin, yMax } = item
    return {
      type: 'create' as const,
      shape: {
        id: createShapeId(),
        type: 'plot' as const,
        x: 0,
        y: 0,
        props: { expression, xMin, xMax, yMin, yMax },
      },
    }
  }
  if (item.type === 'source-fragment') {
    return {
      type: 'create' as const,
      shape: {
        id: createShapeId(),
        type: 'text' as const,
        x: 0,
        y: 0,
        props: { text: item.warning },
        meta: { tikzSourceFragment: item.source },
      },
    }
  }
  return {
    type: 'create' as const,
    shape: {
      id: createShapeId(),
      type: item.type,
      x: item.x,
      y: item.y,
      props:
        item.type === 'latex' ? { latex: item.value } : { text: item.value },
    },
  }
}
