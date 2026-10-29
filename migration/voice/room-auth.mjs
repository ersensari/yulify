import { timingSafeEqual } from 'node:crypto';

/**
 * Pure credential check for the room already looked up by sessionId. Mirrors
 * minicpm-duplex.ts: authorization scheme is case-insensitive, token is not.
 * The caller must prune expired rooms and update lastSeenAt after success.
 */
export function hasRoomBearer(room, sessionId, authorization) {
  if (!room || room.sessionId !== sessionId || typeof room.bridgeToken !== 'string' || !room.bridgeToken || typeof authorization !== 'string') return false;
  const match = /^Bearer (.+)$/i.exec(authorization);
  if (!match) return false;
  const got = Buffer.from(match[1]);
  const expected = Buffer.from(room.bridgeToken);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
