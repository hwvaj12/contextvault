import "dotenv/config";
import { createApp } from "./app";

export async function main() {
  const app = await createApp();
  const port = parseInt(process.env.PORT || "3000", 10);
  await app.listen({ port, host: "0.0.0.0" });
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
