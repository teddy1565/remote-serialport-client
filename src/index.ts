import { Manager, Socket } from "socket.io-client";
import { OpenSerialPortOptions } from "./types/remote-serialport-types/src/serialport";
import { RemoteSerialClientSocket } from "./module/remote-serialport-client";
import { AbsRemoteSerialportClient } from "./types/remote-serialport-types/src/remote-serial-client.model";
import { SocketServerSideEmitChannel, SocketServerSideEmitPayload } from "./types/remote-serialport-types/src/index";

export class RemoteSerialportClient extends AbsRemoteSerialportClient {

    protected _socket: RemoteSerialClientSocket | null = null;

    /**
     *
     * @param server_host - Server Host, Example: ws://localhost:17991
     */
    constructor(server_host: string, serialport_check_regexp: RegExp | string = /^(\/dev\/tty(USB|AMA|ACM)|\/COM)[0-9]+$/) {
        super(server_host, serialport_check_regexp);
    }

    /**
     * Open Serialport Path, namespace serial path will override open_options path
     * @param namesapce - The namespace of the server, Example: /dev/ttyUSB0 or COM1...
     * @param open_options - Serial Port Open Options
     * @returns - Socket Instance
     */
    connect(namesapce: string, open_options: OpenSerialPortOptions): RemoteSerialClientSocket {
        if (namesapce.match(this.serialport_check_regexp) === null) {
            throw new Error("Invalid Serialport");
        }
        const socketIO_client_instance = this.client_manager.socket(namesapce);
        this._socket = new RemoteSerialClientSocket(socketIO_client_instance, open_options);
        return this._socket;
    }

    disconnect() {
    }
}
