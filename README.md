# Remote-Serialport

## Intro

This is a repository for remote proxying of serial ports.

It is a simple server-client architecture where the server is connected to the serial port and the client connects to the server to read and write to the serial port.

This Project is divided into three parts:

1. Server
   - Control Host Physical Serial Port, and virtualize it to the network or IPC.
     - Milestone
       - [ ] Web Socket
       - [ ] Nodejs IPC
       - [ ] Electron utility IPC
2. Client
   - Connect to the server and read and write to the serial port.
     - Milestone
       - [ ] Web Socket
       - [ ] Nodejs IPC
       - [ ] Electron utility IPC
3. Types
   - Common types used in both server and client.

## Features

- [ ] Remote Serial Port Protocol ▶
  - [ ] Web Socket  ▶
    - [x] Connect To Socket Server
    - [x] Socket NameSpace Parser for Serial Port
  - [ ] Inter Process Communication  ○
- [ ] Read from serial port ▶
  - [ ] Read With Parser
    - [ ] ByteLengthParser
    - [ ] CCTalkParser
    - [ ] InterByteTimeoutParser
    - [ ] PacketLengthParser
    - [ ] ReadlineParser
    - [ ] ReadyParser
    - [ ] RegexParser
    - [ ] SlipEncoder
    - [ ] SpacePacketParser
- [ ] Write to serial port
  - [ ] Web Socket
    - [ ] Write to Serial Port
  - [ ] Inter Process Communication
    - [ ] Write to Serial Port
- [ ] Others
  - [ ] Security
    - [ ] Web Socket Security
      - [ ] Connect to server with authentication
      - [ ] Connect to server with encryption
    - [ ] Inter Process Communication Security
      - [ ] Message Encryption
      - [ ] Memory Protection
      - [ ] Message Authentication
  
## Usage

### Client

#### Usual Usage

```javascript
const { RemoteSerialportClient } = require("node-serialport-client");
const { ByteLengthParser } = require("serialport");

const RSC = new RemoteSerialportClient("ws://localhost:17991"); // Initialize the client with the server address

// In windows
const client = RSC.connect("/COM5", { baudRate: 115200 }); // Connect to the server and get the port

// In linux
const client_linux = RSC.connect("/dev/ttyUSB0", { baudRate: 115200 }); // Connect to the server and get the port

// Mapping remote port COM5 to local port COM17
const serialport = client.create_port("COM17").get_port({
    baudRate: 115200,
    autoOpen: true
});

const parser = serialport.pipe(new ByteLengthParser({ length: 30 }));

parser.on("data", (data) => {
    console.log(data);
});
```

#### With Modbus-Serial

```javascript
const { RemoteSerialportClient } = require("node-serialport-client");;
const ModbusRTU = require("modbus-serial");

const RSC = new RemoteSerialportClient("ws://localhost:17991"); // Initialize the client with the server address

// In windows
const client = RSC.connect("/COM5", { baudRate: 115200 }); // Connect to the server and get the port

// In linux
const client_linux = RSC.connect("/dev/ttyUSB0", { baudRate: 115200 }); // Connect to the server and get the port

// Mapping remote port COM5 to local port COM17
const port = client.create_port("COM17");

// There has two ways to create a modbus client

// first way
// create an empty modbus client
const client = new ModbusRTU();
// open connection to a serial port
client.connectRTUBuffered("/dev/ttyUSB0", { baudRate: 9600 });


// or you can use the second way

// the second way
const client = new ModbusMaster(port.get_port({ baudRate: 9600 }));

client.setID(1)
client.readHoldingRegisters(3, 2).then((data) => {
    console.log(data)
}).catch((error) => {
    console.log(error)
})

```
