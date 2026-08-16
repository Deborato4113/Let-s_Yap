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
// USER PROFILE SCHEMA
// -------------------------
const UserProfile = mongoose.model(
  "UserProfile",
  new mongoose.Schema({
    uid: { type: String, unique: true },
    name: String,
    bio: { type: String, default: "" },
    avatarData: { type: String, default: "" }, // base64 data URL, empty = use initials/Google photo
    status: { type: String, default: "online" }, // online | away | dnd | offline
    lastSeen: { type: Number, default: Date.now }
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
  socket.on("join-room", async ({ name, room, uid, photoURL }) => {
  if (!name) name = "Anonymous";
  if (!room) room = "General";
  if (!uid) uid = name; // fallback for guest users

  // Load or create persistent profile
  let profile = await UserProfile.findOne({ uid });
  if (!profile) {
    profile = await UserProfile.create({
      uid,
      name,
      bio: "",
      avatarData: "",
      status: "online",
      lastSeen: Date.now()
    });
  } else {
    profile.name = name; // keep display name fresh
    profile.status = "online";
    await profile.save();
  }

  users.set(socket.id, {
    name,
    room,
    uid,
    photoURL: photoURL || null,
    bio: profile.bio,
    avatarData: profile.avatarData,
    status: profile.status
  });
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
  // PROFILE: FETCH (view someone else's profile)
  // -------------------------
  socket.on("get-profile", async ({ uid }) => {
    const profile = await UserProfile.findOne({ uid });
    if (!profile) return;
    socket.emit("profile-data", {
      uid: profile.uid,
      name: profile.name,
      bio: profile.bio,
      avatarData: profile.avatarData,
      status: profile.status,
      lastSeen: profile.lastSeen
    });
  });

  // -------------------------
  // PROFILE: UPDATE (name / bio / avatar)
  // -------------------------
  socket.on("update-profile", async ({ name, bio, avatarData }) => {
    const u = users.get(socket.id);
    if (!u) return;

    const update = {};
    if (typeof name === "string" && name.trim()) update.name = name.trim();
    if (typeof bio === "string") update.bio = bio.slice(0, 200);
    if (typeof avatarData === "string") update.avatarData = avatarData;

    await UserProfile.updateOne({ uid: u.uid }, { $set: update });

    if (update.name) u.name = update.name;
    if (typeof update.bio === "string") u.bio = update.bio;
    if (typeof update.avatarData === "string") u.avatarData = update.avatarData;

    io.to(u.room).emit("profile-updated", {
      uid: u.uid,
      name: u.name,
      bio: u.bio,
      avatarData: u.avatarData
    });

    sendUserList(u.room);
  });

  // -------------------------
  // PRESENCE: STATUS CHANGE
  // -------------------------
  socket.on("set-status", async (status) => {
    const u = users.get(socket.id);
    if (!u) return;
    if (!["online", "away", "dnd"].includes(status)) return;

    u.status = status;
    await UserProfile.updateOne({ uid: u.uid }, { $set: { status } });

    sendUserList(u.room);
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
  socket.on("disconnect", async () => {
    const u = users.get(socket.id);
    if (!u) return;

    io.to(u.room).emit("message", {
      id: Date.now().toString(),
      type: "system",
      text: `${u.name} left the chat`,
      timestamp: Date.now()
    });

    const lastSeen = Date.now();
    await UserProfile.updateOne(
      { uid: u.uid },
      { $set: { status: "offline", lastSeen } }
    );

    users.delete(socket.id);
    io.to(u.room).emit("user-offline", { uid: u.uid, lastSeen });
    sendUserList(u.room);
  });

  function sendUserList(room) {
    const list = [];
    users.forEach((val, key) => {
      if (val.room === room) {
        list.push({
          id: key,
          uid: val.uid,
          name: val.name,
          status: val.status || "online",
          photoURL: val.photoURL || null,
          avatarData: val.avatarData || null,
          bio: val.bio || ""
        });
      }
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