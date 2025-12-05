document.addEventListener("DOMContentLoaded", () => {

console.log("SCRIPT LOADED!");
 
const socket = io();

const messagesEl = document.getElementById("messages");
const sendBtn = document.getElementById("sendBtn");
const inputEl = document.getElementById("messageInput");
const fileInput = document.getElementById("fileInput");
const typingEl = document.getElementById("typingIndicator");
const userListEl = document.getElementById("userList");
const logoutBtn = document.getElementById("logoutBtn");
const exitBtn = document.getElementById("exitBtn");
const userNameEl = document.getElementById("userName");
const userRoomEl = document.getElementById("userRoom");
const userAvatarEl = document.getElementById("userAvatar");
const roomTitleEl = document.getElementById("roomTitle");
const bgButtons = document.querySelectorAll(".bg-dot");

// ===== User & room =====
const stored = localStorage.getItem("chatUser");
if (!stored) {
  window.location.href = "/";
}
const user = JSON.parse(stored);
userNameEl.textContent = user.name;
userRoomEl.textContent = "Room: " + (user.room || "General");
roomTitleEl.textContent = user.room || "Chatroom";

if (user.photoURL) {
  userAvatarEl.src = user.photoURL;
} else {
  userAvatarEl.style.background = "#ccc";
}

// join room on connect
socket.emit("join-room", { name: user.name, room: user.room });

// ===== Background picker =====
const messagesContainer = document.querySelector(".messages");
const savedBg = localStorage.getItem("chatBg");
if (savedBg) messagesContainer.style.background = savedBg;

bgButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const bg = btn.dataset.bg;
    messagesContainer.style.background = bg;
    localStorage.setItem("chatBg", bg);
  });
});

// ===== Helpers =====
function formatTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// track my own messages by id for read receipts
const myMessages = new Map(); // id -> element

// ===== Socket events =====
socket.on("message", (data) => {
  if (data.type === "system") {
    addSystemMessage(data.text);
    return;
  }

  const isMe = data.senderId === socket.id;
  addChatMessage(data, isMe);

  // if I'm receiver: send seen receipt
  if (!isMe) {
    socket.emit("seen-message", {
      messageId: data.id,
      senderId: data.senderId,
    });
  }
});

// typing indicator
let typingTimeout = null;

inputEl.addEventListener("input", () => {
  socket.emit("typing", inputEl.value.trim().length > 0);
  if (typingTimeout) clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    socket.emit("typing", false);
  }, 1000);
});

socket.on("typing", ({ user, isTyping }) => {
  typingEl.textContent = isTyping ? `${user} is typing…` : "";
});

// read receipt - seen
socket.on("message-seen", ({ messageId }) => {
  const el = myMessages.get(messageId);
  if (!el) return;
  const tickSpan = el.querySelector(".tick");
  if (tickSpan) {
    tickSpan.textContent = "✓✓";
    tickSpan.classList.add("seen");
  }
});

// users in room
socket.on("room-users", (list) => {
  userListEl.innerHTML = "";
  list.forEach((u) => {
    const li = document.createElement("li");
    li.textContent = u.name;
    userListEl.appendChild(li);
  });
});

// message edited
socket.on("message-edited", ({ id, newText }) => {
  const el = document.querySelector(`.message[data-id="${id}"]`);
  if (!el) return;
  const textSpan = el.querySelector(".message-text");
  if (textSpan) textSpan.textContent = newText + " (edited)";
});

// message deleted
socket.on("message-deleted", ({ id }) => {
  const el = document.querySelector(`.message[data-id="${id}"]`);
  if (!el) return;
  el.textContent = "This message was deleted";
  el.classList.add("system");
});

// ===== Sending messages =====
sendBtn.addEventListener("click", sendMessage);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendMessage();
  }
});

function sendMessage() {
  const text = inputEl.value.trim();
  const file = fileInput.files[0];

  if (!text && !file) return;

  const id = Date.now().toString() + Math.random().toString(36).slice(2);

  if (file) {
    const reader = new FileReader();
    reader.onload = () => {
      const fileData = reader.result;
      socket.emit("chat-message", {
        id,
        type: "file",
        text, // optional caption
        fileName: file.name,
        fileType: file.type,
        fileData,
      });
    };
    reader.readAsDataURL(file);
  } else {
    socket.emit("chat-message", {
      id,
      type: "text",
      text,
    });
  }

  inputEl.value = "";
  fileInput.value = "";
}

// ===== Render functions =====
function addSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "system";
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addChatMessage(data, isMe) {
  const div = document.createElement("div");
  div.className = "message " + (isMe ? "me" : "other");
  div.dataset.id = data.id;

  const textSpan = document.createElement("span");
  textSpan.className = "message-text";

  if (data.type === "file") {
    // file rendering
    if (data.fileType && data.fileType.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = data.fileData;
      div.appendChild(img);
    }

    const link = document.createElement("a");
    link.href = data.fileData;
    link.download = data.fileName || "file";
    link.textContent = data.fileName || "Download file";
    link.className = "file-link";
    div.appendChild(link);

    if (data.text) {
      textSpan.textContent = " " + data.text;
      div.appendChild(textSpan);
    }
  } else {
    textSpan.textContent = data.text;
    div.appendChild(textSpan);
  }

  // time + ticks
  const timeSpan = document.createElement("span");
  timeSpan.className = "time-label";
  timeSpan.textContent = formatTime(data.timestamp || Date.now());

  if (isMe) {
    const tickSpan = document.createElement("span");
    tickSpan.className = "tick";
    tickSpan.textContent = "✓";
    timeSpan.appendChild(tickSpan);
    myMessages.set(data.id, div);
  }

  div.appendChild(timeSpan);

  // edit/delete for my messages
  if (isMe) {
    div.addEventListener("dblclick", () => {
      const newText = prompt("Edit your message:", data.text);
      if (newText && newText.trim()) {
        socket.emit("edit-message", { id: data.id, newText: newText.trim() });
      }
    });

    div.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (confirm("Delete this message?")) {
        socket.emit("delete-message", { id: data.id });
      }
    });
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ===== Logout / Exit =====
logoutBtn.onclick = () => {
  localStorage.removeItem("chatUser");
  window.location.href = "/";
};
exitBtn.onclick = () => {
  window.location.href = "/";
};
});