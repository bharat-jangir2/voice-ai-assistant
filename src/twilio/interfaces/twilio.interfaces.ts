import { WebSocket } from 'ws'; // Assuming you might use ws client directly or through socket.io wrappers

export interface StreamState {
  client: any;
  chunkMap: Map<number, Buffer>;
  currentCallSid: string;
  isWelcomeMessagePlaying: boolean;
  lastMarkNameSent: string | null; // To track marks for welcome message
  isProcessingUserAudio: boolean; // Flag to indicate if processing user audio (after welcome)
  silenceChunkCount: number;
  activeChunkCount: number;
  threadId?: string; // Optional: For RAG assistant conversation thread
  initialMediaChunks?: MediaMessage[]; // To store media chunks received before welcome message finishes
  phoneNumber?: string; // Add this to store phone number

  // Interrupt functionality fields
  isPlayingBack: boolean; // Flag to indicate if AI response is being played back
  playbackStartTime: number; // Timestamp when playback started
  accumulatedAudioChunks: Map<number, Buffer>; // Audio chunks accumulated during playback
  interruptThreshold: number; // Minimum amplitude to trigger interrupt
  interruptChunkCount: number; // Number of consecutive chunks above threshold to trigger interrupt
  consecutiveInterruptChunks: number; // Current count of consecutive interrupt chunks
  lastInterruptTime: number; // Last time an interrupt was detected
  playbackInterrupted: boolean; // Flag to track if current playback was interrupted
}

// For "connected" event
export interface TwilioConnectedEventPayload {
  event: 'connected';
  protocol: string;
  version: string;
}

export interface TwilioStartEventPayload {
  event: 'start';
  sequenceNumber: string;
  start: {
    accountSid: string;
    streamSid: string;
    callSid: string;
    tracks: string[]; // Typically ['inbound']
    mediaFormat: {
      encoding: string; // e.g., 'audio/x-mulaw'
      sampleRate: number; // e.g., 8000
      channels: number; // e.g., 1
    };
    customParameters: {
      caller: string; // e.g., '+16203372482'
      assistantType: string; // e.g., 'appraisee'
      [key: string]: string; // Support any additional dynamic keys
    };
  };
  streamSid: string;
}

export interface MediaMessage {
  event: 'media';
  sequenceNumber: string;
  media: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string; // Base64 encoded audio
  };
  streamSid: string;
}

export interface MakeCallDto {
  toPhoneNumber: string;
}

export interface EndCallDto {
  callSid: string;
}

export interface QuestionDto {
  question: string;
  assistantType?: string;
  sessionId?: string;
  phoneNumber?: string;
}
