import type { AppSource, ResourceSource, RunnerInput, RunnerOutput } from "./protocol.ts";

export interface RunConfig {
  core: ArrayBuffer;
  app: AppSource;
  resources: ResourceSource[];
  width: number;
  height: number;
}

type FrameMessage =
  | { token: string; type: "frame-ready" }
  | { token: string; type: "runner"; data: RunnerOutput };

export class StudioController {
  private frame?: HTMLIFrameElement;
  private token = "";
  private onMessage?: (event: MessageEvent<FrameMessage>) => void;

  constructor(private readonly onOutput: (output: RunnerOutput) => void) {}

  async start(config: RunConfig): Promise<void> {
    this.stop();
    const response = await fetch("/target/studio/worker.js");
    if (!response.ok) throw new Error(`Unable to load runner (${response.status})`);
    const workerSource = await response.text();
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
      this.onMessage = (event) => {
        if (event.source !== frame.contentWindow || event.data?.token !== token) return;
        if (event.data.type === "frame-ready") {
          frame.contentWindow?.postMessage({ token, type: "boot", workerSource, start: startMessage }, "*");
        } else if (event.data.type === "runner") {
          const output = event.data.data;
          this.onOutput(output);
          if (output.type === "ready") resolve();
          if (output.type === "error") reject(new Error(output.message));
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
    if (this.onMessage) window.removeEventListener("message", this.onMessage);
    this.onMessage = undefined;
    this.frame?.remove();
    this.frame = undefined;
    this.token = "";
  }
}
