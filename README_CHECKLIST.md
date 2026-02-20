# Twisted Engine - Final Patched Build (Checklist)

This build restores **AdminSauce** (all managers + type syncing), keeps the **hybrid JSON state** approach, and wires in:
- **Quests + Progression** (templates in DB, progress in `characters.state_json`)
- **Legendary Artifacts** (DB-backed, PvP transfer via battle kill hook)
- **Battle Engine fixes** (turn ownership + per-player battle state)

## 0) Prereqs
- Node.js (LTS is fine)
- MariaDB/MySQL running (XAMPP MariaDB is OK)

## 1) Configure env
1. Copy `.env.example` → `.env`
2. Set DB creds + a long `ADMIN_KEY`

## 2) Install deps
```bash
npm install
```

## 3) Create / import DB schema
### If you're using XAMPP MariaDB on Windows PowerShell
PowerShell doesn’t like the `< file.sql` redirect, so do this instead:

```powershell
# cd into the project folder first
Get-Content .\mysql_quests_progression_SAFE.sql | & "C:\xampp\mysql\bin\mysql.exe" -u root -p twisted_rpg
Get-Content .\mysql_legendary_artifacts_SAFE.sql | & "C:\xampp\mysql\bin\mysql.exe" -u root -p twisted_rpg
```

(If your DB name is different, replace `twisted_rpg`.)

## 4) Run the server
```bash
node server.js
```

## 5) Open the UIs
- Game / site: `http://localhost:3000/`
- Game canvas: `http://localhost:3000/game.html`
- AdminSauce: `http://localhost:3000/adminsauce/`

### AdminSauce login
Use the **Admin Key** you set in `.env`.

## 6) Sanity checks
- AdminSauce left nav should load all sections:
  - Items, Feats, Classes, Backgrounds, Races, NPCs, Maps
  - Shops + Shop Supply
  - Spawns, Arena, Battle Commands
  - Quests
  - Legendary Artifacts
  - Settings + Module Scripts

- Battle:
  - Starting a battle should show each player their own HP/MP updates.
  - PvP kill should trigger artifact hook (if artifacts exist) and update ownership/lineage.

## Notes on the “Hybrid JSON” model
- Static definitions live in tables (items, quests, artifacts, etc.)
- Player-specific, flexible state lives in JSON columns like `characters.state_json`.

That’s why the system is easy to extend without 500 migrations 😈
