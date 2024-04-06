import { Socket } from "socket.io-client";
import { SocketServerSideEmitChannel,
    SocketServerSideEmitPayload,
    SocketClientSideEmitChannel,
    SocketServerSideEmitPayload_SerialPort_Packet,
    SocketServerSideEmitPayload_RemoteSerialServerHandshake,
    SocketServerSideEmitPayload_SerialPort_InitResult,
    SocketClientSideEmitPayload } from "../types/remote-serialport-types/src/index";

import { OpenSerialPortOptions } from "../types/remote-serialport-types/src/serialport";
import { AbsRemoteSerialportClientSocket } from "../types/remote-serialport-types/src/remote-serial-client.model";




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
}
