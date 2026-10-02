import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import type { Readable, Writable } from "node:stream";

type Input = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (enabled: boolean) => void };
type Output = Writable & { isTTY?: boolean };

export async function writeTypewriter(
  input: Input,
  output: Output,
  text: string,
  options: { delayMs?: number; terminal?: boolean } = {},
): Promise<"complete" | "cancelled"> {
  if (!(options.terminal ?? (input.isTTY && output.isTTY))) {
    output.write(`${text}\n`);
    return "complete";
  }
  const wasRaw = input.isRaw ?? false;
  const wasPaused = input.isPaused();
  const characters = Array.from(text);
  emitKeypressEvents(input);
  input.setRawMode?.(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let index = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (result: "complete" | "cancelled", interrupted = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.removeListener("keypress", onKey);
      input.removeListener("end", onEnd);
      input.setRawMode?.(wasRaw);
      if (wasPaused) input.pause();
      output.write("\n");
      if (interrupted) reject(Object.assign(new Error("Interrupted"), { code: "ABORT_ERR" }));
      else resolve(result);
    };
    const onKey = (_text: string, key: Key) => {
      if (key?.ctrl && key.name === "c") return finish("cancelled", true);
      if (key?.name === "escape" && key.sequence === "\u001b") return finish("cancelled");
      if (key?.name === "space" || key?.name === "return") {
        output.write(characters.slice(index).join(""));
        finish("complete");
      }
    };
    const onEnd = () => finish("cancelled");
    const tick = () => {
      if (finished) return;
      if (index >= characters.length) return finish("complete");
      output.write(characters[index++]!);
      timer = setTimeout(tick, Math.max(0, options.delayMs ?? 18));
    };
    input.on("keypress", onKey);
    input.once("end", onEnd);
    tick();
  });
}
