import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAI } from 'openai';
import { OpenAIAssistantService } from './open-ai-assistant.service';
import { RedisService } from './redis.service';
import { ChromaDBService } from './chroma-db.services';
import { QdrantDBService } from './qdrant-db.services';
import { ConversationLoggerService } from './conversation-logger.service';
import { DirectAIService } from './direct-ai.service';

@Injectable()
export class AIResponseService {
  private readonly logger = new Logger(AIResponseService.name);
  private readonly openai: OpenAI;
  private readonly assistantType: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly openAIAssistantService: OpenAIAssistantService,
    private readonly redisService: RedisService,
    private readonly chromaDBService: ChromaDBService,
    private readonly qdrantDBService: QdrantDBService,
    private readonly conversationLogger: ConversationLoggerService,
    private readonly directAIService: DirectAIService,
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not defined');
    }
    this.openai = new OpenAI({ apiKey });
    this.assistantType = this.configService.get<string>('ASSISTANT_TYPE') || 'general';
  }

  async generateResponse(
    correctedTranscription: string,
    assistantType: string,
    threadId?: string,
    callSid?: string,
    phoneNumber?: string,
    originalTranscription?: string,
  ): Promise<string> {
    const sessionId = callSid || 'unknown';
    const hasCorrections = originalTranscription && originalTranscription !== correctedTranscription;

    // KEEP: Session management for call tracking
    // Create or get conversation session
    const session = this.conversationLogger.getOrCreateSession(sessionId, assistantType, phoneNumber);

    // Create interaction for this Q&A
    const interaction = this.conversationLogger.createInteraction(correctedTranscription, !!hasCorrections);

    try {
      // COMMENTED OUT: Redis lookup
      // const redisAnswer = await this.redisService.getAnswerFromRedis(correctedTranscription, assistantType);
      // if (redisAnswer) {
      //   // Update interaction with Redis response
      //   this.conversationLogger.updateAnswer(interaction, redisAnswer);
      //   this.conversationLogger.updateSourceRedis(interaction);

      //   // Add interaction to session
      //   await this.conversationLogger.addInteraction(session.sessionId, interaction);

      //   return redisAnswer;
      // }

      // COMMENTED OUT: Vector database RAG process
      // Check which vector database to use based on environment variable
      // const vectorDatabase = this.configService.get<string>('VECTOR_DATABASE') || 'chroma';

      // this.logger.verbose(`
      //   ✅ Using RAG approach with ${vectorDatabase.toUpperCase()}
      //   ${hasCorrections ? '❌' : '✅'} hasCorrections: ${hasCorrections}
      // `);

      // let responseText: string;

      // if (vectorDatabase.toLowerCase() === 'qdrant') {
      //   // Use Qdrant RAG approach
      //   responseText = await this.qdrantDBService.getAnswerUsingQdrantRAG(
      //     correctedTranscription,
      //     assistantType,
      //     sessionId,
      //     0.95,
      //     phoneNumber,
      //   );
      // } else {
      //   // Use ChromaDB RAG approach (default)
      //   responseText = await this.chromaDBService.getAnswerUsingChromaRAG(
      //     correctedTranscription,
      //     assistantType,
      //     sessionId,
      //     0.95,
      //     phoneNumber,
      //   );
      // }

      // if (responseText) {
      //   return responseText;
      // }

      // NEW: Direct AI response using DirectAIService with conversation context
      const responseText = await this.directAIService.getDirectAIResponse(correctedTranscription, assistantType, sessionId);

      // KEEP: Update interaction with response for session tracking
      this.conversationLogger.updateAnswer(interaction, responseText);
      this.conversationLogger.updateSourceDirectAI(interaction);

      // KEEP: Add interaction to session for call history
      await this.conversationLogger.addInteraction(session.sessionId, interaction);

      return responseText;
    } catch (error) {
      // KEEP: Error handling for session tracking
      this.logger.error('Direct AI response failed:', error);

      // Update error in interaction
      this.conversationLogger.updateError(interaction, error.message);

      throw error;
    }

    // COMMENTED OUT: Fallback to OpenAI Assistant
    // this.logger.log('Falling back to existing RAG approach');
    // const fallbackResponse = await this.openAIAssistantService.getAnswer(correctedTranscription, threadId);

    // Update interaction with fallback response
    // this.conversationLogger.updateAnswer(interaction, fallbackResponse);
    // this.conversationLogger.updateSourceNoContext(interaction);

    // Add interaction to session
    // await this.conversationLogger.addInteraction(session.sessionId, interaction);

    // return fallbackResponse;
  }

  private getCorrections(originalText: string, correctedText: string): string[] {
    const corrections: string[] = [];
    if (originalText !== correctedText) {
      corrections.push(`${originalText} → ${correctedText}`);
    }
    return corrections;
  }
}
