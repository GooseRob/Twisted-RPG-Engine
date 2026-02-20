// =================================================================
// NPC BRAIN (Rule-based fallback, LLM when available)
// =================================================================
// TEACHING: This file handles NPC conversations. It has two modes:
//   1. LLM Mode: Sends a prompt to an AI model (like Ollama)
//   2. Rule Mode: Uses keyword matching as a fallback
// You can run Ollama locally: ollama run llama3
// Then set NPC_LLM_URL=http://localhost:11434/api/generate

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function containsAny(s, words) { return words.some(w => s.toLowerCase().includes(w)); }

async function callLLM({ url, model, prompt }) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const json = await res.json();
    return String(json.response || json.text || '').trim();
}

function buildPrompt({ npc, player, message, history }) {
    const hist = (history || []).slice(-8)
        .map(h => (h.role === 'user' ? `PLAYER: ${h.text}` : `${npc.name.toUpperCase()}: ${h.text}`))
        .join('\n');
    return [
        `You are ${npc.name}.`,
        `Persona: ${npc.persona || 'A character in a dark fantasy world.'}`,
        `You are speaking to ${player.name}.`,
        `Rules: Reply in 1-3 short paragraphs. Stay in character. No OOC.`,
        ``, hist ? `Conversation so far:\n${hist}\n` : ``,
        `PLAYER: ${message}`, `${npc.name.toUpperCase()}:`,
    ].join('\n');
}

function ruleBasedReply({ npc, message }) {
    const s = message.trim();
    if (containsAny(s, ['hello', 'hi', 'hey', 'yo']))
        return pick([`*${npc.name} looks you over.* "You're new around here, aren't you?"`, `"Keep your voice down. Walls have ears."`, `"Huh. Another traveler. Try not to bleed on my floor."`]);
    if (containsAny(s, ['quest', 'job', 'work', 'help']))
        return pick([`"If you want work, check the notice board—if it hasn't been stolen."`, `"I might know something… but nothing's free. Not anymore."`, `"Help? Depends. Are you brave… or just desperate?"`]);
    if (containsAny(s, ['where', 'map', 'town', 'dungeon']))
        return pick([`"This district? Safe enough if you keep moving. Don't linger."`, `"The road east leads to old stonework and bad memories. Take a torch."`, `"You'll find answers underground. That's where everyone hides their sins."`]);
    if (containsAny(s, ['who are you', 'name', 'what are you']))
        return pick([`"Names are expensive. Call me ${npc.name} and leave it at that."`, `"I was something else once. Now I'm just ${npc.name}."`]);
    if (containsAny(s, ['buy', 'sell', 'shop', 'store', 'trade']))
        return pick([`"Got coin? I might have what you need."`, `"Take a look at what I've got. No refunds."`, `"Everything has a price in this world."`]);
    if (containsAny(s, ['bye', 'goodbye', 'leave', 'later']))
        return pick([`"Watch your back out there."`, `"Don't die. It's bad for business."`, `*${npc.name} nods.* "Until next time."`]);
    return pick([`"Careful. That kind of talk gets people noticed."`, `"Maybe. Maybe not. Depends what you're willing to risk."`, `"Say what you mean, traveler. I don't have all night."`]);
}

async function getNpcReply({ npc, player, message, history }) {
    const url = process.env.NPC_LLM_URL;
    const model = process.env.NPC_LLM_MODEL || 'llama3';
    if (url) {
        try {
            const prompt = buildPrompt({ npc, player, message, history });
            const out = await callLLM({ url, model, prompt });
            if (out) return out;
        } catch (err) { console.warn('NPC LLM failed, using fallback:', err.message); }
    }
    return ruleBasedReply({ npc, message });
}

module.exports = { getNpcReply };
