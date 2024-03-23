import { Manager, Socket } from "socket.io-client";

export interface IRemoteSerialportClient {
    /**
     * Connect to the server
     * @param namesapce - Just Input the namespace, because server host input in the constructor
     * @returns - Socket
     */
    connect: (namesapce: string) => Socket;
    disconnect: () => void;
    on: (event: string, callback: (...args: any[]) => void) => void;
}
