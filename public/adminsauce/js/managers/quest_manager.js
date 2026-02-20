const QuestManager = {
    config: {
        type: 'quest',
        tableColumns: ['quest_id', 'title', 'required_level', 'quest_type'],
        formFields: [
            'quest_id',
            'title',
            'description',
            'quest_type',
            'category',
            'required_level',
            'is_repeatable',
            'repeat_cooldown_hours',
            'max_completions',
            'objectives_json',
            'rewards_json',
            'is_active'
        ]
    },

    init: async () => {
        document.getElementById('pageTitle').innerText = "QUEST EDITOR";
        document.getElementById('dynamicArea').innerHTML = "Loading Quests...";
        const res = await API.getAll('quest');
        if (res.success) QuestManager.renderTable(res.data);
        else document.getElementById('dynamicArea').innerHTML = `<p class="error">${res.message || 'Failed to load quests'}</p>`;
    },

    renderTable: (data) => {
        let html = `<button class="action-btn save-btn" onclick="QuestManager.edit(null)">+ NEW QUEST</button>`;
        html += `<table><thead><tr>
            <th>QUEST ID</th><th>TITLE</th><th>LVL</th><th>TYPE</th><th>ACTIONS</th>
        </tr></thead><tbody>`;

        (data || []).forEach(q => {
            html += `<tr>
                <td><code>${q.quest_id}</code></td>
                <td><b>${q.title || ''}</b></td>
                <td>${q.required_level || 1}</td>
                <td>${q.quest_type || ''}</td>
                <td>
                    <button class="edit-btn" onclick='QuestManager.edit(${JSON.stringify(q)})'>EDIT</button>
                    <button class="del-btn" onclick="QuestManager.delete('${q.quest_id}')">DEL</button>
                </td>
            </tr>`;
        });

        html += `</tbody></table>`;
        document.getElementById('dynamicArea').innerHTML = html;
    },

    edit: (item) => {
        const data = item || {};
        const isNew = !item;

        let html = `<div class="editor-box visible">
            <h3>${isNew ? "New Quest" : "Edit Quest"}</h3>
            <input type="hidden" id="editId" value="${data.quest_id || ''}">`;

        QuestManager.config.formFields.forEach(f => {
            const label = f.toUpperCase().replace(/_/g, ' ');
            const val = (data[f] === null || data[f] === undefined) ? '' : data[f];

            if (f === 'description') {
                html += `<label>${label}</label>
                         <textarea id="in_${f}" rows="4">${val || ''}</textarea>`;
                return;
            }

            if (f.endsWith('_json')) {
                // Pretty-print JSON if it's already an object; otherwise show raw
                let jsonText = '';
                try {
                    if (typeof val === 'string' && val.trim()) {
                        jsonText = JSON.stringify(JSON.parse(val), null, 2);
                    } else if (typeof val === 'object') {
                        jsonText = JSON.stringify(val, null, 2);
                    }
                } catch {
                    jsonText = val || '';
                }

                // Provide a sane default for new quests
                if (isNew && !jsonText && f === 'objectives_json') {
                    jsonText = JSON.stringify([
                        { key: "obj_1", type: "generic", target: 1, text: "Do the thing" }
                    ], null, 2);
                }
                if (isNew && !jsonText && f === 'rewards_json') {
                    jsonText = JSON.stringify({ xp: 50, gold: 10 }, null, 2);
                }

                html += `<label>${label}</label>
                         <textarea id="in_${f}" rows="8">${jsonText}</textarea>`;
                return;
            }

            // Booleans
            if (f === 'is_repeatable' || f === 'is_active') {
                const checked = String(val) === '1' || val === 1 || val === true ? 'checked' : '';
                html += `<label>${label}</label>
                         <input type="checkbox" id="in_${f}" ${checked}>`;
                return;
            }

            // Numeric fields
            if (['required_level', 'repeat_cooldown_hours', 'max_completions'].includes(f)) {
                html += `<label>${label}</label>
                         <input type="number" id="in_${f}" value="${val || 0}">`;
                return;
            }

            // Default
            html += `<label>${label}</label>
                     <input type="text" id="in_${f}" value="${(val || '').toString().replace(/"/g, '&quot;')}">`;
        });

        html += `<div style="display:flex; gap:10px; margin-top:10px;">
            <button class="action-btn save-btn" onclick="QuestManager.save()">SAVE</button>
            <button class="action-btn" onclick="QuestManager.init()">CANCEL</button>
        </div></div>`;

        document.getElementById('dynamicArea').innerHTML = html;
    },

    save: async () => {
        const id = document.getElementById('editId').value; // quest_id for edits
        const payload = {};

        for (const f of QuestManager.config.formFields) {
            const el = document.getElementById(`in_${f}`);
            if (!el) continue;

            if (f === 'is_repeatable' || f === 'is_active') {
                payload[f] = el.checked ? 1 : 0;
                continue;
            }

            if (f.endsWith('_json')) {
                const txt = el.value || '';
                try {
                    // Validate JSON
                    const parsed = JSON.parse(txt);
                    payload[f] = JSON.stringify(parsed);
                } catch {
                    alert(`${f} must be valid JSON`);
                    return;
                }
                continue;
            }

            if (['required_level', 'repeat_cooldown_hours', 'max_completions'].includes(f)) {
                payload[f] = parseInt(el.value || '0', 10);
                continue;
            }

            payload[f] = el.value;
        }

        // For new quests, quest_id must be set
        if (!id && !payload.quest_id) {
            alert('quest_id is required');
            return;
        }

        const res = await API.save('quest', payload, id || null);
        if (res.success) {
            alert('Saved!');
            QuestManager.init();
        } else {
            alert(res.message || 'Save failed');
        }
    },

    delete: async (questId) => {
        if (!confirm(`Delete quest '${questId}'?`)) return;
        const res = await API.delete('quest', questId);
        if (res.success) QuestManager.init();
        else alert(res.message || 'Delete failed');
    }
};
