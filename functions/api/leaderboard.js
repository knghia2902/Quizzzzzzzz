import {
  ApiError,
  errorResponse,
  enforceRateLimit,
  getRoomStub,
  jsonResponse,
  normalizeCapabilityToken,
  normalizePlayerId,
  normalizeRoomCode
} from './quiz/rooms.js';

const LEADERBOARD_LIMIT = 20;

function toLeaderboardRow(row, index) {
  return {
    rank: Number(row.rank ?? index + 1),
    roomCode: row.roomCode ?? row.room_code ?? null,
    playerId: row.playerId ?? row.player_id ?? null,
    displayName: row.displayName ?? row.display_name ?? '',
    playerSequence: Number(row.playerSequence ?? row.player_sequence ?? 0),
    totalScore: Number(row.totalScore ?? row.total_score ?? 0),
    totalResponseMs: Number(row.totalResponseMs ?? row.total_response_ms ?? 0)
  };
}

async function readCurrentRoom(request, env, roomCode, playerId, capabilityToken) {
  const query = new URLSearchParams({ playerId, capabilityToken, finished: '1' });
  let response;
  try {
    response = await getRoomStub(env, roomCode).fetch(
      new Request(`https://quiz-room.internal/rooms/${roomCode}?${query.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' }
      })
    );
  } catch {
    throw new ApiError('Dịch vụ phòng chơi tạm thời không khả dụng.', 503, 'room_service_unavailable');
  }
  if (!response.ok) return { response };
  try {
    const payload = await response.json();
    return {
      snapshot: payload?.snapshot || null,
      response: null
    };
  } catch {
    throw new ApiError('Phản hồi phòng chơi không hợp lệ.', 502, 'invalid_room_response');
  }
}

export async function onRequestGet(context) {
  try {
    const { request, env } = context;
    const url = new URL(request.url);
    const roomParam = url.searchParams.get('roomCode');
    const playerParam = url.searchParams.get('playerId');
    const capabilityParam = url.searchParams.get('capabilityToken');
    const hasRoomContext = Boolean(roomParam || playerParam || capabilityParam);
    if (!hasRoomContext) {
      throw new ApiError('Cần mã phòng và thông tin phiên để xem bảng xếp hạng phòng.', 400, 'room_context_required');
    }
    let roomCode = null;
    let playerId = null;
    let capabilityToken = null;
    if (hasRoomContext) {
      roomCode = normalizeRoomCode(roomParam);
      playerId = normalizePlayerId(playerParam);
      capabilityToken = normalizeCapabilityToken(capabilityParam);
    }
    enforceRateLimit(request, { action: 'leaderboard', roomCode: roomCode || 'global', limit: 30, windowMs: 60_000 });

    let currentRoom = null;
    if (roomCode) {
      const current = await readCurrentRoom(request, env, roomCode, playerId, capabilityToken);
      if (current.response) return current.response;
      currentRoom = current.snapshot;
    }

    const currentRoomLeaderboard = Array.isArray(currentRoom?.leaderboard)
      ? currentRoom.leaderboard.slice(0, LEADERBOARD_LIMIT).map(toLeaderboardRow)
      : [];
    return jsonResponse({
      ok: true,
      leaderboard: currentRoomLeaderboard,
      currentRoom: {
        roomCode,
        phase: currentRoom.phase,
        leaderboard: currentRoomLeaderboard
      },
      limit: LEADERBOARD_LIMIT
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Forwarded-For'
    }
  });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'OPTIONS') return onRequestOptions(context);
  return jsonResponse({ ok: false, error: 'Phương thức không được hỗ trợ.', code: 'method_not_allowed' }, 405, {
    Allow: 'GET, OPTIONS'
  });
}
