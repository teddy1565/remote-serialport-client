import { randomUUID } from "crypto";
import { WebSocket, ClientOptions as WsClientOptions } from "ws";

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
 * Where to connect. The `url` is a full `ws://` or `wss://` URL; the library doesn't compose it
 * from host/port to keep the surface aligned with the `ws` library and with browser semantics.
 */
export interface RawWebSocketConnectTarget {
    url: string;
}

export interface RawWebSocketClientOptions {
    mode?: "single-namespace" | "mux";
    /** TLS options. Pass `{ rejectUnauthorized: false }` for self-signed dev; in production
     *  pass `{ ca }`. Forwarded directly to the `ws` client constructor's options object — see
     *  https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketaddress-protocols-options
     *  for the full list. Only effective when `url` is `wss://`. */
    tls?: WsClientOptions;
    auth?: unknown;
    logger?: Logger;
}

class WsClientMux {
    private readonly _ws: WebSocket;
    private readonly _decoder: FrameDecoder;
    private readonly _mode: "single-namespace" | "mux";
    private readonly _logger: Logger;
    private readonly _auth: unknown;
    private readonly _transports: Map<string, RawWebSocketClientTransport> = new Map();
    private _alive = true;
    private _socket_ready = false;
    private readonly _pending_envelopes: Envelope[] = [];

    constructor(url: string, mode: "single-namespace" | "mux", logger: Logger, auth: unknown, tls?: WsClientOptions) {
        this._mode = mode;
        this._logger = logger;
        this._auth = auth;
        this._ws = new WebSocket(url, tls);
        this._decoder = new FrameDecoder(
            (env) => this._on_envelope(env),
            (err) => {
                this._logger.warn(`raw-ws client: ${err.message}; closing`);
                this.close();
            }
        );
        this._ws.on("open", () => {
            this._socket_ready = true;
            for (const env of this._pending_envelopes) this._raw_send(env);
            this._pending_envelopes.length = 0;
            for (const t of this._transports.values()) t._fire_connect();
        });
        this._ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
            const buf: Buffer = Buffer.isBuffer(data)
                ? data
                : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
            this._decoder.push(buf);
        });
        this._ws.on("close", () => this._on_close());
        this._ws.on("error", (err) => this._logger.debug(`raw-ws client socket error: ${err.message}`));
    }

    register_transport(label: string, t: RawWebSocketClientTransport): void {
        this._transports.set(label, t);
        const hello: Envelope = this._mode === "mux"
            ? { k: "hello", label, ns: label, auth: this._auth }
            : { k: "hello", label, auth: this._auth };
        this.send_envelope(hello);
    }

    send_envelope(env: Envelope): void {
        if (this._alive === false) return;
        if (this._socket_ready === false) { this._pending_envelopes.push(env); return; }
        this._raw_send(env);
    }

    private _raw_send(env: Envelope): void {
        try {
            const frame: Buffer = encode(env);
            this._ws.send(frame, { binary: true });
        } catch (e) {
            this._logger.warn(`raw-ws client send failed: ${(e as Error).message}`);
        }
    }

    private _on_envelope(env: Envelope): void {
        if (env === null || typeof env !== "object" || typeof (env as any).k !== "string") return;
        switch (env.k) {
            case "msg": {
                const ns: string | null = this._mode === "mux"
                    ? (typeof env.ns === "string" ? env.ns : null)
                    : (this._transports.size === 1 ? this._transports.keys().next().value as string : null);
                if (ns === null) return;
                this._transports.get(ns)?._dispatch_incoming(env);
                return;
            }
            case "ack": {
                for (const t of this._transports.values()) t._dispatch_ack(env);
                return;
            }
            case "bye": {
                if (this._mode === "single-namespace") { this.close(); return; }
                if (typeof env.ns === "string") {
                    this._transports.get(env.ns)?._on_remote_close();
                    this._transports.delete(env.ns);
                }
                return;
            }
            case "hello":
                return;
        }
    }

    get_buffered_amount(): number { return this._ws.bufferedAmount; }
    get mode(): "single-namespace" | "mux" { return this._mode; }

    close_namespace(label: string): void {
        if (this._mode === "mux") {
            this.send_envelope({ k: "bye", ns: label });
            this._transports.get(label)?._on_remote_close();
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
        try { this._ws.close(); } catch {}
        try { this._ws.terminate(); } catch {}
    }
}

class RawWebSocketClientTransport extends AbsTransport {
    private readonly _id: string;
    private readonly _label: string;
    private readonly _mux: WsClientMux;
    private _connected = true;
    private readonly _channel_listeners: Map<string, Set<TransportMessageListener>> = new Map();
    private readonly _lifecycle: Map<TransportLifecycleEvent, Set<(...a: any[]) => void>> = new Map();
    private readonly _pending_rpcs: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
    private _next_ack = 1;

    constructor(label: string, mux: WsClientMux) {
        super();
        this._id = randomUUID();
        this._label = label;
        this._mux = mux;
    }

    get id(): string { return this._id; }
    get is_connected(): boolean { return this._connected; }
    get endpoint_label(): string { return this._label; }
    get credential(): unknown { return undefined; }

    send(channel: string, payload?: unknown): void {
        if (this._connected === false) return;
        const env: Envelope = this._mux.mode === "mux"
            ? { k: "msg", ns: this._label, ch: channel, p: payload }
            : { k: "msg", ch: channel, p: payload };
        this._mux.send_envelope(env);
    }

    send_rpc(channel: string, payload: unknown, timeout_ms: number): Promise<unknown> {
        return new Promise<unknown>((resolve, reject) => {
            if (this._connected === false) { reject(new Error("transport closed")); return; }
            const ack_id: number = this._next_ack++;
            const timer = setTimeout(() => {
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
        const w: TransportMessageListener = (p, a) => { this.off(channel, w); listener(p, a); };
        this.on(channel, w);
    }
    off(channel: string, listener?: TransportMessageListener): void {
        if (listener === undefined) { this._channel_listeners.delete(channel); return; }
        this._channel_listeners.get(channel)?.delete(listener);
    }
    on_lifecycle(e: TransportLifecycleEvent, l: (...a: any[]) => void): void {
        let s = this._lifecycle.get(e); if (s === undefined) { s = new Set(); this._lifecycle.set(e, s); } s.add(l);
    }
    off_lifecycle(e: TransportLifecycleEvent, l: (...a: any[]) => void): void { this._lifecycle.get(e)?.delete(l); }

    get_buffered_amount(): number | null { return this._mux.get_buffered_amount(); }

    close(): void { if (this._connected) this._mux.close_namespace(this._label); }

    /** @internal */
    _fire_connect(): void {
        const s = this._lifecycle.get("connect"); if (s === undefined) return;
        for (const l of s) { try { l(); } catch { /* */ } }
    }

    /** @internal */
    _dispatch_incoming(env: Envelope & { k: "msg" }): void {
        const listeners = this._channel_listeners.get(env.ch);
        if (listeners === undefined || listeners.size === 0) return;
        const ack_id: number | undefined = typeof env.ack === "number" ? env.ack : undefined;
        const ack_cb: TransportAckCallback | undefined = ack_id !== undefined
            ? (r) => this._mux.send_envelope({ k: "ack", ack: ack_id, r })
            : undefined;
        for (const l of listeners) { try { l(env.p, ack_cb); } catch { /* isolated */ } }
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
        for (const [, p] of this._pending_rpcs) { clearTimeout(p.timer); p.reject(new Error("transport closed")); }
        this._pending_rpcs.clear();
        const s = this._lifecycle.get("disconnect");
        if (s !== undefined) for (const l of s) { try { l(); } catch { /* */ } }
    }
}

/* ============================================================================
 * RawWebSocketClient — AbsTransportClient.
 * ========================================================================== */

export class RawWebSocketClient extends AbsTransportClient {
    private readonly _target: RawWebSocketConnectTarget;
    private readonly _opts: RawWebSocketClientOptions;
    private readonly _mode: "single-namespace" | "mux";
    private readonly _logger: Logger;
    private _shared_mux: WsClientMux | null = null;
    private readonly _per_label_mux: Map<string, WsClientMux> = new Map();
    private readonly _transports: Map<string, RawWebSocketClientTransport> = new Map();
    private _closed = false;

    constructor(target: RawWebSocketConnectTarget, opts: RawWebSocketClientOptions = {}) {
        super();
        this._target = target;
        this._opts = opts;
        this._mode = opts.mode ?? "mux";
        this._logger = opts.logger ?? default_logger;
    }

    open(label: string): AbsTransport {
        if (this._closed) throw new Error("raw-ws client closed");
        const existing = this._transports.get(label);
        if (existing !== undefined) return existing;

        let mux: WsClientMux;
        if (this._mode === "mux") {
            if (this._shared_mux === null) this._shared_mux = this._make_mux();
            mux = this._shared_mux;
        } else {
            mux = this._make_mux();
            this._per_label_mux.set(label, mux);
        }
        const t = new RawWebSocketClientTransport(label, mux);
        this._transports.set(label, t);
        mux.register_transport(label, t);
        return t;
    }

    private _make_mux(): WsClientMux {
        return new WsClientMux(this._target.url, this._mode, this._logger, this._opts.auth, this._opts.tls as WsClientOptions);
    }

    close(): void {
        if (this._closed) return;
        this._closed = true;
        if (this._shared_mux !== null) { this._shared_mux.close(); this._shared_mux = null; }
        for (const mux of this._per_label_mux.values()) mux.close();
        this._per_label_mux.clear();
        this._transports.clear();
    }
}
