import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { randomInt } from 'node:crypto';

const app = express();
const server = createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.use(express.static('public'));
app.get('/health', (_req, res) => res.json({ ok: true }));

const allPlayers = (room) => [...room.players.values()];
const players = (room) => allPlayers(room).filter((player) => !player.eliminated);
const publicRoom = (room) => ({
  code: room.code,
  phase: room.phase,
  players: players(room).map(({ id, name, connected }) => ({ id, name, connected })),
  hostId: room.hostId,
  imposterCanStartFirst: room.imposterCanStartFirst,
  speakingOrder: room.speakingOrder || [],
  speakerIndex: room.speakerIndex ?? 0,
  votes: room.votes.size,
  voteCount: room.phase === 'voting' ? players(room).length : undefined,
  result: room.phase === 'result' || room.phase === 'guess'
    ? { ...room.result, footballer: room.phase === 'guess' ? null : room.result?.footballer }
    : undefined,
});
const sendRoom = (room) => io.to(room.code).emit('room:update', publicRoom(room));
const sendPrivateRole = (socket, room) => {
  const player = room.players.get(socket.id);
  if (player?.role) socket.emit('game:role', { role: player.role, footballer: room.footballer });
};
const makeCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join(''); }
  while (rooms.has(code));
  return code;
};
const cleanName = (name) => String(name || '').trim().replace(/[<>]/g, '').slice(0, 18);
const shuffled = (items) => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};
const startRound = (room, { newGame = false } = {}) => {
  room.phase = 'hints';
  room.votes.clear();
  room.result = null;
  if (newGame || !room.footballer) {
    const nextFootballers = FOOTBALLERS.filter((name) => name !== room.footballer);
    room.footballer = nextFootballers[randomInt(nextFootballers.length)];
  }
  if (newGame) {
    for (const player of allPlayers(room)) player.eliminated = !player.connected;
    room.imposterId = null;
  }
  if (!room.imposterId || !room.players.has(room.imposterId) || room.players.get(room.imposterId).eliminated) {
    room.imposterId = players(room)[randomInt(players(room).length)].id;
  }
  room.speakingOrder = shuffled(players(room).map((player) => player.id));
  if (!room.imposterCanStartFirst && room.speakingOrder[0] === room.imposterId) {
    const replacement = randomInt(1, room.speakingOrder.length);
    [room.speakingOrder[0], room.speakingOrder[replacement]] = [room.speakingOrder[replacement], room.speakingOrder[0]];
  }
  room.speakerIndex = 0;
  players(room).forEach((player) => {
    player.role = player.id === room.imposterId ? 'imposter' : 'player';
    io.to(player.id).emit('game:role', { role: player.role, footballer: player.role === 'player' ? room.footballer : null });
  });
};

io.on('connection', (socket) => {
  socket.on('room:create', ({ name } = {}, done = () => {}) => {
    const playerName = cleanName(name);
    if (!playerName) return done({ error: 'Enter your name first.' });
    const code = makeCode();
    const room = { code, phase: 'lobby', hostId: socket.id, players: new Map(), votes: new Map(), footballer: null, result: null, speakingOrder: [], speakerIndex: 0, imposterId: null, imposterCanStartFirst: false };
    room.players.set(socket.id, { id: socket.id, name: playerName, connected: true, eliminated: false });
    rooms.set(code, room);
    socket.join(code);
    done({ code, playerId: socket.id });
    sendRoom(room);
  });

  socket.on('room:join', ({ code, name } = {}, done = () => {}) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    const playerName = cleanName(name);
    if (!playerName) return done({ error: 'Enter your name first.' });
    if (!room) return done({ error: 'That room code wasn’t found.' });
    if (room.phase !== 'lobby') return done({ error: 'This game has already started.' });
    if (players(room).length >= 16) return done({ error: 'This room is full (16 players max).' });
    if (players(room).some((p) => p.name.toLowerCase() === playerName.toLowerCase())) return done({ error: 'That name is already taken in this room.' });
    room.players.set(socket.id, { id: socket.id, name: playerName, connected: true, eliminated: false });
    socket.join(room.code);
    done({ code: room.code, playerId: socket.id });
    sendRoom(room);
  });

  socket.on('game:settings', ({ imposterCanStartFirst } = {}) => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    room.imposterCanStartFirst = Boolean(imposterCanStartFirst);
    sendRoom(room);
  });

  socket.on('game:start', () => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    if (players(room).length < 3) return socket.emit('game:error', 'You need at least 3 players to start.');
    startRound(room, { newGame: true });
    sendRoom(room);
  });

  socket.on('game:next-speaker', () => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.hostId !== socket.id || room.phase !== 'hints') return;
    if (room.speakerIndex < room.speakingOrder.length - 1) {
      room.speakerIndex += 1;
      sendRoom(room);
    }
  });

  socket.on('game:vote', ({ targetId } = {}) => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.phase !== 'voting' || room.players.get(socket.id)?.eliminated || targetId === socket.id || room.players.get(targetId)?.eliminated || !room.players.has(targetId) || room.votes.has(socket.id)) return;
    room.votes.set(socket.id, targetId);
    io.to(socket.id).emit('vote:confirmed');
    if (room.votes.size === players(room).length) {
      const counts = new Map();
      for (const id of room.votes.values()) counts.set(id, (counts.get(id) || 0) + 1);
      const max = Math.max(...counts.values());
      const top = [...counts].filter(([, count]) => count === max).map(([id]) => id);
      const tie = top.length > 1;
      const votedPlayer = top.length === 1 ? room.players.get(top[0]) : null;
      const caught = votedPlayer?.id === room.imposterId;
      let eliminated = null;
      if (votedPlayer && !caught) {
        eliminated = votedPlayer.name;
        votedPlayer.eliminated = true;
        io.to(votedPlayer.id).emit('game:eliminated', { name: votedPlayer.name });
      }
      if (caught) {
        room.result = {
          caught: true,
          tie: false,
          gameOver: false,
          guessPending: true,
          imposter: votedPlayer.name,
          footballer: null,
          remainingPlayers: players(room).length,
        };
        room.phase = 'guess';
      } else {
        const gameOver = !tie && players(room).length === 2;
        room.result = {
          caught: false,
          tie,
          gameOver,
          imposterWon: gameOver,
          eliminated,
          votedOut: votedPlayer?.name || null,
          imposter: gameOver ? players(room).find((player) => player.id === room.imposterId)?.name : null,
          footballer: room.footballer,
          remainingPlayers: players(room).length,
        };
        room.phase = 'result';
      }
    }
    sendRoom(room);
  });

  socket.on('game:phase', ({ phase } = {}) => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.hostId !== socket.id) return;
    if (phase === 'voting' && room.phase === 'hints' && room.speakerIndex === room.speakingOrder.length - 1) { room.phase = 'voting'; room.votes.clear(); sendRoom(room); }
    if (phase === 'hints' && room.phase === 'result' && !room.result?.gameOver && players(room).length > 2) {
      startRound(room);
      sendRoom(room);
    }
  });

  socket.on('game:guess', ({ footballer } = {}) => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.phase !== 'guess' || socket.id !== room.imposterId) return;
    const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const correct = normalize(footballer) === normalize(room.footballer);
    room.result = {
      caught: !correct,
      guessCorrect: correct,
      gameOver: true,
      imposterWon: correct,
      tie: false,
      imposter: room.players.get(room.imposterId)?.name,
      footballer: room.footballer,
      remainingPlayers: players(room).length,
    };
    room.phase = 'result';
    sendRoom(room);
  });

  socket.on('game:new', () => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.hostId !== socket.id || room.phase !== 'result' || !room.result?.gameOver) return;
    for (const player of allPlayers(room)) player.eliminated = !player.connected;
    if (players(room).length < 3) return socket.emit('game:error', 'At least 3 players need to be connected to start a new game.');
    startRound(room, { newGame: true });
    sendRoom(room);
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = room.players.get(socket.id);
      if (!player) continue;
      player.connected = false;
      if (room.phase === 'lobby') room.players.delete(socket.id);
      if (room.hostId === socket.id && room.phase === 'lobby') room.hostId = players(room)[0]?.id;
      sendRoom(room);
      if (players(room).length === 0) rooms.delete(room.code);
      break;
    }
  });
});

const FOOTBALLERS = [
  'Lionel Messi', 'Cristiano Ronaldo', 'Kylian Mbappé', 'Erling Haaland', 'Jude Bellingham',
  'Neymar Jr', 'Mohamed Salah', 'Kevin De Bruyne', 'Luka Modrić', 'Zinedine Zidane',
  'Ronaldinho', 'Pelé', 'Diego Maradona', 'Thierry Henry', 'Andrés Iniesta',
  'Xavi', 'Ronaldo Nazário', 'David Beckham', 'Sadio Mané', 'Vinícius Júnior',
  'Robert Lewandowski', 'Sergio Ramos', 'Wayne Rooney', 'Didier Drogba', 'Andrea Pirlo',
  'Francesco Totti', 'Gareth Bale', 'Luis Suárez', 'Harry Kane', 'Bukayo Saka',
  'Zlatan Ibrahimović', 'Kaká', 'George Best', 'Paolo Maldini', 'Iker Casillas',
  'Manuel Neuer', 'Virgil van Dijk', 'Rodri', 'Antoine Griezmann', 'Son Heung-min',
];

server.listen(PORT, '0.0.0.0', () => console.log(`Football Undercover running on ${PORT}`));
