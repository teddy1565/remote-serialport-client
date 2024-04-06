import { Socket } from "socket.io-client";
import { SocketServerSideEmitChannel,
    SocketServerSideEmitPayload,
    SocketClientSideEmitChannel,
    SocketServerSideEmitPayload_SerialPort_Packet,
    SocketServerSideEmitPayload_RemoteSerialServerHandshake,
    SocketServerSideEmitPayload_SerialPort_InitResult,
    SocketClientSideEmitPayload } from "../types/remote-serialport-types/src/index";

import { OpenSerialPortOptions } from "../types/remote-serialport-types/src/serialport";
import { AbsRemoteSerialportClientPortInstance, AbsRemoteSerialportClientSocket, OpenOptoinsForSerialPortStream } from "../types/remote-serialport-types/src/remote-serial-client.model";
import { MockBindingInterface, CreatePortOptions, MockBinding } from "@serialport/binding-mock";
import { SerialPortStream, OpenOptions } from "@serialport/stream";
import { BindingInterface } from "@serialport/bindings-interface";

export class RemoteSerialClientPortInstance extends AbsRemoteSerialportClientPortInstance {
    protected mock_binding: MockBindingInterface;

    protected port_path: string;
    /**
     * @param mock_binding - Mock Binding Instance
     * @param port_path - Serial Port Path
     * @param open_options - Open SerialPortStream Options
     */
    constructor(mock_binding: MockBindingInterface, port_path: string) {
        super();
        this.mock_binding = mock_binding;
        this.port_path = port_path;
    }

    /**
     * get a serial port stream instance
     * @param open_options - Open SerialPortStream Options
     * @returns SerialPortStream Instance
     */
    public get_port(open_options: OpenOptoinsForSerialPortStream): SerialPortStream {
        if (open_options === undefined || open_options === null) {
            throw new Error("Invalid Open Options");
        }
        open_options.binding = this.mock_binding;
        open_options.path = this.port_path;
        return new SerialPortStream(open_options as OpenOptions<BindingInterface>);
    }
}


export class RemoteSerialClientSocket extends AbsRemoteSerialportClientSocket {
    protected _socket: Socket;

    protected _open_options: OpenSerialPortOptions;

    private _debug_mode: boolean = false;

    constructor(socket: Socket, open_options: OpenSerialPortOptions) {
        super();
        this._socket = socket;
        if (open_options === undefined || open_options === null) {
            throw new Error("Invalid Open Options");
        }
        this._open_options = open_options;
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
            } else if (data.code === "serialport_init_result" && data.data === false) {
                throw new Error("Serialport Init Failed");
            } else {
                throw new Error("Invalid Serialport Init Result");
            }
        });
    }

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
        MockBinding.createPort(path, opt);
        return new RemoteSerialClientPortInstance(MockBinding, path);
    }
}
