import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { SpeechService } from './speech.service';
import { AudioFormatService } from './audio-format.service';
import { ConfigService } from '@nestjs/config';

export interface StreamingSTTSession extends EventEmitter {
  sessionId: string;
  isActive: boolean;
  audioBuffers: Buffer[];
  lastPartialTranscript: string;
  finalTranscript: string | null;
  startTime: number;
  end(): Promise<void>;
  sendAudio(audioBuffer: Buffer): Promise<void>;
}

/**
 * Streaming STT Service
 * 
 * Handles real-time speech-to-text transcription with partial results.
 * Currently uses batch STT with buffering, but designed for future streaming API integration.
 */
@Injectable()
export class StreamingSTTService {
  private readonly logger = new Logger(StreamingSTTService.name);
  private streams: Map<string, StreamingSTTSession> = new Map();

  constructor(
    private readonly speechService: SpeechService,
    private readonly audioFormatService: AudioFormatService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Start a streaming STT session
   */
  async startStreamingSession(sessionId: string): Promise<void> {
    if (this.streams.has(sessionId)) {
      this.logger.warn(`Streaming STT session ${sessionId} already exists`);
      return;
    }

    this.logger.log(`🎤 Starting streaming STT session: ${sessionId}`);

    const session = this.createStreamingSession(sessionId);
    this.streams.set(sessionId, session);

    // Emit start event
    session.emit('start', { sessionId });
  }

  /**
   * Send audio chunk to streaming STT session
   */
  async sendAudio(sessionId: string, audioBuffer: Buffer): Promise<void> {
    const stream = this.streams.get(sessionId);
    if (!stream) {
      this.logger.warn(`⚠️ No streaming STT session found for ${sessionId}`);
      return;
    }

    if (!stream.isActive) {
      this.logger.warn(`⚠️ Streaming STT session ${sessionId} is not active`);
      return;
    }

    // Add to buffer for batch processing
    stream.audioBuffers.push(audioBuffer);

    // For now, we use periodic batch transcription
    // In the future, this can be replaced with true streaming API (e.g., Google Cloud StreamingRecognize)
    // For now, we'll process in chunks when enough audio accumulates
    const shouldProcess = this.shouldProcessBuffer(stream.audioBuffers);

    if (shouldProcess) {
      await this.processBufferedAudio(sessionId);
    }
  }

  /**
   * Check if we should process the accumulated audio buffer
   */
  private shouldProcessBuffer(buffers: Buffer[]): boolean {
    // Process if we have accumulated enough audio (e.g., ~1 second at 8kHz mu-law)
    const totalSize = buffers.reduce((sum, buf) => sum + buf.length, 0);
    const oneSecondSize = 8000; // 8kHz mu-law = 8000 bytes per second
    
    // Process every ~0.5 seconds for more responsive partial results
    return totalSize >= oneSecondSize * 0.5;
  }

  /**
   * Process accumulated audio buffer and get partial/final transcript
   */
  private async processBufferedAudio(sessionId: string): Promise<void> {
    const stream = this.streams.get(sessionId);
    if (!stream || stream.audioBuffers.length === 0) {
      return;
    }

    try {
      // Combine buffers
      const combinedAudio = Buffer.concat(stream.audioBuffers);
      
      // Keep a small buffer for continuity (last 200ms)
      const keepBufferSize = Math.floor(8000 * 0.2); // 200ms at 8kHz
      const keepBuffer = combinedAudio.slice(-keepBufferSize);
      stream.audioBuffers = keepBuffer.length > 0 ? [keepBuffer] : [];

      // Normalize audio format for STT
      const normalizedAudio = this.audioFormatService.normalizeForSTT(combinedAudio, {
        format: 'mulaw',
        sampleRate: 8000,
      });

      // Get STT provider
      const sttProvider = this.speechService.getSTTProvider();

      // Transcribe (this will be replaced with streaming API in the future)
      const transcript = await this.speechService.transcribe(normalizedAudio, sttProvider);

      if (transcript && transcript.trim()) {
        // This is a partial transcript (not final until session ends)
        stream.lastPartialTranscript = transcript.trim();
        
        // Emit partial transcript event
        stream.emit('transcript', transcript.trim(), false);

        this.logger.debug(`📝 Partial transcript for session ${sessionId}: "${transcript.trim()}"`);
      }
    } catch (error) {
      this.logger.error(`❌ Error processing buffered audio for session ${sessionId}: ${error.message}`);
      stream.emit('error', error);
    }
  }

  /**
   * Finalize transcript and end streaming session
   */
  async finalizeTranscript(sessionId: string): Promise<string | null> {
    const stream = this.streams.get(sessionId);
    if (!stream) {
      this.logger.warn(`⚠️ No streaming STT session found for ${sessionId}`);
      return null;
    }

    try {
      // Process any remaining audio
      if (stream.audioBuffers.length > 0) {
        const combinedAudio = Buffer.concat(stream.audioBuffers);
        const normalizedAudio = this.audioFormatService.normalizeForSTT(combinedAudio, {
          format: 'mulaw',
          sampleRate: 8000,
        });

        const sttProvider = this.speechService.getSTTProvider();
        const finalTranscript = await this.speechService.transcribe(normalizedAudio, sttProvider);

        if (finalTranscript && finalTranscript.trim()) {
          stream.finalTranscript = finalTranscript.trim();
          stream.emit('transcript', finalTranscript.trim(), true);
          this.logger.log(`✅ Final transcript for session ${sessionId}: "${finalTranscript.trim()}"`);
        }
      } else if (stream.lastPartialTranscript) {
        // Use last partial transcript as final
        stream.finalTranscript = stream.lastPartialTranscript;
        stream.emit('transcript', stream.lastPartialTranscript, true);
      }

      // End the session
      await stream.end();

      return stream.finalTranscript;
    } catch (error) {
      this.logger.error(`❌ Error finalizing transcript for session ${sessionId}: ${error.message}`);
      stream.emit('error', error);
      return null;
    }
  }

  /**
   * End streaming session
   */
  async endStreamingSession(sessionId: string): Promise<void> {
    const stream = this.streams.get(sessionId);
    if (!stream) {
      return;
    }

    await stream.end();
    this.streams.delete(sessionId);
    this.logger.log(`🔚 Ended streaming STT session: ${sessionId}`);
  }

  /**
   * Get partial transcript for a session
   */
  getPartialTranscript(sessionId: string): string | null {
    const stream = this.streams.get(sessionId);
    return stream?.lastPartialTranscript || null;
  }

  /**
   * Register a callback for transcript events (partial and final)
   * @param sessionId The session ID
   * @param callback Callback function that receives (transcript: string, isFinal: boolean)
   */
  onTranscript(sessionId: string, callback: (transcript: string, isFinal: boolean) => void): void {
    const stream = this.streams.get(sessionId);
    if (stream) {
      stream.on('transcript', callback);
    } else {
      this.logger.warn(`⚠️ Cannot register transcript callback: session ${sessionId} not found`);
    }
  }

  /**
   * Unregister transcript callback
   */
  offTranscript(sessionId: string, callback: (transcript: string, isFinal: boolean) => void): void {
    const stream = this.streams.get(sessionId);
    if (stream) {
      stream.off('transcript', callback);
    }
  }

  /**
   * Create a new streaming session
   */
  private createStreamingSession(sessionId: string): StreamingSTTSession {
    const session = new EventEmitter() as StreamingSTTSession;
    session.sessionId = sessionId;
    session.isActive = true;
    session.audioBuffers = [];
    session.lastPartialTranscript = '';
    session.finalTranscript = null;
    session.startTime = Date.now();

    session.sendAudio = async (audioBuffer: Buffer) => {
      await this.sendAudio(sessionId, audioBuffer);
    };

    session.end = async () => {
      session.isActive = false;
      session.emit('end', { sessionId });
    };

    return session;
  }
}

