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
5. Each speaker gets 20 seconds; turns advance automatically. After the final clue, everyone enters voting together.
6. A tied vote immediately starts a runoff among only the tied players. If the runoff ties again, vote again among the new tied leaders.
7. If an imposter is voted out, their name is shown and they have 30 seconds to privately guess the footballer. A correct guess wins for the imposter team; a wrong or late guess removes that imposter and play continues if teammates remain. If a footballer is voted out, they are removed from play and the game continues with the same footballer and remaining imposters. The imposter team wins when imposters equal or outnumber the remaining footballers.
8. If someone disconnects or refreshes during a game, they are removed from the active round so votes and turns can continue. The host can also disconnect players from the lobby, speaking order, or voting screen.
9. The room owner keeps control even if voted out. After a game ends, Start a new game returns everyone to the lobby. Connected eliminated players rejoin there; the host can review the settings and press Start the game to deal a new footballer and fresh roles.
