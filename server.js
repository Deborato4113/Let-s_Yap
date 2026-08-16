// -------------------------
// INITIAL SETUP
// -------------------------
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const io = new Server(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// -------------------------
// MONGO CONNECTION
// -------------------------
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

// -------------------------
// MESSAGE SCHEMA
// -------------------------
const Message = mongoose.model(
  "Message",
  new mongoose.Schema({
    id: String,
    room: String,
    user: String,
    senderId: String,   // Firebase UID

    type: String,
    text: String,

    fileName: String,
    fileType: String,
    fileData: String,

    timestamp: Number,

    replyToId: String,
    replyToText: String,
    replyToUser: String,

    reactions: {
      type: Map,
      default: {}
    },

    pinned: {
      type: Boolean,
      default: false
    },

    // NEW FIELDS
    deletedForEveryone: {
      type: Boolean,
      default: false
    },

    deletedFor: {
      type: [String], // Array of Firebase UIDs
      default: []
    }
  })
);

// -------------------------
// STATIC FILES
// -------------------------
app.use(express.static(__dirname + "/public"));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/login.html");
});

app.get("/chat", (req, res) => {
  res.sendFile(__dirname + "/public/chat.html");
});

// -------------------------
// USERS (IN-MEMORY)
// -------------------------
const users = new Map(); 
// socket.id → { name, room, uid }

// -------------------------
// SOCKET CONNECTION
// -------------------------
io.on("connection", (socket) => {
  console.log("🟢 User connected:", socket.id);

  // -------------------------
  // USER JOINS ROOM
  // -------------------------
  socket.on("join-room", async ({ name, room, uid }) => {
  if (!name) name = "Anonymous";
  if (!room) room = "General";
  if (!uid) uid = name; // fallback for guest users

  users.set(socket.id, { name, room, uid });
  socket.join(room);

  // Send system message to others only
  socket.to(room).emit("message", {
    id: Date.now().toString(),
    type: "system",
    text: `${name} joined the conversation`,
    timestamp: Date.now(),
    room
  });

  // Load history excluding deleted messages
  const PAGE_SIZE = 30;

  const history = await Message.find({
    room,
    deletedForEveryone: false,
    deletedFor: { $ne: uid }
  })
    .sort({ timestamp: -1 })
    .limit(PAGE_SIZE);

  history.reverse(); // oldest -> newest for rendering

  const hasMore = history.length === PAGE_SIZE;

  socket.emit("chat-history", { messages: history, hasMore });

  const pinned = await Message.find({
    room,
    pinned: true,
    deletedForEveryone: false
  }).sort({ timestamp: 1 });

  socket.emit("pinned-messages", pinned);

  sendUserList(room);
});

  // -------------------------
  // LOAD OLDER MESSAGES (PAGINATION)
  // -------------------------
  socket.on("load-more-messages", async ({ before }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const PAGE_SIZE = 30;

    const older = await Message.find({
      room: user.room,
      deletedForEveryone: false,
      deletedFor: { $ne: user.uid },
      timestamp: { $lt: before }
    })
      .sort({ timestamp: -1 })
      .limit(PAGE_SIZE);

    older.reverse();

    const hasMore = older.length === PAGE_SIZE;

    socket.emit("more-messages", { messages: older, hasMore });
  });

  // -------------------------
  // USER SENDS MESSAGE
  // -------------------------
  socket.on("chat-message", async (msg) => {
    const user = users.get(socket.id);
    if (!user) return;

    const message = new Message({
      ...msg,
      room: user.room,
      user: user.name,
      senderId: user.uid,
      timestamp: msg.timestamp || Date.now()
    });

    await message.save();

    io.to(user.room).emit("message", message);
  });

  // -------------------------
  // READ RECEIPT
  // -------------------------
  socket.on("seen-message", ({ messageId, senderId }) => {
    // senderId is a Firebase UID, not a socket id/room, so find their live socket(s)
    for (const [sockId, u] of users.entries()) {
      if (u.uid === senderId) {
        io.to(sockId).emit("message-seen", { messageId });
      }
    }
  });

  // -------------------------
  // EDIT MESSAGE
  // -------------------------
  socket.on("edit-message", async ({ id, newText }) => {
    const user = users.get(socket.id);
    if (!user) return;

    await Message.updateOne({ id }, { $set: { text: newText } });

    io.to(user.room).emit("message-edited", { id, newText });
  });

  // -------------------------
  // DELETE MESSAGE (FOR EVERYONE)
  // -------------------------
  socket.on("delete-message-everyone", async ({ id }) => {
    const user = users.get(socket.id);
    if (!user) return;

    await Message.updateOne(
      { id },
      { $set: { deletedForEveryone: true, pinned: false } }
    );

    io.to(user.room).emit("message-deleted", { id });
  });

  // -------------------------
  // DELETE MESSAGE FOR ME ONLY
  // (Client-side only — server does nothing)
  // -------------------------
  socket.on("delete-message-me", async ({ id }) => {
  const user = users.get(socket.id);
  if (!user) return;

  await Message.updateOne(
    { id },
    { $addToSet: { deletedFor: user.uid } }
  );

  socket.emit("message-deleted-me", { id });
});
  // -------------------------
  // REACTIONS
  // -------------------------
  socket.on("react-message", async ({ id, emoji, user }) => {
    const msg = await Message.findOne({ id });
    if (!msg) return;

    msg.reactions.set(user, emoji);
    await msg.save();

    io.to(msg.room).emit("message-reacted", {
      id,
      reactions: Object.fromEntries(msg.reactions)
    });
  });

  // -------------------------
  // PIN / UNPIN MESSAGE
  // -------------------------
  socket.on("pin-message", async ({ id }) => {
    const user = users.get(socket.id);
    if (!user) return;

    await Message.updateOne({ id }, { $set: { pinned: true } });
    const msg = await Message.findOne({ id });

    io.to(user.room).emit("message-pinned", msg);
  });

  socket.on("unpin-message", async ({ id }) => {
    const user = users.get(socket.id);
    if (!user) return;

    await Message.updateOne({ id }, { $set: { pinned: false } });

    io.to(user.room).emit("message-unpinned", { id });
  });

  // -------------------------
  // TYPING
  // -------------------------
  socket.on("typing", (isTyping) => {
    const u = users.get(socket.id);
    if (!u) return;
    socket.to(u.room).emit("typing", {
      user: u.name,
      isTyping
    });
  });

  // -------------------------
  // DISCONNECT
  // -------------------------
  socket.on("disconnect", () => {
    const u = users.get(socket.id);
    if (!u) return;

    io.to(u.room).emit("message", {
      id: Date.now().toString(),
      type: "system",
      text: `${u.name} left the chat`,
      timestamp: Date.now()
    });

    users.delete(socket.id);
    sendUserList(u.room);
  });

  function sendUserList(room) {
    const list = [];
    users.forEach((val, key) => {
      if (val.room === room) list.push({ id: key, name: val.name });
    });
    io.to(room).emit("room-users", list);
  }
});

// -------------------------
// START SERVER
// -------------------------
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});