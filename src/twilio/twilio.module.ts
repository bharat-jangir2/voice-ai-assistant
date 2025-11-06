import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import redisConfig from '../config/redis.config';
import { ChromaController } from './controllers/chroma.controller';
import { ChatMicroserviceController } from './controllers/chat-microservice.controller';
import { ConversationLogController } from './controllers/conversation-log.controller';
import { EmbeddingController } from './controllers/embedding.controller';
import { QdrantController } from './controllers/qdrant.controller';
import { TwilioController } from './controllers/twilio.controller';
import { WebCallController } from './controllers/webcall.controller';
import { WebVoiceGateway } from './gateway/web-voice.gateway';
import { VoiceOrchestratorService } from './services/voice-orchestrator.service';
import { TwilioGateway } from './gateway/twilio.gateway';
import { ChatGateway } from './gateway/chat.gateway';
import { AIResponseService } from './services/ai-response.service';
import { AudioProcessingService } from './services/audio-processing.service';
import { BookingFlowService } from './services/booking-flow.service';
import { BookingSessionService } from './services/booking-session.service';
import { ChromaDBService } from './services/chroma-db.services';
import { ConversationLoggerService } from './services/conversation-logger.service';
import { DirectAIService } from './services/direct-ai.service';
import { ElevenLabsService } from './services/elevenlabs.service';
import { EmailService } from './services/email.service';
import { EmbeddingService } from './services/embedding.service';
import { GoogleCloudService } from './services/google-cloud.service';
import { OpenAIAssistantService } from './services/open-ai-assistant.service';
import { OpenAIBookingAssistantService } from './services/openai-booking-assistant.service';
import { QdrantDBService } from './services/qdrant-db.services';
import { RedisService } from './services/redis.service';
import { RuntimeConfigService } from './services/runtime-config.service';
import { SpeechService } from './services/speech.service';
import { TwilioApiService } from './services/twilio-api.service';
import { WhisperService } from './services/whisper.service';
import { WordCorrectionService } from './services/word-correction.service';
import { BookingDataExtractionService } from './services/booking-data-extraction.service';
import { ConversationDbService } from './services/conversation-db.service';
import { KnowledgeBaseEmbeddingService } from './services/knowledge-base-embedding.service';
import { EmbeddingRetryService } from './services/embedding-retry.service';
import { KnowledgeBaseSearchService } from './services/knowledge-base-search.service';
import { KnowledgeBaseResponseService } from './services/knowledge-base-response.service';
import { SemanticSearchService } from './services/semantic-search.service';
import { FileExtractionService } from './services/file-extraction.service';
import { CostCalculationService } from './services/cost-calculation.service';
import { KnowledgeBaseEmbeddingController } from './controllers/knowledge-base-embedding.controller';
import { AudioFormatService } from './services/audio-format.service';
import { VoiceActivityDetectorService } from './services/voice-activity-detector.service';
import { StreamingSTTService } from './services/streaming-stt.service';
import { AssistantConfigCacheService } from './services/assistant-config-cache.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [redisConfig],
      isGlobal: false,
    }),
    ClientsModule.registerAsync([
      {
        name: 'userService',
        useFactory: () => ({
          transport: Transport.TCP,
          options: {
            host: process.env.USER_SERVICE_HOST || '0.0.0.0',
            port: parseInt(process.env.USER_SERVICE_PORT || '9001'),
          },
        }),
      },
    ]),
  ],
  controllers: [
    TwilioController,
    ChatMicroserviceController,
    ChromaController,
    QdrantController,
    ConversationLogController,
    EmbeddingController,
    KnowledgeBaseEmbeddingController,
    WebCallController,
  ],
  providers: [
    TwilioGateway,
    ChatGateway,
    WebVoiceGateway,
    VoiceOrchestratorService,
    WhisperService,
    ElevenLabsService,
    AudioProcessingService,
    AIResponseService,
    TwilioApiService,
    OpenAIAssistantService,
    OpenAIBookingAssistantService,
    RedisService,
    WordCorrectionService,
    ChromaDBService,
    QdrantDBService,
    ConversationLoggerService,
    DirectAIService,
    EmailService,
    EmbeddingService,
    GoogleCloudService,
    SpeechService,
    BookingSessionService,
    BookingFlowService,
    BookingDataExtractionService,
    RuntimeConfigService,
    ConversationDbService,
    KnowledgeBaseEmbeddingService,
    EmbeddingRetryService,
    KnowledgeBaseSearchService,
    KnowledgeBaseResponseService,
    SemanticSearchService,
    FileExtractionService,
    CostCalculationService,
    AudioFormatService,
    VoiceActivityDetectorService,
    StreamingSTTService,
    AssistantConfigCacheService,
  ],
  exports: [RedisService, ChromaDBService, QdrantDBService, ConversationLoggerService, EmailService, SpeechService],
})
export class TwilioModule {}
