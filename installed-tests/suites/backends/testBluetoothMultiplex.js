// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import 'gi://Gdk?version=3.0';
import 'gi://Gtk?version=3.0';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import '../../../src/service/init.js';

import * as Core from '../../../src/service/core.js';
import * as Multiplex from '../../../src/service/backends/multiplex.js';
import * as Bluetooth from '../../../src/service/backends/bluetooth.js';

describe('Bluetooth Multiplexing Protocol', function () {
    const TEST_UUID = 'a0d0aaf4-1072-4d81-aa35-902a954b1266';
    const ALT_UUID = '185f3df4-3268-4e3f-9fca-d4d5059915bd';

    it('packs and unpacks headers accurately', function () {
        const testPayload = '{"id":123,"type":"kdeconnect.ping","body":{}}\n';
        const packed = Multiplex.packMessage(Multiplex.MessageType.WRITE, TEST_UUID, testPayload);

        expect(packed.length).toBe(Multiplex.HEADER_SIZE + testPayload.length);

        const [type, size, uuid] = Multiplex.unpackHeader(packed);
        expect(type).toBe(Multiplex.MessageType.WRITE);
        expect(size).toBe(testPayload.length);
        expect(uuid.toLowerCase()).toBe(TEST_UUID.toLowerCase());

        const payloadBytes = packed.subarray(Multiplex.HEADER_SIZE);
        const decoded = new TextDecoder().decode(payloadBytes);
        expect(decoded).toBe(testPayload);
    });

    it('handles message frames with no payload (OPEN / CLOSE)', function () {
        const packedOpen = Multiplex.packMessage(Multiplex.MessageType.OPEN, ALT_UUID);
        expect(packedOpen.length).toBe(Multiplex.HEADER_SIZE);

        const [type, size, uuid] = Multiplex.unpackHeader(packedOpen);
        expect(type).toBe(Multiplex.MessageType.OPEN);
        expect(size).toBe(0);
        expect(uuid.toLowerCase()).toBe(ALT_UUID.toLowerCase());
    });

    it('handles flow control READ messages with buffer sizes', function () {
        const buf = new ArrayBuffer(2);
        new DataView(buf).setUint16(0, 4096);
        const packedRead = Multiplex.packMessage(Multiplex.MessageType.READ, TEST_UUID, new Uint8Array(buf));

        const [type, size, uuid] = Multiplex.unpackHeader(packedRead);
        expect(type).toBe(Multiplex.MessageType.READ);
        expect(size).toBe(2);

        const readView = new DataView(packedRead.buffer, packedRead.byteOffset + Multiplex.HEADER_SIZE, 2);
        expect(readView.getUint16(0)).toBe(4096);
    });

    it('correctly queues and parses packets in BluetoothChannel', async function () {
        const channel = new Multiplex.BluetoothChannel({
            uuid: TEST_UUID,
        });

        // Simulate incoming chunks in pieces (partial line, then remainder)
        const part1 = '{"id":1,"type":"kdecon';
        const part2 = 'nect.battery","body":{"currentCharge":85}}\n';

        channel.pushData(new TextEncoder().encode(part1));
        // No complete packet yet
        expect(channel._packetQueue.length).toBe(0);

        channel.pushData(new TextEncoder().encode(part2));
        expect(channel._packetQueue.length).toBe(1);

        const packet = await channel.readPacket();
        expect(packet).not.toBeNull();
        expect(packet.id).toBe(1);
        expect(packet.type).toBe('kdeconnect.battery');
        expect(packet.body.currentCharge).toBe(85);

        await channel.close();
        expect(channel.closed).toBeTrue();
    });

    it('supports waiting for packets asynchronously in BluetoothChannel', async function () {
        const channel = new Multiplex.BluetoothChannel({
            uuid: TEST_UUID,
        });

        // Start reading before packet arrives
        const readPromise = channel.readPacket();

        // Push packet after a microtask delay
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const data = '{"id":42,"type":"kdeconnect.ping","body":{}}\n';
            channel.pushData(new TextEncoder().encode(data));
            return GLib.SOURCE_REMOVE;
        });

        const packet = await readPromise;
        expect(packet).not.toBeNull();
        expect(packet.id).toBe(42);
        expect(packet.type).toBe('kdeconnect.ping');

        await channel.close();
    });
});

describe('Bluetooth Channel Service', function () {
    it('instantiates and exports the expected service metadata', function () {
        const service = new Bluetooth.ChannelService({
            name: 'TestMachine',
        });

        expect(service.name).toBe('TestMachine');
        expect(service.active).toBeFalse();

        service.buildIdentity();
        expect(service.identity).toBeDefined();
        expect(service.identity.type).toBe('kdeconnect.identity');
        expect(service.identity.body.bluetooth).toBeTrue();
        expect(service.identity.body.deviceName).toBe('TestMachine');
    });

    it('defines valid BlueZ Service UUID and SDP XML', function () {
        expect(Bluetooth.SERVICE_UUID).toBe('185f3df4-3268-4e3f-9fca-d4d5059915bd');
        expect(Bluetooth.SERVICE_RECORD_XML).toContain('185f3df4-3268-4e3f-9fca-d4d5059915bd');
        expect(Bluetooth.SERVICE_RECORD_XML).toContain('GSConnect');
    });
});
