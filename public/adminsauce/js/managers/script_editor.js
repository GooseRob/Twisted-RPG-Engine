// =================================================================
// SCRIPT EDITOR v1.0 — Event Action List Builder
// =================================================================
// Used inside the Map Manager when editing EVENTS on tiles.
// Instead of typing raw JSON, admins pick actions from a menu and
// fill in fields. The editor outputs a structured actions array.
//
// USAGE: Called by MapManager when placing/editing an event tile.
//   ScriptEditor.open(existingEvent, callback)
//   callback receives the complete event object with actions array.
// =================================================================

const ScriptEditor = {

    // All supported action types with their fields
    ACTION_TYPES: {
        DIALOGUE:       { label: '💬 Dialogue',       fields: [{ key: 'speaker', label: 'Speaker', type: 'text' }, { key: 'text', label: 'Text', type: 'textarea' }] },
        CHOICE:         { label: '🔀 Choice',         fields: [{ key: 'prompt', label: 'Prompt', type: 'text' }], special: 'choice' },
        SET_FLAG:       { label: '🚩 Set Flag',       fields: [{ key: 'key', label: 'Flag Name', type: 'text' }, { key: 'value', label: 'Value', type: 'text' }] },
        INC_FLAG:       { label: '➕ Inc Flag',       fields: [{ key: 'key', label: 'Flag Name', type: 'text' }, { key: 'amount', label: 'Amount', type: 'number', default: 1 }] },
        TELEPORT:       { label: '🚪 Teleport',       fields: [{ key: 'mapId', label: 'Map ID', type: 'number' }, { key: 'x', label: 'X', type: 'number', default: 10 }, { key: 'y', label: 'Y', type: 'number', default: 10 }] },
        GIVE_ITEM:      { label: '📦 Give Item',      fields: [{ key: 'itemId', label: 'Item ID', type: 'number' }, { key: 'quantity', label: 'Qty', type: 'number', default: 1 }] },
        TAKE_ITEM:      { label: '🗑️ Take Item',     fields: [{ key: 'itemId', label: 'Item ID', type: 'number' }, { key: 'quantity', label: 'Qty', type: 'number', default: 1 }] },
        GIVE_GOLD:      { label: '💰 Give Gold',      fields: [{ key: 'amount', label: 'Amount', type: 'number' }] },
        GIVE_XP:        { label: '⭐ Give XP',        fields: [{ key: 'amount', label: 'Amount', type: 'number' }] },
        HEAL:           { label: '💚 Heal',           fields: [{ key: 'hp', label: 'HP (formula)', type: 'text' }, { key: 'mp', label: 'MP (formula)', type: 'text' }] },
        DAMAGE:         { label: '💥 Damage',         fields: [{ key: 'hp', label: 'HP Damage (formula)', type: 'text' }] },
        QUEST_START:    { label: '📜 Start Quest',    fields: [{ key: 'questId', label: 'Quest ID', type: 'number' }] },
        QUEST_ADVANCE:  { label: '📜 Advance Quest',  fields: [{ key: 'questId', label: 'Quest ID', type: 'number' }] },
        QUEST_COMPLETE: { label: '🏆 Complete Quest', fields: [{ key: 'questId', label: 'Quest ID', type: 'number' }] },
        NPC_TALK:       { label: '🗣️ NPC Talk (AI)', fields: [{ key: 'npcName', label: 'NPC Name', type: 'text' }] },
        SHOP:           { label: '🏪 Open Shop',      fields: [{ key: 'shopId', label: 'Shop ID', type: 'number' }] },
        BATTLE:         { label: '⚔️ Start Battle',   fields: [{ key: 'enemyId', label: 'Enemy ID', type: 'number' }] },
        SOUND:          { label: '🔊 Play Sound',     fields: [{ key: 'file', label: 'Filename', type: 'text' }] },
        SCREEN_EFFECT:  { label: '✨ Screen Effect',  fields: [{ key: 'effect', label: 'Effect (shake/flash/fade)', type: 'text' }, { key: 'duration', label: 'Duration (ms)', type: 'number', default: 500 }] },
        WAIT:           { label: '⏱️ Wait',           fields: [{ key: 'ms', label: 'Milliseconds', type: 'number', default: 1000 }] },
        IF:             { label: '❓ Conditional',     fields: [], special: 'conditional' }
    },

    CONDITION_TYPES: {
        FLAG:     { label: 'Flag Check',  fields: [{ key: 'key', label: 'Flag', type: 'text' }, { key: 'op', label: 'Op (==,!=,>,<)', type: 'text', default: '==' }, { key: 'value', label: 'Value', type: 'text' }] },
        LEVEL:    { label: 'Level Check', fields: [{ key: 'op', label: 'Op', type: 'text', default: '>=' }, { key: 'value', label: 'Level', type: 'number' }] },
        HAS_ITEM: { label: 'Has Item',    fields: [{ key: 'itemId', label: 'Item ID', type: 'number' }, { key: 'quantity', label: 'Qty', type: 'number', default: 1 }] },
        RANDOM:   { label: 'Random %',    fields: [{ key: 'chance', label: '% Chance', type: 'number', default: 50 }] },
        CLASS:    { label: 'Is Class',    fields: [{ key: 'classId', label: 'Class ID', type: 'number' }] }
    },

    // Current state
    _callback: null,
    _event: null,

    // Open the editor
    open: (event, callback) => {
        ScriptEditor._callback = callback;
        ScriptEditor._event = event || {
            trigger: 'INTERACT',
            conditions: [],
            actions: []
        };
        ScriptEditor.render();
    },

    render: () => {
        const ev = ScriptEditor._event;
        const area = document.getElementById('dynamicArea');

        let html = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
            <h3 style="margin:0;color:var(--a)">📝 Event Script Editor</h3>
            <div style="display:flex;gap:8px">
                <button class="action-btn save-btn" onclick="ScriptEditor.save()">💾 SAVE EVENT</button>
                <button class="edit-btn" onclick="ScriptEditor.viewJSON()">{ } JSON</button>
                <button class="edit-btn" onclick="ScriptEditor._callback(null)">CANCEL</button>
            </div>
        </div>

        <!-- TRIGGER TYPE -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
            <div style="background:var(--bg2);padding:16px;border:1px solid var(--b);border-radius:8px">
                <label>TRIGGER</label>
                <select id="se_trigger" onchange="ScriptEditor._event.trigger=this.value">
                    <option value="INTERACT" ${ev.trigger==='INTERACT'?'selected':''}>🖐️ INTERACT (Press E)</option>
                    <option value="STEP_ON" ${ev.trigger==='STEP_ON'?'selected':''}>👣 STEP ON (Walk over)</option>
                    <option value="AUTO" ${ev.trigger==='AUTO'?'selected':''}>⚡ AUTO (On map load)</option>
                </select>
            </div>
            <div style="background:var(--bg2);padding:16px;border:1px solid var(--b);border-radius:8px">
                <label>CONDITIONS <span style="color:var(--td);font-weight:normal">(ALL must pass)</span></label>
                <div id="se_conditions">${ScriptEditor.renderConditions(ev.conditions)}</div>
                <button class="edit-btn" style="margin-top:8px" onclick="ScriptEditor.addCondition()">+ Add Condition</button>
            </div>
        </div>

        <!-- ACTION LIST -->
        <div style="background:var(--bg2);padding:16px;border:1px solid var(--b);border-radius:8px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                <label style="margin:0">ACTIONS <span style="color:var(--td);font-weight:normal">(runs top to bottom)</span></label>
                <div style="display:flex;gap:6px;flex-wrap:wrap">
                    ${Object.entries(ScriptEditor.ACTION_TYPES).map(([key, def]) => 
                        `<button class="edit-btn" style="font-size:11px;padding:4px 8px" onclick="ScriptEditor.addAction('${key}')">${def.label}</button>`
                    ).join('')}
                </div>
            </div>
            <div id="se_actions" style="min-height:60px">
                ${ScriptEditor.renderActions(ev.actions)}
            </div>
        </div>`;

        area.innerHTML = html;
    },

    // --- RENDER ACTION LIST ---
    renderActions: (actions) => {
        if (!actions || actions.length === 0) return '<p style="color:var(--td);text-align:center;padding:20px">No actions yet. Click a button above to add one.</p>';

        return actions.map((action, i) => {
            const def = ScriptEditor.ACTION_TYPES[action.type] || { label: action.type, fields: [] };
            let fieldsHtml = '';

            // Render each field
            for (const f of def.fields) {
                const val = action[f.key] !== undefined ? action[f.key] : (f.default || '');
                if (f.type === 'textarea') {
                    fieldsHtml += `<div style="flex:1;min-width:200px"><label style="font-size:10px">${f.label}</label>
                        <textarea rows="2" onchange="ScriptEditor.updateField(${i},'${f.key}',this.value)" style="resize:vertical">${ScriptEditor._esc(String(val))}</textarea></div>`;
                } else {
                    fieldsHtml += `<div style="min-width:80px"><label style="font-size:10px">${f.label}</label>
                        <input type="${f.type}" value="${ScriptEditor._esc(String(val))}" onchange="ScriptEditor.updateField(${i},'${f.key}',this.value)"></div>`;
                }
            }

            return `<div style="background:var(--bg3);border:1px solid var(--b);border-radius:6px;padding:12px;margin-bottom:8px;position:relative" data-idx="${i}">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                    <span style="color:var(--a);font-weight:600;font-size:13px">#${i + 1} ${def.label}</span>
                    <div style="display:flex;gap:4px">
                        ${i > 0 ? `<button class="edit-btn" style="padding:2px 8px" onclick="ScriptEditor.moveAction(${i},-1)">▲</button>` : ''}
                        ${i < actions.length - 1 ? `<button class="edit-btn" style="padding:2px 8px" onclick="ScriptEditor.moveAction(${i},1)">▼</button>` : ''}
                        <button class="del-btn" style="padding:2px 8px" onclick="ScriptEditor.removeAction(${i})">✕</button>
                    </div>
                </div>
                <div style="display:flex;gap:10px;flex-wrap:wrap">${fieldsHtml}</div>
            </div>`;
        }).join('');
    },

    // --- RENDER CONDITIONS ---
    renderConditions: (conditions) => {
        if (!conditions || conditions.length === 0) return '<span style="color:var(--td);font-size:12px">None (always triggers)</span>';

        return conditions.map((cond, i) => {
            const def = ScriptEditor.CONDITION_TYPES[cond.type] || { label: cond.type, fields: [] };
            const fields = def.fields.map(f => {
                const v = cond[f.key] !== undefined ? cond[f.key] : (f.default || '');
                return `<input type="${f.type}" value="${ScriptEditor._esc(String(v))}" style="width:60px;padding:4px;font-size:11px" 
                    onchange="ScriptEditor.updateCondField(${i},'${f.key}',this.value)" placeholder="${f.label}">`;
            }).join(' ');
            return `<div style="display:flex;gap:6px;align-items:center;margin:4px 0;font-size:12px">
                <span style="color:var(--y)">${def.label}</span> ${fields}
                <button class="del-btn" style="padding:1px 6px;font-size:10px" onclick="ScriptEditor.removeCondition(${i})">✕</button>
            </div>`;
        }).join('');
    },

    // --- MUTATIONS ---
    addAction: (type) => {
        const def = ScriptEditor.ACTION_TYPES[type];
        const action = { type };
        // Set defaults
        for (const f of (def.fields || [])) {
            if (f.default !== undefined) action[f.key] = f.default;
        }
        ScriptEditor._event.actions.push(action);
        ScriptEditor.render();
    },

    removeAction: (index) => {
        ScriptEditor._event.actions.splice(index, 1);
        ScriptEditor.render();
    },

    moveAction: (index, dir) => {
        const arr = ScriptEditor._event.actions;
        const target = index + dir;
        if (target < 0 || target >= arr.length) return;
        [arr[index], arr[target]] = [arr[target], arr[index]];
        ScriptEditor.render();
    },

    updateField: (actionIndex, key, value) => {
        const action = ScriptEditor._event.actions[actionIndex];
        // Auto-convert numbers
        if (!isNaN(value) && value !== '' && key !== 'text' && key !== 'speaker' && key !== 'key' && key !== 'prompt') {
            action[key] = Number(value);
        } else if (value === 'true') action[key] = true;
        else if (value === 'false') action[key] = false;
        else action[key] = value;
    },

    addCondition: () => {
        const types = Object.keys(ScriptEditor.CONDITION_TYPES);
        const type = prompt('Condition type:\n' + types.join(', '));
        if (!type || !ScriptEditor.CONDITION_TYPES[type.toUpperCase()]) return;
        if (!ScriptEditor._event.conditions) ScriptEditor._event.conditions = [];
        ScriptEditor._event.conditions.push({ type: type.toUpperCase() });
        ScriptEditor.render();
    },

    removeCondition: (index) => {
        ScriptEditor._event.conditions.splice(index, 1);
        ScriptEditor.render();
    },

    updateCondField: (condIndex, key, value) => {
        const cond = ScriptEditor._event.conditions[condIndex];
        if (!isNaN(value) && value !== '') cond[key] = Number(value);
        else cond[key] = value;
    },

    // --- SAVE ---
    save: () => {
        const ev = ScriptEditor._event;
        // Clean empty conditions
        if (ev.conditions && ev.conditions.length === 0) delete ev.conditions;
        if (ScriptEditor._callback) ScriptEditor._callback(ev);
    },

    // --- JSON VIEW (for power users) ---
    viewJSON: () => {
        const json = JSON.stringify(ScriptEditor._event, null, 2);
        const edited = prompt('Edit JSON (careful!):', json);
        if (edited) {
            try {
                ScriptEditor._event = JSON.parse(edited);
                ScriptEditor.render();
            } catch (e) { alert('Invalid JSON: ' + e.message); }
        }
    },

    _esc: (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
};
