/* eslint-disable no-undef */
import { BackpressureGate, DEFAULT_BACKPRESSURE_WINDOW } from "../src/module/remote-serialport-client";

describe("BackpressureGate", () => {
    test("stays writable until the window fills, then blocks", () => {
        const gate = new BackpressureGate(3);
        expect(gate.writable).toBe(true);
        gate.consume(); // 1
        expect(gate.writable).toBe(true);
        gate.consume(); // 2
        expect(gate.writable).toBe(true);
        gate.consume(); // 3 -> full
        expect(gate.writable).toBe(false);
    });

    test("ack frees a slot and fires drain listeners when crossing back below the window", () => {
        const gate = new BackpressureGate(2);
        let drained = 0;
        gate.on_drain(() => { drained++; });
        gate.consume();
        gate.consume(); // full
        expect(gate.writable).toBe(false);
        gate.ack(); // back to 1 < 2 -> writable, drain fires
        expect(gate.writable).toBe(true);
        expect(drained).toBe(1);
        gate.ack(); // already writable, no extra drain
        expect(drained).toBe(1);
    });

    test("ack on an empty gate does not underflow or fire drain", () => {
        const gate = new BackpressureGate(2);
        let drained = 0;
        gate.on_drain(() => { drained++; });
        gate.ack();
        expect(gate.writable).toBe(true);
        expect(drained).toBe(0);
    });

    test("off_drain removes a listener; reset clears state", () => {
        const gate = new BackpressureGate(1);
        let drained = 0;
        const listener = (): void => { drained++; };
        gate.on_drain(listener);
        gate.off_drain(listener);
        gate.consume(); // full
        gate.ack();
        expect(drained).toBe(0);

        gate.consume();
        expect(gate.writable).toBe(false);
        gate.reset();
        expect(gate.writable).toBe(true);
    });

    test("default window constant is exposed and positive", () => {
        expect(typeof DEFAULT_BACKPRESSURE_WINDOW).toBe("number");
        expect(DEFAULT_BACKPRESSURE_WINDOW).toBeGreaterThan(0);
    });
});
