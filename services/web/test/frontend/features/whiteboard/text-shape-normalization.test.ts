import { expect } from "chai";
import type { TLRecord } from "tldraw";
import {
  DEFAULT_ASSISTANT_TEXT_WIDTH,
  normalizeTextShapeProps,
  repairLegacyAssistantTextRecord,
  repairLegacyAssistantTextRecords,
} from "@/features/whiteboard/text-shape-normalization";

describe("whiteboard text shape normalization", function () {
  it("turns assistant-escaped line breaks into bounded rich-text paragraphs", function () {
    const props = normalizeTextShapeProps({
      text: "First step\\n\\nSecond step\\nFinal answer",
      size: "m",
      h: 180,
      height: 180,
    });

    expect(props).to.include({
      w: DEFAULT_ASSISTANT_TEXT_WIDTH,
      autoSize: false,
      size: "m",
    });
    expect(props).not.to.have.property("h");
    expect(props).not.to.have.property("height");
    expect(paragraphText(props.richText)).to.deep.equal([
      "First step",
      "",
      "Second step",
      "Final answer",
    ]);
  });

  it("keeps short, single-line labels auto-sized", function () {
    const props = normalizeTextShapeProps({ text: "Short label", size: "s" });

    expect(props).not.to.have.property("w");
    expect(props).not.to.have.property("autoSize");
    expect(paragraphText(props.richText)).to.deep.equal(["Short label"]);
  });

  it("repairs the narrow legacy record produced by the affected transaction", function () {
    const record = {
      id: "shape:q13_solution_1",
      typeName: "shape",
      type: "text",
      props: {
        w: 8,
        autoSize: true,
        size: "m",
        richText: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Move everything to one side:\\nexpression ≤ 0",
                },
              ],
            },
          ],
        },
      },
    } as unknown as TLRecord;

    const repaired = repairLegacyAssistantTextRecord(record) as TLRecord & {
      props: Record<string, unknown>;
    };

    expect(repaired).not.to.equal(record);
    expect(repaired.props).to.include({
      w: DEFAULT_ASSISTANT_TEXT_WIDTH,
      autoSize: false,
      size: "m",
    });
    expect(paragraphText(repaired.props.richText)).to.deep.equal([
      "Move everything to one side:",
      "expression ≤ 0",
    ]);
  });

  it("does not rewrite ordinary fixed-width text records", function () {
    const record = {
      id: "shape:user_note",
      typeName: "shape",
      type: "text",
      props: {
        w: 500,
        autoSize: false,
        richText: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Literal \\n example" }],
            },
          ],
        },
      },
    } as unknown as TLRecord;

    expect(repairLegacyAssistantTextRecord(record)).to.equal(record);
  });

  it("reflows consecutive repaired blocks so their paragraphs do not overlap", function () {
    const records = [
      legacyRecord("shape:q13_solution_1", 700, "First\\n".repeat(15)),
      legacyRecord("shape:q13_solution_2", 1040, "Second\\n".repeat(13)),
      legacyRecord("shape:q13_solution_3", 1320, "Third\\n".repeat(11)),
    ];

    const repaired = repairLegacyAssistantTextRecords(records) as Array<
      TLRecord & { y: number; props: Record<string, unknown> }
    >;

    expect(repaired.map((record) => record.y)).to.deep.equal([700, 1340, 1916]);
    expect(
      repaired.every((record) => record.props.autoSize === false),
    ).to.equal(true);
  });
});

function legacyRecord(id: string, y: number, text: string) {
  return {
    id,
    typeName: "shape",
    type: "text",
    x: 260,
    y,
    parentId: "page:page",
    props: {
      w: 8,
      autoSize: true,
      size: "m",
      richText: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text }],
          },
        ],
      },
    },
  } as unknown as TLRecord;
}

function paragraphText(value: unknown) {
  const doc = value as {
    content: Array<{ content?: Array<{ text?: string }> }>;
  };
  return doc.content.map((paragraph) =>
    (paragraph.content ?? []).map((node) => node.text ?? "").join(""),
  );
}
