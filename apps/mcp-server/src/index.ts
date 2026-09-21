import { createApp } from "./app.js";

const app = createApp();
await app.listen();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

export { createApp } from "./app.js";
