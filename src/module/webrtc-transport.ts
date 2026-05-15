import { randomUUID } from "crypto";
import { PeerConnection, DataChannel } from "node-datachannel";

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

export interface WebRtcSignalingMessage {
    kind: "offer" | "answer" | "candidate";
    peer_id: string;
    sdp?: string;
    sdp_type?: "offer" | "answer";
    candidate?: string;
    mid?: string;
}

export interface WebRtcSignalingChannel {
    on_message(handler: (msg: WebRtcSignalingMessage) => void): void;
    send(msg: WebRtcSignalingMessage): void;
}

export interface WebRtcClientOptions {
    signaling: WebRtcSignalingChannel;
    /** ICE servers as strings (e.g. `"stun:stun.l.google.com:19302"`). */
    ice_servers?: string[];
    /** Stable id for this peer. Default random UUID. Travels in every signaling message. */
    peer_id?: string;
    logger?: Logger;
}

class WebRtcClientTransport extends AbsTransport {
    private readonly _id: string;
    private readonly _label: string;
    private readonly _dc: DataChannel;
    private readonly _decoder: FrameDecoder;
    private readonly _logger: Logger;
    private _connected = true;
    private readonly _channel_listeners: Map<string, Set<TransportMessageListener>> = new Map();
    private readonly _lifecycle: Map<TransportLifecycleEvent, Set<(...a: any[]) => void>> = new Map();
    private readonly _pending_rpcs: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
    private _next_ack = 1;
    private _open = false;
    private readonly _pending_envelopes: Envelope[] = [];

    constructor(label: string, dc: DataChannel, logger: Logger) {
        super();
        this._id = randomUUID();
        this._label = label;
        this._dc = dc;
        this._logger = logger;
        this._decoder = new FrameDecoder(
            (env) => this._on_envelope(env),
            (err) => { this._logger.warn(`webrtc client dc ${this._label}: ${err.message}; closing`); this.close(); }
        );
        dc.onOpen(() => {
            this._open = true;
            for (const env of this._pending_envelopes) this._raw_send(env);
            this._pending_envelopes.length = 0;
            this._fire_lifecycle("connect");
        });
        dc.onMessage((data: string | Buffer | ArrayBuffer) => {
            let buf: Buffer;
            if (typeof data === "string") buf = Buffer.from(data, "utf8");
            else if (Buffer.isBuffer(data)) buf = data;
            else buf = Buffer.from(data as ArrayBuffer);
            this._decoder.push(buf);
        });
        dc.onClosed(() => this._on_remote_close());
        dc.onError((err: string) => this._logger.debug(`webrtc client dc ${this._label} err: ${err}`));
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
        if (this._open === false) { this._pending_envelopes.push(env); return; }
        this._raw_send(env);
    }

    private _raw_send(env: Envelope): void {
        try {
            const frame: Buffer = encode(env);
            this._dc.sendMessageBinary(frame);
        } catch (e) {
            this._logger.warn(`webrtc client send failed: ${(e as Error).message}`);
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

    get_buffered_amount(): number | null { try { return this._dc.bufferedAmount(); } catch { return null; } }

    close(): void {
        if (this._connected === false) return;
        try { this._dc.close(); } catch {}
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

export class WebRtcClient extends AbsTransportClient {
    private readonly _opts: WebRtcClientOptions;
    private readonly _logger: Logger;
    private readonly _peer_id: string;
    private readonly _ice_servers: string[];
    private _peer: PeerConnection | null = null;
    private readonly _transports: Map<string, WebRtcClientTransport> = new Map();
    private _closed = false;

    constructor(opts: WebRtcClientOptions) {
        super();
        this._opts = opts;
        this._logger = opts.logger ?? default_logger;
        this._peer_id = opts.peer_id ?? randomUUID();
        this._ice_servers = opts.ice_servers ?? ["stun:stun.l.google.com:19302"];
    }

    private _ensure_peer(): PeerConnection {
        if (this._peer !== null) return this._peer;
        this._peer = new PeerConnection(this._peer_id, { iceServers: this._ice_servers });
        this._peer.onLocalDescription((sdp: string, sdp_type: string) => {
            this._opts.signaling.send({ kind: sdp_type as "offer" | "answer", peer_id: this._peer_id, sdp, sdp_type: sdp_type as any });
        });
        this._peer.onLocalCandidate((candidate: string, mid: string) => {
            this._opts.signaling.send({ kind: "candidate", peer_id: this._peer_id, candidate, mid });
        });
        this._opts.signaling.on_message((msg) => {
            if (msg.peer_id !== this._peer_id) return;
            if (msg.kind === "answer") {
                try { this._peer!.setRemoteDescription(msg.sdp!, "answer"); } catch (e) { this._logger.debug(`setRemoteDescription: ${(e as Error).message}`); }
            } else if (msg.kind === "candidate") {
                try { this._peer!.addRemoteCandidate(msg.candidate ?? "", msg.mid ?? ""); } catch (e) { this._logger.debug(`addRemoteCandidate: ${(e as Error).message}`); }
            }
        });
        return this._peer;
    }

    open(label: string): AbsTransport {
        if (this._closed) throw new Error("webrtc client closed");
        const existing = this._transports.get(label);
        if (existing !== undefined) return existing;
        const peer = this._ensure_peer();
        const dc: DataChannel = peer.createDataChannel(label);
        const transport = new WebRtcClientTransport(label, dc, this._logger);
        this._transports.set(label, transport);
        return transport;
    }

    close(): void {
        if (this._closed) return;
        this._closed = true;
        for (const t of this._transports.values()) { try { t.close(); } catch {} }
        this._transports.clear();
        if (this._peer !== null) { try { this._peer.close(); } catch {} this._peer = null; }
    }
}
