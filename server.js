// -------------------------
// INITIAL SETUP
// -------------------------
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const crypto = require("crypto");
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
// ROOM SCHEMA
// -------------------------
const Room = mongoose.model(
  "Room",
  new mongoose.Schema({
    name: { type: String, unique: true }, // canonical lowercase key
    displayName: String,
    description: { type: String, default: "" },
    isPrivate: { type: Boolean, default: false },
    passwordHash: { type: String, default: "" }, // "salt:hash" or empty
    createdBy: String,
    createdAt: { type: Number, default: Date.now }
  })
);

const DEFAULT_ROOMS = [
  { displayName: "General", description: "General chatter" },
  { displayName: "Development", description: "Code, bugs, and builds" },
  { displayName: "Gaming", description: "Whatever we're playing this week" },
  { displayName: "College", description: "Classes, deadlines, campus stuff" },
  { displayName: "Random", description: "Everything else" }
];

async function seedDefaultRooms() {
  for (const r of DEFAULT_ROOMS) {
    const key = r.displayName.toLowerCase();
    const exists = await Room.findOne({ name: key });
    if (!exists) {
      await Room.create({
        name: key,
        displayName: r.displayName,
        description: r.description,
        isPrivate: false,
        passwordHash: "",
        createdBy: "system"
      });
    }
  }
}
seedDefaultRooms().catch((e) => console.error("Room seed error:", e));

// -------------------------
// PASSWORD HASHING (built-in crypto, no extra deps)
// -------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(8).toString("hex");
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

// -------------------------
// DM HELPERS
// -------------------------
function isDmRoom(room) {
  return typeof room === "string" && room.startsWith("dm__");
}

function dmRoomId(uidA, uidB) {
  return "dm__" + [uidA, uidB].sort().join("__");
}

function dmPeerUid(room, myUid) {
  const parts = room.replace("dm__", "").split("__");
  return parts.find((p) => p !== myUid) || parts[0];
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
// socket.id → { name, room, uid, photoURL, bio, avatarData, status }

// -------------------------
// SOCKET CONNECTION
// -------------------------
io.on("connection", (socket) => {
  console.log("🟢 User connected:", socket.id);

  // -------------------------
  // SHARED ROOM-ENTRY LOGIC
  // used by join-room (login), switch-room, and open-dm
  // -------------------------
  async function enterRoom({ name, uid, photoURL, room, password, peer }) {
    const existing = users.get(socket.id);
    const prevRoom = existing ? existing.room : null;

    if (!isDmRoom(room)) {
      let roomDoc = await Room.findOne({ name: room.toLowerCase() });

      if (!roomDoc) {
        // auto-create unknown rooms as public (keeps old clients / stale
        // localStorage room names from breaking)
        roomDoc = await Room.create({
          name: room.toLowerCase(),
          displayName: room,
          description: "",
          isPrivate: false,
          passwordHash: "",
          createdBy: uid
        });
      }

      if (roomDoc.isPrivate && roomDoc.passwordHash) {
        if (!password || !verifyPassword(password, roomDoc.passwordHash)) {
          socket.emit("join-error", { message: "Incorrect or missing room password." });
          return;
        }
      }

      room = roomDoc.name;
    }

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
      profile.name = name;
      profile.status = "online";
      await profile.save();
    }

    if (prevRoom && prevRoom !== room) {
      socket.leave(prevRoom);
    }

    users.set(socket.id, {
      name,
      room,
      uid,
      photoURL: photoURL || (existing && existing.photoURL) || null,
      bio: profile.bio,
      avatarData: profile.avatarData,
      status: profile.status
    });
    socket.join(room);

    if (!isDmRoom(room)) {
      socket.to(room).emit("message", {
        id: Date.now().toString(),
        type: "system",
        text: `${name} joined the conversation`,
        timestamp: Date.now(),
        room
      });
    }

    socket.emit("room-joined", { room, isDm: isDmRoom(room), peer: peer || null });

    const PAGE_SIZE = 30;
    const history = await Message.find({
      room,
      deletedForEveryone: false,
      deletedFor: { $ne: uid }
    })
      .sort({ timestamp: -1 })
      .limit(PAGE_SIZE);
    history.reverse();
    const hasMore = history.length === PAGE_SIZE;

    socket.emit("chat-history", { messages: history, hasMore });

    const pinned = await Message.find({
      room,
      pinned: true,
      deletedForEveryone: false
    }).sort({ timestamp: 1 });
    socket.emit("pinned-messages", pinned);

    sendUserList(room);
  }

  // -------------------------
  // USER JOINS ROOM (initial login)
  // -------------------------
  socket.on("join-room", async ({ name, room, uid, photoURL }) => {
    if (!name) name = "Anonymous";
    if (!room) room = "General";
    if (!uid) uid = name;
    await enterRoom({ name, uid, photoURL, room });
  });

  // -------------------------
  // SWITCH TO ANOTHER ROOM
  // -------------------------
  socket.on("switch-room", async ({ room, password }) => {
    const u = users.get(socket.id);
    if (!u || !room) return;
    await enterRoom({ name: u.name, uid: u.uid, photoURL: u.photoURL, room, password });
  });

  // -------------------------
  // ROOMS: LIST / CREATE
  // -------------------------
  async function buildRoomListFor(uid) {
    const rooms = await Room.find({ isPrivate: { $ne: true } }).sort({ createdAt: 1 });
    const list = rooms.map((r) => ({
      name: r.name,
      displayName: r.displayName,
      description: r.description,
      isPrivate: r.isPrivate,
      memberCount: io.sockets.adapter.rooms.get(r.name)?.size || 0
    }));

    if (uid) {
      const myPrivate = await Room.find({ isPrivate: true, createdBy: uid });
      myPrivate.forEach((r) => {
        list.push({
          name: r.name,
          displayName: r.displayName,
          description: r.description,
          isPrivate: true,
          memberCount: io.sockets.adapter.rooms.get(r.name)?.size || 0
        });
      });
    }
    return list;
  }

  // broadcast everyone's personalized room list (public rooms + each
  // person's own private rooms) — used whenever the shared room set changes
  async function broadcastRoomLists() {
    for (const [sockId, u] of users.entries()) {
      const list = await buildRoomListFor(u.uid);
      io.to(sockId).emit("rooms-updated", list);
    }
  }

  socket.on("get-rooms", async () => {
    const u = users.get(socket.id);
    const list = await buildRoomListFor(u ? u.uid : null);
    socket.emit("rooms-list", list);
  });

  socket.on("create-room", async ({ name, description, isPrivate, password }) => {
    const u = users.get(socket.id);
    if (!u) return;
    if (!name || !name.trim()) {
      socket.emit("room-error", { message: "Room name is required." });
      return;
    }
    const key = name.trim().toLowerCase();
    if (key.startsWith("dm__")) {
      socket.emit("room-error", { message: "That room name is reserved." });
      return;
    }
    const existing = await Room.findOne({ name: key });
    if (existing) {
      socket.emit("room-error", { message: "A room with that name already exists." });
      return;
    }

    const passwordHash = isPrivate && password ? hashPassword(password) : "";

    await Room.create({
      name: key,
      displayName: name.trim(),
      description: (description || "").slice(0, 140),
      isPrivate: !!isPrivate,
      passwordHash,
      createdBy: u.uid
    });

    await broadcastRoomLists();

    socket.emit("room-created", { name: key });
  });

  // -------------------------
  // DIRECT MESSAGES
  // -------------------------
  socket.on("open-dm", async ({ targetUid, targetName, targetPhoto, targetAvatarData }) => {
    const u = users.get(socket.id);
    if (!u || !targetUid) return;

    const room = dmRoomId(u.uid, targetUid);
    await enterRoom({
      name: u.name,
      uid: u.uid,
      photoURL: u.photoURL,
      room,
      peer: {
        uid: targetUid,
        name: targetName || "Unknown",
        photoURL: targetPhoto || null,
        avatarData: targetAvatarData || null
      }
    });
  });

  socket.on("get-dm-list", async () => {
    const u = users.get(socket.id);
    if (!u) return;

    const rows = await Message.aggregate([
      { $match: { room: { $regex: `^dm__.*${escapeRegex(u.uid)}.*` } } },
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: "$room",
          lastText: { $first: "$text" },
          lastType: { $first: "$type" },
          lastTimestamp: { $first: "$timestamp" }
        }
      }
    ]);

    const result = [];
    for (const row of rows) {
      if (!isDmRoom(row._id)) continue;
      const peerUid = dmPeerUid(row._id, u.uid);
      if (peerUid === u.uid) continue; // guard against self-DM edge case

      const profile = await UserProfile.findOne({ uid: peerUid });
      let liveStatus = "offline";
      for (const val of users.values()) {
        if (val.uid === peerUid) {
          liveStatus = val.status || "online";
          break;
        }
      }

      result.push({
        room: row._id,
        peerUid,
        peerName: profile ? profile.name : "Unknown",
        peerAvatarData: profile ? profile.avatarData : "",
        status: liveStatus,
        lastText: row.lastType === "file" ? "📎 Attachment" : row.lastText,
        lastTimestamp: row.lastTimestamp
      });
    }

    result.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
    socket.emit("dm-list", result);
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

    // For DMs, also nudge the peer directly in case they don't currently
    // have this conversation open (so their sidebar can update/badge it).
    if (isDmRoom(user.room)) {
      const peerUid = dmPeerUid(user.room, user.uid);
      for (const [sockId, u] of users.entries()) {
        if (u.uid === peerUid && u.room !== user.room) {
          io.to(sockId).emit("dm-incoming", {
            room: user.room,
            fromUid: user.uid,
            fromName: user.name,
            text: message.type === "file" ? "📎 Attachment" : message.text,
            timestamp: message.timestamp
          });
        }
      }
    }
  });

  // -------------------------
  // READ RECEIPT
  // -------------------------
  socket.on("seen-message", ({ messageId, senderId }) => {
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

    if (!isDmRoom(u.room)) {
      io.to(u.room).emit("message", {
        id: Date.now().toString(),
        type: "system",
        text: `${u.name} left the chat`,
        timestamp: Date.now()
      });
    }

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