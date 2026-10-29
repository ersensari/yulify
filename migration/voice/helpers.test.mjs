import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasRoomBearer } from './room-auth.mjs';
import { pcmTo24k } from './pcm24.mjs';

const room = { sessionId: 'chat-a', bridgeToken: 'abC_123' };
test('room and exact bearer token are both required', () => {
  assert.equal(hasRoomBearer(room, 'chat-a', 'bearer abC_123'), true);
  for (const [r, s, h] of [[room, 'chat-b', 'Bearer abC_123'], [room, 'chat-a', 'Bearer abc_123'], [room, 'chat-a', 'Bearer abC_12'], [room, 'chat-a', 'Bearer abC_123 '], [room, 'chat-a', 'Basic abC_123'], [undefined, 'chat-a', 'Bearer abC_123'], [{sessionId:'chat-a',bridgeToken:''}, 'chat-a', 'Bearer ']]) assert.equal(hasRoomBearer(r, s, h), false);
});
function convert(rate, input, lengths) {
  const stream = pcmTo24k(rate), parts = [];
  for (let i = 0, n = 0; i < input.length; n++) { const end = Math.min(input.length, i + lengths[n % lengths.length]); parts.push(stream.push(input.subarray(i, end))); i = end; }
  parts.push(stream.finish());
  return Buffer.concat(parts);
}
function tone(rate, hz, seconds = .25) {
  const b = Buffer.alloc(rate * seconds * 2);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(16000 * Math.sin(2 * Math.PI * hz * i / rate)), i * 2);
  return b;
}
function rms(b) {
  let sum = 0, count = 0;
  for (let i = 512; i < b.length - 512; i += 2) { sum += b.readInt16LE(i) ** 2; count++; }
  return Math.sqrt(sum / count);
}
test('24 kHz exact pass-through and odd transport chunks', () => {
  const audio = tone(24000, 3000);
  assert.deepEqual(convert(24000, audio, [1, 2, 3, 5]), audio);
});
test('48 kHz decimation has chunk-invariant samples and correct length', () => {
  const audio = tone(48000, 3000);
  const a = convert(48000, audio, [audio.length]);
  const b = convert(48000, audio, [1, 7, 48, 3, 500]);
  assert.equal(a.length, audio.length / 2);
  assert.deepEqual(a, b);
  const oddSamples = audio.subarray(0, 2002);
  assert.equal(convert(48000, oddSamples, [3]).length, 1002);
});
test('decimator retains speech band and suppresses aliases above output Nyquist', () => {
  const low = rms(convert(48000, tone(48000, 2000), [4096]));
  const high = rms(convert(48000, tone(48000, 18000), [4096]));
  assert.ok(low > 11000 && low < 11500, `2 kHz RMS ${low}`);
  assert.ok(high / low < .005, `18 kHz alias ratio ${high / low}`);
});
test('invalid rates and truncated samples are refused', () => {
  assert.throws(() => pcmTo24k(44100), RangeError);
  for (const rate of [24000, 48000]) {
    const p = pcmTo24k(rate); p.push(Buffer.from([1]));
    assert.throws(() => p.finish(), /Truncated/);
    assert.throws(() => p.push(Buffer.alloc(0)), /ended/);
  }
});
