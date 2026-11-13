const socket = io();
const welcome = document.querySelector('#welcome');
const roomView = document.querySelector('#room');
const toast = document.querySelector('#toast');
let me = null;
let roomState = null;
let roleInfo = null;
let voteConfirmed = false;
let selectedVote = null;
let toastTimer;

function notify(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}
function buttonBusy(button, busy) { button.disabled = busy; button.style.opacity = busy ? '.65' : ''; }
function createRoom() {
  const button = document.querySelector('#create-btn');
  buttonBusy(button, true);
  socket.emit('room:create', { name: document.querySelector('#host-name').value }, (response) => {
    buttonBusy(button, false);
    if (response?.error) return notify(response.error);
    me = response.playerId;
    sessionStorage.setItem('offside-room', response.code);
    sessionStorage.setItem('offside-name', document.querySelector('#host-name').value.trim());
    showRoom(response.code);
  });
}
function joinRoom() {
  const button = document.querySelector('#join-btn');
  buttonBusy(button, true);
  socket.emit('room:join', { code: document.querySelector('#room-code').value, name: document.querySelector('#join-name').value }, (response) => {
    buttonBusy(button, false);
    if (response?.error) return notify(response.error);
    me = response.playerId;
    sessionStorage.setItem('offside-room', response.code);
    sessionStorage.setItem('offside-name', document.querySelector('#join-name').value.trim());
    showRoom(response.code);
  });
}
function showRoom(code) {
  welcome.classList.add('hidden');
  roomView.classList.remove('hidden');
  roomView.innerHTML = '<div class="room-head"><div><div class="room-kicker">YOUR MATCH IS READY</div><h1 class="room-title">The <span class="accent">huddle.</span></h1><div class="room-sub">Invite your friends to join the room.</div></div><div class="room-code-box" id="copy-code"><small>TAP TO COPY CODE</small><strong>' + escapeHtml(code) + '</strong></div></div><div id="room-content"></div>';
  document.querySelector('#copy-code').onclick = async () => {
    try { await navigator.clipboard.writeText(code); notify('Room code copied.'); }
    catch { notify('Your room code is ' + code); }
  };
  renderRoom();
}
function escapeHtml(str) { return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function renderRoom() {
  if (!roomState || !document.querySelector('#room-content')) return;
  const host = roomState.hostId === me;
  const myName = roomState.players.find((p) => p.id === me)?.name;
  const phaseLabel = { lobby: 'WAITING ROOM', hints: 'GIVE A HINT', voting: 'TIME TO VOTE', result: 'FULL TIME' }[roomState.phase];
  let main;
  if (roomState.phase === 'lobby') {
    main = '<div class="game-grid"><div class="game-panel"><div class="panel-top"><span>PLAYERS IN THE HUDDLE</span><span class="badge">' + roomState.players.length + ' / 16</span></div><div class="player-list">' + roomState.players.map((p) => '<div class="player-row"><span class="player-avatar">' + escapeHtml(p.name.slice(0, 1).toUpperCase()) + '</span>' + escapeHtml(p.name) + (p.id === me ? '<span class="you">YOU</span>' : '') + (p.id === roomState.hostId ? '<span class="host-tag">HOST</span>' : '') + '</div>').join('') + '</div><div class="wait-note">' + (host ? 'Everyone here? Kick things off when the squad is ready.' : 'You’re in. Keep this page open while the host gets everyone ready.') + '</div>' + (host ? '<button class="button button-primary" id="start-game">Start the game <span>↗</span></button>' : '') + '</div><aside class="side-panel"><div class="panel-top"><span>HOW TO PLAY</span><span>01 / 03</span></div><h3 class="phase-title">Keep your clues close.</h3><p class="side-copy">Everyone gets a famous footballer. One player is the imposter and has to bluff their way through the round.</p><div class="step active"><b>1</b> GET YOUR SECRET PLAYER</div><div class="step"><b>2</b> GIVE A CLUE, TAKE TURNS</div><div class="step"><b>3</b> VOTE OUT THE IMPOSTER</div></aside></div>';
  } else if (roomState.phase === 'hints') {
    const revealText = roleInfo ? (roleInfo.role === 'imposter' ? 'YOU’RE THE IMPOSTER' : 'YOUR FOOTBALLER') : 'YOUR ROLE IS LOADING';
    main = '<div class="game-grid"><div class="game-panel"><div class="panel-top"><span>ROUND IN PROGRESS</span><span class="badge">HINTS</span></div><div class="role-card ' + (roleInfo?.role === 'imposter' ? 'imposter' : '') + '"><div class="role-label">' + revealText + '</div><div class="role-word ' + (roleInfo ? '' : 'role-blur') + '">' + (roleInfo?.role === 'imposter' ? 'Imposter' : roleInfo?.footballer ? escapeHtml(roleInfo.footballer) : 'Footballer') + '</div><div class="role-hint">' + (roleInfo?.role === 'imposter' ? 'Blend in. Listen to the clues and don’t get caught.' : 'Give one short clue on your turn. Keep it subtle enough to avoid helping the imposter.') + '</div></div><div class="player-list">' + roomState.players.map((p) => '<div class="player-row"><span class="player-avatar">' + escapeHtml(p.name.slice(0, 1).toUpperCase()) + '</span>' + escapeHtml(p.name) + (p.id === me ? '<span class="you">YOU</span>' : '') + '</div>').join('') + '</div>' + (host ? '<button class="button button-primary" id="open-vote">Done with clues — vote <span>→</span></button>' : '<div class="wait-note">Take turns saying one clue out loud. The host will open voting when you’re done.</div>') + '</div><aside class="side-panel"><div class="panel-top"><span>THE RULES</span><span>02 / 03</span></div><h3 class="phase-title">One clue each.</h3><p class="side-copy">Say it out loud in a circle. No names, initials, or phone peeking. The imposter’s goal is to sound like they know the player.</p><div class="step"><b>1</b> GET YOUR SECRET PLAYER</div><div class="step active"><b>2</b> GIVE A CLUE, TAKE TURNS</div><div class="step"><b>3</b> VOTE OUT THE IMPOSTER</div></aside></div>';
  } else if (roomState.phase === 'voting') {
    main = '<div class="game-grid"><div class="game-panel"><div class="panel-top"><span>WHO’S THE IMPOSTER?</span><span class="badge">' + roomState.votes + ' / ' + roomState.voteCount + ' VOTES</span></div><h3 class="phase-title">Lock in your vote.</h3><p class="side-copy">Pick the player whose clues felt a little too suspicious.</p><div class="voter-list">' + roomState.players.map((p) => '<button class="vote-button ' + (selectedVote === p.id ? 'selected' : '') + '" data-vote="' + escapeHtml(p.id) + '" ' + (p.id === me || voteConfirmed ? 'disabled' : '') + '><span class="player-avatar">' + escapeHtml(p.name.slice(0, 1).toUpperCase()) + '</span>' + escapeHtml(p.name) + (selectedVote === p.id ? '<span class="arrow">✓</span>' : '') + '</button>').join('') + '</div>' + (voteConfirmed ? '<div class="wait-note">Vote locked. Waiting for the rest of the squad…</div>' : selectedVote ? '<button class="button button-primary" id="confirm-vote">Lock my vote <span>↗</span></button>' : '') + '</div><aside class="side-panel"><div class="panel-top"><span>LAST CALL</span><span>03 / 03</span></div><h3 class="phase-title">Trust your gut.</h3><p class="side-copy">The vote is private. Once everybody has picked, the imposter is revealed.</p></aside></div>';
  } else {
    const result = roomState.result || {};
    const headline = result.caught ? 'Caught offside.' : 'They got away.';
    main = '<div class="game-grid"><div class="game-panel"><div class="panel-top"><span>THE VERDICT</span><span class="badge">FULL TIME</span></div><div class="result"><div class="role-label">' + (result.tie ? 'IT’S A TIE' : result.caught ? 'THE GROUP GOT IT RIGHT' : 'THE IMPOSTER SURVIVES') + '</div><h3>' + headline + '</h3><p class="side-copy">' + (result.tie ? 'No one was voted out. The squad couldn’t agree.' : 'The group voted for ' + escapeHtml(result.votedOut || 'nobody') + '.') + '</p><div class="role-label">THE IMPOSTER WAS</div><div class="result-name">' + escapeHtml(result.imposter || 'Unknown') + '</div><div class="role-label" style="margin-top:18px">THE FOOTBALLER WAS</div><div class="result-name">' + escapeHtml(result.footballer || 'Unknown') + '</div></div>' + (host ? '<button class="button button-primary" id="next-round">Play another round <span>↗</span></button>' : '<div class="wait-note">The host can start another round when you’re ready.</div>') + '</div><aside class="side-panel"><div class="panel-top"><span>FINAL VOTE</span></div><h3 class="phase-title">' + (result.caught ? 'Nice read, squad.' : 'Better luck next round.') + '</h3><p class="side-copy">Pass the phone around and see who can keep their cool next time.</p></aside></div>';
  }
  if (roomState.phase === 'hints') {
    const order = roomState.speakingOrder || [];
    const activeId = order[roomState.speakerIndex];
    const activePlayer = roomState.players.find((p) => p.id === activeId);
    const isMyTurn = activeId === me;
    const isLastSpeaker = roomState.speakerIndex === order.length - 1;
    const orderRows = order.map((id, index) => {
      const player = roomState.players.find((p) => p.id === id);
      if (!player) return '';
      const status = index < roomState.speakerIndex ? 'DONE' : index === roomState.speakerIndex ? 'SPEAKING' : 'UP NEXT';
      return '<div class="player-row speaking-row ' + (index === roomState.speakerIndex ? 'speaking-now' : index < roomState.speakerIndex ? 'speaker-done' : '') + '"><span class="speaker-number">' + (index + 1) + '</span><span class="player-avatar">' + escapeHtml(player.name.slice(0, 1).toUpperCase()) + '</span>' + escapeHtml(player.name) + (player.id === me ? '<span class="you">YOU</span>' : '') + '<span class="speaker-status">' + status + '</span></div>';
    }).join('');
    const turnMessage = isMyTurn ? 'You’re up! Give your clue out loud.' : (activePlayer ? escapeHtml(activePlayer.name) + ' is giving a clue.' : 'Getting the speaking order ready…');
    const hostAction = host ? (isLastSpeaker ? '<button class="button button-primary" id="open-vote">Everyone has given a clue — vote <span>→</span></button>' : '<button class="button button-primary" id="next-speaker">Clue given — next speaker <span>→</span></button>') : '<div class="wait-note">' + (isMyTurn ? 'Give one short clue, then wait for the host to move the turn along.' : 'Listen to the clues. The host will move to the next speaker.') + '</div>';
    main = '<div class="game-grid"><div class="game-panel"><div class="panel-top"><span>RANDOM SPEAKING ORDER</span><span class="badge">' + (roomState.speakerIndex + 1) + ' / ' + order.length + '</span></div><div class="turn-callout"><span class="turn-kicker">' + (isMyTurn ? 'YOUR TURN' : 'NOW SPEAKING') + '</span><strong>' + (activePlayer ? escapeHtml(activePlayer.name) : '…') + '</strong><span class="turn-copy">' + turnMessage + '</span></div><div class="player-list">' + orderRows + '</div>' + hostAction + '<div class="role-card ' + (roleInfo?.role === 'imposter' ? 'imposter' : '') + ' role-card-compact"><div class="role-label">' + (roleInfo?.role === 'imposter' ? 'YOUR ROLE' : 'YOUR FOOTBALLER') + '</div><div class="role-word">' + (roleInfo?.role === 'imposter' ? 'Imposter' : roleInfo?.footballer ? escapeHtml(roleInfo.footballer) : 'Loading…') + '</div><div class="role-hint">' + (roleInfo?.role === 'imposter' ? 'Blend in. Listen to the clues and don’t get caught.' : 'Give a short clue when it’s your turn.') + '</div></div></div><aside class="side-panel"><div class="panel-top"><span>THE RULES</span><span>02 / 03</span></div><h3 class="phase-title">One clue each.</h3><p class="side-copy">The speaking order is shuffled each round. Number 1 gives the first clue. Say clues out loud, then the host opens voting after everyone has spoken.</p><div class="step"><b>1</b> GET YOUR SECRET PLAYER</div><div class="step active"><b>2</b> FOLLOW THE SPEAKING ORDER</div><div class="step"><b>3</b> VOTE OUT THE IMPOSTER</div></aside></div>';
  }
  document.querySelector('#room-content').innerHTML = main;
  document.querySelector('#start-game')?.addEventListener('click', () => socket.emit('game:start'));
  document.querySelector('#open-vote')?.addEventListener('click', () => socket.emit('game:phase', { phase: 'voting' }));
  document.querySelector('#next-speaker')?.addEventListener('click', () => socket.emit('game:next-speaker'));
  document.querySelectorAll('[data-vote]').forEach((button) => button.addEventListener('click', () => { selectedVote = button.dataset.vote; renderRoom(); }));
  document.querySelector('#confirm-vote')?.addEventListener('click', () => { socket.emit('game:vote', { targetId: selectedVote }); });
  document.querySelector('#next-round')?.addEventListener('click', () => { roleInfo = null; voteConfirmed = false; selectedVote = null; socket.emit('game:phase', { phase: 'hints' }); });
}

document.querySelector('#create-btn').addEventListener('click', createRoom);
document.querySelector('#join-btn').addEventListener('click', joinRoom);
document.querySelector('#room-code').addEventListener('input', (event) => { event.target.value = event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase(); });
document.querySelector('#host-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') createRoom(); });
document.querySelector('#join-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') joinRoom(); });
document.querySelector('#room-code').addEventListener('keydown', (event) => { if (event.key === 'Enter') joinRoom(); });
socket.on('room:update', (state) => { roomState = state; renderRoom(); });
socket.on('game:role', (role) => { roleInfo = role; voteConfirmed = false; selectedVote = null; renderRoom(); });
socket.on('vote:confirmed', () => { voteConfirmed = true; renderRoom(); });
socket.on('game:error', notify);
