document.addEventListener("DOMContentLoaded", () => {
  console.log("SCRIPT LOADED!");

  // ===== Socket connection =====
  const socket = io("https://let-s-yap.onrender.com", {
    transports: ["polling", "websocket"],
    withCredentials: false
  });
  // (Locally you could just use: const socket = io();)

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
  const loadOlderEl = document.getElementById("loadOlder");
  const pinnedBarEl = document.getElementById("pinnedBar");

  // Emoji + reply elements
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

  // ===== Avatar helpers (initials fallback with deterministic color) =====
  const AVATAR_PALETTE = [
    "linear-gradient(135deg,#14c9b6,#0ea5c4)",
    "linear-gradient(135deg,#f97066,#f59e0b)",
    "linear-gradient(135deg,#7c8cf8,#a855f7)",
    "linear-gradient(135deg,#22c55e,#0ea5c4)",
    "linear-gradient(135deg,#f472b6,#f97066)",
    "linear-gradient(135deg,#38bdf8,#7c8cf8)",
  ];

  function colorForName(name) {
    const str = String(name || "?");
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
  }

  function initialsForName(name) {
    const parts = String(name || "?").trim().split(/\s+/);
    const initials = parts.slice(0, 2).map((p) => p[0] || "").join("");
    return (initials || "?").toUpperCase();
  }

  function applyAvatar(el, name, photoURL) {
    if (photoURL) {
      el.style.backgroundImage = `url("${photoURL}")`;
      el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center";
      el.style.background = el.style.backgroundImage; // fallback shorthand consumers
      el.textContent = "";
      return;
    }
    el.style.backgroundImage = "none";
    el.style.background = colorForName(name);
    el.textContent = initialsForName(name);
  }

  applyAvatar(userAvatarEl, user.name, user.photoURL);

  const currentUserName = user.name;

  // ===== Chat history =====
  let oldestLoadedTimestamp = null;
  let hasMoreHistory = false;
  let loadingOlder = false;

  socket.on("chat-history", ({ messages, hasMore }) => {
    messages.forEach((m) => {
      const isMe = m.senderId === (user.uid || user.name);
      addChatMessage(m, isMe, true);
    });
    if (messages.length) {
      oldestLoadedTimestamp = messages[0].timestamp;
    }
    hasMoreHistory = !!hasMore;
    renderLoadOlderState();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  socket.on("more-messages", ({ messages, hasMore }) => {
    loadingOlder = false;
    const prevHeight = messagesEl.scrollHeight;

    // prepend oldest-first, but insert at top in order
    messages
      .slice()
      .reverse()
      .forEach((m) => {
        const isMe = m.senderId === (user.uid || user.name);
        addChatMessage(m, isMe, true, /* prepend */ true);
      });

    if (messages.length) {
      oldestLoadedTimestamp = messages[0].timestamp;
    }
    hasMoreHistory = !!hasMore;
    renderLoadOlderState();

    // preserve scroll position after prepending
    messagesEl.scrollTop = messagesEl.scrollHeight - prevHeight;
  });

  function renderLoadOlderState() {
    if (!loadOlderEl) return;
    if (!hasMoreHistory) {
      loadOlderEl.style.display = "none";
      return;
    }
    loadOlderEl.style.display = "flex";
    loadOlderEl.textContent = "Load older messages";
  }

  function maybeLoadOlder() {
    if (loadingOlder || !hasMoreHistory || !oldestLoadedTimestamp) return;
    if (messagesEl.scrollTop > 80) return;
    loadingOlder = true;
    if (loadOlderEl) loadOlderEl.textContent = "Loading…";
    socket.emit("load-more-messages", { before: oldestLoadedTimestamp });
  }

  messagesEl.addEventListener("scroll", () => {
    maybeLoadOlder();
  });

  // join room on connect
  socket.emit("join-room", {
  name: user.name,
  room: user.room,
  uid: user.uid || user.name // fallback if guest
});

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

  // ===== Pinned messages =====
  const pinnedMessages = new Map(); // id -> { id, text, user }

  function renderPinnedBar() {
    if (!pinnedBarEl) return;
    if (pinnedMessages.size === 0) {
      pinnedBarEl.classList.add("hidden");
      pinnedBarEl.innerHTML = "";
      return;
    }
    pinnedBarEl.classList.remove("hidden");
    pinnedBarEl.innerHTML = "";

    pinnedMessages.forEach((m) => {
      const row = document.createElement("div");
      row.className = "pinned-row";

      const icon = document.createElement("span");
      icon.className = "pinned-icon";
      icon.textContent = "📌";
      row.appendChild(icon);

      const text = document.createElement("span");
      text.className = "pinned-text";
      text.textContent = `${m.user || "Unknown"}: ${m.text || "(attachment)"}`;
      text.addEventListener("click", () => {
        const el = document.querySelector(`.message[data-id="${m.id}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("flash-highlight");
          setTimeout(() => el.classList.remove("flash-highlight"), 900);
        }
      });
      row.appendChild(text);

      const unpinBtn = document.createElement("button");
      unpinBtn.className = "pinned-unpin";
      unpinBtn.textContent = "✕";
      unpinBtn.title = "Unpin";
      unpinBtn.addEventListener("click", () => {
        socket.emit("unpin-message", { id: m.id });
      });
      row.appendChild(unpinBtn);

      pinnedBarEl.appendChild(row);
    });
  }

  socket.on("pinned-messages", (list) => {
    pinnedMessages.clear();
    (list || []).forEach((m) => pinnedMessages.set(m.id, m));
    renderPinnedBar();
  });

  socket.on("message-pinned", (msg) => {
    pinnedMessages.set(msg.id, msg);
    renderPinnedBar();
    const el = document.querySelector(`.message[data-id="${msg.id}"]`);
    if (el) el.classList.add("is-pinned");
  });

  socket.on("message-unpinned", ({ id }) => {
    pinnedMessages.delete(id);
    renderPinnedBar();
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (el) el.classList.remove("is-pinned");
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
      if (!pickerContainer.contains(e.target) && e.target !== emojiBtn) {
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

    const isMe = data.senderId === (user.uid || user.name);

    if (isMe && myMessages.has(data.id)) {
      // this is the server's echo of a message we already rendered optimistically
      // upgrade its tick from "sent" to "delivered"
      const el = myMessages.get(data.id);
      setTickState(el, "delivered");
      return;
    }

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

  // Tick state machine: sent (single grey) -> delivered (double grey) -> read (double blue)
  function tickGlyph(state) {
    if (state === "sent") return "✓";
    return "✓✓"; // delivered or read
  }

  function setTickState(el, state) {
    const tickSpan = el.querySelector(".tick");
    if (!tickSpan) return;
    // never downgrade read -> delivered
    if (tickSpan.dataset.state === "read" && state !== "read") return;
    tickSpan.dataset.state = state;
    tickSpan.textContent = tickGlyph(state);
    tickSpan.classList.toggle("tick-read", state === "read");
  }

  // read receipt - seen
  socket.on("message-seen", ({ messageId }) => {
    const el = myMessages.get(messageId);
    if (!el) return;
    setTickState(el, "read");
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
    if (textSpan) {
      textSpan.textContent = "";
      textSpan.appendChild(linkifyText(newText));
      const badge = document.createElement("span");
      badge.className = "edited-badge";
      badge.textContent = " (edited)";
      textSpan.appendChild(badge);
    }
  });

  // delete for everyone
  socket.on("message-deleted", ({ id }) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (!el) return;
    el.classList.add("deleted");
    el.innerHTML = `<span class="message-text deleted-text">🚫 This message was deleted</span>`;
  });

  // delete for me only
  socket.on("message-deleted-me", ({ id }) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (!el) return;
    el.remove();
  });

  // reactions updated
  socket.on("message-reacted", ({ id, reactions }) => {
    const el = document.querySelector(`.message[data-id="${id}"]`);
    if (!el || !el._renderReactions) return;
    el._renderReactions(reactions);
  });

  // ===== Sending messages =====
  sendBtn.addEventListener("click", sendMessage);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendMessage();
    }
  });

  // auto-send when a file is chosen (WhatsApp-like)
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length > 0) {
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
      timestamp: Date.now(),
    };

    // attach reply info if present
    if (replyTo) {
      basePayload.replyToId = replyTo.id;
      basePayload.replyToText = replyTo.text;
      basePayload.replyToUser = replyTo.user;
    }

    // ---- FILE MESSAGE ----
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const fileData = reader.result;
        const payload = {
          ...basePayload,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          fileData,
          text: text || "", // caption or empty
        };

        addChatMessage({ ...payload, user: currentUserName }, true);
        socket.emit("chat-message", payload);

        fileInput.value = "";
        inputEl.value = "";
        clearReply();
      };
      reader.readAsDataURL(file);
      return; // important: don't send text-only after this
    }

    // ---- TEXT MESSAGE ----
    addChatMessage({ ...basePayload, user: currentUserName }, true);
    socket.emit("chat-message", basePayload);

    inputEl.value = "";
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

  // ===== Link detection helpers =====
  const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;!?)'"\]])/gi;

  function linkifyText(text) {
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let match;
    URL_RE.lastIndex = 0;
    while ((match = URL_RE.exec(text)) !== null) {
      if (match.index > lastIndex) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const a = document.createElement("a");
      a.href = match[0];
      a.textContent = match[0];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      frag.appendChild(a);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    return frag;
  }

  function firstUrlIn(text) {
    URL_RE.lastIndex = 0;
    const m = URL_RE.exec(text || "");
    return m ? m[0] : null;
  }

  function domainOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  }

  function formatFileSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function fileIconFor(fileType, fileName) {
    const ext = (fileName || "").split(".").pop().toLowerCase();
    if (fileType && fileType.includes("pdf")) return "📄";
    if (["doc", "docx"].includes(ext)) return "📝";
    if (["xls", "xlsx", "csv"].includes(ext)) return "📊";
    if (["zip", "rar", "7z"].includes(ext)) return "🗜️";
    if (fileType && fileType.startsWith("audio/")) return "🎵";
    return "📎";
  }

  // simple in-memory cache so we don't refetch a preview for the same URL twice
  const linkPreviewCache = new Map();

  async function attachLinkPreview(container, url) {
    // Lightweight client-side unfurl via a public metadata proxy.
    // Fails silently (no preview) if unavailable — never blocks the message.
    try {
      let data = linkPreviewCache.get(url);
      if (!data) {
        const res = await fetch(
          "https://api.microlink.io/?url=" + encodeURIComponent(url)
        );
        if (!res.ok) return;
        const json = await res.json();
        if (json.status !== "success") return;
        data = json.data;
        linkPreviewCache.set(url, data);
      }
      if (!data || (!data.title && !data.image)) return;

      const card = document.createElement("a");
      card.className = "link-preview";
      card.href = url;
      card.target = "_blank";
      card.rel = "noopener noreferrer";

      if (data.image && data.image.url) {
        const img = document.createElement("img");
        img.src = data.image.url;
        img.loading = "lazy";
        card.appendChild(img);
      }

      const body = document.createElement("div");
      body.className = "link-preview-body";

      if (data.title) {
        const title = document.createElement("div");
        title.className = "link-preview-title";
        title.textContent = data.title;
        body.appendChild(title);
      }
      if (data.description) {
        const desc = document.createElement("div");
        desc.className = "link-preview-desc";
        desc.textContent = data.description;
        body.appendChild(desc);
      }
      const domain = document.createElement("div");
      domain.className = "link-preview-domain";
      domain.textContent = domainOf(url);
      body.appendChild(domain);

      card.appendChild(body);
      container.insertBefore(card, container.firstChild);
    } catch {
      // network blocked / offline — just skip the preview
    }
  }

  function addChatMessage(data, isMe, skipTickInit, prepend) {
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
      // ---- media / file rendering ----
      if (data.fileType && data.fileType.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = data.fileData;
        img.addEventListener("click", () => window.open(data.fileData, "_blank"));
        div.appendChild(img);
      } else if (data.fileType && data.fileType.startsWith("video/")) {
        const video = document.createElement("video");
        video.src = data.fileData;
        video.controls = true;
        div.appendChild(video);
      } else {
        const chip = document.createElement("a");
        chip.className = "file-chip";
        chip.href = data.fileData;
        chip.download = data.fileName || "file";

        const icon = document.createElement("div");
        icon.className = "file-chip-icon";
        icon.textContent = fileIconFor(data.fileType, data.fileName);
        chip.appendChild(icon);

        const meta = document.createElement("div");
        meta.className = "file-chip-meta";
        const nameEl = document.createElement("div");
        nameEl.className = "file-chip-name";
        nameEl.textContent = data.fileName || "Download file";
        const sizeEl = document.createElement("div");
        sizeEl.className = "file-chip-size";
        sizeEl.textContent = formatFileSize(data.fileSize);
        meta.appendChild(nameEl);
        meta.appendChild(sizeEl);
        chip.appendChild(meta);

        div.appendChild(chip);
      }

      if (data.text) {
        textSpan.appendChild(linkifyText(data.text));
        div.appendChild(textSpan);
      }
    } else {
      textSpan.appendChild(linkifyText(data.text || ""));
      div.appendChild(textSpan);

      // auto link-preview card for the first URL in a text-only message
      const url = firstUrlIn(data.text);
      if (url) attachLinkPreview(div, url);
    }

    // time + ticks
    const timeSpan = document.createElement("span");
    timeSpan.className = "time-label";
    timeSpan.textContent = formatTime(data.timestamp || Date.now());

    if (isMe) {
      const tickSpan = document.createElement("span");
      tickSpan.className = "tick";
      // history messages are already delivered+ (server has them); fresh sends start as "sent"
      const initState = skipTickInit ? "delivered" : "sent";
      tickSpan.dataset.state = initState;
      tickSpan.textContent = tickGlyph(initState);
      timeSpan.appendChild(tickSpan);
      myMessages.set(data.id, div);
    }

    div.appendChild(timeSpan);

    // Reaction bar under message
    const reactionBar = document.createElement("div");
    reactionBar.className = "reaction-bar";
    reactionBar.style.display = "none";
    div.appendChild(reactionBar);

    function renderReactions(reactions) {
      reactionBar.innerHTML = "";
      const entries = Object.entries(reactions || {});
      if (!entries.length) {
        reactionBar.style.display = "none";
        return;
      }
      // group by emoji -> count + list of names
      const grouped = {};
      entries.forEach(([userName, emoji]) => {
        if (!grouped[emoji]) grouped[emoji] = [];
        grouped[emoji].push(userName);
      });
      Object.entries(grouped).forEach(([emoji, names]) => {
        const chip = document.createElement("span");
        chip.className = "reaction-chip";
        chip.textContent = names.length > 1 ? `${emoji} ${names.length}` : emoji;
        chip.title = names.join(", ");
        reactionBar.appendChild(chip);
      });
      reactionBar.style.display = "inline-flex";
    }

    // if there are existing reactions (from history)
    if (data.reactions) renderReactions(data.reactions);
    div._renderReactions = renderReactions;

    if (data.pinned) div.classList.add("is-pinned");

    // ===== Hover action menu (⋮) =====
    const actionsWrap = document.createElement("div");
    actionsWrap.className = "msg-actions";

    const menuBtn = document.createElement("button");
    menuBtn.className = "msg-actions-btn";
    menuBtn.textContent = "⋮";
    menuBtn.title = "Message actions";
    actionsWrap.appendChild(menuBtn);

    const reactQuickBtn = document.createElement("button");
    reactQuickBtn.className = "msg-actions-btn";
    reactQuickBtn.textContent = "😊";
    reactQuickBtn.title = "React";
    actionsWrap.appendChild(reactQuickBtn);

    div.appendChild(actionsWrap);

    // Reaction popover
    const REACTION_EMOJIS = ["❤️", "😂", "👍", "😮", "😢", "🙏"];
    function openReactionPopover(anchorEl) {
      closeAnyOpenPopovers();
      const pop = document.createElement("div");
      pop.className = "reaction-popover";
      REACTION_EMOJIS.forEach((emoji) => {
        const btn = document.createElement("button");
        btn.textContent = emoji;
        btn.addEventListener("click", () => {
          socket.emit("react-message", {
            id: data.id,
            emoji,
            user: currentUserName,
          });
          pop.remove();
        });
        pop.appendChild(btn);
      });
      document.body.appendChild(pop);
      const rect = anchorEl.getBoundingClientRect();
      pop.style.top = `${rect.top - pop.offsetHeight - 44 + window.scrollY}px`;
      pop.style.left = `${Math.max(8, rect.left - 100 + window.scrollX)}px`;
      requestAnimationFrame(() => {
        const r2 = pop.getBoundingClientRect();
        pop.style.top = `${rect.top - r2.height - 8 + window.scrollY}px`;
      });
      setTimeout(() => {
        document.addEventListener("click", closeAnyOpenPopovers, { once: true });
      }, 0);
    }

    reactQuickBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openReactionPopover(reactQuickBtn);
    });

    // Action dropdown menu
    function openActionMenu() {
      closeAnyOpenPopovers();
      const menu = document.createElement("div");
      menu.className = "msg-dropdown";

      function item(label, handler) {
        const it = document.createElement("button");
        it.className = "msg-dropdown-item";
        it.textContent = label;
        it.addEventListener("click", () => {
          handler();
          menu.remove();
        });
        menu.appendChild(it);
      }

      item("Reply", () => setReply(data));

      if (isMe) {
        item("Edit", () => {
          const newText = prompt("Edit your message:", data.text);
          if (newText && newText.trim()) {
            socket.emit("edit-message", { id: data.id, newText: newText.trim() });
          }
        });
      }

      item("Copy", () => {
        navigator.clipboard?.writeText(data.text || "").catch(() => {});
      });

      if (pinnedMessages.has(data.id)) {
        item("Unpin", () => socket.emit("unpin-message", { id: data.id }));
      } else {
        item("Pin", () => socket.emit("pin-message", { id: data.id }));
      }

      if (isMe) {
        item("Delete for everyone", () =>
          socket.emit("delete-message-everyone", { id: data.id })
        );
        item("Delete for me", () => socket.emit("delete-message-me", { id: data.id }));
      } else {
        item("Delete for me", () => socket.emit("delete-message-me", { id: data.id }));
      }

      document.body.appendChild(menu);
      const rect = menuBtn.getBoundingClientRect();
      menu.style.top = `${rect.bottom + 4 + window.scrollY}px`;
      menu.style.left = `${Math.max(8, rect.left - 120 + window.scrollX)}px`;
      setTimeout(() => {
        document.addEventListener("click", closeAnyOpenPopovers, { once: true });
      }, 0);
    }

    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openActionMenu();
    });

    if (prepend) {
      const anchor = loadOlderEl && loadOlderEl.nextSibling;
      messagesEl.insertBefore(div, anchor || messagesEl.firstChild);
    } else {
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  // close any open reaction popover / action dropdown
  function closeAnyOpenPopovers() {
    document.querySelectorAll(".reaction-popover, .msg-dropdown").forEach((el) => el.remove());
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