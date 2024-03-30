import { Manager } from "socket.io-client";

import { IRemoteSerialportClient } from "./index.d";

export class RemoteSerialportClient implements IRemoteSerialportClient {

    private client_manager: Manager;

    private serialport_check_regexp: RegExp | string;

    /**
     *
     * @param server_host - Server Host, Example: ws://localhost:17991
     */
    constructor(server_host: string, serialport_check_regexp: RegExp | string = /^(\/dev\/tty(USB|AMA|ACM)|\/COM)[0-9]+$/) {
        throw new Error("Not Implemented");
        // this.client_manager = new Manager(server_host);
        // this.serialport_check_regexp = serialport_check_regexp;
    }

    /**
     *
     * @param namesapce - The namespace of the server, Example: /dev/ttyUSB0 or COM1...
     * @returns
     */
    connect(namesapce: string) {
        if (namesapce.match(this.serialport_check_regexp) === null) {
            throw new Error("Invalid Serialport");
        }
        return this.client_manager.socket(namesapce);
    }

    disconnect() {
    }

    on(event: string, callback: (...args: any[]) => void) {
    }
}
