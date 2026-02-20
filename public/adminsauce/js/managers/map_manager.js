// =================================================================
// MAP MANAGER v3.0 — With Script Editor Integration
// =================================================================
const MapManager = {
    config: {
        type: 'map',
        colors: ['#228822', '#888888', '#2222FF', '#442200'],
        names:  ['Grass',   'Wall',    'Water',   'Dirt'],
        eventIcons: { TELEPORT: '🚪', NPC: '👤', ENEMY: '💀', LOOT: '💎', SHOP: '🏪', SCRIPT: '📝' }
    },

    currentMapId: null,
    currentMapName: '',
    currentTiles: [],
    currentEvents: [],
    activeLayer: 'TILES',
    currentBrush: 1,
    currentTool: 'NPC',

    init: async () => {
        document.getElementById('pageTitle').innerText = "WORLD BUILDER";
        document.getElementById('dynamicArea').innerHTML = "<p>Loading...</p>";
        const r = await API.getAll('map');
        if (r.success) MapManager.renderTable(r.data);
    },

    renderTable: (data) => {
        let h = `<button class="action-btn save-btn" onclick="MapManager.create()">+ NEW MAP</button>`;
        if (!data || !data.length) { h += "<p>No maps yet.</p>"; }
        else {
            h += `<table><thead><tr><th>ID</th><th>NAME</th><th>SIZE</th><th>EVENTS</th><th>ACTIONS</th></tr></thead><tbody>`;
            data.forEach(i => {
                const st = encodeURIComponent(i.tiles_json || '[]');
                const sc = encodeURIComponent(i.collisions_json || '[]');
                let evCount = 0;
                try { evCount = JSON.parse(i.collisions_json || '[]').length; } catch {}
                h += `<tr><td>${i.id}</td><td><b>${i.name}</b></td><td>${i.width}x${i.height}</td><td>${evCount}</td>
                    <td><button class="edit-btn" onclick="MapManager.prepEditor(${i.id},'${i.name.replace(/'/g,"\\'")}','${st}','${sc}')">EDIT</button>
                    <button class="del-btn" onclick="MapManager.deleteMap(${i.id})">DEL</button></td></tr>`;
            });
            h += '</tbody></table>';
        }
        document.getElementById('dynamicArea').innerHTML = h;
    },

    create: async () => {
        const n = prompt("Map Name:");
        if (!n) return;
        const r = await API.save('map', { name: n, width: 20, height: 20, tiles_json: JSON.stringify(Array(400).fill(0)), collisions_json: JSON.stringify([]) });
        if (r.success) MapManager.init();
    },

    prepEditor: (id, name, tE, eE) => {
        MapManager.currentMapId = id;
        MapManager.currentMapName = name;
        try { MapManager.currentTiles = JSON.parse(decodeURIComponent(tE)); if (!MapManager.currentTiles || MapManager.currentTiles.length !== 400) MapManager.currentTiles = Array(400).fill(0); } catch { MapManager.currentTiles = Array(400).fill(0); }
        try { MapManager.currentEvents = JSON.parse(decodeURIComponent(eE)) || []; } catch { MapManager.currentEvents = []; }
        MapManager.renderEditorUI();
    },

    renderEditorUI: () => {
        const name = MapManager.currentMapName;
        document.getElementById('dynamicArea').innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <h3 style="margin:0">Editing: <span style="color:#fff">${name}</span></h3>
            <div style="display:flex;gap:8px">
                <button class="action-btn save-btn" onclick="MapManager.save()">💾 SAVE</button>
                <button class="action-btn" onclick="MapManager.init()" style="background:#333">EXIT</button>
            </div>
        </div>
        <div style="background:#1a1a1a;padding:10px;display:flex;gap:20px;border-bottom:1px solid #444">
            <label style="cursor:pointer;color:${MapManager.activeLayer==='TILES'?'#fff':'#666'}">
                <input type="radio" name="layer" onclick="MapManager.setLayer('TILES')" ${MapManager.activeLayer==='TILES'?'checked':''}> 🖌️ TERRAIN</label>
            <label style="cursor:pointer;color:${MapManager.activeLayer==='EVENTS'?'#fff':'#666'}">
                <input type="radio" name="layer" onclick="MapManager.setLayer('EVENTS')" ${MapManager.activeLayer==='EVENTS'?'checked':''}> ⚙️ EVENTS</label>
        </div>
        <div id="toolbar" style="background:#111;padding:10px;margin-bottom:10px;min-height:40px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"></div>
        <div style="display:flex;gap:20px">
            <div id="mapGrid" style="display:grid;grid-template-columns:repeat(20,20px);grid-template-rows:repeat(20,20px);width:400px;height:400px;background:#000;border:2px solid #555"></div>
            <div style="width:260px;background:#1a1a1a;padding:12px;font-size:12px;border:1px solid #333;border-radius:8px;height:fit-content">
                <h4 style="color:#888;margin-top:0">INSPECTOR</h4>
                <div id="cellInfo">Hover over grid...</div>
            </div>
        </div>`;
        MapManager.renderToolbar();
        MapManager.renderGrid();
    },

    renderToolbar: () => {
        const bar = document.getElementById('toolbar');
        if (MapManager.activeLayer === 'TILES') {
            bar.innerHTML = `<span style="color:#666;font-size:10px">BRUSH:</span>
                ${MapManager.config.names.map((n,i) => `<button onclick="MapManager.setBrush(${i})" style="background:${MapManager.config.colors[i]};border:${MapManager.currentBrush===i?'2px solid white':'1px solid #444'};color:white;padding:5px 10px;cursor:pointer;border-radius:4px">${n}</button>`).join('')}`;
        } else {
            const tools = ['NPC','TELEPORT','ENEMY','LOOT','SHOP','SCRIPT','ERASER'];
            bar.innerHTML = `<span style="color:#666;font-size:10px">TOOL:</span>
                ${tools.map(t => `<button onclick="MapManager.setTool('${t}')" style="background:${MapManager.currentTool===t?'#444':'#222'};border:${MapManager.currentTool===t?'2px solid #bb86fc':'1px solid #444'};color:${t==='ERASER'?'red':t==='SCRIPT'?'#bb86fc':'white'};padding:5px 10px;cursor:pointer;border-radius:4px;font-size:12px">${t==='ERASER'?'❌ DEL':t==='SCRIPT'?'📝 SCRIPT':(MapManager.config.eventIcons[t]||'')+' '+t}</button>`).join('')}
                <span style="color:#555;font-size:10px;margin-left:auto">SCRIPT = new event system</span>`;
        }
    },

    setLayer: (l) => { MapManager.activeLayer = l; MapManager.renderEditorUI(); },
    setBrush: (i) => { MapManager.currentBrush = i; MapManager.renderToolbar(); },
    setTool: (t) => { MapManager.currentTool = t; MapManager.renderToolbar(); },

    renderGrid: () => {
        const g = document.getElementById('mapGrid');
        g.innerHTML = '';
        MapManager.currentTiles.forEach((tv, i) => {
            const c = document.createElement('div'), x = i % 20, y = Math.floor(i / 20);
            c.style.cssText = `width:20px;height:20px;background:${MapManager.config.colors[tv]};border:1px solid rgba(0,0,0,0.1);cursor:pointer;text-align:center;line-height:20px;font-size:14px`;
            const ev = MapManager.currentEvents.find(e => e.x === x && e.y === y);
            if (ev) {
                const icon = ev.actions ? '📝' : (MapManager.config.eventIcons[ev.type] || '?');
                c.innerText = icon;
                c.style.textShadow = '0 0 2px black';
                if (ev.actions) c.style.border = '1px solid #bb86fc';
            }
            c.onmouseover = () => {
                c.style.border = '1px solid white';
                let info = `<b>X:${x} Y:${y}</b><br>Tile: ${MapManager.config.names[tv]}`;
                if (ev) {
                    if (ev.actions) {
                        info += `<br><span style="color:#bb86fc">📝 SCRIPT</span>`;
                        info += `<br>Trigger: <b>${ev.trigger||'INTERACT'}</b>`;
                        info += `<br>Actions: ${ev.actions.length}`;
                        if (ev.conditions && ev.conditions.length) info += `<br>Conditions: ${ev.conditions.length}`;
                    } else {
                        info += `<br><span style="color:#bb86fc">${ev.type}: ${ev.data}</span>`;
                    }
                }
                document.getElementById('cellInfo').innerHTML = info;
            };
            c.onclick = () => MapManager.handleClick(i, x, y);
            g.appendChild(c);
        });
    },

    handleClick: (index, x, y) => {
        if (MapManager.activeLayer === 'TILES') {
            MapManager.currentTiles[index] = MapManager.currentBrush;
            MapManager.renderGrid();
            return;
        }
        const ei = MapManager.currentEvents.findIndex(e => e.x === x && e.y === y);
        const existing = ei >= 0 ? MapManager.currentEvents[ei] : null;

        if (MapManager.currentTool === 'ERASER') {
            if (ei >= 0) MapManager.currentEvents.splice(ei, 1);
            MapManager.renderGrid();
            return;
        }

        // SCRIPT tool — opens the Script Editor
        if (MapManager.currentTool === 'SCRIPT') {
            const event = (existing && existing.actions)
                ? JSON.parse(JSON.stringify(existing))
                : { x, y, trigger: 'INTERACT', conditions: [], actions: [] };

            ScriptEditor.open(event, (result) => {
                if (result === null) { MapManager.renderEditorUI(); return; }
                result.x = x; result.y = y;
                if (ei >= 0) MapManager.currentEvents[ei] = result;
                else MapManager.currentEvents.push(result);
                MapManager.renderEditorUI();
            });
            return;
        }

        // Legacy tools (NPC, TELEPORT, etc)
        let p = 'Enter data:';
        if (MapManager.currentTool === 'NPC') p = 'NPC Name:';
        else if (MapManager.currentTool === 'TELEPORT') p = 'Destination (mapId,x,y):';
        else if (MapManager.currentTool === 'SHOP') p = 'Shop ID:';
        else if (MapManager.currentTool === 'ENEMY') p = 'Enemy ID:';
        else if (MapManager.currentTool === 'LOOT') p = 'Item ID:';

        const d = prompt(p, existing ? existing.data : '');
        if (d) {
            const nE = { x, y, type: MapManager.currentTool, data: d };
            if (ei >= 0) MapManager.currentEvents[ei] = nE;
            else MapManager.currentEvents.push(nE);
        }
        MapManager.renderGrid();
    },

    save: async () => {
        const payload = { tiles_json: JSON.stringify(MapManager.currentTiles), collisions_json: JSON.stringify(MapManager.currentEvents) };
        const r = await API.save('map', payload, MapManager.currentMapId);
        if (r.success) { await API.clearCache(MapManager.currentMapId); alert('Saved & cache cleared!'); }
        else alert('Error: ' + r.message);
    },

    deleteMap: async (id) => {
        if (confirm('Delete map?')) { await API.delete('map', id); MapManager.init(); }
    }
};
