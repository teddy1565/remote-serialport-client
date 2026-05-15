import { MockBinding } from "@serialport/binding-mock";

import { OpenSerialPortOptions } from "./types/remote-serialport-types/src/serialport";
import {
    AbsRemoteSerialportClient,
    AbsRemoteSerialportClientSocket,
    AbsRemoteSerialportClientMuxSocket
} from "./types/remote-serialport-types/src/remote-serial-client.model";
import { AbsTransport, AbsTransportClient } from "./types/remote-serialport-types/src/transport";
import { Logger } from "./types/remote-serialport-types/src/logger";
import { RemoteSerialClientSocket, RemoteSerialClientMuxSocket, RpcDispatcherOptions, TxnIdAllocatorSpec } from "./module/remote-serialport-client";
import { SocketIoClient } from "./module/socketio-transport";
import { default_logger } from "./module/logger";

/** Default regexp for validating namespaces (and, in strict mode on the server, remote serial paths). */
export const DEFAULT_SERIALPORT_CHECK_REGEXP: RegExp = /^(\/dev\/tty(USB|AMA|ACM)|\/COM)[0-9]+$/;

/** Default mux namespace. */
export const DEFAULT_MUX_NAMESPACE = "/";

/**
 * Construction options for {@link RemoteSerialportClient}.
 */
export interface RemoteSerialportClientOptions {
    /** Regexp used to validate namespaces passed to {@link RemoteSerialportClient.connect}. */
    serialport_check_regexp?: RegExp | string;
    /** Logger sink. Default: `warn` / `error` → `console`, `debug` / `info` discarded. */
    logger?: Logger;
    /**
     * RPC behavior (timeout + replay-on-reconnect) for `get_remote_status` / `list_ports` and any
     * other socket.io-ack-based RPCs. Defaults: `timeout_ms: 5000`, `replay_on_reconnect: true`.
     */
    rpc?: RpcDispatcherOptions;
    /**
     * Strategy for allocating multi-chunk `txn_id`s. Default: `'counter'` (per-socket monotonic).
     */
    txn_id_allocator?: TxnIdAllocatorSpec;
    /**
     * Inject a custom transport client (e.g. {@link NodeIpcClient}). If unset, the client is
     * backed by {@link SocketIoClient} pointing at `server_host`.
     */
    transport_client?: AbsTransportClient;
    /**
     * Credential forwarded to the server's `auth_validator`. Opaque to the library — apps put a
     * JWT, API key, signed handshake, or whatever else their validator understands here.
     *
     * On the default socket.io transport this maps to `Manager({auth: ...})` (and is automatically
     * re-sent on reconnect, so the server re-validates after every transport drop). On the IPC
     * transport it travels in the initial `hello` envelope.
     *
     * Ignored when {@link transport_client} is injected — construct your custom transport with the
     * credential directly in that case.
     */
    auth?: unknown;
}

/**
 * Top-level remote serial port client.
 *
 * Holds one socket.io `Manager` (one transport connection). `connect()` / `mux()` create logical
 * sockets over it (socket.io namespace multiplexing), so a single connection can carry many remote
 * serial ports — in namespace mode (one namespace per port) or mux mode (paths inside payloads).
 */
export class RemoteSerialportClient extends AbsRemoteSerialportClient {
    protected readonly _transport_client: AbsTransportClient;

    protected readonly serialport_check_regexp: RegExp | string;

    protected _sockets: Map<string, AbsRemoteSerialportClientSocket> = new Map();

    protected _mux_sockets: Map<string, AbsRemoteSerialportClientMuxSocket> = new Map();

    private readonly _logger: Logger;

    private readonly _rpc_options: RpcDispatcherOptions;

    private readonly _txn_id_allocator: TxnIdAllocatorSpec;

    /**
     * @param server_host - server host, e.g. `ws://localhost:17991`
     * @param options - client options (namespace regexp, logger, RPC behavior, txn id strategy)
     */
    constructor(server_host: string, options: RemoteSerialportClientOptions = {}) {
        super();
        this._logger = options.logger ?? default_logger;
        this._rpc_options = options.rpc ?? {};
        this._txn_id_allocator = options.txn_id_allocator ?? "counter";
        this._transport_client = options.transport_client ?? new SocketIoClient(server_host, { ...this._rpc_options, logger: this._logger, auth: options.auth });
        this.serialport_check_regexp = options.serialport_check_regexp ?? DEFAULT_SERIALPORT_CHECK_REGEXP;
    }

    /**
     * Underlying socket.io-client manager (only available on the default socket.io transport).
     * Provided for ecosystem code that needs to reach into socket.io directly.
     */
    public get client_manager(): import("socket.io-client").Manager {
        return (this._transport_client as SocketIoClient).manager;
    }

    /**
     * Connect to a remote serial port (namespace mode).
     *
     * If `open_options` is given, the port is opened automatically once the handshake completes.
     * Otherwise call {@link RemoteSerialClientSocket.open} on the returned socket later (manual mode).
     * Re-calling with the same namespace returns the existing socket.
     * @param namespace - endpoint label, e.g. `/dev/ttyUSB0` or `/COM5`
     * @param open_options - serial port open options; `options.path` is the real remote path
     */
    connect(namespace: string, open_options: OpenSerialPortOptions): RemoteSerialClientSocket;
    connect(namespace: string): RemoteSerialClientSocket;
    connect(namespace: string, open_options?: OpenSerialPortOptions): RemoteSerialClientSocket {
        if (namespace.match(this.serialport_check_regexp) === null) {
            throw new Error(`Invalid namespace: ${namespace}`);
        }
        const existing: AbsRemoteSerialportClientSocket | undefined = this._sockets.get(namespace);
        if (existing !== undefined) {
            return existing as RemoteSerialClientSocket;
        }
        const transport: AbsTransport = this._transport_client.open(namespace);
        const instance: RemoteSerialClientSocket = new RemoteSerialClientSocket(transport, namespace, open_options ?? null, this._logger, this._rpc_options, this._txn_id_allocator);
        this._sockets.set(namespace, instance);
        return instance;
    }

    /**
     * Open (or reuse) a mux connection on the given mux endpoint, then address remote ports
     * dynamically via {@link RemoteSerialClientMuxSocket.open}.
     * @param namespace - mux endpoint label (default `/`); may be chosen dynamically, e.g. `/site-A`
     */
    mux(namespace: string = DEFAULT_MUX_NAMESPACE): RemoteSerialClientMuxSocket {
        const existing: AbsRemoteSerialportClientMuxSocket | undefined = this._mux_sockets.get(namespace);
        if (existing !== undefined) {
            return existing as RemoteSerialClientMuxSocket;
        }
        const transport: AbsTransport = this._transport_client.open(namespace);
        const instance: RemoteSerialClientMuxSocket = new RemoteSerialClientMuxSocket(transport, this._logger, this._rpc_options, this._txn_id_allocator);
        this._mux_sockets.set(namespace, instance);
        return instance;
    }

    /**
     * Disconnect one namespace's socket (namespace or mux), or — with no argument — disconnect
     * everything, drop all local virtual ports, and reset the mock-binding registry.
     */
    disconnect(namespace?: string): void {
        if (typeof namespace === "string") {
            this._sockets.get(namespace)?.disconnect();
            this._sockets.delete(namespace);
            this._mux_sockets.get(namespace)?.disconnect();
            this._mux_sockets.delete(namespace);
            return;
        }
        for (const socket of this._sockets.values()) {
            socket.disconnect();
        }
        for (const socket of this._mux_sockets.values()) {
            socket.disconnect();
        }
        this._sockets.clear();
        this._mux_sockets.clear();
        this._transport_client.close();
        MockBinding.reset();
    }
}

/* ---- transport re-exports ---- */
export { SocketIoClient, SocketIoClientTransport } from "./module/socketio-transport";
export { NodeIpcClient, NodeIpcClientTransport, MessagePortLike } from "./module/ipc-transport";
export { RawTcpClient, RawTcpConnectTarget, RawTcpClientOptions } from "./module/raw-tcp-transport";
export { RawWebSocketClient, RawWebSocketConnectTarget, RawWebSocketClientOptions } from "./module/raw-websocket-transport";
export { Http2Client, Http2ConnectTarget, Http2ClientOptions } from "./module/http2-transport";
export { MqttRsClient, MqttClientOptions } from "./module/mqtt-transport";
export { GrpcClient, GrpcConnectTarget, GrpcClientOptions } from "./module/grpc-transport";
export { WebRtcClient, WebRtcClientOptions, WebRtcSignalingChannel, WebRtcSignalingMessage } from "./module/webrtc-transport";
export type { AbsTransport, AbsTransportClient } from "./types/remote-serialport-types/src/transport";
