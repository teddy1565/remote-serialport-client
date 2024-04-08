import { Socket } from "socket.io-client";
import { SocketServerSideEmitChannel,
    SocketServerSideEmitPayload,
    SocketClientSideEmitChannel,
    SocketServerSideEmitPayload_SerialPort_Packet,
    SocketServerSideEmitPayload_RemoteSerialServerHandshake,
    SocketServerSideEmitPayload_SerialPort_InitResult,
    SocketClientSideEmitPayload_SerialPort_SendPacket,
    SocketClientSideEmitPayload } from "../types/remote-serialport-types/src/index";

import { OpenSerialPortOptions } from "../types/remote-serialport-types/src/serialport";
import { AbsRemoteSerialportClientPortInstance, AbsRemoteSerialportClientSocket, OpenOptoinsForSerialPortStream } from "../types/remote-serialport-types/src/remote-serial-client.model";
import { MockBindingInterface, CreatePortOptions, MockBinding } from "@serialport/binding-mock";
import { SerialPortStream, OpenOptions } from "@serialport/stream";
import { BindingInterface } from "@serialport/bindings-interface";

import EventEmitter from "events";

export class RemoteSerialClientPortInstanceEventEmitter extends EventEmitter {
    constructor() {
        super();
    }

    emit(channel: "write-command", data: Buffer | Array<number>): boolean {
        return super.emit(channel, data);
    }

    on(channel: "write-command", listener: (data: Buffer | Array<number>) => void): this {
        return super.on(channel, listener);
    }

    once(channel: "write-command", listener: (data: Buffer | Array<number>) => void): this {
        return super.once(channel, listener);
    }
}

export class RemoteSerialportStream extends SerialPortStream {

    private _portInstanceEventEmitter: RemoteSerialClientPortInstanceEventEmitter;

    constructor(options: OpenOptions, portInstanceEventEmitter: RemoteSerialClientPortInstanceEventEmitter) {
        super(options);
        this._portInstanceEventEmitter = portInstanceEventEmitter;
    }

    /**
     * When logical data is written to the local port, it will be encapsulated and sent to the remote end.
     * @param chunk
     * @param encoding
     * @param cb
     */
    // eslint-disable-next-line no-undef
    override write(chunk: Buffer | Array<number>, encoding?: BufferEncoding, cb?: (error: Error | null | undefined) => void): boolean;
    /**
     * When logical data is written to the local port, it will be encapsulated and sent to the remote end.
     * @param chunk
     * @param encoding
     * @param cb
     */
    override write(chunk: Buffer | Array<number>, cb?: (error: Error | null | undefined) => void): boolean;
    override write(chunk: Buffer | Array<number>, encoding?: any, cb?: any): boolean {
        this._portInstanceEventEmitter.emit("write-command", chunk);
        return true;
    }

    /**
     * When physical data is written from the remote end, through additional encapsulation, writing to the local logical port will not conflict with the logical port reading packets.
     *
     * for example, when remote side get <buffer aa bb cc dd>, but local side write <buffer ee ff>
     *
     * you will get <buffer aa bb cc dd ee ff> when you read from the local side
     *
     * so, we need split the buffer to two parts, one is <buffer aa bb cc dd>, another is <buffer ee ff>
     *
     * when we get remote packet, use this method write to the local logical port,
     *
     * when we write to the local logical port, use other overridemethod `write` to the remote end
     * @param chunk
     * @returns
     */
    write_from_physical_remote_write(chunk: Buffer | Array<number>): boolean {
        return super.write(chunk);
    }
}



export class RemoteSerialClientPortInstance extends AbsRemoteSerialportClientPortInstance {
    protected mock_binding: MockBindingInterface;

    protected port_path: string;

    private _serialport_stream: RemoteSerialportStream | null = null;

    /**
     * Serialport Data I/O interface Event Emitter
     */
    private _data_event_emitter: RemoteSerialClientPortInstanceEventEmitter;

    /**
     * @param mock_binding - Mock Binding Instance
     * @param port_path - Serial Port Path
     * @param open_options - Open SerialPortStream Options
     */
    constructor(mock_binding: MockBindingInterface, port_path: string, data_event_emitter: RemoteSerialClientPortInstanceEventEmitter) {
        super();
        this.mock_binding = mock_binding;
        this.port_path = port_path;
        this._data_event_emitter = data_event_emitter;
    }

    /**
     * get a serial port stream instance
     * @param open_options - Open SerialPortStream Options
     * @returns SerialPortStream Instance
     */
    public get_port(open_options: OpenOptoinsForSerialPortStream): RemoteSerialportStream {
        if (open_options === undefined || open_options === null) {
            throw new Error("Invalid Open Options");
        } else if (this._serialport_stream !== null) {
            return this._serialport_stream;
        }
        open_options.binding = this.mock_binding;
        open_options.path = this.port_path;
        this._serialport_stream = new RemoteSerialportStream(open_options as OpenOptions<BindingInterface>, this._data_event_emitter);
        return this._serialport_stream;
    }

    public write(data: Buffer): void {
        if (this._serialport_stream !== null) {
            this._serialport_stream.write_from_physical_remote_write(data);
        }
    }
}


export class RemoteSerialClientSocket extends AbsRemoteSerialportClientSocket {
    protected _socket: Socket;

    protected _open_options: OpenSerialPortOptions;

    private _debug_mode: boolean;

    private _remoteSerialClientPortInstance_map: Map<string, RemoteSerialClientPortInstance> = new Map();

    /**
     * Serialport Data I/O interface Event Emitter
     */
    private _data_event_emitter: RemoteSerialClientPortInstanceEventEmitter  = new RemoteSerialClientPortInstanceEventEmitter();

    /**
     * When WebSocket handshake is successful, it will be `true`. Otherwise, it will be `false`.
     */
    private _remote_serialport_init_status: boolean = false;

    /**
     * @param socket - Socket.io Socket Instance
     * @param open_options - serialport open options
     * @param debug_mode - Debug Mode
     */
    constructor(socket: Socket, open_options: OpenSerialPortOptions, debug_mode: boolean = false) {
        super();
        if (open_options === undefined || open_options === null) {
            throw new Error("Invalid Open Options");
        }
        this._socket = socket;
        this._debug_mode = debug_mode;

        this._socket.on("connect", () => {
            this._initialize();
        });
        this._open_options = open_options;

        /**
         * When the server-side sends a packet, it will be sent to the local serial port
         */
        this.on("serialport_packet", (data_chunk) => {
            for(const [path, remote_serial_client_port_instance] of this._remoteSerialClientPortInstance_map) {
                remote_serial_client_port_instance.write(data_chunk as Buffer);
            }
        });

        /**
         * when local serialport call `write` method, it will be sent to this event emitter, and then send to the server-side
         */
        this._data_event_emitter.on("write-command", (data) => {
            this.emit("serialport_send_packet", data);
        });
    }

    /**
     * @description
     * Get Remote Serialport Init Status
     */
    get remote_serialport_init_status(): boolean {
        return this._remote_serialport_init_status;
    }

    /**
     * @description
     * Initialize Remote Serialport Client (Init Socket Handshake)
     */
    private _initialize(): void {
        this.once("serialport_handshake", (data) => {
            if (data.code === "handshake" && data.data === true) {
                this.emit("serialport_handshake", {
                    code: "serialport_handshake",
                    data: this._open_options
                });
            }
        });
        this.once("serialport_init_result", (data) => {
            if (data.code === "serialport_init_result" && data.data === true) {
                if (this._debug_mode === true) {
                    console.log("Serialport Init Result: ", data);
                }
                this._remote_serialport_init_status = true;
            } else if (data.code === "serialport_init_result" && data.data === false) {
                this._remote_serialport_init_status = false;
                throw new Error("Serialport Init Failed");
            } else {
                this._remote_serialport_init_status = false;
                throw new Error("Invalid Serialport Init Result");
            }
        });
    }

    emit(channel: Extract<SocketClientSideEmitChannel, "serialport_send_packet">, message: SocketClientSideEmitPayload_SerialPort_SendPacket): void;
    emit(channel: SocketClientSideEmitChannel, message: SocketClientSideEmitPayload): void;
    emit(channel: SocketClientSideEmitChannel, message: SocketClientSideEmitPayload): void {
        this._socket.emit(channel, message);
    }

    on(channel: "serialport_handshake", listener: (data: SocketServerSideEmitPayload & SocketServerSideEmitPayload_RemoteSerialServerHandshake) => void): void;
    on(channel: "serialport_packet", listener: (data_chunk: SocketServerSideEmitPayload & SocketServerSideEmitPayload_SerialPort_Packet) => void): void;
    on(channel: "serialport_init_result", listener: (data: SocketServerSideEmitPayload & SocketServerSideEmitPayload_SerialPort_InitResult) => void): void;
    on(channel: SocketServerSideEmitChannel, listener: (data: SocketServerSideEmitPayload) => void): void;
    on(channel: SocketServerSideEmitChannel, listener: (...args: any[]) => void): void {
        this._socket.on(channel, listener);
    }

    once(channel: "serialport_handshake", listener: (data: SocketServerSideEmitPayload & SocketServerSideEmitPayload_RemoteSerialServerHandshake) => void): void;
    once(channel: "serialport_packet", listener: (data_chunk: SocketServerSideEmitPayload & SocketServerSideEmitPayload_SerialPort_Packet) => void): void;
    /**
     * When WebSocket handshake done, toggle the serialport handshake event
     * @param channel
     * @param listener
     */
    once(channel: "serialport_init_result", listener: (data: SocketServerSideEmitPayload & SocketServerSideEmitPayload_SerialPort_InitResult) => void): void;
    once(channel: SocketServerSideEmitChannel, listener: (data: SocketServerSideEmitPayload) => void): void;
    once(channel: SocketServerSideEmitChannel, listener: (...args: any[]) => void): void {
        this._socket.once(channel, listener);
    }

    disconnect(close?: boolean): void {
        this._socket.disconnect();
    }

    /**
     * @description
     * Create a virtual serial port
     * @example
     * const remote_serialport_client = new RemoteSerialportClient("ws://localhost:17991");
     * const serialport_client = remote_serialport_client.connect("/dev/ttyUSB0", { // speicify remote serial port path
     *    path: "/dev/ttyUSB0",
     *    baudRate: 115200
     * });
     *
     * serialport_client.create_port("/dev/ttyUSB1", { echo: true, record: true }).get_port({ })
     * @param path - Serial Port Path
     * @param opt - Create Port Options
     * @returns - RemoteSerialClientPortInstance
     */
    create_port(path: string, opt?: CreatePortOptions | undefined): RemoteSerialClientPortInstance {
        if (this._remoteSerialClientPortInstance_map.has(path) === true) {
            return this._remoteSerialClientPortInstance_map.get(path) as RemoteSerialClientPortInstance;
        }

        if (opt === undefined || opt === null) {
            opt = <CreatePortOptions>{ echo: true };
        }
        opt.echo = true; // echo must be `true`, because need get buffer data from mock binding
        MockBinding.createPort(path, opt);
        const remote_serial_client_port_instance = new RemoteSerialClientPortInstance(MockBinding, path, this._data_event_emitter);
        this._remoteSerialClientPortInstance_map.set(path, remote_serial_client_port_instance);
        return remote_serial_client_port_instance;
    }
}
