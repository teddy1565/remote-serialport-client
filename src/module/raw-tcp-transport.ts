import { randomUUID } from "crypto";
import { Socket, connect as netConnect } from "net";
import { connect as tlsConnect, TLSSocket, ConnectionOptions as TlsConnectionOptions } from "tls";

import {
    AbsTransport,
    AbsTransportClient,
    TransportAckCallback,
    TransportLifecycleEvent,
    TransportMessageListener
} from "../types/remote-serialport-types/src/transport";
import { Logger } from "../types/remote-serialport-types/src/logger";
import { default_logger } from "./logger";
import { Envelope, FrameDecoder, encode } from "./shared/envelope-codec";

/**
 * Where to connect. TCP form has `host` + `port`; UDS / Named Pipe form has `path`. TLS only
 * applies to TCP.
 */
export type RawTcpConnectTarget = { host: string; port: number } | { path: string };

export interface RawTcpClientOptions {
    /** `"single-namespace"` (one TCP conn = one namespace) or `"mux"` (default). */
    mode?: "single-namespace" | "mux";
    /** TLS options. Pass `{}` to enable TLS with system CA + verify; pass `{rejectUnauthorized:false}` for self-signed dev. */
    tls?: TlsConnectionOptions;
    /** TCP keepalive. Boolean shorthand uses 30s. */
    keep_alive?: boolean | { initial_delay_ms: number };
    /** Credential forwarded with every `hello` envelope. */
    auth?: unknown;
    logger?: Logger;
}

function _is_path_target(t: RawTcpConnectTarget): t is { path: string } {
    return Object.prototype.hasOwnProperty.call(t, "path");
}

/* ============================================================================
 * Per-connection multiplexer state (client side).
 * ========================================================================== */

class ClientMux {
    private readonly _socket: Socket | TLSSocket;
    private readonly _decoder: FrameDecoder;
    private readonly _mode: "single-namespace" | "mux";
    private readonly _logger: Logger;
    private readonly _auth: unknown;
    private readonly _transports: Map<string, RawTcpClientTransport> = new Map();
    private _alive = true;
    private _socket_ready = false;
    private readonly _pending_envelopes: Envelope[] = [];

    constructor(
        socket: Socket | TLSSocket,
        mode: "single-namespace" | "mux",
        logger: Logger,
        auth: unknown
    ) {
        this._socket = socket;
        this._mode = mode;
        this._logger = logger;
        this._auth = auth;
        this._decoder = new FrameDecoder(
            (env) => this._on_envelope(env),
            (err) => {
                this._logger.warn(`raw-tcp client: ${err.message}; closing`);
                this.close();
            }
        );
        const ready_event: string = (socket instanceof TLSSocket || (this._socket as any).getCipher !== undefined) ? "secureConnect" : "connect";
        const fire_ready = (): void => {
            if (this._socket_ready === true) return;
            this._socket_ready = true;
            // flush any envelopes that were queued before the socket finished connecting
            for (const env of this._pending_envelopes) this._raw_write(env);
            this._pending_envelopes.length = 0;
            for (const t of this._transports.values()) t._fire_connect();
        };
        socket.once(ready_event, fire_ready);
        socket.on("data", (chunk: Buffer) => this._decoder.push(chunk));
        socket.on("close", () => this._on_close());
        socket.on("error", (err) => {
            this._logger.debug(`raw-tcp client socket error: ${err.message}`);
        });
    }

    register_transport(label: string, transport: RawTcpClientTransport): void {
        this._transports.set(label, transport);
        // Send hello immediately (or after socket ready).
        const hello: Envelope = this._mode === "mux"
            ? { k: "hello", label, ns: label, auth: this._auth }
            : { k: "hello", label, auth: this._auth };
        this.send_envelope(hello);
    }

    send_envelope(env: Envelope): void {
        if (this._alive === false) return;
        if (this._socket_ready === false) {
            this._pending_envelopes.push(env);
            return;
        }
        this._raw_write(env);
    }

    private _raw_write(env: Envelope): void {
        try {
            const frame: Buffer = encode(env);
            this._socket.write(frame);
        } catch (e) {
            this._logger.warn(`raw-tcp client send failed: ${(e as Error).message}`);
        }
    }

    private _on_envelope(env: Envelope): void {
        if (env === null || typeof env !== "object" || typeof (env as any).k !== "string") return;
        switch (env.k) {
            case "msg": {
                let ns: string | null = this._mode === "mux"
                    ? (typeof env.ns === "string" ? env.ns : null)
                    : (this._transports.size === 1 ? this._transports.keys().next().value as string : null);
                if (ns === null) return;
                const t = this._transports.get(ns);
                t?._dispatch_incoming(env);
                return;
            }
            case "ack": {
                // D5: route by `ns` when present (mux mode). ack_id counters are per-transport,
                // so a pre-D5 broadcast could resolve the wrong promise when two transports on
                // the same mux had pending acks with the same id.
                if (this._mode === "mux" && typeof env.ns === "string") {
                    const t = this._transports.get(env.ns);
                    t?._dispatch_ack(env);
                    return;
                }
                for (const t of this._transports.values()) t._dispatch_ack(env);
                return;
            }
            case "bye": {
                if (this._mode === "single-namespace") { this.close(); return; }
                if (typeof env.ns === "string") {
                    const t = this._transports.get(env.ns);
                    t?._on_remote_close();
                    this._transports.delete(env.ns);
                }
                return;
            }
            case "hello":
                // Server should never send hello to client; ignore.
                return;
        }
    }

    get_buffered_amount(): number {
        return (this._socket as Socket).writableLength ?? 0;
    }

    get mode(): "single-namespace" | "mux" { return this._mode; }

    close_namespace(label: string): void {
        if (this._mode === "mux") {
            this.send_envelope({ k: "bye", ns: label });
            const t = this._transports.get(label);
            t?._on_remote_close();
            this._transports.delete(label);
        } else {
            this.close();
        }
    }

    private _on_close(): void {
        if (this._alive === false) return;
        this._alive = false;
        for (const t of this._transports.values()) t._on_remote_close();
        this._transports.clear();
    }

    close(): void {
        if (this._alive === false) return;
        try { this._socket.end(); } catch { /* ignore */ }
        try { this._socket.destroy(); } catch { /* ignore */ }
    }
}

/* ============================================================================
 * Per-namespace transport (client side).
 * ========================================================================== */

class RawTcpClientTransport extends AbsTransport {
    private readonly _id: string;
    private readonly _label: string;
    private readonly _mux: ClientMux;
    private _connected = true;
    private readonly _channel_listeners: Map<string, Set<TransportMessageListener>> = new Map();
    private readonly _lifecycle: Map<TransportLifecycleEvent, Set<(...a: any[]) => void>> = new Map();
    private readonly _pending_rpcs: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
    private _next_ack = 1;

    constructor(label: string, mux: ClientMux) {
        super();
        this._id = randomUUID();
        this._label = label;
        this._mux = mux;
    }

    get id(): string { return this._id; }
    get is_connected(): boolean { return this._connected; }
    get endpoint_label(): string { return this._label; }
    get credential(): unknown { return undefined; }   // client-side: server doesn't push credential to us

    send(channel: string, payload?: unknown): void {
        if (this._connected === false) return;
        const env: Envelope = this._mux.mode === "mux"
            ? { k: "msg", ns: this._label, ch: channel, p: payload }
            : { k: "msg", ch: channel, p: payload };
        this._mux.send_envelope(env);
    }

    send_rpc(channel: string, payload: unknown, timeout_ms: number): Promise<unknown> {
        return new Promise<unknown>((resolve, reject): void => {
            if (this._connected === false) { reject(new Error("transport closed")); return; }
            const ack_id: number = this._next_ack++;
            const timer = setTimeout((): void => {
                this._pending_rpcs.delete(ack_id);
                reject(new Error(`RPC "${channel}" timed out after ${timeout_ms}ms`));
            }, timeout_ms);
            this._pending_rpcs.set(ack_id, { resolve, reject, timer });
            const env: Envelope = this._mux.mode === "mux"
                ? { k: "msg", ns: this._label, ch: channel, p: payload, ack: ack_id }
                : { k: "msg", ch: channel, p: payload, ack: ack_id };
            this._mux.send_envelope(env);
        });
    }

    on(channel: string, listener: TransportMessageListener): void {
        let set = this._channel_listeners.get(channel);
        if (set === undefined) { set = new Set(); this._channel_listeners.set(channel, set); }
        set.add(listener);
    }

    once(channel: string, listener: TransportMessageListener): void {
        const wrapper: TransportMessageListener = (payload, ack): void => {
            this.off(channel, wrapper);
            listener(payload, ack);
        };
        this.on(channel, wrapper);
    }

    off(channel: string, listener?: TransportMessageListener): void {
        if (listener === undefined) { this._channel_listeners.delete(channel); return; }
        this._channel_listeners.get(channel)?.delete(listener);
    }

    on_lifecycle(event: TransportLifecycleEvent, listener: (...args: any[]) => void): void {
        let set = this._lifecycle.get(event);
        if (set === undefined) { set = new Set(); this._lifecycle.set(event, set); }
        set.add(listener);
    }

    off_lifecycle(event: TransportLifecycleEvent, listener: (...args: any[]) => void): void {
        this._lifecycle.get(event)?.delete(listener);
    }

    get_buffered_amount(): number | null {
        return this._mux.get_buffered_amount();
    }

    close(): void {
        if (this._connected === false) return;
        this._mux.close_namespace(this._label);
    }

    /** @internal */
    _fire_connect(): void {
        const set = this._lifecycle.get("connect");
        if (set === undefined) return;
        for (const l of set) { try { l(); } catch { /* swallow */ } }
    }

    /** @internal */
    _dispatch_incoming(env: Envelope & { k: "msg" }): void {
        const listeners = this._channel_listeners.get(env.ch);
        if (listeners === undefined || listeners.size === 0) return;
        const ack_id: number | undefined = typeof env.ack === "number" ? env.ack : undefined;
        const ack_cb: TransportAckCallback | undefined = ack_id !== undefined
            ? (response: unknown): void => {
                  // D5: tag ack with `ns` so the peer's ConnectionMux can route by transport.
                  const reply_env: Envelope = this._mux.mode === "mux"
                      ? { k: "ack", ns: this._label, ack: ack_id, r: response }
                      : { k: "ack", ack: ack_id, r: response };
                  this._mux.send_envelope(reply_env);
              }
            : undefined;
        for (const l of listeners) {
            try { l(env.p, ack_cb); }
            catch { /* isolated; see server-side comment */ }
        }
    }

    /** @internal */
    _dispatch_ack(env: Envelope & { k: "ack" }): void {
        const p = this._pending_rpcs.get(env.ack);
        if (p === undefined) return;
        clearTimeout(p.timer);
        this._pending_rpcs.delete(env.ack);
        p.resolve(env.r);
    }

    /** @internal */
    _on_remote_close(): void {
        if (this._connected === false) return;
        this._connected = false;
        for (const [, p] of this._pending_rpcs) {
            clearTimeout(p.timer);
            p.reject(new Error("transport closed"));
        }
        this._pending_rpcs.clear();
        const set = this._lifecycle.get("disconnect");
        if (set !== undefined) for (const l of set) { try { l(); } catch { /* swallow */ } }
    }
}

/* ============================================================================
 * RawTcpClient — top-level AbsTransportClient.
 *
 * In `mux` mode, multiple `open(label)` calls share one underlying socket; in
 * `single-namespace` mode, each `open(label)` opens its own socket.
 * ========================================================================== */

export class RawTcpClient extends AbsTransportClient {
    private readonly _target: RawTcpConnectTarget;
    private readonly _opts: RawTcpClientOptions;
    private readonly _mode: "single-namespace" | "mux";
    private readonly _logger: Logger;
    /** mux mode: one shared mux. single mode: per-label mux. */
    private _shared_mux: ClientMux | null = null;
    private readonly _per_label_mux: Map<string, ClientMux> = new Map();
    private readonly _transports: Map<string, RawTcpClientTransport> = new Map();
    private _closed = false;

    constructor(target: RawTcpConnectTarget, opts: RawTcpClientOptions = {}) {
        super();
        this._target = target;
        this._opts = opts;
        this._mode = opts.mode ?? "mux";
        this._logger = opts.logger ?? default_logger;
        if (_is_path_target(target) && opts.tls !== undefined) {
            this._logger.warn(
                "raw-tcp client: `tls` option is ignored for UDS / Named Pipe targets"
            );
        }
    }

    open(label: string): AbsTransport {
        if (this._closed === true) throw new Error("raw-tcp client closed");
        const existing = this._transports.get(label);
        if (existing !== undefined) return existing;

        let mux: ClientMux;
        if (this._mode === "mux") {
            if (this._shared_mux === null) this._shared_mux = this._make_mux();
            mux = this._shared_mux;
        } else {
            mux = this._make_mux();
            this._per_label_mux.set(label, mux);
        }
        const transport: RawTcpClientTransport = new RawTcpClientTransport(label, mux);
        this._transports.set(label, transport);
        // M7: prune the Map when this individual transport dies so long-running clients that
        // open/close many labels don't accumulate dead entries.
        transport.on_lifecycle("disconnect", (): void => {
            if (this._transports.get(label) === transport) this._transports.delete(label);
        });
        mux.register_transport(label, transport);
        return transport;
    }

    private _make_mux(): ClientMux {
        const socket: Socket | TLSSocket = this._connect_socket();
        const ka = this._opts.keep_alive ?? true;
        if (ka !== false) {
            const delay: number = typeof ka === "object" ? ka.initial_delay_ms : 30_000;
            try { socket.setKeepAlive(true, delay); } catch { /* not applicable for UDS */ }
        }
        return new ClientMux(socket, this._mode, this._logger, this._opts.auth);
    }

    private _connect_socket(): Socket | TLSSocket {
        if (_is_path_target(this._target)) {
            return netConnect({ path: this._target.path });
        }
        if (this._opts.tls !== undefined) {
            return tlsConnect({
                host: this._target.host,
                port: this._target.port,
                ...this._opts.tls
            });
        }
        return netConnect({ host: this._target.host, port: this._target.port });
    }

    close(): void {
        if (this._closed === true) return;
        this._closed = true;
        if (this._shared_mux !== null) {
            this._shared_mux.close();
            this._shared_mux = null;
        }
        for (const mux of this._per_label_mux.values()) mux.close();
        this._per_label_mux.clear();
        this._transports.clear();
    }
}
