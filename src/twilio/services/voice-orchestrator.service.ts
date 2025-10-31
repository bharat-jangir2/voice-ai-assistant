import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConversationDbService } from './conversation-db.service';
import { SpeechService } from './speech.service';
import { DirectAIService } from './direct-ai.service';
import { CostCalculationService } from './cost-calculation.service';
import { AudioFormatService } from './audio-format.service';
import { WebVoiceGateway } from '../gateway/web-voice.gateway';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

export interface VoiceOrchestratorConfig {
  vadSilenceMs?: number;
  maxUtteranceMs?: number;
}

@Injectable()
export class VoiceOrchestratorService {
  private readonly logger = new Logger(VoiceOrchestratorService.name);
  private readonly sessions: Map<string, any> = new Map();

  constructor(
    private readonly conversationDbService: ConversationDbService,
    private readonly speechService: SpeechService,
    private readonly directAIService: DirectAIService,
    private readonly costCalculationService: CostCalculationService,
    private readonly audioFormatService: AudioFormatService,
    @Inject(forwardRef(() => WebVoiceGateway))
    private readonly webVoiceGateway: WebVoiceGateway,
    @Inject('userService') private readonly userServiceClient: ClientProxy,
  ) {}

  // Called when a new session starts; prepare per-session state
  async startSession(sessionId: string, config?: VoiceOrchestratorConfig) {
    this.logger.log(`Starting voice session: ${sessionId}`);
    this.sessions.set(sessionId, {
      buffers: [] as Buffer[],
      debounce: null as NodeJS.Timeout | null,
      vadSilenceMs: config?.vadSilenceMs ?? 600, // Reduced to 600ms for faster response after silence detected
      audioFormat: 'pcm16' as 'pcm16' | 'mulaw', // Track audio format for this session
      sampleRate: 16000, // Track sample rate for this session
      // Silence detection state
      silenceChunkCount: 0, // Count of consecutive silent chunks
      activeChunkCount: 0, // Count of chunks with audio activity
      lastAudioAmplitude: 0, // Last detected audio amplitude
      // Interrupt detection state
      isPlayingBack: false, // Flag to indicate if AI response is being played back
      playbackStartTime: 0, // Timestamp when playback started
      interruptThreshold: 1000, // Minimum amplitude to trigger interrupt (PCM16 scale)
      interruptChunkCount: 3, // Number of consecutive chunks above threshold to trigger interrupt
      consecutiveInterruptChunks: 0, // Current count of consecutive interrupt chunks
      lastInterruptTime: 0, // Last time an interrupt was detected
      playbackInterrupted: false, // Flag to track if current playback was interrupted
    });
  }

  // Handle incoming audio chunk (PCM/Opus base64) with optional format metadata
  async handleAudioChunk(
    sessionId: string,
    base64Chunk: string,
    format?: 'pcm16' | 'mulaw',
    sampleRate?: number,
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      this.logger.warn(`Session ${sessionId} not found when handling audio chunk`);
      throw new Error(`Session ${sessionId} not started. Call 'start' event first.`);
    }
    
    // Update format info if provided (from frontend metadata)
    if (format) {
      s.audioFormat = format;
    }
    if (sampleRate) {
      s.sampleRate = sampleRate;
    }
    
    const audioBuffer = Buffer.from(base64Chunk, 'base64');
    s.buffers.push(audioBuffer);
    
    // Calculate audio amplitude for silence/interrupt detection
    const amplitude = this.calculateAudioAmplitude(audioBuffer, s.audioFormat);
    s.lastAudioAmplitude = amplitude;
    
    // Check for interrupt during playback
    if (s.isPlayingBack) {
      await this.checkForInterrupt(sessionId, amplitude);
      // Still accumulate audio during interrupt (for processing after interrupt)
      this.logger.debug(`📥 Audio received during playback: amplitude=${amplitude}, interrupt chunks=${s.consecutiveInterruptChunks}`);
    } else {
      // Normal silence detection (when not playing back)
      const silenceThreshold = 300; // Lower threshold for better sensitivity (PCM16 scale)
      
      if (amplitude > silenceThreshold) {
        // Active audio detected - reset silence counter and cancel any pending finalization
        s.silenceChunkCount = 0;
        s.activeChunkCount++;
        
        // Reset debounce timer when we detect new audio (user is still speaking)
        if (s.debounce) {
          clearTimeout(s.debounce);
          s.debounce = null;
        }
      } else {
        // Silent chunk - increment silence counter
        s.silenceChunkCount++;
        
        // Only set debounce timer if we have enough active chunks (user spoke) and enough silence
        const minActiveChunks = 5; // Lower minimum: ~100ms of speech (more responsive)
        const minSilenceChunks = 15; // ~300ms of silence (faster response)
        
        if (s.activeChunkCount >= minActiveChunks && s.silenceChunkCount >= minSilenceChunks) {
          // User has spoken and now there's silence - start countdown to finalize
          if (!s.debounce) {
            // Only set timer if not already set (prevents multiple timers)
            s.debounce = setTimeout(() => {
              // Finalize after additional silence period
              this.logger.log(
                `⏰ Silence detected for session ${sessionId}, finalizing utterance (${s.buffers.length} buffers, ${s.activeChunkCount} active chunks, ${s.silenceChunkCount} silence chunks)`,
              );
              s.debounce = null; // Clear the timer reference
              this.finalizeUtterance(sessionId).catch((e) => {
                this.logger.error(`❌ Error finalizing utterance for session ${sessionId}: ${e.message}`);
              });
            }, s.vadSilenceMs);
          }
        }
      }
    }
    
    this.logger.debug(
      `📥 Received audio chunk for session ${sessionId}: ${audioBuffer.length} bytes (${s.audioFormat} ${s.sampleRate}Hz), amplitude=${amplitude}, silence=${s.silenceChunkCount}, active=${s.activeChunkCount}`,
    );
  }

  // Calculate audio amplitude from buffer (for silence/interrupt detection)
  private calculateAudioAmplitude(audioBuffer: Buffer, format: 'pcm16' | 'mulaw'): number {
    let sum = 0;
    let count = 0;
    
    if (format === 'pcm16') {
      // PCM16: 16-bit signed integers (little-endian)
      for (let i = 0; i < audioBuffer.length - 1; i += 2) {
        const sample = audioBuffer.readInt16LE(i);
        sum += Math.abs(sample);
        count++;
      }
    } else {
      // Mu-law: 8-bit encoded, decode to get amplitude
      for (let i = 0; i < audioBuffer.length; i++) {
        const muLaw = audioBuffer[i];
        // Simple approximation: check distance from mu-law silence (0x7f)
        const amplitude = Math.abs(muLaw - 0x7f) * 256; // Scale up for comparison
        sum += amplitude;
        count++;
      }
    }
    
    return count > 0 ? sum / count : 0;
  }

  // Check for interrupt during playback
  private async checkForInterrupt(sessionId: string, amplitude: number): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || !s.isPlayingBack) return;
    
    const currentTime = Date.now();
    const playbackBufferMs = 500; // Wait 500ms after playback starts before detecting interrupts
    const interruptCooldownMs = 1000; // Minimum 1 second between interrupts
    
    // Check if enough time has passed since playback started
    if (currentTime - s.playbackStartTime < playbackBufferMs) {
      return; // Too early, ignore
    }
    
    // Check cooldown period
    if (currentTime - s.lastInterruptTime < interruptCooldownMs) {
      return; // In cooldown, ignore
    }
    
    // Detect interrupt based on amplitude threshold
    if (amplitude > s.interruptThreshold) {
      s.consecutiveInterruptChunks++;
      
      if (s.consecutiveInterruptChunks >= s.interruptChunkCount) {
        // Interrupt detected!
        this.logger.log(`🚨 INTERRUPT DETECTED for session ${sessionId}! User started speaking during playback.`);
        
        // Stop current playback first
        await this.stopPlayback(sessionId);
        
        // Clear ALL buffers accumulated during playback (they may contain echo/mixed audio)
        // We'll start fresh with the interrupt audio
        this.logger.log(`🧹 Clearing ${s.buffers.length} buffers accumulated during playback to prevent audio mixing`);
        s.buffers = [];
        
        // Reset interrupt counters
        s.consecutiveInterruptChunks = 0;
        s.lastInterruptTime = currentTime;
        s.playbackInterrupted = true;
        s.isPlayingBack = false;
        
        // Reset silence detection for fresh interrupt processing
        s.silenceChunkCount = 0;
        s.activeChunkCount = 0;
        
        // Wait a brief moment for TTS cancellation and to accumulate fresh interrupt audio
        // Then process the interrupt (buffers will be filled with new interrupt audio)
        this.logger.log(`🔄 Processing interrupt audio for session ${sessionId}...`);
        
        // Small delay to ensure TTS sending is stopped and fresh interrupt audio is accumulated
        setTimeout(async () => {
          // Finalize the interrupt utterance (this will process the user's fresh interrupt speech)
          if (s.buffers.length > 0) {
            await this.finalizeUtterance(sessionId).catch((e) => {
              this.logger.error(`❌ Error processing interrupt utterance: ${e.message}`);
            });
          } else {
            this.logger.warn(`⚠️ No interrupt audio buffers to process for session ${sessionId}`);
          }
        }, 300); // 300ms delay to accumulate fresh interrupt audio (user's speech after interrupting)
      }
    } else {
      // Reset consecutive interrupt count if amplitude drops
      s.consecutiveInterruptChunks = 0;
    }
  }

  // Stop current playback
  private async stopPlayback(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    
    this.logger.log(`🛑 Stopping playback for session ${sessionId}`);
    s.isPlayingBack = false;
    s.playbackInterrupted = true;
    
    // Notify gateway to stop sending TTS frames
    this.webVoiceGateway.cancelTtsSending(sessionId);
    
    // Note: Buffer clearing is handled in checkForInterrupt() to ensure we clear
    // all playback-period buffers and start fresh with interrupt audio
  }

  // Finalize on end
  async endSession(sessionId: string): Promise<void> {
    this.logger.log(`Ending voice session (orchestrator): ${sessionId}`);
    const s = this.sessions.get(sessionId);
    
    // Stop any active playback
    if (s) {
      s.isPlayingBack = false;
      s.playbackInterrupted = true;
    }
    
    // Cancel any active TTS sending
    this.webVoiceGateway.cancelTtsSending(sessionId);
    
    // Clear timers and buffers
    if (s?.debounce) clearTimeout(s.debounce);
    
    // Don't finalize utterance on end - just clean up
    // User explicitly ended the session, don't process remaining audio
    if (s) {
      s.buffers = []; // Clear buffers
    }
    
    this.sessions.delete(sessionId);
    this.logger.log(`✅ Session ${sessionId} ended and cleaned up`);
  }

  // Test method: Handle text directly without STT (for testing)
  async handleTestText(sessionId: string, text: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      this.logger.warn(`⚠️ Session ${sessionId} not found when handling test text`);
      throw new Error(`Session ${sessionId} not started. Call 'start' event first.`);
    }
    
    if (!text || !text.trim()) {
      this.logger.warn(`⚠️ Empty test text provided for session ${sessionId}`);
      return;
    }

        this.logger.log(`🧪 Processing test text for session ${sessionId}: "${text}"`);

        // Use the same logic as finalizeUtterance but skip STT
        // NOTE: TTS will use system credentials (TTS_PROVIDER env var), NOT assistant config
    const userText = text.trim();
    
    // Persist user message
    await this.conversationDbService.sendMessage({
      conversationId: sessionId,
      role: 'user',
      content: userText,
      source: 'web-voice',
    } as any);

    // Build context from recent messages
    const history = await this.conversationDbService.getConversationMessages(sessionId, 1, 20);
    const context = history.map((m) => ({ role: m.role, content: m.content })).slice(-20);

    // Resolve assistant config and credentials
    // NOTE: Assistant config is used ONLY for LLM (modelConfig), NOT for STT/TTS
    // STT/TTS use system credentials (environment variables) for testing purposes
    const conv = await this.conversationDbService.getConversation(sessionId);
    const assistantId = (conv as any).assistantId;
    const organizationId = (conv as any).organizationId;
    const userId = (conv as any).userId;

    const assistantConfig = await this.getAssistantConfiguration(assistantId, organizationId, userId);
    // Credentials are used ONLY for LLM, NOT for STT/TTS
    const credentials = (await this.getCredentialsForAssistant(assistantConfig, userId, organizationId)) || undefined;

    // Knowledge Base first
    const kbConfig = assistantConfig.modelConfig?.knowledgeBase || assistantConfig.knowledgeBase;
    let assistantText = '';
    let msgCost: any = undefined;
    let usedKB = false;
    if (kbConfig?.fileIds?.length > 0) {
      try {
        const kbResults = await (
          await import('./knowledge-base-search.service')
        ).KnowledgeBaseSearchService.prototype.searchKnowledgeBase.call({} as any, userText, kbConfig.fileIds, organizationId, {
          similarityThreshold: 0.25,
          maxResultsPerFile: 5,
          maxTotalResults: 15,
          cacheTtlSeconds: 300,
        });
        const kbrs = kbResults as any[];
        if (kbrs.length > 0) {
          const should = (
            await import('./knowledge-base-response.service')
          ).KnowledgeBaseResponseService.prototype.shouldUseKnowledgeBase.call({} as any, kbrs);
          if (should) {
            const createFn = (await import('./knowledge-base-response.service')).KnowledgeBaseResponseService.prototype
              .createFineTunedResponse;
            const tuned = createFn.call({} as any, userText, kbrs, undefined) as any;
            assistantText = tuned?.content || '';
            usedKB = true;
          }
        }
      } catch {}
    }
    if (!assistantText) {
      // LLM response
      this.logger.log(`🤖 Generating AI response for session ${sessionId}...`);
      const ai = await this.directAIService.getDirectAIResponseWithAssistantConfig(
        userText,
        context,
        assistantConfig,
        undefined,
        credentials,
      );
      assistantText = ai.content;
      this.logger.log(`✅ AI response generated for session ${sessionId}: "${assistantText.substring(0, 100)}${assistantText.length > 100 ? '...' : ''}"`);
      const model = assistantConfig.modelConfig?.model || 'gpt';
      const provider = assistantConfig.modelConfig?.provider;
      const tokensAny: any = ai.tokens || {};
      const promptTokens = tokensAny.promptTokens ?? tokensAny.prompt ?? 0;
      const completionTokens = tokensAny.completionTokens ?? tokensAny.completion ?? 0;
      const totalTokens = tokensAny.totalTokens ?? tokensAny.total ?? promptTokens + completionTokens;
      const costBreakdown = this.costCalculationService.calculateCost(
        model,
        {
          promptTokens,
          completionTokens,
          totalTokens,
        },
        provider,
      );
      msgCost = costBreakdown?.totalCost;
    }

    await this.conversationDbService.sendMessage({
      conversationId: sessionId,
      role: 'assistant',
      content: assistantText,
      source: usedKB ? 'knowledge-base' : 'web-voice',
      processingTime: 0,
      cost: msgCost,
      metadata: {},
    } as any);

    // TTS and send frames - Uses SYSTEM CREDENTIALS (environment variables), NOT assistant config
    // For testing: We explicitly use TTS_PROVIDER env var, ignoring assistantConfig.voice
    const ttsProvider = this.speechService.getTTSProvider(); // Returns TTS_PROVIDER env var
    this.logger.log(`🎙️ Generating TTS for session ${sessionId}...`);
    this.logger.debug(`🎙️ TTS Provider Source: Environment Variable (TTS_PROVIDER=${ttsProvider}), NOT from assistant config`);
    this.logger.debug(`🎙️ Voice Config (from assistant): ${JSON.stringify(assistantConfig?.voice || {})} - NOT USED for TTS`);
    const ttsBuffer = await this.speechService.createAudioFileFromText(assistantText);
    this.logger.log(`✅ TTS generated for session ${sessionId}: ${ttsBuffer.length} bytes`);
    this.logger.log(`📤 Sending TTS frames to client for session ${sessionId}...`);
    await this.webVoiceGateway.sendTtsFrames(sessionId, ttsBuffer);
    this.logger.log(`✅ TTS frames sent to client for session ${sessionId}`);
  }

  // Synthesize and stream a text message to the client (testing/welcome)
  async speak(sessionId: string, text: string): Promise<void> {
    if (!text || !text.trim()) {
      this.logger.warn(`⚠️ Empty text provided to speak() for session ${sessionId}`);
      return;
    }
    try {
      const s = this.sessions.get(sessionId);
      if (s) {
        // Mark as playing back
        s.isPlayingBack = true;
        s.playbackStartTime = Date.now();
        s.playbackInterrupted = false;
        s.consecutiveInterruptChunks = 0;
      }
      
      this.logger.log(`🎙️ Generating TTS for session ${sessionId}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
      const ttsBuffer = await this.speechService.createAudioFileFromText(text);
      this.logger.log(`✅ TTS generated for session ${sessionId}: ${ttsBuffer.length} bytes`);
      
      // Check if playback was interrupted before sending
      if (s && s.playbackInterrupted) {
        this.logger.log(`⚠️ Playback was interrupted, skipping TTS for session ${sessionId}`);
        return;
      }
      
      await this.webVoiceGateway.sendTtsFrames(sessionId, ttsBuffer);
      
      // Mark playback as finished after a delay (approximate playback duration)
      if (s) {
        // Estimate playback duration: ~8000 bytes/sec for mu-law 8kHz, ~32000 bytes/sec for PCM16 16kHz
        const estimatedDuration = ttsBuffer.length / 32000 * 1000; // Convert to ms
        setTimeout(() => {
          if (s.isPlayingBack && !s.playbackInterrupted) {
            s.isPlayingBack = false;
            this.logger.debug(`✅ Playback finished for session ${sessionId}`);
          }
        }, estimatedDuration);
      }
    } catch (e) {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.isPlayingBack = false;
      }
      this.logger.error(`❌ speak() failed for ${sessionId}: ${(e as any)?.message || e}`);
      throw e; // Re-throw to let the caller know it failed
    }
  }

  private async finalizeUtterance(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) {
      this.logger.warn(`⚠️ Cannot finalize utterance: session ${sessionId} not found`);
      return;
    }
    const audio = Buffer.concat(s.buffers);
    s.buffers = [];
    
    // Reset silence detection state for next utterance
    s.silenceChunkCount = 0;
    s.activeChunkCount = 0;
    s.lastAudioAmplitude = 0;
    
    if (!audio || audio.length === 0) {
      this.logger.warn(`⚠️ Cannot finalize utterance: no audio data for session ${sessionId}`);
      return;
    }

    this.logger.log(`🎙️ Finalizing utterance for session ${sessionId}: ${audio.length} bytes`);

    // Normalize audio format for STT (backend handles any format → mu-law 8kHz)
    // Use session's format info if available
    const normalizedAudio = this.audioFormatService.normalizeForSTT(audio, {
      format: s.audioFormat,
      sampleRate: s.sampleRate,
    });
    this.logger.log(
      `🔧 Normalized audio for STT: ${audio.length} bytes (${s.audioFormat} ${s.sampleRate}Hz) → ${normalizedAudio.length} bytes (mu-law 8kHz)`,
    );

    // STT - Uses SYSTEM CREDENTIALS (environment variables), NOT assistant config
    // For testing: We explicitly use STT_PROVIDER env var, ignoring assistantConfig.transcriber
    const sttProvider = this.speechService.getSTTProvider(); // Returns STT_PROVIDER env var
    this.logger.log(`🔊 Starting STT transcription (${sttProvider}) for session ${sessionId}...`);
    this.logger.debug(`🔊 STT Provider Source: Environment Variable (STT_PROVIDER=${sttProvider}), NOT from assistant config`);
    
    const userText = (await this.speechService.transcribe(normalizedAudio, sttProvider)).trim();
    if (!userText) {
      this.logger.warn(`⚠️ STT returned empty transcription for session ${sessionId}`);
      this.logger.warn(`⚠️ Audio may be in wrong format or too quiet/noise-like`);
      // Check if audio is mostly zeros/silence
      const audioArray = Array.from(audio);
      const nonZeroBytes = audioArray.filter(b => b !== 0 && b !== 0xff).length;
      const zeroPercentage = ((audio.length - nonZeroBytes) / audio.length) * 100;
      this.logger.warn(`⚠️ Audio analysis: ${nonZeroBytes}/${audio.length} non-zero bytes (${zeroPercentage.toFixed(1)}% silence)`);
      return;
    }
    this.logger.log(`✅ STT transcription for session ${sessionId}: "${userText}"`);

    // Persist user message
    await this.conversationDbService.sendMessage({
      conversationId: sessionId,
      role: 'user',
      content: userText,
      source: 'web-voice',
    } as any);

    // Build context from recent messages
    const history = await this.conversationDbService.getConversationMessages(sessionId, 1, 20);
    const context = history.map((m) => ({ role: m.role, content: m.content })).slice(-20);

    // Resolve assistant config and credentials
    // NOTE: Assistant config is used ONLY for LLM (modelConfig), NOT for STT/TTS
    // STT/TTS use system credentials (environment variables) for testing purposes
    const conv = await this.conversationDbService.getConversation(sessionId);
    const assistantId = (conv as any).assistantId;
    const organizationId = (conv as any).organizationId;
    const userId = (conv as any).userId;

    const assistantConfig = await this.getAssistantConfiguration(assistantId, organizationId, userId);
    // Credentials are used ONLY for LLM, NOT for STT/TTS
    const credentials = (await this.getCredentialsForAssistant(assistantConfig, userId, organizationId)) || undefined;

    // Knowledge Base first
    const kbConfig = assistantConfig.modelConfig?.knowledgeBase || assistantConfig.knowledgeBase;
    let assistantText = '';
    let msgCost: any = undefined;
    let usedKB = false;
    if (kbConfig?.fileIds?.length > 0) {
      try {
        const kbResults = await (
          await import('./knowledge-base-search.service')
        ).KnowledgeBaseSearchService.prototype.searchKnowledgeBase.call({} as any, userText, kbConfig.fileIds, organizationId, {
          similarityThreshold: 0.25,
          maxResultsPerFile: 5,
          maxTotalResults: 15,
          cacheTtlSeconds: 300,
        });
        const kbrs = kbResults as any[];
        if (kbrs.length > 0) {
          const should = (
            await import('./knowledge-base-response.service')
          ).KnowledgeBaseResponseService.prototype.shouldUseKnowledgeBase.call({} as any, kbrs);
          if (should) {
            // Create tuned response
            const createFn = (await import('./knowledge-base-response.service')).KnowledgeBaseResponseService.prototype
              .createFineTunedResponse;
            const tuned = createFn.call({} as any, userText, kbrs, undefined) as any;
            assistantText = tuned?.content || '';
            usedKB = true;
          }
        }
      } catch {}
    }
    if (!assistantText) {
      // LLM response (non-stream for now)
      this.logger.log(`🤖 Generating AI response for session ${sessionId}...`);
      const ai = await this.directAIService.getDirectAIResponseWithAssistantConfig(
        userText,
        context,
        assistantConfig,
        undefined,
        credentials,
      );
      assistantText = ai.content;
      this.logger.log(`✅ AI response generated for session ${sessionId}: "${assistantText.substring(0, 100)}${assistantText.length > 100 ? '...' : ''}"`);
      const model = assistantConfig.modelConfig?.model || 'gpt';
      const provider = assistantConfig.modelConfig?.provider;
      const tokensAny: any = ai.tokens || {};
      const promptTokens = tokensAny.promptTokens ?? tokensAny.prompt ?? 0;
      const completionTokens = tokensAny.completionTokens ?? tokensAny.completion ?? 0;
      const totalTokens = tokensAny.totalTokens ?? tokensAny.total ?? promptTokens + completionTokens;
      const costBreakdown = this.costCalculationService.calculateCost(
        model,
        {
          promptTokens,
          completionTokens,
          totalTokens,
        },
        provider,
      );
      msgCost = costBreakdown?.totalCost;
    }

    await this.conversationDbService.sendMessage({
      conversationId: sessionId,
      role: 'assistant',
      content: assistantText,
      source: usedKB ? 'knowledge-base' : 'web-voice',
      processingTime: 0,
      cost: msgCost,
      metadata: {},
    } as any);

    // TTS and send frames - Uses SYSTEM CREDENTIALS (environment variables), NOT assistant config
    // For testing: We explicitly use TTS_PROVIDER env var, ignoring assistantConfig.voice
    const ttsProvider = this.speechService.getTTSProvider(); // Returns TTS_PROVIDER env var
    this.logger.log(`🎙️ Generating TTS for session ${sessionId}...`);
    this.logger.debug(`🎙️ TTS Provider Source: Environment Variable (TTS_PROVIDER=${ttsProvider}), NOT from assistant config`);
    this.logger.debug(`🎙️ Voice Config (from assistant): ${JSON.stringify(assistantConfig?.voice || {})} - NOT USED for TTS`);
    
    // Mark as playing back before generating TTS (reset interrupt flag for new response)
    if (s) {
      // Reset interrupt flag - this is a new response after interrupt was processed
      s.isPlayingBack = true;
      s.playbackStartTime = Date.now();
      s.playbackInterrupted = false; // Reset - allow new response to play
      s.consecutiveInterruptChunks = 0;
      this.logger.debug(`🔄 Starting new TTS playback for session ${sessionId} (interrupt flag reset)`);
    }
    
    const ttsBuffer = await this.speechService.createAudioFileFromText(assistantText);
    this.logger.log(`✅ TTS generated for session ${sessionId}: ${ttsBuffer.length} bytes`);
    
    // Double-check playback wasn't interrupted during TTS generation (shouldn't happen, but safety check)
    if (s && s.playbackInterrupted && s.isPlayingBack) {
      this.logger.log(`⚠️ Playback was interrupted during TTS generation, skipping TTS send for session ${sessionId}`);
      return;
    }
    
    this.logger.log(`📤 Sending TTS frames to client for session ${sessionId}...`);
    await this.webVoiceGateway.sendTtsFrames(sessionId, ttsBuffer);
    this.logger.log(`✅ TTS frames sent to client for session ${sessionId}`);
    
    // Mark playback as finished after estimated duration
    if (s) {
      const estimatedDuration = ttsBuffer.length / 32000 * 1000; // Convert to ms
      setTimeout(() => {
        if (s.isPlayingBack && !s.playbackInterrupted) {
          s.isPlayingBack = false;
          this.logger.debug(`✅ Playback finished for session ${sessionId}`);
        }
      }, estimatedDuration);
    }
  }

  private async getAssistantConfiguration(assistantId: string, organizationId: string, userId: string): Promise<any> {
    const resp: any = await firstValueFrom(
      this.userServiceClient.send('getAssistantById', { requestedUser: { _id: userId }, assistantId, organizationId }),
    );
    return resp?.data?.result || { modelConfig: {} };
  }

  private async getCredentialsForAssistant(
    assistantConfig: any,
    userId: string,
    organizationId: string,
  ): Promise<Record<string, any> | null> {
    const response: any = await firstValueFrom(
      this.userServiceClient.send('getProviderCredentials', {
        organizationId,
        requestingUserId: userId,
        userId,
        serviceType: 'llm',
      }),
    );
    const creds = response?.data?.result;
    if (!creds?.llm?.length) return null;
    const map: Record<string, string> = {
      openai: 'openaiApiKey',
      anthropic: 'anthropicApiKey',
      groq: 'groqApiKey',
      'together-ai': 'togetherApiKey',
      anyscale: 'anyscaleApiKey',
      google: 'googleApiKey',
    };
    const out: Record<string, any> = {};
    for (const item of creds.llm) {
      if (map[item.providerName] && item.credentials?.apiKey) out[map[item.providerName]] = item.credentials.apiKey;
    }
    return Object.keys(out).length ? out : null;
  }
}
