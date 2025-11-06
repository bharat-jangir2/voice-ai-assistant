import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { VoiceOrchestratorService } from '../services/voice-orchestrator.service';
import { AudioFormatService } from '../services/audio-format.service';
import { ConversationDbService } from '../services/conversation-db.service';
import { AssistantConfigCacheService } from '../services/assistant-config-cache.service';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class WebVoiceGateway {
  private readonly logger = new Logger(WebVoiceGateway.name);
  private io: Server | null = null;
  private sessionIdToSocket: Map<string, Socket> = new Map();
  private activeTtsSessions: Map<string, { cancelled: boolean }> = new Map(); // Track active TTS sending sessions

  // Optimized timing configuration for smoother audio streaming
  private readonly OPTIMIZED_TIMING = {
    ttsChunkDelay: 5, // Reduced from 10ms for faster streaming
    chunkSize: 320, // 10ms at 16kHz PCM16
    adaptiveBuffering: true, // Enable adaptive buffering
  };

  constructor(
    @Inject(forwardRef(() => VoiceOrchestratorService))
    private readonly voiceOrchestrator: VoiceOrchestratorService,
    private readonly audioFormatService: AudioFormatService,
    private readonly conversationDbService: ConversationDbService,
    private readonly assistantConfigCache: AssistantConfigCacheService,
    @Inject('userService') private readonly userServiceClient: ClientProxy,
  ) {}

  initialize(io: Server) {
    this.io = io.of('/voice') as unknown as Server;
    const nsp = this.io as any;

    nsp.on('connection', (socket: Socket) => {
      this.logger.log(`Web voice socket connected: ${socket.id}`);

      socket.on('start', async (payload: { sessionId: string }) => {
        try {
          this.sessionIdToSocket.set(payload.sessionId, socket);
          await this.voiceOrchestrator.startSession(payload.sessionId);

          // Get firstMessage from assistant config
          let firstMessage = process.env.WEB_VOICE_WELCOME_MESSAGE || 'Welcome, your voice session is connected.';
          try {
            const conv = await this.conversationDbService.getConversation(payload.sessionId);
            if (conv) {
              const assistantId = (conv as any).assistantId;
              const organizationId = (conv as any).organizationId;
              const userId = (conv as any).userId;

              if (assistantId && organizationId && userId) {
                // Use cache service instead of direct fetch
                const assistantConfig = await this.assistantConfigCache.getAssistantConfiguration(
                  assistantId,
                  organizationId,
                  userId,
                );
                // Try to get firstMessage from different possible locations in the config
                if (assistantConfig?.firstMessage) {
                  firstMessage = assistantConfig.firstMessage;
                } else if (assistantConfig?.modelConfig?.firstMessage) {
                  firstMessage = assistantConfig.modelConfig.firstMessage;
                } else if (assistantConfig?.aiConfig?.firstMessage) {
                  firstMessage = assistantConfig.aiConfig.firstMessage;
                }
                this.logger.log(`📝 Found firstMessage from assistant config: "${firstMessage}"`);
              }
            }
          } catch (error) {
            this.logger.warn(`⚠️ Could not fetch firstMessage from assistant config, using default: ${(error as any)?.message}`);
          }

          this.logger.log(`📢 Sending first message to session ${payload.sessionId}: "${firstMessage}"`);

          // Wait for the first message TTS to complete before emitting 'started'
          // This ensures all audio chunks are sent before the frontend receives 'started'
          // The speak() method generates TTS and sends all chunks via sendTtsFrames()
          await this.voiceOrchestrator.speak(payload.sessionId, firstMessage);

          // Calculate delay based on message length to ensure all chunks are transmitted
          // For PCM16 16kHz: ~32000 bytes/sec, average ~5 chars per byte of audio
          // Add buffer for network latency and chunk processing
          const estimatedAudioDuration = firstMessage.length * 50; // ~50ms per character (rough estimate)
          const networkBuffer = 200; // 200ms buffer for network and processing
          const waitTime = Math.min(estimatedAudioDuration + networkBuffer, 2000); // Cap at 2 seconds

          this.logger.log(`⏳ Waiting ${waitTime}ms for audio chunks to be transmitted...`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));

          socket.emit('started', { sessionId: payload.sessionId });
          this.logger.log(`✅ Session ${payload.sessionId} started - first message sent and queued`);
        } catch (e) {
          socket.emit('error', { message: (e as any)?.message || 'START_FAILED' });
        }
      });

      socket.on('audio', async (payload: { sessionId: string; chunk: string; format?: string; sampleRate?: number }) => {
        try {
          await this.voiceOrchestrator.handleAudioChunk(
            payload.sessionId,
            payload.chunk,
            payload.format as 'pcm16' | 'mulaw' | undefined,
            payload.sampleRate,
          );
          // In a real flow, TTS frames would be emitted back as 'audio' events
        } catch (e) {
          socket.emit('error', { message: (e as any)?.message || 'AUDIO_FAILED' });
        }
      });

      // Test endpoint: Send text directly without STT (for testing)
      socket.on('test:text', async (payload: { sessionId: string; text: string }) => {
        try {
          this.logger.log(`🧪 Test text received for session ${payload.sessionId}: "${payload.text}"`);
          await this.voiceOrchestrator.handleTestText(payload.sessionId, payload.text);
        } catch (e) {
          this.logger.error(`❌ Test text error: ${(e as any)?.message || e}`);
          socket.emit('error', { message: (e as any)?.message || 'TEST_TEXT_FAILED' });
        }
      });

      socket.on('end', async (payload: { sessionId: string }) => {
        try {
          // Cancel any active TTS sending for this session
          this.cancelTtsSending(payload.sessionId);

          await this.voiceOrchestrator.endSession(payload.sessionId);
          socket.emit('ended', { sessionId: payload.sessionId });
          this.sessionIdToSocket.delete(payload.sessionId);
          socket.disconnect(true);
        } catch (e) {
          socket.emit('error', { message: (e as any)?.message || 'END_FAILED' });
        }
      });

      socket.on('disconnect', () => {
        this.logger.log(`Web voice socket disconnected: ${socket.id}`);
      });
    });
  }

  async sendTtsFrames(sessionId: string, audioBuffer: Buffer, chunkSize = 320) {
    const socket = this.sessionIdToSocket.get(sessionId);
    if (!socket) {
      this.logger.warn(`⚠️ No socket found for session ${sessionId} when trying to send TTS frames`);
      return;
    }
    if (!socket.connected) {
      this.logger.warn(`⚠️ Socket for session ${sessionId} is not connected`);
      return;
    }

    // Mark this session as having active TTS sending
    const ttsState = { cancelled: false };
    this.activeTtsSessions.set(sessionId, ttsState);

    try {
      // Convert TTS output (mu-law 8kHz) to PCM16 16kHz for frontend playback
      const pcm16Buffer = this.audioFormatService.normalizeForPlayback(audioBuffer, 16000);
      this.logger.log(
        `🔧 Converted TTS audio for playback: ${audioBuffer.length} bytes (mu-law 8kHz) → ${pcm16Buffer.length} bytes (PCM16 16kHz)`,
      );

      // Use optimized chunk size for PCM16 (320 bytes = 10ms at 16kHz)
      const pcmChunkSize = this.OPTIMIZED_TIMING.chunkSize;
      const totalChunks = Math.ceil(pcm16Buffer.length / pcmChunkSize);
      this.logger.log(
        `📤 Sending TTS frames to session ${sessionId}: ${pcm16Buffer.length} bytes, ${totalChunks} chunks (PCM16 16kHz)`,
      );

      let chunkCount = 0;
      let sequenceNumber = 0;
      for (let i = 0; i < pcm16Buffer.length; i += pcmChunkSize) {
        // Check if sending was cancelled (session ended or interrupted)
        if (ttsState.cancelled) {
          this.logger.log(`🛑 TTS sending cancelled for session ${sessionId} (stopped at chunk ${chunkCount}/${totalChunks})`);
          break;
        }

        // Double-check socket is still connected
        if (!socket.connected) {
          this.logger.warn(`⚠️ Socket disconnected during TTS sending for session ${sessionId}`);
          break;
        }

        const chunk = pcm16Buffer.slice(i, Math.min(i + pcmChunkSize, pcm16Buffer.length));

        // OPTIMIZED: Use binary transport instead of base64 for efficiency
        // Socket.IO natively supports binary data, which is ~33% smaller than base64
        const chunkBuffer = Buffer.from(chunk);
        socket.emit('audio-binary', {
          chunk: chunkBuffer, // Send as binary buffer (Socket.IO handles this automatically)
          format: 'pcm16',
          sampleRate: 16000,
          timestamp: Date.now(),
          sequence: sequenceNumber++,
        });

        chunkCount++;

        // Only log every 50 chunks to avoid spam
        if (chunkCount % 50 === 0) {
          this.logger.debug(`📤 Sent ${chunkCount}/${totalChunks} chunks`);
        }

        // OPTIMIZED: Reduced delay from 10ms to 5ms for faster streaming
        await new Promise((r) => setTimeout(r, this.OPTIMIZED_TIMING.ttsChunkDelay));
      }

      if (ttsState.cancelled) {
        this.logger.log(
          `⚠️ TTS sending was cancelled for session ${sessionId} (sent ${chunkCount}/${totalChunks} chunks before cancellation)`,
        );
      } else {
        this.logger.log(`✅ Sent ${chunkCount} audio chunks to session ${sessionId}`);
      }
    } finally {
      // Clean up
      this.activeTtsSessions.delete(sessionId);
    }
  }

  // Cancel active TTS sending for a session (called on interrupt or session end)
  cancelTtsSending(sessionId: string): void {
    const ttsState = this.activeTtsSessions.get(sessionId);
    if (ttsState) {
      this.logger.log(`🛑 Cancelling TTS sending for session ${sessionId}`);
      ttsState.cancelled = true;
    }
  }

  /**
   * Emit transcription event to client (for real-time UI updates)
   * @param sessionId The session ID
   * @param data Transcription data with text, isFinal, role, and timestamp
   */
  emitTranscription(
    sessionId: string,
    data: { text: string; isFinal: boolean; role: 'user' | 'assistant'; timestamp: number },
  ): void {
    try {
      const socket = this.sessionIdToSocket.get(sessionId);
      if (!socket) {
        this.logger.warn(`⚠️ No socket found for session ${sessionId} when trying to emit transcription (role: ${data.role})`);
        this.logger.warn(`⚠️ Available sessions: ${Array.from(this.sessionIdToSocket.keys()).join(', ') || 'none'}`);
        return;
      }
      if (!socket.connected) {
        this.logger.warn(
          `⚠️ Socket for session ${sessionId} is not connected when trying to emit transcription (role: ${data.role})`,
        );
        return;
      }

      this.logger.log(
        `📤 Emitting transcription event for session ${sessionId}: ${data.isFinal ? 'final' : 'partial'} ${data.role} - "${data.text.substring(0, 50)}${data.text.length > 50 ? '...' : ''}"`,
      );

      socket.emit('transcription', {
        sessionId,
        text: data.text,
        isFinal: data.isFinal,
        role: data.role,
        timestamp: data.timestamp,
      });

      this.logger.debug(`✅ Transcription event emitted successfully for session ${sessionId} (role: ${data.role})`);
    } catch (error) {
      this.logger.error(`❌ Error emitting transcription for session ${sessionId}: ${(error as any)?.message || error}`);
      this.logger.error(`❌ Error stack: ${(error as any)?.stack || 'No stack trace'}`);
    }
  }

  // DEPRECATED: Use assistantConfigCache.getAssistantConfiguration() instead
  // Keeping for backward compatibility, but should use cache service
  private async getAssistantConfiguration(assistantId: string, organizationId: string, userId: string): Promise<any> {
    return this.assistantConfigCache.getAssistantConfiguration(assistantId, organizationId, userId);
  }
}
