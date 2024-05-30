const express = require("express");
const app = express();
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");
const ACTIONS = require("./src/Actions");

const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("build"));
app.use((req, res, next) => {
  res.sendFile(path.join(__dirname, "build", "index.html"));
});

const userSocketMap = {};
const recentEditors = {}; // Store recent editors per room

// const uri = 'mongodb://localhost:27017';
const uri = "mongodb://127.0.0.1:27017";

const client = new MongoClient(uri);

async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");
    const database = client.db("Collab");
    const collection = database.collection("Users");
    await collection.createIndex({ username: 1 }, { unique: true });
  } catch (err) {
    console.error("Error connecting to MongoDB", err);
  }
}

connectToMongoDB();

function getAllConnectedClients(roomId) {
  return Array.from(io.sockets.adapter.rooms.get(roomId) || []).map(
    (socketId) => {
      return {
        socketId,
        username: userSocketMap[socketId],
      };
    }
  );
}

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  socket.on(ACTIONS.JOIN, async ({ roomId, username }) => {
    userSocketMap[socket.id] = username;
    socket.join(roomId);
    const clients = getAllConnectedClients(roomId);
    clients.forEach(({ socketId }) => {
      io.to(socketId).emit(ACTIONS.JOINED, {
        clients,
        username,
        socketId: socket.id,
      });
    });

    if (!recentEditors[roomId]) {
      recentEditors[roomId] = [];
    }

    const collection = client.db("Collab").collection("Users");
    try {
      await collection.insertOne({ username, roomId });
      console.log("User details stored in MongoDB");
    } catch (err) {
      console.error("Error storing user details in MongoDB", err);
    }
  });

  socket.on(ACTIONS.CODE_CHANGE, ({ roomId, code }) => {
    const username = userSocketMap[socket.id];
    const timestamp = new Date();

    // Update recent editors list for the specific room
    recentEditors[roomId] = recentEditors[roomId].filter(
      (editor) => editor.socketId !== socket.id
    );
    recentEditors[roomId].push({ socketId: socket.id, username, timestamp });

    // Emit the updated recent editors list to all clients in the room
    io.in(roomId).emit("recent-editors-update", recentEditors[roomId]);

    socket.in(roomId).emit(ACTIONS.CODE_CHANGE, { code });
  });

  socket.on(ACTIONS.SYNC_CODE, ({ socketId, code }) => {
    io.to(socketId).emit(ACTIONS.CODE_CHANGE, { code });
  });

  socket.on("disconnecting", () => {
    const rooms = [...socket.rooms];
    rooms.forEach((roomId) => {
      socket.in(roomId).emit(ACTIONS.DISCONNECTED, {
        socketId: socket.id,
        username: userSocketMap[socket.id],
      });
    });
    delete userSocketMap[socket.id];
    socket.leave();
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
