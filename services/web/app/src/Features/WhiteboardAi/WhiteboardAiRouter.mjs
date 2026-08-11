import { RateLimiter } from "../../infrastructure/RateLimiter.mjs";
import RateLimiterMiddleware from "../Security/RateLimiterMiddleware.mjs";
import AuthorizationMiddleware from "../Authorization/AuthorizationMiddleware.mjs";
import WhiteboardAiController from "./WhiteboardAiController.mjs";

const proposeRateLimiter = new RateLimiter("whiteboard-ai-propose", {
  points: 30,
  duration: 60 * 60,
});

function apply(webRouter) {
  const base = "/project/:project_id/whiteboard-ai/:board_id";
  const sessionBase = `${base}/sessions/:session_id`;

  webRouter.get(
    `${base}/sessions`,
    AuthorizationMiddleware.ensureUserCanReadProject,
    WhiteboardAiController.listSessions,
  );
  webRouter.post(
    `${base}/sessions`,
    AuthorizationMiddleware.ensureUserCanWriteProjectContent,
    WhiteboardAiController.createSession,
  );
  webRouter.get(
    sessionBase,
    AuthorizationMiddleware.ensureUserCanReadProject,
    WhiteboardAiController.getSession,
  );
  webRouter.put(
    `${sessionBase}/title`,
    AuthorizationMiddleware.ensureUserCanWriteProjectContent,
    WhiteboardAiController.renameSession,
  );
  webRouter.put(
    `${sessionBase}/settings`,
    AuthorizationMiddleware.ensureUserCanWriteProjectContent,
    WhiteboardAiController.updateSettings,
  );
  webRouter.delete(
    sessionBase,
    AuthorizationMiddleware.ensureUserCanWriteProjectContent,
    WhiteboardAiController.deleteSession,
  );
  webRouter.post(
    `${sessionBase}/proposals`,
    AuthorizationMiddleware.ensureUserCanWriteProjectContent,
    RateLimiterMiddleware.rateLimit(proposeRateLimiter, {
      params: ["project_id", "board_id"],
    }),
    WhiteboardAiController.propose,
  );
  for (const [action, controller] of [
    ["commit", WhiteboardAiController.commit],
    ["undo", WhiteboardAiController.undo],
    ["reject", WhiteboardAiController.reject],
  ]) {
    webRouter.post(
      `${sessionBase}/transactions/:transaction_id/${action}`,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      controller,
    );
  }
}

export default { apply };
