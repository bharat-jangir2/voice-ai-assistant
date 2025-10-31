import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { VoiceOrchestratorService } from '../services/voice-orchestrator.service';
import { AudioFormatService } from '../services/audio-format.service';
import { ConversationDbService } from '../services/conversation-db.service';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class WebVoiceGateway {
  private readonly logger = new Logger(WebVoiceGateway.name);
  private io: Server | null = null;
  private sessionIdToSocket: Map<string, Socket> = new Map();
  private activeTtsSessions: Map<string, { cancelled: boolean }> = new Map(); // Track active TTS sending sessions

  constructor(
    @Inject(forwardRef(() => VoiceOrchestratorService))
    private readonly voiceOrchestrator: VoiceOrchestratorService,
    private readonly audioFormatService: AudioFormatService,
    private readonly conversationDbService: ConversationDbService,
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
                const assistantConfig = await this.getAssistantConfiguration(assistantId, organizationId, userId);
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
          await this.voiceOrchestrator.speak(payload.sessionId, firstMessage);
          socket.emit('started', { sessionId: payload.sessionId });
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
      this.logger.log(`🔧 Converted TTS audio for playback: ${audioBuffer.length} bytes (mu-law 8kHz) → ${pcm16Buffer.length} bytes (PCM16 16kHz)`);
      
      // Use larger chunk size for PCM16 (320 bytes = 10ms at 16kHz)
      const pcmChunkSize = 320;
      const totalChunks = Math.ceil(pcm16Buffer.length / pcmChunkSize);
      this.logger.log(`📤 Sending TTS frames to session ${sessionId}: ${pcm16Buffer.length} bytes, ${totalChunks} chunks (PCM16 16kHz)`);
      
      let chunkCount = 0;
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
        const chunkBase64 = chunk.toString('base64');
        this.logger.debug(`📤 Emitting audio chunk ${chunkCount + 1} to socket ${socket.id}: ${chunkBase64.length} base64 chars`);
        socket.emit('audio', { chunk: chunkBase64, format: 'pcm16', sampleRate: 16000 });
        chunkCount++;
        
        // Only log every 50 chunks to avoid spam
        if (chunkCount % 50 === 0) {
          this.logger.debug(`📤 Sent ${chunkCount}/${totalChunks} chunks`);
        }
        
        await new Promise((r) => setTimeout(r, 10)); // 10ms chunks for 16kHz
      }
      
      if (ttsState.cancelled) {
        this.logger.log(`⚠️ TTS sending was cancelled for session ${sessionId} (sent ${chunkCount}/${totalChunks} chunks before cancellation)`);
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

  private async getAssistantConfiguration(assistantId: string, organizationId: string, userId: string): Promise<any> {
    try {
      const resp: any = await firstValueFrom(
        this.userServiceClient.send('getAssistantById', {
          requestedUser: { _id: userId },
          assistantId,
          organizationId,
        }),
      );
      return resp?.data?.result || {};
    } catch (error) {
      this.logger.error(`❌ Error fetching assistant configuration: ${(error as any)?.message}`);
      throw error;
    }
  }
}
