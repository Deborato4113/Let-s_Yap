document.addEventListener("DOMContentLoaded", () => {
  console.log("SCRIPT LOADED!");

  // ===== Socket connection =====
  const socket = io("https://let-s-yap.onrender.com", {
    transports: ["websocket", "polling"],
  });
  // (Locally you could also just use: const socket = io();)

  // ===== DOM elements =====
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

  // NEW: emoji + reply elements
  const emojiBtn = document.getElementById("emojiBtn");
  const replyPreviewEl = document.getElementById("replyPreview");
  const replyUserEl = document.getElementById("replyUser");
  const replyTextEl = document.getElementById("replyText");
  const replyCancelBtn = document.getElementById("replyCancel");

  // ===== User & room from localStorage =====
  const stored = localStorage.getItem("chatUser");
  if (!stored) {
    window.location.href = "/";
    return;
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

  const currentUserName = user.name;

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

  // ===== Reply state/helpers =====
  let replyTo = null; // { id, text, user }

  function setReply(data) {
    replyTo = {
      id: data.id,
      text: data.text,
      user: data.user,
    };
    if (replyUserEl && replyTextEl && replyPreviewEl) {
      replyUserEl.textContent = data.user || "Unknown";
      replyTextEl.textContent = data.text || "";
      replyPreviewEl.classList.remove("hidden");
    }
  }

  function clearReply() {
    replyTo = null;
    if (replyUserEl && replyTextEl && replyPreviewEl) {
      replyUserEl.textContent = "";
      replyTextEl.textContent = "";
      replyPreviewEl.classList.add("hidden");
    }
  }

  if (replyCancelBtn) {
    replyCancelBtn.addEventListener("click", clearReply);
  }

  // ===== Emoji picker (EmojiMart) =====
  if (emojiBtn && window.EmojiMart) {
    let pickerVisible = false;

    const pickerContainer = document.createElement("div");
    pickerContainer.id = "emojiPickerContainer";
    pickerContainer.style.position = "absolute";
    pickerContainer.style.bottom = "80px";
    pickerContainer.style.left = "280px";
    pickerContainer.style.zIndex = "2000";
    pickerContainer.style.display = "none";
    document.body.appendChild(pickerContainer);

    const picker = new EmojiMart.Picker({
      onEmojiSelect: (emoji) => {
        inputEl.value += emoji.native;
        inputEl.focus();
      },
      theme: "light",
    });
    pickerContainer.appendChild(picker);

    emojiBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pickerVisible = !pickerVisible;
      pickerContainer.style.display = pickerVisible ? "block" : "none";
    });

    // hide picker when clicking outside
    document.addEventListener("click", (e) => {
      if (
        !pickerContainer.contains(e.target) &&
        e.target !== emojiBtn
      ) {
        pickerVisible = false;
        pickerContainer.style.display = "none";
      }
    });
  }

  // ===== Socket events =====

  // main message handler (system + chat)
  socket.on("message", (data) => {
    // system messages: "X joined the conversation"
    if (data.type === "system") {
      addSystemMessage(data.text);
      return;
    }

    // normal chat messages (text / file)
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

    const id =
      Date.now().toString() + Math.random().toString(36).slice(2);

    // base payload
    const basePayload = {
      id,
      type: file ? "file" : "text",
      text,
    };

    // attach reply info if present
    if (replyTo) {
      basePayload.replyToId = replyTo.id;
      basePayload.replyToText = replyTo.text;
      basePayload.replyToUser = replyTo.user;
    }

    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const fileData = reader.result;
        socket.emit("chat-message", {
          ...basePayload,
          fileName: file.name,
          fileType: file.type,
          fileData,
        });
      };
      reader.readAsDataURL(file);
    } else {
      socket.emit("chat-message", basePayload);
    }

    inputEl.value = "";
    fileInput.value = "";
    clearReply();
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

    // --- sender name on top ---
    const nameDiv = document.createElement("div");
    nameDiv.className = "msg-sender";
    nameDiv.textContent =
      data.user || (isMe ? currentUserName : "Unknown");
    div.appendChild(nameDiv);

    // --- quoted reply box if exists ---
    if (data.replyToText) {
      const replyBox = document.createElement("div");
      replyBox.className = "reply-box";
      replyBox.textContent = `${data.replyToUser || "Unknown"}: ${
        data.replyToText
      }`;
      div.appendChild(replyBox);
    }

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
          socket.emit("edit-message", {
            id: data.id,
            newText: newText.trim(),
          });
        }
      });

      div.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (confirm("Delete this message?")) {
          socket.emit("delete-message", { id: data.id });
        }
      });
    } else {
      // reply to others' messages on double-click
      div.addEventListener("dblclick", () => {
        setReply(data);
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
