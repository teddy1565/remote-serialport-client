import { randomUUID } from "crypto";

import {
    AbsTransport,
    AbsTransportClient,
    TransportAckCallback,
    TransportLifecycleEvent,
    TransportMessageListener
} from "../types/remote-serialport-types/src/transport";

/**
 * Minimum surface this transport relies on. Both `worker_threads.MessagePort` and Electron's
 * `MessagePort` (renderer side) satisfy it.
 */
export interface MessagePortLike {
    postMessage(value: unknown): void;
    on(event: "message", listener: (value: unknown) => void): unknown;
    on(event: "close", listener: () => void): unknown;
    off?(event: string, listener: (...args: any[]) => void): unknown;
    removeAllListeners?(event?: string): unknown;
    close?(): void;
    start?(): void;
}

interface IpcEnvelope {
    kind: "msg" | "ack" | "close" | "hello";
    channel?: string;
    payload?: unknown;
    ack_id?: number;
    auth?: unknown;
}

interface PendingRpc {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * AbsTransport over a Node `MessagePort` (worker_threads / Electron utility process).
 *
 * Symmetric to the server-side {@link import("../../../remote-serialport-server/src/modules/ipc-transport").NodeIpcServerTransport}
 * — same envelope format (`msg` / `ack` / `close`). No reconnect, no wire-level backpressure.
 */
export class NodeIpcClientTransport extends AbsTransport {
    private readonly _port: MessagePortLike;
    private readonly _id: string;
    private readonly _label: string;
    private readonly _channel_listeners: Map<string, Set<TransportMessageListener>> = new Map();
    private readonly _lifecycle_listeners: Map<TransportLifecycleEvent, Set<(...args: any[]) => void>> = new Map();
    private readonly _pending_rpcs: Map<number, PendingRpc> = new Map();
    private readonly _on_message: (raw: unknown) => void;
    private readonly _on_close: () => void;
    private _is_connected = true;
    private _next_ack_id = 0;

    constructor(port: MessagePortLike, label: string = "", auth?: unknown) {
        super();
        this._port = port;
        this._id = randomUUID();
        this._label = label;

        this._on_message = (raw: unknown): void => this._handle_envelope(raw as IpcEnvelope);
        this._on_close = (): void => this._fire_disconnect();

        this._port.on("message", this._on_message);
        this._port.on("close", this._on_close);
        this._port.start?.();

        // Announce hello (with optional auth credential) so the server can populate `transport.credential`
        // before firing `on_connection`. Always sent — server-side endpoint blocks on this envelope.
        this._port.postMessage({ kind: "hello", auth: auth });

        process.nextTick((): void => {
            if (this._is_connected === true) {
                this._fire_lifecycle("connect");
            }
        });
    }

    get id(): string {
        return this._id;
    }

    get is_connected(): boolean {
        return this._is_connected;
    }

    get endpoint_label(): string {
        return this._label;
    }

    get credential(): unknown {
        // Client side has no inbound credential to expose.
        return undefined;
    }

    send(channel: string, payload?: unknown): void {
        if (this._is_connected === false) {
            return;
        }
        const env: IpcEnvelope = arguments.length < 2 ? { kind: "msg", channel: channel } : { kind: "msg", channel: channel, payload: payload };
        this._port.postMessage(env);
    }

    send_rpc(channel: string, payload: unknown, timeout_ms: number): Promise<unknown> {
        if (this._is_connected === false) {
            return Promise.reject(new Error(`RPC "${channel}" rejected: transport closed`));
        }
        const ack_id: number = ++this._next_ack_id;
        return new Promise<unknown>((resolve, reject): void => {
            const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
                if (this._pending_rpcs.delete(ack_id) === true) {
                    reject(new Error(`RPC "${channel}" timed out after ${timeout_ms}ms`));
                }
            }, timeout_ms);
            this._pending_rpcs.set(ack_id, { resolve: resolve, reject: reject, timer: timer });
            this._port.postMessage({ kind: "msg", channel: channel, payload: payload, ack_id: ack_id });
        });
    }

    on(channel: string, listener: TransportMessageListener): void {
        let set: Set<TransportMessageListener> | undefined = this._channel_listeners.get(channel);
        if (set === undefined) {
            set = new Set();
            this._channel_listeners.set(channel, set);
        }
        set.add(listener);
    }

    once(channel: string, listener: TransportMessageListener): void {
        const wrapped: TransportMessageListener = (payload: unknown, ack?: TransportAckCallback): void => {
            this.off(channel, wrapped);
            listener(payload, ack);
        };
        this.on(channel, wrapped);
    }

    off(channel: string, listener?: TransportMessageListener): void {
        if (listener === undefined) {
            this._channel_listeners.delete(channel);
        } else {
            this._channel_listeners.get(channel)?.delete(listener);
        }
    }

    on_lifecycle(event: TransportLifecycleEvent, listener: (...args: any[]) => void): void {
        if (event === "reconnect") {
            return;
        }
        let set: Set<(...args: any[]) => void> | undefined = this._lifecycle_listeners.get(event);
        if (set === undefined) {
            set = new Set();
            this._lifecycle_listeners.set(event, set);
        }
        set.add(listener);
    }

    off_lifecycle(event: TransportLifecycleEvent, listener: (...args: any[]) => void): void {
        this._lifecycle_listeners.get(event)?.delete(listener);
    }

    get_buffered_amount(): number | null {
        return null;
    }

    close(): void {
        if (this._is_connected === false) {
            return;
        }
        try {
            this._port.postMessage({ kind: "close" });
        } catch {
            // peer already gone
        }
        this._reject_all_pending(new Error("transport closed"));
        this._fire_disconnect();
        try {
            this._port.removeAllListeners?.();
            this._port.close?.();
        } catch {
            // ignore
        }
    }

    private _fire_disconnect(): void {
        if (this._is_connected === false) {
            return;
        }
        this._is_connected = false;
        this._reject_all_pending(new Error("transport closed"));
        this._fire_lifecycle("disconnect");
    }

    private _fire_lifecycle(event: TransportLifecycleEvent): void {
        const set: Set<(...args: any[]) => void> | undefined = this._lifecycle_listeners.get(event);
        if (set === undefined) {
            return;
        }
        for (const listener of Array.from(set)) {
            try {
                listener();
            } catch {
                // ignore
            }
        }
    }

    private _reject_all_pending(error: Error): void {
        for (const entry of this._pending_rpcs.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this._pending_rpcs.clear();
    }

    private _handle_envelope(env: IpcEnvelope): void {
        if (env === null || typeof env !== "object") {
            return;
        }
        if (env.kind === "hello") {
            return; // client side never expects to receive a hello
        }
        if (env.kind === "ack") {
            if (typeof env.ack_id !== "number") {
                return;
            }
            const pending: PendingRpc | undefined = this._pending_rpcs.get(env.ack_id);
            if (pending === undefined) {
                return;
            }
            this._pending_rpcs.delete(env.ack_id);
            clearTimeout(pending.timer);
            pending.resolve(env.payload);
            return;
        }
        if (env.kind === "close") {
            this._fire_disconnect();
            return;
        }
        if (typeof env.channel !== "string") {
            return;
        }
        const listeners: Set<TransportMessageListener> | undefined = this._channel_listeners.get(env.channel);
        if (listeners === undefined) {
            return;
        }
        const ack_id: number | undefined = env.ack_id;
        const ack: TransportAckCallback | undefined = typeof ack_id === "number" ? (response: unknown): void => {
            if (this._is_connected === false) {
                return;
            }
            this._port.postMessage({ kind: "ack", ack_id: ack_id, payload: response });
        } : undefined;
        for (const listener of Array.from(listeners)) {
            try {
                listener(env.payload, ack);
            } catch {
                // ignore
            }
        }
    }
}

/**
 * AbsTransportClient over a single Node {@link MessagePortLike}.
 *
 * `open(label)` returns the same single underlying IPC transport regardless of label — IPC pairs
 * are 1-to-1 by nature. Use mux mode if you need many remote ports over one IPC pair.
 */
export class NodeIpcClient extends AbsTransportClient {
    private readonly _transport: NodeIpcClientTransport;
    private _opened = false;

    constructor(port: MessagePortLike, label: string = "", auth?: unknown) {
        super();
        this._transport = new NodeIpcClientTransport(port, label, auth);
    }

    /** The single underlying IPC transport. */
    get transport(): NodeIpcClientTransport {
        return this._transport;
    }

    open(_label: string): AbsTransport {
        this._opened = true;
        return this._transport;
    }

    close(): void {
        if (this._opened === false) {
            // Still need to close the port even if nobody called open() yet.
        }
        this._transport.close();
    }
}
