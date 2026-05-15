import { randomUUID } from "crypto";
import * as path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

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

const PROTO_PATH = path.join(__dirname, "..", "..", "proto", "remote-serialport.proto");

interface ProtoEnvelope { frame: Buffer; }

let _proto_cache: any = null;
function _load_proto(): any {
    if (_proto_cache !== null) return _proto_cache;
    const def = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
    });
    const root = grpc.loadPackageDefinition(def) as any;
    _proto_cache = root.remote_serialport.v2;
    return _proto_cache;
}

export interface GrpcConnectTarget {
    /** TCP address. e.g. `localhost:17996`, `dns:///host:17996`. */
    address: string;
}

export interface GrpcClientOptions {
    /** Channel credentials. Default `grpc.credentials.createInsecure()`. For TLS pass
     *  `grpc.credentials.createSsl(ca, key, cert)` or similar. */
    credentials?: grpc.ChannelCredentials;
    /** Forwarded to client constructor (channel options like `grpc.max_receive_message_length`). */
    channel_options?: grpc.ChannelOptions;
    /** Sent in stream metadata under `rsp-auth` (JSON-encoded). */
    auth?: unknown;
    logger?: Logger;
}

class GrpcClientStreamTransport extends AbsTransport {
    private readonly _id: string;
    private readonly _label: string;
    private readonly _call: grpc.ClientDuplexStream<ProtoEnvelope, ProtoEnvelope>;
    private readonly _decoder: FrameDecoder;
    private readonly _logger: Logger;
    private _connected = true;
    private readonly _channel_listeners: Map<string, Set<TransportMessageListener>> = new Map();
    private readonly _lifecycle: Map<TransportLifecycleEvent, Set<(...a: any[]) => void>> = new Map();
    private readonly _pending_rpcs: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
    private _next_ack = 1;

    constructor(label: string, call: grpc.ClientDuplexStream<ProtoEnvelope, ProtoEnvelope>, logger: Logger) {
        super();
        this._id = randomUUID();
        this._label = label;
        this._call = call;
        this._logger = logger;
        this._decoder = new FrameDecoder(
            (env) => this._on_envelope(env),
            (err) => { this._logger.warn(`grpc client stream ${this._label}: ${err.message}; closing`); this.close(); }
        );
        call.on("data", (msg: ProtoEnvelope) => {
            if (msg !== null && msg !== undefined && Buffer.isBuffer(msg.frame)) {
                this._decoder.push(msg.frame);
            }
        });
        call.on("status", () => { /* status arrives at end-of-call */ });
        call.on("metadata", () => this._fire_lifecycle("connect"));
        call.on("end", () => this._on_remote_close());
        call.on("close", () => this._on_remote_close());
        call.on("error", (err) => this._logger.debug(`grpc client stream ${this._label} err: ${err.message}`));
    }

    get id(): string { return this._id; }
    get is_connected(): boolean { return this._connected; }
    get endpoint_label(): string { return this._label; }
    get credential(): unknown { return undefined; }

    private _on_envelope(env: Envelope): void {
        if (env === null || typeof env !== "object" || typeof (env as any).k !== "string") return;
        if (env.k === "msg") { this._dispatch_msg(env); return; }
        if (env.k === "ack") { this._dispatch_ack(env); return; }
        if (env.k === "bye") { this.close(); return; }
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
        try {
            const frame: Buffer = encode(env);
            this._call.write({ frame });
        } catch (e) {
            this._logger.warn(`grpc client send failed: ${(e as Error).message}`);
        }
    }

    send(channel: string, payload?: unknown): void { this._send_envelope({ k: "msg", ch: channel, p: payload }); }

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
        let s = this._channel_listeners.get(channel);
        if (s === undefined) { s = new Set(); this._channel_listeners.set(channel, s); }
        s.add(listener);
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

    get_buffered_amount(): number | null { return null; }

    close(): void {
        if (this._connected === false) return;
        try { this._call.end(); } catch {}
        try { this._call.cancel(); } catch {}
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

export class GrpcClient extends AbsTransportClient {
    private readonly _target: GrpcConnectTarget;
    private readonly _opts: GrpcClientOptions;
    private readonly _logger: Logger;
    private _grpc_client: any = null;
    private readonly _transports: Map<string, GrpcClientStreamTransport> = new Map();
    private _closed = false;

    constructor(target: GrpcConnectTarget, opts: GrpcClientOptions = {}) {
        super();
        this._target = target;
        this._opts = opts;
        this._logger = opts.logger ?? default_logger;
    }

    private _ensure_client(): any {
        if (this._grpc_client !== null) return this._grpc_client;
        const proto: any = _load_proto();
        const creds = this._opts.credentials ?? grpc.credentials.createInsecure();
        this._grpc_client = new proto.RemoteSerialport(this._target.address, creds, this._opts.channel_options ?? {});
        return this._grpc_client;
    }

    open(label: string): AbsTransport {
        if (this._closed) throw new Error("grpc client closed");
        const existing = this._transports.get(label);
        if (existing !== undefined) return existing;
        const client = this._ensure_client();
        const metadata = new grpc.Metadata();
        metadata.set("rsp-label", label);
        if (this._opts.auth !== undefined) {
            try { metadata.set("rsp-auth", JSON.stringify(this._opts.auth)); } catch { /* skip */ }
        }
        const call: grpc.ClientDuplexStream<ProtoEnvelope, ProtoEnvelope> = client.Channel(metadata);
        const transport = new GrpcClientStreamTransport(label, call, this._logger);
        this._transports.set(label, transport);
        return transport;
    }

    close(): void {
        if (this._closed) return;
        this._closed = true;
        for (const t of this._transports.values()) { try { t.close(); } catch {} }
        this._transports.clear();
        if (this._grpc_client !== null) { try { this._grpc_client.close?.(); } catch {} this._grpc_client = null; }
    }
}
