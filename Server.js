const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Room Management ───────────────────────────────────────────────────────────
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function createRoom(code) {
  const room = {
    code,
    chess: new Chess(),
    players: {},          // { socketId: { color, name, timeLeft, disconnected } }
    spectators: new Set(),
    moveHistory: [],
    capturedPieces: { w: [], b: [] },
    timers: { w: null, b: null },
    activeColor: 'w',
    status: 'waiting',    // waiting | playing | ended
    lastMoveTime: null,
    chat: [],
    pendingRematch: new Set(),
    drawOffer: null,
  };
  rooms.set(code, room);
  return room;
}

function getRoomPlayers(room) {
  return Object.values(room.players);
}

function getPlayerByColor(room, color) {
  return Object.values(room.players).find(p => p.color === color);
}

function clearTimers(room) {
  if (room.timers.w) clearInterval(room.timers.w);
  if (room.timers.b) clearInterval(room.timers.b);
  room.timers.w = null;
  room.timers.b = null;
}

function startTimer(room, color) {
  clearTimers(room);
  room.lastMoveTime = Date.now();
  room.activeColor = color;

  const tickInterval = setInterval(() => {
    const player = getPlayerByColor(room, color);
    if (!player || room.status !== 'playing') {
      clearInterval(tickInterval);
      return;
    }
    player.timeLeft = Math.max(0, player.timeLeft - 1);
    broadcastRoomState(room);

    if (player.timeLeft <= 0) {
      clearInterval(tickInterval);
      endGame(room, color === 'w' ? 'b' : 'w', 'timeout');
    }
  }, 1000);

  if (color === 'w') room.timers.w = tickInterval;
  else room.timers.b = tickInterval;
}

function broadcastRoomState(room) {
  const state = getRoomState(room);
  io.to(room.code).emit('room_state', state);
}

function getRoomState(room) {
  const players = {};
  for (const [sid, p] of Object.entries(room.players)) {
    players[sid] = {
      color: p.color,
      name: p.name,
      timeLeft: p.timeLeft,
      disconnected: p.disconnected || false,
    };
  }
  return {
    code: room.code,
    fen: room.chess.fen(),
    players,
    moveHistory: room.moveHistory,
    capturedPieces: room.capturedPieces,
    status: room.status,
    activeColor: room.chess.turn(),
    inCheck: room.chess.inCheck(),
    chat: room.chat.slice(-50),
    spectatorCount: room.spectators.size,
    drawOffer: room.drawOffer,
  };
}

function endGame(room, winnerColor, reason) {
  if (room.status === 'ended') return;
  clearTimers(room);
  room.status = 'ended';

  let result = {};
  if (reason === 'checkmate') {
    result = { type: 'checkmate', winner: winnerColor };
  } else if (reason === 'stalemate') {
    result = { type: 'stalemate', winner: null };
  } else if (reason === 'draw') {
    result = { type: 'draw', winner: null };
  } else if (reason === 'timeout') {
    result = { type: 'timeout', winner: winnerColor };
  } else if (reason === 'resign') {
    result = { type: 'resign', winner: winnerColor };
  } else if (reason === 'disconnect') {
    result = { type: 'disconnect', winner: winnerColor };
  } else {
    result = { type: reason, winner: winnerColor };
  }

  room.result = result;
  io.to(room.code).emit('game_over', result);
  broadcastRoomState(room);
}

// ─── Socket.IO Events ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerColor = null;

  // Create Room
  socket.on('create_room', ({ name }) => {
    const code = generateRoomCode();
    const room = createRoom(code);
    playerColor = 'w';
    currentRoom = room;

    room.players[socket.id] = {
      color: 'w',
      name: name || 'لاعب ١',
      timeLeft: 600,
      disconnected: false,
    };

    socket.join(code);
    socket.emit('room_created', { code, color: 'w' });
    broadcastRoomState(room);
  });

  // Join Room
  socket.on('join_room', ({ code, name }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) {
      socket.emit('error', { message: 'الغرفة غير موجودة' });
      return;
    }

    const existingPlayers = Object.values(room.players).filter(p => !p.disconnected);
    const disconnectedEntry = Object.entries(room.players).find(
      ([, p]) => p.disconnected && p.name === (name || '')
    );

    // Reconnect handling
    if (disconnectedEntry) {
      const [oldSid, oldPlayer] = disconnectedEntry;
      delete room.players[oldSid];
      room.players[socket.id] = { ...oldPlayer, disconnected: false };
      playerColor = oldPlayer.color;
      currentRoom = room;
      socket.join(code);
      socket.emit('reconnected', { code, color: playerColor });
      broadcastRoomState(room);
      return;
    }

    if (existingPlayers.length >= 2) {
      // Join as spectator
      room.spectators.add(socket.id);
      currentRoom = room;
      socket.join(code);
      socket.emit('joined_as_spectator', { code });
      broadcastRoomState(room);
      return;
    }

    playerColor = 'b';
    currentRoom = room;
    room.players[socket.id] = {
      color: 'b',
      name: name || 'لاعب ٢',
      timeLeft: 600,
      disconnected: false,
    };

    socket.join(code);
    socket.emit('room_joined', { code, color: 'b' });

    // Start game if both players present
    if (Object.keys(room.players).length === 2) {
      room.status = 'playing';
      io.to(code).emit('game_start', {
        white: getPlayerByColor(room, 'w')?.name,
        black: getPlayerByColor(room, 'b')?.name,
      });
      startTimer(room, 'w');
    }
    broadcastRoomState(room);
  });

  // Make Move
  socket.on('make_move', ({ move }) => {
    if (!currentRoom || currentRoom.status !== 'playing') return;
    const room = currentRoom;
    const player = room.players[socket.id];
    if (!player || player.color !== room.chess.turn()) return;

    let result;
    try {
      result = room.chess.move(move);
    } catch {
      socket.emit('invalid_move');
      return;
    }

    if (!result) {
      socket.emit('invalid_move');
      return;
    }

    // Track captures
    if (result.captured) {
      const capturedBy = result.color; // the one who moved
      room.capturedPieces[capturedBy].push(result.captured);
    }

    room.moveHistory.push({
      san: result.san,
      from: result.from,
      to: result.to,
      color: result.color,
      piece: result.piece,
      captured: result.captured || null,
      promotion: result.promotion || null,
      flags: result.flags,
    });

    // Check game end
    if (room.chess.isCheckmate()) {
      endGame(room, result.color, 'checkmate');
      broadcastRoomState(room);
      return;
    }
    if (room.chess.isStalemate() || room.chess.isDraw()) {
      const reason = room.chess.isStalemate() ? 'stalemate' : 'draw';
      endGame(room, null, reason);
      broadcastRoomState(room);
      return;
    }

    // Switch timer
    startTimer(room, room.chess.turn());
    broadcastRoomState(room);
  });

  // Chat
  socket.on('chat_message', ({ message }) => {
    if (!currentRoom || !message?.trim()) return;
    const room = currentRoom;
    const player = room.players[socket.id];
    const name = player?.name || 'متفرج';
    const msg = { name, message: message.trim().slice(0, 200), time: Date.now() };
    room.chat.push(msg);
    io.to(room.code).emit('chat_message', msg);
  });

  // Resign
  socket.on('resign', () => {
    if (!currentRoom || currentRoom.status !== 'playing') return;
    const room = currentRoom;
    const player = room.players[socket.id];
    if (!player) return;
    const winner = player.color === 'w' ? 'b' : 'w';
    endGame(room, winner, 'resign');
  });

  // Offer Draw
  socket.on('offer_draw', () => {
    if (!currentRoom || currentRoom.status !== 'playing') return;
    const room = currentRoom;
    const player = room.players[socket.id];
    if (!player) return;
    room.drawOffer = player.color;
    io.to(room.code).emit('draw_offered', { by: player.color, byName: player.name });
  });

  // Respond to Draw
  socket.on('respond_draw', ({ accept }) => {
    if (!currentRoom || currentRoom.status !== 'playing') return;
    const room = currentRoom;
    room.drawOffer = null;
    if (accept) {
      endGame(room, null, 'draw');
    } else {
      io.to(room.code).emit('draw_declined');
    }
  });

  // Rematch
  socket.on('request_rematch', () => {
    if (!currentRoom) return;
    const room = currentRoom;
    room.pendingRematch.add(socket.id);
    io.to(room.code).emit('rematch_requested', { count: room.pendingRematch.size });

    if (room.pendingRematch.size >= 2) {
      // Reset game
      room.chess = new Chess();
      room.moveHistory = [];
      room.capturedPieces = { w: [], b: [] };
      room.status = 'playing';
      room.pendingRematch.clear();
      room.result = null;
      room.drawOffer = null;
      room.chat = [];

      // Swap colors
      for (const p of Object.values(room.players)) {
        p.color = p.color === 'w' ? 'b' : 'w';
        p.timeLeft = 600;
      }

      io.to(room.code).emit('rematch_start', {
        players: Object.fromEntries(
          Object.entries(room.players).map(([sid, p]) => [sid, { color: p.color, name: p.name }])
        )
      });
      startTimer(room, 'w');
      broadcastRoomState(room);
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = currentRoom;

    if (room.spectators.has(socket.id)) {
      room.spectators.delete(socket.id);
      broadcastRoomState(room);
      return;
    }

    const player = room.players[socket.id];
    if (!player) return;

    player.disconnected = true;
    clearTimers(room);

    if (room.status === 'playing') {
      io.to(room.code).emit('player_disconnected', { color: player.color, name: player.name });

      // Give 30s to reconnect before forfeiting
      const timeout = setTimeout(() => {
        if (player.disconnected && room.status === 'playing') {
          const winner = player.color === 'w' ? 'b' : 'w';
          endGame(room, winner, 'disconnect');
        }
      }, 30000);
      player._reconnectTimeout = timeout;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n☽  Muslim Chess server running at http://localhost:${PORT}\n`);
});
  
