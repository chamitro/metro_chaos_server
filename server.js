// server.js - Metro Chaos Multiplayer Server
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files from root directory (not public/)
app.use(express.static(__dirname));

// Store active rooms
const rooms = new Map();
const players = new Map(); // Map WebSocket to player info

// Generate random 6-digit room code
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('New client connected');
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleMessage(ws, message);
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });
  
  ws.on('close', () => {
    handleDisconnect(ws);
  });
});

function handleMessage(ws, message) {
  const { type, payload } = message;
  
  switch (type) {
    case 'CREATE_ROOM':
      handleCreateRoom(ws, payload);
      break;
    case 'JOIN_ROOM':
      handleJoinRoom(ws, payload);
      break;
    case 'START_MATCH':
      handleStartMatch(ws, payload);
      break;
    case 'GAME_UPDATE':
      handleGameUpdate(ws, payload);
      break;
    case 'OVERLOAD_ATTACK':
      handleOverloadAttack(ws, payload);
      break;
    case 'LEAVE_ROOM':
      handleLeaveRoom(ws);
      break;
    default:
      console.log('Unknown message type:', type);
  }
}

function handleCreateRoom(ws, payload) {
  const roomCode = generateRoomCode();
  const { rules, playerName } = payload;
  
  const room = {
    code: roomCode,
    host: ws,
    opponent: null,
    rules: rules,
    hostName: playerName || 'Player 1',
    opponentName: null,
    gameStarted: false,
    startTime: Date.now()
  };
  
  rooms.set(roomCode, room);
  players.set(ws, { roomCode, isHost: true, name: room.hostName });
  
  // Send room code to host
  ws.send(JSON.stringify({
    type: 'ROOM_CREATED',
    payload: {
      roomCode,
      rules,
      playerName: room.hostName
    }
  }));
  
  console.log(`Room ${roomCode} created by ${room.hostName}`);
}

function handleJoinRoom(ws, payload) {
  const { roomCode, playerName } = payload;
  const room = rooms.get(roomCode);
  
  if (!room) {
    ws.send(JSON.stringify({
      type: 'ERROR',
      payload: { message: 'Room not found' }
    }));
    return;
  }
  
  if (room.opponent) {
    ws.send(JSON.stringify({
      type: 'ERROR',
      payload: { message: 'Room is full' }
    }));
    return;
  }
  
  // Add opponent to room
  room.opponent = ws;
  room.opponentName = playerName || 'Player 2';
  players.set(ws, { roomCode, isHost: false, name: room.opponentName });
  
  // Notify both players
  const matchFoundPayload = {
    roomCode,
    rules: room.rules,
    hostName: room.hostName,
    opponentName: room.opponentName
  };
  
  // Tell opponent they joined
  ws.send(JSON.stringify({
    type: 'MATCH_FOUND',
    payload: { ...matchFoundPayload, isHost: false }
  }));
  
  // Tell host opponent joined
  room.host.send(JSON.stringify({
    type: 'MATCH_FOUND',
    payload: { ...matchFoundPayload, isHost: true }
  }));
  
  console.log(`${room.opponentName} joined room ${roomCode}`);
}

function handleStartMatch(ws, payload) {
  const playerInfo = players.get(ws);
  if (!playerInfo || !playerInfo.isHost) {
    ws.send(JSON.stringify({
      type: 'ERROR',
      payload: { message: 'Only host can start match' }
    }));
    return;
  }
  
  const room = rooms.get(playerInfo.roomCode);
  if (!room || !room.opponent) {
    ws.send(JSON.stringify({
      type: 'ERROR',
      payload: { message: 'Waiting for opponent' }
    }));
    return;
  }
  
  room.gameStarted = true;
  room.startTime = Date.now();
  
  // Notify both players to start
  const startPayload = {
  startTime: room.startTime,
  rules: room.rules,
  seed: payload.seed  // ← ADD THIS ONE LINE
};
  
  room.host.send(JSON.stringify({
    type: 'MATCH_START',
    payload: startPayload
  }));
  
  room.opponent.send(JSON.stringify({
    type: 'MATCH_START',
    payload: startPayload
  }));
  
  console.log(`Match started in room ${playerInfo.roomCode}`);
}

function handleGameUpdate(ws, payload) {
  const playerInfo = players.get(ws);
  if (!playerInfo) return;
  
  const room = rooms.get(playerInfo.roomCode);
  if (!room || !room.gameStarted) return;
  
  // Forward game state to opponent
  const opponent = playerInfo.isHost ? room.opponent : room.host;
  if (opponent && opponent.readyState === WebSocket.OPEN) {
    opponent.send(JSON.stringify({
      type: 'OPPONENT_UPDATE',
      payload: payload
    }));
  }
}

function handleOverloadAttack(ws, payload) {
  const playerInfo = players.get(ws);
  if (!playerInfo) return;
  
  const room = rooms.get(playerInfo.roomCode);
  if (!room || !room.gameStarted) return;
  
  // Forward attack to opponent
  const opponent = playerInfo.isHost ? room.opponent : room.host;
  if (opponent && opponent.readyState === WebSocket.OPEN) {
    opponent.send(JSON.stringify({
      type: 'OVERLOAD_ATTACK',
      payload: payload
    }));
    
    console.log(`Overload attack sent from ${playerInfo.name} in room ${playerInfo.roomCode}`);
  }
}

function handleLeaveRoom(ws) {
  const playerInfo = players.get(ws);
  if (!playerInfo) return;
  
  const room = rooms.get(playerInfo.roomCode);
  if (!room) return;
  
  // Notify other player
  const opponent = playerInfo.isHost ? room.opponent : room.host;
  if (opponent && opponent.readyState === WebSocket.OPEN) {
    opponent.send(JSON.stringify({
      type: 'OPPONENT_LEFT',
      payload: { playerName: playerInfo.name }
    }));
  }
  
  // Clean up
  players.delete(ws);
  rooms.delete(playerInfo.roomCode);
  
  console.log(`Player left room ${playerInfo.roomCode}`);
}

function handleDisconnect(ws) {
  const playerInfo = players.get(ws);
  if (playerInfo) {
    handleLeaveRoom(ws);
  }
  console.log('Client disconnected');
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    rooms: rooms.size,
    players: players.size 
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Metro Chaos Server running on port ${PORT}`);
  console.log(`WebSocket server ready`);
});

// Clean up old rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  const ROOM_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  
  for (const [code, room] of rooms.entries()) {
    if (!room.gameStarted && room.startTime && now - room.startTime > ROOM_TIMEOUT) {
      rooms.delete(code);
      console.log(`Cleaned up inactive room ${code}`);
    }
  }
}, 5 * 60 * 1000);
