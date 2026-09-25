import { createApp } from "./app.js";

try {
  const app = await createApp();
  try {
    await app.listen();
  } catch (error) {
    await app.close();
    throw error;
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0), () => {
        console.error("Porter shutdown failed.");
        process.exit(1);
      });
    });
  }
} catch {
  // Database/driver exceptions can embed private connection details.
  console.error("Porter could not start. Check the environment, database migrations, encryption key and provider configuration. See docs/local-development.md.");
  process.exitCode = 1;
}

export { createApp } from "./app.js";
