import type { LvglAppRun, RunnerError, RunnerInput, RunnerOutput, FirmwareRun } from "./protocol.ts";
import { assetUrl } from "./paths.ts";

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
  private startTimeout?: ReturnType<typeof setTimeout>;

  private clearStartTimeout(): void {
    if (this.startTimeout) clearTimeout(this.startTimeout);
    this.startTimeout = undefined;
  }

  constructor(private readonly onOutput: (output: RunnerOutput) => void) {}

  async start(config: RunConfig): Promise<void> {
    this.stop();
    const generation = this.generation;
    const response = await fetch(assetUrl("/target/studio/worker.js"), { cache: "no-store" });
    if (!response.ok) throw new Error(`Unable to load runner (${response.status})`);
    const workerSource = await response.text();
    if (generation !== this.generation) throw new DOMException("Run cancelled", "AbortError");
    const token = crypto.randomUUID();
    this.token = token;

    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.style.display = "none";
    frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none'; script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'; worker-src blob:"></head><body><script>
      const token = ${JSON.stringify(token)};
      let worker;
      let workerUrl;
      const disposeWorker = () => {
        worker?.terminate();
        worker = undefined;
        if (workerUrl) URL.revokeObjectURL(workerUrl);
        workerUrl = undefined;
      };
      addEventListener("pagehide", disposeWorker);
      const reportError = (error) => {
        const detail = {
          code: "runtime",
          phase: "runtime",
          message: error?.message || String(error) || "Application worker failed",
        };
        parent.postMessage({ token, type: "runner", data: { type: "error", message: detail.message, detail } }, "*");
      };
      addEventListener("message", (event) => {
        if (event.source !== parent || event.data?.token !== token) return;
        if (event.data.type === "boot") {
          try {
            const url = URL.createObjectURL(new Blob([event.data.workerSource], { type: "text/javascript" }));
            workerUrl = url;
            worker = new Worker(url);
            worker.onmessage = (result) => {
              const value = result.data;
              const transfer = value.type === "frame" ? [value.pixels] : [];
              parent.postMessage({ token, type: "runner", data: value }, "*", transfer);
            };
            worker.onerror = reportError;
            worker.postMessage(event.data.start);
          } catch (error) {
            reportError(error);
            disposeWorker();
          }
        } else if (event.data.type === "command") {
          if (event.data.command?.type === "stop") {
            disposeWorker();
            return;
          }
          worker?.postMessage(event.data.command);
        }
      });
      parent.postMessage({ token, type: "frame-ready" }, "*");
    </script></body></html>`;
    this.frame = frame;

    const startMessage: RunnerInput = { type: "start", ...config };
    return new Promise<void>((resolve, reject) => {
      this.rejectStart = reject;
      let booted = false;
      const boot = (): void => {
        if (booted) return;
        booted = true;
        frame.contentWindow?.postMessage({ token, type: "boot", workerSource, start: startMessage }, "*");
      };
      this.onMessage = (event) => {
        if (generation !== this.generation) return;
        if (event.source !== frame.contentWindow || event.data?.token !== token) return;
        if (event.data.type === "frame-ready") {
          boot();
        } else if (event.data.type === "runner") {
          const output = event.data.data;
          if (output.type === "ready") {
            this.clearStartTimeout();
            this.rejectStart = undefined;
            resolve();
          }
          if (output.type === "error") {
            this.clearStartTimeout();
            this.rejectStart = undefined;
            const error = new Error(output.message) as Error & { detail?: RunnerError };
            error.detail = output.detail;
            reject(error);
          }
          this.onOutput(output);
        }
      };
      window.addEventListener("message", this.onMessage);
      frame.addEventListener("load", boot, { once: true });
      document.body.append(frame);
      this.startTimeout = setTimeout(() => {
        if (generation !== this.generation || this.rejectStart !== reject) return;
        this.clearStartTimeout();
        this.rejectStart = undefined;
        reject(new Error("Runner timed out while starting"));
        this.stop();
      }, 15_000);
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
    this.clearStartTimeout();
    if (this.frame && this.token) {
      this.frame.contentWindow?.postMessage({ token: this.token, type: "command", command: { type: "stop" } }, "*");
    }
    this.rejectStart?.(new DOMException("Run cancelled", "AbortError"));
    this.rejectStart = undefined;
    if (this.onMessage) window.removeEventListener("message", this.onMessage);
    this.onMessage = undefined;
    this.frame?.remove();
    this.frame = undefined;
    this.token = "";
  }
}
