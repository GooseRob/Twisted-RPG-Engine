// =================================================================
// UNIVERSAL ADMIN ROUTER (AdminSauce Master Key)
// =================================================================
// Generic CRUD bridge for the AdminSauce panel.
//
// Endpoints:
//   POST /admin/get-all   { type, userId }
//   POST /admin/save      { type, id?, data, userId }
//   POST /admin/delete    { type, id, userId }
//   GET  /admin/types
//
// Notes:
// - We use an explicit allow-list (TYPE_META) to prevent arbitrary table access.
// - Some installs may have slightly different table names (older schema vs newer).
//   For those, each type can declare multiple candidate tables; we auto-resolve
//   the first table that exists.
// - This router supports non-"id" primary keys (e.g., level, key_name, module_key).

const express = require('express');
const router = express.Router();

let db;
router.init = (databaseConnection) => {
  db = databaseConnection;
};

// ---------------------------------------------------------------
// Security (server-side)
// ---------------------------------------------------------------
// Minimal staff gate:
// - If ADMIN_KEY is set, you may pass it as header x-admin-key.
// - Otherwise, we check users.role for the given userId.
//
// Allowed roles are intentionally broad for MVP; tighten later.
const STAFF_ROLES = new Set(['ADMIN', 'GM', 'MOD', 'STAFF', 'OWNER']);

async function requireStaff(req, res, next) {
  try {
    // Optional master key bypass
    const adminKey = process.env.ADMIN_KEY;
    const suppliedKey = req.headers['x-admin-key'];
    if (adminKey && suppliedKey && String(suppliedKey) === String(adminKey)) {
      return next();
    }

    const userId = req.body?.userId || req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ success: false, message: 'Missing userId' });

    const [rows] = await db.query('SELECT role FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!rows || !rows.length) return res.status(401).json({ success: false, message: 'Invalid user' });

    const role = String(rows[0].role || '').toUpperCase();
    if (!STAFF_ROLES.has(role)) {
      return res.status(403).json({ success: false, message: 'Staff role required' });
    }

    req.staffRole = role;
    next();
  } catch (err) {
    console.error('Admin auth error:', err);
    res.status(500).json({ success: false, message: 'Auth error' });
  }
}

// ---------------------------------------------------------------
// Type -> table mapping
// ---------------------------------------------------------------
// Each type defines:
//  - pk: primary key column
//  - tables: array of candidate table names (first existing wins)
//
// This is where AdminSauce “gets its powers back” — if a manager uses a type,
// it MUST exist here.
const TYPE_META = {
  // --- World ---
  map:         { pk: 'id', tables: ['game_maps'] },
  npc:         { pk: 'id', tables: ['game_npcs'] },
  shop:        { pk: 'id', tables: ['game_shops', 'game_shop'] },
  shop_supply: { pk: 'id', tables: ['game_shop_supply', 'game_shop_items', 'game_shop_stock'] },
  spawn:       { pk: 'id', tables: ['game_spawns', 'game_spawn_points'] },
  arena:       { pk: 'id', tables: ['game_arenas', 'game_arena'] },

  // --- Character / DB ---
  item:       { pk: 'id', tables: ['game_items'] },
  class:      { pk: 'id', tables: ['game_classes'] },
  race:       { pk: 'id', tables: ['game_races'] },
  bg:         { pk: 'id', tables: ['game_backgrounds'] },
  feat:       { pk: 'id', tables: ['game_feats'] },
  equip_slot: { pk: 'slot_key', tables: ['game_equip_slots', 'equip_slots'] },

  // Stat system
  stat:       { pk: 'key_name', tables: ['game_stat_definitions', 'stat_definitions'] },

  // --- Combat / Rules ---
  battle_cmd:  { pk: 'id', tables: ['game_battle_commands', 'battle_commands'] },
  skill:       { pk: 'id', tables: ['game_skills', 'skills'] },
  element:     { pk: 'id', tables: ['game_elements', 'elements'] },
  status:      { pk: 'id', tables: ['game_statuses', 'statuses', 'status_effects'] },
  limit:       { pk: 'id', tables: ['game_limit_breaks', 'limit_breaks', 'game_limits'] },
  class_skill: { pk: 'id', tables: ['game_class_skills', 'class_skills'] },

  // --- Quests + Progression ---
  quest:     { pk: 'quest_id', tables: ['quest_definitions', 'game_quests'] },
  level_req: { pk: 'level',   tables: ['level_requirements', 'game_level_requirements', 'game_levels'] },
  // alias used by GenericManager config in AdminSauce
  level:     { pk: 'level',   tables: ['level_requirements', 'game_level_requirements', 'game_levels'] },

  // --- Legendary Artifacts ---
  artifact:       { pk: 'artifact_id', tables: ['legendary_artifacts'] },
  artifact_power: { pk: 'power_id',    tables: ['artifact_powers'] },

  // --- Config ---
  setting: { pk: 'setting_key', tables: ['game_settings', 'system_settings', 'settings'] },
  module:  { pk: 'module_key',  tables: ['game_modules', 'core_modules', 'modules'] },
  script:  { pk: 'script_key',  tables: ['game_scripts', 'scripts'] },
};

function isMissingTableErr(err) {
  // MySQL/MariaDB: ER_NO_SUCH_TABLE (errno 1146)
  return !!err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146);
}

async function resolveType(type) {
  const meta = TYPE_META[type];
  if (!meta) {
    const e = new Error('Invalid Type');
    e.status = 400;
    throw e;
  }

  // Cache resolved table (first existing)
  if (meta._resolvedTable) {
    return { ...meta, table: meta._resolvedTable };
  }

  const candidates = Array.isArray(meta.tables) ? meta.tables : [meta.table];
  let lastMissing = null;

  for (const t of candidates) {
    if (!t) continue;
    try {
      // Probing existence safely.
      // NOTE: Using ?? placeholder prevents identifier injection.
      await db.query('SELECT 1 FROM ?? LIMIT 1', [t]);
      meta._resolvedTable = t;
      return { ...meta, table: t };
    } catch (err) {
      if (isMissingTableErr(err)) {
        lastMissing = err;
        continue;
      }
      throw err;
    }
  }

  // None of the tables exist
  const e = new Error('DB table missing for this module. Run the relevant schema / migration, then reload AdminSauce.');
  e.status = 400;
  e._missing = lastMissing;
  throw e;
}

function safeColumnName(col) {
  // allow letters, numbers, underscore only
  return typeof col === 'string' && /^[a-zA-Z0-9_]+$/.test(col);
}

router.get('/admin/types', requireStaff, (req, res) => {
  res.json({ success: true, data: Object.keys(TYPE_META).sort() });
});

// -----------------------------------------------------------------
// 1) GET ALL
// -----------------------------------------------------------------
router.post('/admin/get-all', requireStaff, async (req, res) => {
  try {
    const { type } = req.body;
    const { table, pk } = await resolveType(type);

    const [rows] = await db.query('SELECT * FROM ?? ORDER BY ?? DESC', [table, pk]);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'DB Error' });
  }
});

// -----------------------------------------------------------------
// 2) SAVE / UPDATE
// -----------------------------------------------------------------
router.post('/admin/save', requireStaff, async (req, res) => {
  try {
    const { type, id, data } = req.body;
    const { table, pk } = await resolveType(type);

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ success: false, message: 'Missing data' });
    }

    // Prevent accidental PK mutation on updates
    const payload = { ...data };
    if (id !== undefined && id !== null && String(id) !== '' && pk in payload) {
      delete payload[pk];
    }

    // Validate keys (avoid injection via column names)
    for (const k of Object.keys(payload)) {
      if (!safeColumnName(k)) {
        return res.status(400).json({ success: false, message: `Invalid column name: ${k}` });
      }
    }

    const hasId = (id !== undefined && id !== null && String(id) !== '');

    if (hasId) {
      const keys = Object.keys(payload);
      if (!keys.length) return res.json({ success: true, message: 'Nothing to update' });

      const setClause = keys.map(k => `\`${k}\` = ?`).join(', ');
      const values = keys.map(k => payload[k]);

      const [result] = await db.query(
        `UPDATE \`${table}\` SET ${setClause} WHERE \`${pk}\` = ?`,
        [...values, id]
      );

      // If the record didn't exist AND this table uses a non-auto primary key,
      // treat this as an UPSERT so the ACP can create records with explicit IDs.
      if (result.affectedRows === 0 && pk !== 'id') {
        const insertPayload = { ...payload, [pk]: id };
        await db.query('INSERT INTO ?? SET ?', [table, insertPayload]);
        return res.json({ success: true, message: 'Created!' });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: 'Record not found' });
      }

      return res.json({ success: true, message: 'Updated!' });
    }

    // CREATE
    const [result] = await db.query('INSERT INTO ?? SET ?', [table, payload]);
    res.json({ success: true, message: 'Created!', insertId: result.insertId || null });

  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'DB Error' });
  }
});

// -----------------------------------------------------------------
// 3) DELETE
// -----------------------------------------------------------------
router.post('/admin/delete', requireStaff, async (req, res) => {
  try {
    const { type, id } = req.body;
    const { table, pk } = await resolveType(type);

    if (id === undefined || id === null || id === '') {
      return res.status(400).json({ success: false, message: 'Missing id' });
    }

    const [result] = await db.query('DELETE FROM ?? WHERE ?? = ?', [table, pk, id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Record not found' });
    }

    res.json({ success: true, message: 'Deleted.' });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'DB Error' });
  }
});



// -----------------------------------------------------------------
// 4) SETTINGS (Key/Value convenience endpoints)
// -----------------------------------------------------------------
// Some older AdminSauce managers treat settings as a simple key/value map.
// These endpoints keep that UX intact.

const _tableColumnsCache = new Map();

async function getTableColumns(tableName) {
  if (_tableColumnsCache.has(tableName)) return _tableColumnsCache.get(tableName);
  const [rows] = await db.query(
    'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [tableName]
  );
  const cols = new Set((rows || []).map(r => r.COLUMN_NAME));
  _tableColumnsCache.set(tableName, cols);
  return cols;
}

async function resolveSettingsKV() {
  const meta = await resolveType('setting');
  const table = meta.table;
  const cols = await getTableColumns(table);

  const keyCandidates = ['setting_key', 'key_name', 'key', 'name'];
  const valCandidates = ['setting_value', 'value', 'value_json', 'value_text'];

  const keyCol = keyCandidates.find(c => cols.has(c));
  const valCol = valCandidates.find(c => cols.has(c));

  if (!keyCol || !valCol) {
    const e = new Error(`Settings table schema mismatch. Need key/value columns (found: ${[...cols].join(', ')})`);
    e.status = 400;
    throw e;
  }

  return { table, keyCol, valCol };
}

router.post('/admin/get-settings', requireStaff, async (req, res) => {
  try {
    const { table, keyCol, valCol } = await resolveSettingsKV();
    const [rows] = await db.query('SELECT ?? AS k, ?? AS v FROM ??', [keyCol, valCol, table]);
    const out = {};
    for (const r of (rows || [])) out[r.k] = r.v;
    res.json({ success: true, data: out });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'DB Error' });
  }
});

router.post('/admin/save-setting', requireStaff, async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ success: false, message: 'Missing key' });

    const { table, keyCol, valCol } = await resolveSettingsKV();

    // Key column should be PK/unique for ON DUPLICATE KEY to work.
    await db.query(
      'INSERT INTO ?? (??, ??) VALUES (?, ?) ON DUPLICATE KEY UPDATE ?? = VALUES(??)',
      [table, keyCol, valCol, key, value, valCol, valCol]
    );

    res.json({ success: true, message: 'Saved' });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'DB Error' });
  }
});

router.post('/admin/delete-setting', requireStaff, async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ success: false, message: 'Missing key' });

    const { table, keyCol } = await resolveSettingsKV();
    const [result] = await db.query('DELETE FROM ?? WHERE ?? = ?', [table, keyCol, key]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'DB Error' });
  }
});

// -----------------------------------------------------------------
// 5) MODULES (Key/Value convenience endpoints, mirrors settings)
// -----------------------------------------------------------------
// Allows AdminSauce to GET/SAVE/DELETE individual module records
// via /admin/get-modules, /admin/save-module, /admin/delete-module

async function resolveModulesKV() {
  const meta = await resolveType('module');
  const table = meta.table;
  const cols = await getTableColumns(table);

  const keyCandidates = ['module_key', 'key_name', 'key', 'name'];
  const keyCol = keyCandidates.find(c => cols.has(c));
  if (!keyCol) {
    const e = new Error(`Modules table schema mismatch. Need a key column (found: ${[...cols].join(', ')})`);
    e.status = 400;
    throw e;
  }
  return { table, keyCol, pk: meta.pk, allCols: cols };
}

router.post('/admin/get-modules', requireStaff, async (req, res) => {
  try {
    const { table, pk } = await resolveType('module');
    const [rows] = await db.query('SELECT * FROM ?? ORDER BY ?? ASC', [table, pk]);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'DB Error' });
  }
});

router.post('/admin/save-module', requireStaff, async (req, res) => {
  try {
    const { key, data } = req.body || {};
    if (!key) return res.status(400).json({ success: false, message: 'Missing key' });

    const { table, pk } = await resolveType('module');
    const payload = { ...(data || {}), [pk]: key };

    // Validate column names
    for (const k of Object.keys(payload)) {
      if (!safeColumnName(k)) {
        return res.status(400).json({ success: false, message: `Invalid column: ${k}` });
      }
    }

    await db.query('INSERT INTO ?? SET ? ON DUPLICATE KEY UPDATE ?', [table, payload, data || {}]);
    res.json({ success: true, message: 'Module saved' });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'DB Error' });
  }
});

router.post('/admin/delete-module', requireStaff, async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ success: false, message: 'Missing key' });

    const { table, pk } = await resolveType('module');
    const [result] = await db.query('DELETE FROM ?? WHERE ?? = ?', [table, pk, key]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ success: false, message: err.message || 'DB Error' });
  }
});

module.exports = router;
