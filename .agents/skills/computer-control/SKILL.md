---
name: computer-control
description: >-
  Use for desktop automation, window management, OS-level keyboard/mouse input dispatching, display screen capture, and playtest verification outside the browser sandbox.
---

# Computer Control Skill

Orchestrate host environment interactions, operating system windows, low-level keyboard/mouse events, and desktop screen captures.

## Capabilities

1. **Host Screen & Window Capture**:
   - Capture desktop or application windows using native tools (PowerShell Graphics API, `PrintWindow`, `BitBlt`, or OS screenshot utilities).
   - High-fidelity verification of running game engine windows, tool GUIs, and terminal outputs.
2. **Input Simulation**:
   - Simulate keystrokes, key combinations, and system signals across host sessions.
   - Mouse movement, cursor clicking, scrolling, and dragging for GUI applications.
3. **Process Supervision**:
   - Launch, monitor, and gracefully terminate long-running processes (e.g. game servers, gateways, render workers).
   - Capture stdout/stderr logs and correlate visual frames with server ticks.

## Guidelines

- Prefer headless browser automation (`browser-use`) when testing web-based canvas views to guarantee deterministic, isolated sandbox execution.
- Use `computer-control` when validating native electron windows, OS tray behaviors, multi-monitor displays, or host graphics drivers directly.
- Maintain idempotent cleanup routines so detached test processes and temporary capture files do not leak.
