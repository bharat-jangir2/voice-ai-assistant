// Mu-law decoding table
export const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const input = ~i;
  const sign = input & 0x80 ? -1 : 1;
  const exponent = (input & 0x70) >> 4;
  const mantissa = input & 0x0f;
  let value = mantissa << (exponent + 3);
  value += 0x84;
  value = sign * value;
  MULAW_DECODE_TABLE[i] = value;
}

export const PROCESS_THRESHOLD = 300;
export const SILENCE_THRESHOLD = 500; // or 300 if your environment is quiet
export const SILENCE_CHUNKS = 50; // 400ms of silence
export const MIN_CHUNKS = 40; // 1.6s minimum utterance
export const MIN_ACTIVE_CHUNKS = 10; // e.g., 400ms of actual speech

// Interrupt functionality constants
export const INTERRUPT_THRESHOLD = 800; // Higher threshold for interrupt detection (more sensitive)
export const INTERRUPT_CHUNK_COUNT = 3; // Number of consecutive chunks above threshold to trigger interrupt
export const INTERRUPT_COOLDOWN_MS = 1000; // Minimum time between interrupts (1 second)
export const PLAYBACK_BUFFER_MS = 200; // Buffer time before considering playback started
