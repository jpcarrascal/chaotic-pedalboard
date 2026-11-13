# Chaotic Pedalboard: AI Agent Project Context

> **⚠️ Architecture update (2026-07-06):** the server was migrated onto the
> **beatlink-core** framework. `scripts/sessionObj.js` no longer exists;
> `index.js` is now a thin entrypoint and app-specific server logic lives in
> `server/midiPlugin.js`. Sections below describing the old server internals
> (sessionObj API, server event handling) are historical; client/UI and
> feature documentation remains accurate. See `CLAUDE.md` and
> github.com/jpcarrascal/beatlink-core (BEATLINK-SPEC.md) for the current
> server architecture. Server tests: `tests/server.test.js`.

## 1) Project Description

Chaotic Pedalboard (formerly MIDI Socket) is a real-time collaborative music web app that currently operates as a MIDI routing bridge between:

- Remote browser-based Track clients (participants)
- A host Controller client running on a machine with local MIDI interfaces

The host receives participant control/note data over Socket.IO, maps each participant to a selected MIDI output device/channel, and forwards MIDI messages to connected hardware/software MIDI targets.

The codebase evolved from an earlier collaborative step-sequencer model and includes a completed server-side session manager migration (`sessionsObj.js` -> `sessionObj.js`).

## 2) Product Architecture

### 2.1 Runtime Topology

- `index.js` is the Node.js + Express + Socket.IO server entrypoint.
- Controller web UI (host/operator; formerly "Sequencer") is served from `html/controller.html` with logic in `scripts/controller.js`.
- Track web UI (remote participant) is served from `html/track.html` with logic in `scripts/track.js`.
- Shared/session and MIDI routing utilities are under `scripts/`.

Data flow:

1. Track emits interaction/MIDI events over Socket.IO.
2. Server associates socket with a session and participant slot.
3. Controller host UI manages routing assignments (device + channel per track).
4. Routing logic forwards MIDI messages to the selected local output interface/channel.

### 2.2 Key Modules

- `index.js`: Server, Socket.IO event handling, session lifecycle.
- `scripts/sessionObj.js`: Current session model (`AllSessions`, `Session`, participant allocation, sequencing state APIs).
- `scripts/midiDeviceManager.js`: Web MIDI device discovery/status and sending.
- `scripts/routingMatrix.js`: Track-to-device/channel mapping state and validation.
- `scripts/midiRouting.js`: MIDI message routing engine.
- `scripts/deviceConfiguration.js`: Custom device/controller configuration workflow with persistence/import/export.
- `scripts/controller.js`: Controller page orchestration and routing matrix UI behavior.
- `scripts/track.js`: Track page controls and outbound message behavior.

### 2.3 Frontend Structure

- HTML pages in `html/` for different app surfaces (`controller`, `track`, `public`, `ambsynth`, etc.).
- CSS in `css/` with focused stylesheets (`routingMatrix.css`, `track.css`, `controller.css`, etc.).
- Browser-side scripts in `scripts/`.

## 3) Current Feature Set

### 3.1 Core Routing Features

- Real-time multi-participant track connections.
- Per-track assignment to MIDI output interface + channel.
- Dynamic join/leave updates in routing matrix.
- Start/pause session controls.
- Panic/all-notes-off controls (including per-track action support).

### 3.2 Device and Controller Workflow

- Custom device definitions with:
  - Device name
  - Device color/theme
  - Controller definitions
- Supported controller styles:
  - Continuous controls (slider-like, 0-127 style ranges)
  - Discrete controls (named ranges/states mapped to CC values)
- Device config persistence via localStorage.
- Import/export of device configuration as JSON.
- Track UI adapts to assigned device controller definitions.

### 3.3 Operational UX

- Routing matrix with clear per-track controls.
- Device/channel selection and status visualization.
- MIDI interface auto-detection and hot-plug aware behavior.
- Mobile-oriented Track interface.

## 4) Project History and Migrations

### 4.1 Sequencer Redesign (Completed)

The app was redesigned from collaborative step-sequencer emphasis to MIDI routing bridge emphasis, adding dedicated routing infrastructure (`midiDeviceManager`, `routingMatrix`, `midiRouting`) and upgraded Sequencer UI flows.

### 4.2 Session Manager Migration (Completed)

- Migrated to `scripts/sessionObj.js` (from older wrapper-style API).
- New usage pattern is direct session object access (`sessions.select(name)` then method calls).
- Tests added under `tests/sessionObj.test.js`.
- `package.json` includes Jest scripts/dependency.

## 5) Current State (As of 2026-06-15)

### 5.1 Overall Status

- Application is in a usable, feature-rich state for MIDI routing workflows.
- Core migration and main redesign work are complete.
- Documentation had become fragmented/redundant and is now consolidated into this file.

### 5.2 Known Notes

- Legacy planning/history docs exist for traceability but are no longer primary references.
- There is deferred architecture work for AmbSynth audio-graph persistence (tracked as future work).

## 6) Testing and Validation

### 6.1 Automated Tests

- Test suite location: `tests/sessionObj.test.js`
- Primary command:

```bash
npm test
```

Coverage focus today is session management behavior and direct-access session API expectations.

### 6.2 Manual Validation Checklist

1. Start server (`node index.js`).
2. Open Controller page with a session query.
3. Open one or more Track pages in same session.
4. Confirm track allocation and routing matrix updates.
5. Assign device/channel and send Track interactions.
6. Confirm MIDI output reaches expected local interface/channel.
7. Test panic/all-notes-off behavior.
8. Disconnect/reconnect tracks and verify slot reuse/state correctness.

## 7) Future Work and Roadmap

### 7.1 Deferred Refactor

- AmbSynth persistent audio graph refactor is deferred for stability reasons.
- Candidate path includes feature-flagged persistent graph, A/B comparison, and mobile unlock-regression checks before defaulting on.

### 7.2 Potential Enhancements

- Routing presets/templates.
- Expanded controller/widget types.
- More integration tests (Socket.IO + routing paths).
- CI automation for test execution on push/PR.
- Additional MIDI filtering/transform features.

## 8) AI Agent Operating Guidance

When making changes in this repo:

1. Preserve session API usage based on `sessionObj.js` direct-access pattern.
2. Treat Controller as the routing authority and Track as event source.
3. Validate both Socket.IO behavior and MIDI routing behavior after changes.
4. Prefer minimal, surgical edits to avoid regressions in real-time pathways.
5. Run tests (`npm test`) and perform at least one manual Controller+Track smoke test for user-facing changes.

## 9) Quick Reference

- Server entrypoint: `index.js`
- Session logic: `scripts/sessionObj.js`
- Controller UI: `html/controller.html`, `scripts/controller.js`, `css/routingMatrix.css`
- Track UI: `html/track.html`, `scripts/track.js`, `css/track.css`
- MIDI/routing core: `scripts/midiDeviceManager.js`, `scripts/routingMatrix.js`, `scripts/midiRouting.js`
- Device config system: `scripts/deviceConfiguration.js`
- Tests: `tests/sessionObj.test.js`
