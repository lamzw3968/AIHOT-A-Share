import { inspect } from "node:util";

/** Alongside the normal spec reporter, retain Node's complete error/cause and child stderr events. */
export default async function* diagnostics(source: AsyncIterable<{ type: string; data: unknown }>) {
  for await (const event of source) {
    if (!["test:fail", "test:stderr", "test:stdout", "test:diagnostic", "test:summary"].includes(event.type)) continue;
    yield JSON.stringify({ type: event.type, detail: inspect(event.data, {
      depth: null, showHidden: true, maxArrayLength: null, maxStringLength: null, colors: false, breakLength: Infinity,
    }) }) + "\n";
  }
}
