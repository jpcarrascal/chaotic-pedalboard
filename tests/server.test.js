const Client = require('socket.io-client');
const { server } = require('../index.js');

// Integration tests for the chaotic-pedalboard server on beatlink-core:
// device assignment lifecycle, queueing when no pedal is free, CC runtime
// state over the routed transport, takeover, and the public snapshot.

const DEVICES = [
    { id: 1, name: 'Pedal A', assignedChannel: 3, controllers: [{ ccNumber: 74 }] },
    { id: 2, name: 'Pedal B', assignedChannel: 5, controllers: [{ ccNumber: 12 }] }
];

describe('chaotic-pedalboard server', () => {
    let port, clients = [];

    beforeAll((done) => {
        server.logger.transports.forEach(t => { t.silent = true; });
        server.httpServer.listen(0, () => {
            port = server.httpServer.address().port;
            done();
        });
    });

    afterEach(() => {
        clients.forEach(s => s.connected && s.disconnect());
        clients = [];
        server.sessions.all().forEach(s => {
            server.turnTaking.clearSession(s.name);
            server.sessions.remove(s.name);
        });
    });

    afterAll(async () => {
        await server.close();
    });

    function connect(query) {
        const socket = Client(`http://localhost:${port}`, {
            query,
            forceNew: true,
            transports: ['websocket']
        });
        clients.push(socket);
        return socket;
    }

    function waitFor(socket, event) {
        return new Promise(resolve => socket.once(event, resolve));
    }

    function waitForMatch(socket, event, predicate) {
        return new Promise(resolve => {
            const listener = (msg) => {
                if (predicate(msg)) {
                    socket.off(event, listener);
                    resolve(msg);
                }
            };
            socket.on(event, listener);
        });
    }

    async function setupHostWithDevices(sessionName, devices = DEVICES) {
        const host = connect({ role: 'host', session: sessionName });
        await waitFor(host, 'host-accepted');
        const assignmentsPromise = waitFor(host, 'device-assignments-updated');
        host.emit('devices-configured', { devices });
        await assignmentsPromise;
        return host;
    }

    test('participant gets a pedal on join: device, channel, slot metadata', async () => {
        await setupHostWithDevices('s1', [DEVICES[0]]);

        const track = connect({ role: 'participant', session: 's1', initials: 'JP' });
        const assignment = await waitFor(track, 'track-assignment');

        expect(assignment.device.name).toBe('Pedal A');
        expect(assignment.channel).toBe(2); // assignedChannel 3 -> 0-based
        expect(assignment.slotDurationSec).toBe(60);
        expect(typeof assignment.slotExpiresAt).toBe('number');
        expect(assignment.deviceState).toEqual({ controllers: {}, updatedAt: null });
    });

    test('no free pedal -> queued; pedal freed -> promoted with assignment', async () => {
        await setupHostWithDevices('s2', [DEVICES[0]]);

        const t1 = connect({ role: 'participant', session: 's2', initials: 'T1' });
        await waitFor(t1, 'track-assignment');

        const t2 = connect({ role: 'participant', session: 's2', initials: 'T2' });
        const status = await waitFor(t2, 'queue-status');
        expect(status.position).toBe(1);

        const promotedPromise = waitFor(t2, 'track-assignment');
        t1.disconnect();
        const promoted = await promotedPromise;
        expect(promoted.device.name).toBe('Pedal A');
    });

    test('MIDI CC over routed transport reaches host and updates device runtime state', async () => {
        const host = await setupHostWithDevices('s3', [DEVICES[0]]);

        const track = connect({ role: 'participant', session: 's3', initials: 'JP' });
        await waitFor(track, 'track-assignment');

        const routedPromise = waitFor(host, 'routed-message');
        const diagPromise = waitForMatch(host, 'device-runtime-state-updated',
            msg => msg.deviceStates['1'] && msg.deviceStates['1'].controllers['cc:74'] === 99);

        track.emit('routed-message', { type: 'MIDI', message: [0xB0, 74, 99], source: 'ui' });

        const envelope = await routedPromise;
        expect(envelope.type).toBe('MIDI');
        expect(envelope.message).toEqual([0xB0, 74, 99]);
        expect(envelope.socketID).toBe(track.id);

        await diagPromise; // CC state recorded for device 1

        // A later joiner on the same device inherits the CC state.
        track.disconnect();
        const track2 = connect({ role: 'participant', session: 's3', initials: 'T2' });
        const assignment = await waitFor(track2, 'track-assignment');
        expect(assignment.deviceState.controllers['cc:74']).toBe(99);
    });

    test('participant MIDI emits throttled device-activity to displays; none during takeover', async () => {
        const host = await setupHostWithDevices('s16', [DEVICES[0]]);
        const display = connect({ role: 'public', session: 's16' });
        await waitFor(display, 'public-session-snapshot');

        const track = connect({ role: 'participant', session: 's16', initials: 'JP' });
        await waitFor(track, 'track-assignment');

        const events = [];
        display.on('device-activity', msg => events.push(msg));
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

        // A burst (slider drag) within the throttle window -> one event.
        const firstPromise = waitFor(display, 'device-activity');
        [10, 20, 30].forEach(v => track.emit('routed-message', { type: 'MIDI', message: [0xB0, 74, v] }));
        expect(await firstPromise).toEqual({ deviceId: 1 });
        await sleep(50);
        expect(events).toHaveLength(1);

        // Takeover blocks participant MIDI, so no glow either.
        const takeoverPromise = waitForMatch(host, 'takeover-state-updated', m => m.takeover.enabled);
        host.emit('set-takeover-state', { enabled: true, value: 100 });
        await takeoverPromise;
        await sleep(120); // past the throttle window
        track.emit('routed-message', { type: 'MIDI', message: [0xB0, 74, 40] });
        await sleep(80);
        expect(events).toHaveLength(1);
    });

    test('QR overlay state is shared by host and displays; participants cannot set it', async () => {
        const host = await setupHostWithDevices('s17', [DEVICES[0]]);
        const display = connect({ role: 'public', session: 's17' });
        expect(await waitFor(display, 'qr-overlay-updated')).toEqual({ visible: false });

        // Sequencer shows it -> display and host both get the new state.
        const displayOn = waitForMatch(display, 'qr-overlay-updated', m => m.visible === true);
        const hostOn = waitForMatch(host, 'qr-overlay-updated', m => m.visible === true);
        host.emit('set-qr-overlay', { visible: true });
        await Promise.all([displayOn, hostOn]);

        // A display opened later starts with the current state.
        const late = connect({ role: 'public', session: 's17' });
        expect(await waitFor(late, 'qr-overlay-updated')).toEqual({ visible: true });

        // A participant can't toggle it.
        const track = connect({ role: 'participant', session: 's17', initials: 'JP' });
        await waitFor(track, 'track-assignment');
        track.emit('set-qr-overlay', { visible: false });
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(server.sessions.get('s17').getAttribute('qrOverlayVisible')).toBe(true);

        // A display (grid q / click / Esc) hides it -> the sequencer follows.
        const hostOff = waitForMatch(host, 'qr-overlay-updated', m => m.visible === false);
        display.emit('set-qr-overlay', { visible: false });
        await hostOff;
        expect(server.sessions.get('s17').getAttribute('qrOverlayVisible')).toBe(false);
    });

    test('takeover suspends participants and blocks MIDI; disabling promotes them back', async () => {
        const host = await setupHostWithDevices('s4', [DEVICES[0]]);

        const track = connect({ role: 'participant', session: 's4', initials: 'JP' });
        await waitFor(track, 'track-assignment');

        const suspendedPromise = waitForMatch(track, 'queue-status',
            msg => msg.message.includes('suspended'));
        const takeoverPromise = waitForMatch(host, 'takeover-state-updated',
            msg => msg.takeover.enabled === true);

        host.emit('set-takeover-state', { enabled: true, value: 100 });
        await Promise.all([suspendedPromise, takeoverPromise]);
        expect(server.sessions.get('s4').participants.activeCount()).toBe(0);

        // MIDI is dropped during takeover: send a blocked CC, then disable
        // takeover and send an allowed one — host must only see the second.
        track.emit('routed-message', { type: 'MIDI', message: [0xB0, 74, 1] });

        const reassignedPromise = waitFor(track, 'track-assignment');
        host.emit('set-takeover-state', { enabled: false });
        await reassignedPromise; // promoted back, pedal re-assigned

        const routedPromise = waitFor(host, 'routed-message');
        track.emit('routed-message', { type: 'MIDI', message: [0xB0, 74, 2] });
        const envelope = await routedPromise;
        expect(envelope.message).toEqual([0xB0, 74, 2]);
    });

    test('session-play exits takeover: mode is play and queued participants are promoted', async () => {
        const host = await setupHostWithDevices('s13', [DEVICES[0]]);
        const track = connect({ role: 'participant', session: 's13', initials: 'JP' });
        await waitFor(track, 'track-assignment');

        const suspendedPromise = waitForMatch(track, 'queue-status', m => m.message.includes('suspended'));
        const takeoverOnPromise = waitForMatch(host, 'takeover-state-updated', m => m.takeover.enabled);
        host.emit('set-takeover-state', { enabled: true, value: 100 });
        await Promise.all([suspendedPromise, takeoverOnPromise]);

        const modePromise = waitForMatch(host, 'session-mode-updated', m => m.mode === 'play');
        const takeoverOffPromise = waitForMatch(host, 'takeover-state-updated',
            m => m.takeover.enabled === false && m.takeover.value === 127);
        const promotedPromise = waitForMatch(track, 'track-assignment', m => m.device && m.device.id === 1);
        host.emit('session-play');
        await Promise.all([modePromise, takeoverOffPromise, promotedPromise]);
    });

    test('session-pause exits takeover: mode is pause', async () => {
        const host = await setupHostWithDevices('s14', [DEVICES[0]]);
        const takeoverOnPromise = waitForMatch(host, 'takeover-state-updated', m => m.takeover.enabled);
        host.emit('set-takeover-state', { enabled: true, value: 100 });
        await takeoverOnPromise;

        const modePromise = waitForMatch(host, 'session-mode-updated', m => m.mode === 'pause');
        const takeoverOffPromise = waitForMatch(host, 'takeover-state-updated', m => m.takeover.enabled === false);
        host.emit('session-pause');
        await Promise.all([modePromise, takeoverOffPromise]);
    });

    test('mode cycle: pause/play/takeover switch cleanly in any order', async () => {
        const host = await setupHostWithDevices('s15', [DEVICES[0]]);
        const session = server.sessions.get('s15');
        const track = connect({ role: 'participant', session: 's15', initials: 'JP' });
        await waitFor(track, 'track-assignment');

        const actions = {
            play: () => host.emit('session-play'),
            pause: () => host.emit('session-pause'),
            takeover: () => host.emit('set-takeover-state', { enabled: true, value: 100 })
        };

        // Each step must report the new mode and leave consistent server state.
        async function step(mode) {
            const modePromise = waitForMatch(host, 'session-mode-updated', m => m.mode === mode);
            actions[mode]();
            await modePromise;
            expect(session.getAttribute('takeover').enabled).toBe(mode === 'takeover');
            expect(session.isPlaying()).toBe(mode === 'play');
        }

        expect(session.isPlaying()).toBe(false); // sessions start paused
        await step('play');
        await step('pause');
        await step('takeover');                   // from pause
        await step('play');

        // Takeover from play pauses the session and veils participants.
        const veilPromise = waitFor(track, 'veil-on');
        await step('takeover');
        await veilPromise;
        expect(session.participants.activeCount()).toBe(0);

        await step('pause');

        // Back to play: the queued participant gets a pedal again.
        const promotedPromise = waitForMatch(track, 'track-assignment', m => m.device && m.device.id === 1);
        await step('play');
        await promotedPromise;
        expect(session.participants.activeCount()).toBe(1);
    });

    test('set-takeover-value writes all configured controllers', async () => {
        const host = await setupHostWithDevices('s5', DEVICES);
        const enabledPromise = waitForMatch(host, 'takeover-state-updated', m => m.takeover.enabled);
        host.emit('set-takeover-state', { enabled: true, value: 127 });
        await enabledPromise;

        const diagPromise = waitForMatch(host, 'device-runtime-state-updated',
            msg => msg.deviceStates['1']?.controllers['cc:74'] === 64
                && msg.deviceStates['2']?.controllers['cc:12'] === 64);
        host.emit('set-takeover-value', { value: 64 });
        await diagPromise;
    });

    test('public client gets a full snapshot including devices and QR base URL', async () => {
        const host = await setupHostWithDevices('s6');
        const qrPromise = waitFor(host, 'qr-base-url-updated');
        host.emit('set-qr-base-url', { baseUrl: 'https://example.com/join/' });
        await qrPromise;

        const display = connect({ role: 'public', session: 's6' });
        const snapshot = await waitFor(display, 'public-session-snapshot');
        expect(snapshot.configuredDevices).toHaveLength(2);
        expect(snapshot.qrBaseUrl).toBe('https://example.com/join');
        expect(snapshot.isPlaying).toBe(false);
        expect(snapshot.slotDurationSec).toBe(60);
    });

    test('host reassigns a device via track-assignment; track and maps update', async () => {
        const host = await setupHostWithDevices('s7', DEVICES);
        const track = connect({ role: 'participant', session: 's7', initials: 'JP' });
        const initial = await waitFor(track, 'track-assignment');

        const other = DEVICES.find(d => d.id !== initial.device.id);
        const reassignedPromise = waitForMatch(track, 'track-assignment',
            msg => msg.device && msg.device.id === other.id);

        host.emit('track-assignment', { socketID: track.id, device: other });
        const reassigned = await reassignedPromise;
        expect(reassigned.deviceState).toEqual({ controllers: {}, updatedAt: null });

        const session = server.sessions.get('s7');
        const slot = session.participants.slotOf(track.id);
        expect(session.getAttribute('deviceAssignments')[slot].deviceId).toBe(other.id);
    });

    test('participants get distinct background colors', async () => {
        await setupHostWithDevices('s8', []);
        const t1 = connect({ role: 'participant', session: 's8', initials: 'AA' });
        const t2 = connect({ role: 'participant', session: 's8', initials: 'BB' });
        const [c1, c2] = await Promise.all([
            waitFor(t1, 'participant-color'),
            waitFor(t2, 'participant-color')
        ]);
        expect(c1.color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(c2.color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(c1.color).not.toBe(c2.color);
    });

    test('ambsynth player list follows active state and disconnects', async () => {
        await setupHostWithDevices('s9', []);
        const display = connect({ role: 'public', session: 's9' });
        await waitFor(display, 'public-session-snapshot');

        const track = connect({ role: 'participant', session: 's9', initials: 'JP' });
        const { color } = await waitFor(track, 'participant-color');

        const joinedPromise = waitForMatch(display, 'ambsynth-players-updated', m => m.players.length === 1);
        track.emit('ambsynth-active', { active: true });
        const joined = await joinedPromise;
        expect(joined.players[0]).toEqual({ socketID: track.id, initials: 'JP', color });

        // Late-joining display can request the current list.
        const display2 = connect({ role: 'public', session: 's9' });
        await waitFor(display2, 'public-session-snapshot');
        const listPromise = waitFor(display2, 'ambsynth-players-updated');
        display2.emit('request-ambsynth-players');
        expect((await listPromise).players).toHaveLength(1);

        const inactivePromise = waitForMatch(display, 'ambsynth-players-updated', m => m.players.length === 0);
        track.emit('ambsynth-active', { active: false });
        await inactivePromise;

        const rejoinedPromise = waitForMatch(display, 'ambsynth-players-updated', m => m.players.length === 1);
        track.emit('ambsynth-active', { active: true });
        await rejoinedPromise;

        const leftPromise = waitForMatch(display, 'ambsynth-players-updated', m => m.players.length === 0);
        track.disconnect();
        await leftPromise;
    });

    test('pedal assignments carry the participant color for public displays', async () => {
        await setupHostWithDevices('s12', [DEVICES[0]]);
        const display = connect({ role: 'public', session: 's12' });
        await waitFor(display, 'public-session-snapshot');

        const assignedPromise = waitForMatch(display, 'public-device-assignments-updated',
            m => Object.keys(m.assignments).length === 1);
        const track = connect({ role: 'participant', session: 's12', initials: 'JP' });
        const [{ color }, assigned] = await Promise.all([
            waitFor(track, 'participant-color'),
            assignedPromise
        ]);
        expect(Object.values(assigned.assignments)[0].userColor).toBe(color);
    });

    test('ambsynth player initials are uppercased and capped at 3 chars', async () => {
        await setupHostWithDevices('s11', []);
        const display = connect({ role: 'public', session: 's11' });
        await waitFor(display, 'public-session-snapshot');

        const track = connect({ role: 'participant', session: 's11', initials: 'j p rodriguez' });
        await waitFor(track, 'participant-color');
        const listPromise = waitFor(display, 'ambsynth-players-updated');
        track.emit('ambsynth-active', { active: true });
        expect((await listPromise).players[0].initials).toBe('JPR');
    });

    test('ambsynth touches reach public displays only from active players', async () => {
        await setupHostWithDevices('s10', []);
        const display = connect({ role: 'public', session: 's10' });
        await waitFor(display, 'public-session-snapshot');

        const track = connect({ role: 'participant', session: 's10', initials: 'JP' });
        await waitFor(track, 'participant-color');

        const touchPromise = waitFor(display, 'ambsynth-touch');
        track.emit('ambsynth-touch', { phase: 'down', x: 0.1, y: 0.1 }); // not active: dropped
        const activePromise = waitFor(display, 'ambsynth-players-updated');
        track.emit('ambsynth-active', { active: true });
        await activePromise;
        track.emit('ambsynth-touch', { phase: 'move', x: 1.5, y: 0.25 });

        const touch = await touchPromise;
        expect(touch).toEqual({ socketID: track.id, phase: 'move', x: 1, y: 0.25 }); // x clamped

        // 'up' carries the short-tap flag (drives the ripple on /grid).
        const upPromise = waitFor(display, 'ambsynth-touch');
        track.emit('ambsynth-touch', { phase: 'up', x: 0.5, y: 0.5, short: true });
        expect(await upPromise).toEqual({ socketID: track.id, phase: 'up', x: 0.5, y: 0.5, short: true });
    });

    test('pedal images API serves the catalog', async () => {
        const response = await fetch(`http://localhost:${port}/api/pedal-images`);
        const body = await response.json();
        expect(Array.isArray(body.images)).toBe(true);
        expect(body.images.length).toBeGreaterThan(0);
        expect(body.images[0]).toMatch(/^\/images\/pedals\//);
    });
});
