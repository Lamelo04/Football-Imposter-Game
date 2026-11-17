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
  imposterCount: room.imposterCount,
  speakingOrder: room.speakingOrder || [],
  speakerIndex: room.speakerIndex ?? 0,
  votes: room.votes.size,
  voteCount: room.phase === 'voting' ? players(room).length : undefined,
  speakerDeadline: room.phase === 'hints' ? room.speakerDeadline : undefined,
  result: room.phase === 'result' || room.phase === 'guess'
    ? { ...room.result, footballer: room.result?.gameOver ? room.result.footballer : null }
    : undefined,
  guessDeadline: room.phase === 'guess' ? room.guessDeadline : undefined,
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
const resolveImposterGuess = (room, guess, timedOut = false) => {
  if (room.phase !== 'guess') return;
  if (room.guessTimer) clearTimeout(room.guessTimer);
  room.guessTimer = null;
  room.guessDeadline = null;
  const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const correct = !timedOut && normalize(guess) === normalize(room.footballer);
  const caughtPlayer = room.players.get(room.caughtImposterId);
  if (!correct && caughtPlayer) {
    caughtPlayer.eliminated = true;
    room.imposterIds = room.imposterIds.filter((id) => id !== room.caughtImposterId);
    io.to(caughtPlayer.id).emit('game:eliminated', { name: caughtPlayer.name });
  }
  const remainingImposters = room.imposterIds.length;
  const remainingCrew = players(room).filter((player) => !room.imposterIds.includes(player.id)).length;
  const gameOver = correct || remainingImposters === 0 || remainingCrew <= remainingImposters;
  const imposterWon = correct || (remainingImposters > 0 && remainingCrew <= remainingImposters);
  room.result = {
    caught: gameOver && !imposterWon,
    guessCorrect: correct,
    wrongGuess: !correct,
    guessTimedOut: timedOut,
    gameOver,
    imposterWon,
    tie: false,
    eliminated: !correct ? caughtPlayer?.name : null,
    imposter: gameOver ? allPlayers(room).filter((player) => room.imposterRoster.includes(player.id)).map((player) => player.name) : null,
    footballer: gameOver ? room.footballer : null,
    remainingPlayers: players(room).length,
  };
  room.phase = 'result';
  sendRoom(room);
};
const advanceSpeaker = (room) => {
  if (room.phase !== 'hints') return;
  if (room.speakerTimer) clearTimeout(room.speakerTimer);
  room.speakerTimer = null;
  room.speakerDeadline = null;
  if (room.speakerIndex < room.speakingOrder.length - 1) {
    room.speakerIndex += 1;
    room.speakerDeadline = Date.now() + 15_000;
    room.speakerTimer = setTimeout(() => advanceSpeaker(room), 15_000);
  } else {
    room.phase = 'voting';
    room.votes.clear();
  }
  sendRoom(room);
};
const startRound = (room, { newGame = false } = {}) => {
  if (room.guessTimer) clearTimeout(room.guessTimer);
  if (room.speakerTimer) clearTimeout(room.speakerTimer);
  room.guessTimer = null;
  room.guessDeadline = null;
  room.speakerTimer = null;
  room.speakerDeadline = null;
  room.phase = 'hints';
  room.votes.clear();
  room.result = null;
  if (newGame || !room.footballer) {
    const nextFootballers = FOOTBALLERS.filter((name) => name !== room.footballer);
    room.footballer = nextFootballers[randomInt(nextFootballers.length)];
  }
  if (newGame) {
    for (const player of allPlayers(room)) player.eliminated = !player.connected;
    const activePlayers = players(room);
    const maxImposters = Math.max(1, Math.min(4, Math.floor(activePlayers.length / 2)));
    const count = Math.max(1, Math.min(room.imposterCount, maxImposters));
    room.imposterCount = count;
    room.imposterIds = shuffled(activePlayers.map((player) => player.id)).slice(0, count);
    room.imposterRoster = [...room.imposterIds];
  }
  room.imposterIds = (room.imposterIds || []).filter((id) => room.players.has(id) && !room.players.get(id).eliminated);
  room.speakingOrder = shuffled(players(room).map((player) => player.id));
  if (!room.imposterCanStartFirst && room.imposterIds.includes(room.speakingOrder[0])) {
    const replacement = room.speakingOrder.findIndex((id, index) => index > 0 && !room.imposterIds.includes(id));
    if (replacement > 0) [room.speakingOrder[0], room.speakingOrder[replacement]] = [room.speakingOrder[replacement], room.speakingOrder[0]];
  }
  room.speakerIndex = 0;
  room.speakerDeadline = Date.now() + 15_000;
  room.speakerTimer = setTimeout(() => advanceSpeaker(room), 15_000);
  players(room).forEach((player) => {
    player.role = room.imposterIds.includes(player.id) ? 'imposter' : 'player';
    io.to(player.id).emit('game:role', { role: player.role, footballer: player.role === 'player' ? room.footballer : null });
  });
};

io.on('connection', (socket) => {
  socket.on('room:create', ({ name } = {}, done = () => {}) => {
    const playerName = cleanName(name);
    if (!playerName) return done({ error: 'Enter your name first.' });
    const code = makeCode();
    const room = { code, phase: 'lobby', hostId: socket.id, players: new Map(), votes: new Map(), footballer: null, result: null, speakingOrder: [], speakerIndex: 0, imposterIds: [], imposterRoster: [], imposterCount: 1, imposterCanStartFirst: false };
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

  socket.on('game:settings', ({ imposterCanStartFirst, imposterCount } = {}) => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    if (imposterCanStartFirst !== undefined) room.imposterCanStartFirst = Boolean(imposterCanStartFirst);
    if (imposterCount !== undefined) {
      const maxImposters = Math.max(1, Math.min(4, Math.floor(players(room).length / 2)));
      room.imposterCount = Math.max(1, Math.min(maxImposters, Math.floor(Number(imposterCount) || 1)));
    }
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
    advanceSpeaker(room);
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
      const tieVotes = tie ? top.map((id) => ({
        name: room.players.get(id)?.name || 'Unknown player',
        voters: [...room.votes.entries()]
          .filter(([, votedFor]) => votedFor === id)
          .map(([voterId]) => room.players.get(voterId)?.name || 'Unknown player'),
      })) : null;
      const votedPlayer = top.length === 1 ? room.players.get(top[0]) : null;
      const caught = Boolean(votedPlayer && room.imposterIds.includes(votedPlayer.id));
      let eliminated = null;
      if (votedPlayer && !caught) {
        eliminated = votedPlayer.name;
        votedPlayer.eliminated = true;
        io.to(votedPlayer.id).emit('game:eliminated', { name: votedPlayer.name });
      }
      if (caught) {
        room.caughtImposterId = votedPlayer.id;
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
        room.guessDeadline = Date.now() + 30_000;
        room.guessTimer = setTimeout(() => resolveImposterGuess(room, '', true), 30_000);
        io.to(room.caughtImposterId).emit('game:guess:ready');
      } else {
        const remainingImposters = room.imposterIds.length;
        const remainingCrew = players(room).filter((player) => !room.imposterIds.includes(player.id)).length;
        const gameOver = remainingImposters === 0 || (!tie && remainingCrew <= remainingImposters);
        const imposterWon = gameOver && remainingImposters > 0 && remainingCrew <= remainingImposters;
        room.result = {
          caught: gameOver && !imposterWon,
          tie,
          tieVotes,
          gameOver,
          imposterWon,
          eliminated,
          votedOut: votedPlayer?.name || null,
          imposter: gameOver ? allPlayers(room).filter((player) => room.imposterRoster.includes(player.id)).map((player) => player.name) : null,
          footballer: gameOver ? room.footballer : null,
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
    if (phase === 'voting' && room.phase === 'hints') {
      if (room.speakerTimer) clearTimeout(room.speakerTimer);
      room.speakerTimer = null;
      room.speakerDeadline = null;
      room.phase = 'voting';
      room.votes.clear();
      sendRoom(room);
    }
    if (phase === 'hints' && room.phase === 'result' && !room.result?.gameOver && players(room).length > 2) {
      startRound(room);
      sendRoom(room);
    }
  });

  socket.on('game:guess', ({ footballer } = {}) => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.phase !== 'guess' || socket.id !== room.caughtImposterId) return;
    if (Date.now() >= room.guessDeadline) return resolveImposterGuess(room, '', true);
    resolveImposterGuess(room, footballer);
  });

  socket.on('game:new', (_payload = {}, done = () => {}) => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.hostId !== socket.id || room.phase !== 'result' || !room.result?.gameOver) return done({ error: 'Only the room owner can start a new game after the final result.' });
    if (room.guessTimer) clearTimeout(room.guessTimer);
    if (room.speakerTimer) clearTimeout(room.speakerTimer);
    room.guessTimer = null;
    room.guessDeadline = null;
    room.speakerTimer = null;
    room.speakerDeadline = null;
    room.phase = 'lobby';
    room.result = null;
    room.footballer = null;
    room.imposterIds = [];
    room.imposterRoster = [];
    room.caughtImposterId = null;
    room.speakingOrder = [];
    room.speakerIndex = 0;
    room.votes.clear();
    for (const player of allPlayers(room)) {
      player.eliminated = !player.connected;
      player.role = undefined;
    }
    sendRoom(room);
    done({ ok: true, phase: 'lobby' });
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
