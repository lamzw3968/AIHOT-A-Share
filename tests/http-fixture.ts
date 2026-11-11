import { randomInt } from "node:crypto";
import type { Server } from "node:http";
import type { FastifyInstance } from "fastify";

// Undici's Fetch bad-port list ends at 10080. Use only high ports, rather than accepting an OS
// ephemeral allocation that can include 3659/6669 on some hosts. Bind directly: no reserve/close race.
const MIN_PORT = 16384;
const MAX_PORT = 65535;
type ChoosePort = () => number;
const randomPort = () => randomInt(MIN_PORT, MAX_PORT + 1);

async function bindSafePort<T>(listen: (port: number) => Promise<T>, choosePort: ChoosePort): Promise<T> {
  let collision: unknown;
  for (let attempt = 0; attempt < 64; attempt++) {
    const port = choosePort();
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) continue;
    try { return await listen(port); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE")) throw error;
      collision = error;
    }
  }
  throw new Error("Could not bind a Fetch-safe loopback test port after 64 candidates", { cause: collision });
}

/** Shared and independently constructed HTTP stubs use the same safe allocation and error handling. */
export async function listenForFetch(server: Server, choosePort: ChoosePort = randomPort): Promise<void> {
  await bindSafePort((port) => new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    try { server.listen(port, "127.0.0.1"); }
    catch (error) { server.off("error", onError); server.off("listening", onListening); reject(error); }
  }), choosePort);
}

/** Fastify owns its startup lifecycle; retry only bind collisions, using its normal listen method. */
export async function listenAppForFetch(app: FastifyInstance, choosePort: ChoosePort = randomPort): Promise<string> {
  return bindSafePort((port) => app.listen({ host: "127.0.0.1", port }), choosePort);
}
