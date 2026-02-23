
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getDatabase, ref, get, set, update, push, onChildAdded, onValue, off, query, limitToLast } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

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
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

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
        
        // Обновляем заголовок чата если он открыт
        if (currentChat) {
            const friendDisplayData = await getDisplayNameWithBadge(currentChat.friend);
            chatTitle.innerHTML = friendDisplayData.html;
        }
    }
}

// Mobile menu handlers
menuToggle.addEventListener('click', () => sidebar.classList.toggle('active'));
backBtn.addEventListener('click', closeChat);

// Close sidebar when clicking outside
document.addEventListener('click', (e) => {
  if(window.innerWidth <= 768 && 
     sidebar.classList.contains('active') && 
     !sidebar.contains(e.target) && 
     !menuToggle.contains(e.target)) {
    sidebar.classList.remove('active');
  }
});

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
async function login(username, password) {
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

    currentUser = {username: username};
    
    // Сохраняем в cookie на 30 дней
    setCookie('fireguild_user', username, 30);
    setCookie('fireguild_pass', password, 30);
    
    // Показываем приложение
    auth.style.display = 'none';
    appDiv.style.display = 'flex';
    
    // Обновляем отображение имени с галочкой
    await updateUserDisplay();
    
    myAvatar.textContent = username.charAt(0).toUpperCase();
    
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
  login(u, p);
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
  
  // Сбрасываем состояние
  currentUser = null;
  currentChat = null;
  processedMessageIds.clear();
  isLoadingMessages = false;
  lastMessageTimestamp = 0;
  
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

    if (myGeneration !== chatListRenderGeneration) return;
    chatList.innerHTML = '';

    for (const chat of chats) {
      if (myGeneration !== chatListRenderGeneration) break;
      const div = document.createElement('div');
      div.className = `chat-item ${currentChatId === chat.id ? 'active' : ''}`;
      const displayData = await getDisplayNameWithBadge(chat.with || 'Собеседник');
      if (myGeneration !== chatListRenderGeneration) break;
      div.innerHTML = `
        <span>${displayData.html}</span>
        <p>${chat.lastMessage || 'Нет сообщений'}</p>
      `;
      div.onclick = () => {
        openChat(chat.id, chat.with || 'Собеседник');
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
  
  // Очищаем множество обработанных сообщений
  processedMessageIds.clear();
  isLoadingMessages = true;
  lastMessageTimestamp = 0;

  currentChat = {id: chatId, friend};
  
  // Обновляем заголовок с красивой галочкой
  const friendDisplayData = await getDisplayNameWithBadge(friend);
  chatTitle.innerHTML = friendDisplayData.html;
  
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
        const msg = snap.val();
        
        // Дополнительная проверка по времени для защиты от дублей
        if (msg.timestamp > lastMessageTimestamp) {
          console.log('Новое сообщение:', snap.key, msg);
          processedMessageIds.add(snap.key);
          lastMessageTimestamp = msg.timestamp;
          await addMessageToChat(msg);
          messages.scrollTop = messages.scrollHeight;
        }
      }
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
  
  const div = document.createElement('div');
  div.className = 'msg ' + (mine ? 'mine' : 'other');
  div.setAttribute('data-message-id', msg.id || Date.now() + Math.random()); // Для отладки
  
  // Получаем имя отправителя с красивой галочкой
  const senderDisplayData = await getDisplayNameWithBadge(msg.sender);
  
  div.innerHTML = `
    <div class="sender-name">${senderDisplayData.html}</div>
    ${escapeHtml(msg.text)}
    <div class="time">
      ${new Date(msg.timestamp).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'})}
    </div>
  `;
  messages.appendChild(div);
}

function closeChat() {
  if(currentMessagesRef && messagesListener) {
    off(currentMessagesRef, 'child_added', messagesListener);
    messagesListener = null;
    currentMessagesRef = null;
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
msgInput.onkeypress = e => { if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };

async function sendMessage() {
  const text = msgInput.value.trim();
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
  msgInput.value = '';

  try {
    // Сохраняем сообщение и получаем его ключ
    const newMessageRef = await push(ref(db, `chats/${currentChat.id}/messages`), message);
    
    // Добавляем ключ в множество обработанных сообщений
    processedMessageIds.add(newMessageRef.key);
    if (message.timestamp > lastMessageTimestamp) {
      lastMessageTimestamp = message.timestamp;
    }
    
    // Обновляем последнее сообщение в списке чатов одним запросом, чтобы не вызывать onValue дважды и не дублировать чаты
    await update(ref(db, `users/${currentUser.username}/chats/${currentChat.id}`), {
      lastMessage: text,
      lastMessageTime: Date.now()
    });
    
  } catch(e) {
    console.error('Ошибка отправки:', e);
    alert('Ошибка отправки');
    msgInput.value = originalText;
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
    await login(savedUser, savedPass);
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
