// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Core from '../core.js';

/**
 * Multiplex Constants
 */
export const DEFAULT_UUID = 'a0d0aaf4-1072-4d81-aa35-902a954b1266';
export const BUFFER_SIZE = 4096;
export const HEADER_SIZE = 19;
export const PROTOCOL_MIN = 1;
export const PROTOCOL_MAX = 1;

export const MessageType = {
    PROTOCOL: 0,
    OPEN: 1,
    CLOSE: 2,
    READ: 3,
    WRITE: 4,
};

/**
 * Pack a header and optional payload into a Uint8Array.
 *
 * Header structure (19 bytes):
 * - Byte 0: MessageType (1 byte)
 * - Bytes 1-2: Payload length (2 bytes, big-endian)
 * - Bytes 3-18: Channel UUID (16 bytes)
 *
 * @param {number} type - One of MessageType enum
 * @param {string} uuid - Channel UUID string (with or without hyphens)
 * @param {Uint8Array|string|null} [message] - Optional payload
 * @returns {Uint8Array} Packed message frame
 */
export function packMessage(type, uuid, message = null) {
    let payloadBytes = null;
    if (message !== null) {
        if (typeof message === 'string')
            payloadBytes = new TextEncoder().encode(message);
        else if (message instanceof Uint8Array)
            payloadBytes = message;
    }

    const len = payloadBytes ? payloadBytes.byteLength : 0;
    const buf = new ArrayBuffer(HEADER_SIZE + len);
    const view = new DataView(buf);
    const msg = new Uint8Array(buf);

    // Byte 0: type
    view.setUint8(0, type);

    // Bytes 1-2: length (big endian)
    view.setUint16(1, len);

    // Bytes 3-18: 16-byte UUID
    const cleanUuid = uuid.replace(/-/g, '');
    for (let i = 0; i < 16; i++) {
        const byte = parseInt(cleanUuid.substring(i * 2, i * 2 + 2), 16);
        view.setUint8(3 + i, byte);
    }

    // Bytes 19+: payload
    if (payloadBytes !== null)
        msg.set(payloadBytes, HEADER_SIZE);

    return msg;
}

/**
 * Unpack a 19-byte header from a Uint8Array.
 *
 * @param {Uint8Array} bytes - 19-byte packed header
 * @returns {[number, number, string]} [type, length, uuid]
 */
export function unpackHeader(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_SIZE);
    const type = view.getUint8(0);
    const size = view.getUint16(1);

    let hex = '';
    for (let i = 3; i < HEADER_SIZE; i++) {
        const b = view.getUint8(i).toString(16).padStart(2, '0');
        hex += b;
    }

    const uuid = hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
    return [type, size, uuid];
}

/**
 * A multiplexed channel representing a virtual data stream over the
 * underlying Bluetooth RFCOMM connection.
 */
export const BluetoothChannel = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannel',
}, class BluetoothChannel extends Core.Channel {

    _init(params = {}) {
        super._init();

        this.muxer = params.muxer || null;
        this.uuid = params.uuid || DEFAULT_UUID;
        this.service = params.service || null;

        this._packetQueue = [];
        this._packetWaiters = [];
        this._lineBuffer = '';
        this._closed = false;

        this.read_free = BUFFER_SIZE;
        this.write_free = BUFFER_SIZE;

        this._cancellable = new Gio.Cancellable();
    }

    get address() {
        return `bluetooth://${this.muxer?.remoteAddress || 'unknown'}`;
    }

    get closed() {
        return this._closed;
    }

    /**
     * Push incoming byte chunk to the channel.
     * Parses newline-delimited JSON packets for the default control channel.
     *
     * @param {Uint8Array} chunk - Raw payload bytes
     */
    pushData(chunk) {
        if (this._closed)
            return;

        const text = new TextDecoder().decode(chunk);
        this._lineBuffer += text;

        const lines = this._lineBuffer.split('\n');
        // The last element is the remaining partial line
        this._lineBuffer = lines.pop();

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0)
                continue;

            let packet;
            try {
                packet = Core.Packet.deserialize(trimmed);
            } catch (e) {
                debug(`BluetoothChannel: Failed to parse packet: ${e.message}`);
                continue;
            }

            if (this._packetWaiters.length > 0) {
                const waiter = this._packetWaiters.shift();
                waiter.resolve(packet);
            } else {
                this._packetQueue.push(packet);
            }
        }
    }

    /**
     * Read the next packet from the channel.
     *
     * @param {Gio.Cancellable} [cancellable] - Optional cancellable
     * @returns {Promise<Core.Packet|null>} The next packet or null if closed
     */
    async readPacket(cancellable = null) {
        if (this._packetQueue.length > 0)
            return this._packetQueue.shift();

        if (this._closed)
            return null;

        return new Promise((resolve, reject) => {
            const cancelId = cancellable?.connect(() => {
                const idx = this._packetWaiters.findIndex(w => w.resolve === resolve);
                if (idx !== -1)
                    this._packetWaiters.splice(idx, 1);
                reject(new Gio.IOErrorEnum({
                    message: 'Operation was cancelled',
                    code: Gio.IOErrorEnum.CANCELLED,
                }));
            });

            this._packetWaiters.push({
                resolve: packet => {
                    if (cancelId && cancellable)
                        cancellable.disconnect(cancelId);
                    resolve(packet);
                },
                reject: err => {
                    if (cancelId && cancellable)
                        cancellable.disconnect(cancelId);
                    reject(err);
                },
            });
        });
    }

    /**
     * Send a packet across the multiplexed channel.
     *
     * @param {Core.Packet} packet - The packet to send
     * @param {Gio.Cancellable} [cancellable] - Optional cancellable
     * @returns {Promise<boolean>} True if sent successfully
     */
    async sendPacket(packet, cancellable = null) {
        if (this._closed)
            throw new Error('BluetoothChannel is closed');

        const serialized = packet.serialize(); // Includes trailing newline
        const bytes = new TextEncoder().encode(serialized);
        const frame = packMessage(MessageType.WRITE, this.uuid, bytes);

        await this.muxer.sendMessage(frame, cancellable);
        return true;
    }

    /**
     * Close the channel and notify the multiplexer.
     */
    async close() {
        if (this._closed)
            return;

        this._closed = true;
        this.cancellable.cancel();

        // Drain any pending packet waiters
        while (this._packetWaiters.length > 0) {
            const waiter = this._packetWaiters.shift();
            waiter.resolve(null);
        }

        try {
            if (this.uuid === DEFAULT_UUID)
                await this.muxer?.close();
            else
                await this.muxer?.sendClose(this.uuid);
        } catch (e) {
            debug(`BluetoothChannel.close error: ${e.message}`);
        } finally {
            this.muxer?._channels?.delete(this.uuid);
        }
    }
});

/**
 * Manages multiplexed logical channels over a single bidirectional stream.
 */
export class MultiplexConnection {

    /**
     * @param {Gio.IOStream} connection - Underlying stream or socket connection
     * @param {string} [remoteAddress] - Remote Bluetooth device MAC/address
     */
    constructor(connection, remoteAddress = '') {
        this._connection = connection;
        this.remoteAddress = remoteAddress;

        this.input_stream = new Gio.DataInputStream({
            base_stream: this._connection.input_stream,
            byte_order: Gio.DataStreamByteOrder.BIG_ENDIAN,
        });

        this.output_stream = new Gio.DataOutputStream({
            base_stream: this._connection.output_stream,
            byte_order: Gio.DataStreamByteOrder.BIG_ENDIAN,
        });

        this.cancellable = new Gio.Cancellable();
        this._channels = new Map();
        this._protocol = 1;
        this._closing = false;

        // Default control channel for KDE Connect packets
        this._default = new BluetoothChannel({
            muxer: this,
            uuid: DEFAULT_UUID,
        });
        this._channels.set(DEFAULT_UUID, this._default);
    }

    get defaultChannel() {
        return this._default;
    }

    get protocol() {
        return this._protocol;
    }

    /**
     * Read exact number of bytes asynchronously from input_stream.
     *
     * @param {number} size - Bytes to read
     * @returns {Promise<Uint8Array>}
     */
    async _readExact(size) {
        let total = 0;
        const result = new Uint8Array(size);

        while (total < size) {
            if (this.cancellable.is_cancelled()) {
                throw new Gio.IOErrorEnum({
                    message: 'Operation cancelled',
                    code: Gio.IOErrorEnum.CANCELLED,
                });
            }

            const remaining = size - total;
            const gbytes = await this.input_stream.read_bytes_async(
                remaining,
                GLib.PRIORITY_DEFAULT,
                this.cancellable
            );

            const bytes = gbytes.toArray();
            if (bytes.length === 0) {
                throw new Gio.IOErrorEnum({
                    message: 'End of stream reached',
                    code: Gio.IOErrorEnum.CONNECTION_CLOSED,
                });
            }

            result.set(bytes, total);
            total += bytes.length;
        }

        return result;
    }

    /**
     * Read and unpack the next 19-byte message header.
     *
     * @returns {Promise<[number, number, string]>} [type, length, uuid]
     */
    async readHeader() {
        const headerBytes = await this._readExact(HEADER_SIZE);
        return unpackHeader(headerBytes);
    }

    /**
     * Send a raw packed frame asynchronously.
     *
     * @param {Uint8Array} frame - Packed header + payload
     * @param {Gio.Cancellable} [cancellable] - Optional cancellable
     */
    async sendMessage(frame, cancellable = null) {
        if (this._closing)
            return;

        const activeCancellable = cancellable || this.cancellable;
        const gbytes = new GLib.Bytes(frame);

        await this.output_stream.write_bytes_async(
            gbytes,
            GLib.PRIORITY_DEFAULT,
            activeCancellable
        );
        await this.output_stream.flush_async(GLib.PRIORITY_DEFAULT, activeCancellable);
    }

    /**
     * Negotiate the KDE Connect multiplex protocol handshake.
     *
     * @param {Core.Packet} localIdentity - Local device identity packet
     * @param {boolean} isServer - True if accepting incoming connection
     * @returns {Promise<Core.Packet>} Remote device identity packet
     */
    async handshake(localIdentity, isServer = false) {
        // Step 1: Protocol version handshake
        const [protoType, protoSize, protoUuid] = await this.readHeader();
        if (protoType !== MessageType.PROTOCOL)
            throw new Error(`Expected PROTOCOL message (0), got: ${protoType}`);

        const protoBytes = await this._readExact(protoSize);
        const protoView = new DataView(protoBytes.buffer, protoBytes.byteOffset, protoSize);
        const vmin = protoView.getUint16(0);
        const vmax = protoView.getUint16(2);

        if (vmin < PROTOCOL_MIN && vmax > PROTOCOL_MAX)
            throw new Error(`Unsupported multiplex protocol version range: ${vmin}-${vmax}`);

        this._protocol = Math.min(vmax, PROTOCOL_MAX);

        // Acknowledge protocol version
        await this.sendProtocol();

        // Step 2: Request initial read window for DEFAULT_UUID
        await this.sendRead(DEFAULT_UUID, BUFFER_SIZE);

        // Step 3: Identity packet exchange
        let remoteIdentity = null;
        const [msgType, msgSize, msgUuid] = await this.readHeader();

        if (isServer) {
            // When acting as server: send identity first, then receive client's identity
            await this._sendIdentityPacket(localIdentity);
            if (msgType === MessageType.WRITE && msgUuid === DEFAULT_UUID) {
                const identBytes = await this._readExact(msgSize);
                const identText = new TextDecoder().decode(identBytes).trim();
                remoteIdentity = Core.Packet.deserialize(identText);
            }
        } else {
            // When acting as client: receive server's identity, then send local identity
            if (msgType === MessageType.WRITE && msgUuid === DEFAULT_UUID) {
                const identBytes = await this._readExact(msgSize);
                const identText = new TextDecoder().decode(identBytes).trim();
                remoteIdentity = Core.Packet.deserialize(identText);
            }
            await this._sendIdentityPacket(localIdentity);
        }

        // Grant ongoing read capacity
        await this.sendRead(DEFAULT_UUID, BUFFER_SIZE);

        return remoteIdentity;
    }

    async _sendIdentityPacket(identityPacket) {
        const serialized = identityPacket.serialize();
        const bytes = new TextEncoder().encode(serialized);
        const frame = packMessage(MessageType.WRITE, DEFAULT_UUID, bytes);
        await this.sendMessage(frame);
    }

    /**
     * Send supported protocol versions (v1..v1).
     */
    async sendProtocol() {
        const buf = new ArrayBuffer(4);
        const view = new DataView(buf);
        view.setUint16(0, PROTOCOL_MIN);
        view.setUint16(2, PROTOCOL_MAX);
        const frame = packMessage(MessageType.PROTOCOL, DEFAULT_UUID, new Uint8Array(buf));
        await this.sendMessage(frame);
    }

    /**
     * Send flow control credit announcement (MessageType.READ).
     *
     * @param {string} uuid - Channel UUID
     * @param {number} size - Capacity in bytes
     */
    async sendRead(uuid, size = BUFFER_SIZE) {
        const channel = this._channels.get(uuid);
        if (!channel)
            return;

        const buf = new ArrayBuffer(2);
        const view = new DataView(buf);
        view.setUint16(0, size);
        const frame = packMessage(MessageType.READ, uuid, new Uint8Array(buf));
        await this.sendMessage(frame);
        channel.read_free += size;
    }

    /**
     * Request opening a new multiplexed channel.
     *
     * @param {string} uuid - Channel UUID
     */
    async sendOpen(uuid) {
        const frame = packMessage(MessageType.OPEN, uuid);
        await this.sendMessage(frame);
    }

    /**
     * Request closing an open channel.
     *
     * @param {string} uuid - Channel UUID
     */
    async sendClose(uuid) {
        const frame = packMessage(MessageType.CLOSE, uuid);
        await this.sendMessage(frame);
    }

    /**
     * Background packet demultiplexing loop.
     * Continuously dispatches frames to their assigned channels.
     */
    async runReceiveLoop() {
        try {
            while (!this.cancellable.is_cancelled() && !this._closing) {
                const [type, size, uuid] = await this.readHeader();

                switch (type) {
                    case MessageType.PROTOCOL: {
                        const payload = await this._readExact(size);
                        break;
                    }

                    case MessageType.OPEN: {
                        if (!this._channels.has(uuid)) {
                            const newChan = new BluetoothChannel({
                                muxer: this,
                                uuid: uuid,
                            });
                            this._channels.set(uuid, newChan);
                        }
                        break;
                    }

                    case MessageType.CLOSE: {
                        const chan = this._channels.get(uuid);
                        if (chan) {
                            chan._closed = true;
                            this._channels.delete(uuid);
                        }
                        break;
                    }

                    case MessageType.READ: {
                        const amountBytes = await this._readExact(size);
                        if (amountBytes.length >= 2) {
                            const amount = new DataView(amountBytes.buffer, amountBytes.byteOffset).getUint16(0);
                            const chan = this._channels.get(uuid);
                            if (chan)
                                chan.write_free += amount;
                        }
                        break;
                    }

                    case MessageType.WRITE: {
                        const payload = await this._readExact(size);
                        const chan = this._channels.get(uuid);
                        if (chan) {
                            chan.pushData(payload);
                            // Replenish read window
                            await this.sendRead(uuid, size);
                        } else {
                            await this.sendClose(uuid);
                        }
                        break;
                    }

                    default:
                        debug(`Multiplex: Unknown message type ${type}`);
                        if (size > 0)
                            await this._readExact(size);
                        break;
                }
            }
        } catch (e) {
            if (!this.cancellable.is_cancelled() && !this._closing)
                debug(`Multiplex receive loop terminated: ${e.message}`);
        } finally {
            await this.close();
        }
    }

    /**
     * Terminate the multiplex connection and all child channels.
     */
    async close() {
        if (this._closing)
            return;

        this._closing = true;
        this.cancellable.cancel();

        for (const channel of this._channels.values()) {
            channel._closed = true;
            channel.cancellable.cancel();
        }
        this._channels.clear();

        try {
            this._connection?.close_async(GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            // Ignore socket closure errors
        }
    }
}
