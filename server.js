const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { WebSocketServer } = require('ws');
const OpenAI = require('openai').default || require('openai');
const { MongoClient } = require('mongodb'); // ← ADDED: MongoDB driver

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

const AI_BOT_EMAIL = 'ai@talk.local';
const AI_BOT_NAME = 'Talk AI';

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '20mb' }));

// ── REMOVED: const dataFile = ... (no longer using data.json) ──────────────
const ADMIN_EMAIL = 'hridaymittal85@gmail.com';
const ADMIN_PASSWORD = 'hello05';
const ADMIN_NAME = 'Hriday';

function defaultData() {
    return { users: {}, messages: {}, groups: {}, groupMessages: {}, callHistory: [], feedback: [], leaderboard: {}, challenges: {} };
}

// ── CHANGED: MongoDB persistence replaces data.json ────────────────────────
let _mongo, _cachedData = null;

function readData() { return _cachedData; }

function writeData(d) {
    _cachedData = d;
    _mongo.db('talk').collection('appdata')
        .replaceOne({ _id: 'singleton' }, { _id: 'singleton', ...d }, { upsert: true })
        .catch(err => console.error('MongoDB write error:', err));
}

async function connectDB() {
    _mongo = new MongoClient(process.env.MONGODB_URI);
    await _mongo.connect();
    console.log('Connected to MongoDB');
    const doc = await _mongo.db('talk').collection('appdata').findOne({ _id: 'singleton' });
    _cachedData = doc ? (({ _id, ...rest }) => rest)(doc) : defaultData();
    const d = _cachedData;
    if (!d.groups) d.groups = {};
    if (!d.groupMessages) d.groupMessages = {};
    if (!d.messages) d.messages = {};
    if (!d.users) d.users = {};
    if (!d.callHistory) d.callHistory = [];
    if (!d.feedback) d.feedback = [];
    if (!d.leaderboard) d.leaderboard = {};
    if (!d.challenges) d.challenges = {};
    for (const u of Object.values(d.users)) {
        if (!Array.isArray(u.contacts)) u.contacts = [];
        if (!Array.isArray(u.blocked)) u.blocked = [];
        if (u.avatar === undefined) u.avatar = null;
        if (!u.status) u.status = 'available';
    }
    for (const conv of Object.values(d.messages)) {
        for (const m of conv) {
            if (!m.reactions) m.reactions = {};
            if (!m.readBy) m.readBy = [];
            if (m.deleted === undefined) m.deleted = false;
        }
    }
    for (const conv of Object.values(d.groupMessages)) {
        for (const m of conv) {
            if (!m.reactions) m.reactions = {};
            if (m.deleted === undefined) m.deleted = false;
        }
    }
    ensureAdmin(); // ← called here after data is loaded
}
// ──────────────────────────────────────────────────────────────────────────

// ── CHANGED: was an auto-running IIFE, now a plain function called from connectDB ──
function ensureAdmin() {
    const d = readData();
    if (!d.users[ADMIN_EMAIL]) {
        d.users[ADMIN_EMAIL] = {
            id: 'admin_' + Date.now().toString(36),
            name: ADMIN_NAME,
            email: ADMIN_EMAIL,
            password: ADMIN_PASSWORD,
            avatar: '👑',
            status: 'available',
            contacts: [],
            blocked: [],
            isAdmin: true,
            createdAt: new Date().toISOString(),
        };
        writeData(d);
        console.log('Admin account created:', ADMIN_EMAIL);
    } else if (!d.users[ADMIN_EMAIL].isAdmin) {
        d.users[ADMIN_EMAIL].isAdmin = true;
        d.users[ADMIN_EMAIL].password = ADMIN_PASSWORD;
        writeData(d);
    }
}

let openaiClient = null;
function getOpenAI() {
    if (openaiClient) return openaiClient;
    const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    if (!apiKey || !baseURL) return null;
    openaiClient = new OpenAI({ apiKey, baseURL });
    return openaiClient;
}

function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- Auth ----------
app.post('/api/signup', (req, res) => {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (email === AI_BOT_EMAIL) return res.status(400).json({ error: 'That email is reserved.' });
    const data = readData();
    if (data.users[email]) return res.status(400).json({ error: 'Email already registered' });
    const newUser = { id: newId(), name, email, password, avatar: null, status: 'available', contacts: [], blocked: [], createdAt: new Date().toISOString() };
    data.users[email] = newUser;
    writeData(data);
    res.json({ success: true, user: { id: newUser.id, name, email, status: 'available' } });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const data = readData();
    const user = data.users[email];
    if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid email or password' });
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar || null, status: user.status || 'available' } });
});

app.post('/api/reset-password', (req, res) => {
    const { email, newPassword } = req.body || {};
    if (!email || !newPassword) return res.status(400).json({ error: 'Email and new password required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const data = readData();
    const user = data.users[email];
    if (!user) return res.status(404).json({ error: 'No account found for that email' });
    user.password = newPassword;
    writeData(data);
    res.json({ success: true });
});

// ---------- Users ----------
app.get('/api/users', (req, res) => {
    const data = readData();
    const users = Object.values(data.users).map(u => ({ id: u.id, name: u.name, email: u.email, avatar: u.avatar || null, status: u.status || 'available' }));
    res.json({ users });
});

// Profile update (name + avatar emoji + status)
app.patch('/api/users/:email/profile', (req, res) => {
    const { email } = req.params;
    const { avatar, name, status } = req.body || {};
    const data = readData();
    const user = data.users[email];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (avatar !== undefined) user.avatar = avatar || null;
    if (name && name.trim().length > 0) user.name = name.trim().slice(0, 50);
    if (status && ['available', 'away', 'busy', 'dnd'].includes(status)) user.status = status;
    writeData(data);
    // Broadcast status change to everyone
    const out = { type: 'user-status', email, status: user.status, avatar: user.avatar, name: user.name };
    for (const [, ws] of clients) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(out)); }
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar, status: user.status } });
});

// Get contact list
app.get('/api/users/:email/contacts', (req, res) => {
    const { email } = req.params;
    const data = readData();
    const user = data.users[email];
    if (!user) return res.status(404).json({ error: 'User not found' });
    const contacts = (user.contacts || []).map(c => {
        const u = data.users[c];
        if (!u) return null;
        return { id: u.id, name: u.name, email: u.email, avatar: u.avatar || null, status: u.status || 'available' };
    }).filter(Boolean);
    res.json({ contacts, blocked: user.blocked || [] });
});

// Add contact
app.post('/api/users/:email/contacts', (req, res) => {
    const { email } = req.params;
    const { contactEmail } = req.body || {};
    if (!contactEmail) return res.status(400).json({ error: 'contactEmail required' });
    if (contactEmail === email) return res.status(400).json({ error: 'Cannot add yourself' });
    const data = readData();
    const user = data.users[email];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!data.users[contactEmail] && contactEmail !== AI_BOT_EMAIL)
        return res.status(404).json({ error: 'That person is not on Talk yet' });
    if (!Array.isArray(user.contacts)) user.contacts = [];
    if (!user.contacts.includes(contactEmail)) {
        user.contacts.push(contactEmail);
        writeData(data);
    }
    res.json({ success: true });
});

// Remove contact
app.delete('/api/users/:email/contacts/:target', (req, res) => {
    const { email, target } = req.params;
    const data = readData();
    const user = data.users[email];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!Array.isArray(user.contacts)) user.contacts = [];
    user.contacts = user.contacts.filter(c => c !== target);
    writeData(data);
    res.json({ success: true });
});

// Block / unblock contact
app.post('/api/users/:email/block', (req, res) => {
    const { email } = req.params;
    const { targetEmail, block } = req.body || {};
    if (!targetEmail) return res.status(400).json({ error: 'targetEmail required' });
    const data = readData();
    const user = data.users[email];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!Array.isArray(user.blocked)) user.blocked = [];
    if (block) {
        if (!user.blocked.includes(targetEmail)) user.blocked.push(targetEmail);
    } else {
        user.blocked = user.blocked.filter(b => b !== targetEmail);
    }
    writeData(data);
    res.json({ success: true, blocked: user.blocked });
});

// ---------- Direct messages ----------
app.get('/api/messages/:email1/:email2', (req, res) => {
    const { email1, email2 } = req.params;
    const data = readData();
    const key = [email1, email2].sort().join('_');
    const msgs = (data.messages[key] || []).map(m => {
        if (m.challengeId && data.challenges[m.challengeId]) {
            return { ...m, _challenge: data.challenges[m.challengeId] };
        }
        return m;
    });
    res.json({ messages: msgs });
});

app.post('/api/messages', async (req, res) => {
    const { senderEmail, receiverEmail, text, fileData, fileName, fileType, voiceData, voiceDuration } = req.body || {};
    if (!senderEmail || !receiverEmail) return res.status(400).json({ error: 'Sender and receiver required' });
    if (!text && !fileData && !voiceData) return res.status(400).json({ error: 'Message content required' });
    const data = readData();
    if (!data.users[senderEmail]) return res.status(404).json({ error: 'Sender not found' });
    if (receiverEmail !== AI_BOT_EMAIL && !data.users[receiverEmail]) {
        return res.status(404).json({ error: 'Recipient is not on Talk yet' });
    }
    if (receiverEmail !== AI_BOT_EMAIL) {
        const receiver = data.users[receiverEmail];
        if (receiver?.blocked?.includes(senderEmail)) {
            return res.status(403).json({ error: 'Message blocked' });
        }
    }
    const saved = saveDirectMessage(senderEmail, receiverEmail, { text, fileData, fileName, fileType, voiceData, voiceDuration });
    sendTo(receiverEmail, { type: 'message', message: saved });
    if (receiverEmail === AI_BOT_EMAIL) {
        respondAsAI(senderEmail).catch(err => console.error('AI reply failed:', err));
    }
    res.json({ success: true, message: saved });
});

// Edit DM
app.patch('/api/messages/:msgId', (req, res) => {
    const { msgId } = req.params;
    const { email, text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    const data = readData();
    for (const [key, msgs] of Object.entries(data.messages)) {
        const idx = msgs.findIndex(m => m.id === msgId);
        if (idx >= 0) {
            if (msgs[idx].senderEmail !== email) return res.status(403).json({ error: 'Not your message' });
            msgs[idx].text = text.trim().slice(0, 4000);
            msgs[idx].edited = true;
            writeData(data);
            const updated = msgs[idx];
            const participants = key.split('_');
            for (const p of participants) sendTo(p, { type: 'message-edited', message: updated });
            return res.json({ success: true, message: updated });
        }
    }
    res.status(404).json({ error: 'Message not found' });
});

// Delete DM
app.delete('/api/messages/:msgId', (req, res) => {
    const { msgId } = req.params;
    const { email } = req.body || {};
    const data = readData();
    for (const [key, msgs] of Object.entries(data.messages)) {
        const idx = msgs.findIndex(m => m.id === msgId);
        if (idx >= 0) {
            if (msgs[idx].senderEmail !== email) return res.status(403).json({ error: 'Not your message' });
            msgs[idx].deleted = true;
            msgs[idx].text = '';
            msgs[idx].fileData = null;
            msgs[idx].voiceData = null;
            writeData(data);
            const participants = key.split('_');
            for (const p of participants) sendTo(p, { type: 'message-deleted', messageId: msgId });
            return res.json({ success: true });
        }
    }
    res.status(404).json({ error: 'Message not found' });
});

// React to DM
app.post('/api/messages/:msgId/react', (req, res) => {
    const { msgId } = req.params;
    const { email, emoji } = req.body || {};
    if (!email || !emoji) return res.status(400).json({ error: 'email and emoji required' });
    const data = readData();
    for (const [key, msgs] of Object.entries(data.messages)) {
        const idx = msgs.findIndex(m => m.id === msgId);
        if (idx >= 0) {
            if (!msgs[idx].reactions) msgs[idx].reactions = {};
            if (!msgs[idx].reactions[emoji]) msgs[idx].reactions[emoji] = [];
            const arr = msgs[idx].reactions[emoji];
            const pos = arr.indexOf(email);
            if (pos >= 0) arr.splice(pos, 1); else arr.push(email);
            if (arr.length === 0) delete msgs[idx].reactions[emoji];
            writeData(data);
            const participants = key.split('_');
            for (const p of participants) sendTo(p, { type: 'message-reacted', messageId: msgId, reactions: msgs[idx].reactions });
            return res.json({ success: true, reactions: msgs[idx].reactions });
        }
    }
    res.status(404).json({ error: 'Message not found' });
});

// Mark DM read
app.post('/api/messages/:email1/:email2/read', (req, res) => {
    const { email1, email2 } = req.params;
    const { reader } = req.body || {};
    const data = readData();
    const key = [email1, email2].sort().join('_');
    const msgs = data.messages[key] || [];
    let changed = false;
    for (const m of msgs) {
        if (m.senderEmail !== reader && !m.readBy?.includes(reader)) {
            if (!m.readBy) m.readBy = [];
            m.readBy.push(reader);
            changed = true;
        }
    }
    if (changed) {
        writeData(data);
        const otherEmail = reader === email1 ? email2 : email1;
        sendTo(otherEmail, { type: 'messages-read', by: reader, convKey: key });
    }
    res.json({ success: true });
});

function saveDirectMessage(senderEmail, receiverEmail, content) {
    const data = readData();
    const key = [senderEmail, receiverEmail].sort().join('_');
    if (!data.messages[key]) data.messages[key] = [];
    const msg = {
        id: newId(),
        senderEmail, receiverEmail,
        text: content.text || '',
        fileData: content.fileData || null,
        fileName: content.fileName || null,
        fileType: content.fileType || null,
        voiceData: content.voiceData || null,
        voiceDuration: content.voiceDuration || null,
        timestamp: new Date().toISOString(),
        reactions: {},
        readBy: [],
        deleted: false,
        edited: false,
    };
    data.messages[key].push(msg);
    writeData(data);
    return msg;
}

// ---------- AI bot ----------
async function respondAsAI(userEmail) {
    const data = readData();
    const key = [userEmail, AI_BOT_EMAIL].sort().join('_');
    const history = (data.messages[key] || []).filter(m => !m.deleted).slice(-20);
    const oa = getOpenAI();
    let replyText;
    if (!oa) {
        replyText = "I'm not connected to my brain right now. Ask Replit to set up the OpenAI integration so I can chat properly!";
    } else {
        try {
            const messages = [
                { role: 'system', content: 'You are Talk AI, a friendly assistant inside the Talk chat app. Keep replies concise (1-3 short paragraphs unless asked for detail). Be warm, helpful, and conversational.' },
                ...history.map(m => ({ role: m.senderEmail === AI_BOT_EMAIL ? 'assistant' : 'user', content: m.text || '[file]' })),
            ];
            const completion = await oa.chat.completions.create({ model: 'gpt-5.4', messages, max_completion_tokens: 8192 });
            replyText = completion.choices?.[0]?.message?.content?.trim() || "Sorry, I couldn't think of a reply.";
        } catch (err) {
            console.error('OpenAI error:', err.message || err);
            replyText = "I had trouble reaching my brain. Please try again in a moment.";
        }
    }
    const saved = saveDirectMessage(AI_BOT_EMAIL, userEmail, { text: replyText });
    sendTo(userEmail, { type: 'message', message: saved });
}

// ---------- Groups ----------
app.patch('/api/groups/:id', (req, res) => {
    const { id } = req.params;
    const { name, email } = req.body || {};
    const data = readData();
    const group = data.groups[id];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!userInGroup(group, email)) return res.status(403).json({ error: 'Not a member' });
    if (name && name.trim().length > 0) group.name = name.trim().slice(0, 60);
    writeData(data);
    for (const m of group.members) sendTo(m, { type: 'group-updated', group });
    res.json({ success: true, group });
});

app.delete('/api/groups/:id/members/:target', (req, res) => {
    const { id, target } = req.params;
    const { email } = req.body || {};
    const data = readData();
    const group = data.groups[id];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!userInGroup(group, email)) return res.status(403).json({ error: 'Not a member' });
    if (!group.members.includes(target)) return res.status(400).json({ error: 'Not in group' });
    group.members = group.members.filter(m => m !== target);
    const removerName = data.users[email]?.name || email;
    const removedName = data.users[target]?.name || target;
    const sysMsg = { id: newId(), groupId: id, senderEmail: 'system', senderName: 'System',
        text: `${removerName} removed ${removedName} from the group`,
        timestamp: new Date().toISOString(), system: true, reactions: {}, deleted: false };
    if (!data.groupMessages[id]) data.groupMessages[id] = [];
    data.groupMessages[id].push(sysMsg);
    writeData(data);
    for (const m of [...group.members, target]) {
        sendTo(m, { type: 'group-updated', group });
        sendTo(m, { type: 'group-message', message: sysMsg });
    }
    res.json({ success: true, group });
});

function userInGroup(group, email) {
    return group && Array.isArray(group.members) && group.members.includes(email);
}

app.get('/api/groups', (req, res) => {
    const email = (req.query.email || '').toString();
    if (!email) return res.status(400).json({ error: 'email query required' });
    const data = readData();
    const list = Object.values(data.groups)
        .filter(g => userInGroup(g, email))
        .map(g => ({ id: g.id, name: g.name, members: g.members, createdBy: g.createdBy, createdAt: g.createdAt }));
    res.json({ groups: list });
});

app.post('/api/groups', (req, res) => {
    const { name, members, createdBy } = req.body || {};
    if (!name || !createdBy) return res.status(400).json({ error: 'name and createdBy required' });
    const data = readData();
    if (!data.users[createdBy]) return res.status(404).json({ error: 'Creator not found' });
    const memberSet = new Set([createdBy, ...(Array.isArray(members) ? members : [])]);
    const memberList = Array.from(memberSet).filter(e => data.users[e]);
    if (memberList.length < 2) return res.status(400).json({ error: 'Add at least one other member' });
    const id = 'g_' + newId();
    const group = { id, name: name.trim().slice(0, 60), members: memberList, createdBy, createdAt: new Date().toISOString() };
    data.groups[id] = group;
    data.groupMessages[id] = [];
    writeData(data);
    for (const m of memberList) sendTo(m, { type: 'group-created', group });
    res.json({ success: true, group });
});

app.post('/api/groups/:id/members', (req, res) => {
    const { id } = req.params;
    const { email, addedBy } = req.body || {};
    const data = readData();
    const group = data.groups[id];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!userInGroup(group, addedBy)) return res.status(403).json({ error: 'Not a member' });
    if (!data.users[email]) return res.status(404).json({ error: 'User not on Talk yet' });
    if (group.members.includes(email)) return res.status(400).json({ error: 'Already in group' });
    group.members.push(email);
    const sysMsg = { id: newId(), groupId: id, senderEmail: 'system', senderName: 'System',
        text: `${data.users[addedBy]?.name || addedBy} added ${data.users[email].name} to the group`,
        timestamp: new Date().toISOString(), system: true, reactions: {}, deleted: false };
    if (!data.groupMessages[id]) data.groupMessages[id] = [];
    data.groupMessages[id].push(sysMsg);
    writeData(data);
    for (const m of group.members) {
        sendTo(m, { type: 'group-updated', group });
        sendTo(m, { type: 'group-message', message: sysMsg });
    }
    res.json({ success: true, group });
});

app.get('/api/groups/:id/messages', (req, res) => {
    const { id } = req.params;
    const email = (req.query.email || '').toString();
    const data = readData();
    const group = data.groups[id];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!userInGroup(group, email)) return res.status(403).json({ error: 'Not a member' });
    res.json({ messages: data.groupMessages[id] || [], group });
});

app.post('/api/groups/:id/messages', (req, res) => {
    const { id } = req.params;
    const { senderEmail, text, fileData, fileName, fileType, voiceData, voiceDuration } = req.body || {};
    if (!senderEmail) return res.status(400).json({ error: 'senderEmail required' });
    if (!text && !fileData && !voiceData) return res.status(400).json({ error: 'Message content required' });
    const data = readData();
    const group = data.groups[id];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!userInGroup(group, senderEmail)) return res.status(403).json({ error: 'Not a member' });
    const sender = data.users[senderEmail];
    const msg = saveGroupMessage(group, senderEmail, sender?.name || senderEmail, { text, fileData, fileName, fileType, voiceData, voiceDuration });
    for (const m of group.members) sendTo(m, { type: 'group-message', message: msg });
    res.json({ success: true, message: msg });
});

// Edit group message
app.patch('/api/groups/:id/messages/:msgId', (req, res) => {
    const { id, msgId } = req.params;
    const { email, text } = req.body || {};
    const data = readData();
    const msgs = data.groupMessages[id];
    if (!msgs) return res.status(404).json({ error: 'Group not found' });
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx < 0) return res.status(404).json({ error: 'Message not found' });
    if (msgs[idx].senderEmail !== email) return res.status(403).json({ error: 'Not your message' });
    msgs[idx].text = text.trim().slice(0, 4000);
    msgs[idx].edited = true;
    writeData(data);
    const group = data.groups[id];
    if (group) for (const m of group.members) sendTo(m, { type: 'group-message-edited', message: msgs[idx] });
    res.json({ success: true, message: msgs[idx] });
});

// Delete group message
app.delete('/api/groups/:id/messages/:msgId', (req, res) => {
    const { id, msgId } = req.params;
    const { email } = req.body || {};
    const data = readData();
    const msgs = data.groupMessages[id];
    if (!msgs) return res.status(404).json({ error: 'Group not found' });
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx < 0) return res.status(404).json({ error: 'Message not found' });
    if (msgs[idx].senderEmail !== email) return res.status(403).json({ error: 'Not your message' });
    msgs[idx].deleted = true;
    msgs[idx].text = '';
    msgs[idx].fileData = null;
    msgs[idx].voiceData = null;
    writeData(data);
    const group = data.groups[id];
    if (group) for (const m of group.members) sendTo(m, { type: 'group-message-deleted', messageId: msgId, groupId: id });
    res.json({ success: true });
});

// React to group message
app.post('/api/groups/:id/messages/:msgId/react', (req, res) => {
    const { id, msgId } = req.params;
    const { email, emoji } = req.body || {};
    const data = readData();
    const msgs = data.groupMessages[id];
    if (!msgs) return res.status(404).json({ error: 'Group not found' });
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx < 0) return res.status(404).json({ error: 'Message not found' });
    if (!msgs[idx].reactions) msgs[idx].reactions = {};
    if (!msgs[idx].reactions[emoji]) msgs[idx].reactions[emoji] = [];
    const arr = msgs[idx].reactions[emoji];
    const pos = arr.indexOf(email);
    if (pos >= 0) arr.splice(pos, 1); else arr.push(email);
    if (arr.length === 0) delete msgs[idx].reactions[emoji];
    writeData(data);
    const group = data.groups[id];
    if (group) for (const m of group.members) sendTo(m, { type: 'group-message-reacted', messageId: msgId, groupId: id, reactions: msgs[idx].reactions });
    res.json({ success: true, reactions: msgs[idx].reactions });
});

function saveGroupMessage(group, senderEmail, senderName, content) {
    const data = readData();
    const msg = {
        id: newId(),
        groupId: group.id,
        senderEmail,
        senderName,
        text: content.text || '',
        fileData: content.fileData || null,
        fileName: content.fileName || null,
        fileType: content.fileType || null,
        voiceData: content.voiceData || null,
        voiceDuration: content.voiceDuration || null,
        timestamp: new Date().toISOString(),
        reactions: {},
        deleted: false,
        edited: false,
    };
    if (!data.groupMessages[group.id]) data.groupMessages[group.id] = [];
    data.groupMessages[group.id].push(msg);
    writeData(data);
    return msg;
}

// ---------- Challenges ----------
app.post('/api/challenges', (req, res) => {
    const { challenger, opponent, game } = req.body || {};
    if (!challenger || !opponent || !game) return res.status(400).json({ error: 'challenger, opponent, game required' });
    const data = readData();
    if (!data.users[challenger]) return res.status(404).json({ error: 'Challenger not found' });
    if (!data.users[opponent]) return res.status(404).json({ error: 'Opponent not found' });
    const id = 'c_' + newId();
    const challenge = { id, game, challenger, opponent, challengerScore: null, opponentScore: null, status: 'pending', createdAt: new Date().toISOString() };
    data.challenges[id] = challenge;
    // Save challenge message in DM
    const msg = {
        id: 'm_' + newId(), senderEmail: challenger, receiverEmail: opponent,
        text: '🎮 Game Challenge: ' + (game === 'dodger' ? 'Dodger' : 'Arcade'),
        challengeId: id, game, timestamp: new Date().toISOString(),
        reactions: {}, readBy: [], deleted: false, edited: false,
    };
    const key = [challenger, opponent].sort().join('_');
    if (!data.messages[key]) data.messages[key] = [];
    data.messages[key].push(msg);
    writeData(data);
    const wsMsg = { ...msg, _challenge: challenge };
    sendTo(opponent, { type: 'message', message: wsMsg });
    sendTo(challenger, { type: 'message', message: wsMsg });
    res.json({ success: true, challenge, message: wsMsg });
});

app.get('/api/challenges/:id', (req, res) => {
    const data = readData();
    const c = data.challenges[req.params.id];
    if (!c) return res.status(404).json({ error: 'Challenge not found' });
    res.json({ challenge: c });
});

app.post('/api/challenges/:id/score', (req, res) => {
    const { id } = req.params;
    const { email, score } = req.body || {};
    if (!email || score === undefined) return res.status(400).json({ error: 'email and score required' });
    const data = readData();
    const c = data.challenges[id];
    if (!c) return res.status(404).json({ error: 'Challenge not found' });
    if (c.status === 'complete') return res.json({ success: true, challenge: c });
    if (email === c.challenger && c.challengerScore === null) c.challengerScore = Number(score);
    else if (email === c.opponent && c.opponentScore === null) c.opponentScore = Number(score);
    else return res.json({ success: true, challenge: c });
    if (c.challengerScore !== null && c.opponentScore !== null) {
        c.status = 'complete';
        if (c.challengerScore > c.opponentScore) c.winner = c.challenger;
        else if (c.opponentScore > c.challengerScore) c.winner = c.opponent;
        else c.winner = 'tie';
    } else { c.status = 'in-progress'; }
    writeData(data);
    // Also post to leaderboard
    const u = data.users[email];
    if (u) {
        if (!data.leaderboard[c.game]) data.leaderboard[c.game] = [];
        const board = data.leaderboard[c.game];
        const existing = board.find(e => e.email === email);
        if (existing) { if (Number(score) > existing.score) { existing.score = Number(score); existing.updatedAt = new Date().toISOString(); } }
        else board.push({ email, name: u.name, score: Number(score), updatedAt: new Date().toISOString() });
        board.sort((a,b) => b.score - a.score);
        data.leaderboard[c.game] = board.slice(0,100);
        writeData(data);
    }
    sendTo(c.challenger, { type: 'challenge-updated', challenge: c });
    sendTo(c.opponent, { type: 'challenge-updated', challenge: c });
    res.json({ success: true, challenge: c });
});

// ---------- Feedback ----------
app.get('/api/feedback', (req, res) => {
    const data = readData();
    const reviews = (data.feedback || []).slice().reverse();
    res.json({ reviews });
});

app.post('/api/feedback', (req, res) => {
    const { email, rating, message } = req.body || {};
    if (!email || !rating) return res.status(400).json({ error: 'email and rating required' });
    const data = readData();
    if (!data.users[email]) return res.status(404).json({ error: 'User not found' });
    const u = data.users[email];
    const entry = { id: newId(), email, name: u.name, avatar: u.avatar || null, rating: Number(rating), message: (message||'').slice(0,500), timestamp: new Date().toISOString() };
    data.feedback.push(entry);
    writeData(data);
    res.json({ success: true, review: entry });
});

// ---------- Leaderboard ----------
app.get('/api/leaderboard', (req, res) => {
    const data = readData();
    res.json({ leaderboard: data.leaderboard || {} });
});

app.post('/api/leaderboard/score', (req, res) => {
    const { email, name, game, score } = req.body || {};
    if (!email || !game || score === undefined) return res.status(400).json({ error: 'email, game, score required' });
    const data = readData();
    if (!data.leaderboard[game]) data.leaderboard[game] = [];
    const board = data.leaderboard[game];
    const existing = board.find(e => e.email === email);
    if (existing) { if (Number(score) > existing.score) { existing.score = Number(score); existing.name = name || existing.name; existing.updatedAt = new Date().toISOString(); } }
    else board.push({ email, name: name || email, score: Number(score), updatedAt: new Date().toISOString() });
    board.sort((a,b) => b.score - a.score);
    data.leaderboard[game] = board.slice(0, 100);
    writeData(data);
    res.json({ success: true });
});

app.delete('/api/leaderboard', (req, res) => {
    const { adminEmail, adminPassword, game } = req.body || {};
    if (adminEmail !== ADMIN_EMAIL || adminPassword !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Admin credentials required' });
    const data = readData();
    if (game) { data.leaderboard[game] = []; }
    else { data.leaderboard = {}; }
    writeData(data);
    res.json({ success: true });
});

// Call history
app.get('/api/calls/:email', (req, res) => {
    const { email } = req.params;
    const data = readData();
    const calls = (data.callHistory || [])
        .filter(c => c.from === email || c.to === email)
        .slice(-100).reverse();
    res.json({ calls });
});

// ---------- Admin: Download all files as ZIP ----------
app.get('/api/admin/download', (req, res) => {
    const { password } = req.query;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Invalid admin password' });

    const EXCLUDE = new Set(['node_modules', '.git', '.cache', '.local', '.upm', '.replit', 'replit.nix']);
    const EXT_OK = new Set(['.js','.html','.css','.json','.md','.txt','.nix','.sh','.ts','.jsx','.tsx']);

    function collectFiles(dir, base) {
        let out = [];
        for (const name of fs.readdirSync(dir)) {
            if (EXCLUDE.has(name) || name.startsWith('.')) continue;
            const abs = path.join(dir, name);
            const rel = base ? path.join(base, name) : name;
            const stat = fs.statSync(abs);
            if (stat.isDirectory()) { out = out.concat(collectFiles(abs, rel)); }
            else if (EXT_OK.has(path.extname(name).toLowerCase()) || name === 'package-lock.json') {
                out.push({ abs, rel });
            }
        }
        return out;
    }

    const files = collectFiles(__dirname, '');

    res.setHeader('Content-Disposition', 'attachment; filename="talk-app.zip"');
    res.setHeader('Content-Type', 'application/zip');

    const archive = require('archiver')('zip', { zlib: { level: 9 } });
    archive.on('error', err => { console.error('Archive error:', err); res.status(500).end(); });
    archive.pipe(res);

    for (const { abs, rel } of files) {
        try { archive.file(abs, { name: rel }); } catch (_) {}
    }

    archive.finalize();
});

// ---------- Static ----------
app.use(express.static(__dirname, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    extensions: ['html'],
}));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Map();
const pendingCalls = new Map(); // key: "caller:callee" -> call record
const groupCalls = new Map(); // groupId -> { participants: Set<email>, startedBy, startTime }

function broadcastPresence() {
    const online = Array.from(clients.keys());
    online.push(AI_BOT_EMAIL);
    const msg = JSON.stringify({ type: 'presence', online });
    for (const ws of clients.values()) {
        if (ws.readyState === ws.OPEN) ws.send(msg);
    }
}

function sendTo(email, payload) {
    const ws = clients.get(email);
    if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(payload));
        return true;
    }
    return false;
}

wss.on('connection', (ws) => {
    ws.email = null;

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === 'hello' && msg.email) {
            ws.email = msg.email;
            const prev = clients.get(msg.email);
            if (prev && prev !== ws) { try { prev.close(); } catch {} }
            clients.set(msg.email, ws);
            broadcastPresence();
            return;
        }

        if (!ws.email) return;

        if (msg.type === 'message' && msg.to) {
            const data = readData();
            if (msg.to !== AI_BOT_EMAIL && !data.users[msg.to]) return;
            const saved = saveDirectMessage(ws.email, msg.to, { text: msg.text, fileData: msg.fileData, fileName: msg.fileName, fileType: msg.fileType, voiceData: msg.voiceData, voiceDuration: msg.voiceDuration });
            const out = { type: 'message', message: saved };
            sendTo(msg.to, out);
            sendTo(ws.email, out);
            if (msg.to === AI_BOT_EMAIL) {
                respondAsAI(ws.email).catch(err => console.error('AI reply failed:', err));
            }
            return;
        }

        if (msg.type === 'group-message' && msg.groupId) {
            const data = readData();
            const group = data.groups[msg.groupId];
            if (!group || !userInGroup(group, ws.email)) return;
            const sender = data.users[ws.email];
            const saved = saveGroupMessage(group, ws.email, sender?.name || ws.email, { text: msg.text, fileData: msg.fileData, fileName: msg.fileName, fileType: msg.fileType, voiceData: msg.voiceData, voiceDuration: msg.voiceDuration });
            for (const m of group.members) sendTo(m, { type: 'group-message', message: saved });
            return;
        }

        if (msg.type === 'group-typing' && msg.groupId) {
            const data = readData();
            const group = data.groups[msg.groupId];
            if (!group || !userInGroup(group, ws.email)) return;
            for (const m of group.members) {
                if (m === ws.email) continue;
                sendTo(m, { type: 'group-typing', groupId: msg.groupId, from: ws.email, fromName: data.users[ws.email]?.name || ws.email, isTyping: !!msg.isTyping });
            }
            return;
        }

        if (msg.type === 'call-invite' && msg.to) {
            const callKey = ws.email + ':' + msg.to;
            pendingCalls.set(callKey, {
                id: newId(), from: ws.email, to: msg.to,
                callType: msg.callType || 'audio',
                startTime: new Date().toISOString(), status: 'ringing',
            });
            sendTo(msg.to, { ...msg, from: ws.email });
            return;
        }
        if (msg.type === 'call-accept' && msg.to) {
            const record = pendingCalls.get(msg.to + ':' + ws.email);
            if (record) { record.status = 'answered'; record.answeredAt = new Date().toISOString(); }
            sendTo(msg.to, { ...msg, from: ws.email });
            return;
        }
        if ((msg.type === 'call-reject' || msg.type === 'call-cancel') && msg.to) {
            const k1 = ws.email + ':' + msg.to;
            const k2 = msg.to + ':' + ws.email;
            const key = pendingCalls.has(k1) ? k1 : k2;
            const record = pendingCalls.get(key);
            if (record) {
                record.status = msg.type === 'call-cancel' ? 'missed' : 'rejected';
                record.endTime = new Date().toISOString();
                const data = readData();
                data.callHistory.push(record);
                if (data.callHistory.length > 500) data.callHistory = data.callHistory.slice(-500);
                writeData(data);
                pendingCalls.delete(key);
            }
            sendTo(msg.to, { ...msg, from: ws.email });
            return;
        }
        if (msg.type === 'call-end' && msg.to) {
            const k1 = ws.email + ':' + msg.to;
            const k2 = msg.to + ':' + ws.email;
            const key = pendingCalls.has(k1) ? k1 : k2;
            const record = pendingCalls.get(key);
            if (record) {
                if (record.status !== 'answered') record.status = 'missed';
                record.endTime = new Date().toISOString();
                const data = readData();
                data.callHistory.push(record);
                if (data.callHistory.length > 500) data.callHistory = data.callHistory.slice(-500);
                writeData(data);
                pendingCalls.delete(key);
            }
            sendTo(msg.to, { ...msg, from: ws.email });
            return;
        }
        if (['webrtc-offer', 'webrtc-answer', 'webrtc-ice', 'typing'].includes(msg.type)) {
            if (!msg.to) return;
            sendTo(msg.to, { ...msg, from: ws.email });
            return;
        }

        // ---------- Group calls ----------
        if (msg.type === 'group-call-start' && msg.groupId) {
            const data = readData();
            const group = data.groups[msg.groupId];
            if (!group || !userInGroup(group, ws.email)) return;
            if (!groupCalls.has(msg.groupId)) {
                groupCalls.set(msg.groupId, { participants: new Set([ws.email]), startedBy: ws.email, startTime: new Date().toISOString() });
            } else {
                groupCalls.get(msg.groupId).participants.add(ws.email);
            }
            const call = groupCalls.get(msg.groupId);
            const starterName = data.users[ws.email]?.name || ws.email;
            for (const m of group.members) {
                if (m === ws.email) {
                    sendTo(m, { type: 'group-call-state', groupId: msg.groupId, participants: Array.from(call.participants) });
                } else {
                    sendTo(m, { type: 'group-call-invite', groupId: msg.groupId, groupName: group.name, startedBy: ws.email, startedByName: starterName });
                }
            }
            return;
        }
        if (msg.type === 'group-call-join' && msg.groupId) {
            const data = readData();
            const group = data.groups[msg.groupId];
            if (!group || !userInGroup(group, ws.email)) return;
            let call = groupCalls.get(msg.groupId);
            if (!call) { call = { participants: new Set(), startedBy: ws.email, startTime: new Date().toISOString() }; groupCalls.set(msg.groupId, call); }
            const existingParticipants = Array.from(call.participants);
            call.participants.add(ws.email);
            const all = Array.from(call.participants);
            // Tell the new joiner who's already in
            sendTo(ws.email, { type: 'group-call-state', groupId: msg.groupId, participants: all, newJoiner: ws.email, existingParticipants });
            // Tell others the new person joined
            for (const p of call.participants) {
                if (p !== ws.email) sendTo(p, { type: 'group-call-state', groupId: msg.groupId, participants: all, newJoiner: ws.email });
            }
            return;
        }
        if (msg.type === 'group-call-leave' && msg.groupId) {
            const call = groupCalls.get(msg.groupId);
            if (call) {
                call.participants.delete(ws.email);
                const all = Array.from(call.participants);
                for (const p of call.participants) sendTo(p, { type: 'group-call-state', groupId: msg.groupId, participants: all });
                if (call.participants.size === 0) groupCalls.delete(msg.groupId);
            }
            return;
        }
        if (['group-webrtc-offer', 'group-webrtc-answer', 'group-webrtc-ice'].includes(msg.type)) {
            if (!msg.to) return;
            sendTo(msg.to, { ...msg, from: ws.email });
            return;
        }
    });

    ws.on('close', () => {
        if (ws.email && clients.get(ws.email) === ws) {
            clients.delete(ws.email);
            broadcastPresence();
        }
    });
});

// ── CHANGED: server.listen is now wrapped in connectDB() ──────────────────
connectDB().then(() => {
    server.listen(PORT, HOST, () => {
        console.log(`Talk server running at http://${HOST}:${PORT}/`);
        console.log(`OpenAI integration: ${getOpenAI() ? 'ready' : 'not configured'}`);
    });
}).catch(err => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
});
