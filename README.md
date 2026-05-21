# Remote-Serialport

> **Language**: [English](#english) · [中文](#中文)

<a id="english"></a>

## English

> **⚠ Node.js only.** This library uses Node's `Buffer`, `worker_threads`, `node:http2`, the
> native `serialport` binding, and other Node-specific APIs. It **does not work in browsers**
> — bundling it via webpack / Vite / Rollup will fail at `Buffer`/`stream`/`net` imports.
> For a browser front-end, write a thin app-layer adapter against your own WebSocket / WebRTC
> and forward bytes — don't try to load this package in the browser.

Proxy a host's physical serial ports over the network: the **server** holds the real serial ports;
the **client** connects and gets a local *virtual* serial port (a mock-binding–backed
`SerialPortStream`) that mirrors a remote one. Reads/writes on the virtual port are forwarded to the
physical port, and vice versa — so existing Node serialport code (`serialport`, `modbus-serial`, …)
works across the network with almost no changes.

This project is split into three packages:

| Package | npm | Role |
|---|---|---|
| [`remote-serialport-types`](https://github.com/teddy1565/remote-serialport-types) | `remote-serialport-types` | Shared protocol types & abstract contracts (consumed by the other two via git submodule). |
| [`remote-serialport-server`](https://github.com/teddy1565/remote-serialport-server) | `node-serialport-server` | Owns the physical serial ports; exposes them over socket.io. |
| [`remote-serialport-client`](https://github.com/teddy1565/remote-serialport-client) | `node-serialport-client` | Connects to the server; surfaces remote ports as local virtual ports. |

> **Developing from source?** The `types` package is included as a git submodule under
> `src/types/remote-serialport-types`. After `git submodule update --init`, run `npm install` **inside
> that submodule directory too** (it has its own dependencies) so `tsc` resolves all types.

## Use cases — when do you need this?

The core problem this solves: **the code that wants to talk to a serial device, and the machine the
device is physically plugged into, are not the same machine** — or not the same process, or not the
same container. If your device and your code share a process, you don't need this; just use
`serialport` directly. You want `remote-serialport` when one of these is true:

| Scenario | Why this library helps |
|---|---|
| **Remote industrial / lab equipment.** A PLC, Modbus energy meter, RS-485 sensor bus, or bench instrument sits on a factory floor or a lab rack; your control / monitoring code runs on a server, a dev laptop, or a cloud VM. | Run `remote-serialport-server` on the small box wired to the equipment. Run your existing `modbus-serial` / `serialport` code anywhere and point it at a *virtual* port — almost zero code change. |
| **Containerised / Kubernetes apps.** A container can't see host `/dev/ttyUSB0` without privileged device passthrough. | Run the server on the host (or one privileged sidecar); let unprivileged app containers connect over the network. No `--device`, no `--privileged`. |
| **Shared access to one instrument.** Several engineers — or several services — need the same RS-485 line at once. | `multi_access: 'shared'` refcounts a single physical port, fans reads out to every client, and the `shared_mode` policy table arbitrates writes (FIFO, single-writer, COW snapshot, …). |
| **Hardware-in-the-loop CI / test farms.** The device under test lives in a test rack; CI runners are elsewhere or ephemeral. | The server keeps the port; each CI job connects, runs, disconnects. Or inject a mock-backed `serialport_factory` and run the *same* suite with no hardware at all. |
| **Electron / multi-process desktop apps.** The native `serialport` binding shouldn't load in your renderer process. | Keep `serialport` in a utility process or worker; talk to it from the rest of the app over the **IPC transport** (`NodeIpcClient` on a `MessagePort`). Same API, no network hop. |
| **IoT gateways / device mesh.** An edge gateway aggregates many serial devices; a cloud service addresses them dynamically and neither side has a stable address. | Use **mux mode** (one connection, ports addressed by `path` in the payload) and/or the **MQTT transport** so both sides only need to know the broker. |

> **Not for browsers.** This is a Node.js library (see the warning at the top). For a browser
> front-end, put `remote-serialport` on a Node backend and expose your own app-layer API to the
> browser.

## Two modes

- **Namespace mode** — one socket.io namespace = one remote serial port. `client.connect("/dev/ttyUSB0", …)`.
  Simple and socket.io-idiomatic. Multiple `connect()` calls reuse the client's single transport
  connection (socket.io namespace multiplexing), so one connection can still carry many ports.
- **Mux mode** — one connection on a "mux namespace" carries any number of remote ports, addressed
  dynamically by `path` inside the messages. For cases where you don't want a namespace per port
  (e.g. IoT mesh, dynamic addressing). `client.mux("/site-A").open("/dev/ttyUSB0", …)`.

The two modes share the same protocol shape; the only difference is whether the socket itself
identifies the port (namespace mode, payloads are raw bytes) or each payload carries a `path`
(mux mode).

## Install

```bash
npm install node-serialport-server   # server
npm install node-serialport-client   # client
```

## Quick start — a complete echo example

A minimal end-to-end pair. Run the **server** on the machine with the serial hardware; run the
**client** anywhere that can reach it over the network.

**`server.js`** — on the host with `/dev/ttyUSB0` physically attached:

```javascript
const { RemoteSerialportServer } = require("node-serialport-server");

const server = new RemoteSerialportServer(
  { cors: { origin: "*" } }, // socket.io ServerOptions
  17991                      // listen port
);
server.listen();

server.of().on("connection", (socket) => {
  // Write direction (client -> device) is wired automatically.
  socket.pipe(); // forward read direction (device -> client)

  socket.port.on("data", (chunk) =>
    console.log(`device sent ${chunk.length} bytes`));
  console.log("client connected, proxying", socket.port.path);
});

console.log("remote-serialport server listening on :17991");
```

**`client.js`** — on any other machine (replace the IP with the server's):

```javascript
const { RemoteSerialportClient } = require("node-serialport-client");
const { ReadlineParser } = require("serialport");

const rsc = new RemoteSerialportClient("ws://192.168.1.50:17991");

// 1st arg = socket.io namespace; options.path = the real remote serial path.
const conn = rsc.connect("/dev/ttyUSB0", {
  path: "/dev/ttyUSB0",
  baudRate: 115200,
});

// Map the remote port to a LOCAL virtual port path; get a SerialPortStream.
const port = conn
  .create_port("/dev/ttyV0")
  .get_port({ baudRate: 115200, autoOpen: true });

// Read: device -> here
port.pipe(new ReadlineParser({ delimiter: "\r\n" }))
    .on("data", (line) => console.log("line from device:", line));

// Write: here -> device (forwarded to the real physical port)
port.on("open", () => port.write("PING\r\n"));

port.on("error", (err) => console.error("port error:", err.message));

// When done: rsc.disconnect();
```

`port` is an ordinary `SerialPortStream` — any library that already accepts a serialport instance
(`modbus-serial`, `@serialport/parser-*`, …) takes it unchanged. The rest of this README drills
into each capability; the [server README](../remote-serialport-server/README.md) covers the
server side in the same depth.

## Server

### Namespace mode

```javascript
const { RemoteSerialportServer } = require("node-serialport-server");

const server = new RemoteSerialportServer(
  { cors: { origin: "*", methods: ["GET", "POST"] } }, // socket.io ServerOptions
  17991,                                               // port
  { /* strict_path: true, auto_pipe: false, serialport_factory */ }
);
server.listen();

server.of().on("connection", (socket) => {
  // Write direction (client -> device) is wired automatically.
  // Read direction (device -> client): either let the library forward it...
  socket.pipe();

  // ...or forward it yourself if you need to transform bytes in transit:
  // socket.port.on("data", (chunk) => socket.emit("serialport_packet", transform(chunk)));
  // (don't do both — data would be forwarded twice)

  socket.port.on("data", (chunk) => console.log("device says", chunk));
});
```

All `RemoteSerialServerOptions`:

| Option | Default | What it does |
|---|---|---|
| `strict_path` | `true` | If `false`, namespace is just a routing label and client's `options.path` is used (still regexp-validated). |
| `auto_pipe` | `false` | If `true`, every accepted connection auto-`pipe()`s (read direction). |
| `serialport_factory` | `(opts) => new SerialPort(opts)` | Inject a mock-backed factory in tests. |
| `port_list_provider` | `() => SerialPort.list()` | Override what `serialport_list` RPC returns (tests can return mock entries; `SerialPort.list()` doesn't see `SerialPortMock` ports). |
| `logger` | warn/error → console, debug/info silent | Inject pino / winston / your own `Logger` (see below). |
| `multi_access` | `'reject'` | `'shared'` lets multiple clients connect to the same physical path (refcounted). |
| `shared_mode` | `'fifo'` | Only used when `multi_access='shared'`. See [Shared mode](#shared-mode-multi_access-shared). |
| `txn_timeout_ms` | `5000` | Per-transaction timeout; reset on each `serialport_send_chunk`. Drops buffered chunks if no `_end`/`_abort` arrives. |
| `txn_timeout_action` | `'log'` | `'log'` / `'state'` (also emit `serialport_state: ERROR`) / `'both'`. |

### Mux mode

```javascript
server.mux().on("connection", (socket) => {
  socket.pipe(); // forward reads for every port on this connection (existing and future)
  // Per-port proxies: socket.port("/dev/ttyUSB0").on("data", …)
});
```

`server.mux("/site-A")` (or a regexp) to use a specific / dynamic mux namespace; default `/`.

## Client

### Namespace mode — auto open

```javascript
const { RemoteSerialportClient } = require("node-serialport-client");
const { ByteLengthParser } = require("serialport");

const rsc = new RemoteSerialportClient("ws://localhost:17991");

// connect to the remote port (the 1st arg is the socket.io namespace; options.path is the real
// remote serial path — usually the same string). The port is opened automatically after handshake.
const conn = rsc.connect("/dev/ttyUSB0", { path: "/dev/ttyUSB0", baudRate: 115200 });

// map the remote port to a local virtual port path and get a SerialPortStream-compatible object
const port = conn.create_port("/dev/ttyV0").get_port({ baudRate: 115200, autoOpen: true });

port.pipe(new ByteLengthParser({ length: 30 })).on("data", (data) => console.log(data));
port.write(Buffer.from([0x01, 0x02, 0x03])); // forwarded to the remote physical port

console.log(conn.state); // "idle" | "opening" | "open" | "closing" | "closed" | "error"
```

> **`conn.state` vs. local stream `'open'` event.** `conn.state` reflects the **remote** physical
> port's state (driven by `serialport_state` packets from the server). The local virtual
> `SerialPortStream` emits its own `'open'` event as soon as the MockBinding open completes —
> which happens **before** `conn.state` transitions to `"open"`. If you need to gate "ready to
> write" on the remote port being up, listen on `port_instance.on("data", …)` to know fanout is
> live, or poll/watch `conn.state` (a `state-changed` listener is not exposed in v2 — track
> changes via the local stream's `'error'` / `'close'` events plus `conn.state` snapshots).

All `RemoteSerialportClientOptions`:

| Option | Default | What it does |
|---|---|---|
| `serialport_check_regexp` | `/^(\/dev\/tty(USB\|AMA\|ACM)\|\/COM)[0-9]+$/` | Validates the `namespace` you pass to `connect(namespace, ...)`. Override in lockstep with the server's `serialport_namespace_regexp` if you use custom paths. |
| `logger` | warn/error → console, debug/info silent | Inject your `Logger` (see [Logger](#logger)). |
| `rpc.timeout_ms` | `5000` | `get_remote_status` / `list_ports` RPC timeout (wall-clock; not reset on reconnect). |
| `rpc.replay_on_reconnect` | `true` | On reconnect, replay in-flight RPCs. `false` → reject all pending on `disconnect`. |
| `txn_id_allocator` | `'counter'` | `'counter'` (per-socket monotonic), `'uuid'`, or `() => string`. |
| `auth` | — | Credential forwarded to the server's `auth_validator`. socket.io → `Manager({auth})`; IPC → `hello` envelope. Auto-replayed on reconnect. |
| `transport_client` | `new SocketIoClient(host, ...)` | Inject a custom transport (e.g. `NodeIpcClient`). |
| `manager_options` | — | Extra options forwarded to socket.io's `Manager(uri, opts)` ctor. Use this for TLS settings (`{ rejectUnauthorized: false, ca: ca_cert }` for `wss://`), forced transports (`{ transports: ["websocket"] }`), reconnect cadence, etc. Only honored on the default socket.io transport. |

#### `wss://` example

```javascript
const rsc = new RemoteSerialportClient("wss://your-host:17991", {
  manager_options: {
    transports: ["websocket"],
    rejectUnauthorized: false,        // dev only; for production use `ca: production_ca`
    ca: my_ca_pem,                    // private-CA chain (production)
  }
});
```

The matching server side attaches its `srv.io` to an `https.Server` — see the
[server README's TLS section](../remote-serialport-server/README.md#encryption--tls).

### Namespace mode — manual open

```javascript
const conn = rsc.connect("/dev/ttyUSB0");      // connect only, don't open yet
// ...later...
conn.open({ path: "/dev/ttyUSB0", baudRate: 9600 });
```

### With modbus-serial

```javascript
const ModbusRTU = require("modbus-serial");
const rsc = new RemoteSerialportClient("ws://localhost:17991");
const conn = rsc.connect("/dev/ttyUSB0", { path: "/dev/ttyUSB0", baudRate: 9600 });
const port = conn.create_port("/dev/ttyV0").get_port({ baudRate: 9600 });

const modbus = new ModbusRTU(port);
modbus.setID(1);
modbus.readHoldingRegisters(3, 2).then(console.log).catch(console.error);
```

### Mux mode

```javascript
const mux = rsc.mux();                 // or rsc.mux("/site-A")
mux.open("/dev/ttyUSB0", { path: "/dev/ttyUSB0", baudRate: 115200 });
mux.open("/dev/ttyACM0", { path: "/dev/ttyACM0", baudRate: 9600 });

const portA = mux.create_port("/dev/ttyUSB0", "/dev/ttyVA").get_port({ baudRate: 115200, autoOpen: true });
const portB = mux.create_port("/dev/ttyACM0", "/dev/ttyVB").get_port({ baudRate: 9600, autoOpen: true });

console.log(mux.get_state("/dev/ttyUSB0"));
```

### Remote port control / discovery (RPC)

These act on the *physical* port on the server (the local virtual port's own `set/get/update/flush`
still go to the local mock binding and are unaffected). `get`/`list` return a `Promise`
(socket.io ack under the hood, ~5s timeout).

```javascript
const ports  = await conn.list_ports();          // PortInfo[] — server host's SerialPort.list()
const status = await conn.get_remote_status();   // { cts, dsr, dcd } of the real port
conn.set_remote({ dtr: true, rts: false });      // toggle modem control lines on the real port
conn.update_remote({ baudRate: 9600 });          // change baud rate on the real port
conn.flush_remote();                             // discard the real port's buffers

// mux variants take the remote path (list_ports is server-wide, no path):
const muxStatus = await mux.get_remote_status("/dev/ttyUSB0");
mux.set_remote("/dev/ttyUSB0", { dtr: true });
const muxPorts  = await mux.list_ports();
```

The server reads the port list from `() => SerialPort.list()` by default; pass `port_list_provider`
in the server options to override (e.g. in tests, where `SerialPort.list()` doesn't see mock ports).

### Multiple servers

```javascript
const { RemoteSerialportServerManager } = require("node-serialport-server");
const mgr = new RemoteSerialportServerManager();
mgr.create("line-A", { cors: { origin: "*" } }, 17991);
mgr.create("modbus", { cors: { origin: "*" } }, 17992);
mgr.listen_all();
// mgr.get("line-A"), mgr.servers, mgr.close_all()
```

### Disconnect

```javascript
rsc.disconnect("/dev/ttyUSB0"); // one socket
rsc.disconnect();               // everything + drop all virtual ports + reset mock registry
```

### Multi-chunk transactions (txn)

For writes that span multiple chunks and must be atomic on the device side (e.g. one Modbus PDU sent
as several pieces; network may delay/drop chunks; the server must not write partial bytes).

```javascript
const portInst = conn.create_port("/dev/ttyV0");

// build the transaction; server starts buffering on .txn() (sends serialport_send_begin)
const tx = portInst.txn();
tx.write(Buffer.from([0x01, 0x03]));
tx.write(Buffer.from([0x00, 0x00, 0x00, 0x02]));
await tx.end(); // Promise resolves when the FULL buffer has drained on the physical port

// scoped: auto end on success, auto abort on throw
await portInst.with_txn(async (tx) => {
  tx.write(part1);
  if (some_error) throw new Error("rollback"); // auto-aborts; bytes never reach device
  tx.write(part2);
});
```

- Server-side timeout (`txn_timeout_ms`, default 5s, **resets on every chunk**) drops buffered chunks
  if no `_end` / `_abort` arrives.
- Only `_end` consumes a slot in the client's send window; `_begin` / `_chunk` / `_abort` are free.
- **Calling `tx.abort()` *inside* a `with_txn(async (tx) => …)` callback** causes the wrapper's
  implicit `_end` to find the handle already in `aborted` state and reject the promise with
  `"txn N was aborted"`. The rollback DID happen (bytes never reach the device), but
  `with_txn` itself throws. For non-throwing explicit abort, use the lower-level
  `portInst.txn()` handle directly and call `tx.abort()` outside any `with_txn` wrapper — as
  in the first example above.

### Logger

`RemoteSerialServerOptions.logger` (server) and `RemoteSerialportClientOptions.logger` (client)
accept any object matching:

```typescript
interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}
```

Default: `warn` / `error` to `console`, `debug` / `info` discarded. Plug in pino/winston/etc. for
production logging.

### Reconnect behavior (client)

Both `connect()` and `mux()` survive transport drops:

- **Namespace mode**: `_open_options` is preserved; on reconnect the client auto-replays
  `serialport_open` after the handshake. The server reopens the physical port.
- **Mux mode**: every `mux.open(remote_path, options)` is persisted in an `_active_opens` map and
  replayed on every reconnect. Removed only by `mux.close(remote_path)` or `rsc.disconnect()`.
- **In-flight RPCs** (`get_remote_status` / `list_ports`): replayed on reconnect with the **original
  deadline** (not reset). Configure via the constructor:

```javascript
const rsc = new RemoteSerialportClient("ws://localhost:17991", {
  logger: my_logger,
  rpc: { timeout_ms: 5000, replay_on_reconnect: true }, // defaults shown
  txn_id_allocator: "counter", // or "uuid" or () => string
});
```

**Abrupt transport disconnect (server crash, kernel reset, etc.)** — when the underlying
transport fires its `disconnect` lifecycle and no `reconnect` happens within **500 ms**, the
client propagates the loss to every open local virtual stream:

```javascript
port.on("error", (e) => { /* e.message === "transport disconnected" */ });
port.on("close", () => { /* fired right after error */ });
```

On socket.io's auto-reconnect, a transient blip fires `disconnect` followed by `reconnect`
within ms — the 500 ms grace timer cancels and the local stream sees no event, so the
recovery is invisible to apps. On the single-shot transports (Raw TCP / Raw WS / HTTP/2 /
gRPC) the disconnect almost always means "permanently gone" and the error+close events fire.
MQTT goes through the broker so the keepalive (~60 s default) must expire before the server's
loss surfaces — tune `mqtt_options.keepalive` if you need faster detection.

### Shared mode (`multi_access: 'shared'`)

Multiple clients can connect to the same physical path; the server refcounts one
`SharedPortSession` per path. Works for both namespace mode and mux mode; a namespace client and a
mux client on the same `path` share the same underlying physical port.

```javascript
const server = new RemoteSerialportServer({ cors: { origin: "*" } }, 17991, {
  multi_access: "shared",
  shared_mode: "fifo", // or "fifo-strict" / "batch" / "pipe"
});
```

| `shared_mode` | Write scheduling | Reads |
|---|---|---|
| `'fifo'` (default) | Strict by `_begin` arrival order; head-of-line blocking. | Fan-out to all subscribers. |
| `'fifo-strict'` | Same as `'fifo'` + only one in-flight write at a time. | Fan-out. |
| `'batch'` | Immediate flush on `_end`/single-shot arrival — `_end`-order on the wire, no HOL. | Fan-out. |
| `'pipe'` | First-connected client is writer; others are read-only. Writer disconnect → next-earliest client auto-promoted. | Fan-out. |
| `'cow-write-isolate'` | Immediate flush + per-subscriber echo memory (server filters device echo back to writer only). | Echo-filtered fan-out. |
| `'cow-snapshot'` | Immediate flush. | Fan-out + ring-buffer replay on join (`cow_snapshot_buffer_bytes`, default 64 KB). |
| `'cow-virtual-port'` | Immediate flush + per-subscriber `set`/`update` state cache; last-write-wins on physical. | Fan-out. |

Writer policy + scheduling are *per-path*. Drain acks for each write route back to the originating
client only (no cross-client window stalls).

### Wire backpressure (device→client)

When `socket.pipe()` is forwarding physical bytes faster than the client can drain them, the
server samples the underlying socket.io transport's `bufferedAmount` after each emit and `pause()`s
the physical port once it crosses `WIRE_BACKPRESSURE_HIGH_WATER` (1 MB). A periodic check
(`WIRE_BACKPRESSURE_POLL_MS`, 50 ms) `resume()`s it once the buffer falls below
`WIRE_BACKPRESSURE_LOW_WATER` (256 KB). Only active in `multi_access: 'reject'` mode — shared mode
pause/resume would starve other subscribers, so it's disabled there. IPC transports report
`get_buffered_amount()` as `null`, so wire backpressure is skipped on IPC.

### Authentication

```javascript
const rsc = new RemoteSerialportClient("ws://example:17991", {
  auth: { token: my_jwt }  // opaque; server-side `auth_validator` interprets it
});
```

On the default socket.io transport, `auth` lands in the `Manager({auth})` field and is replayed
on every reconnect, so the server's `auth_validator` re-runs after each transport drop.

> **Gotcha — top-level `auth` is only wired for the default socket.io transport.** If you
> inject your own `transport_client` (Raw TCP / Raw WebSocket / HTTP/2 / MQTT / gRPC), the
> top-level `auth` option is **silently dropped** — pass the credential into the transport's
> own constructor options instead:
>
> ```javascript
> // Right way for non-socket.io transports:
> new RemoteSerialportClient("", { transport_client: new RawTcpClient({host, port}, { auth: cred }) });
> new RemoteSerialportClient("", { transport_client: new MqttRsClient({broker_url, auth: cred }) });
> new RemoteSerialportClient("", { transport_client: new Http2Client({url}, { auth: cred }) });
> ```
>
> If you accidentally combine top-level `auth` with a user-supplied `transport_client`, the
> library logs a `warn` at construction time explaining how to fix it. WebRTC carries no
> app-level auth by design — gate connections at the signaling layer.

When the server denies auth, the connection closes without a `serialport_handshake`; locally that
manifests as a stream that never reaches `open` (the local virtual port stays in `idle`). The
server's logger and `serialport_state: ERROR` payload carry the reason.

### Transports (`AbsTransport`)

The default transport is **socket.io-client**; a second built-in transport speaks **Node IPC**
(`worker_threads.MessagePort` / Electron utility process `MessagePort`). Swap by injecting
`transport_client` into the constructor.

#### Choosing a transport

All transports speak the same protocol — pick by deployment shape, not by feature. Quick guide:

| Transport | Class | Reach for it when… | Watch out for |
|---|---|---|---|
| **socket.io** (default) | — | You want auto-reconnect, RPC replay, and Engine.IO's polling fallback. The safe default for anything over a real network. | Slightly lower raw throughput (~18 MB/s localhost). |
| **Node IPC** | `NodeIpcClient` | Server and client are different *processes on the same host* — Electron utility process, `worker_threads`. No network at all. | Single endpoint per `MessagePort` pair → use mux mode. No reconnect. |
| **Raw TCP / UDS / Pipe** | `RawTcpClient` | Trusted LAN and you want the thinnest path; or a same-host Unix socket / named pipe. | Single-shot — no auto-reconnect. |
| **Raw WebSocket** | `RawWebSocketClient` | You want WebSocket semantics without Engine.IO's overhead. Highest WS throughput (~44 MB/s localhost). | Single-shot — no auto-reconnect / fallback. |
| **HTTP/2** | `Http2Client` | Many ports on one connection and you care about tail latency — per-stream flow control, no head-of-line blocking. Best p99 (~1.5 ms locally). | — |
| **MQTT** | `MqttRsClient` | Decoupled deployment: server and clients only know a broker's address (NAT on both sides, intermittent links). | Highest latency; QoS-1 duplicate-write caveat (see below). |
| **gRPC** | `GrpcClient` | Your infrastructure is already gRPC-native (service mesh, existing `.proto` tooling). | — |
| **WebRTC** | `WebRtcClient` | True peer-to-peer with NAT traversal, no server in the data path. | Experimental; bring your own signaling. |

The subsections below give a runnable example and the full options table for each.

> **IPC `label` is the serial port path (namespace mode).** `new NodeIpcClient(port, label)` —
> in **namespace mode** the `label` you pass MUST match the path the server expects (which on
> the server side is `NodeIpcServer(port, path)`'s second argument). Passing `"/"` or a
> placeholder works only in **mux mode**, where the path comes from `mux.open(path, …)` payloads
> instead. The walkthrough's [Script 5](../note/walkthrough/05-ipc-main.js) is a worked example
> using namespace mode.

```typescript
import { MessageChannel } from "worker_threads";
import { RemoteSerialportClient, NodeIpcClient } from "node-serialport-client";

// --- Namespace mode: label = serial port path ---
const ns_channel = new MessageChannel();
const ns_rsc = new RemoteSerialportClient("", {
    transport_client: new NodeIpcClient(ns_channel.port2, "/dev/ttyUSB0") // path, not a debug name
});
const conn   = ns_rsc.connect("/dev/ttyUSB0", { path: "/dev/ttyUSB0", baudRate: 115200 });
const stream = conn.create_port("/dev/ttyV0").get_port({ baudRate: 115200, autoOpen: true });

// --- Mux mode: label unused for routing; placeholder is fine ---
const mx_channel = new MessageChannel();
const mx_rsc = new RemoteSerialportClient("", {
    transport_client: new NodeIpcClient(mx_channel.port2, "/")
});
const mux = mx_rsc.mux();
mux.open("/dev/ttyACM0", { path: "/dev/ttyACM0", baudRate: 115200 });
const mx_stream = mux.create_port("/dev/ttyACM0", "/dev/ttyV1").get_port({ baudRate: 115200, autoOpen: true });
mx_stream.on("data", (d) => console.log("from device:", d));
mx_stream.write(Buffer.from("hello"));
```

When `transport_client` is provided, the `server_host` argument is ignored. IPC differences from
socket.io:

| Behavior | socket.io | Node IPC |
|---|---|---|
| Reconnect | auto-reconnect; RPC replay survives drops | no reconnect — port pair is single-shot |
| Wire backpressure | sampled via `bufferedAmount` | reported as `null`; skipped |
| Endpoint multiplexing | one per `connect(label)` / `mux(label)` | single endpoint per IPC pair; **use mux mode** |
| Connection model | many clients → server | one peer pair |

#### Raw TCP / Unix Domain Socket / Named Pipe (`RawTcpClient`)

A length-prefix-framed JSON envelope transport over `net.Socket` (mirror of the server-side
`RawTcpServer`). Same `mode` selector, same TCP vs UDS / Pipe choice via `host+port` vs `path`.

```javascript
const { RemoteSerialportClient, RawTcpClient } = require("node-serialport-client");

// Plain TCP, mux mode (default)
new RemoteSerialportClient("", {
    transport_client: new RawTcpClient({ host: "localhost", port: 17993 })
});

// TLS over TCP (self-signed cert? pass `{rejectUnauthorized:false}` or the CA you generated)
new RawTcpClient({ host: "remote", port: 17994 }, {
    tls: { ca: ca_cert, servername: "remote" }   // production
});
new RawTcpClient({ host: "localhost", port: 17994 }, {
    tls: { rejectUnauthorized: false }            // local dev with self-signed cert
});

// 1-to-1 (one connection per namespace)
new RawTcpClient({ host: "localhost", port: 17995 }, { mode: "single-namespace" });

// UDS / Named Pipe
new RawTcpClient({ path: "/tmp/rsp.sock" });
new RawTcpClient({ path: "\\\\.\\pipe\\rsp" });
```

`RawTcpClientOptions`:

| Option | Default | What it does |
|---|---|---|
| `mode` | `"mux"` | Must match the server's mode (otherwise the hello envelope doesn't route as expected). |
| `tls` | — | `tls.ConnectionOptions`. Pass `{}` to enable TLS with system CA + verify; pass `{ ca, servername }` for a private CA; `{ rejectUnauthorized: false }` for local self-signed cert. Ignored for `path:` targets. |
| `keep_alive` | `true` (30 s) | TCP keepalive. |
| `auth` | — | Credential forwarded in the `hello` envelope to `auth_validator`. |
| `logger` | default | Inject your `Logger`. |

For full transport behaviour matrix (reconnect / backpressure / TLS / etc.) see the
[server README](../remote-serialport-server/README.md#raw-tcp--unix-domain-socket--named-pipe-rawtcpserver).

#### Raw WebSocket (`RawWebSocketClient`)

WebSocket-based transport using the `ws` library. Mirror of the server-side `RawWebSocketServer`.
Same `mode` selector; URL form for connect target. `ws://` for plain, `wss://` for TLS.

```javascript
const { RemoteSerialportClient, RawWebSocketClient } = require("node-serialport-client");

// Plain ws, mux mode (default)
new RemoteSerialportClient("", {
    transport_client: new RawWebSocketClient({ url: "ws://localhost:17996" })
});

// TLS (wss)
new RawWebSocketClient({ url: "wss://remote:17997" }, {
    tls: { ca: ca_cert, servername: "remote" }    // production private CA
});
new RawWebSocketClient({ url: "wss://localhost:17997" }, {
    tls: { rejectUnauthorized: false }            // local dev self-signed
});

// 1-to-1
new RawWebSocketClient({ url: "ws://localhost:17998" }, { mode: "single-namespace" });
```

`RawWebSocketClientOptions`:

| Option | Default | What it does |
|---|---|---|
| `mode` | `"mux"` | Must match the server's mode. |
| `tls` | — | Forwarded to the `ws` constructor's options object — supports `ca`, `cert`, `key`, `passphrase`, `rejectUnauthorized`, `servername`, etc. Only effective when `url` is `wss://`. |
| `auth` | — | Credential forwarded in the `hello` envelope. |
| `logger` | default | Inject your `Logger`. |

Compared to socket.io, `RawWebSocketClient` skips Engine.IO's polling fallback and gives slightly higher binary throughput (~44 MB/s localhost vs socket.io's ~18 MB/s on the same hardware). Use socket.io when you need Engine.IO's reconnect / auto-fallback semantics; use Raw WebSocket when you want a tighter TCP-only path.

#### HTTP/2 (`Http2Client`)

Uses Node's built-in `node:http2`. Each `open(label)` opens a new HTTP/2 stream with `:path: label`
within a single shared session, taking advantage of per-stream flow control (no head-of-line
blocking between namespaces).

```javascript
const { RemoteSerialportClient, Http2Client } = require("node-serialport-client");

// h2 over TLS
new RemoteSerialportClient("", {
    transport_client: new Http2Client(
        { url: "https://remote:17996" },
        { tls: { ca: ca_cert, servername: "remote" } }
    )
});

// h2c cleartext (trusted internal networks)
new Http2Client({ url: "http://localhost:17997" });
```

`Http2ClientOptions`:

| Option | Default | What it does |
|---|---|---|
| `tls` | — | `http2.SecureClientSessionOptions` forwarded to `http2.connect`. Use for self-signed dev (`{ rejectUnauthorized: false }`) or production private CA (`{ ca, servername }`). Only effective for `https://` URLs. |
| `h2_options` | — | Extra h2 session options (settings, peer max concurrent streams, etc.). |
| `auth` | — | Credential forwarded in the per-stream `hello` envelope. |
| `logger` | default | Inject your `Logger`. |

HTTP/2 gives the best p99 latency (1.48 ms locally) thanks to per-stream flow control; throughput is between Raw TCP and socket.io (~17 MB/s).

#### MQTT broker pattern (`MqttRsClient`)

Talks to an MQTT broker; publishes on per-client/per-namespace c2s topics and subscribes to the
matching s2c topics. Mirror of `MqttServer`. Exported as `MqttRsClient` (the `mqtt` library
already exports a class named `MqttClient`, so we use the `Rs` prefix to avoid a collision).

```javascript
const { RemoteSerialportClient, MqttRsClient } = require("node-serialport-client");

new RemoteSerialportClient("", {
    transport_client: new MqttRsClient({
        broker_url: "mqtt://broker.internal:1883",
        topic_prefix: "rsp",
        qos: 1,
        auth: { token: "..." },
        mqtt_options: { username: "u", password: "p" }
    })
});
```

`MqttClientOptions`:

| Option | Default | What it does |
|---|---|---|
| `broker_url` | (required) | Same URL as the server side. |
| `topic_prefix` | `"rsp"` | Must match the server's prefix. |
| `client_id` | random UUID | Used in the MQTT clientId and in the c2s/s2c topic path. |
| `qos` | `1` | MQTT QoS. Use 1 or 2; never 0 for serial streams. |
| `mqtt_options` | — | Forwarded to `mqtt.connect`. |
| `auth` | — | Credential forwarded in the `hello` envelope. |
| `logger` | default | Inject your `Logger`. |

The MQTT pattern fits "decoupled deployment" scenarios where server and clients only know the
broker's address and the broker can survive network blips on either side. Don't use it when you
need the lowest possible latency — at-source-broker round-trips push p99 well above the direct
transports.

**Graceful disconnect**: `rsc.disconnect()` (and `MqttRsClient.close()`) publishes a `bye`
envelope on each open `<prefix>/c2s/<client_id>/<label>` topic before ending the broker
connection (with a 1 s graceful-end + force-end fallback). The server clears its per-(client,
label) transport state immediately on receipt instead of waiting for the keepalive to expire,
so shared-mode writer-promotion (`pipe` mode) re-fires the moment the writer leaves rather
than ~60 s later.

> **⚠ QoS 1 retransmits and write-critical workloads.** MQTT QoS 1 is "at-least-once":
> under packet loss, the broker may redeliver the same PUBLISH and the receiver acks each
> copy. **This library does NOT deduplicate retransmitted messages at the application
> layer** — if the network drops a PUBACK and the broker resends, a `serialport_send_packet`
> envelope can reach the device's port **twice**, writing the same Modbus PDU / RS-485
> command twice. For write-idempotent workloads (status polling, log streaming) this is
> usually fine. For write-critical workloads (commanding actuators, Modbus function-code
> 5/6/15/16) one of the following is required:
>
> - Set `qos: 2` (exactly-once; broker uses 4-step handshake — higher latency, no
>   duplicates).
> - Use a different transport (Raw TCP / Raw WS / HTTP/2) where the underlying TCP stream
>   gives in-order non-duplicated delivery.
> - Dedup at the app layer by stamping each command with a sequence number.
>
> **MQTT KeepAlive defaults to ~60 s** in the `mqtt` lib: a dead server is not detected on
> the client side until KeepAlive expires. Tune via `mqtt_options.keepalive` if you need
> faster failure detection.

#### gRPC (`GrpcClient`)

Wraps `@grpc/grpc-js`. Each `open(label)` opens a new bi-directional `Channel` streaming RPC
with metadata `rsp-label: <label>` and (optionally) `rsp-auth: <JSON>`. Mirror of `GrpcServer`.

```javascript
const { RemoteSerialportClient, GrpcClient } = require("node-serialport-client");
const grpc = require("@grpc/grpc-js");

// Insecure
new RemoteSerialportClient("", {
    transport_client: new GrpcClient({ address: "localhost:17996" })
});

// TLS
const tls_creds = grpc.credentials.createSsl(fs.readFileSync("ca.crt"));
new GrpcClient(
    { address: "remote:17997" },
    {
        credentials: tls_creds,
        channel_options: { "grpc.ssl_target_name_override": "remote" }
    }
);
```

`GrpcClientOptions`:

| Option | Default | What it does |
|---|---|---|
| `credentials` | `grpc.credentials.createInsecure()` | Standard `ChannelCredentials`. |
| `channel_options` | — | Per-channel options (`grpc.ssl_target_name_override`, `grpc.max_receive_message_length`, etc.). |
| `auth` | — | Sent as `rsp-auth` metadata (JSON-encoded) on every stream open. |
| `logger` | default | Inject your `Logger`. |

The `.proto` is shipped in the client package under `proto/remote-serialport.proto` and loaded
on first `open()`.

#### WebRTC DataChannel (`WebRtcClient`) — experimental

True P2P transport. Each `open(label)` creates a new DataChannel on the peer connection.
Bring-your-own signaling. Mirror of `WebRtcServer`.

```javascript
const { RemoteSerialportClient, WebRtcClient } = require("node-serialport-client");

const signaling = {
    on_message(handler) { /* receive offers/answers/candidates from server side */ },
    send(msg) { /* forward to server */ }
};

new RemoteSerialportClient("", {
    transport_client: new WebRtcClient({
        signaling,
        ice_servers: ["stun:stun.l.google.com:19302"]
    })
});
```

`WebRtcClientOptions`:

| Option | Default | What it does |
|---|---|---|
| `signaling` | (required) | `WebRtcSignalingChannel` adapter; see server README for shape. |
| `ice_servers` | `["stun:stun.l.google.com:19302"]` | String array; node-datachannel doesn't take W3C objects. |
| `peer_id` | random UUID | Stable id for this peer, carried in every signaling message. |
| `logger` | default | Inject your `Logger`. |

The library bundles `node-datachannel` (native dep, libdatachannel + libsrtp + libjuice). The
walkthrough's [webrtc-smoke.js](../note/walkthrough/webrtc-smoke.js) uses an in-process
EventEmitter for signaling so you can try it without a real signaling server.

## Protocol (v2)

`serialport_handshake` (S→C) announces the protocol version on connect; the client checks
compatibility.

| Direction | Namespace mode | Mux mode (payload carries `path`) |
|---|---|---|
| S→C | `serialport_handshake` `{protocolVersion}` | `serialport_handshake` |
| C→S | `serialport_open` `{path, options}` | `serialport_mux_open` `{path, options}` |
| S→C | `serialport_state` `{state, message?}` | `serialport_mux_state` `{path, state, message?}` |
| S→C | `serialport_packet` (raw bytes) | `serialport_mux_packet` `{path, data}` |
| C→S | `serialport_send_packet` (raw bytes) | `serialport_mux_send_packet` `{path, data}` |
| S→C | `serialport_drain` (backpressure ack) | `serialport_mux_drain` `{path}` |
| C→S | `serialport_close` | `serialport_mux_close` `{path}` |
| C→S RPC | `serialport_set` `{options}` / `serialport_update` `{options}` / `serialport_flush` | `serialport_mux_set` / `_update` / `_flush` `{path, …}` |
| C→S RPC (ack) | `serialport_get` → `{cts,dsr,dcd}` · `serialport_list` → `PortInfo[]` | `serialport_mux_get` `{path}` → status · `serialport_list` (shared) |
| C→S Txn | `serialport_send_begin/_chunk/_end/_abort` `{txn_id, …}` | `serialport_mux_send_begin/_chunk/_end/_abort` `{path, txn_id, …}` |

`RemoteSerialPortState`: `idle → opening → open → closing → closed`, plus `error`.

**Backpressure (client → device):** the client uses a write window; each `serialport_send_packet`
(or `serialport_send_end`) consumes a slot and each `serialport_drain` from the server frees one.
When the window fills, `port.write(...)` returns `false` and the stream emits `'drain'` once it
clears.

**Backpressure (device → client):** when `socket.pipe()` is forwarding, the server samples the
underlying transport's buffered byte count after each emit and `pause()`s the physical port if it
crosses 1 MB; resumes once below 256 KB. Only in `multi_access: 'reject'` mode (see above).

## Features

- [x] Transport abstraction (`AbsTransport`) — swap socket.io for IPC or future transports
  - [x] WebSocket transport (socket.io)
    - [x] Namespace mode (one namespace per remote port)
    - [x] Mux mode (many remote ports per connection, dynamic addressing)
  - [x] Node IPC transport (worker_threads / Electron utility process; mux-only)
- [x] Read from serial port (device → client)
- [x] Write to serial port (client → device)
- [x] Port lifecycle state machine + `serialport_state`
- [x] Backpressure both directions (write window + device pause/resume)
- [x] Injectable physical-port factory (testable without hardware)
- [x] Remote port control RPCs (`set` / `get` / `update` / `flush`) and `list_ports`
- [x] Multiple-server registry (`RemoteSerialportServerManager`)
- [x] Remote `error` / `close` re-emitted on the local virtual stream
- [x] Multi-chunk atomic transactions (`txn()` / `with_txn()`) with timeout
- [x] Injectable `Logger` interface (pino / winston / etc.)
- [x] Auto-reconnect: client replays opens + in-flight RPCs after transport drop (socket.io only)
- [x] Multi-client access policy (`multi_access: 'shared'` with `fifo` / `fifo-strict` / `batch` / `pipe` scheduling)
- [x] **COW shared modes** (`cow-write-isolate` / `cow-snapshot` / `cow-virtual-port`)
- [x] **Authentication credential** (`new RemoteSerialportClient(host, { auth: ... })`; forwarded as socket.io `Manager({auth})` or IPC `hello` envelope; replayed on reconnect)
- [ ] Encryption: delegated to transport (TLS for socket.io, OS sandbox for IPC)

## Known limitations

- **Per-port `MockBinding` cleanup** (test mode only): `@serialport/binding-mock`'s registry
  (`MockBinding.serialPorts`) has no `removePort()` API. `port_instance.close()` releases the lock
  and stream, but the path entry persists in the process-wide registry until `MockBinding.reset()`
  (which `rsc.disconnect()` with no argument calls). In long-running test processes that create
  many ports under different paths, expect the registry to grow until a full `disconnect()`.
- **Per-txn success/failure ack**: client `tx.end()` resolves on the `serialport_drain` ack. If the
  server times out the txn before `_end` arrives, the eventual `_end` still gets an "unknown txn"
  ack from the server, so `tx.end()` resolves silently as success even though the bytes never
  reached the device. The server's logger (and `txn_timeout_action: 'state'`/`'both'`) is the way
  to detect this server-side.
- **IPC transport is single-endpoint**: one `MessagePort` pair represents one server connection,
  so `connect(label)` / `mux(label)` both return the same single transport regardless of label.
  Use **mux mode** for many remote ports over one IPC pair.

<a id="中文"></a>

## 中文

> **⚠ Node.js 限定。** 用了 Node 的 `Buffer`、`worker_threads`、`node:http2`、native `serialport` binding 等 Node 專屬 API。**瀏覽器跑不起來** — 用 webpack / Vite / Rollup 打包會在 `Buffer`/`stream`/`net` import 直接炸。要做瀏覽器前端，請自己寫一層薄薄的 app-layer adapter（搭配你自己的 WebSocket / WebRTC）把 bytes 轉過去 — 不要試圖直接 bundle 這個 package 進 browser。

把主機的實體序列埠透過網路代理出去：**server** 守住真實的序列埠；**client** 連上來，拿到一個本地 *虛擬* 序列埠（用 mock-binding 撐起來的 `SerialPortStream`）對應某個遠端埠。對虛擬埠的讀寫會轉發到實體埠，反之亦然 — 既有的 Node serialport 生態（`serialport`、`modbus-serial` …）幾乎零修改就能跨網路使用。

專案拆三個 package：

| Package | npm | 角色 |
|---|---|---|
| [`remote-serialport-types`](https://github.com/teddy1565/remote-serialport-types) | `remote-serialport-types` | 共用型別 + abstract 介面（被另兩個 repo 以 git submodule 內嵌引用）。 |
| [`remote-serialport-server`](https://github.com/teddy1565/remote-serialport-server) | `node-serialport-server` | 守實體序列埠；透過 socket.io 對外。 |
| [`remote-serialport-client`](https://github.com/teddy1565/remote-serialport-client) | `node-serialport-client` | 連 server；把遠端埠暴露成本地虛擬埠。 |

> **從原始碼開發？** `types` package 以 submodule 內嵌在 `src/types/remote-serialport-types`。`git submodule update --init` 後**也要進那個目錄跑一次 `npm install`**（它有自己的依賴），`tsc` 才能解析所有型別。

### 使用場景 — 什麼時候會需要它？

要解決的核心問題：**想跟序列裝置溝通的「程式」，跟裝置實際插著的「機器」，不是同一台** — 或不是同一個 process、不是同一個 container。如果裝置跟程式在同一個 process，你不需要這個 library，直接用 `serialport` 就好。下面任一條成立時才用 `remote-serialport`：

| 場景 | 這個 library 怎麼幫上忙 |
|---|---|
| **遠端工控 / 實驗室設備。** PLC、Modbus 電錶、RS-485 sensor bus、桌上型儀器在工廠現場或實驗室機架；你的控制 / 監測程式跑在伺服器、開發筆電或雲端 VM。 | 在接著設備的小主機上跑 `remote-serialport-server`。既有的 `modbus-serial` / `serialport` 程式碼放哪都行，指向一個*虛擬*埠 — 幾乎零修改。 |
| **容器化 / Kubernetes 應用。** Container 沒有 privileged device passthrough 就看不到 host 的 `/dev/ttyUSB0`。 | server 跑在 host（或一個 privileged sidecar）；讓非特權的 app container 走網路連進來。不用 `--device`、不用 `--privileged`。 |
| **多人共用一台儀器。** 多個工程師 — 或多個服務 — 要同時用同一條 RS-485 線。 | `multi_access: 'shared'` 對單一實體埠 refcount，讀方向 fanout 給每個 client，`shared_mode` 政策表決定寫方向的仲裁（FIFO、單一 writer、COW snapshot…）。 |
| **硬體在環 (HIL) CI / 測試農場。** 待測裝置在測試機架；CI runner 在別處或是用完即丟。 | server 守著埠；每個 CI job 連上、跑、斷開。或注入 mock 撐起來的 `serialport_factory`，完全沒硬體也能跑*同一套*測試。 |
| **Electron / 多 process 桌面應用。** native `serialport` binding 不該載進 renderer process。 | 把 `serialport` 留在 utility process 或 worker；app 其它部分透過 **IPC transport**（`NodeIpcClient` 跑在 `MessagePort` 上）跟它講話。同一套 API、沒有網路跳轉。 |
| **IoT 閘道 / 裝置 mesh。** 邊緣閘道彙整多個序列裝置；雲端服務動態定址，且兩邊都沒有固定位址。 | 用 **mux mode**（一條連線、埠由 payload 內的 `path` 定址）和／或 **MQTT transport**，這樣雙方只需要知道 broker。 |

> **不支援瀏覽器。** 這是 Node.js library（見最上方警告）。要做瀏覽器前端，請把 `remote-serialport` 放在 Node 後端，再對瀏覽器暴露你自己的 app-layer API。

### 快速開始 — 完整 echo 範例

一組最小的端到端範例。**server** 跑在有序列硬體的機器上；**client** 放在任何連得到它的地方。

**`server.js`** — 在實體插著 `/dev/ttyUSB0` 的 host 上：

```javascript
const { RemoteSerialportServer } = require("node-serialport-server");

const server = new RemoteSerialportServer(
  { cors: { origin: "*" } }, // socket.io ServerOptions
  17991                      // 監聽埠
);
server.listen();

server.of().on("connection", (socket) => {
  // 寫方向（client -> device）會自動接好。
  socket.pipe(); // forward 讀方向（device -> client）

  socket.port.on("data", (chunk) =>
    console.log(`device 送來 ${chunk.length} bytes`));
  console.log("client 已連上，proxy 中：", socket.port.path);
});

console.log("remote-serialport server 監聽於 :17991");
```

**`client.js`** — 任何另一台機器（IP 換成 server 的）：

```javascript
const { RemoteSerialportClient } = require("node-serialport-client");
const { ReadlineParser } = require("serialport");

const rsc = new RemoteSerialportClient("ws://192.168.1.50:17991");

// 第 1 個參數 = socket.io namespace；options.path = 遠端真實序列埠路徑。
const conn = rsc.connect("/dev/ttyUSB0", {
  path: "/dev/ttyUSB0",
  baudRate: 115200,
});

// 把遠端埠對應到一個「本地」虛擬埠路徑；拿到 SerialPortStream。
const port = conn
  .create_port("/dev/ttyV0")
  .get_port({ baudRate: 115200, autoOpen: true });

// 讀：device -> 這裡
port.pipe(new ReadlineParser({ delimiter: "\r\n" }))
    .on("data", (line) => console.log("device 來的一行：", line));

// 寫：這裡 -> device（轉發到實體埠）
port.on("open", () => port.write("PING\r\n"));

port.on("error", (err) => console.error("port error:", err.message));

// 結束時：rsc.disconnect();
```

`port` 就是個普通的 `SerialPortStream` — 任何已經吃 serialport instance 的 library（`modbus-serial`、`@serialport/parser-*`…）原封不動就能用。本 README 後面逐項深入各功能；server 側細節同樣深度請見 [server README](../remote-serialport-server/README.md)。

### 兩種模式

- **Namespace mode** — 一個 socket.io namespace = 一個遠端序列埠。`client.connect("/dev/ttyUSB0", …)`。simple、socket.io 慣用；多個 `connect()` 共用同一條傳輸通道（socket.io namespace 多工），所以單一連線仍可承載多埠。
- **Mux mode** — 一條 mux namespace 上的連線可承載任意多個遠端埠，由訊息 payload 內的 `path` 動態定址。給「不想 namespace 一對一」的場景（IoT mesh、動態定址）。`client.mux("/site-A").open("/dev/ttyUSB0", …)`。

兩種模式 wire format 結構相同；差別只是「socket 本身就是 routing key（namespace mode，payload 是裸 bytes）」還是「每個 payload 帶 `path`（mux mode）」。

### 安裝

```bash
npm install node-serialport-server   # server
npm install node-serialport-client   # client
```

### Client 用法

#### Namespace mode — 自動 open

`new RemoteSerialportClient(host, options).connect(namespace, open_options)` 一行接上。連線完成（handshake 後）自動發 `serialport_open`。詳細 code 請看 [Client § Namespace mode — auto open](#namespace-mode--auto-open) 英文段。

`RemoteSerialportClientOptions` 重點：

| 選項 | 預設 | 說明 |
|---|---|---|
| `serialport_check_regexp` | `/^(\/dev\/tty(USB\|AMA\|ACM)\|\/COM)[0-9]+$/` | validate `connect(namespace)` 的 namespace 字串。 |
| `logger` | warn/error → console、debug/info 靜默 | 注入自定義 `Logger`。 |
| `rpc.timeout_ms` | `5000` | `get_remote_status` / `list_ports` 等 RPC timeout（wall-clock，不重置）。 |
| `rpc.replay_on_reconnect` | `true` | reconnect 時是否 replay in-flight RPC；`false` 則 disconnect 立即 reject 全部 pending。 |
| `txn_id_allocator` | `'counter'` | `'counter'`（per-socket 遞增）/ `'uuid'`（每筆 UUID）/ 自訂函式。 |
| `auth` | — | 認證 credential；socket.io 走 `Manager.socket(label, { auth })`，IPC 走 `hello` envelope。重連自動 replay。 |
| `transport_client` | `new SocketIoClient(host, ...)` | 注入自訂 transport（例如 `NodeIpcClient`）。 |
| `manager_options` | — | 直接 forward 到 socket.io `Manager(uri, opts)` 的 options。`wss://` TLS 設定（`{ rejectUnauthorized: false, ca: ca_cert }`）、強制 transport（`{ transports: ["websocket"] }`）、reconnect cadence 等都從這裡進去。只有預設 socket.io transport 會用到。 |

##### `wss://` 用法

```javascript
const rsc = new RemoteSerialportClient("wss://your-host:17991", {
  manager_options: {
    transports: ["websocket"],
    rejectUnauthorized: false,        // dev only；production 用 `ca: production_ca`
    ca: my_ca_pem,                    // 私 CA chain（production）
  }
});
```

Server 端要把自己的 `srv.io` 接到 `https.Server` — 見 [server README 的 TLS section](../remote-serialport-server/README.md#encryption--tls)。

#### Namespace mode — 手動 open

不傳 `open_options`：先 `connect(namespace)` 拿 socket，之後再 `socket.open(open_options)`。

#### 與 `modbus-serial` 整合

`create_port(local_path)` 後 `get_port({ baudRate, autoOpen: true })` 拿到的 stream 結構上是個正常 `SerialPortStream`。其它套件（如 `modbus-serial`）直接吃這個 stream 不用改 code。

#### Mux mode

`rsc.mux().open(remote_path, options)` → `rsc.mux().create_port(remote_path, local_path)` 拿到本地虛擬埠。

#### Remote port 控制 / 探索（RPC）

- `set_remote(SetOptions)`、`update_remote(UpdateOptions)`、`flush_remote()` — fire-and-forget
- `get_remote_status()` → `Promise<PortStatus>`、`list_ports()` → `Promise<PortInfo[]>` — 走 socket.io ack 包成 Promise

#### Disconnect

`rsc.disconnect(namespace)` 斷單條；`rsc.disconnect()` 全斷並 reset MockBinding registry。

### 多 chunk transactions（txn）

```javascript
const tx = portInstance.txn();
tx.write(Buffer.from("HEAD_"));
tx.write(Buffer.from("BODY_"));
tx.write(Buffer.from("TAIL"));
await tx.end();   // 在 server 端被當成 ONE atomic write 到 device
// 或：tx.abort() — server drop 全部 buffered chunks
```

便利包裝 `portInstance.with_txn(async (handle) => { … })`：自動 `end()`，throw 時自動 `abort()`。

語意：
- `_begin` → 0..N 個 `_chunk` → `_end`（送 device）或 `_abort`（drop）
- 只有 `_end` 跟單發 `serialport_send_packet` 消耗背壓窗口
- Server-side timeout（每 chunk reset）：drop buffered chunks（行為由 `txn_timeout_action` 決定）
- **在 `with_txn(async (tx) => …)` callback 內呼叫 `tx.abort()`**：wrapper 的隱式 `_end` 會看到 handle 已 abort 然後 reject promise（訊息 `"txn N was aborted"`）。Rollback 確實發生了（bytes 沒送到 device），但 `with_txn` 自己會 throw。要 explicit abort 又不想 throw，就用底層 `portInstance.txn()` handle 直接呼叫 `tx.abort()`（在 `with_txn` wrapper 外），如上面第一個範例。

### Logger

```typescript
interface Logger {
    debug(message: string, ...meta: unknown[]): void;
    info(message: string, ...meta: unknown[]): void;
    warn(message: string, ...meta: unknown[]): void;
    error(message: string, ...meta: unknown[]): void;
}
```

預設：warn/error → `console`，debug/info 靜默。可注入 pino / winston / bunyan，或寫個 prefix wrapper。

### Reconnect 行為（僅 socket.io transport）

- Transport 斷線：socket.io 自動重連（指數退避）
- 重連完成、handshake 後：client 重發所有 `_active_opens` 的 `serialport_mux_open` / 重新自動 `serialport_open`
- In-flight RPC：option `rpc.replay_on_reconnect`（預設 `true`）— `connect` 事件 fire 時把 `_pending_rpcs` 全部用同一個 ack callback 重發；timeout 是從第一次呼叫起算的 wall-clock（不重置）。若 `false` → `disconnect` 事件當下直接 reject 全部 pending
- IPC transport：無 reconnect。`on_lifecycle("reconnect")` 永不 fire

**Server 崩潰 / 連線被硬切時的本地行為**：底層 transport `disconnect` lifecycle 觸發後 **500 ms 內**沒有 `reconnect`，client 會把 loss 推到每個 open 的本地虛擬 stream：

```javascript
port.on("error", (e) => { /* e.message === "transport disconnected" */ });
port.on("close", () => { /* 緊接著 error 觸發 */ });
```

socket.io 的自動重連在 grace 內完成時 timer 會 cancel，本地 stream 看不到任何事件 — 短暫斷線對 app 是透明的。單發類 transport（Raw TCP / Raw WS / HTTP/2 / gRPC）幾乎一定就是「永久斷」所以 error+close 會 fire。MQTT 因為走 broker，server 真正掉線要等 broker keepalive 過期（預設 ~60 s）— 想要更快偵測請調 `mqtt_options.keepalive`。

**注意 — `conn.state` vs 本地 stream 的 `'open'` 事件**：`conn.state` 反映**遠端**物理埠的狀態（由 server 推送的 `serialport_state` 驅動）。本地虛擬 `SerialPortStream` 的 `'open'` 事件在 MockBinding open 完成的當下就 fire，那發生在 `conn.state` 轉成 `"open"` **之前**。如果要 gate「真的能寫了沒」在遠端埠就緒，請聽 `port_instance.on("data", …)` 確認 fanout live，或 poll/watch `conn.state`（v2 沒有暴露 state-changed listener — 用本地 stream 的 `'error'` / `'close'` 事件 + `conn.state` snapshot 來追）。

### Wire backpressure（device→client，僅參考；server 端控制）

`socket.pipe()` forward 物理 bytes 比 client drain 還快時，server 採樣底層 socket.io transport 的 `bufferedAmount`；超過 `WIRE_BACKPRESSURE_HIGH_WATER`（1 MB）就 `pause()` 物理埠；低於 `WIRE_BACKPRESSURE_LOW_WATER`（256 KB）就 `resume()`。只在 `multi_access: 'reject'` 模式生效（shared 模式 pause/resume 會餓死其它 subscriber）。IPC transport 的 `get_buffered_amount()` 回 `null`，跳過 wire backpressure。詳細請看 [server README 中文段 Wire backpressure](../remote-serialport-server/README.md#wire-backpressuredeviceclient)。

### Shared mode（`multi_access: 'shared'`）

由 server 控制 — client 無需特別設定，只要兩個以上 client 連到同一條 path 就生效。client 看到的差別是讀方向有 fanout、寫方向可能被 server-side scheduling 影響（per-mode 行為詳見 server README 中文段「Shared mode」表）。

### 認證（client 側）

```javascript
const rsc = new RemoteSerialportClient("ws://example:17991", {
  auth: { token: my_jwt }  // opaque；server-side `auth_validator` 自行解讀
});
```

預設 socket.io transport：`auth` 落在 `Manager.socket(label, { auth })`，**每次重連自動 replay**，server 端 `auth_validator` 每次都重跑。IPC 場景請自己 `new NodeIpcClient(port, label, credential)` 然後 `transport_client: ...` 注入。

> **注意 — top-level `auth` 只對預設的 socket.io 有效**。如果注入了自己的 `transport_client`（Raw TCP / Raw WebSocket / HTTP/2 / MQTT / gRPC），top-level `auth` 會**靜默被丟棄** — credential 請傳進 transport 自己的 ctor options：
>
> ```javascript
> new RemoteSerialportClient("", { transport_client: new RawTcpClient({host, port}, { auth: cred }) });
> new RemoteSerialportClient("", { transport_client: new MqttRsClient({broker_url, auth: cred }) });
> new RemoteSerialportClient("", { transport_client: new Http2Client({url}, { auth: cred }) });
> ```
>
> 如果不小心 top-level `auth` 跟 user-supplied `transport_client` 同時給，library 會在 constructor 時 log `warn` 提示你怎麼修。WebRTC 設計上沒帶 app-level auth — 認證請放 signaling 那層。

Server 拒絕 auth 時：連線關閉、handshake 永遠不會收到 — 本地表現是「虛擬 stream 永遠到不了 `open` 狀態」（停在 `idle`）。server 那邊的 logger 跟 `serialport_state: ERROR` payload 才有拒絕原因。

### Transports（`AbsTransport`）

預設 transport 是 socket.io-client；另一個內建是 **Node IPC**（`worker_threads.MessagePort` / Electron utility process `MessagePort`）。透過 ctor option `transport_client` 注入切換。

#### 怎麼選 transport

所有 transport 講同一套協定 — 按「部署形狀」選，不是按功能選。快速指引：

| Transport | Class | 什麼時候用 | 注意 |
|---|---|---|---|
| **socket.io**（預設） | — | 要自動重連、RPC replay、Engine.IO polling fallback。任何走真實網路的場景的安全預設。 | raw throughput 略低（localhost 實測 ~18 MB/s）。 |
| **Node IPC** | `NodeIpcClient` | server 跟 client 是*同一台主機上的不同 process* — Electron utility process、`worker_threads`。完全不走網路。 | 一個 `MessagePort` pair 只有單一 endpoint → 用 mux mode。不重連。 |
| **Raw TCP / UDS / Pipe** | `RawTcpClient` | 信任的 LAN、要最薄的路徑；或同主機的 Unix socket / named pipe。 | single-shot — 不自動重連。 |
| **Raw WebSocket** | `RawWebSocketClient` | 要 WebSocket 語意但不要 Engine.IO 的額外開銷。WS throughput 最高（localhost ~44 MB/s）。 | single-shot — 不自動重連 / fallback。 |
| **HTTP/2** | `Http2Client` | 一條連線承載多埠且在意尾端延遲 — per-stream flow control、無 HOL blocking。p99 最佳（localhost ~1.5 ms）。 | — |
| **MQTT** | `MqttRsClient` | 解耦部署：server 跟 client 只認得 broker 位址（兩邊都在 NAT 後、連線時斷時續）。 | 延遲最差；QoS-1 重複寫入的雷（見下）。 |
| **gRPC** | `GrpcClient` | 你的基礎設施本來就是 gRPC（service mesh、既有 `.proto` 工具鏈）。 | — |
| **WebRTC** | `WebRtcClient` | 真 P2P + NAT 穿透，data path 上沒有 server。 | experimental；signaling 自己準備。 |

下面各小節給每種 transport 一個可跑的範例與完整選項表。

socket.io / IPC 範例：

```javascript
import { MessageChannel } from "worker_threads";
import { RemoteSerialportClient, NodeIpcClient } from "node-serialport-client";

const channel = new MessageChannel();
// 把 channel.port1 送到跑 server 的 host process / utility；這邊用 port2
const rsc = new RemoteSerialportClient("", {
    transport_client: new NodeIpcClient(channel.port2, "/")
});
const mux = rsc.mux();
mux.open("/dev/ttyACM0", { path: "/dev/ttyACM0", baudRate: 115200 });
const stream = mux.create_port("/dev/ttyACM0", "/dev/ttyV0").get_port({ baudRate: 115200, autoOpen: true });
```

注入 `transport_client` 時 `server_host` 參數會被忽略。IPC 跟 socket.io 的差異：

| 行為 | socket.io | Node IPC |
|---|---|---|
| Reconnect | 自動重連 + RPC replay | 不重連 — port pair 是 single-shot |
| Wire backpressure | 採樣 `bufferedAmount` | 回 `null`，跳過 |
| Endpoint 多工 | 每 `connect(label)` / `mux(label)` 一個 | 單 endpoint per IPC pair；**用 mux mode** |
| Connection model | 多 client → server | 1-to-1 process pair |

#### Raw TCP / Unix Domain Socket / Named Pipe（`RawTcpClient`）

長度前綴 framing + JSON envelope，跑在 `net.Socket` 上（server 端 `RawTcpServer` 的對應）。同樣的 `mode` 選項，同樣用 `host+port` 或 `path` 區分 TCP / UDS / Named Pipe。

```javascript
const { RemoteSerialportClient, RawTcpClient } = require("node-serialport-client");

// Plain TCP，mux 模式（預設）
new RemoteSerialportClient("", {
    transport_client: new RawTcpClient({ host: "localhost", port: 17993 })
});

// TLS over TCP（自簽 cert 開發用 rejectUnauthorized:false；production 傳 ca + servername）
new RawTcpClient({ host: "remote", port: 17994 }, {
    tls: { ca: ca_cert, servername: "remote" }   // production
});
new RawTcpClient({ host: "localhost", port: 17994 }, {
    tls: { rejectUnauthorized: false }            // 本地自簽 cert 開發用
});

// 1-to-1
new RawTcpClient({ host: "localhost", port: 17995 }, { mode: "single-namespace" });

// UDS / Named Pipe
new RawTcpClient({ path: "/tmp/rsp.sock" });
new RawTcpClient({ path: "\\\\.\\pipe\\rsp" });
```

`RawTcpClientOptions`：

| 選項 | 預設 | 說明 |
|---|---|---|
| `mode` | `"mux"` | 必須跟 server 的 mode 一致（不然 hello envelope 路由不到對的 endpoint）。 |
| `tls` | — | `tls.ConnectionOptions`。傳 `{}` 用系統 CA + verify；私有 CA 傳 `{ ca, servername }`；本地自簽用 `{ rejectUnauthorized: false }`。`path:` target 會被忽略。 |
| `keep_alive` | `true`（30 秒） | TCP keepalive。 |
| `auth` | — | hello envelope 帶過去給 server `auth_validator`。 |
| `logger` | 預設 | 注入自訂 `Logger`。 |

完整 transport 行為對照（reconnect / backpressure / TLS / 效能…）看 [server README](../remote-serialport-server/README.md#raw-tcp--unix-domain-socket--named-pipe-rawtcpserver)。

#### Raw WebSocket（`RawWebSocketClient`）

用 `ws` 函式庫的 WebSocket 走線（server 端 `RawWebSocketServer` 的對應）。同 `mode` 選項，連線目標用 URL 形式：`ws://` 不加密、`wss://` TLS。

```javascript
const { RemoteSerialportClient, RawWebSocketClient } = require("node-serialport-client");

// Plain ws，mux 模式（預設）
new RemoteSerialportClient("", {
    transport_client: new RawWebSocketClient({ url: "ws://localhost:17996" })
});

// TLS (wss)
new RawWebSocketClient({ url: "wss://remote:17997" }, {
    tls: { ca: ca_cert, servername: "remote" }    // production 私有 CA
});
new RawWebSocketClient({ url: "wss://localhost:17997" }, {
    tls: { rejectUnauthorized: false }            // 本地自簽 cert 開發用
});

// 1-to-1
new RawWebSocketClient({ url: "ws://localhost:17998" }, { mode: "single-namespace" });
```

`RawWebSocketClientOptions`：

| 選項 | 預設 | 說明 |
|---|---|---|
| `mode` | `"mux"` | 必須跟 server 的 mode 一致。 |
| `tls` | — | 直接轉給 `ws` constructor 的 options object — 支援 `ca` / `cert` / `key` / `passphrase` / `rejectUnauthorized` / `servername` 等。`url` 是 `wss://` 時才有作用。 |
| `auth` | — | hello envelope 帶過去給 server `auth_validator`。 |
| `logger` | 預設 | 注入自訂 `Logger`。 |

跟 socket.io 比，`RawWebSocketClient` 跳過 Engine.IO 的 polling fallback，binary throughput 略高（localhost 實測 ~44 MB/s vs socket.io 同硬體 ~18 MB/s）。要 Engine.IO 的 reconnect / auto-fallback 還是用 socket.io；要薄一點、TCP-only 的就用 Raw WebSocket。

#### HTTP/2（`Http2Client`）

用 Node 內建 `node:http2`。每次 `open(label)` 在共用 session 上開一條 `:path: label` 的 stream，吃 HTTP/2 的 per-stream flow control（namespace 之間沒 HOL blocking）。

```javascript
const { RemoteSerialportClient, Http2Client } = require("node-serialport-client");

// h2 over TLS
new RemoteSerialportClient("", {
    transport_client: new Http2Client(
        { url: "https://remote:17996" },
        { tls: { ca: ca_cert, servername: "remote" } }
    )
});

// h2c cleartext（信任內網）
new Http2Client({ url: "http://localhost:17997" });
```

`Http2ClientOptions`：

| 選項 | 預設 | 說明 |
|---|---|---|
| `tls` | — | `http2.SecureClientSessionOptions`，直接給 `http2.connect`。自簽 dev 用 `{ rejectUnauthorized: false }`；production 私有 CA 用 `{ ca, servername }`。只在 `https://` URL 下生效。 |
| `h2_options` | — | 額外 h2 session 選項（settings、peer max concurrent streams…）。 |
| `auth` | — | 每條 stream 的 `hello` envelope 帶過去給 server `auth_validator`。 |
| `logger` | 預設 | 注入自訂 `Logger`。 |

HTTP/2 在 p99 latency 是內建 transport 裡最好的（localhost 實測 1.48 ms），throughput 在 Raw TCP 跟 socket.io 之間（~17 MB/s）。

#### MQTT broker pattern（`MqttRsClient`）

對 MQTT broker pub-sub；按 client/namespace 在 c2s topic 發、s2c topic 收。`MqttServer` 的對應 client。export 名稱用 `MqttRsClient`（避免跟 `mqtt` 函式庫的 `MqttClient` 撞名）。

```javascript
const { RemoteSerialportClient, MqttRsClient } = require("node-serialport-client");

new RemoteSerialportClient("", {
    transport_client: new MqttRsClient({
        broker_url: "mqtt://broker.internal:1883",
        topic_prefix: "rsp",
        qos: 1,
        auth: { token: "..." },
        mqtt_options: { username: "u", password: "p" }
    })
});
```

`MqttClientOptions`：

| 選項 | 預設 | 說明 |
|---|---|---|
| `broker_url` | （必填） | 跟 server 同一個 URL。 |
| `topic_prefix` | `"rsp"` | 跟 server 的 prefix 一致。 |
| `client_id` | 隨機 UUID | 進 MQTT clientId 跟 c2s/s2c topic path。 |
| `qos` | `1` | 1 或 2；serial stream 絕不能用 0。 |
| `mqtt_options` | — | 直接給 `mqtt.connect`。 |
| `auth` | — | `hello` envelope 帶過去給 server `auth_validator`。 |
| `logger` | 預設 | 注入自訂 `Logger`。 |

MQTT 適合「server / client 雙方都只認 broker」的解耦部署，broker 還能撐住任一邊的網路短斷。但延遲最差（broker round-trip 在 p99 比所有直連 transport 都高），純求速度不要選它。

> **⚠ QoS 1 重送跟「寫關鍵」工作負載**：QoS 1 是「至少送達一次」。掉包時 broker 重送 PUBLISH。**library 不會在 application layer 對重送訊息去重** — PUBACK 路上掉了 broker 重送的話，一個 `serialport_send_packet` envelope 可能會抵達裝置埠**兩次**，把同一個 Modbus PDU / RS-485 command 寫兩次。寫入冪等（狀態輪詢、log streaming）沒差；**寫關鍵**（操作 actuator、Modbus function-code 5/6/15/16）需要：
>
> - 設 `qos: 2`（剛好一次；4-step handshake，延遲較高但不會重複）。
> - 換不同 transport（Raw TCP / Raw WS / HTTP/2），底層 TCP 自帶 in-order 不重複。
> - 在 app 層自己用 sequence number 戳每筆命令去重。
>
> **`mqtt` lib 的 KeepAlive 預設 ~60 秒**：server 真的掛了 client 端要 60 秒才偵測到。`mqtt_options.keepalive` 調短可加快偵測。

#### gRPC（`GrpcClient`）

包 `@grpc/grpc-js`。每次 `open(label)` 開一條 bi-directional `Channel` streaming RPC，metadata 帶 `rsp-label: <label>` 跟（選填）`rsp-auth: <JSON>`。`GrpcServer` 的對應。

```javascript
const { RemoteSerialportClient, GrpcClient } = require("node-serialport-client");
const grpc = require("@grpc/grpc-js");

// Insecure
new RemoteSerialportClient("", {
    transport_client: new GrpcClient({ address: "localhost:17996" })
});

// TLS
const tls_creds = grpc.credentials.createSsl(fs.readFileSync("ca.crt"));
new GrpcClient(
    { address: "remote:17997" },
    {
        credentials: tls_creds,
        channel_options: { "grpc.ssl_target_name_override": "remote" }
    }
);
```

`GrpcClientOptions`：

| 選項 | 預設 | 說明 |
|---|---|---|
| `credentials` | `grpc.credentials.createInsecure()` | 標準 `ChannelCredentials`。 |
| `channel_options` | — | per-channel options（`grpc.ssl_target_name_override`、`grpc.max_receive_message_length` 等）。 |
| `auth` | — | 每次 stream open 時當作 `rsp-auth` metadata（JSON 編碼）送出。 |
| `logger` | 預設 | 注入自訂 `Logger`。 |

`.proto` 隨 client package 出貨，放在 `proto/remote-serialport.proto`，第一次 `open()` 時載入。

#### WebRTC DataChannel（`WebRtcClient`）— experimental

真 P2P transport。每次 `open(label)` 在 peer connection 上開一條新的 DataChannel。Signaling 自己準備。`WebRtcServer` 的對應。

```javascript
const { RemoteSerialportClient, WebRtcClient } = require("node-serialport-client");

const signaling = {
    on_message(handler) { /* 從 server 端收到 offer / answer / candidate */ },
    send(msg) { /* 轉給 server */ }
};

new RemoteSerialportClient("", {
    transport_client: new WebRtcClient({
        signaling,
        ice_servers: ["stun:stun.l.google.com:19302"]
    })
});
```

`WebRtcClientOptions`：

| 選項 | 預設 | 說明 |
|---|---|---|
| `signaling` | （必填） | `WebRtcSignalingChannel` adapter；shape 請看 server README。 |
| `ice_servers` | `["stun:stun.l.google.com:19302"]` | 字串陣列；node-datachannel 不接受 W3C object 格式。 |
| `peer_id` | 隨機 UUID | 本端 peer 的穩定 ID，會帶在每個 signaling 訊息中。 |
| `logger` | 預設 | 注入自訂 `Logger`。 |

library 帶了 `node-datachannel`（native dep，libdatachannel + libsrtp + libjuice）。walkthrough 的 [webrtc-smoke.js](../note/walkthrough/webrtc-smoke.js) 用 in-process EventEmitter 當 signaling，不用真實 signaling server 就能試。

### 協定（v2）

`serialport_handshake`（S→C）連上時宣告協定版本；client 比對相容性。協定版號 **2** 整段 v2 開發（P1-P5）不動。

Channel 表詳見 [Protocol (v2)](#protocol-v2) 英文段。

`RemoteSerialPortState`：`idle → opening → open → closing → closed`、加 `error`。

### 已知限制

- **MockBinding 沒有 removePort**（測試模式）：`@serialport/binding-mock` registry 沒有移除單一 port 的 API。`port_instance.close()` 釋放 lock 跟 stream，但 path 留在 process-wide registry 直到 `MockBinding.reset()`（`rsc.disconnect()` 無參數呼叫會做）。長時間跑、不同 path 一直建的 process 預期 registry 會緩慢增長到一次完整 disconnect。
- **Per-txn 成功/失敗 ack**：client `tx.end()` 在 `serialport_drain` 那刻 resolve。若 server 在 `_end` 抵達前 timeout 該 txn，後來的 `_end` 還是會收到 "unknown txn" 的 ack，所以 `tx.end()` 會「靜默 resolve 成成功」即使 bytes 沒到 device。server log（跟 `txn_timeout_action: 'state'/'both'`）才是 server 端偵測這個情況的方式。
- **IPC transport 是 single-endpoint**：一個 `MessagePort` pair 代表一條 server 連線，所以 `connect(label)` / `mux(label)` 不管 label 都回同一條底層 transport。要承載多埠請用 **mux mode**。

## License

MIT
