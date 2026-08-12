import {
  DocumentRecordType,
  IndexKey,
  PageRecordType,
  RecordsDiff,
  TLDOCUMENT_ID,
  TLPageId,
  TLRecord,
  TLStore,
  createTLStore,
  defaultShapeUtils,
} from "tldraw";
import { WHITEBOARD_SHAPE_UTILS } from "./shapes";
import { repairLegacyAssistantTextRecords } from "./text-shape-normalization";

export const TLDRAW_DIFF_FORMAT = "overleaf-tldraw-diff";
export const TLDRAW_SNAPSHOT_FORMAT = "overleaf-tldraw-snapshot";
export const TLDRAW_FORMAT_VERSION = 2;
export const DEFAULT_WHITEBOARD_PAGE_ID = "page:page" as TLPageId;

const COMPACTION_BYTES = 1024 * 1024;
const COMPACTION_ENTRIES = 1000;

type PersistedTldrawDiff = {
  format: typeof TLDRAW_DIFF_FORMAT;
  version: 1 | typeof TLDRAW_FORMAT_VERSION;
  added: TLRecord[];
  updated: TLRecord[];
  removed: string[];
  transactionId?: string;
  source?: "ai" | "user" | "system";
};

type PersistedTldrawSnapshot = {
  format: typeof TLDRAW_SNAPSHOT_FORMAT;
  version: typeof TLDRAW_FORMAT_VERSION;
  records: TLRecord[];
  compactedAt?: string;
};

type PersistedTldrawEntry = PersistedTldrawDiff | PersistedTldrawSnapshot;

export type WhiteboardDiffMetadata = {
  transactionId?: string;
  source?: PersistedTldrawDiff["source"];
};

export function createWhiteboardStore() {
  return createTLStore({
    shapeUtils: [...defaultShapeUtils, ...WHITEBOARD_SHAPE_UTILS],
  });
}

export function createWhiteboardDocumentRecords(snapshot: string): TLRecord[] {
  const validationStore = createWhiteboardStore();

  validationStore.mergeRemoteChanges(() => {
    validationStore.put(createInitialRecords());

    for (const entry of parseWhiteboardEntries(snapshot)) {
      if (entry.format === TLDRAW_SNAPSHOT_FORMAT) {
        replaceDocumentRecords(validationStore, entry.records);
      } else {
        putPersistedDiff(validationStore, entry);
      }
    }
  });

  return Object.values(validationStore.serialize("document"));
}

export function reconcileWhiteboardStore(store: TLStore, snapshot: string) {
  const documentRecords = createWhiteboardDocumentRecords(snapshot);
  store.mergeRemoteChanges(() => {
    replaceDocumentRecords(store, documentRecords);
  });
}

export function serializeWhiteboardDiff(
  diff: RecordsDiff<TLRecord>,
  metadata: WhiteboardDiffMetadata = {},
): string | null {
  const added = Object.values(diff.added);
  const updated = Object.values(diff.updated).map(([, record]) => record);
  const removed = Object.keys(diff.removed);

  if (added.length === 0 && updated.length === 0 && removed.length === 0) {
    return null;
  }

  const persistedDiff: PersistedTldrawDiff = {
    format: TLDRAW_DIFF_FORMAT,
    version: TLDRAW_FORMAT_VERSION,
    added,
    updated,
    removed,
    ...(metadata.transactionId
      ? { transactionId: metadata.transactionId }
      : {}),
    ...(metadata.source ? { source: metadata.source } : {}),
  };

  return `${JSON.stringify(persistedDiff)}\n`;
}

export function serializeWhiteboardSnapshot(store: TLStore) {
  const entry: PersistedTldrawSnapshot = {
    format: TLDRAW_SNAPSHOT_FORMAT,
    version: TLDRAW_FORMAT_VERSION,
    records: Object.values(store.serialize("document")),
    compactedAt: new Date().toISOString(),
  };
  return `${JSON.stringify(entry)}\n`;
}

export function shouldCompactWhiteboard(snapshot: string) {
  if (snapshot.split("\n").filter(Boolean).length >= COMPACTION_ENTRIES) {
    return true;
  }
  return new TextEncoder().encode(snapshot).byteLength >= COMPACTION_BYTES;
}

export function parseWhiteboardEntries(
  snapshot: string,
): PersistedTldrawEntry[] {
  const entries: PersistedTldrawEntry[] = [];

  for (const [index, line] of snapshot.split("\n").entries()) {
    if (!line.trim()) continue;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Invalid whiteboard data on line ${index + 1}`);
    }

    if (!isPersistedEntry(value)) {
      throw new Error(`Unsupported whiteboard data on line ${index + 1}`);
    }
    entries.push(value);
  }

  return entries;
}

function isPersistedEntry(value: unknown): value is PersistedTldrawEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;

  if (candidate.format === TLDRAW_SNAPSHOT_FORMAT) {
    return (
      candidate.version === TLDRAW_FORMAT_VERSION &&
      Array.isArray(candidate.records)
    );
  }

  if (candidate.format !== TLDRAW_DIFF_FORMAT) return false;
  return (
    (candidate.version === 1 || candidate.version === TLDRAW_FORMAT_VERSION) &&
    Array.isArray(candidate.added) &&
    Array.isArray(candidate.updated) &&
    Array.isArray(candidate.removed)
  );
}

function createInitialRecords(): TLRecord[] {
  return [
    DocumentRecordType.create({ id: TLDOCUMENT_ID, name: "" }),
    PageRecordType.create({
      id: DEFAULT_WHITEBOARD_PAGE_ID,
      name: "Page 1",
      index: "a1" as IndexKey,
      meta: {},
    }),
  ];
}

function replaceDocumentRecords(store: TLStore, records: TLRecord[]) {
  const existingIds = Object.keys(
    store.serialize("document"),
  ) as TLRecord["id"][];
  if (existingIds.length > 0) store.remove(existingIds);
  store.put(
    records.length > 0
      ? repairLegacyAssistantTextRecords(records)
      : createInitialRecords(),
  );
}

function putPersistedDiff(store: TLStore, diff: PersistedTldrawDiff) {
  const records = repairLegacyAssistantTextRecords([
    ...diff.added,
    ...diff.updated,
  ]);
  if (records.length > 0) store.put(records);
  if (diff.removed.length > 0) {
    store.remove(diff.removed as TLRecord["id"][]);
  }
}
