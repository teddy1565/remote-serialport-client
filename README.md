# Remote-Serialport

> **Language**: [English](#english) · [中文](#中文)

<a id="english"></a>

## English

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
on every reconnect, so the server's `auth_validator` re-runs after each transport drop. On IPC
construct your own `NodeIpcClient(port, label, credential)` and pass it via `transport_client`.

When the server denies auth, the connection closes without a `serialport_handshake`; locally that
manifests as a stream that never reaches `open` (the local virtual port stays in `idle`). The
server's logger and `serialport_state: ERROR` payload carry the reason.

### Transports (`AbsTransport`)

The default transport is **socket.io-client**; a second built-in transport speaks **Node IPC**
(`worker_threads.MessagePort` / Electron utility process `MessagePort`). Swap by injecting
`transport_client` into the constructor.

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

把主機的實體序列埠透過網路代理出去：**server** 守住真實的序列埠；**client** 連上來，拿到一個本地 *虛擬* 序列埠（用 mock-binding 撐起來的 `SerialPortStream`）對應某個遠端埠。對虛擬埠的讀寫會轉發到實體埠，反之亦然 — 既有的 Node serialport 生態（`serialport`、`modbus-serial` …）幾乎零修改就能跨網路使用。

專案拆三個 package：

| Package | npm | 角色 |
|---|---|---|
| [`remote-serialport-types`](https://github.com/teddy1565/remote-serialport-types) | `remote-serialport-types` | 共用型別 + abstract 介面（被另兩個 repo 以 git submodule 內嵌引用）。 |
| [`remote-serialport-server`](https://github.com/teddy1565/remote-serialport-server) | `node-serialport-server` | 守實體序列埠；透過 socket.io 對外。 |
| [`remote-serialport-client`](https://github.com/teddy1565/remote-serialport-client) | `node-serialport-client` | 連 server；把遠端埠暴露成本地虛擬埠。 |

> **從原始碼開發？** `types` package 以 submodule 內嵌在 `src/types/remote-serialport-types`。`git submodule update --init` 後**也要進那個目錄跑一次 `npm install`**（它有自己的依賴），`tsc` 才能解析所有型別。

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

### Shared mode（`multi_access: 'shared'`）

由 server 控制 — client 無需特別設定，只要兩個以上 client 連到同一條 path 就生效。client 看到的差別是讀方向有 fanout、寫方向可能被 server-side scheduling 影響（per-mode 行為詳見 server README 中文段「Shared mode」表）。

### 認證（client 側）

```javascript
const rsc = new RemoteSerialportClient("ws://example:17991", {
  auth: { token: my_jwt }  // opaque；server-side `auth_validator` 自行解讀
});
```

預設 socket.io transport：`auth` 落在 `Manager.socket(label, { auth })`，**每次重連自動 replay**，server 端 `auth_validator` 每次都重跑。IPC 場景請自己 `new NodeIpcClient(port, label, credential)` 然後 `transport_client: ...` 注入。

Server 拒絕 auth 時：連線關閉、handshake 永遠不會收到 — 本地表現是「虛擬 stream 永遠到不了 `open` 狀態」（停在 `idle`）。server 那邊的 logger 跟 `serialport_state: ERROR` payload 才有拒絕原因。

### Transports（`AbsTransport`）

預設 transport 是 socket.io-client；另一個內建是 **Node IPC**（`worker_threads.MessagePort` / Electron utility process `MessagePort`）。透過 ctor option `transport_client` 注入切換。範例：

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
