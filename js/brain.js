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
      p.catch(() => {
        // Autoplay policy may block until user interaction
      });
    }
  } catch (e) {
    // ignore
  }
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
    // auto close
    setTimeout(() => {
      try { n.close(); } catch (e) {}
    }, 7000);
  } catch (e) {
    console.error('Notification error:', e);
  }
}

async function maybeRequestNotificationPermission(options = { force: false }) {
  if (!("Notification" in window)) return false;

  // already granted/denied
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;

  // avoid repeated prompts
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

// throttle notifications a bit (avoid spam)
function shouldNotifyNow() {
  const now = Date.now();
  if (now - lastNotifiedAt < 900) return false;
  lastNotifiedAt = now;
  return true;
}

// Decide whether to show notification (if tab is not focused or user is not in that chat)
function shouldShowNotificationForChat(chatId) {
  const focused = (typeof document.hasFocus === 'function') ? document.hasFocus() : !document.hidden;
  const isCurrentChat = currentChat && currentChat.id === chatId;

  // If you're in the same chat AND page focused => don't show desktop popup, but still can play sound (optional)
  if (isCurrentChat && focused && !document.hidden) return false;

  // Otherwise show if permission granted and not too frequent
  return canShowDesktopNotifications() && shouldNotifyNow();
}

// init sound early
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

// На некоторых мобильных браузерах первый фокус в поле может странно инициализировать раскладку.
// Делаем один «перефокус», чтобы привести клавиатуру в нормальное состояние для русского ввода.
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

// Функция для установки cookie
function setCookie(name, value, days) {
  const date = new Date();
  date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
  const expires = "; expires=" + date.toUTCString();
  document.cookie = name + "=" + (value || "") + expires + "; path=/; SameSite=Lax";
}

// Функция для получения cookie
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

// Функция для удаления cookie
function deleteCookie(name) {
  document.cookie = name + '=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC; SameSite=Lax';
}

// Функция для проверки верификации пользователя
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

// Функция для получения отображаемого имени с красивой галочкой
async function getDisplayNameWithBadge(username) {
    const verified = await isUserVerified(username);
    if (verified) {
        return {
            name: username,
            verified: true,
            html: `${username}<span class="verified-badge"></span>`
        };
    }
    return {
        name: username,
        verified: false,
        html: username
    };
}

// Обновленная функция обновления отображения пользователя
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

// Close sidebar when clicking outside
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

    // Помечаем онлайн
    await set(statusRef, {
      online: true,
      lastSeen: Date.now()
    });

    // Сервер автоматически отметит офлайн при разрыве соединения
    try {
      const disconn = onDisconnect(statusRef);
      disconn.set({
        online: false,
        lastSeen: Date.now()
      });
    } catch (e) {
      console.error('onDisconnect error:', e);
    }

    // На случай закрытия вкладки/приложения
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

// Получить ID чата для пары пользователей (детерминированный)
function getChatIdForUsers(userA, userB) {
  return [userA, userB].sort().join('_');
}

// Регистрация
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
    
    await set(userRef, {
      password: p,
      created: Date.now(),
      verified: false
    });
    
    alert('Регистрация успешна! Теперь войдите.');
    
  } catch(e) {
    console.error('Registration error:', e);
    alert('Ошибка регистрации: ' + e.message);
  }
};

// Функция входа
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
    
    if(snap.val().password !== password) {
      alert('Неверный пароль');
      return false;
    }

    if (snap.val().banned) {
      alert('Этот аккаунт заблокирован администрацией');
      return false;
    }

    currentUser = {username: username};
    
    // Сохраняем в cookie на 30 дней
    setCookie('fireguild_user', username, 30);
    setCookie('fireguild_pass', password, 30);

    // Обновляем статус присутствия
    await setupPresence(username);
    
    // Показываем приложение
    auth.style.display = 'none';
    appDiv.style.display = 'flex';
    
    // Обновляем отображение имени с галочкой
    await updateUserDisplay();
    
    myAvatar.textContent = username.charAt(0).toUpperCase();
    
    // ВАЖНО: запрос разрешения на уведомления — только при ручном входе (не при autoLogin),
    // чтобы не терять ввод/промпты и не ловить блокировку браузера на авто-gesture.
    if (!isAuto) {
      try {
        await maybeRequestNotificationPermission();
      } catch (e) {
        console.error('maybeRequestNotificationPermission error:', e);
      }
    }
    
    // Загружаем чаты
    loadChats();
    
    return true;
    
  } catch(e) {
    console.error('Login error:', e);
    alert('Ошибка подключения: ' + e.message);
    return false;
  }
}

// Обработчик кнопки входа
loginBtn.onclick = () => {
  const u = loginUser.value.trim();
  const p = loginPass.value;
  login(u, p, false);
};

// Выход
logoutBtn.onclick = () => {
  // Очищаем слушатели
  if(chatListUnsubscribe) {
    chatListUnsubscribe();
    chatListUnsubscribe = null;
  }
  if(currentMessagesRef && messagesListener) {
    off(currentMessagesRef, 'child_added', messagesListener);
    messagesListener = null;
    currentMessagesRef = null;
  }
  
  // Удаляем cookie
  deleteCookie('fireguild_user');
  deleteCookie('fireguild_pass');

  // Отмечаем офлайн
  if (presenceStatusRef) {
    set(presenceStatusRef, {
      online: false,
      lastSeen: Date.now()
    });
    presenceStatusRef = null;
  }
  
  // Сбрасываем состояние
  currentUser = null;
  currentChat = null;
  processedMessageIds.clear();
  isLoadingMessages = false;
  lastMessageTimestamp = 0;

  // reset notif tracking for this session
  chatListInitialLoadDone = false;
  lastNotifiedChatTime = Object.create(null);
  lastNotifiedChatText = Object.create(null);
  lastNotifiedChatSender = Object.create(null);
  lastNotifiedAt = 0;
  
  // Показываем экран входа
  appDiv.style.display = 'none';
  auth.style.display = 'flex';
  
  // Очищаем поля
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
      chats.push({
        id: child.key,
        ...child.val()
      });
    });
    chats.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));

    // ===== GLOBAL NEW MESSAGE NOTIFICATIONS (TAB OPEN) =====
    // We notify based on users/{me}/chats updates (works for ANY chat, even if not opened).
    // On first load: fill the cache, do not notify.
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

        // message updated
        if (newTime > prevTime && chat.lastMessage && chat.with) {
          const prevText = lastNotifiedChatText[chat.id] || '';
          const newText = chat.lastMessage || '';
          const prevWith = lastNotifiedChatSender[chat.id] || '';
          const newWith = chat.with || '';

          // Avoid notifying for your own outgoing messages:
          // In your schema `with` is friend username, so outgoing messages still update your own chats with same friend.
          // So we need an extra heuristic:
          // - If you're currently in that chat and focused, don't show popup.
          // - Also if message text equals last text and time changed, still notify once (time-based).
          // There's no sender info in users/{me}/chats; sender is only in chats/{id}/messages.
          // So we assume "new message" should notify unless you're focused in that chat.
          const shouldPopup = shouldShowNotificationForChat(chat.id);

          // Sound: always play on "new chat update" unless you're focused in that chat (optional),
          // but user asked sound for new notification: so play when it's NOT focused in that chat OR tab hidden.
          const focused = (typeof document.hasFocus === 'function') ? document.hasFocus() : !document.hidden;
          const isCurrentChat = currentChat && currentChat.id === chat.id;
          const shouldSound = !(isCurrentChat && focused && !document.hidden);

          if (shouldSound) playNotificationSound();
          if (shouldPopup) {
            showDesktopNotification(`${newWith}`, newText);
          }

          lastNotifiedChatTime[chat.id] = newTime;
          lastNotifiedChatText[chat.id] = newText;
          lastNotifiedChatSender[chat.id] = newWith;
        } else {
          // update cache even if no notify
          lastNotifiedChatTime[chat.id] = newTime;
          lastNotifiedChatText[chat.id] = chat.lastMessage || (lastNotifiedChatText[chat.id] || '');
          lastNotifiedChatSender[chat.id] = chat.with || (lastNotifiedChatSender[chat.id] || '');
        }
      }
    }
    // ===== END GLOBAL NEW MESSAGE NOTIFICATIONS =====

    if (myGeneration !== chatListRenderGeneration) return;
    chatList.innerHTML = '';

    for (const chat of chats) {
      if (myGeneration !== chatListRenderGeneration) break;
      const friend = chat.with || 'Собеседник';

      // Имя + верификация
      const displayData = await getDisplayNameWithBadge(friend);

      // Статус онлайна собеседника
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
    // Проверяем, существует ли такой пользователь и не заблокирован ли он
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

    // Ищем уже существующий чат с этим пользователем
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

    // Создаем новый чат с детерминированным ID
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
  
  // Если уже открыт этот же чат, ничего не делаем
  if(currentChat?.id === chatId) {
    return;
  }
  
  // Очищаем предыдущий слушатель
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
  
  // Очищаем множество обработанных сообщений
  processedMessageIds.clear();
  isLoadingMessages = true;
  lastMessageTimestamp = 0;

  const friendDisplayData = await getDisplayNameWithBadge(friend);
  currentChat = {id: chatId, friend, friendDisplayData};
  
  // Заголовок с красивой галочкой и статусом
  renderChatHeader(friendDisplayData, false);

  // Слушаем статус присутствия собеседника
  friendStatusRef = ref(db, `presence/${friend}`);
  onValue(friendStatusRef, (snap) => {
    const val = snap.val();
    const online = !!(val && val.online);
    if (currentChat && currentChat.friend === friend) {
      renderChatHeader(currentChat.friendDisplayData || friendDisplayData, online);
    }
  });
  
  chatInput.style.display = 'flex';
  messages.innerHTML = '<div style="color:#8b98a5; text-align:center; padding:20px;">Загрузка сообщений...</div>';

  // Загружаем последние сообщения
  const messagesRef = ref(db, `chats/${chatId}/messages`);
  const messagesQuery = query(messagesRef, limitToLast(50));
  
  get(messagesQuery).then((snap) => {
    messages.innerHTML = ''; // Очищаем сообщение о загрузке
    
    if(snap.exists()) {
      const messages_array = [];
      snap.forEach(child => {
        messages_array.push({
          id: child.key,
          ...child.val()
        });
      });
      
      // Сортируем по времени
      messages_array.sort((a, b) => a.timestamp - b.timestamp);
      
      // Добавляем все сообщения
      messages_array.forEach(msg => {
        processedMessageIds.add(msg.id);
        if (msg.timestamp > lastMessageTimestamp) {
          lastMessageTimestamp = msg.timestamp;
        }
        addMessageToChat(msg);
      });
      
      messages.scrollTop = messages.scrollHeight;
    }
    
    isLoadingMessages = false;
    
    // Устанавливаем слушатель только для новых сообщений
    const newMessagesQuery = query(messagesRef, limitToLast(1));
    
    currentMessagesRef = newMessagesQuery;
    
    messagesListener = onChildAdded(newMessagesQuery, async (snap) => {
      // Игнорируем сообщения во время загрузки
      if (isLoadingMessages) return;
      
      // Проверяем, не было ли уже это сообщение обработано
      if (!processedMessageIds.has(snap.key)) {
        const msg = { id: snap.key, ...snap.val() };
        
        // Дополнительная проверка по времени для защиты от дублей
        if (msg.timestamp > lastMessageTimestamp) {
          console.log('Новое сообщение:', snap.key, msg);
          processedMessageIds.add(snap.key);
          lastMessageTimestamp = msg.timestamp;

          // Если входящее сообщение пришло в ОТКРЫТЫЙ чат:
          // - звук (если не фокус/не в этом чате — уже есть глобально, но тут тоже оставим как safety)
          // - уведомление (если таб не в фокусе)
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

    // Слушатель изменений для обновления статуса прочтения (галочки)
    readStatusRef = messagesQuery;
    readStatusListener = onValue(readStatusRef, (snap) => {
      if (!currentChat || currentChat.id !== chatId) return;
      if (!snap.exists()) return;

      const friendUsername = currentChat.friend;
      if (!friendUsername) return;

      snap.forEach(child => {
        const msg = { id: child.key, ...child.val() };
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

// Обновленная функция добавления сообщения в чат
async function addMessageToChat(msg) {
  // Проверяем, существует ли уже такое сообщение в DOM
  const existingMessages = messages.querySelectorAll('.msg');
  for (let existingMsg of existingMessages) {
    const timeDiv = existingMsg.querySelector('.time');
    if (timeDiv && timeDiv.textContent.includes(new Date(msg.timestamp).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'}))) {
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
  div.setAttribute('data-message-id', msg.id || Date.now() + Math.random()); // Для отладки
  
  // Получаем имя отправителя с красивой галочкой
  const senderDisplayData = await getDisplayNameWithBadge(msg.sender);
  
  div.innerHTML = `
    <div class="sender-name">${senderDisplayData.html}</div>
    ${escapeHtml(msg.text)}
    <div class="time">
      <span class="time-text">${new Date(msg.timestamp).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'})}</span>
      ${mine ? `<span class="msg-status ${readByFriend ? 'read' : 'sent'}">${readByFriend ? '✔✔' : '✔'}</span>` : ''}
    </div>
  `;
  messages.appendChild(div);

  // Помечаем входящее сообщение как прочитанное
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

  // Блокируем повторную отправку
  isSending = true;
  sendBtn.disabled = true;

  const message = {
    text,
    sender: currentUser.username,
    timestamp: Date.now()
  };

  // Сохраняем текст для восстановления в случае ошибки
  const originalText = text;
  msgInput.textContent = '';

  try {
    // Сохраняем сообщение и получаем его ключ
    const newMessageRef = await push(ref(db, `chats/${currentChat.id}/messages`), message);
    
    // Добавляем ключ в множество обработанных сообщений
    processedMessageIds.add(newMessageRef.key);
    if (message.timestamp > lastMessageTimestamp) {
      lastMessageTimestamp = message.timestamp;
    }
    
    // Обновляем последнее сообщение в списке чатов для обоих пользователей
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
    // Разблокируем отправку
    isSending = false;
    sendBtn.disabled = false;
  }
}

// Автовход из cookie (30 дней)
async function autoLogin() {
  const savedUser = getCookie('fireguild_user');
  const savedPass = getCookie('fireguild_pass');
  
  if(savedUser && savedPass) {
    console.log('Пробуем автоматический вход для:', savedUser);
    loginUser.value = savedUser;
    loginPass.value = savedPass;
    await login(savedUser, savedPass, true);
  }
}

// === Console command: get.token (без скобок, с подтверждением) ===
Object.defineProperty(window, 'get', {
  value: {},
  writable: false
});

Object.defineProperty(window.get, 'token', {
  get() {
    const confirmGet = confirm('Точно ли вы хотите получить токен?');

    if (!confirmGet) {
      console.log('Получение токена отменено');
      return null;
    }

    const user = getCookie('fireguild_user');
    const pass = getCookie('fireguild_pass');

    if (!user || !pass) {
      console.log('Куки не найдены');
      return null;
    }

    const token = `${user}:${pass}`;
    console.log(token);
    return token;
  }
});

backBtn.onclick = closeChat;

// Запускаем автовход после инициализации
setTimeout(autoLogin, 0);

// ===== Optional: first user interaction helps audio + notifications (no extra prompts) =====
(function bindFirstInteractionForSoundWarmup(){
  let warmed = false;
  function warm() {
    if (warmed) return;
    warmed = true;
    // Try to "unlock" audio on some browsers after user gesture
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
