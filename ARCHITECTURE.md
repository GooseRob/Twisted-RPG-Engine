# Twisted RPG Engine - Architecture Overview

This document provides a high-level overview of the architecture, systems, and
design philosophy behind the Twisted RPG Engine. It is intended for developers,
contributors, and anyone seeking to understand how the engine works internally.

---

# Core Principles

1. Server-authoritative gameplay  
2. Data-driven content  
3. Modular, extensible systems  
4. Real-time multiplayer via Socket.IO  
5. Safe, creator-friendly design  

---

# High-Level Structure

The engine is divided into the following major subsystems:

- Server (Node.js)
- Database (MySQL/MariaDB)
- Battle Engine
- Event Runner
- NPC Brain
- Admin Panel (AdminSauce)
- Client (HTML/JS)
- Routes / API Layer

---

# Server

The server is responsible for:

- Handling all game logic
- Validating all client actions
- Managing sessions and authentication
- Running battles, events, and NPC logic
- Broadcasting updates via Socket.IO
- Serving static client files

Entry point:  
`server.js`

---

# Database (MySQL/MariaDB)

The database stores all game content:

- Skills
- Items
- Status effects
- Classes
- Races
- NPCs
- Maps
- Shops
- Quests
- Progression tables
- Limit breaks
- Legendary artifacts
- Parties, guilds, friends

The engine is fully data-driven. No game logic is hardcoded.

---

# Battle Engine

File: `battle_engine.js`

Responsibilities:

- Turn-based combat resolution
- Skill, item, and command execution
- Status effect application and expiration
- Elemental bonuses and resistances
- Limit break system
- AI combatants
- Logging and client-safe state output

Key functions:

- `resolveTurn()`
- `resolveSkill()`
- `applyStatusEffects()`
- `calculateDamage()`
- `battle.toClientState()`

---

# Event Runner

File: `event_runner.js`

Responsibilities:

- Running scripted events (quests, cutscenes, interactions)
- Executing event actions (dialogue, movement, conditions, rewards)
- Managing event state and branching logic
- Integrating with DB for quest progression

Event actions are JSON-driven and fully extensible.

---

# NPC Brain

File: `npc_brain.js`

Responsibilities:

- NPC AI behavior
- Pathing, interactions, and triggers
- Combat AI decision-making
- Event-triggered NPC actions

---

# Admin Panel (AdminSauce)

Directory: `public/adminsauce/`

Responsibilities:

- CRUD editors for all game content
- Map editor
- NPC editor
- Skill, item, class, race editors
- Quest and event editors
- Settings and configuration tools

This is the primary tool for creators.

---

# Client

Directory: `public/js/`

Responsibilities:

- UI rendering
- Chat, party, guild, trade interfaces
- Battle UI
- World map and minimap
- Inventory and equipment
- Quest log

The client never performs game logic.  
It only displays server-authoritative state.

---

# Routes / API Layer

Directory: `routes/`

Responsibilities:

- Authentication
- Game actions
- Admin endpoints
- Guild, party, progression, and quest routes

All routes validate input and interact with the DB.

---

# Summary

The Twisted RPG Engine is a modular, data-driven, server-authoritative RPG
framework designed for extensibility, safety, and creator empowerment. Each
subsystem is isolated, maintainable, and built for long-term growth.
