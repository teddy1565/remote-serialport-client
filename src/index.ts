import { Manager } from "socket.io-client";
const client_manager = new Manager("ws://localhost:17991");

const client = client_manager.socket("/dev/ttyUSB0");

client.on("connect", () => {
    console.log("Connected to Server");
});
