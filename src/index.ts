#!/usr/bin/env node
import { InotesClient } from "./client.js";
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

try {
  const config = loadConfig();
  const client = new InotesClient(config);
  await startServer(client);
} catch (error) {
  const message = error instanceof Error ? error.message : "Не удалось запустить MCP-сервер iNotes";
  console.error(message);
  process.exit(1);
}
