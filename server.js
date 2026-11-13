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

const players = (room) => [...room.players.values()];
const publicRoom = (room) => ({
  code: room.code,
  phase: room.phase,
  players: players(room).map(({ id, name, connected }) => ({ id, name, connected })),
  hostId: room.hostId,
  votes: room.votes.size,
  voteCount: room.phase === 'voting' ? players(room).length : undefined,
  result: room.phase === 'result' ? room.result : undefined,
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

io.on('connection', (socket) => {
  socket.on('room:create', ({ name } = {}, done = () => {}) => {
    const playerName = cleanName(name);
    if (!playerName) return done({ error: 'Enter your name first.' });
    const code = makeCode();
    const room = { code, phase: 'lobby', hostId: socket.id, players: new Map(), votes: new Map(), footballer: null, result: null };
    room.players.set(socket.id, { id: socket.id, name: playerName, connected: true });
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
    room.players.set(socket.id, { id: socket.id, name: playerName, connected: true });
    socket.join(room.code);
    done({ code: room.code, playerId: socket.id });
    sendRoom(room);
  });

  socket.on('game:start', () => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    if (players(room).length < 3) return socket.emit('game:error', 'You need at least 3 players to start.');
    const names = FOOTBALLERS;
    room.footballer = names[randomInt(names.length)];
    room.votes.clear();
    room.result = null;
    const impostorIndex = randomInt(players(room).length);
    players(room).forEach((player, index) => {
      player.role = index === impostorIndex ? 'imposter' : 'player';
      io.to(player.id).emit('game:role', { role: player.role, footballer: player.role === 'player' ? room.footballer : null });
    });
    room.phase = 'hints';
    sendRoom(room);
  });

  socket.on('game:vote', ({ targetId } = {}) => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.phase !== 'voting' || targetId === socket.id || !room.players.has(targetId) || room.votes.has(socket.id)) return;
    room.votes.set(socket.id, targetId);
    io.to(socket.id).emit('vote:confirmed');
    if (room.votes.size === players(room).length) {
      const counts = new Map();
      for (const id of room.votes.values()) counts.set(id, (counts.get(id) || 0) + 1);
      const max = Math.max(...counts.values());
      const top = [...counts].filter(([, count]) => count === max).map(([id]) => id);
      const caught = top.length === 1 && room.players.get(top[0])?.role === 'imposter';
      room.result = {
        caught,
        tie: top.length > 1,
        votedOut: top.length === 1 ? room.players.get(top[0])?.name : null,
        imposter: players(room).find((player) => player.role === 'imposter')?.name,
        footballer: room.footballer,
      };
      room.phase = 'result';
    }
    sendRoom(room);
  });

  socket.on('game:phase', ({ phase } = {}) => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.hostId !== socket.id) return;
    if (phase === 'voting' && room.phase === 'hints') { room.phase = 'voting'; room.votes.clear(); sendRoom(room); }
    if (phase === 'hints' && room.phase === 'result') {
      room.phase = 'hints'; room.votes.clear(); room.result = null;
      const impostorIndex = randomInt(players(room).length);
      players(room).forEach((player, index) => {
        player.role = index === impostorIndex ? 'imposter' : 'player';
        io.to(player.id).emit('game:role', { role: player.role, footballer: player.role === 'player' ? room.footballer : null });
      });
      sendRoom(room);
    }
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
