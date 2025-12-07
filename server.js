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
    senderId: String,

    type: String,     // text, file, system
    text: String,

    fileName: String,
    fileType: String,
    fileData: String,

    timestamp: Number,

    // reply data
    replyToId: String,
    replyToText: String,
    replyToUser: String,

    // reactions
    reactions: {
      type: Map,
      default: {}
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
const users = new Map(); // socket.id → { name, room }

// -------------------------
// SOCKET CONNECTION
// -------------------------
io.on("connection", (socket) => {
  console.log("🟢 User connected:", socket.id);

  // -------------------------
  // USER JOINS ROOM
  // -------------------------
  socket.on("join-room", async ({ name, room }) => {
    if (!name) name = "Anonymous";
    if (!room) room = "General";

    users.set(socket.id, { name, room });
    socket.join(room);

    // send system message
    const systemMsg = {
      id: Date.now().toString(),
      type: "system",
      text: `${name} joined the conversation`,
      timestamp: Date.now(),
      room
    };
    io.to(room).emit("message", systemMsg);

    // -------------------------
    // SEND CHAT HISTORY
    // -------------------------
    const history = await Message.find({ room }).sort({ timestamp: 1 });
    socket.emit("chat-history", history);

    sendUserList(room);
  });

  // -------------------------
  // USER SENDS MESSAGE
  // -------------------------
  socket.on("chat-message", async (msg) => {
    const user = users.get(socket.id);
    if (!user) return;

    const message = new Message({
      id: msg.id,
      room: user.room,
      user: user.name,
      senderId: socket.id,

      type: msg.type,
      text: msg.text,

      fileName: msg.fileName,
      fileType: msg.fileType,
      fileData: msg.fileData,

      timestamp: Date.now(),

      replyToId: msg.replyToId || null,
      replyToText: msg.replyToText || null,
      replyToUser: msg.replyToUser || null,

      reactions: {}
    });

    await message.save();

    io.to(user.room).emit("message", message);
  });

  // -------------------------
  // READ RECEIPT
  // -------------------------
  socket.on("seen-message", ({ messageId, senderId }) => {
    io.to(senderId).emit("message-seen", { messageId });
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

    await Message.deleteOne({ id });

    io.to(user.room).emit("message-deleted", { id });
  });

  // -------------------------
  // DELETE MESSAGE FOR ME ONLY
  // (Client-side only — server does nothing)
  // -------------------------
  socket.on("delete-message-me", ({ id }) => {
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
