export const eventImports: Readonly<Record<string, string>> = Object.freeze({
  lv_obj_add_event_cb: "iiii/i", lv_obj_remove_event_dsc: "ii/i", lv_obj_send_event: "iii/i",
  lv_event_get_code: "i/i", lv_event_get_user_data: "i/i", lv_event_get_target_obj: "i/i",
});
export const eventDispatch = "app_event_dispatch";

function fail(message: string): never { throw new Error(message); }

interface EventRegistration {
  readonly descriptor: number;
  readonly id: number;
  readonly callback: number;
  readonly target: number;
  readonly pointer: number;
  readonly user: number;
  removing: boolean;
}
interface EventFrame { readonly token: number; readonly registration: EventRegistration; readonly code: number }

export class EventAdapter {
  #core?: WebAssembly.Instance;
  #consumer?: WebAssembly.Instance;
  #registrations = new Map<number, EventRegistration>();
  #byId = new Map<number, EventRegistration>();
  #frames: EventFrame[] = [];
  #nextId = 1;
  #sends: number[] = [];
  #pendingRegistrations = 0;
  #checkingDispatch = false;

  constructor(core: WebAssembly.Instance, consumer: WebAssembly.Instance, private readonly label: { eventTarget(token: number): number },
    readonly clicked: number, readonly options: { readonly maxRegistrations: number; readonly maxDepth: number }, private readonly rethrow: () => void,
    private readonly reserveToken: () => number) {
    this.#core = core;
    this.#consumer = consumer;
  }

  #call(name: string, ...args: number[]): number | void {
    const fn = this.#core?.exports[name];
    if (typeof fn !== "function") return fail("LVGL event adapter is unavailable");
    const result = fn(...args) as number | void;
    this.rethrow();
    return result;
  }

  #frame(value: number): EventFrame {
    const current = this.#frames[this.#frames.length - 1];
    if (!current || current.token !== (value >>> 0)) return fail("invalid LVGL event token");
    return current;
  }

  add(target: number, callback: number, code: number, user: number): number {
    const pointer = this.label.eventTarget(target);
    if ((code >>> 0) !== this.clicked) return fail("unsupported LVGL event code");
    if ((callback >>> 0) === 0) return 0;
    if (this.#registrations.size + this.#pendingRegistrations >= this.options.maxRegistrations) return fail("LVGL event quota exceeded");
    if (this.#nextId > 0xffff_ffff) return fail("LVGL callback IDs exhausted");
    const registration: EventRegistration = { descriptor: this.reserveToken(), id: this.#nextId++, callback: callback >>> 0,
      target: target >>> 0, pointer, user: user >>> 0, removing: false };
    this.#pendingRegistrations++;
    let status: number | void;
    try { status = this.#call("lvw_event_add", pointer, this.clicked, registration.id); }
    finally { this.#pendingRegistrations--; }
    if (status === -3) return 0;
    if (status !== 0) return fail(`LVGL event registration failed (${status})`);
    this.#registrations.set(registration.descriptor, registration);
    this.#byId.set(registration.id, registration);
    return registration.descriptor;
  }

  remove(target: number, descriptor: number): number {
    const pointer = this.label.eventTarget(target);
    const registration = this.#registrations.get(descriptor >>> 0);
    if (!registration || registration.target !== (target >>> 0) || registration.pointer !== pointer) return fail("invalid LVGL event descriptor");
    if (registration.removing) return fail("LVGL event removal is already in progress");
    registration.removing = true;
    const status = this.#call("lvw_event_remove", pointer, registration.id);
    if (status !== 0) return fail(`LVGL event removal failed (${status})`);
    if (this.#registrations.get(registration.descriptor) !== registration || this.#byId.get(registration.id) !== registration) {
      return fail("LVGL event registration changed");
    }
    this.#registrations.delete(registration.descriptor);
    this.#byId.delete(registration.id);
    return 1;
  }

  send(target: number, code: number, parameter: number): number {
    const pointer = this.label.eventTarget(target);
    if ((code >>> 0) !== this.clicked || parameter !== 0) return fail("unsupported LVGL event dispatch");
    if (this.#sends.length > this.options.maxDepth) return fail("LVGL event nesting limit exceeded");
    this.#sends.push(pointer);
    try { return this.#call("lv_obj_send_event", pointer, this.clicked, 0) as number; }
    finally { if (this.#sends.pop() !== pointer) fail("LVGL event send stack corrupted"); }
  }

  dispatch(id: number, current: number, code: number): void {
    if (this.#checkingDispatch) return fail("LVGL event validation is reentrant");
    const registration = this.#byId.get(id >>> 0);
    if (!registration || registration.removing || this.#sends[this.#sends.length - 1] !== registration.pointer
        || registration.pointer !== (current >>> 0) || (code >>> 0) !== this.clicked) {
      return fail("invalid LVGL event dispatch");
    }
    if (this.#frames.length >= this.options.maxDepth) return fail("LVGL event nesting limit exceeded");
    this.#checkingDispatch = true;
    try {
      const native = (this.#call("lvw_event_current") as number) >>> 0;
      if (!native || ((this.#call("lv_event_get_target_obj", native) as number) >>> 0) !== registration.pointer) {
        return fail("invalid LVGL event target");
      }
    } finally { this.#checkingDispatch = false; }
    if (this.#byId.get(registration.id) !== registration || this.#registrations.get(registration.descriptor) !== registration
        || registration.removing || this.#sends[this.#sends.length - 1] !== registration.pointer || (code >>> 0) !== this.clicked) {
      return fail("invalid LVGL event dispatch");
    }
    if (this.#frames.length >= this.options.maxDepth) return fail("LVGL event nesting limit exceeded");
    const frame: EventFrame = { token: this.reserveToken(), registration, code: code >>> 0 };
    this.#frames.push(frame);
    try {
      const callback = this.#consumer?.exports[eventDispatch];
      if (typeof callback !== "function") return fail("LVGL consumer event dispatcher is unavailable");
      callback(registration.callback, frame.token);
      this.rethrow();
    } finally {
      if (this.#frames.pop() !== frame) fail("LVGL event stack corrupted");
    }
  }

  code(token: number): number { return this.#frame(token).code; }
  user(token: number): number { return this.#frame(token).registration.user; }
  target(token: number): number { return this.#frame(token).registration.target; }

  close(): void {
    if (this.#frames.length || this.#sends.length || this.#pendingRegistrations || this.#checkingDispatch) return fail("LVGL event adapter is active");
    for (const registration of [...this.#registrations.values()].reverse()) {
      if (registration.removing) return fail("LVGL event removal is already in progress");
      registration.removing = true;
      const status = this.#call("lvw_event_remove", registration.pointer, registration.id);
      if (status !== 0) return fail(`LVGL event removal failed (${status})`);
      if (this.#registrations.get(registration.descriptor) !== registration || this.#byId.get(registration.id) !== registration) {
        return fail("LVGL event registration changed");
      }
      this.#registrations.delete(registration.descriptor);
      this.#byId.delete(registration.id);
    }
    this.discard();
  }

  discard(): void {
    this.#registrations.clear(); this.#byId.clear(); this.#frames.length = 0; this.#sends.length = 0;
    this.#consumer = undefined; this.#core = undefined;
  }
}
