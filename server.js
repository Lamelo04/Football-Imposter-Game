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
  voteRound: room.voteRound || 0,
  voteCount: room.phase === 'voting' || room.phase === 'revote' ? players(room).length : undefined,
  voteDeadline: room.phase === 'voting' || room.phase === 'revote' ? room.voteDeadline : undefined,
  voteCandidates: room.phase === 'revote' ? room.voteCandidates : undefined,
  tieVotes: room.phase === 'revote' ? room.tieVotes : undefined,
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
  const votedBy = room.result?.votedBy || [];
  const votedOut = room.result?.votedOut || null;
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
    imposterGuess: timedOut ? null : String(guess || '').trim(),
    wrongGuess: !correct,
    guessTimedOut: timedOut,
    gameOver,
    imposterWon,
    tie: false,
    votedBy,
    votedOut,
    eliminated: !correct ? caughtPlayer?.name : null,
    imposter: gameOver ? allPlayers(room).filter((player) => room.imposterRoster.includes(player.id)).map((player) => player.name) : null,
    footballer: gameOver ? room.footballer : null,
    remainingPlayers: players(room).length,
  };
  room.phase = 'result';
  sendRoom(room);
};
const beginVoting = (room, phase = 'voting', candidates = null, tieVotes = null) => {
  if (room.voteTimer) clearTimeout(room.voteTimer);
  room.phase = phase;
  room.voteCandidates = candidates;
  room.tieVotes = tieVotes;
  room.votes.clear();
  room.voteRound = (room.voteRound || 0) + 1;
  room.voteDeadline = phase === 'revote' ? null : Date.now() + 30_000;
  room.voteTimer = phase === 'revote' ? null : setTimeout(() => resolveVote(room, true), 30_000);
};
const resolveVote = (room, timedOut = false) => {
  if (!['voting', 'revote'].includes(room.phase)) return;
  if (room.voteTimer) clearTimeout(room.voteTimer);
  room.voteTimer = null;
  room.voteDeadline = null;
  const counts = new Map();
  for (const id of room.votes.values()) if (id) counts.set(id, (counts.get(id) || 0) + 1);
  if (!counts.size) {
    room.result = { noVotes: true, voteTimedOut: timedOut, tie: false, gameOver: false, footballer: null, remainingPlayers: players(room).length };
    room.phase = 'result';
    room.voteCandidates = null;
    room.tieVotes = null;
    sendRoom(room);
    return;
  }
  const max = Math.max(...counts.values());
  const top = [...counts].filter(([, count]) => count === max).map(([id]) => id);
  if (top.length > 1) {
    const tieVotes = top.map((id) => ({ name: room.players.get(id)?.name || 'Unknown player', voters: [...room.votes.entries()].filter(([, votedFor]) => votedFor === id).map(([voterId]) => room.players.get(voterId)?.name || 'Unknown player') }));
    beginVoting(room, 'revote', top, tieVotes);
    sendRoom(room);
    return;
  }
  const votedPlayer = room.players.get(top[0]);
  const votedBy = [...room.votes.entries()].filter(([, votedFor]) => votedFor === top[0]).map(([voterId]) => room.players.get(voterId)?.name || 'Unknown player');
  const caught = Boolean(votedPlayer && room.imposterIds.includes(votedPlayer.id));
  let eliminated = null;
  if (votedPlayer && !caught) {
    eliminated = votedPlayer.name;
    votedPlayer.eliminated = true;
    io.to(votedPlayer.id).emit('game:eliminated', { name: votedPlayer.name });
  }
  if (caught) {
    room.caughtImposterId = votedPlayer.id;
    room.result = { caught: true, tie: false, gameOver: false, guessPending: true, imposter: votedPlayer.name, votedOut: votedPlayer.name, votedBy, footballer: null, remainingPlayers: players(room).length };
    room.phase = 'guess';
    room.guessDeadline = Date.now() + 30_000;
    room.guessTimer = setTimeout(() => resolveImposterGuess(room, '', true), 30_000);
    io.to(room.caughtImposterId).emit('game:guess:ready');
  } else {
    const remainingImposters = room.imposterIds.length;
    const remainingCrew = players(room).filter((player) => !room.imposterIds.includes(player.id)).length;
    const gameOver = remainingImposters === 0 || remainingCrew <= remainingImposters;
    const imposterWon = gameOver && remainingImposters > 0 && remainingCrew <= remainingImposters;
    room.result = { caught: gameOver && !imposterWon, tie: false, gameOver, imposterWon, eliminated, votedOut: votedPlayer?.name || null, votedBy, imposter: gameOver ? allPlayers(room).filter((player) => room.imposterRoster.includes(player.id)).map((player) => player.name) : null, footballer: gameOver ? room.footballer : null, remainingPlayers: players(room).length };
    room.phase = 'result';
  }
  room.voteCandidates = null;
  room.tieVotes = null;
  sendRoom(room);
};
const advanceSpeaker = (room) => {
  if (room.phase !== 'hints') return;
  if (room.speakerTimer) clearTimeout(room.speakerTimer);
  room.speakerTimer = null;
  room.speakerDeadline = null;
  if (room.speakerIndex < room.speakingOrder.length - 1) {
    room.speakerIndex += 1;
    room.speakerDeadline = Date.now() + 20_000;
    room.speakerTimer = setTimeout(() => advanceSpeaker(room), 20_000);
  } else {
    beginVoting(room);
  }
  sendRoom(room);
};
const finishAfterPlayerDrop = (room) => {
  const remainingImposters = room.imposterIds.length;
  const remainingCrew = players(room).filter((player) => !room.imposterIds.includes(player.id)).length;
  if (remainingImposters > 0 && remainingCrew > remainingImposters) return false;
  if (room.guessTimer) clearTimeout(room.guessTimer);
  if (room.speakerTimer) clearTimeout(room.speakerTimer);
  if (room.voteTimer) clearTimeout(room.voteTimer);
  room.guessTimer = null;
  room.guessDeadline = null;
  room.speakerTimer = null;
  room.speakerDeadline = null;
  room.voteTimer = null;
  room.voteDeadline = null;
  room.phase = 'result';
  room.result = {
    caught: remainingImposters === 0,
    tie: false,
    gameOver: true,
    imposterWon: remainingImposters > 0,
    imposter: allPlayers(room).filter((player) => room.imposterRoster.includes(player.id)).map((player) => player.name),
    footballer: room.footballer,
    remainingPlayers: players(room).length,
  };
  sendRoom(room);
  return true;
};
const removePlayerFromRoom = (room, playerId) => {
  const player = room.players.get(playerId);
  if (!player || !player.connected) return false;
  player.connected = false;
  if (room.phase === 'lobby') {
    room.players.delete(playerId);
    if (room.hostId === playerId) room.hostId = players(room).find((candidate) => candidate.connected)?.id;
    sendRoom(room);
    return true;
  }

  player.eliminated = true;
  room.imposterIds = room.imposterIds.filter((id) => id !== playerId);
  room.votes.delete(playerId);
  for (const [voterId, targetId] of room.votes) if (targetId === playerId) room.votes.delete(voterId);
  if (room.hostId === playerId) room.hostId = players(room).find((candidate) => candidate.connected)?.id;

  if (room.phase === 'guess' && room.caughtImposterId === playerId) {
    resolveImposterGuess(room, '', true);
    return true;
  }
  if (room.phase === 'hints') {
    const orderIndex = room.speakingOrder.indexOf(playerId);
    if (orderIndex >= 0) {
      room.speakingOrder.splice(orderIndex, 1);
      if (orderIndex < room.speakerIndex) room.speakerIndex -= 1;
      else if (orderIndex === room.speakerIndex) {
        if (room.speakerTimer) clearTimeout(room.speakerTimer);
        if (room.speakerIndex >= room.speakingOrder.length) {
          room.speakerTimer = null;
          room.speakerDeadline = null;
          beginVoting(room);
        } else {
          room.speakerDeadline = Date.now() + 20_000;
          room.speakerTimer = setTimeout(() => advanceSpeaker(room), 20_000);
        }
      }
    }
  } else if (room.phase === 'voting' || room.phase === 'revote') {
    beginVoting(room);
  }
  if (finishAfterPlayerDrop(room)) return true;
  sendRoom(room);
  return true;
};
const startRound = (room, { newGame = false } = {}) => {
  if (room.guessTimer) clearTimeout(room.guessTimer);
  if (room.speakerTimer) clearTimeout(room.speakerTimer);
  if (room.voteTimer) clearTimeout(room.voteTimer);
  room.guessTimer = null;
  room.guessDeadline = null;
  room.speakerTimer = null;
  room.speakerDeadline = null;
  room.voteTimer = null;
  room.voteDeadline = null;
  room.phase = 'hints';
  room.votes.clear();
  room.result = null;
  room.voteCandidates = null;
  room.tieVotes = null;
  room.voteRound = 0;
  if (newGame || !room.footballer) {
    room.usedFootballers ||= [];
    let nextFootballers = FOOTBALLERS.filter((name) => !room.usedFootballers.includes(name));
    if (!nextFootballers.length) {
      room.usedFootballers = room.footballer ? [room.footballer] : [];
      nextFootballers = FOOTBALLERS.filter((name) => !room.usedFootballers.includes(name));
    }
    room.footballer = nextFootballers[randomInt(nextFootballers.length)];
    room.usedFootballers.push(room.footballer);
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
  room.speakerDeadline = Date.now() + 20_000;
  room.speakerTimer = setTimeout(() => advanceSpeaker(room), 20_000);
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
    const room = { code, phase: 'lobby', hostId: socket.id, players: new Map(), votes: new Map(), footballer: null, usedFootballers: [], result: null, speakingOrder: [], speakerIndex: 0, imposterIds: [], imposterRoster: [], imposterCount: 1, imposterCanStartFirst: false, voteRound: 0 };
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
    if (!room || room.phase !== 'hints' || (room.hostId !== socket.id && room.speakingOrder[room.speakerIndex] !== socket.id)) return;
    advanceSpeaker(room);
  });

  socket.on('game:vote', ({ targetId, abstain = false } = {}) => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || !['voting', 'revote'].includes(room.phase) || (room.voteDeadline && Date.now() >= room.voteDeadline) || room.players.get(socket.id)?.eliminated || room.votes.has(socket.id)) return;
    if (!abstain && (targetId === socket.id || room.players.get(targetId)?.eliminated || !room.players.has(targetId))) return;
    if (!abstain && room.phase === 'revote' && !room.voteCandidates?.includes(targetId)) return;
    room.votes.set(socket.id, abstain ? null : targetId);
    io.to(socket.id).emit('vote:confirmed');
    if (room.votes.size === players(room).length) resolveVote(room);
    else sendRoom(room);
  });

  socket.on('game:phase', ({ phase } = {}) => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.hostId !== socket.id) return;
    if (phase === 'voting' && room.phase === 'hints') {
      if (room.speakerTimer) clearTimeout(room.speakerTimer);
      room.speakerTimer = null;
      room.speakerDeadline = null;
      beginVoting(room);
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

  socket.on('game:kick', ({ targetId } = {}) => {
    const room = [...rooms.values()].find((candidate) => candidate.players.has(socket.id));
    if (!room || room.hostId !== socket.id || targetId === socket.id) return;
    if (!['lobby', 'hints', 'voting', 'revote', 'guess', 'result'].includes(room.phase)) return;
    const target = room.players.get(targetId);
    if (!target?.connected) return;
    io.to(targetId).emit('game:kicked', { name: target.name });
    const targetSocket = io.sockets.sockets.get(targetId);
    removePlayerFromRoom(room, targetId);
    targetSocket?.leave(room.code);
    targetSocket?.disconnect(true);
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      if (!room.players.has(socket.id)) continue;
      removePlayerFromRoom(room, socket.id);
      if (allPlayers(room).every((player) => !player.connected)) {
        if (room.guessTimer) clearTimeout(room.guessTimer);
        if (room.speakerTimer) clearTimeout(room.speakerTimer);
        rooms.delete(room.code);
      }
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
  'Lamine Yamal', 'Pedri', 'Gavi', 'Phil Foden', 'Cole Palmer', 'Declan Rice',
  'Martin Ødegaard', 'Florian Wirtz', 'Jamal Musiala', 'Lautaro Martínez', 'Julián Álvarez',
  'Trent Alexander-Arnold', 'Alisson Becker', 'Thibaut Courtois', 'Federico Valverde',
  'Nico Williams', 'Rúben Dias', 'João Neves', 'Vitinha', 'Ousmane Dembélé',
  'Rafael Leão', 'Victor Osimhen', 'Khvicha Kvaratskhelia', 'Alexander Isak',
  'Viktor Gyökeres', 'Dusan Vlahović', 'Darwin Núñez', 'Enzo Fernández',
  'Alexis Mac Allister', 'Bruno Fernandes', 'Bernardo Silva', 'Julián Draxler',
  'Franz Beckenbauer', 'Gerd Müller', 'Lothar Matthäus', 'Miroslav Klose',
  'Thomas Müller', 'Bastian Schweinsteiger', 'Toni Kroos', 'Philipp Lahm', 'Oliver Kahn',
  'Karl-Heinz Rummenigge', 'Michael Ballack', 'Jürgen Klinsmann', 'Andriy Shevchenko',
  'Lev Yashin', 'Dino Zoff', 'Gianluigi Buffon', 'Gianluigi Donnarumma', 'Fabio Cannavaro',
  'Alessandro Del Piero', 'Gianfranco Zola', 'Roberto Baggio', 'Gennaro Gattuso',
  'Daniele De Rossi', 'Giorgio Chiellini', 'Leonardo Bonucci', 'Filippo Inzaghi',
  'Johan Cruyff', 'Marco van Basten', 'Ruud Gullit', 'Dennis Bergkamp', 'Arjen Robben',
  'Robin van Persie', 'Wesley Sneijder', 'Clarence Seedorf', 'Edgar Davids',
  'Ruud van Nistelrooy', 'Patrick Kluivert', 'Frank Rijkaard', 'Rivaldo', 'Romário',
  'Zico', 'Sócrates', 'Garrincha', 'Cafu', 'Roberto Carlos', 'Dani Alves', 'Adriano',
  'Juninho Pernambucano', 'Jairzinho', 'Carlos Alberto Torres', 'Falcão', 'Rogério Ceni',
  'Enzo Francescoli', 'Gabriel Batistuta', 'Juan Román Riquelme', 'Ángel Di María',
  'Sergio Agüero', 'Carlos Tévez', 'Javier Mascherano', 'Hernán Crespo', 'Pablo Aimar',
  'George Weah', 'Samuel Eto’o', 'Yaya Touré', 'Didier Zokora', 'Jay-Jay Okocha',
  'Nwankwo Kanu', 'Abedi Pelé', 'Michael Essien', 'Roger Milla', 'Riyad Mahrez',
  'Achraf Hakimi', 'Hakim Ziyech', 'Mohamed Aboutrika', 'Hossam Hassan',
  'Park Ji-sung', 'Cha Bum-kun', 'Hidetoshi Nakata', 'Shinji Kagawa', 'Keisuke Honda',
  'Ali Daei', 'Tim Cahill', 'Clint Dempsey', 'Landon Donovan', 'Gianluca Vialli',
  'David Villa', 'Fernando Torres', 'Raúl González', 'Carles Puyol', 'Sergio Busquets',
  'Gerard Piqué', 'Cesc Fàbregas', 'David Silva', 'Fernando Hierro', 'Emilio Butragueño',
  'Xabi Alonso', 'Santi Cazorla', 'Luis Figo', 'Eusébio', 'Rui Costa', 'Deco',
  'Christian Vieri', 'David Trezeguet', 'Eric Cantona', 'Patrick Vieira', 'Raymond Kopa',
  'Ian Rush', 'Tony Adams', 'John Terry', 'Ashley Cole', 'Paul Gascoigne', 'Teddy Sheringham',
  'Alan Shearer', 'Gary Lineker', 'Peter Schmeichel', 'Michael Owen', 'Sol Campbell',
  'Jean-Pierre Papin', 'Enzo Scifo', 'Hristo Stoichkov', 'Davor Šuker'
];

server.listen(PORT, '0.0.0.0', () => console.log(`Football Undercover running on ${PORT}`));
