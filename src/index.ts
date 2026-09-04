import { app } from "./app";
import { processPendingReplays } from "./outbox";

export { app };

export default {
  fetch: app.fetch,
  async scheduled(
    _controller: ScheduledController,
    env: CloudflareBindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(processPendingReplays(env.DB));
  },
};
