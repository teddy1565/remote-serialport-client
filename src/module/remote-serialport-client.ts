import EventEmitter from "events";

import { MockBinding, MockBindingInterface, CreatePortOptions } from "@serialport/binding-mock";
import { SerialPortStream, OpenOptions } from "@serialport/stream";
import { BindingInterface } from "@serialport/bindings-interface";

import { AbsTransport } from "../types/remote-serialport-types/src/transport";

import {
    REMOTE_SERIALPORT_PROTOCOL_VERSION,
    RemoteSerialPortState,
    SerialPortPacket,
    SocketServerSideEmitChannel_Handshake,
    SocketServerSideEmitChannel_State,
    SocketServerSideEmitChannel_Packet,
    SocketServerSideEmitChannel_Drain,
    SocketServerSideEmitChannel_Mux_State,
    SocketServerSideEmitChannel_Mux_Packet,
    SocketServerSideEmitChannel_Mux_Drain,
    SocketServerSideEmitPayload_Handshake,
    SocketServerSideEmitPayload_State,
    SocketServerSideEmitPayload_Mux_State,
    SocketServerSideEmitPayload_Mux_Packet,
    SocketServerSideEmitPayload_Mux_Drain,
    SocketClientSideEmitChannel_Open,
    SocketClientSideEmitChannel_Close,
    SocketClientSideEmitChannel_SendPacket,
    SocketClientSideEmitChannel_Mux_Open,
    SocketClientSideEmitChannel_Mux_Close,
    SocketClientSideEmitChannel_Mux_SendPacket,
    SocketClientSideEmitPayload_Open,
    SocketClientSideEmitPayload_Mux_Open,
    SocketClientSideEmitPayload_Mux_Close,
    SocketClientSideEmitPayload_Mux_SendPacket,
    SocketClientSideRpcChannel_Set,
    SocketClientSideRpcChannel_Update,
    SocketClientSideRpcChannel_Flush,
    SocketClientSideRpcChannel_Mux_Set,
    SocketClientSideRpcChannel_Mux_Update,
    SocketClientSideRpcChannel_Mux_Flush,
    SocketClientSideRpcPayload_Set,
    SocketClientSideRpcPayload_Update,
    SocketClientSideRpcPayload_Mux_Set,
    SocketClientSideRpcPayload_Mux_Update,
    SocketClientSideRpcPayload_Mux_Flush,
    SocketRpcResponse_Status,
    SocketRpcResponse_List,
    SocketClientSideTxnChannel_Begin,
    SocketClientSideTxnChannel_Chunk,
    SocketClientSideTxnChannel_End,
    SocketClientSideTxnChannel_Abort,
    SocketClientSideTxnChannel_Mux_Begin,
    SocketClientSideTxnChannel_Mux_Chunk,
    SocketClientSideTxnChannel_Mux_End,
    SocketClientSideTxnChannel_Mux_Abort,
    SocketClientSideTxnPayload_Begin,
    SocketClientSideTxnPayload_Chunk,
    SocketClientSideTxnPayload_End,
    SocketClientSideTxnPayload_Abort,
    SocketClientSideTxnPayload_Mux_Begin,
    SocketClientSideTxnPayload_Mux_Chunk,
    SocketClientSideTxnPayload_Mux_End,
    SocketClientSideTxnPayload_Mux_Abort
} from "../types/remote-serialport-types/src/index";

import {
    AbsRemoteSerialportClientPortInstance,
    AbsRemoteSerialportClientSocket,
    AbsRemoteSerialportClientMuxSocket,
    AbsRemoteSerialportClientTxnHandle,
    OpenOptionsForSerialPortStream
} from "../types/remote-serialport-types/src/remote-serial-client.model";

import { OpenSerialPortOptions, SetOptions, UpdateOptions, PortStatus, PortInfo } from "../types/remote-serialport-types/src/serialport";
import { Logger } from "../types/remote-serialport-types/src/logger";
import { default_logger } from "./logger";

// RPC tracking + replay-on-reconnect lives on the transport now (see `socketio-transport.ts`).
// The historical `RpcDispatcherOptions` type is re-exported from there for `RemoteSerialportClient`
// option compatibility.
import { RPC_TIMEOUT_MS, RpcDispatcherOptions } from "./socketio-transport";
export { RPC_TIMEOUT_MS, RpcDispatcherOptions };

/**
 * Helper for the recurring "transport.send_rpc + extract typed value + check ok flag" pattern.
 * Centralizes the failure-message logic so every RPC call site stays one line.
 */
function rpc_call<T>(transport: AbsTransport, channel: string, payload: object, timeout_ms: number, extract: (response: { ok?: boolean; message?: string } & Record<string, unknown>) => T): Promise<T> {
    return transport.send_rpc(channel, payload, timeout_ms).then((raw: unknown): T => {
        const response = (raw ?? {}) as { ok?: boolean; message?: string } & Record<string, unknown>;
        if (response.ok !== true) {
            throw new Error(response.message ?? `RPC "${channel}" failed`);
        }
        return extract(response);
    });
}

/* eslint-disable no-console, no-undef */

/** Default number of in-flight write packets allowed before {@link RemoteSerialportStream.write} returns `false`. */
export const DEFAULT_BACKPRESSURE_WINDOW = 64;

/**
 * Per-remote-port write-window backpressure gate.
 *
 * Every `serialport_send_packet` consumes a slot; every `serialport_drain` from the server frees one.
 * When the window fills, `write()` returns `false`; when it drains below the window again, the stream
 * emits `'drain'`.
 */
/** Per-consume hook so individual writes (e.g. txn `end()`) can await their own drain ack. */
export interface AckResolver {
    resolve(): void;
    reject(error: Error): void;
}

export class BackpressureGate {
    private _outstanding = 0;

    private _writable = true;

    private readonly _window: number;

    private readonly _drain_listeners: Set<() => void> = new Set();

    /**
     * FIFO of optional resolvers, one per outstanding write. `null` for single-shot writes that
     * don't care about per-ack notification; a resolver for txn `end()` waits. Server processes
     * writes in arrival order, so its drains pop this queue in the same order.
     */
    private _ack_resolvers: Array<AckResolver | null> = [];

    constructor(window: number = DEFAULT_BACKPRESSURE_WINDOW) {
        this._window = window;
    }

    get writable(): boolean {
        return this._writable;
    }

    on_drain(listener: () => void): void {
        this._drain_listeners.add(listener);
    }

    off_drain(listener: () => void): void {
        this._drain_listeners.delete(listener);
    }

    consume(resolver: AckResolver | null = null): void {
        this._outstanding++;
        this._ack_resolvers.push(resolver);
        if (this._outstanding >= this._window) {
            this._writable = false;
        }
    }

    ack(): void {
        if (this._outstanding > 0) {
            this._outstanding--;
        }
        const resolver: AckResolver | null | undefined = this._ack_resolvers.shift();
        if (resolver !== null && resolver !== undefined) {
            resolver.resolve();
        }
        if (this._writable === false && this._outstanding < this._window) {
            this._writable = true;
            for (const listener of this._drain_listeners) {
                listener();
            }
        }
    }

    reset(): void {
        const queued: Array<AckResolver | null> = this._ack_resolvers;
        this._ack_resolvers = [];
        for (const resolver of queued) {
            if (resolver !== null) {
                resolver.reject(new Error("backpressure gate reset"));
            }
        }
        this._outstanding = 0;
        this._writable = true;
        this._drain_listeners.clear();
    }
}

/**
 * Internal event emitter bridging a local virtual port and its owning socket: `write-command` carries
 * bytes the app wrote into the local virtual port, which the socket forwards to the remote end.
 */
export class RemoteSerialClientPortInstanceEventEmitter extends EventEmitter {
    constructor() {
        super();
    }

    emit(channel: "write-command", data: Buffer | Array<number>): boolean;
    emit(channel: string | symbol, ...args: any[]): boolean;
    emit(channel: string | symbol, ...args: any[]): boolean {
        return super.emit(channel, ...args);
    }

    on(channel: "write-command", listener: (data: Buffer | Array<number>) => void): this;
    on(channel: string | symbol, listener: (...args: any[]) => void): this;
    on(channel: string | symbol, listener: (...args: any[]) => void): this {
        super.on(channel, listener);
        return this;
    }

    once(channel: "write-command", listener: (data: Buffer | Array<number>) => void): this;
    once(channel: string | symbol, listener: (...args: any[]) => void): this;
    once(channel: string | symbol, listener: (...args: any[]) => void): this {
        super.once(channel, listener);
        return this;
    }
}

/**
 * A local virtual serial port stream (mock-binding backed) handed to the app.
 *
 * Reads: bytes the remote port produced are pushed in via {@link write_from_physical_remote_write}
 * (it goes through `super.write()` with `echo: true`, so the app sees it as inbound `data`).
 * Writes: the app's `write()` is overridden to *not* touch the mock binding, instead it emits
 * `write-command` (forwarded to the remote end by the socket) and participates in backpressure.
 */
export class RemoteSerialportStream extends SerialPortStream {
    private readonly _port_emitter: RemoteSerialClientPortInstanceEventEmitter;

    private readonly _gate: BackpressureGate;

    private readonly _on_gate_drain: () => void = (): void => {
        this.emit("drain");
    };

    constructor(options: OpenOptions, port_emitter: RemoteSerialClientPortInstanceEventEmitter, gate: BackpressureGate) {
        super(options);
        this._port_emitter = port_emitter;
        this._gate = gate;
        this._gate.on_drain(this._on_gate_drain);
    }

    override write(chunk: Buffer | Array<number>, encoding?: BufferEncoding, cb?: (error: Error | null | undefined) => void): boolean;
    override write(chunk: Buffer | Array<number>, cb?: (error: Error | null | undefined) => void): boolean;
    override write(chunk: Buffer | Array<number>, encoding?: any, cb?: any): boolean {
        const callback: ((error: Error | null | undefined) => void) | undefined = typeof encoding === "function" ? encoding : cb;
        this._port_emitter.emit("write-command", chunk);
        if (typeof callback === "function") {
            process.nextTick((): void => callback(null));
        }
        return this._gate.writable;
    }

    /**
     * Push bytes received from the remote serial port into this local virtual port so the app reading
     * the stream sees them. Goes through the real `SerialPortStream.write()` (separate from the app's
     * overridden `write()` above), so an app write and an inbound packet never get concatenated.
     */
    write_from_physical_remote_write(chunk: Buffer | Array<number>): boolean {
        return super.write(chunk as Buffer);
    }

    /** Detach from the backpressure gate (called on close). */
    detach_gate(): void {
        this._gate.off_drain(this._on_gate_drain);
    }
}

/**
 * One local virtual serial port that mirrors one remote serial port.
 */
export class RemoteSerialClientPortInstance extends AbsRemoteSerialportClientPortInstance {
    protected port_path: string;

    private readonly _mock_binding: MockBindingInterface;

    private readonly _port_emitter: RemoteSerialClientPortInstanceEventEmitter;

    private readonly _gate: BackpressureGate;

    private readonly _logger: Logger;

    private _stream: RemoteSerialportStream | null = null;

    private _state: RemoteSerialPortState = RemoteSerialPortState.IDLE;

    constructor(local_path: string, mock_binding: MockBindingInterface, port_emitter: RemoteSerialClientPortInstanceEventEmitter, gate: BackpressureGate, logger: Logger = default_logger) {
        super();
        this.port_path = local_path;
        this._mock_binding = mock_binding;
        this._port_emitter = port_emitter;
        this._gate = gate;
        this._logger = logger;
    }

    get state(): RemoteSerialPortState {
        return this._state;
    }

    /**
     * Updated by the owning socket when the remote port's state changes. On `ERROR` / `CLOSED` the
     * local virtual stream re-emits `'error'` / `'close'` so apps using standard serialport handlers
     * react to remote events. (`'error'` is only emitted if a listener is attached, to avoid
     * crashing apps that don't handle it; a warning is logged otherwise.)
     */
    set_state(state: RemoteSerialPortState, message?: string): void {
        const previous: RemoteSerialPortState = this._state;
        this._state = state;
        if (this._stream === null || state === previous) {
            return;
        }
        if (state === RemoteSerialPortState.ERROR) {
            const error: Error = new Error(message ?? `remote serial port "${this.port_path}" error`);
            if (this._stream.listenerCount("error") > 0) {
                this._stream.emit("error", error);
            } else {
                this._logger.warn(`unhandled remote port error on "${this.port_path}": ${error.message}`);
            }
        } else if (state === RemoteSerialPortState.CLOSED) {
            this._stream.emit("close");
        }
    }

    get_port(open_options: OpenOptionsForSerialPortStream): RemoteSerialportStream {
        if (open_options === undefined || open_options === null) {
            throw new Error("Invalid Open Options");
        }
        if (this._stream !== null) {
            return this._stream;
        }
        const options = { ...open_options, binding: this._mock_binding, path: this.port_path } as unknown as OpenOptions<BindingInterface>;
        this._stream = new RemoteSerialportStream(options, this._port_emitter, this._gate);
        return this._stream;
    }

    write(data: SerialPortPacket): void {
        if (this._stream !== null) {
            this._stream.write_from_physical_remote_write(data as Buffer);
        }
    }

    close(): void {
        if (this._stream !== null) {
            this._stream.detach_gate();
            try {
                this._stream.close((): void => undefined);
            } catch {
                // ignore
            }
            try {
                this._stream.destroy();
            } catch {
                // ignore
            }
            this._stream = null;
        }
        this._state = RemoteSerialPortState.CLOSED;
    }

    // Stage 4 will wire these to the owning socket's txn allocator + ack-resolver queue.
    // The owning socket sets this hook on create_port; until then, `txn()` throws clearly.
    private _txn_opener: (() => AbsRemoteSerialportClientTxnHandle) | null = null;

    /** @internal Set by the owning socket; do not call from app code. */
    install_txn_opener(opener: () => AbsRemoteSerialportClientTxnHandle): void {
        this._txn_opener = opener;
    }

    txn(): AbsRemoteSerialportClientTxnHandle {
        if (this._txn_opener === null) {
            throw new Error(`txn() is not yet wired for "${this.port_path}"; this is a library bug`);
        }
        return this._txn_opener();
    }

    async with_txn<T>(fn: (handle: AbsRemoteSerialportClientTxnHandle) => Promise<T> | T): Promise<T> {
        const handle: AbsRemoteSerialportClientTxnHandle = this.txn();
        try {
            const result: T = await fn(handle);
            await handle.end();
            return result;
        } catch (error) {
            try { handle.abort(); } catch { /* ignore abort errors */ }
            throw error;
        }
    }
}

/**
 * How a {@link RemoteSerialportClient} allocates `txn_id` strings.
 *
 * - `'counter'` (default): per-socket monotonic counter (`"0"`, `"1"`, ...). No round-trips, smallest
 *   payload. Server scopes uniqueness by `(socket.id, txn_id)`.
 * - `'uuid'`: per-call UUID v4. Globally unique, easier to trace; larger payload.
 * - Custom function: provide your own.
 */
export type TxnIdAllocatorSpec = "counter" | "uuid" | (() => string);

/** Build a `() => string` allocator from a {@link TxnIdAllocatorSpec}. */
export function make_txn_id_allocator(spec: TxnIdAllocatorSpec): () => string {
    if (typeof spec === "function") {
        return spec;
    }
    if (spec === "uuid") {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { randomUUID } = require("crypto");
        return (): string => randomUUID();
    }
    let n = 0;
    return (): string => String(n++);
}

/**
 * Concrete implementation of a client-side multi-chunk transaction. Holds its allocated `txn_id`
 * and emits the protocol channels via callbacks bound by the owning socket (so this class is the
 * same in namespace mode and mux mode — only the emit closures differ).
 */
export class RemoteSerialClientTxnHandle extends AbsRemoteSerialportClientTxnHandle {
    public readonly txn_id: string;

    private _state: "open" | "ended" | "aborted" = "open";

    private _end_promise: Promise<void> | null = null;

    private readonly _emit_chunk: (data: SerialPortPacket) => void;

    private readonly _emit_end: () => void;

    private readonly _emit_abort: () => void;

    private readonly _gate: BackpressureGate;

    constructor(
        txn_id: string,
        emit_begin: () => void,
        emit_chunk: (data: SerialPortPacket) => void,
        emit_end: () => void,
        emit_abort: () => void,
        gate: BackpressureGate
    ) {
        super();
        this.txn_id = txn_id;
        this._emit_chunk = emit_chunk;
        this._emit_end = emit_end;
        this._emit_abort = emit_abort;
        this._gate = gate;
        // Announce begin synchronously so the server can start buffering / timing the txn.
        emit_begin();
    }

    write(chunk: Buffer | Array<number>): void {
        if (this._state !== "open") {
            throw new Error(`txn ${this.txn_id} is ${this._state}; cannot write`);
        }
        this._emit_chunk(chunk as SerialPortPacket);
    }

    end(): Promise<void> {
        if (this._end_promise !== null) {
            return this._end_promise;
        }
        if (this._state === "aborted") {
            return Promise.reject(new Error(`txn ${this.txn_id} was aborted`));
        }
        this._state = "ended";
        this._emit_end();
        this._end_promise = new Promise<void>((resolve, reject): void => {
            this._gate.consume({ resolve: resolve, reject: reject });
        });
        return this._end_promise;
    }

    abort(): void {
        if (this._state !== "open") {
            return;
        }
        this._state = "aborted";
        this._emit_abort();
    }
}

/* ============================================================================
 * Namespace mode
 * ========================================================================== */

/**
 * Client side of one remote serial port, addressed by a socket.io namespace.
 */
export class RemoteSerialClientSocket extends AbsRemoteSerialportClientSocket {
    protected _transport: AbsTransport;

    protected _open_options: OpenSerialPortOptions | null;

    private readonly _logger: Logger;

    private readonly _namespace_path: string;

    private readonly _rpc_timeout_ms: number;

    private _state: RemoteSerialPortState = RemoteSerialPortState.IDLE;

    private _handshaked = false;

    private _open_sent = false;

    private readonly _port_instances: Map<string, RemoteSerialClientPortInstance> = new Map();

    private readonly _data_event_emitter: RemoteSerialClientPortInstanceEventEmitter = new RemoteSerialClientPortInstanceEventEmitter();

    private readonly _gate: BackpressureGate = new BackpressureGate();

    private readonly _allocate_txn_id: () => string;

    constructor(transport: AbsTransport, namespace: string, open_options: OpenSerialPortOptions | null, logger: Logger = default_logger, rpc_options: RpcDispatcherOptions = {}, txn_id_allocator: TxnIdAllocatorSpec = "counter") {
        super();
        this._transport = transport;
        this._open_options = open_options;
        this._logger = logger;
        this._namespace_path = namespace;
        this._rpc_timeout_ms = rpc_options.timeout_ms ?? RPC_TIMEOUT_MS;
        this._allocate_txn_id = make_txn_id_allocator(txn_id_allocator);

        this._transport.on_lifecycle("connect", (): void => {
            this._handshaked = false;
            this._open_sent = false;
        });

        // Surface abrupt transport disconnect (e.g. server crash, network drop with no
        // protocol-level close) to the local virtual stream. Without this, the transport's
        // disconnect lifecycle fires but `port.on("error" / "close")` never does, so naive
        // serialport code hangs waiting on a dead remote. We wait a grace period so the
        // auto-reconnecting transports (socket.io) get to recover transparently and don't spam
        // ERROR on transient blips.
        this._transport.on_lifecycle("disconnect", (): void => {
            if (this._port_instances.size === 0) return; // user disconnect already cleared map
            let listener_removed = false;
            let on_reconnect: (() => void) | null = null;
            const remove_listener = (): void => {
                if (listener_removed === true || on_reconnect === null) return;
                listener_removed = true;
                this._transport.off_lifecycle("reconnect", on_reconnect);
            };
            let cancelled = false;
            const grace_timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
                remove_listener();
                if (cancelled === true) return;
                for (const instance of this._port_instances.values()) {
                    // L1 collapse: always detach the on_reconnect listener when the timer fires
                    // (previously only the reconnect branch removed it; storms of disconnects
                    // with no reconnects would accumulate listeners until reconnect finally
                    // fired). Now cleanup is guaranteed regardless of outcome.
                    instance.set_state(RemoteSerialPortState.ERROR, "transport disconnected");
                    instance.set_state(RemoteSerialPortState.CLOSED);
                }
            }, 500);
            if (typeof (grace_timer as { unref?: () => void }).unref === "function") {
                (grace_timer as { unref: () => void }).unref();
            }
            on_reconnect = (): void => {
                cancelled = true;
                clearTimeout(grace_timer);
                remove_listener();
            };
            this._transport.on_lifecycle("reconnect", on_reconnect);
        });

        this.on("serialport_handshake", (data: SocketServerSideEmitPayload_Handshake): void => {
            if (typeof data?.protocolVersion === "number" && data.protocolVersion !== REMOTE_SERIALPORT_PROTOCOL_VERSION) {
                this._logger.warn(`protocol version mismatch: server=${data.protocolVersion}, client=${REMOTE_SERIALPORT_PROTOCOL_VERSION}`);
            }
            this._handshaked = true;
            if (this._open_options !== null) {
                this._send_open(this._open_options);
            }
        });

        this.on("serialport_state", (data: SocketServerSideEmitPayload_State): void => {
            this._state = data.state;
            for (const instance of this._port_instances.values()) {
                instance.set_state(data.state, data.message);
            }
            if (data.state === RemoteSerialPortState.ERROR) {
                this._logger.debug(`remote port error: ${data.message ?? ""}`);
            }
        });

        // remote port bytes -> every local mirror of this port (broadcast: one namespace = one remote port)
        this.on("serialport_packet", (chunk: SerialPortPacket): void => {
            for (const instance of this._port_instances.values()) {
                instance.write(chunk);
            }
        });

        this.on("serialport_drain", (): void => {
            this._gate.ack();
        });

        // local app write -> remote
        this._data_event_emitter.on("write-command", (data: Buffer | Array<number>): void => {
            this.emit("serialport_send_packet", data as SerialPortPacket);
            this._gate.consume();
        });
    }

    private _send_open(options: OpenSerialPortOptions): void {
        if (this._open_sent === true) {
            return;
        }
        this._open_sent = true;
        const path: string = (options.path as string | undefined) ?? this._namespace_path;
        this.emit("serialport_open", { path: path, options: options });
    }

    get state(): RemoteSerialPortState {
        return this._state;
    }

    open(options: OpenSerialPortOptions): void {
        this._open_options = options;
        if (this._handshaked === true) {
            this._send_open(options);
        }
    }

    close(): void {
        this.emit("serialport_close");
    }

    /* ---- remote physical-port control (RPC; does not touch the local virtual port) ---- */

    set_remote(options: SetOptions): void {
        this.emit("serialport_set", { options: options });
    }

    update_remote(options: UpdateOptions): void {
        this.emit("serialport_update", { options: options });
    }

    flush_remote(): void {
        this.emit("serialport_flush");
    }

    get_remote_status(): Promise<PortStatus> {
        return rpc_call<PortStatus>(this._transport, "serialport_get", {}, this._rpc_timeout_ms, (response): PortStatus => (response as SocketRpcResponse_Status).status as PortStatus);
    }

    list_ports(): Promise<PortInfo[]> {
        return rpc_call<PortInfo[]>(this._transport, "serialport_list", {}, this._rpc_timeout_ms, (response): PortInfo[] => (response as SocketRpcResponse_List).ports ?? []);
    }

    create_port(local_path: string, opt?: CreatePortOptions): RemoteSerialClientPortInstance {
        const existing: RemoteSerialClientPortInstance | undefined = this._port_instances.get(local_path);
        if (existing !== undefined) {
            return existing;
        }
        const options: CreatePortOptions = { ...(opt ?? {}), echo: true }; // echo must be on to surface remote bytes
        MockBinding.createPort(local_path, options);
        const instance: RemoteSerialClientPortInstance = new RemoteSerialClientPortInstance(local_path, MockBinding, this._data_event_emitter, this._gate, this._logger);
        instance.set_state(this._state);
        // Wire txn(): every call allocates a fresh txn_id and binds the emit closures to this socket.
        instance.install_txn_opener((): AbsRemoteSerialportClientTxnHandle => {
            const txn_id: string = this._allocate_txn_id();
            return new RemoteSerialClientTxnHandle(
                txn_id,
                (): void => this.emit("serialport_send_begin", { txn_id: txn_id }),
                (data: SerialPortPacket): void => this.emit("serialport_send_chunk", { txn_id: txn_id, data: data }),
                (): void => this.emit("serialport_send_end", { txn_id: txn_id }),
                (): void => this.emit("serialport_send_abort", { txn_id: txn_id }),
                this._gate
            );
        });
        this._port_instances.set(local_path, instance);
        return instance;
    }

    emit(channel: SocketClientSideEmitChannel_SendPacket, message: SerialPortPacket): void;
    emit(channel: SocketClientSideEmitChannel_Open, message: SocketClientSideEmitPayload_Open): void;
    emit(channel: SocketClientSideEmitChannel_Close): void;
    emit(channel: SocketClientSideRpcChannel_Set, message: SocketClientSideRpcPayload_Set): void;
    emit(channel: SocketClientSideRpcChannel_Update, message: SocketClientSideRpcPayload_Update): void;
    emit(channel: SocketClientSideRpcChannel_Flush): void;
    emit(channel: SocketClientSideTxnChannel_Begin, message: SocketClientSideTxnPayload_Begin): void;
    emit(channel: SocketClientSideTxnChannel_Chunk, message: SocketClientSideTxnPayload_Chunk): void;
    emit(channel: SocketClientSideTxnChannel_End, message: SocketClientSideTxnPayload_End): void;
    emit(channel: SocketClientSideTxnChannel_Abort, message: SocketClientSideTxnPayload_Abort): void;
    emit(channel: string, message?: any): void {
        if (arguments.length < 2) {
            this._transport.send(channel);
        } else {
            this._transport.send(channel, message);
        }
    }

    on(channel: SocketServerSideEmitChannel_Handshake, listener: (data: SocketServerSideEmitPayload_Handshake) => void): void;
    on(channel: SocketServerSideEmitChannel_State, listener: (data: SocketServerSideEmitPayload_State) => void): void;
    on(channel: SocketServerSideEmitChannel_Packet, listener: (data: SerialPortPacket) => void): void;
    on(channel: SocketServerSideEmitChannel_Drain, listener: () => void): void;
    on(channel: string, listener: (...args: any[]) => void): void {
        this._transport.on(channel, listener);
    }

    once(channel: SocketServerSideEmitChannel_Handshake, listener: (data: SocketServerSideEmitPayload_Handshake) => void): void;
    once(channel: SocketServerSideEmitChannel_State, listener: (data: SocketServerSideEmitPayload_State) => void): void;
    once(channel: SocketServerSideEmitChannel_Packet, listener: (data: SerialPortPacket) => void): void;
    once(channel: SocketServerSideEmitChannel_Drain, listener: () => void): void;
    once(channel: string, listener: (...args: any[]) => void): void {
        this._transport.once(channel, listener);
    }

    disconnect(_close?: boolean): void {
        for (const instance of this._port_instances.values()) {
            instance.close();
        }
        this._port_instances.clear();
        this._data_event_emitter.removeAllListeners();
        this._gate.reset();
        // Transport handles its own RPC-pending cleanup + socket close.
        this._transport.close();
        this._state = RemoteSerialPortState.CLOSED;
    }
}

/* ============================================================================
 * Mux mode
 * ========================================================================== */

/**
 * Client side of a mux connection: one socket on a mux namespace carrying many remote serial ports,
 * each addressed by `path`.
 */
export class RemoteSerialClientMuxSocket extends AbsRemoteSerialportClientMuxSocket {
    protected _transport: AbsTransport;

    private readonly _logger: Logger;

    private readonly _rpc_timeout_ms: number;

    private _handshaked = false;

    /** state per remote path. */
    private readonly _states: Map<string, RemoteSerialPortState> = new Map();

    /** local virtual port + which remote path it mirrors, keyed by local path. */
    private readonly _port_instances: Map<string, { remote_path: string; instance: RemoteSerialClientPortInstance }> = new Map();

    /** local paths mirroring a given remote path. */
    private readonly _by_remote_path: Map<string, Set<string>> = new Map();

    /** per-remote-path backpressure gate. */
    private readonly _gates: Map<string, BackpressureGate> = new Map();

    /**
     * Opens that have been requested (by `open()`) and should be reissued on every (re)connect,
     * keyed by remote path. Stays populated for the lifetime of the mux socket — kept across
     * reconnects so the server re-opens the ports the client expects after a transport drop.
     * Removed only by `close(remote_path)` or `disconnect()`.
     */
    private readonly _active_opens: Map<string, OpenSerialPortOptions> = new Map();

    private readonly _allocate_txn_id: () => string;

    constructor(transport: AbsTransport, logger: Logger = default_logger, rpc_options: RpcDispatcherOptions = {}, txn_id_allocator: TxnIdAllocatorSpec = "counter") {
        super();
        this._transport = transport;
        this._logger = logger;
        this._rpc_timeout_ms = rpc_options.timeout_ms ?? RPC_TIMEOUT_MS;
        this._allocate_txn_id = make_txn_id_allocator(txn_id_allocator);

        this._transport.on_lifecycle("connect", (): void => {
            this._handshaked = false;
        });

        // See namespace-mode equivalent: surface abrupt transport disconnect to local virtual
        // streams across all open mux paths, after a grace period so auto-reconnect transports
        // (socket.io) don't spam ERROR on transient drops.
        this._transport.on_lifecycle("disconnect", (): void => {
            if (this._port_instances.size === 0) return;
            let cancelled = false;
            const grace_timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
                if (cancelled === true) return;
                for (const { instance } of this._port_instances.values()) {
                    instance.set_state(RemoteSerialPortState.ERROR, "transport disconnected");
                    instance.set_state(RemoteSerialPortState.CLOSED);
                }
            }, 500);
            if (typeof (grace_timer as { unref?: () => void }).unref === "function") {
                (grace_timer as { unref: () => void }).unref();
            }
            const on_reconnect = (): void => {
                cancelled = true;
                clearTimeout(grace_timer);
                this._transport.off_lifecycle("reconnect", on_reconnect);
            };
            this._transport.on_lifecycle("reconnect", on_reconnect);
        });

        this.on("serialport_handshake", (data: SocketServerSideEmitPayload_Handshake): void => {
            if (typeof data?.protocolVersion === "number" && data.protocolVersion !== REMOTE_SERIALPORT_PROTOCOL_VERSION) {
                this._logger.warn(`protocol version mismatch: server=${data.protocolVersion}, client=${REMOTE_SERIALPORT_PROTOCOL_VERSION}`);
            }
            this._handshaked = true;
            // Replay every currently-active open. After a reconnect this re-opens ports that the
            // client still expects to be open; on the first connect this just replays whatever the
            // caller requested while waiting for handshake.
            for (const [path, options] of this._active_opens) {
                this.emit("serialport_mux_open", { path: path, options: options });
            }
        });

        this.on("serialport_mux_state", (data: SocketServerSideEmitPayload_Mux_State): void => {
            this._states.set(data.path, data.state);
            const local_paths: Set<string> | undefined = this._by_remote_path.get(data.path);
            if (local_paths !== undefined) {
                for (const local_path of local_paths) {
                    this._port_instances.get(local_path)?.instance.set_state(data.state, data.message);
                }
            }
            if (data.state === RemoteSerialPortState.ERROR) {
                this._logger.debug(`remote port "${data.path}" error: ${data.message ?? ""}`);
            }
        });

        this.on("serialport_mux_packet", (message: SocketServerSideEmitPayload_Mux_Packet): void => {
            const local_paths: Set<string> | undefined = this._by_remote_path.get(message.path);
            if (local_paths === undefined) {
                return;
            }
            for (const local_path of local_paths) {
                this._port_instances.get(local_path)?.instance.write(message.data);
            }
        });

        this.on("serialport_mux_drain", (message: SocketServerSideEmitPayload_Mux_Drain): void => {
            this._gates.get(message.path)?.ack();
        });
    }

    private _gate_for(remote_path: string): BackpressureGate {
        let gate: BackpressureGate | undefined = this._gates.get(remote_path);
        if (gate === undefined) {
            gate = new BackpressureGate();
            this._gates.set(remote_path, gate);
        }
        return gate;
    }

    get_state(path: string): RemoteSerialPortState {
        return this._states.get(path) ?? RemoteSerialPortState.IDLE;
    }

    open(remote_path: string, options: OpenSerialPortOptions): void {
        // Track the intent so it survives reconnects; emit only if handshake is done (otherwise the
        // handshake handler will replay everything in `_active_opens`).
        this._active_opens.set(remote_path, options);
        if (this._handshaked === true) {
            this.emit("serialport_mux_open", { path: remote_path, options: options });
        }
    }

    close(remote_path: string): void {
        // Forget the intent so a future reconnect doesn't re-open it.
        this._active_opens.delete(remote_path);
        this.emit("serialport_mux_close", { path: remote_path });
    }

    /* ---- remote physical-port control (RPC; does not touch the local virtual port) ---- */

    set_remote(remote_path: string, options: SetOptions): void {
        this.emit("serialport_mux_set", { path: remote_path, options: options });
    }

    update_remote(remote_path: string, options: UpdateOptions): void {
        this.emit("serialport_mux_update", { path: remote_path, options: options });
    }

    flush_remote(remote_path: string): void {
        this.emit("serialport_mux_flush", { path: remote_path });
    }

    get_remote_status(remote_path: string): Promise<PortStatus> {
        return rpc_call<PortStatus>(this._transport, "serialport_mux_get", { path: remote_path }, this._rpc_timeout_ms, (response): PortStatus => (response as SocketRpcResponse_Status).status as PortStatus);
    }

    list_ports(): Promise<PortInfo[]> {
        return rpc_call<PortInfo[]>(this._transport, "serialport_list", {}, this._rpc_timeout_ms, (response): PortInfo[] => (response as SocketRpcResponse_List).ports ?? []);
    }

    create_port(remote_path: string, local_path: string, opt?: CreatePortOptions): RemoteSerialClientPortInstance {
        const existing: { remote_path: string; instance: RemoteSerialClientPortInstance } | undefined = this._port_instances.get(local_path);
        if (existing !== undefined) {
            return existing.instance;
        }
        const options: CreatePortOptions = { ...(opt ?? {}), echo: true };
        MockBinding.createPort(local_path, options);

        const gate: BackpressureGate = this._gate_for(remote_path);
        const port_emitter: RemoteSerialClientPortInstanceEventEmitter = new RemoteSerialClientPortInstanceEventEmitter();
        port_emitter.on("write-command", (data: Buffer | Array<number>): void => {
            this.emit("serialport_mux_send_packet", { path: remote_path, data: data as SerialPortPacket });
            gate.consume();
        });

        const instance: RemoteSerialClientPortInstance = new RemoteSerialClientPortInstance(local_path, MockBinding, port_emitter, gate, this._logger);
        instance.set_state(this.get_state(remote_path));
        // Wire txn(): every call allocates a fresh txn_id and binds the emit closures to this mux socket + this remote path.
        instance.install_txn_opener((): AbsRemoteSerialportClientTxnHandle => {
            const txn_id: string = this._allocate_txn_id();
            return new RemoteSerialClientTxnHandle(
                txn_id,
                (): void => this.emit("serialport_mux_send_begin", { path: remote_path, txn_id: txn_id }),
                (data: SerialPortPacket): void => this.emit("serialport_mux_send_chunk", { path: remote_path, txn_id: txn_id, data: data }),
                (): void => this.emit("serialport_mux_send_end", { path: remote_path, txn_id: txn_id }),
                (): void => this.emit("serialport_mux_send_abort", { path: remote_path, txn_id: txn_id }),
                gate
            );
        });
        this._port_instances.set(local_path, { remote_path: remote_path, instance: instance });

        let set: Set<string> | undefined = this._by_remote_path.get(remote_path);
        if (set === undefined) {
            set = new Set();
            this._by_remote_path.set(remote_path, set);
        }
        set.add(local_path);

        return instance;
    }

    emit(channel: SocketClientSideEmitChannel_Mux_Open, message: SocketClientSideEmitPayload_Mux_Open): void;
    emit(channel: SocketClientSideEmitChannel_Mux_Close, message: SocketClientSideEmitPayload_Mux_Close): void;
    emit(channel: SocketClientSideEmitChannel_Mux_SendPacket, message: SocketClientSideEmitPayload_Mux_SendPacket): void;
    emit(channel: SocketClientSideRpcChannel_Mux_Set, message: SocketClientSideRpcPayload_Mux_Set): void;
    emit(channel: SocketClientSideRpcChannel_Mux_Update, message: SocketClientSideRpcPayload_Mux_Update): void;
    emit(channel: SocketClientSideRpcChannel_Mux_Flush, message: SocketClientSideRpcPayload_Mux_Flush): void;
    emit(channel: SocketClientSideTxnChannel_Mux_Begin, message: SocketClientSideTxnPayload_Mux_Begin): void;
    emit(channel: SocketClientSideTxnChannel_Mux_Chunk, message: SocketClientSideTxnPayload_Mux_Chunk): void;
    emit(channel: SocketClientSideTxnChannel_Mux_End, message: SocketClientSideTxnPayload_Mux_End): void;
    emit(channel: SocketClientSideTxnChannel_Mux_Abort, message: SocketClientSideTxnPayload_Mux_Abort): void;
    emit(channel: string, message: any): void {
        this._transport.send(channel, message);
    }

    on(channel: SocketServerSideEmitChannel_Handshake, listener: (data: SocketServerSideEmitPayload_Handshake) => void): void;
    on(channel: SocketServerSideEmitChannel_Mux_State, listener: (data: SocketServerSideEmitPayload_Mux_State) => void): void;
    on(channel: SocketServerSideEmitChannel_Mux_Packet, listener: (data: SocketServerSideEmitPayload_Mux_Packet) => void): void;
    on(channel: SocketServerSideEmitChannel_Mux_Drain, listener: (data: SocketServerSideEmitPayload_Mux_Drain) => void): void;
    on(channel: string, listener: (...args: any[]) => void): void {
        this._transport.on(channel, listener);
    }

    once(channel: SocketServerSideEmitChannel_Handshake, listener: (data: SocketServerSideEmitPayload_Handshake) => void): void;
    once(channel: SocketServerSideEmitChannel_Mux_State, listener: (data: SocketServerSideEmitPayload_Mux_State) => void): void;
    once(channel: SocketServerSideEmitChannel_Mux_Packet, listener: (data: SocketServerSideEmitPayload_Mux_Packet) => void): void;
    once(channel: SocketServerSideEmitChannel_Mux_Drain, listener: (data: SocketServerSideEmitPayload_Mux_Drain) => void): void;
    once(channel: string, listener: (...args: any[]) => void): void {
        this._transport.once(channel, listener);
    }

    disconnect(_close?: boolean): void {
        for (const entry of this._port_instances.values()) {
            entry.instance.close();
        }
        this._port_instances.clear();
        this._by_remote_path.clear();
        for (const gate of this._gates.values()) {
            gate.reset();
        }
        this._gates.clear();
        this._states.clear();
        this._active_opens.clear();
        // Transport handles its own RPC-pending cleanup + socket close.
        this._transport.close();
    }
}
