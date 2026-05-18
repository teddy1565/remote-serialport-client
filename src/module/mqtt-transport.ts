import { randomUUID } from "crypto";
import { connect as mqttConnect, MqttClient, IClientOptions } from "mqtt";

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
 * MQTT broker-pattern client. Mirror of {@link MqttServer}. Connects to the same broker as the
 * server, publishes c2s envelopes, subscribes to s2c. Each `open(label)` becomes a transport
 * carried on its own topic pair.
 */

export interface MqttClientOptions {
    broker_url: string;
    topic_prefix?: string;
    /** Stable client id (also used in the topic path). Default: random UUID. */
    client_id?: string;
    qos?: 0 | 1 | 2;
    /** Forwarded to `mqtt.connect`. */
    mqtt_options?: IClientOptions;
    auth?: unknown;
    logger?: Logger;
}

class MqttClientTransport extends AbsTransport {
    private readonly _id: string;
    private readonly _label: string;
    private readonly _client_id: string;
    private readonly _publish: (frame: Buffer) => void;
    private _connected = true;
    private readonly _channel_listeners: Map<string, Set<TransportMessageListener>> = new Map();
    private readonly _lifecycle: Map<TransportLifecycleEvent, Set<(...a: any[]) => void>> = new Map();
    private readonly _pending_rpcs: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
    private _next_ack = 1;

    constructor(label: string, client_id: string, publish: (frame: Buffer) => void) {
        super();
        this._id = randomUUID();
        this._label = label;
        this._client_id = client_id;
        this._publish = publish;
    }

    get id(): string { return this._id; }
    get is_connected(): boolean { return this._connected; }
    get endpoint_label(): string { return this._label; }
    get credential(): unknown { return undefined; }
    get client_id(): string { return this._client_id; }

    send(channel: string, payload?: unknown): void {
        if (this._connected === false) return;
        this._publish(encode({ k: "msg", ch: channel, p: payload }));
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
            this._publish(encode({ k: "msg", ch: channel, p: payload, ack: ack_id }));
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
        this._publish(encode({ k: "bye" }));
        this._on_remote_close();
    }

    /** @internal */
    _fire_connect(): void { this._fire_lifecycle("connect"); }

    /** @internal */
    _dispatch_envelope(env: Envelope): void {
        if (env.k === "msg") {
            const listeners = this._channel_listeners.get(env.ch);
            if (listeners === undefined || listeners.size === 0) return;
            const ack_id: number | undefined = typeof env.ack === "number" ? env.ack : undefined;
            const ack_cb: TransportAckCallback | undefined = ack_id !== undefined
                ? (r) => this._publish(encode({ k: "ack", ack: ack_id, r }))
                : undefined;
            for (const l of listeners) { try { l(env.p, ack_cb); } catch { /* isolated */ } }
            return;
        }
        if (env.k === "ack") {
            const p = this._pending_rpcs.get(env.ack);
            if (p === undefined) return;
            clearTimeout(p.timer);
            this._pending_rpcs.delete(env.ack);
            p.resolve(env.r);
            return;
        }
        if (env.k === "bye") { this._on_remote_close(); return; }
    }

    /** @internal */
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

export class MqttClient_ extends AbsTransportClient {
    private readonly _opts: MqttClientOptions;
    private readonly _prefix: string;
    private readonly _qos: 0 | 1 | 2;
    private readonly _client_id: string;
    private readonly _auth: unknown;
    private readonly _logger: Logger;
    private _client: MqttClient | null = null;
    private _mqtt_ready = false;
    private readonly _transports: Map<string, MqttClientTransport> = new Map();
    private readonly _pending_publishes: Array<{ topic: string; frame: Buffer }> = [];
    private _closed = false;

    constructor(opts: MqttClientOptions) {
        super();
        this._opts = opts;
        this._prefix = opts.topic_prefix ?? "rsp";
        this._qos = opts.qos ?? 1;
        this._client_id = opts.client_id ?? randomUUID();
        this._auth = opts.auth;
        this._logger = opts.logger ?? default_logger;
    }

    private _ensure_client(): MqttClient {
        if (this._client !== null) return this._client;
        this._client = mqttConnect(this._opts.broker_url, {
            clientId: `rsp-client-${this._client_id}`,
            clean: true,
            ...this._opts.mqtt_options
        });
        this._client.on("connect", () => {
            this._mqtt_ready = true;
            const wildcard = `${this._prefix}/s2c/${this._client_id}/#`;
            this._client!.subscribe(wildcard, { qos: this._qos }, (err) => {
                if (err !== null && err !== undefined) {
                    this._logger.error(`mqtt subscribe failed: ${err.message}`);
                    return;
                }
                // Subscription confirmed: flush queued publishes (including hellos).
                for (const { topic, frame } of this._pending_publishes) {
                    this._client!.publish(topic, frame, { qos: this._qos });
                }
                this._pending_publishes.length = 0;
                for (const t of this._transports.values()) t._fire_connect();
            });
        });
        this._client.on("message", (topic, payload) => this._on_message(topic, payload));
        this._client.on("error", (err) => this._logger.warn(`mqtt client error: ${err.message}`));
        return this._client;
    }

    private _on_message(topic: string, payload: Buffer): void {
        // <prefix>/s2c/<client_id>/<label>
        const parts = topic.split("/");
        if (parts.length < 4 || parts[0] !== this._prefix || parts[1] !== "s2c") return;
        const label: string = parts.slice(3).join("/");
        const transport = this._transports.get(label);
        if (transport === undefined) return;
        const decoder = new FrameDecoder(
            (env) => transport._dispatch_envelope(env),
            (err) => this._logger.warn(`mqtt client decode: ${err.message}`)
        );
        decoder.push(payload);
    }

    open(label: string): AbsTransport {
        if (this._closed) throw new Error("mqtt client closed");
        const existing = this._transports.get(label);
        if (existing !== undefined) return existing;
        this._ensure_client();
        const c2s_topic = `${this._prefix}/c2s/${this._client_id}/${label}`;
        const publish = (frame: Buffer): void => {
            if (this._client === null) return;
            if (this._mqtt_ready === false) {
                this._pending_publishes.push({ topic: c2s_topic, frame });
                return;
            }
            this._client.publish(c2s_topic, frame, { qos: this._qos });
        };
        const transport = new MqttClientTransport(label, this._client_id, publish);
        this._transports.set(label, transport);
        // M7: prune on per-transport disconnect (e.g. server publishes bye, or app calls
        // transport.close() explicitly).
        transport.on_lifecycle("disconnect", (): void => {
            if (this._transports.get(label) === transport) this._transports.delete(label);
        });
        // Send hello envelope to register at server.
        publish(encode({ k: "hello", label, auth: this._auth }));
        // D10 + F13: if the broker is already connected + SUBACK'd, the bulk fire_connect at
        // `_mqtt_ready=true` has already run for the existing transports — late-arriving
        // open(label)s would never see their `connect` lifecycle fire. Schedule via setImmediate
        // (not process.nextTick) so users attaching listeners via Promise.then / await also
        // catch the event.
        if (this._mqtt_ready === true) {
            setImmediate((): void => { try { transport._fire_connect(); } catch { /* swallow */ } });
        }
        return transport;
    }

    close(): void {
        if (this._closed) return;
        this._closed = true;
        // Each child's close() publishes a `bye` envelope before flipping itself local-closed.
        // Without that the server keeps the per-(client_id, label) transport (and any shared
        // session it owns) registered — pipe-mode writer-promotion would never re-fire.
        for (const t of this._transports.values()) { try { t.close(); } catch {} }
        this._transports.clear();
        if (this._client !== null) {
            const client = this._client;
            this._client = null;
            // Graceful end (force=false) so the queued bye publishes drain.
            // Fallback force-end after 1 s in case the broker is unresponsive — app shutdown
            // must never block on a stuck mqtt session.
            let done = false;
            const finalize = (): void => { if (done) return; done = true; try { client.end(true); } catch {} };
            try { client.end(false, {}, finalize); } catch { finalize(); }
            const t = setTimeout(finalize, 1000);
            if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
        }
    }
}

// Avoid name clash with the `mqtt` library's MqttClient class — export under MqttRsClient too.
export { MqttClient_ as MqttRsClient };
