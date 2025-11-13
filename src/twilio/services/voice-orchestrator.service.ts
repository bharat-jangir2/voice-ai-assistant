import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConversationDbService } from './conversation-db.service';
import { SpeechService } from './speech.service';
import { DirectAIService } from './direct-ai.service';
import { CostCalculationService } from './cost-calculation.service';
import { AudioFormatService } from './audio-format.service';
import { VoiceActivityDetectorService, VADResult } from './voice-activity-detector.service';
import { StreamingSTTService } from './streaming-stt.service';
import { WebVoiceGateway } from '../gateway/web-voice.gateway';
import { AssistantConfigCacheService } from './assistant-config-cache.service';
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

  // Optimized silence detection configuration for faster, more natural conversations
  private readonly QUICK_SILENCE_CONFIG = {
    minActiveChunks: 3, // ~60ms of speech (reduced from 5 = 100ms)
    minSilenceChunks: 10, // ~200ms of silence (reduced from 15 = 300ms)
    vadSilenceMs: 200, // Additional silence period (reduced from 600ms)
    silenceThreshold: 250, // Slightly lower threshold for better sensitivity (reduced from 300)
    maxBufferChunks: 200, // Prevent memory leaks in long sessions
  };

  // PHASE 3: Enhanced interrupt detection configuration for faster, more responsive interrupts
  private readonly ENHANCED_INTERRUPT_CONFIG = {
    quickInterruptThreshold: 500, // Lower threshold for faster interrupt detection (was 1000)
    instantInterruptChunks: 2, // Faster detection - only 2 chunks needed (was 3)
    playbackBufferMs: 100, // Reduced grace period after playback starts (was 500ms)
    interruptCooldownMs: 800, // Slightly reduced cooldown (was 1000ms)
    exponentialDecayFactor: 0.9, // Smoother decay for interrupt detection
  };

  constructor(
    private readonly conversationDbService: ConversationDbService,
    private readonly speechService: SpeechService,
    private readonly directAIService: DirectAIService,
    private readonly costCalculationService: CostCalculationService,
    private readonly audioFormatService: AudioFormatService,
    private readonly vadService: VoiceActivityDetectorService,
    private readonly streamingSTTService: StreamingSTTService,
    private readonly assistantConfigCache: AssistantConfigCacheService,
    @Inject(forwardRef(() => WebVoiceGateway))
    private readonly webVoiceGateway: WebVoiceGateway,
    @Inject('userService') private readonly userServiceClient: ClientProxy,
  ) {}

  // Called when a new session starts; prepare per-session state
  async startSession(sessionId: string, config?: VoiceOrchestratorConfig) {
    this.logger.log(`Starting voice session: ${sessionId}`);

    // Pre-fetch and cache assistant config for this session
    let assistantConfig: any = null;
    let assistantId: string | null = null;
    let organizationId: string | null = null;
    let userId: string | null = null;

    try {
      const conv = await this.conversationDbService.getConversation(sessionId);
      if (conv) {
        assistantId = (conv as any).assistantId;
        organizationId = (conv as any).organizationId;
        userId = (conv as any).userId;

        if (assistantId && organizationId && userId) {
          // Fetch and cache assistant config at session start
          assistantConfig = await this.assistantConfigCache.getAssistantConfiguration(assistantId, organizationId, userId);
          this.logger.log(`✅ Pre-cached assistant config for session ${sessionId}`);
        }
      }
    } catch (error) {
      this.logger.warn(`⚠️ Could not pre-cache assistant config for session ${sessionId}: ${(error as any)?.message}`);
    }

    // Use centralized session creation method
    const session = this.createSession(sessionId, config, {
      assistantConfig,
      assistantId,
      organizationId,
      userId,
    });

    this.sessions.set(sessionId, session);
  }

  // Enhanced session interface - centralized session creation
  private createSession(
    sessionId: string,
    config?: VoiceOrchestratorConfig,
    metadata?: {
      assistantConfig?: any;
      assistantId?: string | null;
      organizationId?: string | null;
      userId?: string | null;
    },
  ): any {
    return {
      buffers: [] as Buffer[],
      debounce: null as NodeJS.Timeout | null,
      audioFormat: 'pcm16' as 'pcm16' | 'mulaw',
      sampleRate: 16000,
      // Speech state
      silenceChunkCount: 0,
      activeChunkCount: 0,
      lastAudioAmplitude: 0,
      lastIsSpeech: false, // Track speech transitions for better endpointing
      // Playback state
      isPlayingBack: false,
      playbackStartTime: 0,
      interruptThreshold: this.ENHANCED_INTERRUPT_CONFIG.quickInterruptThreshold,
      interruptChunkCount: this.ENHANCED_INTERRUPT_CONFIG.instantInterruptChunks,
      consecutiveInterruptChunks: 0,
      lastInterruptTime: 0,
      playbackInterrupted: false,
      // STT state
      streamingSTT: null as any,
      lastVADResult: null as VADResult | null,
      // Config
      vadSilenceMs: config?.vadSilenceMs ?? this.QUICK_SILENCE_CONFIG.vadSilenceMs,
      cachedAssistantConfig: metadata?.assistantConfig ?? null,
      assistantId: metadata?.assistantId ?? null,
      organizationId: metadata?.organizationId ?? null,
      userId: metadata?.userId ?? null,
    };
  }

  // Handle incoming audio chunk (PCM/Opus base64) with optional format metadata
  // PHASE 2: Now uses VAD (Voice Activity Detection) instead of simple amplitude checks
  async handleAudioChunk(sessionId: string, base64Chunk: string, format?: 'pcm16' | 'mulaw', sampleRate?: number): Promise<void> {
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

    // PHASE 2: Use VAD instead of simple amplitude check
    const vadResult = await this.vadService.analyzeAudioChunk(audioBuffer, s.audioFormat);
    s.lastVADResult = vadResult;
    s.lastAudioAmplitude = vadResult.amplitude;

    // Track speech transitions for better endpointing
    const wasSpeech = s.lastIsSpeech;
    s.lastIsSpeech = vadResult.isSpeech;

    this.logger.debug(
      `📥 Audio: ${audioBuffer.length} bytes, VAD: ${vadResult.isSpeech}, confidence: ${vadResult.confidence.toFixed(2)}`,
    );

    // Check for interrupt during playback FIRST
    if (s.isPlayingBack) {
      await this.checkForInterrupt(sessionId, vadResult.amplitude);
      return;
    }

    // Normal speech/silence processing
    if (vadResult.isSpeech) {
      await this.handleSpeechChunk(sessionId, audioBuffer, vadResult);
    } else {
      await this.handleSilenceChunk(sessionId, audioBuffer, vadResult, wasSpeech);
    }
  }

  /**
   * Handle speech chunk (user is speaking)
   * PHASE 2: VAD-based speech handling with streaming STT
   */
  private async handleSpeechChunk(sessionId: string, audioBuffer: Buffer, vadResult: VADResult): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;

    // Only process high-confidence speech
    if (vadResult.confidence < 0.6) {
      this.logger.debug(`⚠️ Low confidence speech: ${vadResult.confidence.toFixed(2)}`);
      return;
    }

    // Reset silence counter and increment active counter
    s.silenceChunkCount = 0;
    s.activeChunkCount++;

    // Cancel any pending finalization
    if (s.debounce) {
      clearTimeout(s.debounce);
      s.debounce = null;
    }

    // Add to buffer with memory management
    s.buffers.push(audioBuffer);

    // Prevent memory leaks in long sessions
    if (s.buffers.length > this.QUICK_SILENCE_CONFIG.maxBufferChunks) {
      const excess = s.buffers.length - this.QUICK_SILENCE_CONFIG.maxBufferChunks;
      s.buffers = s.buffers.slice(excess);
      this.logger.debug(`🗜️ Trimmed ${excess} buffers to prevent memory growth`);
    }

    // Start streaming STT if not already started
    if (!s.streamingSTT) {
      await this.startStreamingSTT(sessionId);
    }

    // Send to streaming STT with error handling
    if (s.streamingSTT) {
      try {
        await this.streamingSTTService.sendAudio(sessionId, audioBuffer);
      } catch (error) {
        this.logger.error(`❌ Streaming STT error: ${error.message}`);
        // Continue processing without STT
      }
    }
  }

  /**
   * Handle silence chunk (user is not speaking)
   * PHASE 2: VAD-based silence handling with intelligent finalization
   */
  private async handleSilenceChunk(
    sessionId: string,
    audioBuffer: Buffer,
    vadResult: VADResult,
    wasSpeech: boolean,
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;

    s.silenceChunkCount++;
    s.buffers.push(audioBuffer); // Include silence for natural endpointing

    // Adaptive finalization based on confidence
    let finalizationDelay = s.vadSilenceMs;
    if (vadResult.confidence < 0.7) {
      finalizationDelay *= 1.5; // Extend for low confidence
    }

    // VAD-based finalization (preferred)
    if (vadResult.shouldFinalize && s.activeChunkCount >= 2) {
      this.scheduleFinalization(sessionId, 'vad', finalizationDelay, vadResult.confidence);
      return;
    }

    // Speech-to-silence transition detection
    if (wasSpeech && !vadResult.isSpeech) {
      this.logger.debug(`🔄 Speech → Silence transition detected`);
    }

    // Fallback: Chunk-based finalization
    const { minActiveChunks, minSilenceChunks } = this.QUICK_SILENCE_CONFIG;
    if (s.activeChunkCount >= minActiveChunks && s.silenceChunkCount >= minSilenceChunks) {
      this.scheduleFinalization(sessionId, 'chunk-based', finalizationDelay);
    }
  }

  /**
   * Start streaming STT session
   * PHASE 2: Initialize real-time transcription
   */
  private async startStreamingSTT(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;

    try {
      await this.streamingSTTService.startStreamingSession(sessionId);
      s.streamingSTT = true; // Mark as active

      // Set up event listeners for partial transcripts (for real-time UI updates)
      this.streamingSTTService.onTranscript(sessionId, (transcript: string, isFinal: boolean) => {
        this.logger.debug(`📝 Transcript event for session ${sessionId} (final=${isFinal}): "${transcript}"`);

        // Emit transcription event to client via WebVoiceGateway
        this.webVoiceGateway.emitTranscription(sessionId, {
          text: transcript,
          isFinal,
          role: 'user',
          timestamp: Date.now(),
        });
      });

      this.logger.debug(`🎤 Started streaming STT for session ${sessionId}`);
    } catch (error) {
      this.logger.error(`❌ Failed to start streaming STT for session ${sessionId}: ${error.message}`);
      // Continue without streaming STT (fallback to batch processing)
    }
  }

  private scheduleFinalization(sessionId: string, type: string, delayMs: number, confidence?: number): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.debounce) return;

    s.debounce = setTimeout(async () => {
      // Clear immediately and validate session
      s.debounce = null;

      const currentSession = this.sessions.get(sessionId);
      if (!currentSession) {
        this.logger.warn(`Session ${sessionId} ended during finalization`);
        return;
      }

      this.logger.log(
        `⏰ ${type} finalization: ${currentSession.buffers.length} buffers` +
          (confidence ? `, confidence: ${confidence.toFixed(2)}` : ''),
      );
      try {
        await this.finalizeUtterance(sessionId);
      } catch (error) {
        this.logger.error(`❌ Finalization error: ${error.message}`);
      }
    }, delayMs);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  // PHASE 3: Enhanced interrupt detection with faster response and exponential decay
  private async checkForInterrupt(sessionId: string, amplitude: number): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || !s.isPlayingBack) return;

    const currentTime = Date.now();
    const { playbackBufferMs, interruptCooldownMs, exponentialDecayFactor } = this.ENHANCED_INTERRUPT_CONFIG;

    // Timing constraints
    if (currentTime - s.playbackStartTime < playbackBufferMs) return;
    if (currentTime - s.lastInterruptTime < interruptCooldownMs) return;

    // Enhanced interrupt detection with exponential decay
    if (amplitude > s.interruptThreshold) {
      s.consecutiveInterruptChunks++;

      if (s.consecutiveInterruptChunks >= s.interruptChunkCount) {
        await this.handleInstantInterrupt(sessionId);
      }
    } else {
      // Exponential decay instead of linear
      s.consecutiveInterruptChunks *= exponentialDecayFactor;
      if (s.consecutiveInterruptChunks < 0.1) {
        s.consecutiveInterruptChunks = 0;
      }
    }
  }

  /**
   * PHASE 3: Handle instant interrupt with optimized processing
   */
  private async handleInstantInterrupt(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;

    this.logger.log(`🚨 INSTANT INTERRUPT DETECTED for session ${sessionId}`);

    // Atomic state change
    s.playbackInterrupted = true;
    s.isPlayingBack = false;
    s.lastInterruptTime = Date.now();

    // Stop playback and preserve interrupted buffers for debugging
    const interruptedBuffers = [...s.buffers];
    await this.stopPlayback(sessionId);

    s.buffers = [];
    s.consecutiveInterruptChunks = 0;
    s.silenceChunkCount = 0;
    s.activeChunkCount = 0;
    this.logger.log(`🧹 Cleared ${interruptedBuffers.length} buffers from interrupted playback`);

    // Wait for fresh audio accumulation
    await this.delay(200);

    // Critical: Re-validate session after delay
    const currentSession = this.sessions.get(sessionId);
    if (!currentSession) {
      this.logger.warn(`Session ${sessionId} ended during interrupt processing`);
      return;
    }

    // Process fresh interrupt audio
    if (currentSession.buffers.length > 0) {
      this.logger.log(`🔄 Processing ${currentSession.buffers.length} interrupt audio buffers`);
      await this.finalizeUtterance(sessionId).catch((e) => {
        this.logger.error(`❌ Error processing interrupt utterance: ${e.message}`);
      });
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

    // PHASE 2: Clean up streaming STT session
    if (s?.streamingSTT) {
      try {
        await this.streamingSTTService.endStreamingSession(sessionId);
      } catch (error) {
        this.logger.error(`Error ending streaming STT session ${sessionId}: ${error.message}`);
      }
    }

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
      this.logger.log(
        `✅ AI response generated for session ${sessionId}: "${assistantText.substring(0, 100)}${assistantText.length > 100 ? '...' : ''}"`,
      );
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
      // Format cost to 4 decimal places before storing
      if (costBreakdown?.totalCost) {
        msgCost = {
          ...costBreakdown.totalCost,
          amount: parseFloat(Number(costBreakdown.totalCost.amount || 0).toFixed(4)),
        };
      }
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

    // Emit assistant response transcription event to client (for real-time UI updates)
    if (assistantText && assistantText.trim()) {
      this.webVoiceGateway.emitTranscription(sessionId, {
        text: assistantText.trim(),
        isFinal: true,
        role: 'assistant',
        timestamp: Date.now(),
      });
    } else {
      this.logger.warn(`⚠️ Cannot emit transcription: assistantText is empty for session ${sessionId}`);
    }

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

      // Emit assistant response transcription event to client (for real-time UI updates)
      // This is used for welcome messages and direct speak() calls
      const trimmedText = text.trim();
      if (trimmedText) {
        this.webVoiceGateway.emitTranscription(sessionId, {
          text: trimmedText,
          isFinal: true,
          role: 'assistant',
          timestamp: Date.now(),
        });
      } else {
        this.logger.warn(`⚠️ Cannot emit transcription: text is empty for session ${sessionId} in speak()`);
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
        const estimatedDuration = (ttsBuffer.length / 32000) * 1000; // Convert to ms
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
      // PHASE 2: Still try to get transcript from streaming STT if available
      if (s.streamingSTT) {
        const finalTranscript = await this.streamingSTTService.finalizeTranscript(sessionId);
        if (finalTranscript) {
          await this.processUserMessage(sessionId, finalTranscript);
        }
      }
      return;
    }

    this.logger.log(`🎙️ Finalizing utterance for session ${sessionId}: ${audio.length} bytes`);

    // PHASE 2: Try to get transcript from streaming STT first (faster, already processed)
    let userText: string | null = null;

    if (s.streamingSTT) {
      // Finalize streaming STT and get transcript
      userText = await this.streamingSTTService.finalizeTranscript(sessionId);
      if (userText) {
        this.logger.log(`✅ Got transcript from streaming STT for session ${sessionId}: "${userText}"`);
      } else {
        this.logger.warn(`⚠️ Streaming STT returned empty transcript, falling back to batch STT`);
      }
    }

    // Fallback to batch STT if streaming STT didn't provide transcript
    if (!userText) {
      // Normalize audio format for STT (backend handles any format → mu-law 8kHz)
      const normalizedAudio = this.audioFormatService.normalizeForSTT(audio, {
        format: s.audioFormat,
        sampleRate: s.sampleRate,
      });
      this.logger.log(
        `🔧 Normalized audio for STT: ${audio.length} bytes (${s.audioFormat} ${s.sampleRate}Hz) → ${normalizedAudio.length} bytes (mu-law 8kHz)`,
      );

      // STT - Uses SYSTEM CREDENTIALS (environment variables), NOT assistant config
      const sttProvider = this.speechService.getSTTProvider();
      this.logger.log(`🔊 Starting batch STT transcription (${sttProvider}) for session ${sessionId}...`);

      userText = (await this.speechService.transcribe(normalizedAudio, sttProvider)).trim();

      // Emit final transcript from batch STT (fallback case)
      if (userText) {
        this.webVoiceGateway.emitTranscription(sessionId, {
          text: userText,
          isFinal: true,
          role: 'user',
          timestamp: Date.now(),
        });
      }
    }
    if (!userText) {
      this.logger.warn(`⚠️ STT returned empty transcription for session ${sessionId}`);
      this.logger.warn(`⚠️ Audio may be in wrong format or too quiet/noise-like`);
      // Check if audio is mostly zeros/silence
      const audioArray = Array.from(audio);
      const nonZeroBytes = audioArray.filter((b) => b !== 0 && b !== 0xff).length;
      const zeroPercentage = ((audio.length - nonZeroBytes) / audio.length) * 100;
      this.logger.warn(
        `⚠️ Audio analysis: ${nonZeroBytes}/${audio.length} non-zero bytes (${zeroPercentage.toFixed(1)}% silence)`,
      );
      // PHASE 2: Clean up streaming STT session
      if (s.streamingSTT) {
        await this.streamingSTTService.endStreamingSession(sessionId);
        s.streamingSTT = null;
      }
      return;
    }
    this.logger.log(`✅ STT transcription for session ${sessionId}: "${userText}"`);

    // PHASE 2: Clean up streaming STT session
    if (s.streamingSTT) {
      await this.streamingSTTService.endStreamingSession(sessionId);
      s.streamingSTT = null;
    }

    // Process user message (save to DB and generate AI response)
    await this.processUserMessage(sessionId, userText);
  }

  /**
   * Process user message: save to DB and generate AI response
   * Extracted to separate method for reuse
   */
  private async processUserMessage(sessionId: string, userText: string): Promise<void> {
    // Get session for playback state management
    const s = this.sessions.get(sessionId);

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
      this.logger.log(
        `✅ AI response generated for session ${sessionId}: "${assistantText.substring(0, 100)}${assistantText.length > 100 ? '...' : ''}"`,
      );
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
      // Format cost to 4 decimal places before storing
      if (costBreakdown?.totalCost) {
        msgCost = {
          ...costBreakdown.totalCost,
          amount: parseFloat(Number(costBreakdown.totalCost.amount || 0).toFixed(4)),
        };
      }
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

    // Emit assistant response transcription event to client (for real-time UI updates)
    if (assistantText && assistantText.trim()) {
      this.webVoiceGateway.emitTranscription(sessionId, {
        text: assistantText.trim(),
        isFinal: true,
        role: 'assistant',
        timestamp: Date.now(),
      });
    } else {
      this.logger.warn(`⚠️ Cannot emit transcription: assistantText is empty for session ${sessionId} in processUserMessage()`);
    }

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
      const estimatedDuration = (ttsBuffer.length / 32000) * 1000; // Convert to ms
      setTimeout(() => {
        if (s.isPlayingBack && !s.playbackInterrupted) {
          s.isPlayingBack = false;
          this.logger.debug(`✅ Playback finished for session ${sessionId}`);
        }
      }, estimatedDuration);
    }
  }

  // DEPRECATED: Use assistantConfigCache.getAssistantConfiguration() instead
  // Keeping for backward compatibility, but should use cache service
  private async getAssistantConfiguration(assistantId: string, organizationId: string, userId: string): Promise<any> {
    return this.assistantConfigCache.getAssistantConfiguration(assistantId, organizationId, userId);
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
