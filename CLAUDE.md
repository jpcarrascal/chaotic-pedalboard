# CLAUDE.md — Operating Instructions

## Collaboration

- Think through every request carefully before proposing or making any changes.
- Ask clarifying questions rather than making assumptions when anything is unclear.
- Describe the plan and wait for explicit approval before touching code.
- Make the smallest change that satisfies the request — no scope creep, no unsolicited cleanup.

## Workflow

- Run `npm test` and confirm tests pass before reporting a task as done.
- Prefer surgical edits over rewrites or refactors.
- Discuss creating new files with the user before doing so.

## Architecture

The server runs on the **beatlink-core** framework (github.com/jpcarrascal/beatlink-core, consumed as a git dependency tracking `main`):

- `index.js` is a thin entrypoint: `createServer(...)` config + HTML routes + static mounts.
- `server/midiPlugin.js` holds ALL app-specific server logic (device catalog/assignments, CC runtime state, takeover, QR base URL, public snapshot) via the core plugin API.
- Sessions, roles (host/public/participant), the waiting queue, slot timers (turn-taking), Lobby/Veil, and the MIDI transport (`routed-message` envelopes) are core concerns — do not reimplement them here.
- Rule: if a change fits the plugin API, it belongs in `server/midiPlugin.js`; if it can't be expressed there, it's a core improvement — make it upstream in beatlink-core (with contract tests) instead of working around it locally.

See [AI_AGENT_PROJECT_CONTEXT.md](AI_AGENT_PROJECT_CONTEXT.md) for the app-level reference (note: its server-architecture sections predate the beatlink-core migration; client/UI documentation is current).

Additional rules:
- MIDI-specific logic belongs in client scripts and `server/midiPlugin.js` — never in beatlink-core.
