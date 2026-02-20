# Contributing to Twisted RPG Engine

Thank you for your interest in contributing! This engine is designed to be modular,
data-driven, and creator-friendly. This guide explains how to contribute safely
and effectively.

---

## Project Philosophy

The Twisted RPG Engine is built on three pillars:

1. Server-authoritative gameplay
2. Data-driven content
3. Modular, extensible architecture

All contributions should reinforce these principles.

---

## Getting Started

### 1. Clone the repository
git clone https://github.com/GooseRob/Twisted-RPG-Engine.git
cd Twisted-RPG-Engine

### 2. Install dependencies
npm install

### 3. Create your .env file
Copy .env.example to .env and fill in your local values.

### 4. Start the server
node server.js

---

## Code Standards

### Use async/await
All database operations must use async/await.

### Follow existing patterns
Study the following files before contributing:
- battle_engine.js
- event_runner.js
- npc_brain.js
- routes/*

### Keep logic data-driven
Do not hardcode:
- skills
- items
- statuses
- commands
- classes
- elements

These must come from MySQL.

### Maintain backwards compatibility
Use helper functions like:
- queryLevelRow
- queryLimitBreakRow
- buildFormulaVars

### Keep logs consistent
Use:
- result.log.push()
- battle.addLog()

### Keep client views safe
Never expose internal state directly. Always use:
battle.toClientState(viewerCharId)

---

## Submitting Changes

1. Create a new branch:
git checkout -b feature/my-new-feature

2. Make your changes.

3. Commit with a descriptive message:
git commit -m "Add new status effect: Bleed"

4. Push your branch:
git push origin feature/my-new-feature

5. Open a Pull Request on GitHub.

---

## What Makes a Good Pull Request?

- Clear purpose
- Clean, readable code
- Follows engine architecture
- Includes comments where needed
- Does not break existing systems
- Does not introduce hardcoded game logic
- Includes DB migration if needed

---

## Need Help?

Open an issue on GitHub or join the discussion.
We welcome contributions of all sizes — from bug fixes to new systems.

Thanks for helping build the Twisted RPG Engine!
