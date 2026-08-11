import mongoose from "../infrastructure/Mongoose.mjs";

const { Schema } = mongoose;

export const WhiteboardAiTransactionSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true, index: true },
    boardId: { type: Schema.Types.ObjectId, required: true, index: true },
    threadId: { type: Schema.Types.ObjectId, required: true },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    title: { type: String, required: true },
    explanation: { type: String, default: "" },
    boardActions: { type: [Schema.Types.Mixed], default: [] },
    boardPatch: { type: [Schema.Types.Mixed], default: [] },
    texChange: {
      docId: { type: Schema.Types.ObjectId },
      before: { type: String },
      after: { type: String },
    },
    requestedMode: {
      type: String,
      enum: ["direct", "suggest"],
      required: true,
    },
    effectiveMode: {
      type: String,
      enum: ["direct", "suggest"],
      required: true,
    },
    forcedSuggest: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["proposed", "applied", "undone", "rejected"],
      default: "proposed",
    },
    createdAt: { type: Date, default: Date.now },
    appliedAt: { type: Date },
    undoneAt: { type: Date },
  },
  {
    collection: "whiteboardAiTransactions",
    minimize: false,
  },
);

WhiteboardAiTransactionSchema.index({ threadId: 1, createdAt: -1 });

export const WhiteboardAiTransaction = mongoose.model(
  "WhiteboardAiTransaction",
  WhiteboardAiTransactionSchema,
);
