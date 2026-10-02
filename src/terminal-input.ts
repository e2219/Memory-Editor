import { createInterface } from "node:readline/promises";
import type { Key } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { writeTypewriter } from "./typewriter.ts";

// null means cancel this prompt, never an empty answer or a game action.
export function createTerminalInput(input: Readable, output: Writable, terminal?: boolean) {
  const createReader = () => createInterface({ input, output, terminal, escapeCodeTimeout: 100 });
  let rl = createReader();
  return {
    async question(prompt: string): Promise<string | null> {
      const controller = new AbortController();
      const onKey = (_text: string, key: Key) => {
        // Arrow/function keys also start with ESC; only a standalone Esc cancels.
        if (key?.name !== "escape" || key.sequence !== "\u001b") return;
        rl.write(null, { ctrl: true, name: "u" });
        controller.abort();
      };
      input.on("keypress", onKey);
      try {
        const answer = await rl.question(prompt, { signal: controller.signal });
        return ["/返回", "/取消", "esc", "\u001b"].includes(answer.trim().toLowerCase())
          ? null
          : answer;
      } catch (error) {
        if (controller.signal.aborted) return null;
        throw error;
      } finally {
        input.removeListener("keypress", onKey);
      }
    },
    async typewrite(text: string): Promise<"complete" | "cancelled"> {
      // No active question here: release readline's editing/echo handlers during playback.
      rl.close();
      try { return await writeTypewriter(input, output, text, { terminal }); }
      finally { rl = createReader(); }
    },
    close() { rl.close(); },
  };
}
