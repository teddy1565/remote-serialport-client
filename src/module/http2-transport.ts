import { randomUUID } from "crypto";
import { connect as http2Connect, ClientHttp2Session, ClientHttp2Stream, SecureClientSessionOptions, ClientSessionOptions } from "http2";

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

export interface Http2ConnectTarget {
    /** Full URL: `https://host:port` for TLS h2, `http://host:port` for h2c. */
    url: string;
}

export interface Http2ClientOptions {
    /** TLS options forwarded to `http2.connect`. Pass `{ rejectUnauthorized: false }` for self-signed
     *  dev; in production pass `{ ca, servername }`. Only effective for `https://` URLs. */
    tls?: SecureClientSessionOptions;
    /** Extra h2 session options (settings, peer max concurrent streams, etc.). */
    h2_options?: ClientSessionOptions;
    /** Credential forwarded in the per-stream `hello` envelope. */
    auth?: unknown;
    logger?: Logger;
}

class Http2ClientStreamTransport extends AbsTransport {
    private readonly _id: string;
    private readonly _label: string;
    private readonly _stream: ClientHttp2Stream;
    private readonly _decoder: FrameDecoder;
    private readonly _logger: Logger;
    private _connected = true;
    private readonly _channel_listeners: Map<string, Set<TransportMessageListener>> = new Map();
    private readonly _lifecycle: Map<TransportLifecycleEvent, Set<(...a: any[]) => void>> = new Map();
    private readonly _pending_rpcs: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
    private _next_ack = 1;
    private _stream_open = false;
    private readonly _pending_envelopes: Envelope[] = [];

    constructor(label: string, stream: ClientHttp2Stream, auth: unknown, logger: Logger) {
        super();
        this._id = randomUUID();
        this._label = label;
        this._stream = stream;
        this._logger = logger;
        this._decoder = new FrameDecoder(
            (env) => this._on_envelope(env),
            (err) => {
                this._logger.warn(`http2 stream ${this._label}: ${err.message}; closing`);
                this.close();
            }
        );
        stream.on("response", () => {
            // server accepted the stream; start flushing any pre-queued envelopes
            this._stream_open = true;
            // hello envelope first
            this._raw_send({ k: "hello", label: this._label, auth });
            for (const env of this._pending_envelopes) this._raw_send(env);
            this._pending_envelopes.length = 0;
            this._fire_lifecycle("connect");
        });
        stream.on("data", (chunk: Buffer) => this._decoder.push(chunk));
        stream.on("close", () => this._on_remote_close());
        stream.on("error", (err) => this._logger.debug(`http2 stream ${this._label} error: ${err.message}`));
    }

    get id(): string { return this._id; }
    get is_connected(): boolean { return this._connected; }
    get endpoint_label(): string { return this._label; }
    get credential(): unknown { return undefined; }

    private _on_envelope(env: Envelope): void {
        if (env === null || typeof env !== "object" || typeof (env as any).k !== "string") return;
        if (env.k === "msg") { this._dispatch_msg(env); return; }
        if (env.k === "ack") { this._dispatch_ack(env); return; }
        if (env.k === "bye") { this._on_remote_close(); return; }
    }

    private _dispatch_msg(env: Envelope & { k: "msg" }): void {
        const listeners = this._channel_listeners.get(env.ch);
        if (listeners === undefined || listeners.size === 0) return;
        const ack_id: number | undefined = typeof env.ack === "number" ? env.ack : undefined;
        const ack_cb: TransportAckCallback | undefined = ack_id !== undefined
            ? (r) => this._send_envelope({ k: "ack", ack: ack_id, r })
            : undefined;
        for (const l of listeners) { try { l(env.p, ack_cb); } catch { /* isolated */ } }
    }

    private _dispatch_ack(env: Envelope & { k: "ack" }): void {
        const p = this._pending_rpcs.get(env.ack);
        if (p === undefined) return;
        clearTimeout(p.timer);
        this._pending_rpcs.delete(env.ack);
        p.resolve(env.r);
    }

    private _send_envelope(env: Envelope): void {
        if (this._connected === false) return;
        if (this._stream_open === false) { this._pending_envelopes.push(env); return; }
        this._raw_send(env);
    }

    private _raw_send(env: Envelope): void {
        try {
            const frame: Buffer = encode(env);
            this._stream.write(frame);
        } catch (e) {
            this._logger.warn(`http2 client send failed: ${(e as Error).message}`);
        }
    }

    send(channel: string, payload?: unknown): void {
        this._send_envelope({ k: "msg", ch: channel, p: payload });
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
            this._send_envelope({ k: "msg", ch: channel, p: payload, ack: ack_id });
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

    get_buffered_amount(): number | null { return this._stream.writableLength ?? 0; }

    close(): void {
        if (this._connected === false) return;
        try { this._stream.end(); } catch {}
        try { this._stream.close(); } catch {}
        this._on_remote_close();
    }

    _on_remote_close(): void {
        if (this._connected === false) return;
        this._connected = false;
        for (const [, p] of this._pending_rpcs) { clearTimeout(p.timer); p.reject(new Error("transport closed")); }
        this._pending_rpcs.clear();
        this._fire_lifecycle("disconnect");
    }

    private _fire_lifecycle(event: TransportLifecycleEvent, ...args: any[]): void {
        const set = this._lifecycle.get(event);
        if (set === undefined) return;
        for (const l of set) { try { l(...args); } catch { /* */ } }
    }
}

/**
 * `Http2Client` opens ONE HTTP/2 session per instance and multiplexes namespaces over it as
 * concurrent streams. Each `open(label)` opens a new stream with `:path: label`.
 */
export class Http2Client extends AbsTransportClient {
    private readonly _target: Http2ConnectTarget;
    private readonly _opts: Http2ClientOptions;
    private readonly _logger: Logger;
    private _session: ClientHttp2Session | null = null;
    private readonly _transports: Map<string, Http2ClientStreamTransport> = new Map();
    private _closed = false;

    constructor(target: Http2ConnectTarget, opts: Http2ClientOptions = {}) {
        super();
        this._target = target;
        this._opts = opts;
        this._logger = opts.logger ?? default_logger;
    }

    private _ensure_session(): ClientHttp2Session {
        if (this._session !== null) return this._session;
        const session_opts: ClientSessionOptions = { ...(this._opts.h2_options ?? {}) };
        if (this._target.url.startsWith("https:")) {
            Object.assign(session_opts, this._opts.tls ?? {});
        }
        this._session = http2Connect(this._target.url, session_opts);
        this._session.on("error", (err) => this._logger.debug(`http2 session error: ${err.message}`));
        return this._session;
    }

    open(label: string): AbsTransport {
        if (this._closed) throw new Error("http2 client closed");
        const existing = this._transports.get(label);
        if (existing !== undefined) return existing;
        const session = this._ensure_session();
        const stream: ClientHttp2Stream = session.request({ ":path": label, ":method": "POST" });
        const transport = new Http2ClientStreamTransport(label, stream, this._opts.auth, this._logger);
        this._transports.set(label, transport);
        return transport;
    }

    close(): void {
        if (this._closed) return;
        this._closed = true;
        for (const t of this._transports.values()) { try { t.close(); } catch {} }
        this._transports.clear();
        if (this._session !== null) {
            try { this._session.close(); } catch {}
            try { this._session.destroy(); } catch {}
            this._session = null;
        }
    }
}
