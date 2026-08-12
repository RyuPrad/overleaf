import { expect } from "chai";
import {
  fileMentionToken,
  filterMentionableFiles,
  findActiveFileMention,
  insertFileMention,
  mentionableFilesInFolder,
  MentionableProjectFile,
} from "@/features/whiteboard/assistant/file-mentions";

describe("whiteboard assistant file mentions", function () {
  const files: MentionableProjectFile[] = [
    { id: "1", kind: "doc", path: "main.tex" },
    { id: "2", kind: "doc", path: "chapters/methods.tex" },
    { id: "3", kind: "file", path: "figures/result chart.png" },
  ];

  it("finds an @ query at the caret but ignores email addresses and tokens", function () {
    expect(findActiveFileMention("Use @methods", 12)).to.deep.equal({
      start: 4,
      end: 12,
      query: "methods",
    });
    expect(findActiveFileMention("Use @result chart", 17)?.query).to.equal(
      "result chart",
    );
    expect(findActiveFileMention("me@example.com", 14)).to.equal(null);
    expect(findActiveFileMention("Use @{main.tex}", 15)).to.equal(null);
  });

  it("filters paths case-insensitively and omits selected files", function () {
    expect(filterMentionableFiles(files, "METHOD", [], 10)).to.deep.equal([
      files[1],
    ]);
    expect(filterMentionableFiles(files, "fig chart", [], 10)).to.deep.equal([
      files[2],
    ]);
    expect(filterMentionableFiles(files, "", [files[0]], 10)).not.to.include(
      files[0],
    );
  });

  it("inserts an unambiguous token for paths containing spaces", function () {
    const mention = findActiveFileMention("Compare @result", 15);
    if (!mention) throw new Error("expected an active mention");

    expect(insertFileMention("Compare @result", mention, files[2].path)).to.eql(
      {
        value: "Compare @{figures/result chart.png} ",
        caret: 36,
      },
    );
    expect(fileMentionToken("folder/a}b.tex")).to.equal("@{folder/a\\}b.tex}");
  });

  it("flattens editable and uploaded files from nested folders", function () {
    const folder = {
      _id: "root",
      name: "root",
      docs: [{ _id: "doc", name: "main.tex" }],
      fileRefs: [{ _id: "image", name: "plot.png", hash: "hash" }],
      folders: [
        {
          _id: "sub",
          name: "chapters",
          docs: [{ _id: "bib", name: "sources.bib" }],
          fileRefs: [],
          folders: [],
        },
      ],
    };

    expect(mentionableFilesInFolder(folder)).to.deep.equal([
      { id: "bib", kind: "doc", path: "chapters/sources.bib" },
      { id: "doc", kind: "doc", path: "main.tex" },
      { id: "image", kind: "file", path: "plot.png" },
    ]);
  });
});
