# Offside — Football Undercover

A phone friendly, real time social deduction game. One player hosts a room, shares the five character code, and friends join from their own phones. Everyone except the imposter privately sees the same footballer.

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

Open `http://localhost:3000`. For friends on the same Wi-Fi, open the host computer's local network IP at port 3000 on each phone.

## Put it online

This repository includes a `render.yaml` blueprint. Push it to a GitHub repository, create a new Blueprint in Render, and select the repository. Render will install the dependencies and start the app. Share the resulting HTTPS URL with your friends; the room code connects everyone to the same live game.

Rooms live in server memory and are cleared when the server restarts. Keep one server instance running for the duration of a game. Supports 3–16 players per room.

## How to play

1. Host creates a room and shares the code.
2. Players join from their phones; the host starts with at least three players.
3. The host chooses the number of imposters and can allow an imposter to speak first. Otherwise, the randomized first speaker is always on the footballer team.
4. Each player sees their role privately. Footballers stay hidden from imposters on all shared result screens until the game ends.
5. Take turns giving one verbal clue, then vote privately.
6. If an imposter is voted out, they get one private guess at the footballer. A correct guess wins for the imposter team; a wrong guess removes that imposter and play continues. If a footballer is voted out, they are removed from play and the game continues with the same footballer and remaining imposters. The imposter team wins when imposters equal or outnumber the remaining footballers.
7. The room owner keeps control even if voted out. After a game ends, they can start a new game with a different footballer and freshly assigned roles; eliminated players who are still connected return.
