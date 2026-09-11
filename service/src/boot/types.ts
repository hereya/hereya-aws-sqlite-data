import type { Server } from "node:http";
import type { Litestream } from "../litestream.ts";
import type { AppSync } from "../sync.ts";

export interface RunningService {
  server: Server;
  port: number;
  sync: AppSync;
  litestream: Litestream;
  stop: () => Promise<void>;
}
