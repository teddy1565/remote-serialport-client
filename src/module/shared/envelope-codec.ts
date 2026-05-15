/**
 * Length-prefix framing + JSON envelope codec — mirror of the server-side codec. Must be kept
 * in sync with `remote-serialport-server/src/modules/shared/envelope-codec.ts`.
 *
 * See the server-side file for full documentation of the wire format and `_binloc` semantics.
 */

export type Envelope =
    | { k: "hello"; label: string; auth?: unknown; ns?: string }
    | { k: "msg"; ns?: string; ch: string; p?: unknown; ack?: number; _binloc?: "p" | "p.data" }
    | { k: "ack"; ack: number; r?: unknown }
    | { k: "bye"; ns?: string };

const HEADER_BYTES = 4;
const JSON_LEN_BYTES = 4;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

function _revive_buffers(_key: string, value: unknown): unknown {
    if (value !== null && typeof value === "object"
        && (value as { type?: unknown }).type === "Buffer"
        && Array.isArray((value as { data?: unknown }).data)) {
        return Buffer.from((value as { data: number[] }).data);
    }
    return value;
}

export function encode(env: Envelope): Buffer {
    let json_obj: any = env;
    let tail: Buffer | null = null;

    if (env.k === "msg" && env.p !== undefined && env.p !== null) {
        if (Buffer.isBuffer(env.p)) {
            tail = env.p;
            json_obj = { ...env, p: undefined, _binloc: "p" };
            delete (json_obj as any).p;
        } else if (typeof env.p === "object"
                   && Buffer.isBuffer((env.p as { data?: unknown }).data)) {
            tail = (env.p as { data: Buffer }).data;
            const p_without_data: any = { ...(env.p as object) };
            delete p_without_data.data;
            json_obj = { ...env, p: p_without_data, _binloc: "p.data" };
        }
    }

    const json: Buffer = Buffer.from(JSON.stringify(json_obj), "utf8");
    const tail_len: number = tail !== null ? tail.length : 0;
    const total: number = JSON_LEN_BYTES + json.length + tail_len;
    if (total > MAX_FRAME_BYTES) {
        throw new Error(`frame exceeds max size (${total} > ${MAX_FRAME_BYTES})`);
    }
    const out: Buffer = Buffer.allocUnsafe(HEADER_BYTES + total);
    out.writeUInt32BE(total, 0);
    out.writeUInt32BE(json.length, HEADER_BYTES);
    json.copy(out, HEADER_BYTES + JSON_LEN_BYTES);
    if (tail !== null) {
        tail.copy(out, HEADER_BYTES + JSON_LEN_BYTES + json.length);
    }
    return out;
}

export class FrameDecoder {
    private _buf: Buffer = Buffer.alloc(0);
    private readonly _on_envelope: (env: Envelope) => void;
    private readonly _on_error: (err: Error) => void;

    constructor(on_envelope: (env: Envelope) => void, on_error: (err: Error) => void) {
        this._on_envelope = on_envelope;
        this._on_error = on_error;
    }

    push(chunk: Buffer): void {
        this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
        while (this._buf.length >= HEADER_BYTES) {
            const total: number = this._buf.readUInt32BE(0);
            if (total > MAX_FRAME_BYTES) {
                this._on_error(new Error(`oversized frame total=${total} (max=${MAX_FRAME_BYTES})`));
                this._buf = Buffer.alloc(0);
                return;
            }
            if (this._buf.length < HEADER_BYTES + total) {
                return;
            }
            const frame: Buffer = this._buf.subarray(HEADER_BYTES, HEADER_BYTES + total);
            this._buf = this._buf.subarray(HEADER_BYTES + total);

            if (frame.length < JSON_LEN_BYTES) {
                this._on_error(new Error(`frame too short for json_len header (${frame.length})`));
                continue;
            }
            const json_len: number = frame.readUInt32BE(0);
            if (frame.length < JSON_LEN_BYTES + json_len) {
                this._on_error(new Error(`frame truncated: json_len=${json_len} but only ${frame.length - JSON_LEN_BYTES} bytes available`));
                continue;
            }
            const json_bytes: Buffer = frame.subarray(JSON_LEN_BYTES, JSON_LEN_BYTES + json_len);
            const tail: Buffer | null = frame.length > JSON_LEN_BYTES + json_len
                ? frame.subarray(JSON_LEN_BYTES + json_len)
                : null;

            let env: Envelope;
            try {
                env = JSON.parse(json_bytes.toString("utf8"), _revive_buffers) as Envelope;
            } catch (e) {
                this._on_error(new Error(`malformed envelope JSON: ${(e as Error).message}`));
                continue;
            }
            if (tail !== null && env.k === "msg") {
                const binloc: string | undefined = (env as any)._binloc;
                if (binloc === "p") {
                    (env as any).p = tail;
                } else if (binloc === "p.data") {
                    if (typeof env.p !== "object" || env.p === null) (env as any).p = {};
                    ((env as any).p as { data: Buffer }).data = tail;
                }
                delete (env as any)._binloc;
            }
            this._on_envelope(env);
        }
    }

    reset(): void {
        this._buf = Buffer.alloc(0);
    }
}
