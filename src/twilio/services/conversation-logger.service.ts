import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { EmailService } from './email.service';

/**
 * Interface for a single conversation interaction
 */
export interface ConversationInteraction {
  timestamp: string;
  question: string; // User's question after correction
  correction: boolean; // Whether any correction was applied
  answer: string; // Final answer sent to user
  source: {
    type: 'Redis' | string; // Dynamic string for Qdrant confidence levels
    context?: string[]; // Context documents if applicable
  };
  error?: string; // Error message if any
}

/**
 * Interface for a complete conversation session
 */
export interface ConversationSession {
  sessionId: string;
  assistantType: string;
  startTime: string;
  lastUpdateTime: string;
  totalInteractions: number;
  interactions: ConversationInteraction[];
  metadata: {
    phoneNumber?: string;
    callDuration?: number;
    errorCount: number;
    averageSearchTime: number;
    averageResponseTime: number;
  };
}

/**
 * Service for logging complete conversation sessions
 */
@Injectable()
export class ConversationLoggerService implements OnModuleInit {
  private readonly logger = new Logger(ConversationLoggerService.name);
  private readonly logDirectory: string;
  private readonly sessionCache: Map<string, ConversationSession> = new Map();
  private readonly qdrantHighConfidenceScore: number; // Configurable high confidence threshold for Qdrant
  private readonly qdrantLowConfidenceScore: number; // Configurable low confidence threshold for Qdrant

  constructor(
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {
    // Create logs directory in project root
    this.logDirectory = path.join(process.cwd(), 'logs', 'conversations');
    this.ensureLogDirectory();

    // Initialize Qdrant confidence score thresholds
    this.qdrantHighConfidenceScore = parseFloat(this.configService.get<string>('QDRANT_HIGH_CONFIDENCE_SCORE') || '0.5');
    this.qdrantLowConfidenceScore = parseFloat(this.configService.get<string>('QDRANT_LOW_CONFIDENCE_SCORE') || '0.2');
    this.logger.log(
      `ConversationLoggerService initialized with Qdrant high confidence score threshold: ${this.qdrantHighConfidenceScore}, low confidence score threshold: ${this.qdrantLowConfidenceScore}`,
    );
  }

  /**
   * Initialize cleanup on module start
   */
  async onModuleInit() {
    this.logger.log('🧹 [CLEANUP] Initializing conversation logger service...');

    // Run cleanup in background to avoid blocking startup
    this.performCleanup().catch(err => {
      this.logger.error('Background cleanup failed:', err);
    });
    
    this.logger.log('✅ [CLEANUP] Conversation logger service initialized');
  }

  /**
   * Perform cleanup operations
   */
  private async performCleanup() {
    // Clean up any old sessions that might have been left behind
    await this.cleanupOldSessions();

    this.logger.log('✅ [CLEANUP] Conversation logger service initialized');
  }

  /**
   * Ensures the log directory exists
   */
  private ensureLogDirectory(): void {
    try {
      if (!fs.existsSync(this.logDirectory)) {
        fs.mkdirSync(this.logDirectory, { recursive: true });
        this.logger.log(`Created conversation log directory: ${this.logDirectory}`);
      }
    } catch (error) {
      this.logger.error('Failed to create log directory:', error);
    }
  }

  // Create a new conversation session
  createSession(sessionId: string, assistantType: string, phoneNumber?: string): ConversationSession {
    const now = new Date().toISOString();
    const session: ConversationSession = {
      sessionId,
      assistantType,
      startTime: now,
      lastUpdateTime: now,
      totalInteractions: 0,
      interactions: [],
      metadata: {
        phoneNumber,
        callDuration: 0,
        errorCount: 0,
        averageSearchTime: 0,
        averageResponseTime: 0,
      },
    };

    // Cache the session
    this.sessionCache.set(sessionId, session);

    return session;
  }

  // Get or create a conversation session
  getOrCreateSession(sessionId: string, assistantType: string, phoneNumber?: string): ConversationSession {
    // Check cache first
    let session: any = this.sessionCache.get(sessionId);

    if (!session) {
      // Check if session file exists
      const sessionFile = this.getSessionFilePath(sessionId);
      if (fs.existsSync(sessionFile)) {
        try {
          const content = fs.readFileSync(sessionFile, 'utf8');
          session = JSON.parse(content);
          // Cache the loaded session
          this.sessionCache.set(sessionId, session);
        } catch (error) {
          this.logger.error(`Failed to load existing session ${sessionId}:`, error);
        }
      }
    }

    if (!session) {
      session = this.createSession(sessionId, assistantType, phoneNumber);
    }

    return session;
  }

  /**
   * Adds an interaction to a conversation session
   * @param sessionId - The session ID
   * @param interaction - The conversation interaction to add
   */
  async addInteraction(sessionId: string, interaction: ConversationInteraction): Promise<void> {
    try {
      const session = this.sessionCache.get(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found in cache`);
      }

      // Add the interaction
      session.interactions.push(interaction);
      session.totalInteractions = session.interactions.length;
      session.lastUpdateTime = new Date().toISOString();

      // Update metadata
      this.updateSessionMetadata(session);

      // Save the updated session
      await this.saveSession(session);

      // Log to console for development
      if (this.configService.get('NODE_ENV') === 'development') {
        this.logger.debug('Added interaction to session:', {
          sessionId,
          assistantType: session.assistantType,
          interactionNumber: session.totalInteractions,
          userInput: interaction.question,
          responseLength: interaction.answer.length,
          searchTime: interaction.source.context?.length || 0, // Assuming search time is related to context
          responseTime: 0, // No response time in this simplified interface
        });
      }
    } catch (error) {
      this.logger.error(`Failed to add interaction to session ${sessionId}:`, error);
    }
  }

  /**
   * Updates session metadata based on interactions
   * @param session - The conversation session to update
   */
  private updateSessionMetadata(session: ConversationSession): void {
    const interactions = session.interactions;

    if (interactions.length === 0) return;

    // Calculate averages
    const totalSearchTime = interactions.reduce((sum, interaction) => sum + (interaction.source.context?.length || 0), 0);
    const totalResponseTime = interactions.reduce((sum, interaction) => sum + 0, 0); // No response time in this simplified interface
    const errorCount = interactions.filter((interaction) => interaction.error).length;

    session.metadata.averageSearchTime = Math.round(totalSearchTime / interactions.length);
    session.metadata.averageResponseTime = Math.round(totalResponseTime / interactions.length);
    session.metadata.errorCount = errorCount;

    // Calculate call duration if we have multiple interactions
    if (interactions.length > 1) {
      const startTime = new Date(interactions[0].timestamp).getTime();
      const endTime = new Date(interactions[interactions.length - 1].timestamp).getTime();
      session.metadata.callDuration = endTime - startTime;
    }
  }

  /**
   * Saves a conversation session to file
   * @param session - The conversation session to save
   */
  private async saveSession(session: ConversationSession): Promise<void> {
    try {
      const filePath = this.getSessionFilePath(session.sessionId);
      const logContent = JSON.stringify(session, null, 2);
      await fs.promises.writeFile(filePath, logContent, 'utf8');
    } catch (error) {
      this.logger.error(`Failed to save session ${session.sessionId}:`, error);
    }
  }

  // Get the file path for a session
  private getSessionFilePath(sessionId: string): string {
    return path.join(this.logDirectory, `${sessionId}.json`);
  }

  /**
   * Creates a conversation interaction with all required fields
   * @param question - The user's question after correction
   * @param correction - Whether any correction was applied
   * @returns A new conversation interaction
   */
  createInteraction(question: string, correction: boolean = false): ConversationInteraction {
    return {
      timestamp: new Date().toISOString(),
      question,
      correction,
      answer: '',
      source: {
        type: 'no context found + chatgpt',
      },
    };
  }

  /**
   * Updates the answer in an interaction
   * @param interaction - The interaction to update
   * @param answer - The final answer sent to user
   */
  updateAnswer(interaction: ConversationInteraction, answer: string): void {
    interaction.answer = answer;
  }

  // Updates the source type for Redis cached answer
  updateSourceRedis(interaction: ConversationInteraction): void {
    interaction.source.type = 'Cached answer found in Redis use Redis answer directly';
  }

  // Updates the source type for Qdrant high confidence + AI provider responses
  updateSourceQdrantHighConfidence(
    interaction: ConversationInteraction,
    context?: Array<{ content: string; score: number }>,
  ): void {
    interaction.source.type = `High confidence (confidence ≥ ${this.qdrantHighConfidenceScore.toFixed(2)}) use vector DB (qdrant) answer directly.`;
    if (context) {
      interaction.source.context = context.map((doc) => `Score: ${doc.score.toFixed(2)} | ${doc.content}`);
    }
  }

  // Updates the source type for Qdrant medium confidence + AI provider responses
  updateSourceQdrantMediumConfidence(
    interaction: ConversationInteraction,
    context?: Array<{ content: string; score: number }>,
  ): void {
    const aiProvider = process.env.AI_PROVIDER;
    let aiModel: string;

    if (aiProvider === 'google') {
      aiModel = process.env.GOOGLE_AI_MODEL || 'unknown model';
    } else if (aiProvider === 'openai') {
      aiModel = process.env.OPENAI_MODEL || 'unknown model';
    } else {
      aiModel = 'unknown AI provider';
    }

    interaction.source.type = `Medium confidence (${this.qdrantLowConfidenceScore.toFixed(2)} ≤ confidence < ${this.qdrantHighConfidenceScore.toFixed(2)}) use vector DB (qdrant) context + ${aiModel} with prompt.`;
    if (context) {
      interaction.source.context = context.map((doc) => `Score: ${doc.score.toFixed(2)} | ${doc.content}`);
    }
  }

  // Updates the source type for Qdrant low confidence + AI provider responses
  updateSourceQdrantLowConfidence(
    interaction: ConversationInteraction,
    context?: Array<{ content: string; score: number }>,
  ): void {
    const aiProvider = process.env.AI_PROVIDER;
    let aiModel: string;

    if (aiProvider === 'google') {
      aiModel = process.env.GOOGLE_AI_MODEL || 'unknown model';
    } else if (aiProvider === 'openai') {
      aiModel = process.env.OPENAI_MODEL || 'unknown model';
    } else {
      aiModel = 'unknown AI provider';
    }

    interaction.source.type = `Low confidence (confidence < ${this.qdrantLowConfidenceScore.toFixed(2)}) ignore weak vector DB (qdrant) context, use ${aiModel} with prompt.`;
    if (context) {
      interaction.source.context = context.map((doc) => `Score: ${doc.score.toFixed(2)} | ${doc.content}`);
    }
  }

  // Updates the source type for Qdrant zero confidence + AI provider responses
  updateSourceQdrantNoContext(interaction: ConversationInteraction, context?: Array<{ content: string; score: number }>): void {
    const aiProvider = process.env.AI_PROVIDER;
    let aiModel: string;

    if (aiProvider === 'google') {
      aiModel = process.env.GOOGLE_AI_MODEL || 'unknown model';
    } else if (aiProvider === 'openai') {
      aiModel = process.env.OPENAI_MODEL || 'unknown model';
    } else {
      aiModel = 'unknown AI provider';
    }

    interaction.source.type = `Zero confidence (no context in vector DB qdrant) use ${aiModel} with prompt only.`;
    if (context) {
      interaction.source.context = context.map((doc) => `Score: ${doc.score.toFixed(2)} | ${doc.content}`);
    }
  }

  // Updates the source type for no context + AI provider responses
  updateSourceNoContext(interaction: ConversationInteraction): void {
    const aiProvider = process.env.AI_PROVIDER;
    let aiModel: string;

    if (aiProvider === 'google') {
      aiModel = process.env.GOOGLE_AI_MODEL || 'unknown model';
    } else if (aiProvider === 'openai') {
      aiModel = process.env.OPENAI_MODEL || 'unknown model';
    } else {
      aiModel = 'unknown AI provider';
    }

    interaction.source.type = `Zero confidence (no context) use ${aiModel} with prompt only`;
  }

  // Updates the source type for direct AI responses (bypassing database)
  updateSourceDirectAI(interaction: ConversationInteraction): void {
    const aiProvider = process.env.AI_PROVIDER;
    let aiModel: string;

    if (aiProvider === 'google') {
      aiModel = process.env.GOOGLE_AI_MODEL || 'unknown model';
    } else if (aiProvider === 'openai') {
      aiModel = process.env.OPENAI_MODEL || 'unknown model';
    } else {
      aiModel = 'unknown AI provider';
    }

    interaction.source.type = `Direct AI response using ${aiProvider} (${aiModel}) - bypassed database lookup.`;
  }

  /**
   * Updates error information in an interaction
   * @param interaction - The interaction to update
   * @param error - The error message
   */
  updateError(interaction: ConversationInteraction, error: string): void {
    interaction.error = error;
  }

  /**
   * Retrieves a conversation session by session ID
   * @param sessionId - The session ID to retrieve
   * @returns The conversation session or null if not found
   */
  async getSession(sessionId: string): Promise<ConversationSession | null> {
    try {
      // Check cache first
      let session: any = this.sessionCache.get(sessionId);

      if (!session) {
        // Load from file
        const filePath = this.getSessionFilePath(sessionId);
        if (fs.existsSync(filePath)) {
          const content = await fs.promises.readFile(filePath, 'utf8');
          session = JSON.parse(content);
          // Cache the loaded session
          this.sessionCache.set(sessionId, session);
        }
      }

      return session || null;
    } catch (error) {
      this.logger.error(`Failed to retrieve session ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Retrieves all conversation sessions for a specific assistant type
   * @param assistantType - The assistant type to filter by
   * @param limit - Maximum number of sessions to return
   * @returns Array of conversation sessions
   */
  async getSessionsByAssistant(assistantType: string, limit: number = 100): Promise<ConversationSession[]> {
    try {
      const files = await fs.promises.readdir(this.logDirectory);
      const sessions: ConversationSession[] = [];

      for (const file of files.slice(0, limit)) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.logDirectory, file);
          const content = await fs.promises.readFile(filePath, 'utf8');
          const session = JSON.parse(content);

          if (session.assistantType === assistantType) {
            sessions.push(session);
          }
        }
      }

      return sessions.sort((a, b) => new Date(b.lastUpdateTime).getTime() - new Date(a.lastUpdateTime).getTime());
    } catch (error) {
      this.logger.error(`Failed to retrieve sessions for assistant ${assistantType}:`, error);
      return [];
    }
  }

  /**
   * Gets summary statistics for all sessions
   * @returns Summary statistics for all conversation sessions
   */
  async getSessionsSummary(): Promise<any> {
    try {
      const assistantTypes = ['general', 'hospital', 'speedel', 'appraisee', 'prep-my-vehicle'];
      const summary = {};

      for (const assistantType of assistantTypes) {
        const sessions = await this.getSessionsByAssistant(assistantType, 1000);

        if (sessions.length > 0) {
          const totalInteractions = sessions.reduce((sum, session) => sum + session.totalInteractions, 0);
          const totalErrors = sessions.reduce((sum, session) => sum + session.metadata.errorCount, 0);
          const avgSearchTime = sessions.reduce((sum, session) => sum + session.metadata.averageSearchTime, 0) / sessions.length;
          const avgResponseTime =
            sessions.reduce((sum, session) => sum + session.metadata.averageResponseTime, 0) / sessions.length;

          summary[assistantType] = {
            totalSessions: sessions.length,
            totalInteractions,
            averageInteractionsPerSession: Math.round(totalInteractions / sessions.length),
            averageSearchTime: Math.round(avgSearchTime),
            averageResponseTime: Math.round(avgResponseTime),
            errorRate: totalInteractions > 0 ? ((totalErrors / totalInteractions) * 100).toFixed(2) + '%' : '0%',
            lastSession: sessions[0]?.lastUpdateTime,
          };
        }
      }

      return {
        summary,
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        error: 'Failed to generate summary',
        message: error.message,
      };
    }
  }

  /**
   * Ends a conversation session and sends email notification
   * @param sessionId - The session ID to end
   */
  async endSession(sessionId: string): Promise<void> {
    try {
      const session = this.sessionCache.get(sessionId);
      if (session) {
        session.lastUpdateTime = new Date().toISOString();
        this.updateSessionMetadata(session);
        await this.saveSession(session);
        this.logger.log(`Ended session: ${sessionId} with ${session.totalInteractions} interactions`);

        // Send email notification
        await this.sendSessionEndEmail(session);

        // Clean up the session after email is sent
        await this.cleanupSession(sessionId);
      }
    } catch (error) {
      this.logger.error(`Failed to end session ${sessionId}:`, error);
    }
  }

  /**
   * Clean up session data after call ends
   * @param sessionId - The session ID to clean up
   */
  private async cleanupSession(sessionId: string): Promise<void> {
    try {
      this.logger.log(`🧹 [CLEANUP] Starting cleanup for session: ${sessionId}`);

      // 1. Remove from memory cache
      const removedFromCache = this.sessionCache.delete(sessionId);
      if (removedFromCache) {
        this.logger.log(`✅ [CLEANUP] Removed session ${sessionId} from memory cache`);
      }

      // 2. Delete conversation file
      const filePath = this.getSessionFilePath(sessionId);
      try {
        await fs.promises.unlink(filePath);
        this.logger.log(`✅ [CLEANUP] Deleted conversation file: ${filePath}`);
      } catch (fileError) {
        if (fileError.code === 'ENOENT') {
          this.logger.log(`ℹ️ [CLEANUP] Conversation file already deleted: ${filePath}`);
        } else {
          this.logger.warn(`⚠️ [CLEANUP] Failed to delete conversation file ${filePath}:`, fileError);
        }
      }

      // 3. Clean up any old sessions (optional - runs periodically)
      await this.cleanupOldSessions();

      this.logger.log(`✅ [CLEANUP] Completed cleanup for session: ${sessionId}`);
    } catch (error) {
      this.logger.error(`❌ [CLEANUP] Failed to cleanup session ${sessionId}:`, error);
    }
  }

  /**
   * Clean up old sessions that might have been missed
   * This runs periodically to ensure no sessions are left behind
   */
  private async cleanupOldSessions(): Promise<void> {
    try {
      const now = new Date();
      const cleanupThreshold = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
      let cleanedCount = 0;

      // Clean up old sessions from memory cache
      for (const [sessionId, session] of this.sessionCache.entries()) {
        const sessionTime = new Date(session.lastUpdateTime || session.startTime);
        const timeDiff = now.getTime() - sessionTime.getTime();

        if (timeDiff > cleanupThreshold) {
          this.sessionCache.delete(sessionId);
          cleanedCount++;
          this.logger.log(
            `🧹 [CLEANUP] Removed old session from cache: ${sessionId} (age: ${Math.round(timeDiff / (60 * 60 * 1000))} hours)`,
          );
        }
      }

      // Clean up old conversation files
      try {
        const files = await fs.promises.readdir(this.logDirectory);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const filePath = path.join(this.logDirectory, file);
            const stats = await fs.promises.stat(filePath);
            const timeDiff = now.getTime() - stats.mtime.getTime();

            if (timeDiff > cleanupThreshold) {
              await fs.promises.unlink(filePath);
              cleanedCount++;
              this.logger.log(
                `🧹 [CLEANUP] Deleted old conversation file: ${file} (age: ${Math.round(timeDiff / (60 * 60 * 1000))} hours)`,
              );
            }
          }
        }
      } catch (dirError) {
        this.logger.warn(`⚠️ [CLEANUP] Failed to read log directory for cleanup:`, dirError);
      }

      if (cleanedCount > 0) {
        this.logger.log(`✅ [CLEANUP] Cleaned up ${cleanedCount} old sessions and files`);
      }
    } catch (error) {
      this.logger.error(`❌ [CLEANUP] Failed to cleanup old sessions:`, error);
    }
  }

  /**
   * Send email notification when session ends
   * @param session - The conversation session that ended
   */
  private async sendSessionEndEmail(session: ConversationSession): Promise<void> {
    try {
      // Read the JSON file content
      const filePath = this.getSessionFilePath(session.sessionId);
      let jsonContent: string | undefined;
      let fileExists = false;

      if (fs.existsSync(filePath)) {
        jsonContent = fs.readFileSync(filePath, 'utf8');
        fileExists = true;
      }

      const emailSent = await this.emailService.sendConversationJsonEmail(
        session.sessionId,
        session.assistantType,
        session.metadata.phoneNumber,
        session.totalInteractions,
        session.metadata.callDuration,
        jsonContent,
      );

      if (emailSent) {
        this.logger.log(`JSON email notification sent for session: ${session.sessionId}`);

        // Delete the conversation file after successful email send
        if (fileExists) {
          try {
            fs.unlinkSync(filePath);
            this.logger.log(`Deleted conversation file for session: ${session.sessionId}`);
          } catch (deleteError) {
            this.logger.warn(`Failed to delete conversation file for session ${session.sessionId}:`, deleteError);
          }
        }
      } else {
        this.logger.warn(`Failed to send JSON email notification for session: ${session.sessionId}`);
      }
    } catch (error) {
      this.logger.error(`Error sending JSON email notification for session ${session.sessionId}:`, error);
    }
  }

  /**
   * Clears the session cache (useful for memory management)
   */
  clearCache(): void {
    this.sessionCache.clear();
    this.logger.log('Session cache cleared');
  }
}
