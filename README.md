# Chaotic Pedalboard

Chaotic Pedalboard is a collaborative music performance system: a guitar effect pedal
chain is connected to the internet during a live performance, and the audience takes
control of the effects from their phones, shaping the guitarist's sound in real time.
Attendees can also contribute their own sound by using their phones as simple
synthesizers — no app install required, just a browser.

## How a session works

- **Host** — the performer/operator's machine. It runs the controller/routing page, has
  the local MIDI interfaces connected to the actual pedals, and owns the session.
- **Participants** — audience members who join on their phones. Each is assigned an
  available pedal (or a synth voice) and gets a control surface built specifically for
  that device: sliders for continuous parameters, buttons for discrete ones. Turns are
  time-limited so a crowd bigger than the number of pedals still gets to participate —
  people who can't get a device yet are held in a queue and promoted as slots free up.
- **Public display** — an optional shared screen: QR code to join, the live queue, and
  who's controlling what.

The host can also flip on **takeover mode**, briefly pausing audience control to play a
passage unassisted, then hand it back.

## Quick start

```bash
npm install
node index.js
```

- Host: `http://localhost:3000/controller?session=yoursession`
- Participants: `http://localhost:3000/track?session=yoursession`
- Public display: `http://localhost:3000/public?session=yoursession`

## Configuring devices

Before a session, the host defines the pedals (or synths) available to route to:

1. Open **Device Configuration** on the controller page.
2. Give the device a name and a color (the color themes that device's Track interface).
3. Add controllers:
   - **Continuous** — a slider over a CC range, e.g. `Filter Cutoff`, CC 74, range 0–127.
   - **Discrete** — a set of named states mapped to CC sub-ranges, e.g. `Waveform`, CC 12,
     with `Sine: 0–31, Square: 32–63, Saw: 64–95, Noise: 96–127` rendered as four buttons.
4. Export/import device configurations as JSON to reuse or share a setup between gigs.

As participants join, the host assigns each one a configured device and a MIDI
channel/output; that participant's phone renders only the controls for their device.

## Requirements

- Node.js 24+
- A browser with Web MIDI API support on the host machine (Chrome, Edge, or Opera —
  Web MIDI isn't implemented in Firefox/Safari)
- MIDI interfaces connecting the host machine to the actual pedals/hardware

## Architecture

```
Participant phones (browser)  ──┐
                                 ├──▶  Chaotic Pedalboard server  ──▶  MIDI hardware
Public display (browser)      ──┘            (device routing)
```

The server runs on [beatlink-core](https://github.com/jpcarrascal/beatlink-core), a
shared framework for this and several sibling collaborative-music apps — session/role
management, the turn-taking queue, and the MIDI transport are all provided by the
framework; this repo's `server/midiPlugin.js` holds the app-specific device-routing logic.

## Documentation

- [AI_AGENT_PROJECT_CONTEXT.md](AI_AGENT_PROJECT_CONTEXT.md) — architecture and module
  reference for developers
- [beatlink-core's MANUAL.md](https://github.com/jpcarrascal/beatlink-core/blob/main/MANUAL.md) —
  how the underlying framework works

## License

MIT — see [LICENSE](LICENSE).
