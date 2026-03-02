import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getDatabase, ref, get, set, update, push, onChildAdded, onValue, off, onDisconnect, query, limitToLast } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDxTZxpBF6ma0m3FLbxQhxD_xngu0Nm6OU",
  authDomain: "fireguildnew-3356a.firebaseapp.com",
  databaseURL: "https://fireguildnew-3356a-default-rtdb.firebaseio.com",
  projectId: "fireguildnew-3356a",
  storageBucket: "fireguildnew-3356a.firebasestorage.app",
  messagingSenderId: "1020153656700",
  appId: "1:1020153656700:web:9a39087a47b8c4138aa0f9"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

let currentUser = null;
let currentChat = null;
let messagesListener = null;
let currentMessagesRef = null;
let chatListUnsubscribe = null;
let isSending = false;
let processedMessageIds = new Set();
let isLoadingMessages = false;
let lastMessageTimestamp = 0;
let userChatsRefGlobal = null;
let chatListRenderGeneration = 0;
let presenceStatusRef = null;
let friendStatusRef = null;
let friendStatusListenerAttached = false;
let readStatusRef = null;
let readStatusListener = null;
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

// === SHA-256 helpers (WebCrypto) ===
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function genSaltHex(lenBytes = 16) { // 16 bytes = 128-bit salt
  const b = new Uint8Array(lenBytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}
async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}
// hash = SHA256(salt + ":" + password)
async function hashPassword(password, saltHex) {
  return sha256Hex(`${saltHex}:${password}`);
}

// ===== Safe date/time helpers (FIX Invalid Date) =====
function parseTimestamp(ts) {
  // returns number (ms) or null
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;

  // Firebase may store as string in older data
  if (typeof ts === 'string') {
    const n = Number(ts);
    if (Number.isFinite(n)) return n;
  }

  // If someone saved {".sv":"timestamp"} etc — ignore here
  return null;
}

function formatTime(ts) {
  const t = parseTimestamp(ts);
  if (!t) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function normalizeMessage(raw) {
  const msg = raw && typeof raw === 'object' ? raw : {};
  const sender = (typeof msg.sender === 'string' && msg.sender.trim()) ? msg.sender.trim() : 'Unknown';
  const text = (msg.text == null) ? '' : String(msg.text);
  const ts = parseTimestamp(msg.timestamp) ?? Date.now();

  return {
    ...msg,
    sender,
    text,
    timestamp: ts
  };
}

function inferFriendFromChatId(chatId, me) {
  // chatId is deterministic: [userA,userB].sort().join('_')
  // If old chat record missed `with`, we try to infer.
  if (!chatId || !me) return null;
  const parts = String(chatId).split('_');
  // Typical case: exactly 2 parts.
  if (parts.length === 2) {
    const [a, b] = parts;
    if (a === me) return b;
    if (b === me) return a;
  }
  // Fallback: choose any part that is not me (best-effort)
  const other = parts.find(p => p && p !== me);
  return other || null;
}

function normalizeChatRecord(chatId, rawChat, me) {
  const chat = rawChat && typeof rawChat === 'object' ? rawChat : {};
  const withUser = (typeof chat.with === 'string' && chat.with.trim())
    ? chat.with.trim()
    : (inferFriendFromChatId(chatId, me) || 'Собеседник');

  const lastMessage = (chat.lastMessage == null) ? '' : String(chat.lastMessage);
  const lastMessageTime = parseTimestamp(chat.lastMessageTime) ?? 0;

  return {
    id: chatId,
    ...chat,
    with: withUser,
    lastMessage,
    lastMessageTime
  };
}

// ===== Desktop notifications + sound (TAB OPEN / SITE RUNNING) =====
const NOTIF_ASKED_KEY = 'fireguild_notif_asked_v1';
let notifSound = null;
let chatListInitialLoadDone = false;
let lastNotifiedChatTime = Object.create(null); // { [chatId]: lastMessageTime }
let lastNotifiedChatText = Object.create(null); // { [chatId]: lastMessage }
let lastNotifiedChatSender = Object.create(null); // { [chatId]: with }
let lastNotifiedAt = 0;

function initNotificationSound() {
  try {
    notifSound = new Audio('assets/new.mp3');
    notifSound.preload = 'auto';
    notifSound.volume = 1.0;
  } catch (e) {
    console.error('Failed to init notification sound:', e);
    notifSound = null;
  }
}

function playNotificationSound() {
  if (!notifSound) return;
  try {
    notifSound.currentTime = 0;
    const p = notifSound.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
    }
  } catch (e) {}
}

function canShowDesktopNotifications() {
  return ("Notification" in window) && Notification.permission === 'granted';
}

function showDesktopNotification(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== 'granted') return;

  try {
    const n = new Notification(title, { body: body || '' });
    n.onclick = () => {
      try { window.focus(); } catch (e) {}
      try { n.close(); } catch (e) {}
    };
    setTimeout(() => {
      try { n.close(); } catch (e) {}
    }, 7000);
  } catch (e) {
    console.error('Notification error:', e);
  }
}

async function maybeRequestNotificationPermission(options = { force: false }) {
  if (!("Notification" in window)) return false;

  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;

  const asked = localStorage.getItem(NOTIF_ASKED_KEY);
  if (asked && !options.force) return false;

  localStorage.setItem(NOTIF_ASKED_KEY, '1');

  try {
    const res = await Notification.requestPermission();
    return res === 'granted';
  } catch (e) {
    console.error('Notification permission request error:', e);
    return false;
  }
}

function shouldNotifyNow() {
  const now = Date.now();
  if (now - lastNotifiedAt < 900) return false;
  lastNotifiedAt = now;
  return true;
}

function shouldShowNotificationForChat(chatId) {
  const focused = (typeof document.hasFocus === 'function') ? document.hasFocus() : !document.hidden;
  const isCurrentChat = currentChat && currentChat.id === chatId;
  if (isCurrentChat && focused && !document.hidden) return false;
  return canShowDesktopNotifications() && shouldNotifyNow();
}

initNotificationSound();

// DOM elements
const auth = document.getElementById('auth');
const appDiv = document.getElementById('app');
const loginBtn = document.getElementById('loginBtn');
const registerBtn = document.getElementById('registerBtn');
const logoutBtn = document.getElementById('logoutBtn');
const loginUser = document.getElementById('loginUser');
const loginPass = document.getElementById('loginPass');
const myName = document.getElementById('myName');
const myAvatar = document.getElementById('myAvatar');
const chatList = document.getElementById('chatList');
const chatTitle = document.getElementById('chatTitle');
const messages = document.getElementById('messages');
const chatInput = document.getElementById('chatInput');
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');
const menuToggle = document.getElementById('menuToggle');
const sidebar = document.getElementById('sidebar');
const backBtn = document.getElementById('backBtn');
const userSearchInput = document.getElementById('userSearchInput');
const userSearchBtn = document.getElementById('userSearchBtn');

// Mobile input fix
if (isMobile && msgInput) {
  let msgInputFixApplied = false;
  msgInput.addEventListener('focus', () => {
    if (msgInputFixApplied) return;
    msgInputFixApplied = true;
    msgInput.setAttribute('lang', 'ru');
    setTimeout(() => {
      msgInput.blur();
      setTimeout(() => msgInput.focus(), 0);
    }, 0);
  });
}

// Cookie helpers
function setCookie(name, value, days) {
  const date = new Date();
  date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
  const expires = "; expires=" + date.toUTCString();
  document.cookie = name + "=" + (value || "") + expires + "; path=/; SameSite=Lax";
}
function getCookie(name) {
  const nameEQ = name + "=";
  const ca = document.cookie.split(';');
  for(let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) == ' ') c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
}
function deleteCookie(name) {
  document.cookie = name + '=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC; SameSite=Lax';
}

// Verification helpers
async function isUserVerified(username) {
  try {
    const userRef = ref(db, `users/${username}`);
    const snap = await get(userRef);
    return snap.exists() && snap.val().verified === true;
  } catch (e) {
    console.error('Error checking verification:', e);
    return false;
  }
}
async function getDisplayNameWithBadge(username) {
  const safeName = (typeof username === 'string' && username.trim()) ? username.trim() : 'Unknown';
  const verified = await isUserVerified(safeName);
  if (verified) {
    return {
      name: safeName,
      verified: true,
      html: `${safeName}<span class="verified-badge"></span>`
    };
  }
  return { name: safeName, verified: false, html: safeName };
}
async function updateUserDisplay() {
  if (currentUser) {
    const displayData = await getDisplayNameWithBadge(currentUser.username);
    myName.innerHTML = displayData.html;
  }
}

// Mobile menu handlers
menuToggle.addEventListener('click', () => sidebar.classList.toggle('active'));
backBtn.addEventListener('click', closeChat);

if (userSearchBtn && userSearchInput) {
  userSearchBtn.addEventListener('click', async () => {
    const res = await findOrCreateChatWithUser(userSearchInput.value);
    if (res) {
      userSearchInput.value = res.friend;
      openChat(res.id, res.friend);
      if(window.innerWidth <= 768) {
        sidebar.classList.remove('active');
      }
    }
  });

  userSearchInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const res = await findOrCreateChatWithUser(userSearchInput.value);
      if (res) {
        userSearchInput.blur();
        openChat(res.id, res.friend);
        if(window.innerWidth <= 768) {
          sidebar.classList.remove('active');
        }
      }
    }
  });
}

document.addEventListener('click', (e) => {
  if(window.innerWidth <= 768 &&
     sidebar.classList.contains('active') &&
     !sidebar.contains(e.target) &&
     !menuToggle.contains(e.target)) {
    sidebar.classList.remove('active');
  }
});

async function setupPresence(username) {
  try {
    const statusRef = ref(db, `presence/${username}`);
    presenceStatusRef = statusRef;

    await set(statusRef, {
      online: true,
      lastSeen: Date.now()
    });

    try {
      const disconn = onDisconnect(statusRef);
      disconn.set({
        online: false,
        lastSeen: Date.now()
      });
    } catch (e) {
      console.error('onDisconnect error:', e);
    }

    window.addEventListener('beforeunload', () => {
      set(statusRef, {
        online: false,
        lastSeen: Date.now()
      });
    }, { once: true });
  } catch (e) {
    console.error('setupPresence error:', e);
  }
}

// deterministic chatId
function getChatIdForUsers(userA, userB) {
  return [userA, userB].sort().join('_');
}

// Registration
registerBtn.onclick = async () => {
  const u = loginUser.value.trim();
  const p = loginPass.value.trim();

  if(!u || !p) {
    alert('Введите логин и пароль');
    return;
  }

  try {
    const userRef = ref(db, `users/${u}`);
    const snap = await get(userRef);

    if(snap.exists()) {
      alert('Пользователь уже существует');
      return;
    }

    const salt = genSaltHex(16);
    const passwordHash = await hashPassword(p, salt);

    await set(userRef, {
      passwordHash,
      salt,
      created: Date.now(),
      verified: false
    });

    alert('Регистрация успешна! Теперь войдите.');
  } catch(e) {
    console.error('Registration error:', e);
    alert('Ошибка регистрации: ' + e.message);
  }
};

// Login
async function login(username, password, isAuto = false) {
  if(!username || !password) {
    alert('Введите логин и пароль');
    return false;
  }

  try {
    console.log('Пытаемся войти как:', username);
    const userRef = ref(db, `users/${username}`);
    const snap = await get(userRef);

    if(!snap.exists()) {
      alert('Пользователь не найден');
      return false;
    }

    const userData = snap.val();

    if (userData.banned) {
      alert('Этот аккаунт заблокирован администрацией');
      return false;
    }

    if (userData.passwordHash && userData.salt) {
      const tryHash = await hashPassword(password, userData.salt);
      if (tryHash !== userData.passwordHash) {
        alert('Неверный пароль');
        return false;
      }

      setCookie('fireguild_user', username, 30);
      setCookie('fireguild_passhash', tryHash, 30);
      deleteCookie('fireguild_pass');
    } else if (typeof userData.password === 'string') {
      if (userData.password !== password) {
        alert('Неверный пароль');
        return false;
      }

      const salt = genSaltHex(16);
      const passwordHash = await hashPassword(password, salt);
      await update(ref(db, `users/${username}`), {
        passwordHash,
        salt,
        password: null
      });

      setCookie('fireguild_user', username, 30);
      setCookie('fireguild_passhash', passwordHash, 30);
      deleteCookie('fireguild_pass');
    } else {
      alert('У аккаунта некорректные данные пароля');
      return false;
    }

    currentUser = {username: username};

    await setupPresence(username);

    auth.style.display = 'none';
    appDiv.style.display = 'flex';

    await updateUserDisplay();
    myAvatar.textContent = username.charAt(0).toUpperCase();

    if (!isAuto) {
      try { await maybeRequestNotificationPermission(); } catch (e) {}
    }

    loadChats();
    return true;

  } catch(e) {
    console.error('Login error:', e);
    alert('Ошибка подключения: ' + e.message);
    return false;
  }
}

loginBtn.onclick = () => {
  const u = loginUser.value.trim();
  const p = loginPass.value;
  login(u, p, false);
};

// Logout
logoutBtn.onclick = () => {
  if(chatListUnsubscribe) {
    chatListUnsubscribe();
    chatListUnsubscribe = null;
  }
  if(currentMessagesRef && messagesListener) {
    off(currentMessagesRef, 'child_added', messagesListener);
    messagesListener = null;
    currentMessagesRef = null;
  }

  deleteCookie('fireguild_user');
  deleteCookie('fireguild_pass');
  deleteCookie('fireguild_passhash');

  if (presenceStatusRef) {
    set(presenceStatusRef, {
      online: false,
      lastSeen: Date.now()
    });
    presenceStatusRef = null;
  }

  currentUser = null;
  currentChat = null;
  processedMessageIds.clear();
  isLoadingMessages = false;
  lastMessageTimestamp = 0;

  chatListInitialLoadDone = false;
  lastNotifiedChatTime = Object.create(null);
  lastNotifiedChatText = Object.create(null);
  lastNotifiedChatSender = Object.create(null);
  lastNotifiedAt = 0;

  appDiv.style.display = 'none';
  auth.style.display = 'flex';

  messages.innerHTML = '';
  chatList.innerHTML = '';
  chatTitle.textContent = 'Выберите чат';
  chatInput.style.display = 'none';
  loginUser.value = '';
  loginPass.value = '';
};

async function loadChats() {
  console.log("LOAD CHATS CALLED");
  if(userChatsRefGlobal) {
    off(userChatsRefGlobal);
  }

  const userChatsRef = ref(db, `users/${currentUser.username}/chats`);
  userChatsRefGlobal = userChatsRef;

  onValue(userChatsRef, async (snap) => {
    const myGeneration = ++chatListRenderGeneration;

    if(!snap.exists()) {
      if (myGeneration !== chatListRenderGeneration) return;
      chatList.innerHTML = '<div style="color:#8b98a5; text-align:center; padding:20px;">Нет чатов</div>';
      chatListInitialLoadDone = true;
      return;
    }

    const currentChatId = currentChat?.id;
    const chats = [];

    snap.forEach(child => {
      const normalized = normalizeChatRecord(child.key, child.val(), currentUser.username);
      chats.push(normalized);
    });

    chats.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));

    // notifications cache
    if (!chatListInitialLoadDone) {
      for (const chat of chats) {
        lastNotifiedChatTime[chat.id] = chat.lastMessageTime || 0;
        lastNotifiedChatText[chat.id] = chat.lastMessage || '';
        lastNotifiedChatSender[chat.id] = chat.with || '';
      }
      chatListInitialLoadDone = true;
    } else {
      for (const chat of chats) {
        const prevTime = lastNotifiedChatTime[chat.id] || 0;
        const newTime = chat.lastMessageTime || 0;

        if (newTime > prevTime && chat.lastMessage && chat.with) {
          const shouldPopup = shouldShowNotificationForChat(chat.id);

          const focused = (typeof document.hasFocus === 'function') ? document.hasFocus() : !document.hidden;
          const isCurrentChat = currentChat && currentChat.id === chat.id;
          const shouldSound = !(isCurrentChat && focused && !document.hidden);

          if (shouldSound) playNotificationSound();
          if (shouldPopup) {
            showDesktopNotification(`${chat.with}`, chat.lastMessage);
          }

          lastNotifiedChatTime[chat.id] = newTime;
          lastNotifiedChatText[chat.id] = chat.lastMessage || '';
          lastNotifiedChatSender[chat.id] = chat.with || '';
        } else {
          lastNotifiedChatTime[chat.id] = newTime;
          lastNotifiedChatText[chat.id] = chat.lastMessage || (lastNotifiedChatText[chat.id] || '');
          lastNotifiedChatSender[chat.id] = chat.with || (lastNotifiedChatSender[chat.id] || '');
        }
      }
    }

    if (myGeneration !== chatListRenderGeneration) return;
    chatList.innerHTML = '';

    for (const chat of chats) {
      if (myGeneration !== chatListRenderGeneration) break;

      const friend = chat.with || 'Собеседник';
      const displayData = await getDisplayNameWithBadge(friend);

      let online = false;
      try {
        const statusSnap = await get(ref(db, `presence/${friend}`));
        online = statusSnap.exists() && !!statusSnap.val().online;
      } catch (e) {
        console.error('Ошибка получения статуса пользователя', friend, e);
      }

      if (myGeneration !== chatListRenderGeneration) break;

      const div = document.createElement('div');
      div.className = `chat-item ${currentChatId === chat.id ? 'active' : ''}`;
      div.innerHTML = `
        <span class="chat-name-with-status">
          <span class="status-dot ${online ? 'online' : 'offline'}"></span>
          ${displayData.html}
        </span>
        <p>${chat.lastMessage || 'Нет сообщений'}</p>
      `;
      div.onclick = () => {
        openChat(chat.id, friend);
        if(window.innerWidth <= 768) {
          sidebar.classList.remove('active');
        }
      };
      chatList.appendChild(div);
    }
  }, (error) => {
    console.error('Ошибка загрузки чатов:', error);
    chatList.innerHTML = '<div style="color:#ff6b6b; text-align:center; padding:20px;">Ошибка загрузки чатов</div>';
  });
}

async function findOrCreateChatWithUser(friendUsername) {
  const target = (friendUsername || '').trim();
  if (!target) {
    alert('Введите ник пользователя');
    return null;
  }
  if (!currentUser) {
    alert('Сначала войдите в аккаунт');
    return null;
  }
  if (target === currentUser.username) {
    alert('Нельзя писать самому себе');
    return null;
  }

  try {
    const userRef = ref(db, `users/${target}`);
    const userSnap = await get(userRef);
    if (!userSnap.exists()) {
      alert('Пользователь не найден');
      return null;
    }
    if (userSnap.val().banned) {
      alert('Этот пользователь заблокирован администрацией');
      return null;
    }

    const userChatsRef = ref(db, `users/${currentUser.username}/chats`);
    const chatsSnap = await get(userChatsRef);
    let existingChatId = null;
    if (chatsSnap.exists()) {
      chatsSnap.forEach(child => {
        const val = child.val();
        if (val && val.with === target) {
          existingChatId = child.key;
        }
      });
    }

    if (existingChatId) {
      return { id: existingChatId, friend: target };
    }

    const chatId = getChatIdForUsers(currentUser.username, target);
    const now = Date.now();

    const currentUserChatRef = ref(db, `users/${currentUser.username}/chats/${chatId}`);
    const friendChatRef = ref(db, `users/${target}/chats/${chatId}`);

    await Promise.all([
      set(currentUserChatRef, {
        with: target,
        lastMessage: '',
        lastMessageTime: now
      }),
      set(friendChatRef, {
        with: currentUser.username,
        lastMessage: '',
        lastMessageTime: now
      })
    ]);

    return { id: chatId, friend: target };
  } catch (e) {
    console.error('Ошибка при поиске/создании чата:', e);
    alert('Ошибка при поиске пользователя');
    return null;
  }
}

function renderChatHeader(friendDisplayData, online) {
  const statusText = online ? 'В сети' : 'Не в сети';
  const statusClass = online ? 'online' : 'offline';
  chatTitle.innerHTML = `
    <div class="chat-title-name">${friendDisplayData.html}</div>
    <div class="chat-title-status ${statusClass}">${statusText}</div>
  `;
}

async function openChat(chatId, friend) {
  console.log('Открываем чат:', chatId, friend);

  if(currentChat?.id === chatId) return;

  if(currentMessagesRef && messagesListener) {
    off(currentMessagesRef, 'child_added', messagesListener);
    messagesListener = null;
    currentMessagesRef = null;
  }
  if (friendStatusRef) {
    off(friendStatusRef);
    friendStatusRef = null;
    friendStatusListenerAttached = false;
  }
  if (readStatusRef && readStatusListener) {
    off(readStatusRef, 'value', readStatusListener);
    readStatusRef = null;
    readStatusListener = null;
  }

  processedMessageIds.clear();
  isLoadingMessages = true;
  lastMessageTimestamp = 0;

  const safeFriend = (typeof friend === 'string' && friend.trim()) ? friend.trim() : (inferFriendFromChatId(chatId, currentUser.username) || 'Собеседник');
  const friendDisplayData = await getDisplayNameWithBadge(safeFriend);

  currentChat = {id: chatId, friend: safeFriend, friendDisplayData};

  renderChatHeader(friendDisplayData, false);

  friendStatusRef = ref(db, `presence/${safeFriend}`);
  onValue(friendStatusRef, (snap) => {
    const val = snap.val();
    const online = !!(val && val.online);
    if (currentChat && currentChat.friend === safeFriend) {
      renderChatHeader(currentChat.friendDisplayData || friendDisplayData, online);
    }
  });

  chatInput.style.display = 'flex';
  messages.innerHTML = '<div style="color:#8b98a5; text-align:center; padding:20px;">Загрузка сообщений...</div>';

  const messagesRef = ref(db, `chats/${chatId}/messages`);
  const messagesQuery = query(messagesRef, limitToLast(50));

  get(messagesQuery).then((snap) => {
    messages.innerHTML = '';

    if(snap.exists()) {
      const messages_array = [];
      snap.forEach(child => {
        messages_array.push(normalizeMessage({ id: child.key, ...child.val() }));
      });

      messages_array.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      messages_array.forEach(msg => {
        processedMessageIds.add(msg.id);
        if (msg.timestamp > lastMessageTimestamp) lastMessageTimestamp = msg.timestamp;
        addMessageToChat(msg);
      });

      messages.scrollTop = messages.scrollHeight;
    }

    isLoadingMessages = false;

    const newMessagesQuery = query(messagesRef, limitToLast(1));
    currentMessagesRef = newMessagesQuery;

    messagesListener = onChildAdded(newMessagesQuery, async (snap) => {
      if (isLoadingMessages) return;

      if (!processedMessageIds.has(snap.key)) {
        const msg = normalizeMessage({ id: snap.key, ...snap.val() });

        if (msg.timestamp > lastMessageTimestamp) {
          console.log('Новое сообщение:', snap.key, msg);
          processedMessageIds.add(snap.key);
          lastMessageTimestamp = msg.timestamp;

          if (msg.sender !== currentUser.username) {
            const focused = (typeof document.hasFocus === 'function') ? document.hasFocus() : !document.hidden;
            if (!focused || document.hidden) {
              playNotificationSound();
              if (canShowDesktopNotifications() && shouldNotifyNow()) {
                showDesktopNotification(`${msg.sender}`, msg.text || 'Новое сообщение');
              }
            }
          }

          await addMessageToChat(msg);
          messages.scrollTop = messages.scrollHeight;
        }
      }
    });

    readStatusRef = messagesQuery;
    readStatusListener = onValue(readStatusRef, (snap) => {
      if (!currentChat || currentChat.id !== chatId) return;
      if (!snap.exists()) return;

      const friendUsername = currentChat.friend;
      if (!friendUsername) return;

      snap.forEach(child => {
        const raw = { id: child.key, ...child.val() };
        const msg = normalizeMessage(raw);
        if (msg.sender !== currentUser.username) return;

        const readBy = msg.readBy || {};
        const readByFriend = !!readBy[friendUsername];

        const msgDiv = messages.querySelector(`.msg[data-message-id="${msg.id}"]`);
        if (!msgDiv) return;

        const statusSpan = msgDiv.querySelector('.msg-status');
        if (!statusSpan) return;

        statusSpan.textContent = readByFriend ? '✔✔' : '✔';
        statusSpan.classList.toggle('read', readByFriend);
        statusSpan.classList.toggle('sent', !readByFriend);
      });
    });

  }).catch(error => {
    console.error('Ошибка загрузки сообщений:', error);
    messages.innerHTML = '<div style="color:#ff6b6b; text-align:center; padding:20px;">Ошибка загрузки сообщений</div>';
    isLoadingMessages = false;
  });
}

// Add message (FIX sender/timestamp safety)
async function addMessageToChat(rawMsg) {
  const msg = normalizeMessage(rawMsg);

  // Soft dedupe (do not crash on invalid dates)
  const existingMessages = messages.querySelectorAll('.msg');
  const thisTime = formatTime(msg.timestamp);

  for (let existingMsg of existingMessages) {
    const timeDiv = existingMsg.querySelector('.time');
    if (timeDiv && thisTime !== '—' && timeDiv.textContent.includes(thisTime)) {
      const msgText = existingMsg.childNodes[0]?.nodeValue?.trim();
      if (msgText === msg.text) {
        console.log('Сообщение уже есть в DOM, пропускаем');
        return;
      }
    }
  }

  const mine = msg.sender === currentUser.username;
  const friendUsername = currentChat?.friend;
  const readBy = msg.readBy || {};
  const readByFriend = mine && friendUsername ? !!readBy[friendUsername] : false;

  const div = document.createElement('div');
  div.className = 'msg ' + (mine ? 'mine' : 'other');
  div.setAttribute('data-message-id', msg.id || (Date.now() + '_' + Math.random()));

  const senderDisplayData = await getDisplayNameWithBadge(msg.sender);

  div.innerHTML = `
    <div class="sender-name">${senderDisplayData.html}</div>
    ${escapeHtml(msg.text)}
    <div class="time">
      <span class="time-text">${formatTime(msg.timestamp)}</span>
      ${mine ? `<span class="msg-status ${readByFriend ? 'read' : 'sent'}">${readByFriend ? '✔✔' : '✔'}</span>` : ''}
    </div>
  `;
  messages.appendChild(div);

  if (!mine && currentChat && msg.id) {
    try {
      await set(ref(db, `chats/${currentChat.id}/messages/${msg.id}/readBy/${currentUser.username}`), true);
    } catch (e) {
      console.error('Не удалось отметить сообщение прочитанным', e);
    }
  }
}

function closeChat() {
  if(currentMessagesRef && messagesListener) {
    off(currentMessagesRef, 'child_added', messagesListener);
    messagesListener = null;
    currentMessagesRef = null;
  }
  if (friendStatusRef) {
    off(friendStatusRef);
    friendStatusRef = null;
  }
  if (readStatusRef && readStatusListener) {
    off(readStatusRef, 'value', readStatusListener);
    readStatusRef = null;
    readStatusListener = null;
  }
  currentChat = null;
  processedMessageIds.clear();
  isLoadingMessages = false;
  lastMessageTimestamp = 0;
  chatTitle.textContent = 'Выберите чат';
  chatInput.style.display = 'none';
  messages.innerHTML = '';

  if(window.innerWidth <= 768) {
    sidebar.classList.add('active');
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

sendBtn.onclick = sendMessage;
msgInput.addEventListener('keydown', (e) => {
  if (!e.isComposing && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  const text = msgInput.textContent.trim();
  if(!text || !currentChat || isSending) return;

  isSending = true;
  sendBtn.disabled = true;

  const message = {
    text,
    sender: currentUser.username,
    timestamp: Date.now()
  };

  const originalText = text;
  msgInput.textContent = '';

  try {
    const newMessageRef = await push(ref(db, `chats/${currentChat.id}/messages`), message);

    processedMessageIds.add(newMessageRef.key);
    if (message.timestamp > lastMessageTimestamp) {
      lastMessageTimestamp = message.timestamp;
    }

    const now = Date.now();
    const updates = [
      update(ref(db, `users/${currentUser.username}/chats/${currentChat.id}`), {
        with: currentChat.friend,
        lastMessage: text,
        lastMessageTime: now
      })
    ];

    if (currentChat.friend) {
      updates.push(
        update(ref(db, `users/${currentChat.friend}/chats/${currentChat.id}`), {
          with: currentUser.username,
          lastMessage: text,
          lastMessageTime: now
        })
      );
    }

    await Promise.all(updates);

  } catch(e) {
    console.error('Ошибка отправки:', e);
    alert('Ошибка отправки');
    msgInput.textContent = originalText;
  } finally {
    isSending = false;
    sendBtn.disabled = false;
  }
}

// Auto login from cookie (hash)
async function autoLogin() {
  const savedUser = getCookie('fireguild_user');
  const savedHash = getCookie('fireguild_passhash');

  if(savedUser && savedHash) {
    console.log('Пробуем автоматический вход для:', savedUser);

    try {
      const userRef = ref(db, `users/${savedUser}`);
      const snap = await get(userRef);
      if (!snap.exists()) return;

      const data = snap.val();
      if (data && data.passwordHash && savedHash === data.passwordHash) {
        currentUser = { username: savedUser };

        await setupPresence(savedUser);

        auth.style.display = 'none';
        appDiv.style.display = 'flex';

        await updateUserDisplay();
        myAvatar.textContent = savedUser.charAt(0).toUpperCase();

        loadChats();
      }
    } catch (e) {
      console.error('autoLogin error:', e);
    }
  }
}

// Console command: get.token
Object.defineProperty(window, 'get', {
  value: {},
  writable: false
});
Object.defineProperty(window.get, 'token', {
  get() {
    const user = getCookie('fireguild_user');
    const passhash = getCookie('fireguild_passhash');

    if (!user || !passhash) {
      console.log('Токен не найден (нет cookie user/passhash)');
      return null;
    }

    const token = `${user}:${passhash}`;
    console.log(token);
    return token;
  }
});

backBtn.onclick = closeChat;

setTimeout(autoLogin, 0);

// Audio warmup
(function bindFirstInteractionForSoundWarmup(){
  let warmed = false;
  function warm() {
    if (warmed) return;
    warmed = true;
    try {
      if (notifSound) {
        const prevVol = notifSound.volume;
        notifSound.volume = 0.0;
        const p = notifSound.play();
        if (p && typeof p.then === 'function') {
          p.then(() => {
            try { notifSound.pause(); } catch (e) {}
            try { notifSound.currentTime = 0; } catch (e) {}
            notifSound.volume = prevVol;
          }).catch(() => {
            notifSound.volume = prevVol;
          });
        } else {
          notifSound.volume = prevVol;
        }
      }
    } catch (e) {}
    window.removeEventListener('pointerdown', warm, true);
    window.removeEventListener('keydown', warm, true);
  }
  window.addEventListener('pointerdown', warm, true);
  window.addEventListener('keydown', warm, true);
})();
