# Copilot Guide for Twisted RPG Engine

This document teaches GitHub Copilot how to behave when generating code for this project.
The Twisted RPG Engine is a fully data-driven, server-authoritative RPG framework. All
gameplay logic must follow the patterns and architecture described below.

---

## Core Principles

1. **Server-authoritative logic**
   - All combat, events, progression, and world logic must be resolved on the server.
   - Never trust client input. Always validate and sanitize.

2. **Data-driven design**
   - Skills, items, statuses, commands, classes, elements, and limit breaks come from MySQL.
   - Do not hardcode game logic. Always reference DB definitions.
   - Use `safeEval` for formulas.

3. **Modular architecture**
   - Keep systems separated: battle engine, event runner, NPC brain, admin panel, routes.
   - Avoid circular dependencies.
   - Prefer small, focused functions.

4. **Backwards compatibility**
   - The engine must support older database schemas when possible.
   - Use helper functions like `queryLevelRow`, `queryLimitBreakRow`, etc.

5. **Async/await everywhere**
   - All DB operations must use async/await.
   - Never mix callbacks or raw promises.

6. **Security**
   - Never expose internal state directly to clients.
   - Use `battle.toClientState(viewerCharId)` for safe views.
   - Do not leak private stats, hidden statuses, or server-only fields.

---

## Coding Style

- Use descriptive variable names.
- Keep logs consistent with:
  - `result.log.push()`
  - `battle.addLog()`
- Follow the patterns in:
  - `battle_engine.js`
  - `event_runner.js`
  - `npc_brain.js`
- Avoid deeply nested logic; prefer early returns.
- Keep functions pure when possible (except DB writes).

---

## When Copilot Generates New Code

Copilot should:

- Follow existing patterns for resolving skills, items, statuses, and commands.
- Use DB-driven definitions instead of hardcoding.
- Maintain the turn-based flow:
  1. Execute action
  2. Apply statuses
  3. Check deaths
  4. Advance turn
  5. Broadcast update
- Use `battle.addLog()` for all combat logs.
- Use `safeEval()` for formulas.
- Use `jp()` for JSON parsing from DB fields.

---

## Examples of Good Copilot Behavior

- Adding a new skill effect type:
  - Follow `resolveSkill()` patterns.
  - Use DB definitions.
  - Log actions consistently.

- Adding a new event action:
  - Follow `event_runner.js` structure.
  - Use async DB operations.
  - Return updated event state.

- Adding a new status effect:
  - Update `processStatusEffects()`.
  - Add DB-driven behavior.
  - Keep logs consistent.

---

## Examples of Bad Copilot Behavior

- Hardcoding skill damage formulas.
- Adding combat logic on the client.
- Ignoring DB definitions.
- Using callbacks instead of async/await.
- Creating global state.
- Bypassing `battle.toClientState()`.

---

## Final Notes

Copilot should always:
- Respect the engine’s modular design.
- Keep logic server-authoritative.
- Follow the data-driven architecture.
- Maintain readability and extensibility.

This guide exists to help Copilot generate code that fits naturally into the Twisted RPG Engine.
