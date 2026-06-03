(function () {
    const AI_BOT_EMAIL = 'ai@talk.local';
    const AI_BOT_NAME = 'Talk AI';

    const EMOJI_LIST = ['😀','😎','🥳','😇','🤩','🦊','🐼','🐸','🐙','🦄','🌈','⚡','🔥','🌊','🍕',
        '🎮','🎵','📚','✈️','🏆','💎','🌸','🍀','🌙','⭐','🎯','🚀','🎲','🏄','🐉'];
    const REACTION_EMOJI = ['👍','❤️','😂','😮','😢','🔥','👏','🎉'];

    // ---------- Auth elements ----------
    const authScreen = document.getElementById('auth-screen');
    const appScreen = document.getElementById('app-screen');
    const authTitle = document.getElementById('auth-title');
    const authForm = document.getElementById('auth-form');
    const nameInput = document.getElementById('name-input');
    const emailInput = document.getElementById('email-input');
    const passwordInput = document.getElementById('password-input');
    const submitBtn = document.getElementById('submit-btn');
    const toggleText = document.getElementById('toggle-text');
    const toggleLink = document.getElementById('toggle-link');
    const forgotRow = document.getElementById('forgot-row');
    const forgotLink = document.getElementById('forgot-link');
    const authError = document.getElementById('auth-error');
    const authSuccess = document.getElementById('auth-success');

    // ---------- State ----------
    let mode = 'login';
    let me = null;
    let ws = null;
    let onlineSet = new Set();
    let allUsers = [];
    let contacts = [];
    let blockedEmails = [];
    let groups = [];
    let activeChat = null;
    let unread = {};
    let pc = null;
    let localStream = null;
    let screenStream = null;
    let remoteStream = null;
    let callState = null;
    let pendingCallType = null;
    let pendingPeer = null;
    let iceQueue = [];
    let mediaRecorder = null;
    let voiceChunks = [];
    let voiceSeconds = 0;
    let isRecording = false;
    let searchVisible = false;
    let activeTab = 'chat';
    let wsReconnectDelay = 2000;
    let callHistory = [];

    function loadUnread() {
        try { unread = JSON.parse(localStorage.getItem('talkUnread') || '{}') || {}; } catch { unread = {}; }
    }
    function saveUnread() { try { localStorage.setItem('talkUnread', JSON.stringify(unread)); } catch {} }
    function updateTitle() {
        const total = Object.values(unread).reduce((a, b) => a + b, 0);
        document.title = total > 0 ? '(' + total + ') Talk' : 'Talk';
    }
    function bumpUnread(key) { unread[key] = (unread[key] || 0) + 1; saveUnread(); updateTitle(); }
    function clearUnread(key) { if (unread[key]) { delete unread[key]; saveUnread(); updateTitle(); } }

    function initials(name) { return (name||'?').trim().split(/\s+/).slice(0,2).map(s=>s[0]).join('').toUpperCase(); }
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function findUser(email) {
        if (email === AI_BOT_EMAIL) return { email: AI_BOT_EMAIL, name: AI_BOT_NAME, avatar: null };
        if (me && email === me.email) return me;
        return allUsers.find(u => u.email === email) || contacts.find(u => u.email === email) || { email, name: email, avatar: null };
    }
    function isOnline(email) { return email === AI_BOT_EMAIL || onlineSet.has(email); }
    function avatarContent(u) { return (u && u.avatar) ? u.avatar : initials(u?.name || '?'); }
    function avatarClass(u, extra='') {
        if (!u || u.email === AI_BOT_EMAIL) return 'avatar online ai-avatar' + (extra ? ' '+extra : '');
        return 'avatar' + (isOnline(u.email) ? ' online' : '') + (extra ? ' '+extra : '');
    }
    function statusLabel(s) {
        return { available:'Available', away:'Away', busy:'Busy', dnd:'Do not disturb' }[s] || 'Available';
    }
    function statusColor(s) {
        return { available:'#2bb673', away:'#f8c51b', busy:'#e05c2e', dnd:'#c4314b' }[s] || '#2bb673';
    }
    function formatDuration(secs) {
        const m = Math.floor(secs/60), s = secs%60;
        return m+':'+(s<10?'0':'')+s;
    }
    function formatBytes(b) {
        if (b < 1024) return b+'B';
        if (b < 1048576) return (b/1024).toFixed(1)+'KB';
        return (b/1048576).toFixed(1)+'MB';
    }

    // ---------- Auth ----------
    function setMode(m) {
        mode = m;
        authError.textContent = '';
        authSuccess.textContent = '';
        if (m === 'login') {
            authTitle.textContent = 'Sign in'; submitBtn.textContent = 'Sign in';
            nameInput.style.display = 'none'; nameInput.required = false;
            passwordInput.placeholder = 'Password'; passwordInput.autocomplete = 'current-password';
            toggleText.textContent = 'New here?'; toggleLink.textContent = 'Create an account';
            forgotRow.style.display = '';
        } else if (m === 'signup') {
            authTitle.textContent = 'Create account'; submitBtn.textContent = 'Sign up';
            nameInput.style.display = ''; nameInput.required = true;
            passwordInput.placeholder = 'Password (min 6 chars)'; passwordInput.autocomplete = 'new-password';
            toggleText.textContent = 'Have an account?'; toggleLink.textContent = 'Sign in';
            forgotRow.style.display = 'none';
        } else if (m === 'forgot') {
            authTitle.textContent = 'Reset password'; submitBtn.textContent = 'Reset password';
            nameInput.style.display = 'none'; nameInput.required = false;
            passwordInput.placeholder = 'New password (min 6 chars)'; passwordInput.autocomplete = 'new-password';
            toggleText.textContent = 'Remembered it?'; toggleLink.textContent = 'Sign in';
            forgotRow.style.display = 'none';
        }
    }
    toggleLink.addEventListener('click', (e) => { e.preventDefault(); setMode(mode === 'forgot' ? 'login' : mode === 'login' ? 'signup' : 'login'); });
    forgotLink.addEventListener('click', (e) => { e.preventDefault(); setMode('forgot'); });

    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        authError.textContent = ''; authSuccess.textContent = ''; submitBtn.disabled = true;
        try {
            if (mode === 'forgot') {
                const res = await fetch('/api/reset-password', { method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({ email: emailInput.value.trim(), newPassword: passwordInput.value }) });
                const data = await res.json();
                if (!res.ok) { authError.textContent = data.error || 'Could not reset'; return; }
                authSuccess.textContent = 'Password updated. Sign in now.';
                setTimeout(() => setMode('login'), 1500);
                return;
            }
            const payload = { email: emailInput.value.trim(), password: passwordInput.value };
            if (mode === 'signup') payload.name = nameInput.value.trim();
            const res = await fetch('/api/' + (mode === 'signup' ? 'signup' : 'login'), {
                method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
            const data = await res.json();
            if (!res.ok) { authError.textContent = data.error || 'Something went wrong'; return; }
            localStorage.setItem('talkUser', JSON.stringify(data.user));
            me = data.user;
            enterApp();
        } catch { authError.textContent = 'Network error. Please try again.'; }
        finally { submitBtn.disabled = false; }
    });

    document.getElementById('logout-btn').addEventListener('click', () => {
        try { ws && ws.close(); } catch {}
        localStorage.removeItem('talkUser'); location.reload();
    });

    document.getElementById('download-btn').addEventListener('click', () => {
        const pw = prompt('Enter admin password to download all app files:');
        if (!pw) return;
        const a = document.createElement('a');
        a.href = '/api/admin/download?password=' + encodeURIComponent(pw);
        a.download = 'talk-app.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    });

    // ---------- App elements ----------
    const meAvatar = document.getElementById('me-avatar');
    const meName = document.getElementById('me-name');
    const contactList = document.getElementById('contact-list');
    const contactSearch = document.getElementById('contact-search');
    const emptyState = document.getElementById('empty-state');
    const convView = document.getElementById('conv-view');
    const peerAvatar = document.getElementById('peer-avatar');
    const peerName = document.getElementById('peer-name');
    const peerStatus = document.getElementById('peer-status');
    const messagesEl = document.getElementById('messages');
    const composer = document.getElementById('composer');
    const messageInput = document.getElementById('message-input');
    const audioCallBtn = document.getElementById('audio-call-btn');
    const videoCallBtn = document.getElementById('video-call-btn');
    const addMemberBtn = document.getElementById('add-member-btn');
    const groupSettingsBtn = document.getElementById('group-settings-btn');
    const searchBtn = document.getElementById('search-btn');
    const searchBar = document.getElementById('search-bar');
    const searchInput = document.getElementById('search-input');
    const searchClose = document.getElementById('search-close');
    const searchResults = document.getElementById('search-results');
    const attachBtn = document.getElementById('attach-btn');
    const fileInput = document.getElementById('file-input');
    const voiceBtn = document.getElementById('voice-btn');
    const voiceRecordingBar = document.getElementById('voice-recording-bar');
    const voiceTimer = document.getElementById('voice-timer-el');
    const voiceSend = document.getElementById('voice-send');
    const voiceCancel = document.getElementById('voice-cancel');
    const statusBtn = document.getElementById('status-btn');
    const statusMenu = document.getElementById('status-menu');
    const screenShareBtn = document.getElementById('screen-share-btn');

    function updateMeAvatar() {
        if (!me) return;
        meAvatar.textContent = me.avatar || initials(me.name);
        meAvatar.title = me.name;
        meAvatar.style.fontSize = me.avatar ? '22px' : '';
        if (meName) meName.textContent = me.name;
        // Status dot
        const dot = document.getElementById('me-status-dot');
        if (dot) { dot.style.background = statusColor(me.status || 'available'); dot.title = statusLabel(me.status || 'available'); }
    }

    function enterApp() {
        loadUnread();
        updateTitle();
        authScreen.style.display = 'none';
        appScreen.style.display = 'grid';
        updateMeAvatar();
        connectWS();
        loadAllUsers();
        loadContacts();
        loadGroups();
        loadCallHistory();
        loadLeaderboard();
        maybeShowPermissionsModal();
    }

    async function loadAllUsers() {
        try {
            const r = await fetch('/api/users');
            const d = await r.json();
            allUsers = (d.users || []).filter(u => u.email !== me.email);
        } catch {}
    }

    async function loadCallHistory() {
        try {
            const r = await fetch('/api/calls/' + encodeURIComponent(me.email));
            const d = await r.json();
            callHistory = d.calls || [];
        } catch {}
    }

    function formatCallTime(ts) {
        if (!ts) return '';
        const d = new Date(ts); const now = new Date();
        const diff = now - d;
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000) return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        if (diff < 604800000) return d.toLocaleDateString([], { weekday:'short' });
        return d.toLocaleDateString([], { month:'short', day:'numeric' });
    }

    function renderCalls() {
        const q = contactSearch.value.trim().toLowerCase();
        contactList.innerHTML = '';
        if (callHistory.length === 0) {
            contactList.appendChild(sectionHeader('Recent calls'));
            const d = document.createElement('div'); d.className = 'list-empty';
            d.style.marginTop = '16px'; d.textContent = 'No call history yet.';
            contactList.appendChild(d); return;
        }
        contactList.appendChild(sectionHeader('Recent calls'));
        const filtered = q ? callHistory.filter(c => {
            const peer = c.from === me.email ? c.to : c.from;
            const u = findUser(peer);
            return u.name.toLowerCase().includes(q) || peer.toLowerCase().includes(q);
        }) : callHistory;
        for (const c of filtered.slice(0, 50)) {
            const peerEmail = c.from === me.email ? c.to : c.from;
            const u = findUser(peerEmail);
            const isOut = c.from === me.email;
            const item = document.createElement('div');
            item.className = 'contact-item' + (c.status === 'missed' && !isOut ? ' call-item-missed' : ' call-item-answered');
            const av = document.createElement('div');
            av.className = 'avatar' + (isOnline(peerEmail) ? ' online' : '');
            av.textContent = avatarContent(u); av.style.fontSize = u.avatar ? '20px' : '';
            const info = document.createElement('div'); info.className = 'contact-info';
            const nm = document.createElement('div'); nm.className = 'contact-name'; nm.textContent = u.name;
            const sub = document.createElement('div'); sub.className = 'contact-sub';
            const icon = (c.status === 'missed' && !isOut) ? '📵 Missed' : isOut ? '↗ Outgoing' : '↙ Incoming';
            const type = c.callType === 'video' ? 'video' : 'audio';
            sub.textContent = icon + ' · ' + type + ' · ' + formatCallTime(c.startTime);
            info.appendChild(nm); info.appendChild(sub);
            item.appendChild(av); item.appendChild(info);
            const cbBtn = document.createElement('button');
            cbBtn.className = 'call-back-btn'; cbBtn.title = 'Call back';
            cbBtn.innerHTML = c.callType === 'video'
                ? '<svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>'
                : '<svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.5 11.5 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.5 11.5 0 0 0 .57 3.6 1 1 0 0 1-.25 1l-2.22 2.2z"/></svg>';
            cbBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelector('.nav-btn[data-tab="chat"]')?.click();
                const contact = contacts.find(cc => cc.email === peerEmail) || u;
                openDM(contact);
            });
            item.appendChild(cbBtn);
            item.addEventListener('click', () => {
                document.querySelector('.nav-btn[data-tab="chat"]')?.click();
                const contact = contacts.find(cc => cc.email === peerEmail) || u;
                openDM(contact);
            });
            contactList.appendChild(item);
        }
        if (filtered.length === 0) {
            const d = document.createElement('div'); d.className = 'list-empty';
            d.style.marginTop = '8px'; d.textContent = 'No matches.';
            contactList.appendChild(d);
        }
    }

    function renderPeople() {
        const q = contactSearch.value.trim().toLowerCase();
        contactList.innerHTML = '';
        contactList.appendChild(sectionHeader('Everyone on Talk'));
        const users = allUsers.filter(u => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
        if (users.length === 0) {
            const d = document.createElement('div'); d.className = 'list-empty';
            d.style.marginTop = '8px'; d.textContent = q ? 'No matches.' : 'No other users yet.';
            contactList.appendChild(d); return;
        }
        for (const u of users) {
            const isContact = contacts.some(c => c.email === u.email);
            const isBlocked = blockedEmails.includes(u.email);
            const uStatus = u.status || 'available';
            const item = document.createElement('div'); item.className = 'contact-item';
            const av = document.createElement('div');
            av.className = 'avatar' + (isOnline(u.email) ? ' online' : '');
            av.textContent = avatarContent(u); av.style.fontSize = u.avatar ? '20px' : '';
            if (isOnline(u.email) && uStatus !== 'available') {
                av.style.setProperty('--status-color', statusColor(uStatus));
                av.classList.add('custom-status');
            }
            const info = document.createElement('div'); info.className = 'contact-info';
            const nm = document.createElement('div'); nm.className = 'contact-name'; nm.textContent = u.name;
            const subEl = document.createElement('div'); subEl.className = 'contact-sub';
            subEl.textContent = isBlocked ? '🚫 Blocked' : (isOnline(u.email) ? statusLabel(uStatus) : 'Offline');
            info.appendChild(nm); info.appendChild(subEl);
            item.appendChild(av); item.appendChild(info);
            const btn = document.createElement('button');
            btn.className = 'people-action-btn' + (isContact ? ' msg' : '');
            btn.title = isBlocked ? 'Blocked' : (isContact ? 'Message' : 'Add contact');
            btn.textContent = isBlocked ? 'Blocked' : (isContact ? '💬 Chat' : '+ Add');
            if (!isBlocked) {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    document.querySelector('.nav-btn[data-tab="chat"]')?.click();
                    if (isContact) { openDM(u); }
                    else { addContactAPI(u.email).then(() => { const c = contacts.find(cc => cc.email === u.email) || u; openDM(c); }); }
                });
                item.addEventListener('click', () => {
                    document.querySelector('.nav-btn[data-tab="chat"]')?.click();
                    if (isContact) { openDM(u); }
                    else { addContactAPI(u.email).then(() => { const c = contacts.find(cc => cc.email === u.email) || u; openDM(c); }); }
                });
            }
            item.appendChild(btn);
            contactList.appendChild(item);
        }
    }

    async function loadContacts() {
        try {
            const r = await fetch('/api/users/' + encodeURIComponent(me.email) + '/contacts');
            const d = await r.json();
            contacts = (d.contacts || []).filter(u => u.email !== me.email);
            blockedEmails = d.blocked || [];
            renderContacts();
        } catch {}
    }

    async function loadGroups() {
        try {
            const r = await fetch('/api/groups?email=' + encodeURIComponent(me.email));
            const d = await r.json();
            groups = d.groups || [];
            renderContacts();
        } catch {}
    }

    async function addContactAPI(email) {
        try {
            await fetch('/api/users/' + encodeURIComponent(me.email) + '/contacts', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ contactEmail: email }) });
            await loadContacts();
            await loadAllUsers();
        } catch {}
    }

    async function removeContactAPI(email) {
        await fetch('/api/users/' + encodeURIComponent(me.email) + '/contacts/' + encodeURIComponent(email), { method:'DELETE' });
        contacts = contacts.filter(c => c.email !== email);
        if (activeChat && activeChat.kind === 'dm' && activeChat.email === email) {
            activeChat = null;
            convView.style.display = 'none';
            emptyState.style.display = '';
        }
        renderContacts();
    }

    async function blockContactAPI(email, block) {
        await fetch('/api/users/' + encodeURIComponent(me.email) + '/block', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ targetEmail: email, block }) });
        if (block) { if (!blockedEmails.includes(email)) blockedEmails.push(email); }
        else blockedEmails = blockedEmails.filter(e => e !== email);
        renderContacts();
    }

    // ---------- Status ----------
    statusBtn && statusBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (statusMenu) statusMenu.style.display = statusMenu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { if (statusMenu) statusMenu.style.display = 'none'; });
    document.querySelectorAll('.status-option').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const s = btn.dataset.status;
            if (!s) return;
            if (statusMenu) statusMenu.style.display = 'none';
            try {
                const r = await fetch('/api/users/' + encodeURIComponent(me.email) + '/profile', {
                    method:'PATCH', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({ status: s }) });
                const d = await r.json();
                if (r.ok) { me.status = d.user.status; localStorage.setItem('talkUser', JSON.stringify(me)); updateMeAvatar(); }
            } catch {}
        });
    });

    // ---------- Sidebar ----------
    function renderContacts() {
        if (activeTab === 'calls') { renderCalls(); return; }
        if (activeTab === 'people') { renderPeople(); return; }
        const q = contactSearch.value.trim().toLowerCase();
        contactList.innerHTML = '';

        if (!q || AI_BOT_NAME.toLowerCase().includes(q)) {
            contactList.appendChild(buildContactRow({
                user: { email: AI_BOT_EMAIL, name: AI_BOT_NAME, avatar: null },
                sub: 'Always here · ask me anything',
                badge: unread['ai'] || 0,
                active: activeChat?.kind === 'ai',
                isAI: true,
                onClick: () => openAI(),
            }));
        }

        const filteredGroups = groups.filter(g => !q || g.name.toLowerCase().includes(q));
        if (filteredGroups.length > 0) {
            contactList.appendChild(sectionHeader('Groups'));
            for (const g of filteredGroups) {
                const key = 'g:' + g.id;
                const active = activeChat?.kind === 'group' && activeChat.group.id === g.id;
                contactList.appendChild(buildContactRow({
                    user: { email: 'group', name: g.name, avatar: null },
                    sub: g.members.length + ' members',
                    badge: unread[key] || 0,
                    active, isGroup: true,
                    onClick: () => openGroup(g),
                }));
            }
        }

        const filteredContacts = contacts.filter(u => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
        if (filteredContacts.length > 0) {
            contactList.appendChild(sectionHeader('People'));
            for (const u of filteredContacts) {
                const blocked = blockedEmails.includes(u.email);
                const active = activeChat?.kind === 'dm' && activeChat.email === u.email;
                const uStatus = u.status || 'available';
                const sub = blocked ? '🚫 Blocked' : (isOnline(u.email) ? statusLabel(uStatus) : 'Offline');
                contactList.appendChild(buildContactRow({
                    user: u,
                    sub,
                    badge: unread['dm:' + u.email] || 0,
                    active,
                    onClick: blocked ? null : () => openDM(u),
                    menuFn: () => showContactMenu(u),
                    userStatus: isOnline(u.email) ? uStatus : null,
                }));
            }
        } else if (!q && contacts.length === 0 && groups.length === 0) {
            const d = document.createElement('div');
            d.className = 'list-empty'; d.style.marginTop = '8px';
            d.textContent = 'No contacts yet. Tap "+ New" → "New chat" to find someone.';
            contactList.appendChild(d);
        } else if (q && filteredContacts.length === 0 && filteredGroups.length === 0) {
            const d = document.createElement('div');
            d.className = 'list-empty'; d.textContent = 'No matches.';
            contactList.appendChild(d);
        }
    }

    function sectionHeader(text) {
        const h = document.createElement('div');
        h.className = 'list-section'; h.textContent = text; return h;
    }

    function buildContactRow({ user, sub, badge, active, isAI, isGroup, onClick, menuFn, userStatus }) {
        const item = document.createElement('div');
        item.className = 'contact-item' + (active ? ' active' : '');

        const av = document.createElement('div');
        if (isAI) {
            av.className = 'avatar online ai-avatar';
            av.textContent = 'AI';
        } else if (isGroup) {
            av.className = 'avatar group-avatar';
            av.textContent = initials(user.name);
        } else {
            av.className = 'avatar' + (isOnline(user.email) ? ' online' : '');
            av.textContent = avatarContent(user);
            av.style.fontSize = user.avatar ? '20px' : '';
            // Custom status dot color
            if (userStatus && userStatus !== 'available' && isOnline(user.email)) {
                av.style.setProperty('--status-color', statusColor(userStatus));
                av.classList.add('custom-status');
            }
        }

        const info = document.createElement('div');
        info.className = 'contact-info';
        const nm = document.createElement('div'); nm.className = 'contact-name'; nm.textContent = user.name;
        const subEl = document.createElement('div'); subEl.className = 'contact-sub'; subEl.textContent = sub;
        info.appendChild(nm); info.appendChild(subEl);

        item.appendChild(av); item.appendChild(info);

        if (badge > 0) {
            const b = document.createElement('div');
            b.className = 'unread-badge';
            b.textContent = badge > 99 ? '99+' : String(badge);
            item.appendChild(b);
        }

        if (menuFn) {
            const btn = document.createElement('button');
            btn.className = 'contact-menu-btn';
            btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>';
            btn.addEventListener('click', (e) => { e.stopPropagation(); menuFn(); });
            item.appendChild(btn);
        }

        if (onClick) item.addEventListener('click', onClick);
        return item;
    }

    // ---------- Contact context menu ----------
    let activeMenu = null;
    function showContactMenu(u) {
        closeMenu();
        const blocked = blockedEmails.includes(u.email);
        const menu = document.createElement('div');
        menu.className = 'ctx-menu';
        const items = [
            { label: blocked ? '✅ Unblock' : '🚫 Block', action: () => blockContactAPI(u.email, !blocked) },
            { label: '🗑️ Remove contact', action: () => {
                if (confirm('Remove ' + u.name + ' from contacts?')) removeContactAPI(u.email);
            }},
        ];
        for (const it of items) {
            const btn = document.createElement('button');
            btn.textContent = it.label;
            btn.addEventListener('click', () => { closeMenu(); it.action(); });
            menu.appendChild(btn);
        }
        document.body.appendChild(menu);
        menu.style.top = '50%'; menu.style.left = '50%';
        menu.style.transform = 'translate(-50%,-50%)';
        activeMenu = menu;
        setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 10);
    }
    function closeMenu() {
        if (activeMenu) { try { activeMenu.remove(); } catch {} activeMenu = null; }
    }

    contactSearch.addEventListener('input', renderContacts);

    // ---------- + New menu ----------
    const newMenuBtn = document.getElementById('new-menu-btn');
    const newMenu = document.getElementById('new-menu');
    newMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); newMenu.style.display = newMenu.style.display === 'none' ? 'block' : 'none'; });
    document.addEventListener('click', () => { newMenu.style.display = 'none'; });

    // ---------- New chat modal ----------
    const newChatBtn = document.getElementById('new-chat-btn');
    const newChatModal = document.getElementById('new-chat-modal');
    const newChatClose = document.getElementById('new-chat-close');
    const newChatInput = document.getElementById('new-chat-input');
    const newChatSuggestions = document.getElementById('new-chat-suggestions');
    const newChatHint = document.getElementById('new-chat-hint');

    function openNewChat() {
        newChatInput.value = ''; newChatSuggestions.innerHTML = '';
        newChatSuggestions.classList.remove('visible'); newChatHint.innerHTML = 'Start typing a name…';
        newChatModal.style.display = 'flex';
        loadAllUsers().then(() => { renderNewChatSuggestions(); setTimeout(() => newChatInput.focus(), 50); });
    }
    function closeNewChat() { newChatModal.style.display = 'none'; }
    newChatBtn.addEventListener('click', openNewChat);
    newChatClose.addEventListener('click', closeNewChat);
    newChatModal.addEventListener('click', (e) => { if (e.target === newChatModal) closeNewChat(); });

    function renderNewChatSuggestions() {
        const q = newChatInput.value.trim(); const ql = q.toLowerCase();
        newChatSuggestions.innerHTML = '';
        if (!q) { newChatSuggestions.classList.remove('visible'); newChatHint.innerHTML = 'Start typing a name…'; return; }
        const matches = allUsers.filter(u => u.name.toLowerCase().includes(ql) || u.email.toLowerCase().includes(ql));
        if (matches.length === 0) {
            newChatSuggestions.classList.remove('visible');
            const link = location.origin + '/';
            newChatHint.innerHTML = '"' + escapeHtml(q) + '" isn\'t on Talk yet. Share this link:<br>' +
                '<span class="invite-link">' + escapeHtml(link) + '</span> <button class="copy-btn" id="copy-invite">Copy link</button>';
            document.getElementById('copy-invite')?.addEventListener('click', async (e) => {
                e.stopPropagation();
                try { await navigator.clipboard.writeText(link); e.target.textContent = 'Copied!'; setTimeout(() => e.target.textContent = 'Copy link', 1500); }
                catch { e.target.textContent = 'Copy failed'; }
            });
            return;
        }
        newChatHint.textContent = matches.length + ' match' + (matches.length === 1 ? '' : 'es');
        for (const u of matches.slice(0,20)) {
            const isContact = contacts.some(c => c.email === u.email);
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            const av = document.createElement('div');
            av.className = 'avatar' + (isOnline(u.email) ? ' online' : '');
            av.textContent = avatarContent(u); av.style.fontSize = u.avatar ? '20px' : '';
            const info = document.createElement('div');
            const nm = document.createElement('div'); nm.className = 'contact-name'; nm.textContent = u.name;
            const sub = document.createElement('div'); sub.className = 'contact-sub';
            sub.textContent = isContact ? 'Already a contact' : (isOnline(u.email) ? 'Available' : 'Offline');
            info.appendChild(nm); info.appendChild(sub);
            item.appendChild(av); item.appendChild(info);
            item.addEventListener('click', () => {
                closeNewChat();
                addContactAPI(u.email).then(() => {
                    const contact = contacts.find(c => c.email === u.email) || u;
                    openDM(contact);
                });
            });
            newChatSuggestions.appendChild(item);
        }
        newChatSuggestions.classList.add('visible');
    }
    newChatInput.addEventListener('input', renderNewChatSuggestions);
    newChatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeNewChat();
        if (e.key === 'Enter') { e.preventDefault(); newChatSuggestions.querySelector('.suggestion-item')?.click(); }
    });

    // ---------- New group modal ----------
    const newGroupBtn = document.getElementById('new-group-btn');
    const newGroupModal = document.getElementById('new-group-modal');
    const newGroupClose = document.getElementById('new-group-close');
    const groupNameInput = document.getElementById('group-name-input');
    const groupSearchInput = document.getElementById('group-search-input');
    const groupSearchResults = document.getElementById('group-search-results');
    const pickedMembersEl = document.getElementById('picked-members');
    const groupModalHint = document.getElementById('group-modal-hint');
    const createGroupBtn = document.getElementById('create-group-btn');
    const groupModalTitle = document.getElementById('group-modal-title');
    const groupMembersLabel = document.getElementById('group-members-label');

    let pickedMembers = new Set();
    let groupModalMode = 'create';
    let addToGroup = null;

    function openNewGroup() {
        groupModalMode = 'create'; addToGroup = null;
        groupModalTitle.textContent = 'New group'; groupMembersLabel.textContent = 'Add members';
        createGroupBtn.textContent = 'Create group'; groupNameInput.style.display = '';
        groupNameInput.value = ''; groupSearchInput.value = '';
        pickedMembers = new Set(); groupModalHint.textContent = '';
        newGroupModal.style.display = 'flex';
        loadAllUsers().then(() => { renderGroupModal(); setTimeout(() => groupNameInput.focus(), 50); });
    }
    function openAddMember(group) {
        groupModalMode = 'add'; addToGroup = group;
        groupModalTitle.textContent = 'Add to ' + group.name; groupMembersLabel.textContent = 'Pick someone to add';
        createGroupBtn.textContent = 'Add to group'; groupNameInput.style.display = 'none';
        groupSearchInput.value = ''; pickedMembers = new Set(); groupModalHint.textContent = '';
        newGroupModal.style.display = 'flex';
        loadAllUsers().then(() => { renderGroupModal(); setTimeout(() => groupSearchInput.focus(), 50); });
    }
    function closeNewGroup() { newGroupModal.style.display = 'none'; }
    newGroupBtn.addEventListener('click', openNewGroup);
    newGroupClose.addEventListener('click', closeNewGroup);
    newGroupModal.addEventListener('click', (e) => { if (e.target === newGroupModal) closeNewGroup(); });

    function renderGroupModal() {
        const q = groupSearchInput.value.trim().toLowerCase();
        groupSearchResults.innerHTML = '';
        let candidates = allUsers;
        if (groupModalMode === 'add' && addToGroup) {
            const mSet = new Set(addToGroup.members);
            candidates = allUsers.filter(u => !mSet.has(u.email));
        }
        const matches = candidates.filter(u => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
        for (const u of matches.slice(0,30)) {
            const item = document.createElement('div');
            item.className = 'suggestion-item' + (pickedMembers.has(u.email) ? ' picked' : '');
            const av = document.createElement('div');
            av.className = 'avatar' + (isOnline(u.email) ? ' online' : '');
            av.textContent = avatarContent(u); av.style.fontSize = u.avatar ? '20px' : '';
            const info = document.createElement('div');
            const nm = document.createElement('div'); nm.className = 'contact-name'; nm.textContent = u.name;
            const sub = document.createElement('div'); sub.className = 'contact-sub';
            sub.textContent = pickedMembers.has(u.email) ? 'Selected' : (isOnline(u.email) ? 'Available' : 'Offline');
            info.appendChild(nm); info.appendChild(sub); item.appendChild(av); item.appendChild(info);
            item.addEventListener('click', () => {
                if (groupModalMode === 'add') pickedMembers = new Set([u.email]);
                else pickedMembers.has(u.email) ? pickedMembers.delete(u.email) : pickedMembers.add(u.email);
                renderGroupModal();
            });
            groupSearchResults.appendChild(item);
        }
        if (matches.length === 0) {
            const e = document.createElement('div'); e.className = 'list-empty'; e.style.padding = '12px';
            e.textContent = allUsers.length === 0 ? 'No other users yet.' : 'No matches.';
            groupSearchResults.appendChild(e);
        }
        pickedMembersEl.innerHTML = '';
        for (const email of pickedMembers) {
            const u = findUser(email);
            const chip = document.createElement('div'); chip.className = 'member-chip';
            chip.innerHTML = '<span>' + escapeHtml(u.name) + '</span>';
            const x = document.createElement('button'); x.textContent = '×';
            x.addEventListener('click', () => { pickedMembers.delete(email); renderGroupModal(); });
            chip.appendChild(x); pickedMembersEl.appendChild(chip);
        }
        if (groupModalMode === 'create') {
            createGroupBtn.disabled = groupNameInput.value.trim().length === 0 || pickedMembers.size < 1;
            groupModalHint.textContent = pickedMembers.size === 0 ? 'Pick at least 1 person.' : pickedMembers.size + ' picked';
        } else {
            createGroupBtn.disabled = pickedMembers.size !== 1;
        }
    }
    groupNameInput.addEventListener('input', renderGroupModal);
    groupSearchInput.addEventListener('input', renderGroupModal);

    createGroupBtn.addEventListener('click', async () => {
        createGroupBtn.disabled = true;
        try {
            if (groupModalMode === 'create') {
                const r = await fetch('/api/groups', { method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({ name: groupNameInput.value.trim(), members: Array.from(pickedMembers), createdBy: me.email }) });
                const d = await r.json();
                if (!r.ok) { groupModalHint.textContent = d.error || 'Could not create'; return; }
                closeNewGroup(); await loadGroups(); openGroup(d.group);
            } else if (groupModalMode === 'add' && addToGroup) {
                const email = Array.from(pickedMembers)[0];
                const r = await fetch('/api/groups/' + encodeURIComponent(addToGroup.id) + '/members', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({ email, addedBy: me.email }) });
                const d = await r.json();
                if (!r.ok) { groupModalHint.textContent = d.error || 'Could not add'; return; }
                closeNewGroup(); await loadGroups();
            }
        } catch { groupModalHint.textContent = 'Network error'; }
        finally { createGroupBtn.disabled = false; }
    });

    addMemberBtn.addEventListener('click', () => { if (activeChat?.kind === 'group') openAddMember(activeChat.group); });

    // ---------- Group settings modal ----------
    const groupSettingsModal = document.getElementById('group-settings-modal');
    const groupSettingsClose = document.getElementById('group-settings-close');
    const groupSettingsName = document.getElementById('group-settings-name');
    const groupRenameBtn = document.getElementById('group-rename-btn');
    const groupRenameHint = document.getElementById('group-rename-hint');
    const groupMembersList = document.getElementById('group-members-list');

    groupSettingsBtn && groupSettingsBtn.addEventListener('click', () => {
        if (activeChat?.kind === 'group') openGroupSettings(activeChat.group);
    });
    groupSettingsClose && groupSettingsClose.addEventListener('click', () => { groupSettingsModal.style.display = 'none'; });
    groupSettingsModal && groupSettingsModal.addEventListener('click', (e) => { if (e.target === groupSettingsModal) groupSettingsModal.style.display = 'none'; });

    function openGroupSettings(group) {
        groupSettingsName.value = group.name;
        groupRenameHint.textContent = '';
        renderGroupMembersList(group);
        groupSettingsModal.style.display = 'flex';
    }

    function renderGroupMembersList(group) {
        groupMembersList.innerHTML = '';
        for (const email of group.members) {
            const u = findUser(email);
            const row = document.createElement('div');
            row.className = 'group-member-row';
            const av = document.createElement('div');
            av.className = 'avatar' + (isOnline(email) ? ' online' : '');
            av.textContent = avatarContent(u);
            av.style.width = '32px'; av.style.height = '32px'; av.style.fontSize = u.avatar ? '18px' : '12px';
            const info = document.createElement('div'); info.style.flex = '1';
            const nm = document.createElement('div'); nm.className = 'contact-name'; nm.style.fontSize = '13px';
            nm.textContent = u.name + (email === me.email ? ' (you)' : '') + (email === group.createdBy ? ' · creator' : '');
            const sub = document.createElement('div'); sub.className = 'contact-sub'; sub.textContent = email;
            info.appendChild(nm); info.appendChild(sub);
            row.appendChild(av); row.appendChild(info);
            if (email !== me.email && group.createdBy === me.email) {
                const rmBtn = document.createElement('button');
                rmBtn.className = 'ghost-btn'; rmBtn.style.padding = '4px 8px'; rmBtn.style.fontSize = '12px';
                rmBtn.textContent = 'Remove';
                rmBtn.addEventListener('click', async () => {
                    if (!confirm('Remove ' + u.name + ' from the group?')) return;
                    const r = await fetch('/api/groups/' + encodeURIComponent(group.id) + '/members/' + encodeURIComponent(email), {
                        method:'DELETE', headers:{'Content-Type':'application/json'},
                        body: JSON.stringify({ email: me.email }) });
                    const d = await r.json();
                    if (r.ok) { activeChat.group = d.group; openGroupSettings(d.group); loadGroups(); }
                });
                row.appendChild(rmBtn);
            }
            groupMembersList.appendChild(row);
        }
    }

    groupRenameBtn && groupRenameBtn.addEventListener('click', async () => {
        if (!activeChat?.group) return;
        const newName = groupSettingsName.value.trim();
        if (!newName) { groupRenameHint.textContent = 'Name cannot be empty'; return; }
        groupRenameBtn.disabled = true;
        try {
            const r = await fetch('/api/groups/' + encodeURIComponent(activeChat.group.id), {
                method:'PATCH', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ name: newName, email: me.email }) });
            const d = await r.json();
            if (!r.ok) { groupRenameHint.textContent = d.error || 'Could not rename'; return; }
            activeChat.group = d.group;
            peerName.textContent = d.group.name;
            groupRenameHint.textContent = 'Renamed!';
            await loadGroups();
            setTimeout(() => { groupRenameHint.textContent = ''; }, 2000);
        } catch { groupRenameHint.textContent = 'Network error'; }
        finally { groupRenameBtn.disabled = false; }
    });

    // ---------- Profile / avatar modal ----------
    const profileModal = document.getElementById('profile-modal');
    const profileClose = document.getElementById('profile-close');
    const profileEmojiGrid = document.getElementById('profile-emoji-grid');
    const profileClearBtn = document.getElementById('profile-clear-btn');
    const profileHint = document.getElementById('profile-hint');

    meAvatar.style.cursor = 'pointer';
    meAvatar.addEventListener('click', openProfileModal);

    profileClose && profileClose.addEventListener('click', () => { profileModal.style.display = 'none'; });
    profileModal && profileModal.addEventListener('click', (e) => { if (e.target === profileModal) profileModal.style.display = 'none'; });

    function openProfileModal() {
        profileEmojiGrid.innerHTML = '';
        for (const emoji of EMOJI_LIST) {
            const btn = document.createElement('button');
            btn.className = 'emoji-btn' + (me.avatar === emoji ? ' selected' : '');
            btn.textContent = emoji;
            btn.addEventListener('click', () => saveAvatar(emoji));
            profileEmojiGrid.appendChild(btn);
        }
        profileHint.textContent = me.avatar ? 'Current: ' + me.avatar : 'Pick a photo emoji';
        profileModal.style.display = 'flex';
    }

    profileClearBtn && profileClearBtn.addEventListener('click', () => saveAvatar(null));

    async function saveAvatar(emoji) {
        try {
            const r = await fetch('/api/users/' + encodeURIComponent(me.email) + '/profile', {
                method:'PATCH', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ avatar: emoji }) });
            const d = await r.json();
            if (r.ok) {
                me.avatar = d.user.avatar;
                localStorage.setItem('talkUser', JSON.stringify(me));
                updateMeAvatar();
                profileModal.style.display = 'none';
                loadAllUsers();
            }
        } catch {}
    }

    // ---------- Message search ----------
    searchBtn && searchBtn.addEventListener('click', () => {
        searchVisible = !searchVisible;
        searchBar.style.display = searchVisible ? 'flex' : 'none';
        if (searchVisible) { searchInput.value = ''; searchResults.innerHTML = ''; setTimeout(() => searchInput.focus(), 50); }
    });
    searchClose && searchClose.addEventListener('click', () => { searchVisible = false; searchBar.style.display = 'none'; searchResults.style.display = 'none'; });

    searchInput && searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        if (!q || !activeChat) { searchResults.style.display = 'none'; searchResults.innerHTML = ''; return; }
        const rows = Array.from(messagesEl.querySelectorAll('.msg-row:not(.deleted-row)'));
        const hits = [];
        for (const row of rows) {
            const bubble = row.querySelector('.msg-bubble');
            if (!bubble) continue;
            const text = bubble.textContent.toLowerCase();
            if (text.includes(q)) hits.push({ el: row, text: bubble.textContent });
        }
        searchResults.innerHTML = '';
        if (hits.length === 0) {
            searchResults.style.display = 'block';
            searchResults.innerHTML = '<div class="search-no-result">No messages found</div>';
            return;
        }
        searchResults.style.display = 'block';
        for (const h of hits.slice(0, 20)) {
            const item = document.createElement('div');
            item.className = 'search-result-item';
            const idx = h.text.toLowerCase().indexOf(q);
            const pre = escapeHtml(h.text.slice(Math.max(0,idx-30), idx));
            const match = escapeHtml(h.text.slice(idx, idx+q.length));
            const post = escapeHtml(h.text.slice(idx+q.length, idx+q.length+60));
            item.innerHTML = '…' + pre + '<mark>' + match + '</mark>' + post + '…';
            item.addEventListener('click', () => {
                searchResults.style.display = 'none';
                h.el.scrollIntoView({ behavior:'smooth', block:'center' });
                h.el.classList.add('highlight-flash');
                setTimeout(() => h.el.classList.remove('highlight-flash'), 1500);
            });
            searchResults.appendChild(item);
        }
        if (hits.length > 20) {
            const more = document.createElement('div'); more.className = 'search-no-result';
            more.textContent = (hits.length - 20) + ' more results…';
            searchResults.appendChild(more);
        }
    });

    // ---------- File sharing ----------
    attachBtn && attachBtn.addEventListener('click', () => fileInput && fileInput.click());
    fileInput && fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        fileInput.value = '';
        if (file.size > 10 * 1024 * 1024) { alert('File too large (max 10MB)'); return; }
        const reader = new FileReader();
        reader.onload = (ev) => {
            const dataUrl = ev.target.result;
            sendFile(file.name, file.type, dataUrl);
        };
        reader.readAsDataURL(file);
    });

    async function sendFile(fileName, fileType, fileData) {
        if (!activeChat) return;
        if (activeChat.kind === 'group') {
            const g = activeChat.group;
            const tempId = 'tmp_' + Date.now();
            const tempMsg = { id: tempId, groupId: g.id, senderEmail: me.email, senderName: me.name,
                text: '', fileName, fileType, fileData, timestamp: new Date().toISOString() };
            appendGroupMessage(tempMsg);
            try {
                const r = await fetch('/api/groups/' + encodeURIComponent(g.id) + '/messages', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({ senderEmail: me.email, fileData, fileName, fileType }) });
                const d = await r.json();
                if (r.ok) {
                    const el = messagesEl.querySelector('[data-id="'+tempId+'"]');
                    if (el) el.dataset.id = d.message.id;
                }
            } catch {}
            return;
        }
        const peerEmail = activeChat.email;
        const tempId = 'tmp_' + Date.now();
        const tempMsg = { id: tempId, senderEmail: me.email, receiverEmail: peerEmail,
            text: '', fileName, fileType, fileData, timestamp: new Date().toISOString() };
        appendDMMessage(tempMsg);
        try {
            const r = await fetch('/api/messages', { method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ senderEmail: me.email, receiverEmail: peerEmail, fileData, fileName, fileType }) });
            const d = await r.json();
            if (r.ok) {
                const el = messagesEl.querySelector('[data-id="'+tempId+'"]');
                if (el) el.dataset.id = d.message.id;
            }
        } catch {}
    }

    // ---------- Voice messages ----------
    voiceBtn && voiceBtn.addEventListener('click', async () => {
        if (isRecording) return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            isRecording = true;
            voiceChunks = [];
            voiceSeconds = 0;
            mediaRecorder = new MediaRecorder(stream);
            mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) voiceChunks.push(e.data); };
            mediaRecorder.onstop = () => {
                for (const t of stream.getTracks()) t.stop();
                const blob = new Blob(voiceChunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.onload = (ev) => sendVoice(ev.target.result, voiceSeconds);
                reader.readAsDataURL(blob);
            };
            mediaRecorder.start();
            composer.style.display = 'none';
            voiceRecordingBar.style.display = 'flex';
            if (voiceTimer) voiceTimer.textContent = '0:00';
            const tick = setInterval(() => {
                if (!isRecording) { clearInterval(tick); return; }
                voiceSeconds++;
                if (voiceTimer) voiceTimer.textContent = formatDuration(voiceSeconds);
                if (voiceSeconds >= 120) stopVoice(true);
            }, 1000);
        } catch(err) { alert('Cannot access microphone: ' + err.message); }
    });

    function stopVoice(send) {
        if (!isRecording) return;
        isRecording = false;
        composer.style.display = '';
        voiceRecordingBar.style.display = 'none';
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            if (!send) {
                const mr = mediaRecorder;
                mr.onstop = null;
                mr.ondataavailable = null;
                mr.stop();
            } else {
                mediaRecorder.stop();
            }
        }
        mediaRecorder = null;
        if (!send) { voiceChunks = []; voiceSeconds = 0; }
    }

    voiceSend && voiceSend.addEventListener('click', () => stopVoice(true));
    voiceCancel && voiceCancel.addEventListener('click', () => stopVoice(false));

    async function sendVoice(voiceData, duration) {
        if (!activeChat) return;
        if (activeChat.kind === 'group') {
            const g = activeChat.group;
            const tempId = 'tmp_' + Date.now();
            appendGroupMessage({ id: tempId, groupId: g.id, senderEmail: me.email, senderName: me.name,
                text: '', voiceData, voiceDuration: duration, timestamp: new Date().toISOString() });
            try {
                await fetch('/api/groups/' + encodeURIComponent(g.id) + '/messages', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({ senderEmail: me.email, voiceData, voiceDuration: duration }) });
            } catch {}
            return;
        }
        const peerEmail = activeChat.email;
        const tempId = 'tmp_' + Date.now();
        appendDMMessage({ id: tempId, senderEmail: me.email, receiverEmail: peerEmail,
            text: '', voiceData, voiceDuration: duration, timestamp: new Date().toISOString() });
        try {
            await fetch('/api/messages', { method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ senderEmail: me.email, receiverEmail: peerEmail, voiceData, voiceDuration: duration }) });
        } catch {}
    }

    // ---------- Open conversations ----------
    async function openDM(u) {
        if (isRecording) stopVoice(false);
        activeChat = { kind: 'dm', email: u.email };
        clearUnread('dm:' + u.email);
        peerAvatar.className = 'avatar' + (isOnline(u.email) ? ' online' : '');
        peerAvatar.textContent = avatarContent(u);
        peerAvatar.style.fontSize = u.avatar ? '20px' : '';
        peerName.textContent = u.name;
        peerStatus.textContent = isOnline(u.email) ? statusLabel(u.status || 'available') : 'Offline';
        addMemberBtn.style.display = 'none';
        groupSettingsBtn && (groupSettingsBtn.style.display = 'none');
        searchBtn && (searchBtn.style.display = '');
        audioCallBtn.style.display = ''; videoCallBtn.style.display = '';
        const gcBtnDM = document.getElementById('group-call-btn');
        if (gcBtnDM) gcBtnDM.style.display = 'none';
        const chBtnDM = document.getElementById('challenge-btn');
        if (chBtnDM) chBtnDM.style.display = '';
        emptyState.style.display = 'none'; convView.style.display = 'flex';
        hideSearch();
        renderContacts();
        messagesEl.innerHTML = '<div class="list-empty">Loading…</div>';
        try {
            const r = await fetch('/api/messages/' + encodeURIComponent(me.email) + '/' + encodeURIComponent(u.email));
            const d = await r.json();
            renderMessages(d.messages || []);
            markMessagesRead(u.email);
        } catch { messagesEl.innerHTML = '<div class="list-empty">Could not load messages.</div>'; }
    }

    async function openAI() {
        if (isRecording) stopVoice(false);
        activeChat = { kind: 'ai', email: AI_BOT_EMAIL };
        clearUnread('ai');
        peerAvatar.className = 'avatar online ai-avatar';
        peerAvatar.textContent = 'AI'; peerAvatar.style.fontSize = '';
        peerName.textContent = AI_BOT_NAME;
        peerStatus.textContent = 'Always here · ask me anything';
        addMemberBtn.style.display = 'none';
        groupSettingsBtn && (groupSettingsBtn.style.display = 'none');
        searchBtn && (searchBtn.style.display = '');
        audioCallBtn.style.display = 'none'; videoCallBtn.style.display = 'none';
        const gcBtnAI = document.getElementById('group-call-btn');
        if (gcBtnAI) gcBtnAI.style.display = 'none';
        const chBtnAI = document.getElementById('challenge-btn');
        if (chBtnAI) chBtnAI.style.display = 'none';
        emptyState.style.display = 'none'; convView.style.display = 'flex';
        hideSearch();
        renderContacts();
        messagesEl.innerHTML = '<div class="list-empty">Loading…</div>';
        try {
            const r = await fetch('/api/messages/' + encodeURIComponent(me.email) + '/' + encodeURIComponent(AI_BOT_EMAIL));
            const d = await r.json();
            let list = d.messages || [];
            if (list.length === 0) {
                renderMessages([{ id: 'welcome', senderEmail: AI_BOT_EMAIL, receiverEmail: me.email,
                    text: "Hi " + (me.name?.split(' ')[0]||'there') + "! I'm Talk AI — ask me anything! I can help with anything you need.",
                    timestamp: new Date().toISOString(), reactions: {}, readBy: [] }]);
            } else {
                renderMessages(list);
            }
        } catch { messagesEl.innerHTML = '<div class="list-empty">Could not load messages.</div>'; }
    }

    async function openGroup(g) {
        if (isRecording) stopVoice(false);
        activeChat = { kind: 'group', group: g };
        clearUnread('g:' + g.id);
        peerAvatar.className = 'avatar group-avatar';
        peerAvatar.textContent = initials(g.name); peerAvatar.style.fontSize = '';
        peerName.textContent = g.name;
        peerStatus.textContent = g.members.length + ' members';
        addMemberBtn.style.display = ''; groupSettingsBtn && (groupSettingsBtn.style.display = '');
        searchBtn && (searchBtn.style.display = '');
        audioCallBtn.style.display = 'none'; videoCallBtn.style.display = 'none';
        const gcBtn = document.getElementById('group-call-btn');
        if (gcBtn) gcBtn.style.display = '';
        const chBtnGrp = document.getElementById('challenge-btn');
        if (chBtnGrp) chBtnGrp.style.display = 'none';
        emptyState.style.display = 'none'; convView.style.display = 'flex';
        hideSearch();
        renderContacts();
        messagesEl.innerHTML = '<div class="list-empty">Loading…</div>';
        try {
            const r = await fetch('/api/groups/' + encodeURIComponent(g.id) + '/messages?email=' + encodeURIComponent(me.email));
            const d = await r.json();
            if (d.group) {
                activeChat.group = d.group;
                peerStatus.textContent = d.group.members.length + ' members';
                const idx = groups.findIndex(x => x.id === g.id);
                if (idx >= 0) groups[idx] = d.group;
            }
            renderGroupMessages(d.messages || []);
        } catch { messagesEl.innerHTML = '<div class="list-empty">Could not load messages.</div>'; }
    }

    function hideSearch() {
        searchVisible = false;
        if (searchBar) searchBar.style.display = 'none';
        if (searchResults) { searchResults.style.display = 'none'; searchResults.innerHTML = ''; }
    }

    async function markMessagesRead(otherEmail) {
        try {
            await fetch('/api/messages/' + encodeURIComponent(me.email) + '/' + encodeURIComponent(otherEmail) + '/read', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ reader: me.email }) });
        } catch {}
    }

    // ---------- Messages ----------
    function renderMarkdown(text) {
        if (!text) return '';
        let s = String(text);
        // Escape HTML first
        s = s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        // Code blocks (``` ... ```)
        s = s.replace(/```([a-z]*)\n?([\s\S]*?)```/g, (_, lang, code) =>
            '<pre class="md-pre"><code' + (lang ? ' class="lang-'+lang+'"' : '') + '>' + code.trim() + '</code></pre>');
        // Inline code
        s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
        // Horizontal rule
        s = s.replace(/^---$/gm, '<hr class="md-hr">');
        // Tables (| ... |)
        s = s.replace(/((?:\|[^\n]+\|\n?)+)/g, (match) => {
            const rows = match.trim().split('\n').filter(r => r.trim());
            if (rows.length < 2) return match;
            const isSep = r => /^\|[-| :]+\|$/.test(r.trim());
            let html = '<table class="md-table"><thead><tr>';
            const headers = rows[0].split('|').filter((_, i, a) => i > 0 && i < a.length - 1);
            for (const h of headers) html += '<th>' + h.trim() + '</th>';
            html += '</tr></thead><tbody>';
            for (let i = 1; i < rows.length; i++) {
                if (isSep(rows[i])) continue;
                const cells = rows[i].split('|').filter((_, j, a) => j > 0 && j < a.length - 1);
                html += '<tr>';
                for (const c of cells) html += '<td>' + c.trim() + '</td>';
                html += '</tr>';
            }
            html += '</tbody></table>';
            return html;
        });
        // Headings
        s = s.replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>');
        s = s.replace(/^## (.+)$/gm, '<h2 class="md-h2">$1</h2>');
        s = s.replace(/^# (.+)$/gm, '<h1 class="md-h1">$1</h1>');
        // Blockquote
        s = s.replace(/^&gt; (.+)$/gm, '<blockquote class="md-bq">$1</blockquote>');
        // Unordered list items
        s = s.replace(/^[-*] (.+)$/gm, '<li class="md-li">$1</li>');
        s = s.replace(/(<li class="md-li">[\s\S]*?<\/li>)(?=\s*(?:<li|<h|<p|<hr|$))/g, '<ul class="md-ul">$1</ul>');
        // Ordered list items
        s = s.replace(/^\d+\. (.+)$/gm, '<li class="md-oli">$1</li>');
        s = s.replace(/(<li class="md-oli">[\s\S]*?<\/li>)(?=\s*(?:<li|<h|<p|<hr|$))/g, '<ol class="md-ol">$1</ol>');
        // Bold + italic
        s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
        // Checkboxes
        s = s.replace(/\[ \] /g, '<input type="checkbox" disabled> ');
        s = s.replace(/\[x\] /gi, '<input type="checkbox" checked disabled> ');
        // Links
        s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="msg-link">$1</a>');
        // Plain URLs
        s = s.replace(/(?<![">])(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="msg-link">$1</a>');
        // Newlines → <br> (but not inside block elements)
        s = s.replace(/\n/g, '<br>');
        // Clean up excess <br> around block elements
        s = s.replace(/(<br>)*(<\/?(?:pre|ul|ol|table|h[123]|blockquote|hr)[^>]*>)(<br>)*/g, '$2');
        return s;
    }

    function linkify(text) {
        const escaped = escapeHtml(text);
        return escaped.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="msg-link">$1</a>');
    }

    const scrollFab = document.getElementById('scroll-fab');
    function scrollToBottom() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
        if (scrollFab) scrollFab.style.display = 'none';
    }
    function smartScroll() {
        const dist = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
        if (dist < 160) scrollToBottom();
        else if (scrollFab) scrollFab.style.display = 'flex';
    }
    scrollFab && scrollFab.addEventListener('click', () => { messagesEl.scrollTop = messagesEl.scrollHeight; scrollFab.style.display = 'none'; });
    messagesEl.addEventListener('scroll', () => {
        if (!scrollFab) return;
        const dist = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
        if (dist < 80) scrollFab.style.display = 'none';
    });

    function openLightbox(src, alt) {
        const lb = document.getElementById('img-lightbox');
        const lbImg = document.getElementById('img-lightbox-img');
        if (!lb || !lbImg) { window.open(src, '_blank'); return; }
        lbImg.src = src; lbImg.alt = alt || 'image';
        lb.style.display = 'flex';
    }
    function closeLightbox() {
        const lb = document.getElementById('img-lightbox');
        if (lb) lb.style.display = 'none';
    }
    document.getElementById('img-lightbox')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('img-lightbox')) closeLightbox();
    });
    document.getElementById('lightbox-close')?.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

    function dateKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
    function makeDateDivider(ts) {
        const d = new Date(ts); const now = new Date();
        const diff = Math.floor((now - d) / 86400000);
        const label = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString([], { weekday:'long', month:'short', day:'numeric' });
        const div = document.createElement('div'); div.className = 'date-divider';
        const span = document.createElement('span'); span.textContent = label;
        div.appendChild(span); return div;
    }

    function renderMessages(list) {
        messagesEl.innerHTML = '';
        let lastDate = null;
        for (const m of list) {
            const dk = dateKey(m.timestamp);
            if (dk !== lastDate) { messagesEl.appendChild(makeDateDivider(m.timestamp)); lastDate = dk; }
            appendDMMessage(m, false);
        }
        scrollToBottom();
    }
    function renderGroupMessages(list) {
        messagesEl.innerHTML = '';
        let lastDate = null;
        for (const m of list) {
            const dk = dateKey(m.timestamp);
            if (dk !== lastDate) { messagesEl.appendChild(makeDateDivider(m.timestamp)); lastDate = dk; }
            appendGroupMessage(m, false);
        }
        scrollToBottom();
    }
    function formatTime(ts) { try { return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); } catch { return ''; } }

    function buildFileBubble(m) {
        if (m.voiceData) {
            const wrap = document.createElement('div'); wrap.className = 'voice-msg';
            const audio = document.createElement('audio');
            audio.src = m.voiceData; audio.controls = true;
            const dur = document.createElement('span'); dur.className = 'voice-duration';
            dur.textContent = m.voiceDuration ? formatDuration(m.voiceDuration) : '';
            wrap.appendChild(audio); wrap.appendChild(dur);
            return wrap;
        }
        if (m.fileData) {
            const isImg = m.fileType && m.fileType.startsWith('image/');
            if (isImg) {
                const img = document.createElement('img');
                img.src = m.fileData; img.className = 'msg-image'; img.alt = m.fileName || 'image';
                img.addEventListener('click', () => openLightbox(m.fileData, m.fileName));
                return img;
            }
            const wrap = document.createElement('div'); wrap.className = 'file-msg';
            const icon = document.createElement('div'); icon.className = 'file-icon'; icon.textContent = '📎';
            const info = document.createElement('div');
            const name = document.createElement('div'); name.className = 'file-name'; name.textContent = m.fileName || 'File';
            const size = document.createElement('div'); size.className = 'file-size';
            const byteSize = Math.round((m.fileData.length * 3) / 4);
            size.textContent = formatBytes(byteSize);
            info.appendChild(name); info.appendChild(size);
            const dl = document.createElement('a'); dl.href = m.fileData; dl.download = m.fileName || 'file';
            dl.className = 'file-dl'; dl.textContent = '↓';
            wrap.appendChild(icon); wrap.appendChild(info); wrap.appendChild(dl);
            return wrap;
        }
        return null;
    }

    function buildReactionsEl(reactions, msgId, isGroup, groupId) {
        const el = document.createElement('div'); el.className = 'msg-reactions'; el.dataset.msgId = msgId;
        updateReactionsEl(el, reactions, msgId, isGroup, groupId);
        return el;
    }

    function updateReactionsEl(el, reactions, msgId, isGroup, groupId) {
        el.innerHTML = '';
        for (const [emoji, users] of Object.entries(reactions || {})) {
            if (!users.length) continue;
            const chip = document.createElement('button');
            chip.className = 'reaction-chip' + (users.includes(me.email) ? ' mine' : '');
            chip.title = users.map(e => findUser(e).name).join(', ');
            chip.textContent = emoji + ' ' + users.length;
            chip.addEventListener('click', () => reactToMessage(msgId, emoji, isGroup, groupId));
            el.appendChild(chip);
        }
    }

    function buildActionBar(m, isGroup, groupId) {
        const bar = document.createElement('div'); bar.className = 'msg-action-bar';
        // Emoji reaction picker
        const reactBtn = document.createElement('button'); reactBtn.className = 'msg-action-btn'; reactBtn.title = 'React';
        reactBtn.innerHTML = '😊';
        reactBtn.addEventListener('click', (e) => { e.stopPropagation(); showReactionPicker(reactBtn, m.id, isGroup, groupId); });
        bar.appendChild(reactBtn);
        // Edit (own messages only, not deleted, not file/voice)
        if (m.senderEmail === me.email && !m.deleted && m.text && !m.fileData && !m.voiceData) {
            const editBtn = document.createElement('button'); editBtn.className = 'msg-action-btn'; editBtn.title = 'Edit';
            editBtn.innerHTML = '✏️';
            editBtn.addEventListener('click', (e) => { e.stopPropagation(); startEditMessage(m, isGroup, groupId); });
            bar.appendChild(editBtn);
        }
        // Delete (own messages only)
        if (m.senderEmail === me.email && !m.deleted) {
            const delBtn = document.createElement('button'); delBtn.className = 'msg-action-btn'; delBtn.title = 'Delete';
            delBtn.innerHTML = '🗑️';
            delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteMessage(m.id, isGroup, groupId); });
            bar.appendChild(delBtn);
        }
        return bar;
    }

    function attachLongPress(row) {
        let timer = null;
        row.addEventListener('touchstart', (e) => {
            timer = setTimeout(() => {
                document.querySelectorAll('.msg-row.touch-active').forEach(r => r.classList.remove('touch-active'));
                row.classList.add('touch-active');
                timer = null;
            }, 550);
        }, { passive: true });
        row.addEventListener('touchend', () => { if (timer) { clearTimeout(timer); timer = null; } });
        row.addEventListener('touchmove', () => { if (timer) { clearTimeout(timer); timer = null; } });
    }

    document.addEventListener('touchstart', (e) => {
        if (!e.target.closest('.msg-action-bar')) {
            document.querySelectorAll('.msg-row.touch-active').forEach(r => r.classList.remove('touch-active'));
        }
    }, { passive: true });

    function appendDMMessage(m, scroll=true) {
        if (m.deleted) {
            const row = document.createElement('div');
            row.className = 'msg-row deleted-row' + (m.senderEmail === me.email ? ' me' : '');
            row.dataset.id = m.id;
            row.innerHTML = '<div><div class="msg-bubble deleted-bubble">🗑 Message deleted</div></div>';
            messagesEl.appendChild(row);
            if (scroll) scrollToBottom();
            return;
        }
        // Challenge card rendering
        if (m.challengeId && m._challenge) {
            const row = document.createElement('div');
            row.className = 'msg-row challenge-row'; row.dataset.id = m.id;
            const card = renderChallengeCard(m, m.senderEmail === me.email);
            if (card) {
                row.appendChild(card);
                messagesEl.appendChild(row);
                if (scroll) scrollToBottom();
                return;
            }
        }
        const isMe = m.senderEmail === me.email;
        const row = document.createElement('div');
        row.className = 'msg-row' + (isMe ? ' me' : ''); row.dataset.id = m.id;
        const wrap = document.createElement('div');
        const fileBubble = buildFileBubble(m);
        const isAIMsg = m.senderEmail === AI_BOT_EMAIL;
        if (fileBubble) {
            wrap.appendChild(fileBubble);
        } else {
            const bubble = document.createElement('div');
            bubble.className = 'msg-bubble' + (isAIMsg ? ' ai-bubble' : '');
            if (m.text) bubble.innerHTML = isAIMsg ? renderMarkdown(m.text) : linkify(m.text);
            wrap.appendChild(bubble);
        }
        if (m.edited && !m.deleted) {
            const editedMark = document.createElement('span'); editedMark.className = 'edited-mark'; editedMark.textContent = ' (edited)';
            (wrap.querySelector('.msg-bubble') || wrap.lastChild).appendChild(editedMark);
        }
        const time = document.createElement('div'); time.className = 'msg-time';
        time.textContent = formatTime(m.timestamp);
        if (isMe && m.readBy && m.readBy.length > 0) {
            const tick = document.createElement('span'); tick.className = 'read-tick'; tick.textContent = ' ✓✓';
            tick.title = 'Read';
            time.appendChild(tick);
        }
        wrap.appendChild(time);

        const actionBar = buildActionBar(m, false, null);
        row.appendChild(wrap);
        row.appendChild(actionBar);
        attachLongPress(row);

        if (m.reactions && Object.keys(m.reactions).length > 0) {
            const reactEl = buildReactionsEl(m.reactions, m.id, false, null);
            row.appendChild(reactEl);
        }

        messagesEl.appendChild(row);
        if (scroll) smartScroll();
    }

    function appendGroupMessage(m, scroll=true) {
        if (m.system) {
            const row = document.createElement('div'); row.className = 'system-msg'; row.textContent = m.text;
            messagesEl.appendChild(row); if (scroll) scrollToBottom(); return;
        }
        if (m.deleted) {
            const row = document.createElement('div');
            row.className = 'msg-row group-msg deleted-row' + (m.senderEmail === me.email ? ' me' : '');
            row.dataset.id = m.id;
            row.innerHTML = '<div><div class="msg-bubble deleted-bubble">🗑 Message deleted</div></div>';
            messagesEl.appendChild(row);
            if (scroll) scrollToBottom();
            return;
        }
        const isMe = m.senderEmail === me.email;
        const row = document.createElement('div');
        row.className = 'msg-row group-msg' + (isMe ? ' me' : ''); row.dataset.id = m.id;
        const wrap = document.createElement('div');
        if (!isMe) {
            const author = document.createElement('div'); author.className = 'msg-author';
            author.textContent = m.senderName || m.senderEmail; wrap.appendChild(author);
        }
        const fileBubble = buildFileBubble(m);
        if (fileBubble) {
            wrap.appendChild(fileBubble);
        } else {
            const bubble = document.createElement('div');
            bubble.className = 'msg-bubble';
            if (m.text) bubble.innerHTML = linkify(m.text);
            wrap.appendChild(bubble);
        }
        if (m.edited && !m.deleted) {
            const editedMark = document.createElement('span'); editedMark.className = 'edited-mark'; editedMark.textContent = ' (edited)';
            (wrap.querySelector('.msg-bubble') || wrap.lastChild).appendChild(editedMark);
        }
        const time = document.createElement('div'); time.className = 'msg-time'; time.textContent = formatTime(m.timestamp);
        wrap.appendChild(time); row.appendChild(wrap);

        const actionBar = buildActionBar(m, true, activeChat?.group?.id || m.groupId);
        row.appendChild(actionBar);
        attachLongPress(row);

        if (m.reactions && Object.keys(m.reactions).length > 0) {
            const reactEl = buildReactionsEl(m.reactions, m.id, true, activeChat?.group?.id || m.groupId);
            row.appendChild(reactEl);
        }

        messagesEl.appendChild(row);
        if (scroll) smartScroll();
    }

    // ---------- Reaction picker ----------
    let reactionPicker = null;
    function showReactionPicker(anchorBtn, msgId, isGroup, groupId) {
        if (reactionPicker) { reactionPicker.remove(); reactionPicker = null; return; }
        const picker = document.createElement('div'); picker.className = 'reaction-picker';
        for (const emoji of REACTION_EMOJI) {
            const btn = document.createElement('button');
            btn.textContent = emoji;
            btn.addEventListener('click', () => { reactToMessage(msgId, emoji, isGroup, groupId); picker.remove(); reactionPicker = null; });
            picker.appendChild(btn);
        }
        document.body.appendChild(picker);
        reactionPicker = picker;
        const rect = anchorBtn.getBoundingClientRect();
        picker.style.top = (rect.top - 50) + 'px';
        picker.style.left = rect.left + 'px';
        setTimeout(() => document.addEventListener('click', () => { picker.remove(); reactionPicker = null; }, { once: true }), 10);
    }

    async function reactToMessage(msgId, emoji, isGroup, groupId) {
        try {
            let url;
            if (isGroup && groupId) url = '/api/groups/' + encodeURIComponent(groupId) + '/messages/' + encodeURIComponent(msgId) + '/react';
            else url = '/api/messages/' + encodeURIComponent(msgId) + '/react';
            await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ email: me.email, emoji }) });
        } catch {}
    }

    // ---------- Edit message ----------
    function startEditMessage(m, isGroup, groupId) {
        const row = messagesEl.querySelector('[data-id="' + m.id + '"]');
        if (!row) return;
        const bubble = row.querySelector('.msg-bubble');
        if (!bubble) return;
        const oldText = m.text || bubble.innerText || '';
        const input = document.createElement('input');
        input.type = 'text'; input.value = oldText;
        input.className = 'edit-input';
        bubble.innerHTML = '';
        bubble.appendChild(input);
        input.focus(); input.select();
        let saved = false;
        const save = async () => {
            if (saved) return; saved = true;
            const newText = input.value.trim();
            if (!newText || newText === oldText) { bubble.innerHTML = linkify(oldText); return; }
            try {
                let url, body;
                if (isGroup && groupId) {
                    url = '/api/groups/' + encodeURIComponent(groupId) + '/messages/' + encodeURIComponent(m.id);
                    body = { email: me.email, text: newText };
                } else {
                    url = '/api/messages/' + encodeURIComponent(m.id);
                    body = { email: me.email, text: newText };
                }
                const r = await fetch(url, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
                if (r.ok) { m.text = newText; bubble.innerHTML = linkify(newText); }
                else bubble.innerHTML = linkify(oldText);
            } catch { bubble.innerHTML = linkify(oldText); }
        };
        const cancel = () => { if (saved) return; saved = true; bubble.innerHTML = linkify(oldText); };
        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
    }

    // ---------- Delete message ----------
    async function deleteMessage(msgId, isGroup, groupId) {
        if (!confirm('Delete this message?')) return;
        try {
            let url;
            if (isGroup && groupId) url = '/api/groups/' + encodeURIComponent(groupId) + '/messages/' + encodeURIComponent(msgId);
            else url = '/api/messages/' + encodeURIComponent(msgId);
            await fetch(url, { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: me.email }) });
        } catch {}
    }

    function removeOptimisticDM(serverMsg) {
        if (serverMsg.senderEmail !== me.email) return;
        for (const r of messagesEl.querySelectorAll('.msg-row.me')) {
            if ((r.dataset.id||'').startsWith('tmp_')) {
                const b = r.querySelector('.msg-bubble');
                if (b && (b.innerText || b.textContent).trim() === (serverMsg.text || '').trim()) {
                    r.dataset.id = serverMsg.id; return;
                }
                if (serverMsg.fileData || serverMsg.voiceData) { r.dataset.id = serverMsg.id; return; }
            }
        }
    }
    function markFailed(tempId, reason) {
        for (const r of messagesEl.querySelectorAll('.msg-row')) {
            if (r.dataset.id === tempId) {
                const t = r.querySelector('.msg-time');
                if (t) { t.textContent = 'Not sent · ' + reason; t.classList.add('failed'); }
                return;
            }
        }
    }

    function showAIThinking(on) {
        document.getElementById('ai-thinking')?.remove();
        if (!on) return;
        const row = document.createElement('div');
        row.className = 'msg-row'; row.id = 'ai-thinking';
        row.innerHTML = '<div><div class="msg-bubble thinking"><span></span><span></span><span></span></div></div>';
        messagesEl.appendChild(row); scrollToBottom();
    }

    // ---------- Composer ----------
    composer.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = messageInput.value.trim();
        if (!text || !activeChat) return;

        if (activeChat.kind === 'group') {
            const g = activeChat.group;
            const tempId = 'tmp_' + Date.now() + Math.random().toString(36).slice(2,6);
            appendGroupMessage({ id:tempId, groupId:g.id, senderEmail:me.email, senderName:me.name, text, timestamp:new Date().toISOString(), reactions:{} });
            messageInput.value = ''; sendGroupTyping(false);
            let ok = false;
            if (ws?.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type:'group-message', groupId:g.id, text })); ok=true; } catch {} }
            if (!ok) {
                try {
                    const r = await fetch('/api/groups/' + encodeURIComponent(g.id) + '/messages', {
                        method:'POST', headers:{'Content-Type':'application/json'},
                        body: JSON.stringify({ senderEmail:me.email, text }) });
                    if (!r.ok) { const d = await r.json().catch(()=>({})); markFailed(tempId, d.error||'Failed'); }
                } catch { markFailed(tempId, 'No connection'); }
            }
            return;
        }

        const peerEmail = activeChat.email;
        const tempId = 'tmp_' + Date.now() + Math.random().toString(36).slice(2,6);
        appendDMMessage({ id:tempId, senderEmail:me.email, receiverEmail:peerEmail, text, timestamp:new Date().toISOString(), reactions:{}, readBy:[] });
        messageInput.value = ''; sendDMTyping(false);
        if (activeChat.kind === 'ai') showAIThinking(true);
        let ok = false;
        if (ws?.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type:'message', to:peerEmail, text })); ok=true; } catch {} }
        if (!ok) {
            try {
                const r = await fetch('/api/messages', { method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({ senderEmail:me.email, receiverEmail:peerEmail, text }) });
                if (!r.ok) {
                    const d = await r.json().catch(()=>({}));
                    markFailed(tempId, d.error||'Failed');
                    if (activeChat.kind === 'ai') showAIThinking(false);
                }
            } catch { markFailed(tempId, 'No connection'); if (activeChat.kind==='ai') showAIThinking(false); }
        }
    });

    // ---------- Typing ----------
    let dmTypingState=false, dmTypingTimer=null, groupTypingState=false, groupTypingTimer=null;
    function sendDMTyping(on) {
        if (!activeChat || activeChat.kind!=='dm' || ws?.readyState!==WebSocket.OPEN) return;
        if (on !== dmTypingState) { dmTypingState=on; ws.send(JSON.stringify({ type:'typing', to:activeChat.email, isTyping:on })); }
    }
    function sendGroupTyping(on) {
        if (!activeChat || activeChat.kind!=='group' || ws?.readyState!==WebSocket.OPEN) return;
        if (on !== groupTypingState) { groupTypingState=on; ws.send(JSON.stringify({ type:'group-typing', groupId:activeChat.group.id, isTyping:on })); }
    }
    messageInput.addEventListener('input', () => {
        const has = messageInput.value.length > 0;
        if (activeChat?.kind === 'dm') {
            sendDMTyping(has); clearTimeout(dmTypingTimer);
            if (has) dmTypingTimer = setTimeout(() => sendDMTyping(false), 2500);
        } else if (activeChat?.kind === 'group') {
            sendGroupTyping(has); clearTimeout(groupTypingTimer);
            if (has) groupTypingTimer = setTimeout(() => sendGroupTyping(false), 2500);
        }
    });
    messageInput.addEventListener('blur', () => { clearTimeout(dmTypingTimer); sendDMTyping(false); clearTimeout(groupTypingTimer); sendGroupTyping(false); });

    let peerTypingTimer=null;
    function showDMTyping(on) {
        if (!activeChat || activeChat.kind!=='dm') return;
        clearTimeout(peerTypingTimer);
        const u = findUser(activeChat.email);
        peerStatus.textContent = on ? u.name.split(' ')[0] + ' is typing…' : (isOnline(u.email) ? statusLabel(u.status||'available') : 'Offline');
        if (on) peerTypingTimer = setTimeout(() => showDMTyping(false), 4000);
    }
    const groupPeerTypers = new Map();
    function showGroupTyping(email, name, on) {
        if (!activeChat || activeChat.kind!=='group' || email===me.email) return;
        const existing = groupPeerTypers.get(email);
        if (existing) clearTimeout(existing.timer);
        if (on) {
            const timer = setTimeout(() => { groupPeerTypers.delete(email); refreshGroupTyping(); }, 4000);
            groupPeerTypers.set(email, { name, timer });
        } else groupPeerTypers.delete(email);
        refreshGroupTyping();
    }
    function refreshGroupTyping() {
        if (!activeChat || activeChat.kind!=='group') return;
        const names = Array.from(groupPeerTypers.values()).map(v => v.name.split(' ')[0]);
        if (!names.length) peerStatus.textContent = activeChat.group.members.length + ' members';
        else if (names.length === 1) peerStatus.textContent = names[0] + ' is typing…';
        else if (names.length === 2) peerStatus.textContent = names.join(' & ') + ' are typing…';
        else peerStatus.textContent = 'Several people are typing…';
    }

    // ---------- WebSocket ----------
    function connectWS() {
        wsReconnectDelay = wsReconnectDelay || 2000;
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(proto + '//' + location.host + '/ws');
        ws.addEventListener('open', () => { wsReconnectDelay = 2000; ws.send(JSON.stringify({ type:'hello', email:me.email })); });
        ws.addEventListener('message', (ev) => { try { handleWS(JSON.parse(ev.data)); } catch {} });
        ws.addEventListener('close', () => {
            if (!me) return;
            setTimeout(() => { if (me) connectWS(); }, wsReconnectDelay);
            wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
        });
    }

    function handleWS(msg) {
        if (msg.type === 'presence') {
            onlineSet = new Set(msg.online);
            renderContacts();
            if (activeChat?.kind === 'dm') {
                const on = isOnline(activeChat.email);
                const u = findUser(activeChat.email);
                if (!peerStatus.textContent.includes('typing')) peerStatus.textContent = on ? statusLabel(u.status||'available') : 'Offline';
                peerAvatar.className = 'avatar' + (on ? ' online' : '');
            }
            return;
        }
        if (msg.type === 'user-status') {
            const u = allUsers.find(x => x.email === msg.email);
            if (u) { u.status = msg.status; if (msg.avatar) u.avatar = msg.avatar; if (msg.name) u.name = msg.name; }
            const c = contacts.find(x => x.email === msg.email);
            if (c) { c.status = msg.status; if (msg.avatar) c.avatar = msg.avatar; if (msg.name) c.name = msg.name; }
            renderContacts();
            if (activeChat?.kind === 'dm' && activeChat.email === msg.email) {
                peerStatus.textContent = isOnline(msg.email) ? statusLabel(msg.status) : 'Offline';
            }
            return;
        }
        if (msg.type === 'message') {
            const m = msg.message;
            const other = m.senderEmail === me.email ? m.receiverEmail : m.senderEmail;
            const isAI = other === AI_BOT_EMAIL;
            const isCurrent = activeChat && ((activeChat.kind==='dm' && activeChat.email===other) || (activeChat.kind==='ai' && isAI));
            const doAppend = async (msgObj) => {
                if (msgObj.challengeId && !msgObj._challenge) {
                    try {
                        const cr = await fetch('/api/challenges/' + encodeURIComponent(msgObj.challengeId));
                        const cd = await cr.json();
                        if (cd.challenge) msgObj._challenge = cd.challenge;
                    } catch {}
                }
                appendDMMessage(msgObj);
            };
            if (isCurrent) {
                if (m.senderEmail === me.email) {
                    removeOptimisticDM(m);
                    if (m.challengeId) doAppend(m);
                } else { if (isAI) showAIThinking(false); doAppend(m); markMessagesRead(other); }
            } else if (m.senderEmail !== me.email) {
                bumpUnread(isAI ? 'ai' : 'dm:'+other);
                renderContacts();
                const notifText = m.challengeId ? '⚔️ Game challenge!' : (m.text || (m.voiceData ? '🎤 Voice message' : '📎 File'));
                notify(findUser(m.senderEmail).name, notifText, 'msg:'+m.senderEmail);
            }
            return;
        }
        if (msg.type === 'message-edited') {
            const m = msg.message;
            const row = messagesEl.querySelector('[data-id="' + m.id + '"]');
            if (row) {
                const bubble = row.querySelector('.msg-bubble');
                if (bubble) {
                    const isAI = m.senderEmail === AI_BOT_EMAIL;
                    bubble.innerHTML = isAI ? renderMarkdown(m.text) : linkify(m.text);
                    if (!row.querySelector('.edited-mark')) {
                        const mark = document.createElement('span'); mark.className = 'edited-mark'; mark.textContent = ' (edited)';
                        bubble.appendChild(mark);
                    }
                }
            }
            return;
        }
        if (msg.type === 'message-deleted') {
            const row = messagesEl.querySelector('[data-id="' + msg.messageId + '"]');
            if (row) {
                const wasMe = row.classList.contains('me');
                row.className = 'msg-row deleted-row' + (wasMe ? ' me' : '');
                row.innerHTML = '<div><div class="msg-bubble deleted-bubble">🗑 Message deleted</div></div>';
            }
            return;
        }
        if (msg.type === 'message-reacted') {
            const row = messagesEl.querySelector('[data-id="' + msg.messageId + '"]');
            if (row) {
                let reactEl = row.querySelector('.msg-reactions');
                if (!reactEl) { reactEl = document.createElement('div'); reactEl.className = 'msg-reactions'; row.appendChild(reactEl); }
                updateReactionsEl(reactEl, msg.reactions, msg.messageId, false, null);
            }
            return;
        }
        if (msg.type === 'messages-read') {
            // Update tick marks on my sent messages in this conversation
            if (activeChat?.kind === 'dm') {
                for (const row of messagesEl.querySelectorAll('.msg-row.me')) {
                    const time = row.querySelector('.msg-time');
                    if (time && !time.querySelector('.read-tick')) {
                        const tick = document.createElement('span'); tick.className = 'read-tick'; tick.textContent = ' ✓✓'; tick.title = 'Read';
                        time.appendChild(tick);
                    }
                }
            }
            return;
        }
        if (msg.type === 'group-message') {
            const m = msg.message;
            const isCurrent = activeChat?.kind==='group' && activeChat.group.id===m.groupId;
            if (isCurrent) {
                if (m.senderEmail === me.email) {
                    let replaced = false;
                    for (const r of messagesEl.querySelectorAll('.msg-row.me')) {
                        if ((r.dataset.id||'').startsWith('tmp_')) {
                            const b = r.querySelector('.msg-bubble');
                            if (b && b.textContent === m.text) { r.dataset.id=m.id; replaced=true; break; }
                        }
                    }
                    if (!replaced) appendGroupMessage(m);
                } else appendGroupMessage(m);
            } else if (m.senderEmail !== me.email) {
                bumpUnread('g:'+m.groupId); renderContacts();
                const g = groups.find(x=>x.id===m.groupId);
                notify(g?.name||'Group', (m.senderName||'Someone')+': '+(m.text || (m.voiceData?'🎤 Voice':'📎 File')), 'g:'+m.groupId);
            }
            return;
        }
        if (msg.type === 'group-message-edited') {
            const m = msg.message;
            const row = messagesEl.querySelector('[data-id="' + m.id + '"]');
            if (row) {
                const bubble = row.querySelector('.msg-bubble');
                if (bubble) {
                    bubble.innerHTML = linkify(m.text);
                    if (!row.querySelector('.edited-mark')) {
                        const mark = document.createElement('span'); mark.className = 'edited-mark'; mark.textContent = ' (edited)';
                        bubble.appendChild(mark);
                    }
                }
            }
            return;
        }
        if (msg.type === 'group-message-deleted') {
            const row = messagesEl.querySelector('[data-id="' + msg.messageId + '"]');
            if (row) {
                const wasMe = row.classList.contains('me');
                row.className = 'msg-row deleted-row' + (wasMe ? ' me' : '');
                row.innerHTML = '<div><div class="msg-bubble deleted-bubble">🗑 Message deleted</div></div>';
            }
            return;
        }
        if (msg.type === 'group-message-reacted') {
            const row = messagesEl.querySelector('[data-id="' + msg.messageId + '"]');
            if (row) {
                let reactEl = row.querySelector('.msg-reactions');
                if (!reactEl) { reactEl = document.createElement('div'); reactEl.className = 'msg-reactions'; row.appendChild(reactEl); }
                updateReactionsEl(reactEl, msg.reactions, msg.messageId, true, msg.groupId);
            }
            return;
        }
        if (msg.type === 'group-created' || msg.type === 'group-updated') {
            loadGroups();
            if (activeChat?.kind==='group' && msg.group && activeChat.group.id===msg.group.id) {
                activeChat.group = msg.group;
                peerName.textContent = msg.group.name;
                peerStatus.textContent = msg.group.members.length + ' members';
                if (groupSettingsModal?.style.display==='flex') openGroupSettings(msg.group);
            }
            return;
        }
        if (msg.type === 'group-typing') {
            if (activeChat?.kind==='group' && activeChat.group.id===msg.groupId)
                showGroupTyping(msg.from, msg.fromName, !!msg.isTyping);
            return;
        }
        if (msg.type === 'typing') {
            if (activeChat?.kind==='dm' && msg.from===activeChat.email) showDMTyping(!!msg.isTyping);
            return;
        }
        if (msg.type === 'call-invite') return handleIncomingCall(msg);
        if (msg.type === 'call-accept') return handleCallAccepted(msg);
        if (['call-reject','call-cancel','call-end'].includes(msg.type)) return handleCallEnded(msg);
        if (msg.type === 'webrtc-offer') return handleRemoteOffer(msg);
        if (msg.type === 'webrtc-answer') return handleRemoteAnswer(msg);
        if (msg.type === 'webrtc-ice') return handleRemoteIce(msg);
        if (msg.type === 'group-call-invite') return handleGroupCallInvite(msg);
        if (msg.type === 'group-call-state') return handleGroupCallState(msg);
        if (msg.type === 'group-webrtc-offer') return handleGroupWebRTCOffer(msg);
        if (msg.type === 'group-webrtc-answer') return handleGroupWebRTCAnswer(msg);
        if (msg.type === 'group-webrtc-ice') return handleGroupWebRTCIce(msg);
        if (msg.type === 'challenge-updated') {
            updateChallengeCard(msg.challenge);
            return;
        }
    }

    // ---------- Permissions modal ----------
    const permModal = document.getElementById('perm-modal');
    const permAllowBtn = document.getElementById('perm-allow');
    const permSkipBtn = document.getElementById('perm-skip');
    const permHint = document.getElementById('perm-hint');

    function setPermStatus(which, status) {
        const el = document.getElementById('perm-status-' + which); if (!el) return;
        el.classList.remove('granted','denied','pending');
        if (status==='granted') { el.textContent='Allowed'; el.classList.add('granted'); }
        else if (status==='denied') { el.textContent='Blocked'; el.classList.add('denied'); }
        else if (status==='pending') { el.textContent='Asking…'; el.classList.add('pending'); }
        else el.textContent = 'Not set';
    }
    async function maybeShowPermissionsModal() {
        if (localStorage.getItem('talkPermsDone')) return;
        try {
            if ('Notification' in window) setPermStatus('notifications', Notification.permission==='granted'?'granted':Notification.permission==='denied'?'denied':'');
            if (navigator.permissions) {
                try { const p = await navigator.permissions.query({name:'microphone'}); setPermStatus('mic',p.state); } catch {}
                try { const p = await navigator.permissions.query({name:'camera'}); setPermStatus('camera',p.state); } catch {}
            }
        } catch {}
        permModal.style.display = 'flex';
    }
    permSkipBtn?.addEventListener('click', () => { localStorage.setItem('talkPermsDone','1'); permModal.style.display='none'; });
    permAllowBtn?.addEventListener('click', async () => {
        permAllowBtn.disabled = true;
        permHint.innerHTML = 'Click <b>Allow</b> in each browser pop-up.';
        try { if ('Notification' in window && Notification.permission==='default') { setPermStatus('notifications','pending'); setPermStatus('notifications', await Notification.requestPermission()); } else if ('Notification' in window) setPermStatus('notifications', Notification.permission); } catch { setPermStatus('notifications','denied'); }
        try { setPermStatus('mic','pending'); const s=await navigator.mediaDevices.getUserMedia({audio:true}); for(const t of s.getTracks()) t.stop(); setPermStatus('mic','granted'); } catch { setPermStatus('mic','denied'); }
        try { setPermStatus('camera','pending'); const s=await navigator.mediaDevices.getUserMedia({video:true}); for(const t of s.getTracks()) t.stop(); setPermStatus('camera','granted'); } catch { setPermStatus('camera','denied'); }
        permAllowBtn.disabled=false; permAllowBtn.textContent='Done';
        permHint.innerHTML='All set! Change anytime in browser site settings.';
        permAllowBtn.onclick = () => { localStorage.setItem('talkPermsDone','1'); permModal.style.display='none'; };
    });

    // ---------- Notifications ----------
    function notify(title, body, tag) {
        try {
            if (!('Notification' in window) || Notification.permission!=='granted') return;
            if (document.visibilityState==='visible' && document.hasFocus()) return;
            const n = new Notification(title, { body, tag:tag||'talk', silent:false });
            n.onclick = () => { window.focus(); try { n.close(); } catch {} };
            setTimeout(() => { try { n.close(); } catch {} }, 8000);
        } catch {}
    }

    // ---------- Ringtone ----------
    let ringCtx=null, ringInterval=null, ringNodes=[];
    function startRinging() {
        try {
            stopRinging();
            const Ctx = window.AudioContext||window.webkitAudioContext;
            if (!Ctx) return;
            ringCtx = new Ctx();
            const play = () => {
                const now = ringCtx.currentTime;
                for (const [freq, start, dur] of [[440,0,.4],[480,0,.4],[440,.5,.4],[480,.5,.4]]) {
                    const osc = ringCtx.createOscillator(); const gain = ringCtx.createGain();
                    osc.type='sine'; osc.frequency.value=freq;
                    gain.gain.setValueAtTime(0,now+start); gain.gain.linearRampToValueAtTime(.18,now+start+.02); gain.gain.linearRampToValueAtTime(0,now+start+dur);
                    osc.connect(gain).connect(ringCtx.destination); osc.start(now+start); osc.stop(now+start+dur+.05);
                    ringNodes.push(osc);
                }
            };
            play(); ringInterval = setInterval(play, 3000);
        } catch {}
    }
    function stopRinging() {
        if (ringInterval) { clearInterval(ringInterval); ringInterval=null; }
        for (const n of ringNodes) { try { n.stop(); } catch {} } ringNodes=[];
        if (ringCtx) { try { ringCtx.close(); } catch {} ringCtx=null; }
    }

    // ---------- Calling ----------
    const callOverlay = document.getElementById('call-overlay');
    const callPeerName = document.getElementById('call-peer-name');
    const callStateEl = document.getElementById('call-state');
    const callAvatar = document.getElementById('call-avatar');
    const localVideo = document.getElementById('local-video');
    const remoteVideo = document.getElementById('remote-video');
    const acceptBtn = document.getElementById('accept-btn');
    const muteBtn = document.getElementById('mute-btn');
    const cameraBtn = document.getElementById('camera-btn');
    const endBtn = document.getElementById('end-btn');
    const incomingToast = document.getElementById('incoming-toast');
    const toastAvatar = document.getElementById('toast-avatar');
    const toastName = document.getElementById('toast-name');
    const toastSub = document.getElementById('toast-sub');
    const toastAccept = document.getElementById('toast-accept');
    const toastReject = document.getElementById('toast-reject');

    const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

    audioCallBtn.addEventListener('click', () => startCall('audio'));
    videoCallBtn.addEventListener('click', () => startCall('video'));

    screenShareBtn && screenShareBtn.addEventListener('click', toggleScreenShare);

    async function toggleScreenShare() {
        if (!pc || callState !== 'in-call') return;
        if (screenStream) {
            // Stop screen share, go back to camera
            for (const t of screenStream.getTracks()) t.stop();
            screenStream = null;
            screenShareBtn.classList.remove('active');
            screenShareBtn.title = 'Share screen';
            if (localStream) {
                const videoTrack = localStream.getVideoTracks()[0];
                if (videoTrack) {
                    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
                    if (sender) sender.replaceTrack(videoTrack);
                }
            }
            return;
        }
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const screenTrack = screenStream.getVideoTracks()[0];
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender) sender.replaceTrack(screenTrack);
            screenShareBtn.classList.add('active');
            screenShareBtn.title = 'Stop sharing';
            screenTrack.onended = () => {
                screenStream = null; screenShareBtn.classList.remove('active');
                const camTrack = localStream?.getVideoTracks()[0];
                if (camTrack) { const s = pc.getSenders().find(s => s.track?.kind === 'video'); if (s) s.replaceTrack(camTrack); }
            };
        } catch(err) { if (err.name !== 'NotAllowedError') alert('Screen share failed: ' + err.message); }
    }

    async function startCall(type) {
        if (!activeChat || activeChat.kind!=='dm') return;
        if (callState) return;
        if (!isOnline(activeChat.email)) { alert(findUser(activeChat.email).name + ' is offline.'); return; }
        pendingPeer = findUser(activeChat.email); pendingCallType = type;
        callState = 'outgoing';
        showCallUI(pendingPeer, type, 'Calling…');
        ws.send(JSON.stringify({ type:'call-invite', to:pendingPeer.email, callType:type }));
    }

    function handleIncomingCall(msg) {
        if (callState) { ws.send(JSON.stringify({ type:'call-reject', to:msg.from })); return; }
        callState='incoming'; pendingPeer=findUser(msg.from); pendingCallType=msg.callType||'video';
        toastAvatar.textContent = avatarContent(pendingPeer);
        toastAvatar.style.fontSize = pendingPeer.avatar ? '20px' : '';
        toastName.textContent = pendingPeer.name;
        toastSub.textContent = pendingCallType==='video' ? 'Incoming video call' : 'Incoming audio call';
        incomingToast.style.display = 'flex';
        startRinging();
        notify(pendingPeer.name, pendingCallType==='video'?'Incoming video call':'Incoming audio call', 'call:'+pendingPeer.email);
    }

    toastAccept.addEventListener('click', acceptIncoming);
    toastReject.addEventListener('click', rejectIncoming);

    async function acceptIncoming() {
        if (callState!=='incoming'||!pendingPeer) return;
        stopRinging(); incomingToast.style.display='none';
        showCallUI(pendingPeer, pendingCallType, 'Connecting…');
        try { await getMedia(pendingCallType); }
        catch(err) { alert('Could not access microphone/camera: '+err.message); cleanupCall(); return; }
        ws.send(JSON.stringify({ type:'call-accept', to:pendingPeer.email, callType:pendingCallType }));
        await createPC(false);
    }

    function rejectIncoming() {
        if (!pendingPeer) return;
        stopRinging();
        ws.send(JSON.stringify({ type:'call-reject', to:pendingPeer.email }));
        incomingToast.style.display='none'; cleanupCall();
    }

    async function handleCallAccepted(msg) {
        if (callState!=='outgoing'||!pendingPeer) return;
        callStateEl.textContent='Connecting…';
        try { await getMedia(pendingCallType); }
        catch(err) { alert('Could not access microphone/camera: '+err.message); ws.send(JSON.stringify({type:'call-end',to:pendingPeer.email})); cleanupCall(); return; }
        await createPC(true);
    }

    async function getMedia(type) {
        localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:type==='video' });
        localVideo.srcObject = localStream;
        muteBtn.style.display='flex';
        cameraBtn.style.display=type==='video'?'flex':'none';
        if (screenShareBtn) screenShareBtn.style.display = type==='video' ? 'flex' : 'none';
    }

    async function createPC(isCaller) {
        pc = new RTCPeerConnection(STUN);
        remoteStream = new MediaStream();
        remoteVideo.srcObject = remoteStream;
        pc.onicecandidate = (e) => {
            if (e.candidate && pendingPeer) ws.send(JSON.stringify({ type:'webrtc-ice', to:pendingPeer.email, candidate:e.candidate }));
        };
        pc.ontrack = (e) => {
            for (const t of e.streams[0].getTracks()) remoteStream.addTrack(t);
            callStateEl.textContent = pendingCallType==='video'?'In a video call':'In an audio call';
            callState='in-call';
        };
        pc.onconnectionstatechange = () => {
            if (['failed','closed','disconnected'].includes(pc.connectionState) && callState) cleanupCall();
        };
        if (localStream) for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
        for (const c of iceQueue) { try { await pc.addIceCandidate(c); } catch {} }
        iceQueue = [];
        if (isCaller) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type:'webrtc-offer', to:pendingPeer.email, sdp:offer }));
        }
    }

    async function handleRemoteOffer(msg) {
        if (!pendingPeer || !['incoming','in-call'].includes(callState)) return;
        if (!pc) await createPC(false);
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            for (const c of iceQueue) { try { await pc.addIceCandidate(c); } catch {} }
            iceQueue = [];
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({ type:'webrtc-answer', to:pendingPeer.email, sdp:answer }));
        } catch(err) { console.error('offer error', err); }
    }

    async function handleRemoteAnswer(msg) {
        if (!pc) return;
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            for (const c of iceQueue) { try { await pc.addIceCandidate(c); } catch {} }
            iceQueue = [];
        } catch(err) { console.error('answer error', err); }
    }

    async function handleRemoteIce(msg) {
        if (!msg.candidate) return;
        if (!pc || !pc.remoteDescription) { iceQueue.push(msg.candidate); return; }
        try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
    }

    function handleCallEnded() { cleanupCall(); }

    endBtn.addEventListener('click', () => {
        if (pendingPeer) ws.send(JSON.stringify({ type:callState==='outgoing'?'call-cancel':'call-end', to:pendingPeer.email }));
        cleanupCall();
    });

    let muted=false, cameraOff=false;
    muteBtn.addEventListener('click', () => {
        if (!localStream) return; muted=!muted;
        for (const t of localStream.getAudioTracks()) t.enabled=!muted;
        muteBtn.classList.toggle('muted', muted);
    });
    cameraBtn.addEventListener('click', () => {
        if (!localStream) return; cameraOff=!cameraOff;
        for (const t of localStream.getVideoTracks()) t.enabled=!cameraOff;
        cameraBtn.classList.toggle('muted', cameraOff);
    });

    function showCallUI(peer, type, label) {
        callPeerName.textContent = peer.name;
        callAvatar.textContent = avatarContent(peer);
        callAvatar.style.fontSize = peer.avatar ? '28px' : '';
        callStateEl.textContent = label;
        acceptBtn.style.display='none'; muteBtn.style.display='none'; cameraBtn.style.display='none';
        if (screenShareBtn) screenShareBtn.style.display = 'none';
        callOverlay.style.display='flex';
        localVideo.style.display=type==='video'?'':'none';
        remoteVideo.style.display=type==='video'?'':'none';
    }

    function cleanupCall() {
        stopRinging();
        if (screenStream) { for (const t of screenStream.getTracks()) t.stop(); screenStream = null; }
        try { pc?.close(); } catch {}; pc=null;
        if (localStream) { for (const t of localStream.getTracks()) { try { t.stop(); } catch {} } }
        localStream=null; remoteStream=null;
        try { localVideo.srcObject=null; } catch {}
        try { remoteVideo.srcObject=null; } catch {}
        callOverlay.style.display='none'; incomingToast.style.display='none';
        callState=null; pendingPeer=null; pendingCallType=null; iceQueue=[];
        muted=false; cameraOff=false;
        muteBtn.classList.remove('muted'); cameraBtn.classList.remove('muted');
        if (screenShareBtn) { screenShareBtn.classList.remove('active'); screenShareBtn.style.display='none'; }
    }

    // ---------- Games pane helpers ----------
    const gamesPane = document.getElementById('games-pane');
    const listPane = document.querySelector('.list-pane');
    const convPane = document.getElementById('conv-pane');

    function showGamesPane() {
        if (gamesPane) gamesPane.style.display = 'flex';
        if (listPane) listPane.style.display = 'none';
        if (convPane) convPane.style.display = 'none';
    }
    function hideGamesPane() {
        if (gamesPane) gamesPane.style.display = 'none';
        if (listPane) listPane.style.display = '';
        if (convPane) convPane.style.display = '';
    }

    window.openGameIframe = function(gameId) {
        const iframe = document.getElementById('game-iframe');
        const viewer = document.getElementById('games-viewer');
        const titleEl = document.getElementById('games-viewer-title');
        const names = { arcade: 'ARCADE.EXE', dodger: 'DODGER' };
        const paths = { arcade: '/games/arcade.html', dodger: '/games/dodger.html' };
        if (!iframe || !viewer || !paths[gameId]) return;
        iframe.src = paths[gameId];
        if (titleEl) titleEl.textContent = names[gameId] || gameId;
        viewer.style.display = 'flex';
    };

    // Listen for score messages from game iframes
    window.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'game-score') {
            // Auto-switch leaderboard tab to match the game that just scored
            const game = e.data.game || activeLbGame;
            loadLeaderboard(game);
        }
        if (e.data && e.data.type === 'challenge-score' && e.data.challengeId && e.data.score !== undefined) {
            fetch('/api/challenges/' + encodeURIComponent(e.data.challengeId) + '/score', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: me?.email, score: e.data.score })
            }).catch(() => {});
        }
    });

    window.closeGameIframe = function() {
        const iframe = document.getElementById('game-iframe');
        const viewer = document.getElementById('games-viewer');
        if (iframe) iframe.src = '';
        if (viewer) viewer.style.display = 'none';
    };

    // ---------- Group call ----------
    const groupCallOverlay = document.getElementById('group-call-overlay');
    const groupCallTitle = document.getElementById('group-call-title');
    const groupCallCount = document.getElementById('group-call-count');
    const groupVideoGrid = document.getElementById('group-video-grid');
    const gcMuteBtn = document.getElementById('gc-mute-btn');
    const gcEndBtn = document.getElementById('gc-end-btn');
    const gcToast = document.getElementById('group-call-toast');
    const gcToastName = document.getElementById('gc-toast-name');
    const gcToastSub = document.getElementById('gc-toast-sub');
    const gcToastAccept = document.getElementById('gc-toast-accept');
    const gcToastReject = document.getElementById('gc-toast-reject');
    const groupCallBtn = document.getElementById('group-call-btn');

    let gcGroupId = null;
    let gcPeers = new Map(); // email -> RTCPeerConnection
    let gcStreams = new Map(); // email -> MediaStream
    let gcLocalStream = null;
    let gcMuted = false;
    let gcInCall = false;
    let gcPendingGroupId = null;

    groupCallBtn && groupCallBtn.addEventListener('click', startGroupCall);

    async function startGroupCall() {
        if (!activeChat || activeChat.kind !== 'group') return;
        if (gcInCall) return;
        gcGroupId = activeChat.group.id;
        try { gcLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
        catch(err) { alert('Could not access microphone: ' + err.message); return; }
        gcInCall = true;
        groupCallTitle.textContent = activeChat.group.name || 'Group Call';
        groupCallOverlay.style.display = 'flex';
        addLocalTile();
        ws.send(JSON.stringify({ type: 'group-call-start', groupId: gcGroupId }));
    }

    function addLocalTile() {
        updateGroupTiles();
    }

    function updateGroupTiles() {
        if (!groupVideoGrid) return;
        groupVideoGrid.innerHTML = '';
        const participants = Array.from(gcPeers.keys());
        // Local tile
        const localTile = document.createElement('div');
        localTile.className = 'gc-tile';
        const localAv = document.createElement('div');
        localAv.className = 'gc-avatar';
        localAv.textContent = me ? (me.avatar || initials(me.name)) : '?';
        const localName = document.createElement('div');
        localName.className = 'gc-name';
        localName.textContent = (me?.name || 'You') + ' (you)';
        localTile.appendChild(localAv);
        localTile.appendChild(localName);
        groupVideoGrid.appendChild(localTile);
        // Remote tiles
        for (const email of participants) {
            const u = findUser(email);
            const tile = document.createElement('div');
            tile.className = 'gc-tile';
            tile.id = 'gc-tile-' + email.replace(/[@.]/g,'_');
            const av = document.createElement('div');
            av.className = 'gc-avatar';
            av.textContent = u.avatar || initials(u.name);
            const nm = document.createElement('div');
            nm.className = 'gc-name';
            nm.textContent = u.name;
            const remoteAudio = document.createElement('audio');
            remoteAudio.autoplay = true;
            remoteAudio.id = 'gc-audio-' + email.replace(/[@.]/g,'_');
            if (gcStreams.has(email)) remoteAudio.srcObject = gcStreams.get(email);
            tile.appendChild(av);
            tile.appendChild(nm);
            tile.appendChild(remoteAudio);
            groupVideoGrid.appendChild(tile);
        }
        const total = participants.length + 1;
        groupCallCount.textContent = total + ' participant' + (total !== 1 ? 's' : '');
    }

    async function gcCreatePeer(email, isCaller) {
        if (gcPeers.has(email)) { try { gcPeers.get(email).close(); } catch {} }
        const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] });
        gcPeers.set(email, peer);
        const remoteStream = new MediaStream();
        gcStreams.set(email, remoteStream);
        peer.ontrack = (e) => {
            for (const t of e.streams[0].getTracks()) remoteStream.addTrack(t);
            const audioEl = document.getElementById('gc-audio-' + email.replace(/[@.]/g,'_'));
            if (audioEl) audioEl.srcObject = remoteStream;
        };
        peer.onicecandidate = (e) => {
            if (e.candidate && gcGroupId) ws.send(JSON.stringify({ type: 'group-webrtc-ice', groupId: gcGroupId, to: email, candidate: e.candidate }));
        };
        peer.onconnectionstatechange = () => {
            if (['failed','closed','disconnected'].includes(peer.connectionState)) {
                gcPeers.delete(email); gcStreams.delete(email); updateGroupTiles();
            }
        };
        if (gcLocalStream) for (const t of gcLocalStream.getTracks()) peer.addTrack(t, gcLocalStream);
        if (isCaller) {
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: 'group-webrtc-offer', groupId: gcGroupId, to: email, sdp: offer }));
        }
        updateGroupTiles();
        return peer;
    }

    async function handleGroupCallState(msg) {
        if (msg.groupId !== gcGroupId) return;
        groupCallTitle.textContent = (activeChat && activeChat.id === msg.groupId ? activeChat.name : null) || 'Group Call';
        // If we're the new joiner, connect to each existing participant
        if (msg.newJoiner === me.email && msg.existingParticipants) {
            for (const p of msg.existingParticipants) {
                if (p !== me.email) await gcCreatePeer(p, true);
            }
        }
        updateGroupTiles();
    }

    async function handleGroupWebRTCOffer(msg) {
        if (msg.groupId !== gcGroupId || !gcInCall) return;
        let peer = gcPeers.get(msg.from);
        if (!peer) peer = await gcCreatePeer(msg.from, false);
        try {
            await peer.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: 'group-webrtc-answer', groupId: gcGroupId, to: msg.from, sdp: answer }));
        } catch(err) { console.error('gc offer err', err); }
    }

    async function handleGroupWebRTCAnswer(msg) {
        if (msg.groupId !== gcGroupId) return;
        const peer = gcPeers.get(msg.from);
        if (!peer) return;
        try { await peer.setRemoteDescription(new RTCSessionDescription(msg.sdp)); } catch(err) { console.error('gc answer err', err); }
    }

    async function handleGroupWebRTCIce(msg) {
        if (msg.groupId !== gcGroupId) return;
        const peer = gcPeers.get(msg.from);
        if (!peer || !msg.candidate) return;
        try { await peer.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
    }

    function handleGroupCallInvite(msg) {
        if (gcInCall) return;
        gcPendingGroupId = msg.groupId;
        gcToastName.textContent = msg.groupName || 'Group Call';
        gcToastSub.textContent = (msg.startedByName || 'Someone') + ' started a group call';
        gcToast.style.display = 'flex';
        startRinging();
    }

    gcToastAccept && gcToastAccept.addEventListener('click', async () => {
        if (!gcPendingGroupId) return;
        gcToast.style.display = 'none';
        stopRinging();
        gcGroupId = gcPendingGroupId; gcPendingGroupId = null;
        try { gcLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
        catch(err) { alert('Mic access failed: ' + err.message); return; }
        gcInCall = true;
        const g = groups.find(gr => gr.id === gcGroupId);
        groupCallTitle.textContent = g?.name || 'Group Call';
        groupCallOverlay.style.display = 'flex';
        addLocalTile();
        ws.send(JSON.stringify({ type: 'group-call-join', groupId: gcGroupId }));
    });

    gcToastReject && gcToastReject.addEventListener('click', () => {
        gcToast.style.display = 'none';
        stopRinging();
        gcPendingGroupId = null;
    });

    gcMuteBtn && gcMuteBtn.addEventListener('click', () => {
        if (!gcLocalStream) return;
        gcMuted = !gcMuted;
        for (const t of gcLocalStream.getAudioTracks()) t.enabled = !gcMuted;
        gcMuteBtn.classList.toggle('muted', gcMuted);
    });

    gcEndBtn && gcEndBtn.addEventListener('click', leaveGroupCall);

    function leaveGroupCall() {
        if (gcGroupId) ws.send(JSON.stringify({ type: 'group-call-leave', groupId: gcGroupId }));
        for (const [, peer] of gcPeers) { try { peer.close(); } catch {} }
        gcPeers.clear(); gcStreams.clear();
        if (gcLocalStream) { for (const t of gcLocalStream.getTracks()) t.stop(); gcLocalStream = null; }
        gcInCall = false; gcGroupId = null; gcPendingGroupId = null; gcMuted = false;
        gcMuteBtn && gcMuteBtn.classList.remove('muted');
        groupCallOverlay.style.display = 'none';
        groupVideoGrid.innerHTML = '';
    }

    // ---------- Leaderboard ----------
    let activeLbGame = 'dodger';

    async function loadLeaderboard(game) {
        if (game) activeLbGame = game;
        const lbList = document.getElementById('leaderboard-list');
        if (!lbList) return;
        // Update tab active state
        document.querySelectorAll('.lb-tab').forEach(t => t.classList.toggle('active', t.dataset.game === activeLbGame));
        try {
            const r = await fetch('/api/leaderboard');
            const d = await r.json();
            const board = (d.leaderboard && d.leaderboard[activeLbGame]) || [];
            lbList.innerHTML = '';
            if (board.length === 0) {
                lbList.innerHTML = '<div class="lb-empty">No scores yet — be the first to play!</div>';
                return;
            }
            board.slice(0, 20).forEach((entry, i) => {
                const row = document.createElement('div');
                row.className = 'lb-row' + (i < 3 ? ' lb-top' : '');
                const medal = ['🥇','🥈','🥉'][i] || (i+1)+'.';
                row.innerHTML = `<span class="lb-rank">${medal}</span><span class="lb-name">${escapeHtml(entry.name)}</span><span class="lb-score">${entry.score}</span>`;
                lbList.appendChild(row);
            });
        } catch {}
    }

    // Leaderboard tab switching
    document.querySelectorAll('.lb-tab').forEach(tab => {
        tab.addEventListener('click', () => loadLeaderboard(tab.dataset.game));
    });

    const lbResetBtn = document.getElementById('lb-reset-btn');
    const lbResetModal = document.getElementById('lb-reset-modal');
    const lbResetClose = document.getElementById('lb-reset-close');
    const lbResetCancel = document.getElementById('lb-reset-cancel');
    const lbResetConfirm = document.getElementById('lb-reset-confirm');
    const lbAdminPass = document.getElementById('lb-admin-pass');
    const lbResetHint = document.getElementById('lb-reset-hint');

    lbResetBtn && lbResetBtn.addEventListener('click', () => {
        if (lbResetModal) { lbResetModal.style.display = 'flex'; if (lbAdminPass) lbAdminPass.value = ''; if (lbResetHint) lbResetHint.textContent = ''; }
    });
    lbResetClose && lbResetClose.addEventListener('click', () => lbResetModal.style.display = 'none');
    lbResetCancel && lbResetCancel.addEventListener('click', () => lbResetModal.style.display = 'none');
    lbResetConfirm && lbResetConfirm.addEventListener('click', async () => {
        const pass = lbAdminPass ? lbAdminPass.value : '';
        if (!pass) { if (lbResetHint) lbResetHint.textContent = 'Enter admin password'; return; }
        try {
            const r = await fetch('/api/leaderboard', { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ adminEmail: 'hridaymittal85@gmail.com', adminPassword: pass, game: activeLbGame }) });
            const d = await r.json();
            if (!r.ok) { if (lbResetHint) lbResetHint.textContent = d.error || 'Incorrect password'; return; }
            lbResetModal.style.display = 'none';
            loadLeaderboard();
        } catch { if (lbResetHint) lbResetHint.textContent = 'Error. Try again.'; }
    });

    // ---------- Challenges ----------
    const challengeModal = document.getElementById('challenge-modal');
    const challengeModalClose = document.getElementById('challenge-modal-close');
    const challengeOpponentName = document.getElementById('challenge-opponent-name');
    const challengeModalHint = document.getElementById('challenge-modal-hint');
    const challengeBtn = document.getElementById('challenge-btn');

    challengeModalClose && challengeModalClose.addEventListener('click', () => { if (challengeModal) challengeModal.style.display = 'none'; });

    challengeBtn && challengeBtn.addEventListener('click', () => {
        if (!activeChat || activeChat.kind !== 'dm') return;
        const peer = findUser(activeChat.email);
        if (challengeOpponentName) challengeOpponentName.textContent = peer.name;
        if (challengeModalHint) challengeModalHint.textContent = '';
        if (challengeModal) challengeModal.style.display = 'flex';
    });

    document.querySelectorAll('.challenge-pick-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!activeChat || activeChat.kind !== 'dm' || !me) return;
            const game = btn.dataset.game;
            if (challengeModalHint) challengeModalHint.textContent = 'Sending challenge…';
            try {
                const r = await fetch('/api/challenges', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ challenger: me.email, opponent: activeChat.email, game }) });
                const d = await r.json();
                if (!r.ok) { if (challengeModalHint) challengeModalHint.textContent = d.error || 'Failed to send'; return; }
                if (challengeModal) challengeModal.style.display = 'none';
            } catch { if (challengeModalHint) challengeModalHint.textContent = 'Network error.'; }
        });
    });

    function renderChallengeCard(msg, isMe) {
        const c = msg._challenge;
        if (!c) return null;

        const gameName = c.game === 'dodger' ? 'Dodger 🎯' : 'Arcade 🚀';
        const gameIcon = c.game === 'dodger' ? '🎯' : '🚀';
        const challengerUser = findUser(c.challenger);
        const opponentUser = findUser(c.opponent);

        const myEmail = me?.email;
        const myRole = myEmail === c.challenger ? 'challenger' : myEmail === c.opponent ? 'opponent' : null;
        const myScore = myRole === 'challenger' ? c.challengerScore : c.opponentScore;
        const hasPlayed = myScore !== null;

        const challengerScore = c.challengerScore !== null ? c.challengerScore : '–';
        const opponentScore = c.opponentScore !== null ? c.opponentScore : '–';

        let winnerLine = '';
        if (c.status === 'complete') {
            if (c.winner === 'tie') winnerLine = `<div class="ch-result ch-tie">🤝 It's a tie!</div>`;
            else {
                const winnerUser = findUser(c.winner);
                const iMeWon = c.winner === myEmail;
                winnerLine = `<div class="ch-result ${iMeWon ? 'ch-win' : 'ch-loss'}">${iMeWon ? '🏆 You won!' : '😔 ' + winnerUser.name + ' won!'}</div>`;
            }
        }

        let playBtn = '';
        if (myRole && !hasPlayed && c.status !== 'complete') {
            playBtn = `<button class="ch-play-btn primary-btn" data-challenge="${c.id}" data-game="${c.game}" style="margin-top:0;padding:8px 18px;font-size:13px;">▶ Play Now!</button>`;
        } else if (!myRole) {
            playBtn = '<span style="font-size:12px;color:#999;">Not your challenge</span>';
        } else if (hasPlayed && c.status !== 'complete') {
            playBtn = '<span style="font-size:12px;color:#6264a7;font-weight:600;">✓ Score submitted! Waiting for opponent…</span>';
        }

        const card = document.createElement('div');
        card.className = 'challenge-card';
        card.dataset.challengeId = c.id;
        card.innerHTML = `
            <div class="ch-header"><span class="ch-icon">${gameIcon}</span><span class="ch-title">⚔️ ${gameName} Challenge</span></div>
            <div class="ch-scores">
                <div class="ch-player ${c.challengerScore !== null ? 'ch-played' : ''}">
                    <div class="ch-avatar">${challengerUser.avatar || initials(challengerUser.name)}</div>
                    <div class="ch-player-name">${escapeHtml(challengerUser.name)}</div>
                    <div class="ch-score">${challengerScore}</div>
                </div>
                <div class="ch-vs">VS</div>
                <div class="ch-player ${c.opponentScore !== null ? 'ch-played' : ''}">
                    <div class="ch-avatar">${opponentUser.avatar || initials(opponentUser.name)}</div>
                    <div class="ch-player-name">${escapeHtml(opponentUser.name)}</div>
                    <div class="ch-score">${opponentScore}</div>
                </div>
            </div>
            ${winnerLine}
            <div class="ch-action">${playBtn}</div>
        `;

        // Attach play button listener
        const pb = card.querySelector('.ch-play-btn');
        if (pb) {
            pb.addEventListener('click', () => launchChallengeGame(c.id, c.game));
        }
        return card;
    }

    function launchChallengeGame(challengeId, game) {
        if (!me) return;
        // Switch to games pane and open the game with challenge params
        document.querySelector('.nav-btn[data-tab="games"]')?.click();
        setTimeout(() => {
            const iframe = document.getElementById('game-iframe');
            const viewer = document.getElementById('games-viewer');
            const titleEl = document.getElementById('games-viewer-title');
            const paths = {
                dodger: `/games/dodger.html?challenge=${encodeURIComponent(challengeId)}&player=${encodeURIComponent(me.email)}&name=${encodeURIComponent(me.name||'')}`,
                arcade: `/games/arcade.html?challenge=${encodeURIComponent(challengeId)}&player=${encodeURIComponent(me.email)}&name=${encodeURIComponent(me.name||'')}`,
            };
            const names = { dodger: 'Dodger — Challenge', arcade: 'Arcade — Challenge' };
            if (!iframe || !viewer || !paths[game]) return;
            iframe.src = paths[game];
            if (titleEl) titleEl.textContent = names[game] || game;
            if (viewer) viewer.style.display = 'flex';
        }, 100);
    }

    function updateChallengeCard(challenge) {
        // Update all rendered challenge cards for this challenge ID
        document.querySelectorAll('[data-challenge-id="' + challenge.id + '"]').forEach(card => {
            const gameName = challenge.game === 'dodger' ? 'Dodger 🎯' : 'Arcade 🚀';
            const gameIcon = challenge.game === 'dodger' ? '🎯' : '🚀';
            const challengerUser = findUser(challenge.challenger);
            const opponentUser = findUser(challenge.opponent);
            const myEmail = me?.email;
            const myRole = myEmail === challenge.challenger ? 'challenger' : myEmail === challenge.opponent ? 'opponent' : null;
            const myScore = myRole === 'challenger' ? challenge.challengerScore : challenge.opponentScore;
            const hasPlayed = myScore !== null;

            const challengerScore = challenge.challengerScore !== null ? challenge.challengerScore : '–';
            const opponentScore = challenge.opponentScore !== null ? challenge.opponentScore : '–';

            let winnerLine = '';
            if (challenge.status === 'complete') {
                if (challenge.winner === 'tie') winnerLine = `<div class="ch-result ch-tie">🤝 It's a tie!</div>`;
                else {
                    const winnerUser = findUser(challenge.winner);
                    const iMeWon = challenge.winner === myEmail;
                    winnerLine = `<div class="ch-result ${iMeWon ? 'ch-win' : 'ch-loss'}">${iMeWon ? '🏆 You won!' : '😔 ' + escapeHtml(winnerUser.name) + ' won!'}</div>`;
                }
            }

            let playBtn = '';
            if (myRole && !hasPlayed && challenge.status !== 'complete') {
                playBtn = `<button class="ch-play-btn primary-btn" data-challenge="${challenge.id}" data-game="${challenge.game}" style="margin-top:0;padding:8px 18px;font-size:13px;">▶ Play Now!</button>`;
            } else if (!myRole) {
                playBtn = '<span style="font-size:12px;color:#999;">Not your challenge</span>';
            } else if (hasPlayed && challenge.status !== 'complete') {
                playBtn = '<span style="font-size:12px;color:#6264a7;font-weight:600;">✓ Score submitted! Waiting for opponent…</span>';
            }

            card.innerHTML = `
                <div class="ch-header"><span class="ch-icon">${gameIcon}</span><span class="ch-title">⚔️ ${gameName} Challenge</span></div>
                <div class="ch-scores">
                    <div class="ch-player ${challenge.challengerScore !== null ? 'ch-played' : ''}">
                        <div class="ch-avatar">${challengerUser.avatar || initials(challengerUser.name)}</div>
                        <div class="ch-player-name">${escapeHtml(challengerUser.name)}</div>
                        <div class="ch-score">${challengerScore}</div>
                    </div>
                    <div class="ch-vs">VS</div>
                    <div class="ch-player ${challenge.opponentScore !== null ? 'ch-played' : ''}">
                        <div class="ch-avatar">${opponentUser.avatar || initials(opponentUser.name)}</div>
                        <div class="ch-player-name">${escapeHtml(opponentUser.name)}</div>
                        <div class="ch-score">${opponentScore}</div>
                    </div>
                </div>
                ${winnerLine}
                <div class="ch-action">${playBtn}</div>
            `;
            const pb = card.querySelector('.ch-play-btn');
            if (pb) pb.addEventListener('click', () => launchChallengeGame(challenge.id, challenge.game));
        });
    }

    // ---------- Nav tabs ----------
    // ---------- Reviews / Feedback pane ----------
    const feedbackPane = document.getElementById('feedback-pane');

    function showFeedbackPane() {
        if (feedbackPane) feedbackPane.style.display = 'flex';
        if (listPane) listPane.style.display = 'none';
        if (gamesPane) gamesPane.style.display = 'none';
        if (convPane) convPane.style.display = 'none';
        loadReviews();
    }
    function hideFeedbackPane() {
        if (feedbackPane) feedbackPane.style.display = 'none';
        if (listPane) listPane.style.display = '';
        if (convPane) convPane.style.display = '';
    }

    async function loadReviews() {
        const list = document.getElementById('fb-reviews-list');
        const avgEl = document.getElementById('fb-avg-score');
        const avgStarsEl = document.getElementById('fb-avg-stars');
        const avgSubEl = document.getElementById('fb-avg-sub');
        const reviewsHeader = document.getElementById('fb-reviews-header');
        const countEl = document.getElementById('fb-review-count');
        if (!list) return;
        list.innerHTML = '<div class="lb-empty" style="padding:32px 16px;">Loading…</div>';
        try {
            const r = await fetch('/api/feedback');
            const d = await r.json();
            const reviews = d.reviews || [];
            // Compute average
            if (reviews.length === 0) {
                if (avgEl) avgEl.textContent = '–';
                if (avgStarsEl) avgStarsEl.innerHTML = '';
                if (avgSubEl) avgSubEl.textContent = 'No reviews yet — be the first!';
                if (reviewsHeader) reviewsHeader.style.display = 'none';
                list.innerHTML = '<div class="lb-empty" style="padding:32px 16px;text-align:center;">No reviews yet.<br>Be the first to share your thoughts!</div>';
                return;
            }
            const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
            if (avgEl) avgEl.textContent = avg.toFixed(1);
            if (avgStarsEl) avgStarsEl.innerHTML = renderStarsDisplay(avg);
            if (avgSubEl) avgSubEl.textContent = reviews.length + ' review' + (reviews.length !== 1 ? 's' : '');
            if (reviewsHeader) reviewsHeader.style.display = 'flex';
            if (countEl) countEl.textContent = reviews.length + ' total';
            list.innerHTML = '';
            for (const rev of reviews) {
                list.appendChild(buildReviewCard(rev));
            }
        } catch {
            list.innerHTML = '<div class="lb-empty" style="padding:32px 16px;">Could not load reviews.</div>';
        }
    }

    function renderStarsDisplay(avg) {
        let html = '';
        for (let i = 1; i <= 5; i++) {
            if (avg >= i) html += '<span class="fb-star filled">★</span>';
            else if (avg >= i - 0.5) html += '<span class="fb-star half">★</span>';
            else html += '<span class="fb-star empty">★</span>';
        }
        return html;
    }

    function buildReviewCard(rev) {
        const card = document.createElement('div');
        card.className = 'fb-review-card';
        const isMe = rev.email === me?.email;
        const avatarContent = rev.avatar ? rev.avatar : initials(rev.name);
        const avatarStyle = rev.avatar ? 'font-size:20px;' : '';
        const starsHtml = Array.from({length:5}, (_,i) =>
            `<span class="fb-star ${i < rev.rating ? 'filled' : 'empty'}">★</span>`
        ).join('');
        const dateStr = formatReviewDate(rev.timestamp);
        card.innerHTML = `
            <div class="fb-review-header">
                <div class="fb-review-avatar" style="${avatarStyle}">${escapeHtml(avatarContent)}</div>
                <div class="fb-review-meta">
                    <div class="fb-review-name">${escapeHtml(rev.name)}${isMe ? ' <span class="fb-you-badge">You</span>' : ''}</div>
                    <div class="fb-review-stars">${starsHtml}</div>
                </div>
                <div class="fb-review-date">${dateStr}</div>
            </div>
            ${rev.message ? `<div class="fb-review-body">${escapeHtml(rev.message)}</div>` : ''}
        `;
        return card;
    }

    function formatReviewDate(ts) {
        try {
            const d = new Date(ts);
            const now = new Date();
            const diff = now - d;
            if (diff < 60000) return 'Just now';
            if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
            if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
            if (diff < 7*86400000) return Math.floor(diff/86400000) + 'd ago';
            return d.toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' });
        } catch { return ''; }
    }

    // Write review form
    let fbWriteRating = 0;
    const fbToggleBtn = document.getElementById('fb-toggle-form');
    const fbWriteForm = document.getElementById('fb-write-form');
    const fbCancelBtn = document.getElementById('fb-cancel-btn');
    const fbSubmitBtn = document.getElementById('fb-submit-btn');
    const fbWriteText = document.getElementById('fb-write-text');
    const fbCharCount = document.getElementById('fb-char-count');
    const fbFormHint = document.getElementById('fb-form-hint');

    fbToggleBtn && fbToggleBtn.addEventListener('click', () => {
        const form = document.getElementById('fb-write-form');
        if (form) {
            const open = form.style.display !== 'none';
            form.style.display = open ? 'none' : 'block';
            fbToggleBtn.textContent = open ? '+ Add Review' : '− Cancel';
        }
    });
    fbCancelBtn && fbCancelBtn.addEventListener('click', () => {
        if (fbWriteForm) fbWriteForm.style.display = 'none';
        if (fbToggleBtn) fbToggleBtn.textContent = '+ Add Review';
        fbWriteRating = 0;
        updateWriteStars(0);
        if (fbWriteText) fbWriteText.value = '';
        if (fbCharCount) fbCharCount.textContent = '0/500';
        if (fbSubmitBtn) fbSubmitBtn.disabled = true;
        if (fbFormHint) fbFormHint.textContent = '';
    });

    document.querySelectorAll('#fb-write-stars .fb-write-star').forEach(star => {
        star.addEventListener('click', () => {
            fbWriteRating = Number(star.dataset.val);
            updateWriteStars(fbWriteRating);
            if (fbSubmitBtn) fbSubmitBtn.disabled = fbWriteRating === 0;
        });
        star.addEventListener('mouseenter', () => updateWriteStars(Number(star.dataset.val)));
        star.addEventListener('mouseleave', () => updateWriteStars(fbWriteRating));
    });

    function updateWriteStars(val) {
        document.querySelectorAll('#fb-write-stars .fb-write-star').forEach((s, i) => {
            s.classList.toggle('active', i < val);
        });
    }

    fbWriteText && fbWriteText.addEventListener('input', () => {
        if (fbCharCount) fbCharCount.textContent = (fbWriteText.value.length) + '/500';
    });

    fbSubmitBtn && fbSubmitBtn.addEventListener('click', async () => {
        if (!fbWriteRating || !me) return;
        fbSubmitBtn.disabled = true;
        if (fbFormHint) fbFormHint.textContent = '';
        try {
            const r = await fetch('/api/feedback', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: me.email, rating: fbWriteRating, message: fbWriteText?.value || '' })
            });
            const d = await r.json();
            if (r.ok) {
                // Reset form
                fbWriteRating = 0;
                updateWriteStars(0);
                if (fbWriteText) fbWriteText.value = '';
                if (fbCharCount) fbCharCount.textContent = '0/500';
                if (fbWriteForm) fbWriteForm.style.display = 'none';
                if (fbToggleBtn) fbToggleBtn.textContent = '+ Add Review';
                // Prepend new review to list
                loadReviews();
            } else {
                if (fbFormHint) fbFormHint.textContent = d.error || 'Could not submit. Try again.';
                fbSubmitBtn.disabled = false;
            }
        } catch {
            if (fbFormHint) fbFormHint.textContent = 'Network error.';
            fbSubmitBtn.disabled = false;
        }
    });

    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeTab = btn.dataset.tab || 'chat';
            const titles = { chat:'Chat', calls:'Calls', people:'People', games:'Games', feedback:'Reviews' };
            if (activeTab === 'games') {
                hideFeedbackPane();
                showGamesPane();
                loadLeaderboard();
                return;
            }
            if (activeTab === 'feedback') {
                hideGamesPane();
                closeGameIframe();
                showFeedbackPane();
                return;
            }
            hideGamesPane();
            hideFeedbackPane();
            closeGameIframe();
            document.getElementById('list-title').textContent = titles[activeTab] || 'Chat';
            if (activeTab === 'calls') {
                loadCallHistory().then(() => renderContacts());
            } else {
                renderContacts();
            }
        });
    });

    // ---------- Boot ----------
    const stored = localStorage.getItem('talkUser');
    if (stored) {
        try { me = JSON.parse(stored); enterApp(); } catch { localStorage.removeItem('talkUser'); }
    }
    setMode('login');
})();
