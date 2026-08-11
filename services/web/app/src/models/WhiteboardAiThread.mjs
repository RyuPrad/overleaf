import mongoose from "../infrastructure/Mongoose.mjs";

const { Schema } = mongoose;

const MessageSchema = new Schema(
  {
    messageId: { type: String, required: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    text: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId },
    transactionId: { type: Schema.Types.ObjectId },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

export const WhiteboardAiThreadSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true, index: true },
    boardId: { type: Schema.Types.ObjectId, required: true },
    title: { type: String, default: "New chat" },
    titleIsCustom: { type: Boolean, default: false },
    linkedDocId: { type: Schema.Types.ObjectId },
    mode: { type: String, enum: ["direct", "suggest"], default: "suggest" },
    messages: { type: [MessageSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    collection: "whiteboardAiThreads",
    minimize: false,
  },
);

WhiteboardAiThreadSchema.index({ projectId: 1, boardId: 1, updatedAt: -1 });

export const WhiteboardAiThread = mongoose.model(
  "WhiteboardAiThread",
  WhiteboardAiThreadSchema,
);
