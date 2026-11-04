import "dotenv/config";
import { createApp } from "./app";

export async function main() {
  const app = await createApp();
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) { await app.close(); throw new Error("PORT must be an integer between 0 and 65535"); }
  const stop = () => { void app.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  app.addHook("onClose", async () => { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); });
  try { await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" }); }
  catch (error) { await app.close(); throw error; }
  app.log.info(`ContextVault API running on http://localhost:${port}`);
  app.log.info(`Swagger docs at http://localhost:${port}/docs`);
  return app;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
