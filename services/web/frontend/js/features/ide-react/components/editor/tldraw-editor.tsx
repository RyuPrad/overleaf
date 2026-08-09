import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DocumentRecordType,
  Editor,
  IndexKey,
  PageRecordType,
  RecordsDiff,
  TLDOCUMENT_ID,
  TLPageId,
  TLRecord,
  TLStore,
  Tldraw,
  createTLStore,
  squashRecordDiffs,
} from 'tldraw'
import { getAssetUrlsByMetaUrl } from '@tldraw/assets/urls'
import 'tldraw/tldraw.css'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import { usePermissionsContext } from '@/features/ide-react/context/permissions-context'

const TLDRAW_DIFF_FORMAT = 'overleaf-tldraw-diff'
const TLDRAW_DIFF_VERSION = 1
const LOCAL_FLUSH_DELAY = 120
const DEFAULT_PAGE_ID = 'page:page' as TLPageId
const TLDRAW_ASSET_URLS = getAssetUrlsByMetaUrl()

type PersistedTldrawDiff = {
  format: typeof TLDRAW_DIFF_FORMAT
  version: typeof TLDRAW_DIFF_VERSION
  added: TLRecord[]
  updated: TLRecord[]
  removed: string[]
}

function isPersistedTldrawDiff(value: unknown): value is PersistedTldrawDiff {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<PersistedTldrawDiff>
  return (
    candidate.format === TLDRAW_DIFF_FORMAT &&
    candidate.version === TLDRAW_DIFF_VERSION &&
    Array.isArray(candidate.added) &&
    Array.isArray(candidate.updated) &&
    Array.isArray(candidate.removed)
  )
}

function parseDiffLog(snapshot: string): PersistedTldrawDiff[] {
  const diffs: PersistedTldrawDiff[] = []

  for (const [index, line] of snapshot.split('\n').entries()) {
    if (!line.trim()) {
      continue
    }

    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`Invalid whiteboard data on line ${index + 1}`)
    }

    if (!isPersistedTldrawDiff(value)) {
      throw new Error(`Unsupported whiteboard data on line ${index + 1}`)
    }

    diffs.push(value)
  }

  return diffs
}

function putPersistedDiff(store: TLStore, diff: PersistedTldrawDiff) {
  const records = [...diff.added, ...diff.updated]
  if (records.length > 0) {
    store.put(records)
  }
  if (diff.removed.length > 0) {
    store.remove(diff.removed as TLRecord['id'][])
  }
}

function createDocumentRecords(snapshot: string): TLRecord[] {
  const diffs = parseDiffLog(snapshot)
  const validationStore = createTLStore()

  validationStore.mergeRemoteChanges(() => {
    validationStore.put([
      DocumentRecordType.create({ id: TLDOCUMENT_ID, name: '' }),
      PageRecordType.create({
        id: DEFAULT_PAGE_ID,
        name: 'Page 1',
        index: 'a1' as IndexKey,
        meta: {},
      }),
    ])

    for (const diff of diffs) {
      putPersistedDiff(validationStore, diff)
    }
  })

  return Object.values(validationStore.serialize('document'))
}

function reconcileStore(store: TLStore, snapshot: string) {
  const documentRecords = createDocumentRecords(snapshot)
  const existingDocumentIds = Object.keys(store.serialize('document')) as TLRecord['id'][]

  store.mergeRemoteChanges(() => {
    if (existingDocumentIds.length > 0) {
      store.remove(existingDocumentIds)
    }
    store.put(documentRecords)
  })
}

function serializeDiff(diff: RecordsDiff<TLRecord>): string | null {
  const added = Object.values(diff.added)
  const updated = Object.values(diff.updated).map(([, record]) => record)
  const removed = Object.keys(diff.removed)

  if (added.length === 0 && updated.length === 0 && removed.length === 0) {
    return null
  }

  const persistedDiff: PersistedTldrawDiff = {
    format: TLDRAW_DIFF_FORMAT,
    version: TLDRAW_DIFF_VERSION,
    added,
    updated,
    removed,
  }

  return `${JSON.stringify(persistedDiff)}\n`
}

export default function TldrawEditor() {
  const { currentDocument } = useEditorOpenDocContext()
  const { write } = usePermissionsContext()
  const store = useMemo(() => createTLStore(), [])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const pendingDiffs = useRef<RecordsDiff<TLRecord>[]>([])
  const flushTimer = useRef<number | null>(null)
  const writeRef = useRef(write)

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
    const line = serializeDiff(diff)
    if (!line) {
      return
    }

    const snapshot = currentDocument.getSnapshot() ?? ''
    currentDocument.submitOp({ p: snapshot.length, i: line })
  }, [clearFlushTimer, currentDocument])

  const scheduleFlush = useCallback(() => {
    clearFlushTimer()
    flushTimer.current = window.setTimeout(
      flushPendingDiffs,
      LOCAL_FLUSH_DELAY
    )
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
        reconcileStore(store, currentDocument.getSnapshot() ?? '')
        setSyncError(null)
        editor.updateInstanceState({ isReadonly: !write })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unable to load whiteboard data'
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
      syncFromDocument()
    }

    currentDocument.on('remoteop.tldraw', onRemoteOp)

    return () => {
      stopListening()
      currentDocument.off('remoteop.tldraw', onRemoteOp)
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
    </div>
  )
}
