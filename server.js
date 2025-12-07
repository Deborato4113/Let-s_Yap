const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const io = new Server(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});


// =======================
//   MONGODB SETUP
// =======================
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB error:", err));


const Message = mongoose.model(
  "Message",
  new mongoose.Schema({
    id: String,
    user: String,
    text: String,
    type: String,
    fileName: String,
    fileData: String,
    fileType: String,
    senderId: String,
    room: String,
    timestamp: Number,

    // reply
    replyToId: String,
    replyToText: String,
    replyToUser: String,
  })
);


// =======================
//     STATIC FILES
// =======================
app.use(express.static(__dirname + "/public"));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/login.html");
});

app.get("/chat", (req, res) => {
  res.sendFile(__dirname + "/public/chat.html");
});


// =======================
//     SOCKET LOGIC
// =======================

const users = new Map(); // socket.id → { name, room }

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // JOIN ROOM
  socket.on("join-room", async ({ name, room }) => {
    if (!name) name = "Anonymous";
    if (!room) room = "General";

    const prev = users.get(socket.id);
    if (prev && prev.room) socket.leave(prev.room);

    users.set(socket.id, { name, room });
    socket.join(room);

    // LOAD CHAT HISTORY
    const history = await Message.find({ room })
      .sort({ timestamp: 1 })
      .limit(200); // load last 200 messages

    socket.emit("chat-history", history);

    // SYSTEM JOIN MESSAGE
    io.to(room).emit("message", {
      type: "system",
      text: `${name} joined the conversation`,
      timestamp: Date.now(),
    });

    sendRoomUsers(room);
  });


  // ===========================
  //    CHAT MESSAGE (SAVE + SEND)
  // ===========================
  socket.on("chat-message", async (msg) => {
    const u = users.get(socket.id);
    if (!u) return;

    const message = {
      id: msg.id,
      type: msg.type || "text",
      text: msg.text || "",
      fileName: msg.fileName || null,
      fileData: msg.fileData || null,
      fileType: msg.fileType || null,
      user: u.name,
      senderId: socket.id,
      room: u.room,
      timestamp: Date.now(),

      replyToId: msg.replyToId || null,
      replyToText: msg.replyToText || null,
      replyToUser: msg.replyToUser || null,
    };

    // SAVE TO DB
    await Message.create(message);

    // BROADCAST
    io.to(u.room).emit("message", message);
  });


  // TYPING
  socket.on("typing", (isTyping) => {
    const u = users.get(socket.id);
    if (!u) return;
    socket.to(u.room).emit("typing", { user: u.name, isTyping });
  });


  // MESSAGE SEEN
  socket.on("seen-message", ({ messageId, senderId }) => {
    if (!messageId || !senderId) return;
    io.to(senderId).emit("message-seen", { messageId });
  });


  // EDIT MESSAGE
  socket.on("edit-message", ({ id, newText }) => {
    const u = users.get(socket.id);
    if (!u) return;

    // Update DB
    Message.updateOne({ id }, { text: newText }).catch(err =>
      console.log("Edit error:", err)
    );

    io.to(u.room).emit("message-edited", { id, newText });
  });


  // DELETE MESSAGE
  socket.on("delete-message", ({ id }) => {
    const u = users.get(socket.id);
    if (!u) return;

    // Update DB as deleted
    Message.updateOne({ id }, { text: "", type: "deleted" }).catch(err =>
      console.log("Delete error:", err)
    );

    io.to(u.room).emit("message-deleted", { id });
  });


  // DISCONNECT
  socket.on("disconnect", () => {
    const u = users.get(socket.id);
    if (!u) return;

    const { name, room } = u;
    users.delete(socket.id);

    io.to(room).emit("message", {
      type: "system",
      text: `${name} left the chat`,
      timestamp: Date.now(),
    });

    sendRoomUsers(room);
  });


  // SEND USER LIST
  function sendRoomUsers(room) {
    const list = [];
    users.forEach((val, key) => {
      if (val.room === room) {
        list.push({ id: key, name: val.name });
      }
    });
    io.to(room).emit("room-users", list);
  }
});


// =======================
//       START SERVER
// =======================
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
