import type { LvglAppRun, RunnerInput, RunnerOutput, FirmwareRun } from "./protocol.ts";

export type RunConfig = LvglAppRun | FirmwareRun;

type FrameMessage =
  | { token: string; type: "frame-ready" }
  | { token: string; type: "runner"; data: RunnerOutput };

export class StudioController {
  private frame?: HTMLIFrameElement;
  private token = "";
  private onMessage?: (event: MessageEvent<FrameMessage>) => void;
  private generation = 0;
  private rejectStart?: (error: Error) => void;

  constructor(private readonly onOutput: (output: RunnerOutput) => void) {}

  async start(config: RunConfig): Promise<void> {
    this.stop();
    const generation = this.generation;
    const response = await fetch("/target/studio/worker.js", { cache: "no-store" });
    if (!response.ok) throw new Error(`Unable to load runner (${response.status})`);
    const workerSource = await response.text();
    if (generation !== this.generation) throw new DOMException("Run cancelled", "AbortError");
    const token = crypto.randomUUID();
    this.token = token;

    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.style.display = "none";
    frame.srcdoc = `<script>
      const token = ${JSON.stringify(token)};
      let worker;
      addEventListener("message", (event) => {
        if (event.source !== parent || event.data?.token !== token) return;
        if (event.data.type === "boot") {
          const url = URL.createObjectURL(new Blob([event.data.workerSource], { type: "text/javascript" }));
          worker = new Worker(url);
          worker.onmessage = (result) => {
            const value = result.data;
            const transfer = value.type === "frame" ? [value.pixels] : [];
            parent.postMessage({ token, type: "runner", data: value }, "*", transfer);
          };
          worker.onerror = (error) => {
            parent.postMessage({ token, type: "runner", data: { type: "error", message: error.message } }, "*");
          };
          worker.postMessage(event.data.start);
        } else if (event.data.type === "command") {
          worker?.postMessage(event.data.command);
        }
      });
      parent.postMessage({ token, type: "frame-ready" }, "*");
    </script>`;
    this.frame = frame;

    const startMessage: RunnerInput = { type: "start", ...config };
    return new Promise<void>((resolve, reject) => {
      this.rejectStart = reject;
      this.onMessage = (event) => {
        if (generation !== this.generation) return;
        if (event.source !== frame.contentWindow || event.data?.token !== token) return;
        if (event.data.type === "frame-ready") {
          frame.contentWindow?.postMessage({ token, type: "boot", workerSource, start: startMessage }, "*");
        } else if (event.data.type === "runner") {
          const output = event.data.data;
          if (output.type === "ready") {
            this.rejectStart = undefined;
            resolve();
          }
          if (output.type === "error") {
            this.rejectStart = undefined;
            reject(new Error(output.message));
          }
          this.onOutput(output);
        }
      };
      window.addEventListener("message", this.onMessage);
      document.body.append(frame);
    });
  }

  private command(command: RunnerInput): void {
    this.frame?.contentWindow?.postMessage({ token: this.token, type: "command", command }, "*");
  }

  pointer(x: number, y: number, pressed: boolean): void {
    this.command({ type: "pointer", x, y, pressed });
  }

  resize(width: number, height: number): void {
    this.command({ type: "resize", width, height });
  }

  stop(): void {
    this.generation++;
    this.rejectStart?.(new DOMException("Run cancelled", "AbortError"));
    this.rejectStart = undefined;
    if (this.onMessage) window.removeEventListener("message", this.onMessage);
    this.onMessage = undefined;
    this.frame?.remove();
    this.frame = undefined;
    this.token = "";
  }
}
