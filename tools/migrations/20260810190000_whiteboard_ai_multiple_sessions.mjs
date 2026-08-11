import Helpers from "./lib/helpers.mjs";
import { getCollectionInternal } from "./lib/mongodb.mjs";

const tags = ["server-ce", "server-pro", "saas"];
const oldIndex = { name: "projectId_1_boardId_1" };
const sessionIndex = {
  key: { projectId: 1, boardId: 1, updatedAt: -1 },
  name: "projectId_1_boardId_1_updatedAt_-1",
};
const transactionIndex = {
  key: { threadId: 1, createdAt: -1 },
  name: "threadId_1_createdAt_-1",
};

function titleFromThread(thread) {
  const firstPrompt = thread.messages?.find(
    (message) => message.role === "user",
  );
  const title = firstPrompt?.text?.replace(/\s+/g, " ").trim().slice(0, 80);
  return title || "New chat";
}

const migrate = async () => {
  const collection = await getCollectionInternal("whiteboardAiThreads");
  const transactionCollection = await getCollectionInternal(
    "whiteboardAiTransactions",
  );
  const cursor = collection.find(
    {
      $or: [
        { title: { $exists: false } },
        { titleIsCustom: { $exists: false } },
      ],
    },
    { projection: { messages: 1, title: 1, titleIsCustom: 1 } },
  );

  for await (const thread of cursor) {
    await collection.updateOne(
      { _id: thread._id },
      {
        $set: {
          ...(thread.title == null ? { title: titleFromThread(thread) } : {}),
          ...(thread.titleIsCustom == null ? { titleIsCustom: false } : {}),
        },
      },
    );
  }

  await Helpers.dropIndexesFromCollection(collection, [oldIndex]);
  await Helpers.addIndexesToCollection(collection, [sessionIndex]);
  await Helpers.addIndexesToCollection(transactionCollection, [
    transactionIndex,
  ]);
};

const rollback = async () => {
  const collection = await getCollectionInternal("whiteboardAiThreads");
  const transactionCollection = await getCollectionInternal(
    "whiteboardAiTransactions",
  );
  const duplicate = await collection
    .aggregate([
      {
        $group: {
          _id: { projectId: "$projectId", boardId: "$boardId" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ])
    .next();

  if (duplicate) {
    throw new Error(
      "Cannot restore the one-thread-per-board index while multiple whiteboard AI sessions exist",
    );
  }

  await Helpers.dropIndexesFromCollection(collection, [sessionIndex]);
  await Helpers.dropIndexesFromCollection(transactionCollection, [
    transactionIndex,
  ]);
  await Helpers.addIndexesToCollection(collection, [
    { key: { projectId: 1, boardId: 1 }, name: oldIndex.name, unique: true },
  ]);
};

export default { tags, migrate, rollback };
