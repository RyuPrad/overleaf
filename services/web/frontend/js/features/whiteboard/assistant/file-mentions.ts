import { Folder } from "../../../../../types/folder";

export const MAX_FILE_MENTIONS = 20;

export type MentionableProjectFile = {
  id: string;
  kind: "doc" | "file";
  path: string;
};

export type ActiveFileMention = {
  start: number;
  end: number;
  query: string;
};

export function mentionableFilesInFolder(
  folder: Folder,
  parentPath = "",
): MentionableProjectFile[] {
  const entries: MentionableProjectFile[] = [
    ...folder.docs.map((doc) => ({
      id: doc._id,
      kind: "doc" as const,
      path: `${parentPath}${doc.name}`,
    })),
    ...folder.fileRefs.map((file) => ({
      id: file._id,
      kind: "file" as const,
      path: `${parentPath}${file.name}`,
    })),
  ];

  for (const child of folder.folders) {
    entries.push(
      ...mentionableFilesInFolder(child, `${parentPath}${child.name}/`),
    );
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function findActiveFileMention(
  value: string,
  caret: number,
): ActiveFileMention | null {
  const beforeCaret = value.slice(0, caret);
  const match = /(?:^|\s)@([^\n@{}]*)$/.exec(beforeCaret);
  if (!match) return null;

  const start = beforeCaret.lastIndexOf("@");
  return {
    start,
    end: caret,
    query: match[1].trim(),
  };
}

export function filterMentionableFiles(
  files: MentionableProjectFile[],
  query: string,
  selected: MentionableProjectFile[],
  limit = 10,
) {
  const selectedKeys = new Set(
    selected.map((file) => `${file.kind}:${file.id}`),
  );
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);

  return files
    .filter((file) => !selectedKeys.has(`${file.kind}:${file.id}`))
    .filter((file) => {
      const path = file.path.toLocaleLowerCase();
      return terms.every((term) => path.includes(term));
    })
    .slice(0, limit);
}

export function fileMentionToken(path: string) {
  return `@{${path.replaceAll("\\", "\\\\").replaceAll("}", "\\}")}}`;
}

export function insertFileMention(
  value: string,
  mention: ActiveFileMention,
  path: string,
) {
  const token = fileMentionToken(path);
  const needsTrailingSpace = value[mention.end] !== " ";
  const inserted = `${token}${needsTrailingSpace ? " " : ""}`;
  return {
    value: `${value.slice(0, mention.start)}${inserted}${value.slice(
      mention.end,
    )}`,
    caret: mention.start + inserted.length,
  };
}
