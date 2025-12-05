const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const io = new Server(http);

// Serve static files from public directory
app.use(express.static(__dirname + "/public"));

// Login page on root
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/login.html");
});

// Chat page
app.get("/chat", (req, res) => {
  res.sendFile(__dirname + "/public/chat.html");
});

// Keep track of users by socket
const users = new Map(); // socket.id -> {name, room}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // join a room with user info
  socket.on("join-room", ({ name, room }) => {
    if (!name) name = "Anonymous";
    if (!room) room = "General";

    // leave previous room
    const prev = users.get(socket.id);
    if (prev && prev.room) socket.leave(prev.room);

    // store + join
    users.set(socket.id, { name, room });
    socket.join(room);

    // system join message
    io.to(room).emit("message", {
      type: "system",
      text: `${name} joined the conversation`,
      timestamp: Date.now(),
    });

    // send updated user list
    sendRoomUsers(room);
  });

  // text / file message
  socket.on("chat-message", (msg) => {
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
    };

    io.to(u.room).emit("message", message);
  });

  // typing indicator
  socket.on("typing", (isTyping) => {
    const u = users.get(socket.id);
    if (!u) return;
    socket.to(u.room).emit("typing", {
      user: u.name,
      isTyping,
    });
  });

  // message seen (read receipt)
  socket.on("seen-message", ({ messageId, senderId }) => {
    if (!messageId || !senderId) return;
    io.to(senderId).emit("message-seen", {
      messageId,
    });
  });

  // edit message
  socket.on("edit-message", ({ id, newText }) => {
    const u = users.get(socket.id);
    if (!u) return;
    io.to(u.room).emit("message-edited", { id, newText });
  });

  // delete message
  socket.on("delete-message", ({ id }) => {
    const u = users.get(socket.id);
    if (!u) return;
    io.to(u.room).emit("message-deleted", { id });
  });

  // disconnect
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

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});