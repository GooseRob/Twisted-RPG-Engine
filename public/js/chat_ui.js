// =================================================================
// CHAT UI — 7-Channel Messaging System
// =================================================================
// Teaching: This file handles everything visual about chat.
// The server (server.js) handles routing messages to the right
// players. We just send to the server and display what comes back.
//
// Channels:
//   global   — everyone online                 [white]
//   local    — same map only                   [green]
//   party    — party members (stub)            [blue]
//   guild    — guild members (stub)            [orange]
//   dm       — direct message to one player   [pink]
//   announce — staff broadcasts               [yellow, bold]
//   admin    — staff only                     [red]
//   system   — server messages to you alone   [gray]
//
// Hotkeys (only when chat is NOT focused):
//   [ Enter ]  — focus chat input
//   [ 1-7 ]    — quick channel switch (when not in chat input)
//
// Design: persistent panel bottom-left, collapsible, never blocks game
// =================================================================

const ChatUI = {
    // ---------------------------------------------------------------
    // STATE
    // ---------------------------------------------------------------
    collapsed: false,
    activeChannel: 'global',
    dmTarget: null,       // { charId, name } — set when sending DMs
    unread: {},           // channel -> count of unread messages
    history: {},          // channel -> [ {from, text, ts, fromCharId, targetName} ]
    isStaff: false,       // set from init_self role
    MAX_HISTORY: 100,     // messages kept per channel in memory

    // Channel config (order = tab order)
    CHANNELS: [
        { key: 'global',   label: 'Global',   color: '#e8eef6', icon: '🌐' },
        { key: 'local',    label: 'Zone',     color: '#88ff88', icon: '📍' },
        { key: 'party',    label: 'Party',    color: '#88aaff', icon: '⚔️' },
        { key: 'guild',    label: 'Guild',    color: '#ffaa44', icon: '🏰' },
        { key: 'dm',       label: 'DM',       color: '#ff88ff', icon: '✉️' },
        { key: 'announce', label: 'Announce', color: '#ffff55', icon: '📢' },
        { key: 'admin',    label: 'Admin',    color: '#ff5555', icon: '🔑', staffOnly: true },
    ],

    // ---------------------------------------------------------------
    // INIT — call once after Game is loaded
    // ---------------------------------------------------------------
    init(isStaffUser) {
        ChatUI.isStaff = !!isStaffUser;

        // Pre-populate history buckets
        ChatUI.CHANNELS.forEach(c => {
            ChatUI.history[c.key] = [];
            ChatUI.unread[c.key]  = 0;
        });
        ChatUI.history['system'] = [];

        ChatUI._buildDOM();
        ChatUI._bindSocketEvents();
        ChatUI._bindHotkeys();

        // Welcome message
        ChatUI._addMessage({
            channel: 'system',
            from: 'System',
            text: 'Chat ready! Press Enter to focus. Use tabs to switch channels.',
            ts: Date.now()
        });
    },

    // ---------------------------------------------------------------
    // DOM CONSTRUCTION
    // ---------------------------------------------------------------
    _buildDOM() {
        const panel = document.createElement('div');
        panel.id = 'chatPanel';

        // Channel tabs HTML — hide admin tab for non-staff
        const tabsHtml = ChatUI.CHANNELS
            .filter(c => !c.staffOnly || ChatUI.isStaff)
            .map(c => `
                <div class="chat-tab" id="ctab-${c.key}" data-ch="${c.key}"
                     onclick="ChatUI.switchChannel('${c.key}')"
                     title="${c.label}">
                    ${c.icon} <span class="tab-lbl">${c.label}</span>
                    <span class="chat-badge" id="cbadge-${c.key}" style="display:none">0</span>
                </div>`
            ).join('');

        panel.innerHTML = `
            <div id="chatHeader" onclick="ChatUI.toggleCollapse()">
                💬 CHAT
                <span id="chatCollapseIcon" style="float:right;opacity:0.6">▲</span>
            </div>

            <div id="chatBody">
                <!-- Tab row -->
                <div id="chatTabs">${tabsHtml}</div>

                <!-- DM target row (hidden unless DM channel active) -->
                <div id="chatDmRow" style="display:none">
                    <input id="chatDmInput" type="text" placeholder="Type name then Enter…"
                           title="Type the player's character name to start a DM" />
                    <span id="chatDmLabel" style="color:#ff88ff;font-size:11px;padding-left:6px"></span>
                </div>

                <!-- Message list -->
                <div id="chatMessages"></div>

                <!-- Input row -->
                <div id="chatInputRow">
                    <input id="chatInput" type="text" maxlength="300"
                           placeholder="Press Enter to chat…" autocomplete="off" />
                    <button id="chatSendBtn" onclick="ChatUI.send()">▶</button>
                </div>
            </div>`;

        document.body.appendChild(panel);
        ChatUI._injectStyles();
        ChatUI._applyTabActive();
        ChatUI._bindInputKeys();
    },

    _injectStyles() {
        const s = document.createElement('style');
        s.textContent = `
        #chatPanel {
            position: fixed;
            bottom: 10px;
            left: 10px;
            width: 340px;
            background: rgba(5, 8, 14, 0.88);
            border: 1px solid rgba(255,255,255,0.13);
            border-radius: 10px;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            z-index: 50;
            user-select: none;
        }
        #chatHeader {
            padding: 7px 12px;
            color: #bb86fc;
            font-weight: bold;
            font-size: 12px;
            cursor: pointer;
            border-bottom: 1px solid rgba(255,255,255,0.07);
            letter-spacing: 1px;
        }
        #chatHeader:hover { background: rgba(255,255,255,0.03); border-radius: 10px 10px 0 0; }
        #chatBody { display: flex; flex-direction: column; }
        #chatTabs {
            display: flex;
            gap: 2px;
            padding: 5px 6px 0;
            overflow-x: auto;
            scrollbar-width: none;
        }
        #chatTabs::-webkit-scrollbar { display: none; }
        .chat-tab {
            padding: 4px 8px;
            border-radius: 6px 6px 0 0;
            cursor: pointer;
            font-size: 11px;
            color: #666;
            border: 1px solid transparent;
            border-bottom: none;
            white-space: nowrap;
            position: relative;
            transition: 0.15s;
        }
        .chat-tab:hover { color: #aaa; background: rgba(255,255,255,0.04); }
        .chat-tab.active { color: #e8eef6; background: rgba(255,255,255,0.07); border-color: rgba(255,255,255,0.1); }
        .tab-lbl { display: none; }
        .chat-tab.active .tab-lbl { display: inline; }
        .chat-badge {
            position: absolute;
            top: 0; right: 0;
            background: #f85149;
            color: #fff;
            border-radius: 8px;
            font-size: 9px;
            padding: 0 3px;
            min-width: 14px;
            text-align: center;
        }
        #chatDmRow {
            display: flex;
            align-items: center;
            padding: 4px 8px;
            background: rgba(255,136,255,0.05);
            border-bottom: 1px solid rgba(255,136,255,0.1);
        }
        #chatDmInput {
            flex: 1;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,136,255,0.3);
            color: #ff88ff;
            padding: 3px 6px;
            font-family: 'Courier New', monospace;
            font-size: 11px;
            border-radius: 4px;
            outline: none;
        }
        #chatMessages {
            height: 180px;
            overflow-y: auto;
            padding: 6px 10px;
            display: flex;
            flex-direction: column;
            gap: 3px;
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.1) transparent;
        }
        .chat-line { line-height: 1.4; word-break: break-word; }
        .chat-ts { color: #444; font-size: 10px; }
        .chat-name { font-weight: bold; cursor: pointer; }
        .chat-name:hover { text-decoration: underline; }
        #chatInputRow {
            display: flex;
            gap: 6px;
            padding: 6px 8px;
            border-top: 1px solid rgba(255,255,255,0.07);
        }
        #chatInput {
            flex: 1;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.12);
            color: #e8eef6;
            padding: 5px 8px;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            border-radius: 6px;
            outline: none;
            transition: border 0.15s;
            user-select: text;
        }
        #chatInput:focus { border-color: #bb86fc; }
        #chatSendBtn {
            background: rgba(187,134,252,0.15);
            border: 1px solid rgba(187,134,252,0.3);
            color: #bb86fc;
            padding: 5px 10px;
            cursor: pointer;
            border-radius: 6px;
            font-size: 13px;
            transition: 0.15s;
        }
        #chatSendBtn:hover { background: rgba(187,134,252,0.3); }

        /* Collapsed state */
        #chatPanel.collapsed #chatBody { display: none; }
        #chatPanel.collapsed { border-radius: 10px; }
        `;
        document.head.appendChild(s);
    },

    // ---------------------------------------------------------------
    // INPUT KEYBOARD HANDLING
    // ---------------------------------------------------------------
    _bindInputKeys() {
        const input = document.getElementById('chatInput');
        const dmInput = document.getElementById('chatDmInput');

        // Main chat input: Enter sends
        input.addEventListener('keydown', (e) => {
            e.stopPropagation(); // CRITICAL: prevents WASD etc from firing game movement
            if (e.key === 'Enter') { ChatUI.send(); }
            if (e.key === 'Escape') { input.blur(); }
        });

        // DM target input: Enter confirms target
        dmInput.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                ChatUI._resolveDmTarget(dmInput.value.trim());
                dmInput.blur();
                document.getElementById('chatInput').focus();
            }
            if (e.key === 'Escape') { dmInput.blur(); }
        });
    },

    _bindHotkeys() {
        // Global hotkey: Enter focuses chat input (when nothing is focused)
        window.addEventListener('keydown', (e) => {
            // Only act if game input isn't consumed elsewhere
            if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
            if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;

            // Enter: focus chat
            if (e.key === 'Enter' && !ChatUI.collapsed) {
                e.preventDefault();
                document.getElementById('chatInput').focus();
            }
        });
    },

    // ---------------------------------------------------------------
    // SOCKET EVENTS
    // ---------------------------------------------------------------
    _bindSocketEvents() {
        // Game object may not exist yet — wait for it
        const tryBind = () => {
            if (typeof Game === 'undefined' || !Game.socket) {
                setTimeout(tryBind, 100);
                return;
            }
            Game.socket.on('chat_msg', (msg) => ChatUI._addMessage(msg));
        };
        tryBind();
    },

    // ---------------------------------------------------------------
    // MESSAGE HANDLING
    // ---------------------------------------------------------------
    _addMessage(msg) {
        const ch = msg.channel || 'system';

        // Store in history
        if (!ChatUI.history[ch]) ChatUI.history[ch] = [];
        ChatUI.history[ch].push(msg);
        if (ChatUI.history[ch].length > ChatUI.MAX_HISTORY) {
            ChatUI.history[ch].shift();
        }

        // Unread badge when not on this channel
        if (ch !== ChatUI.activeChannel && ch !== 'system') {
            ChatUI.unread[ch] = (ChatUI.unread[ch] || 0) + 1;
            ChatUI._updateBadge(ch);
        }

        // If this is our active channel (or system msg) render it
        if (ch === ChatUI.activeChannel || ch === 'system') {
            ChatUI._renderMessage(msg);
        }

        // For announces: always show regardless of channel
        if (ch === 'announce' && ChatUI.activeChannel !== 'announce') {
            ChatUI._renderMessage(msg, true); // forceShow
        }
    },

    _renderMessage(msg, forceShow = false) {
        const box = document.getElementById('chatMessages');
        if (!box) return;

        const ch = msg.channel || 'system';
        const cfg = ChatUI.CHANNELS.find(c => c.key === ch);
        const color = cfg ? cfg.color : '#888888';

        const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const nameClick = (msg.fromCharId && msg.fromCharId !== (typeof Game !== 'undefined' ? Game.myCharId : -1))
            ? `onclick="ChatUI.startDM(${msg.fromCharId}, '${ChatUI._esc(msg.from)}')" title="DM ${ChatUI._esc(msg.from)}"`
            : '';

        // Prefix for forced announces shown in other channels
        const prefix = forceShow ? `<span style="color:#ffff55;font-weight:bold">[📢] </span>` : '';

        // DM direction label
        let dmLabel = '';
        if (ch === 'dm' && msg.targetName) {
            const isMe = msg.fromCharId === (typeof Game !== 'undefined' ? Game.myCharId : -1);
            dmLabel = isMe
                ? `<span style="color:#888;font-size:10px"> → ${msg.targetName}</span>`
                : `<span style="color:#888;font-size:10px"> [DM]</span>`;
        }

        const line = document.createElement('div');
        line.className = 'chat-line';
        line.innerHTML = `${prefix}<span class="chat-ts">[${time}]</span> `
            + `<span class="chat-name" style="color:${color}" ${nameClick}>${ChatUI._esc(msg.from)}</span>`
            + `${dmLabel}: `
            + `<span style="color:${ch === 'system' ? '#888' : '#ccc'}">${msg.text}</span>`;

        box.appendChild(line);

        // Auto-scroll to bottom
        box.scrollTop = box.scrollHeight;

        // Cap rendered lines at 200 DOM elements
        while (box.children.length > 200) box.removeChild(box.firstChild);
    },

    // ---------------------------------------------------------------
    // SENDING
    // ---------------------------------------------------------------
    send() {
        const input = document.getElementById('chatInput');
        const text = (input.value || '').trim();
        if (!text) return;

        if (typeof Game === 'undefined' || !Game.socket) return;

        const payload = { channel: ChatUI.activeChannel, text };
        if (ChatUI.activeChannel === 'dm') {
            if (!ChatUI.dmTarget) {
                ChatUI._addMessage({ channel: 'system', from: 'System', text: 'Set a DM target first — type their name in the pink box above.', ts: Date.now() });
                return;
            }
            payload.targetCharId = ChatUI.dmTarget.charId;
        }

        Game.socket.emit('chat_send', payload);
        input.value = '';
    },

    // ---------------------------------------------------------------
    // CHANNEL SWITCHING
    // ---------------------------------------------------------------
    switchChannel(key) {
        ChatUI.activeChannel = key;
        ChatUI.unread[key] = 0;
        ChatUI._updateBadge(key);
        ChatUI._applyTabActive();

        // Show/hide DM target row
        const dmRow = document.getElementById('chatDmRow');
        if (dmRow) dmRow.style.display = key === 'dm' ? 'flex' : 'none';

        // Re-render messages for this channel
        ChatUI._redrawMessages();

        // Focus input
        const inp = document.getElementById('chatInput');
        if (inp) inp.focus();
    },

    _applyTabActive() {
        document.querySelectorAll('.chat-tab').forEach(el => {
            el.classList.toggle('active', el.dataset.ch === ChatUI.activeChannel);
        });
        // Update placeholder based on channel
        const inp = document.getElementById('chatInput');
        if (!inp) return;
        const cfg = ChatUI.CHANNELS.find(c => c.key === ChatUI.activeChannel);
        inp.placeholder = cfg ? `${cfg.icon} ${cfg.label}…` : 'Message…';
        inp.style.borderColor = (cfg && ChatUI.activeChannel !== 'global') ? cfg.color + '55' : '';
    },

    _redrawMessages() {
        const box = document.getElementById('chatMessages');
        if (!box) return;
        box.innerHTML = '';
        const msgs = ChatUI.history[ChatUI.activeChannel] || [];
        msgs.forEach(m => ChatUI._renderMessage(m));
        box.scrollTop = box.scrollHeight;
    },

    _updateBadge(ch) {
        const badge = document.getElementById('cbadge-' + ch);
        if (!badge) return;
        const count = ChatUI.unread[ch] || 0;
        badge.style.display = count > 0 ? 'inline' : 'none';
        badge.textContent = count > 99 ? '99+' : count;
    },

    // ---------------------------------------------------------------
    // DM HELPERS
    // ---------------------------------------------------------------
    startDM(charId, name) {
        ChatUI.switchChannel('dm');
        ChatUI.dmTarget = { charId, name };
        const label = document.getElementById('chatDmLabel');
        const inp = document.getElementById('chatDmInput');
        if (label) label.textContent = `→ ${name}`;
        if (inp) inp.value = name;
        document.getElementById('chatInput').focus();
    },

    _resolveDmTarget(name) {
        if (!name) return;
        // Try to find in online players — Game.players is charId -> player object
        if (typeof Game !== 'undefined') {
            const found = Object.values(Game.players).find(
                p => p.name.toLowerCase() === name.toLowerCase() && p.charId !== Game.myCharId
            );
            if (found) {
                ChatUI.dmTarget = { charId: found.charId, name: found.name };
                const label = document.getElementById('chatDmLabel');
                if (label) label.textContent = `→ ${found.name}`;
                return;
            }
        }
        // Not found in local list — still store name; server will reject if offline
        ChatUI.dmTarget = { charId: null, name };
        const label = document.getElementById('chatDmLabel');
        if (label) label.textContent = `→ ${name} (may be offline)`;
    },

    // ---------------------------------------------------------------
    // COLLAPSE TOGGLE
    // ---------------------------------------------------------------
    toggleCollapse() {
        ChatUI.collapsed = !ChatUI.collapsed;
        document.getElementById('chatPanel').classList.toggle('collapsed', ChatUI.collapsed);
        document.getElementById('chatCollapseIcon').textContent = ChatUI.collapsed ? '▼' : '▲';
    },

    // ---------------------------------------------------------------
    // UTIL
    // ---------------------------------------------------------------
    _esc(s) { return String(s || '').replace(/'/g, '&#39;').replace(/</g, '&lt;'); },
};
