// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import * as Core from '../core.js';
import {wrapObject} from '../utils/dbus.js';
import {MultiplexConnection, BluetoothChannel, DEFAULT_UUID} from './multiplex.js';

/**
 * Service Discovery Protocol Record and Service UUID for KDE Connect RFCOMM
 */
export const SERVICE_UUID = '185f3df4-3268-4e3f-9fca-d4d5059915bd';

export const SERVICE_RECORD_XML = `<?xml version="1.0" encoding="utf-8" ?>
<record>
  <attribute id="0x0001">
    <sequence>
      <uuid value="185f3df4-3268-4e3f-9fca-d4d5059915bd" />
      <uuid value="185f3df432684e3f9fcad4d5059915bd" />
      <uuid value="0x1101" />
    </sequence>
  </attribute>
  <attribute id="0x0003">
    <uuid value="185f3df4-3268-4e3f-9fca-d4d5059915bd" />
  </attribute>
  <attribute id="0x0004">
    <sequence>
      <sequence>
        <uuid value="0x0003" />
      </sequence>
    </sequence>
  </attribute>
  <attribute id="0x0005">
    <sequence>
      <uuid value="0x1002" />
    </sequence>
  </attribute>
  <attribute id="0x0009">
    <sequence>
      <uuid value="0x1101" />
    </sequence>
  </attribute>
  <attribute id="0x0100">
    <text value="GSConnect" />
  </attribute>
</record>`;

const BLUEZ_PROFILE_NODE = Gio.DBusNodeInfo.new_for_xml(`
<node>
  <interface name="org.bluez.Profile1">
    <method name="Release"/>
    <method name="NewConnection">
      <arg name="device" type="o" direction="in"/>
      <arg name="fd" type="h" direction="in"/>
      <arg name="fd_properties" type="a{sv}" direction="in"/>
    </method>
    <method name="RequestDisconnection">
      <arg name="device" type="o" direction="in"/>
    </method>
  </interface>
</node>
`);

const BLUEZ_PROFILE_MANAGER_NODE = Gio.DBusNodeInfo.new_for_xml(`
<node>
  <interface name="org.bluez.ProfileManager1">
    <method name="RegisterProfile">
      <arg name="profile" type="o" direction="in"/>
      <arg name="UUID" type="s" direction="in"/>
      <arg name="options" type="a{sv}" direction="in"/>
    </method>
    <method name="UnregisterProfile">
      <arg name="profile" type="o" direction="in"/>
    </method>
  </interface>
</node>
`);

const PROFILE_IFACE_INFO = BLUEZ_PROFILE_NODE.lookup_interface('org.bluez.Profile1');
const PROFILE_MANAGER_IFACE_INFO = BLUEZ_PROFILE_MANAGER_NODE.lookup_interface('org.bluez.ProfileManager1');

/**
 * Bluetooth Channel Service
 * Manages RFCOMM connections with paired devices using BlueZ.
 */
export const ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannelService',
    Properties: {
        'certificate': GObject.ParamSpec.object(
            'certificate',
            'Certificate',
            'The TLS certificate',
            GObject.ParamFlags.READWRITE,
            Gio.TlsCertificate.$gtype
        ),
    },
}, class BluetoothChannelService extends Core.ChannelService {

    _init(params = {}) {
        super._init(params);

        this._systemBus = null;
        this._profileManager = null;
        this._exportedProfile = null;
        this._profilePath = '/org/gnome/Shell/Extensions/GSConnect/Profile';

        this._devices = new Map();
        this._activeMuxers = new Map();
        this._active = false;
        this._bluezAvailable = false;
        this._bluezWatchId = 0;
    }

    get certificate() {
        if (this._certificate === undefined)
            this._certificate = null;
        return this._certificate;
    }

    set certificate(certificate) {
        if (this.certificate === certificate)
            return;
        this._certificate = certificate;
        this.notify('certificate');
    }

    get active() {
        return this._active;
    }

    get cancellable() {
        if (this._cancellable === undefined || this._cancellable === null)
            this._cancellable = new Gio.Cancellable();
        return this._cancellable;
    }

    /**
     * Rebuild the identity packet for Bluetooth.
     * Inherits capabilities from Core.ChannelService.
     */
    buildIdentity() {
        super.buildIdentity();
        this.identity.body.bluetooth = true;
    }

    /**
     * Start the Bluetooth channel service.
     */
    async start() {
        if (this.active)
            return;

        try {
            this._systemBus = await new Promise((resolve, reject) => {
                Gio.bus_get(Gio.BusType.SYSTEM, this.cancellable, (source, res) => {
                    try {
                        resolve(Gio.bus_get_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            this._bluezAvailable = true;
            this._initProfileManager();
            await this._registerProfile();
            await this._discoverPairedDevices();

            // Watch for BlueZ name appearance/disappearance
            this._bluezWatchId = Gio.bus_watch_name_on_connection(
                this._systemBus,
                'org.bluez',
                Gio.BusNameWatcherFlags.NONE,
                this._onBluezAppeared.bind(this),
                this._onBluezVanished.bind(this)
            );

            this._active = true;
            this.notify('active');
            debug('BluetoothChannelService started');
        } catch (e) {
            debug(`BluetoothChannelService failed to start: ${e.message}`);
        }
    }

    async _onBluezAppeared(connection, name, nameOwner) {
        debug(`BlueZ appeared (${nameOwner})`);
        if (this._exportedProfile)
            return;

        this._bluezAvailable = true;

        try {
            this._initProfileManager();
            await this._registerProfile();
            await this._discoverPairedDevices();
            await this.broadcast();
        } catch (e) {
            debug(`Failed initializing BlueZ profile: ${e.message}`);
        }
    }

    _onBluezVanished(connection, name) {
        debug('BlueZ vanished');
        this._bluezAvailable = false;
        this._cleanDevices();
    }

    _initProfileManager() {
        this._profileManager = new Gio.DBusProxy({
            g_connection: this._systemBus,
            g_name: 'org.bluez',
            g_object_path: '/org/bluez',
            g_interface_name: 'org.bluez.ProfileManager1',
            g_interface_info: PROFILE_MANAGER_IFACE_INFO,
        });

        this._profileManager.init(null);
    }

    async _registerProfile() {
        if (this._exportedProfile)
            return;

        // Export the org.bluez.Profile1 interface on our system bus
        const profileMethods = {
            Release: this.Release.bind(this),
            NewConnection: this.NewConnection.bind(this),
            RequestDisconnection: this.RequestDisconnection.bind(this),
        };

        this._exportedProfile = wrapObject(PROFILE_IFACE_INFO, profileMethods);
        this._exportedProfile.export(this._systemBus, this._profilePath);

        const options = {
            'RequireAuthorization': new GLib.Variant('b', false),
            'RequireAuthentication': new GLib.Variant('b', false),
            'ServiceRecord': new GLib.Variant('s', SERVICE_RECORD_XML),
        };

        await this._profileManager.call(
            'RegisterProfile',
            new GLib.Variant('(osa{sv})', [
                this._profilePath,
                SERVICE_UUID,
                options,
            ]),
            Gio.DBusCallFlags.NONE,
            -1,
            this.cancellable
        );

        debug('BlueZ KDE Connect Profile registered successfully');
    }

    async _discoverPairedDevices() {
        try {
            const objectManager = new Gio.DBusProxy({
                g_connection: this._systemBus,
                g_name: 'org.bluez',
                g_object_path: '/',
                g_interface_name: 'org.freedesktop.DBus.ObjectManager',
            });

            objectManager.init(null);

            const reply = await objectManager.call(
                'GetManagedObjects',
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                this.cancellable
            );

            const [managedObjects] = reply.deepUnpack();
            for (const [path, ifaces] of Object.entries(managedObjects)) {
                if (ifaces['org.bluez.Device1'])
                    this._addDeviceProxy(path, ifaces['org.bluez.Device1']);
            }
        } catch (e) {
            debug(`Failed discovering BlueZ devices: ${e.message}`);
        }
    }

    _addDeviceProxy(objectPath, properties = {}) {
        const proxy = new Gio.DBusProxy({
            g_connection: this._systemBus,
            g_name: 'org.bluez',
            g_object_path: objectPath,
            g_interface_name: 'org.bluez.Device1',
        });
        proxy.init(null);

        this._devices.set(objectPath, proxy);
    }

    /**
     * org.bluez.Profile1.Release
     */
    Release() {
        debug('BlueZ Profile released');
        this._exportedProfile = null;
    }

    /**
     * org.bluez.Profile1.NewConnection
     * BlueZ delivers an incoming or initiated RFCOMM socket connection.
     *
     * @param {string} devicePath - D-Bus object path of the remote device
     * @param {number} fd - Socket file descriptor
     * @param {object} fdProperties - Connection properties dictionary
     */
    async NewConnection(devicePath, fd, fdProperties) {
        debug(`BlueZ NewConnection from ${devicePath} (fd: ${fd})`);

        try {
            const socket = Gio.Socket.new_from_fd(fd);
            const connection = new Gio.SocketConnection({socket});

            const deviceProxy = this._devices.get(devicePath);
            const remoteAddress = deviceProxy?.get_cached_property('Address')?.unpack() || devicePath;

            const muxer = new MultiplexConnection(connection, remoteAddress);
            this._activeMuxers.set(devicePath, muxer);

            // Complete multiplex protocol & identity handshake
            const remoteIdentity = await muxer.handshake(this.identity, true);

            const channel = muxer.defaultChannel;
            channel.identity = remoteIdentity;
            channel.backend = this;

            // Start background frame demuxing
            muxer.runReceiveLoop();

            // Emit the channel to GSConnect Manager
            this.emit('channel', channel);
        } catch (e) {
            debug(`BlueZ NewConnection failed: ${e.message}`);
            try {
                const muxer = this._activeMuxers.get(devicePath);
                if (muxer) {
                    await muxer.close();
                    this._activeMuxers.delete(devicePath);
                }
            } catch {
                // Ignore cleanup errors
            }
        }
    }

    /**
     * org.bluez.Profile1.RequestDisconnection
     *
     * @param {string} devicePath - D-Bus object path of the disconnected device
     */
    async RequestDisconnection(devicePath) {
        debug(`BlueZ RequestDisconnection for ${devicePath}`);
        const muxer = this._activeMuxers.get(devicePath);
        if (muxer) {
            await muxer.close();
            this._activeMuxers.delete(devicePath);
        }
    }

    /**
     * Attempt to initiate connection to paired devices.
     *
     * @param {string} [devicePath] - Specific BlueZ device path or null for all
     */
    async broadcast(devicePath = null) {
        if (!this._bluezAvailable || !this._profileManager)
            return;

        const targets = devicePath ? [this._devices.get(devicePath)].filter(Boolean) : Array.from(this._devices.values());

        for (const dev of targets) {
            try {
                const paired = dev.get_cached_property('Paired')?.unpack() ?? false;
                if (!paired)
                    continue;

                const uuids = dev.get_cached_property('UUIDs')?.deepUnpack() ?? [];
                const isConnected = dev.get_cached_property('Connected')?.unpack() ?? false;
                const hasUuid = uuids.includes(SERVICE_UUID) || uuids.includes('00001101-0000-1000-8000-00805f9b34fb');

                if (hasUuid || isConnected) {
                    debug(`Requesting Bluetooth connection to ${dev.g_object_path}`);
                    await dev.call(
                        'ConnectProfile',
                        new GLib.Variant('(s)', [SERVICE_UUID]),
                        Gio.DBusCallFlags.NONE,
                        -1,
                        this.cancellable
                    );
                }
            } catch (e) {
                debug(`ConnectProfile failed for ${dev.g_object_path}: ${e.message}`);
            }
        }
    }

    _cleanDevices() {
        for (const muxer of this._activeMuxers.values())
            muxer.close();

        this._activeMuxers.clear();
        this._devices.clear();
    }

    /**
     * Stop the Bluetooth channel service.
     */
    stop() {
        if (!this.active)
            return;

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._bluezWatchId && this._systemBus) {
            Gio.bus_unwatch_name(this._bluezWatchId);
            this._bluezWatchId = 0;
        }

        if (this._profileManager && this._exportedProfile) {
            try {
                this._profileManager.call(
                    'UnregisterProfile',
                    new GLib.Variant('(o)', [this._profilePath]),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null
                );
            } catch {
                // Ignore unregister errors on shutdown
            }
        }

        if (this._exportedProfile) {
            this._exportedProfile.unexport();
            this._exportedProfile = null;
        }

        this._cleanDevices();

        this._active = false;
        this.notify('active');
        debug('BluetoothChannelService stopped');
    }

    /**
     * Destroy the service.
     */
    destroy() {
        this.stop();
    }
});

export const Channel = BluetoothChannel;
