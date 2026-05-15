import { Manager, Socket } from "socket.io-client";

import {
    AbsTransport,
    AbsTransportClient,
    TransportLifecycleEvent,
    TransportMessageListener
} from "../types/remote-serialport-types/src/transport";
import { Logger } from "../types/remote-serialport-types/src/logger";
import { default_logger } from "./logger";

/** Default timeout (ms) for RPCs that wait on a socket.io ack. */
export const RPC_TIMEOUT_MS = 5000;

/**
 * Construction options for {@link SocketIoClientTransport}.
 *
 * Kept exported as `RpcDispatcherOptions` historically — `send_rpc` lives on the transport now,
 * so this configures the transport's RPC behavior directly.
 */
export interface SocketIoClientTransportOptions {
    /** Default RPC timeout in ms. Wall-clock from the original call; not reset on reconnect. */
    timeout_ms?: number;
    /**
     * When `true` (default): pending RPCs survive disconnects and are re-emitted on `'connect'`
     * with the same ack callback. When `false`: pending RPCs are rejected immediately on
     * `'disconnect'`.
     */
    replay_on_reconnect?: boolean;
    logger?: Logger;
    /**
     * Credential placed in socket.io's `Manager({auth: ...})` field. socket.io automatically
     * re-sends it on every reconnect so the server can re-run its `auth_validator`.
     */
    auth?: unknown;
}

/** Historical name retained for the public option surface on `RemoteSerialportClient`. */
export type RpcDispatcherOptions = SocketIoClientTransportOptions;

interface PendingRpc {
    channel: string;
    payload: unknown;
    ack: (response: unknown) => void;
    deadline_timer: ReturnType<typeof setTimeout>;
    reject: (error: Error) => void;
}

/**
 * Adapts a socket.io-client {@link Socket} (one multiplexed namespace) to {@link AbsTransport}.
 *
 * Owns the per-socket pending RPC map and replays in-flight RPCs on reconnect (option B in the
 * v2 design). The same ack callback is reused on replay so the originating Promise still resolves
 * when the server eventually responds.
 */
export class SocketIoClientTransport extends AbsTransport {
    private readonly _socket: Socket;
    private readonly _label: string;
    private readonly _pending_rpcs: Map<number, PendingRpc> = new Map();
    private _next_rpc_id = 0;
    private readonly _default_timeout_ms: number;
    private readonly _replay_on_reconnect: boolean;
    private readonly _logger: Logger;
    private _destroyed = false;

    constructor(socket: Socket, label: string, options: SocketIoClientTransportOptions = {}) {
        super();
        this._socket = socket;
        this._label = label;
        this._default_timeout_ms = options.timeout_ms ?? RPC_TIMEOUT_MS;
        this._replay_on_reconnect = options.replay_on_reconnect ?? true;
        this._logger = options.logger ?? default_logger;

        this._socket.on("connect", (): void => {
            if (this._replay_on_reconnect === true && this._pending_rpcs.size > 0) {
                this._logger.debug(`replaying ${this._pending_rpcs.size} in-flight RPC(s) after (re)connect on "${this._label}"`);
                for (const entry of this._pending_rpcs.values()) {
                    this._socket.emit(entry.channel, entry.payload, entry.ack);
                }
            }
        });

        this._socket.on("disconnect", (): void => {
            if (this._replay_on_reconnect === false) {
                this._reject_all(new Error("socket disconnected (rpc replay disabled)"));
            }
        });
    }

    /** Underlying socket.io-client socket. Exposed for advanced use; prefer AbsTransport methods. */
    get raw_socket(): Socket {
        return this._socket;
    }

    get id(): string {
        return this._socket.id ?? "";
    }

    get is_connected(): boolean {
        return this._socket.connected;
    }

    get endpoint_label(): string {
        return this._label;
    }

    get credential(): unknown {
        // Client side has no inbound credential to expose.
        return undefined;
    }

    send(channel: string, payload?: unknown): void {
        if (arguments.length < 2) {
            this._socket.emit(channel);
        } else {
            this._socket.emit(channel, payload);
        }
    }

    send_rpc(channel: string, payload: unknown, timeout_ms: number = this._default_timeout_ms): Promise<unknown> {
        if (this._destroyed === true) {
            return Promise.reject(new Error(`RPC "${channel}" rejected: transport destroyed`));
        }
        const id: number = ++this._next_rpc_id;
        return new Promise<unknown>((resolve, reject): void => {
            const deadline_timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
                if (this._pending_rpcs.delete(id) === true) {
                    reject(new Error(`RPC "${channel}" timed out after ${timeout_ms}ms`));
                }
            }, timeout_ms);
            const ack = (response: unknown): void => {
                if (this._pending_rpcs.delete(id) === false) {
                    return;
                }
                clearTimeout(deadline_timer);
                resolve(response);
            };
            this._pending_rpcs.set(id, { channel: channel, payload: payload, ack: ack, deadline_timer: deadline_timer, reject: reject });
            // socket.io-client buffers when disconnected; replay-on-connect catches drops.
            this._socket.emit(channel, payload, ack);
        });
    }

    on(channel: string, listener: TransportMessageListener): void {
        this._socket.on(channel, listener as (...args: any[]) => void);
    }

    once(channel: string, listener: TransportMessageListener): void {
        this._socket.once(channel, listener as (...args: any[]) => void);
    }

    off(channel: string, listener?: TransportMessageListener): void {
        if (listener === undefined) {
            this._socket.removeAllListeners(channel);
        } else {
            this._socket.off(channel, listener as (...args: any[]) => void);
        }
    }

    on_lifecycle(event: TransportLifecycleEvent, listener: (...args: any[]) => void): void {
        if (event === "reconnect") {
            // socket.io-client fires "connect" on both initial connect and reconnect; surface
            // "reconnect" as a no-op since callers can just listen on "connect".
            return;
        }
        this._socket.on(event, listener);
    }

    off_lifecycle(event: TransportLifecycleEvent, listener: (...args: any[]) => void): void {
        if (event === "reconnect") {
            return;
        }
        this._socket.off(event, listener);
    }

    /**
     * Client-side socket.io doesn't expose a useful wire buffer indicator; return `null` so wire
     * backpressure paths know to skip sampling.
     */
    get_buffered_amount(): number | null {
        return null;
    }

    close(): void {
        if (this._destroyed === true) {
            return;
        }
        this._destroyed = true;
        this._reject_all(new Error("transport closed"));
        this._socket.removeAllListeners();
        this._socket.disconnect();
    }

    private _reject_all(error: Error): void {
        for (const entry of this._pending_rpcs.values()) {
            clearTimeout(entry.deadline_timer);
            entry.reject(error);
        }
        this._pending_rpcs.clear();
    }
}

/**
 * Adapts a socket.io-client {@link Manager} to {@link AbsTransportClient}.
 *
 * Each {@link open} call returns a per-label {@link SocketIoClientTransport} (one socket.io
 * namespace), all multiplexed over the same underlying transport connection.
 */
export class SocketIoClient extends AbsTransportClient {
    public readonly manager: Manager;
    private readonly _transports: Map<string, SocketIoClientTransport> = new Map();
    private readonly _transport_options: SocketIoClientTransportOptions;

    constructor(server_host: string, transport_options: SocketIoClientTransportOptions = {}) {
        super();
        this.manager = new Manager(server_host);
        this._transport_options = transport_options;
    }

    open(label: string): AbsTransport {
        const existing: SocketIoClientTransport | undefined = this._transports.get(label);
        if (existing !== undefined) {
            return existing;
        }
        // `auth` is forwarded per-namespace via socket.io's `Socket` options. socket.io re-sends it
        // on reconnect automatically, so the server can re-run `auth_validator` after every drop.
        const socket: Socket = this._transport_options.auth !== undefined
            ? this.manager.socket(label, { auth: this._transport_options.auth as { [k: string]: unknown } })
            : this.manager.socket(label);
        const transport: SocketIoClientTransport = new SocketIoClientTransport(socket, label, this._transport_options);
        this._transports.set(label, transport);
        return transport;
    }

    /** Drop one transport (close + forget). Used by `RemoteSerialportClient.disconnect(namespace)`. */
    drop(label: string): void {
        const transport: SocketIoClientTransport | undefined = this._transports.get(label);
        if (transport === undefined) {
            return;
        }
        transport.close();
        this._transports.delete(label);
    }

    close(): void {
        for (const transport of this._transports.values()) {
            transport.close();
        }
        this._transports.clear();
    }
}
