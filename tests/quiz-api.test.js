import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { onRequestGet as roomsGet, onRequestPost as roomsPost } from '../functions/api/quiz/rooms.js';
import { onRequestGet as socketGet } from '../functions/api/quiz/rooms/[roomCode]/socket.js';
import { onRequestPost as scorePost } from '../functions/api/score.js';
import { onRequestGet as leaderboardGet } from '../functions/api/leaderboard.js';
import { onRequestGet as historyGet } from '../functions/api/history.js';
import { questions as defaultQuestions } from '../presentation/workers/questions.js';

const TOKEN = 'a'.repeat(64);
const importedQuestionSet = {
  id: 'imported-api-set',
  name: 'Bộ import kiểm thử API',
  questions: defaultQuestions.map((question, index) => ({
    ...question,
    id: `api-${String(index + 1).padStart(2, '0')}`,
    options: { ...question.options }
  }))
};

function context(request, bindings = env, params = {}) {
  return { request, env: bindings, params };
}

function jsonRequest(url, body, { method = 'POST', ip = 'api-test', headers = {} } = {}) {
  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
      ...headers
    },
    body: method === 'GET' ? undefined : JSON.stringify(body)
  });
}

async function json(response) {
  return response.json();
}

function fakeBindings({ roomResponse, onRoomRequest } = {}) {
  const calls = [];
  const bindings = {
    QUIZ_ROOM: {
      idFromName(name) {
        return name;
      },
      get(id) {
        return {
          async fetch(request) {
            const body = request.body ? await request.text() : null;
            calls.push({ id, request, body });
            if (onRoomRequest) return onRoomRequest({ id, request, body });
            return roomResponse || new Response(JSON.stringify({ ok: true, snapshot: { leaderboard: [] } }), {
              headers: { 'Content-Type': 'application/json' }
            });
          }
        };
      }
    }
  };
  return { bindings, calls };
}

describe('Pages quiz API contracts', () => {
  afterEach(async () => {
    await reset();
  });

  it('validates room create/join/snapshot inputs before forwarding to one actor', async () => {
    const { bindings, calls } = fakeBindings();
    const create = await roomsPost(context(jsonRequest('https://pages.test/api/quiz/rooms', {
      type: 'create', nickname: 'Chủ phòng', role: 'host'
    }, { ip: 'room-create' }), bindings));
    expect(create.status).toBe(200);
    expect(calls[0].id).toBe('__quiz_room_allocator__');
    expect(JSON.parse(calls[0].body)).toEqual({ type: 'create', nickname: 'Chủ phòng' });

    const join = await roomsPost(context(jsonRequest('https://pages.test/api/quiz/rooms', {
      type: 'join', roomCode: 'abc123', nickname: 'Minh', role: 'player'
    }, { ip: 'room-join' }), bindings));
    expect(join.status).toBe(200);
    expect(calls[1].id).toBe('ABC123');

    const snapshot = await roomsGet(context(new Request(
      `https://pages.test/api/quiz/rooms?roomCode=ABC123&playerId=player-1234&capabilityToken=${TOKEN}`,
      { headers: { 'CF-Connecting-IP': 'room-snapshot' } }
    ), bindings));
    expect(snapshot.status).toBe(200);
    expect(new URL(calls[2].request.url).pathname).toBe('/rooms/ABC123');

    const finishedSnapshot = await roomsGet(context(new Request(
      `https://pages.test/api/quiz/rooms?roomCode=ABC123&playerId=player-1234&capabilityToken=${TOKEN}&finished=1`,
      { headers: { 'CF-Connecting-IP': 'room-finished-snapshot' } }
    ), bindings));
    expect(finishedSnapshot.status).toBe(200);
    expect(new URL(calls[3].request.url).searchParams.get('finished')).toBe('1');

    const malformed = await roomsPost(context(new Request('https://pages.test/api/quiz/rooms', {
      method: 'POST', body: JSON.stringify({ type: 'join', roomCode: 'ABC123', nickname: 'Minh' })
    }), bindings));
    expect(malformed.status).toBe(415);
    expect((await json(malformed)).code).toBe('unsupported_media_type');

    const invalidNickname = await roomsPost(context(jsonRequest('https://pages.test/api/quiz/rooms', {
      type: 'join', roomCode: 'ABC123', nickname: 'bad\u0000name'
    }, { ip: 'room-invalid-nickname' }), bindings));
    expect(invalidNickname.status).toBe(400);
    expect((await json(invalidNickname)).code).toBe('invalid_nickname');

    const invalidRole = await roomsPost(context(jsonRequest('https://pages.test/api/quiz/rooms', {
      type: 'join', roomCode: 'ABC123', nickname: 'Minh', role: 'host'
    }, { ip: 'room-invalid-role' }), bindings));
    expect(invalidRole.status).toBe(403);

    const missingCapability = await roomsGet(context(new Request(
      'https://pages.test/api/quiz/rooms?roomCode=ABC123&playerId=player-1234',
      { headers: { 'CF-Connecting-IP': 'room-missing-capability' } }
    ), bindings));
    expect(missingCapability.status).toBe(401);
    expect(calls).toHaveLength(4);

    const missingBinding = await roomsPost(context(jsonRequest('https://pages.test/api/quiz/rooms', {
      type: 'join', roomCode: 'ABC123', nickname: 'Minh'
    }, { ip: 'room-missing-binding' }), {}));
    expect(missingBinding.status).toBe(503);
    expect((await json(missingBinding)).code).toBe('missing_room_binding');
  });

  it('validates and preserves the room-specific WebSocket upgrade', async () => {
    const { bindings, calls } = fakeBindings({
      onRoomRequest: async ({ request }) => ({ ok: true, status: 101, request })
    });
    const request = new Request(
      `https://pages.test/api/quiz/rooms/abc123/socket?playerId=player-1234&capabilityToken=${TOKEN}&reconnectToken=${'b'.repeat(64)}`,
      { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'CF-Connecting-IP': 'socket-valid' } }
    );
    const response = await socketGet(context(request, bindings, { roomCode: 'abc123' }));
    expect(response.status).toBe(101);
    expect(calls[0].id).toBe('ABC123');
    expect(calls[0].request.headers.get('Upgrade')).toBe('websocket');
    expect(new URL(calls[0].request.url).pathname).toBe('/rooms/ABC123');

    const noUpgrade = await socketGet(context(new Request(
      `https://pages.test/api/quiz/rooms/ABC123/socket?playerId=player-1234&capabilityToken=${TOKEN}`
    ), bindings, { roomCode: 'ABC123' }));
    expect(noUpgrade.status).toBe(426);

    const invalidPath = await socketGet(context(new Request(
      `https://pages.test/api/quiz/rooms/not-valid/socket?playerId=player-1234&capabilityToken=${TOKEN}`,
      { headers: { Upgrade: 'websocket' } }
    ), bindings, { roomCode: 'not-valid' }));
    expect(invalidPath.status).toBe(400);
  });

  it('strips forged score fields and keeps finalization idempotent', async () => {
    const forwarded = [];
    const { bindings } = fakeBindings({
      onRoomRequest: async ({ body }) => {
        forwarded.push(JSON.parse(body));
        return new Response(JSON.stringify({ ok: true, event: 'finished', idempotent: forwarded.length > 1 }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    });
    const payload = {
      roomCode: 'SCORE1', playerId: 'player-1234', capabilityToken: TOKEN,
      score: 999999, elapsedMs: 0, correctness: true, rank: 1, option: 'A'
    };
    const first = await scorePost(context(jsonRequest('https://pages.test/api/score', payload, { ip: 'score-idempotent' }), bindings));
    const second = await scorePost(context(jsonRequest('https://pages.test/api/score', payload, { ip: 'score-idempotent-2' }), bindings));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(forwarded).toEqual([
      { type: 'finalize', playerId: 'player-1234', capabilityToken: TOKEN },
      { type: 'finalize', playerId: 'player-1234', capabilityToken: TOKEN }
    ]);

    const badBody = await scorePost(context(jsonRequest('https://pages.test/api/score', {
      roomCode: 'SCORE1', playerId: 'player-1234', capabilityToken: TOKEN, role: 'moderator'
    }, { ip: 'score-bad-role' }), bindings));
    expect(badBody.status).toBe(400);
    const oversized = await scorePost(context(new Request('https://pages.test/api/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '9000' },
      body: '{}'
    }), bindings));
    expect(oversized.status).toBe(413);
  });

  it('allows only the host to finalize a real room and persists no client score', async () => {
    const roomCode = 'API123';
    const room = env.QUIZ_ROOM.get(env.QUIZ_ROOM.idFromName(roomCode));
    const createResponse = await room.fetch(`https://quiz.test/rooms/${roomCode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'create', nickname: 'Chủ phòng', questionSet: importedQuestionSet })
    });
    const host = await createResponse.json();
    const joinResponse = await room.fetch(`https://quiz.test/rooms/${roomCode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'join', nickname: 'Minh' })
    });
    const player = await joinResponse.json();

    const forged = await scorePost(context(jsonRequest('https://pages.test/api/score', {
      roomCode, playerId: player.player.playerId, capabilityToken: player.capabilityToken,
      score: 20000, elapsedMs: 0, correctness: true
    }, { ip: 'real-player-finalize' })));
    expect(forged.status).toBe(403);
    expect((await json(forged)).code).toBe('host_only');

    const finalPayload = {
      roomCode, playerId: host.player.playerId, capabilityToken: host.capabilityToken,
      score: 20000, elapsedMs: 1, correctness: true, rank: 1
    };
    const finalized = await scorePost(context(jsonRequest('https://pages.test/api/score', finalPayload, { ip: 'real-host-finalize' })));
    const repeated = await scorePost(context(jsonRequest('https://pages.test/api/score', finalPayload, { ip: 'real-host-finalize-repeat' })));
    expect(finalized.status).toBe(200);
    expect((await finalized.clone().json()).idempotent).toBe(false);
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).idempotent).toBe(true);

    const playerAfterFinish = await scorePost(context(jsonRequest('https://pages.test/api/score', {
      roomCode, playerId: player.player.playerId, capabilityToken: player.capabilityToken
    }, { ip: 'real-player-after-finish' })));
    expect(playerAfterFinish.status).toBe(200);
    expect((await playerAfterFinish.json()).idempotent).toBe(true);

    const leaderboard = await leaderboardGet(context(new Request(
      `https://pages.test/api/leaderboard?roomCode=${roomCode}&playerId=${host.player.playerId}&capabilityToken=${host.capabilityToken}`,
      { headers: { 'CF-Connecting-IP': 'real-leaderboard' } }
    )));
    const leaderboardBody = await leaderboard.json();
    expect(leaderboard.status).toBe(200);
    expect(leaderboardBody.currentRoom.roomCode).toBe(roomCode);
    expect(leaderboardBody.leaderboard).toHaveLength(1);
    expect(leaderboardBody.leaderboard[0].totalScore).toBe(0);
  });

  it('returns only the current-room leaderboard', async () => {
    const { bindings } = fakeBindings({
      roomResponse: new Response(JSON.stringify({ ok: true, snapshot: {
        roomCode: 'ABC123', phase: 'reveal', leaderboard: [{ displayName: 'Phòng', playerSequence: 2, totalScore: 999, totalResponseMs: 10, rank: 1 }]
      } }), { headers: { 'Content-Type': 'application/json' } })
    });
    const response = await leaderboardGet(context(new Request(
      `https://pages.test/api/leaderboard?roomCode=ABC123&playerId=player-1234&capabilityToken=${TOKEN}`,
      { headers: { 'CF-Connecting-IP': 'leaderboard-query' } }
    ), bindings));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.leaderboard[0].displayName).toBe('Phòng');

    const missingRoom = await leaderboardGet(context(new Request('https://pages.test/api/leaderboard'), {}));
    expect(missingRoom.status).toBe(400);
    expect((await missingRoom.json()).code).toBe('room_context_required');
  });

  it('lists finished rooms from the SQLite-backed Durable Object history index', async () => {
    const roomCode = 'HIST01';
    const room = env.QUIZ_ROOM.get(env.QUIZ_ROOM.idFromName(roomCode));
    const created = await room.fetch('https://quiz.test/rooms/' + roomCode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'create', nickname: 'Chủ phòng', questionSet: importedQuestionSet })
    });
    const host = await created.json();
    const finalized = await scorePost(context(jsonRequest('https://pages.test/api/score', {
      roomCode,
      playerId: host.player.playerId,
      capabilityToken: host.capabilityToken
    }, { ip: 'history-finalize' })));
    expect(finalized.status).toBe(200);

    const response = await historyGet(context(new Request('https://pages.test/api/history', {
      headers: { 'CF-Connecting-IP': 'history-read' }
    })));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.history[0]).toMatchObject({ roomCode, playerCount: 0, questionCount: 20 });
  });

  it('rate-limits repeated finalization attempts without using nickname identity', async () => {
    const { bindings } = fakeBindings({
      roomResponse: new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
    });
    const requests = [];
    for (let index = 0; index < 11; index += 1) {
      requests.push(scorePost(context(jsonRequest('https://pages.test/api/score', {
        roomCode: 'RATE01', playerId: 'player-1234', capabilityToken: TOKEN,
        nickname: `different-${index}`, score: index
      }, { ip: 'same-client' }), bindings)));
    }
    const responses = await Promise.all(requests);
    expect(responses.slice(0, 10).every((response) => response.status === 200)).toBe(true);
    expect(responses[10].status).toBe(429);
    expect((await responses[10].json()).code).toBe('rate_limited');
  });
});
