import { Injectable, Logger, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

// ============================================
// DTOs for Conversation Database Operations
// ============================================
export interface StartConversationDto {
  organizationId: string;
  assistantId: string;
  userId?: string;
  type: 'chat' | 'phoneCall' | 'webCall' | 'sms';
  direction?: 'inbound' | 'outbound';
  stream?: boolean;
  phoneNumber?: string;
  phoneDetails?: any;
  metadata?: Record<string, any>;
}

export interface SendMessageDto {
  conversationId: string;
  role: 'system' | 'user' | 'assistant' | 'bot' | 'function';
  content: string;
  source?: string;
  audio?: any;
  processingTime?: number;
  cost?: any;
  metadata?: Record<string, any>;
}

export interface EndConversationDto {
  conversationId: string;
  endedReason?: string;
  recordingUrl?: string;
  stereoRecordingUrl?: string;
  analysis?: any;
  performanceMetrics?: any;
}

export interface ConversationEntity {
  _id: string;
  organizationId: string;
  assistantId: string;
  userId?: string;
  type: string;
  direction?: string;
  status: string;
  stream: boolean;
  phoneNumber?: string;
  phoneDetails?: any;
  startedAt: Date;
  endedAt?: Date;
  duration?: number;
  lastActivityAt?: Date;
  conversationMetrics: any;
  cost: number;
  costs: any[];
  costBreakdown: any;
  analysis: any;
  performanceMetrics: any;
  transport: any;
  artifact: any;
  recordingConsent: boolean;
  dataRetentionConsent: boolean;
  complianceFlags: any[];
  customData: any;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageEntity {
  _id: string;
  conversationId: string;
  organizationId: string;
  assistantId: string;
  userId: string;
  role: string;
  content: string;
  audio?: any;
  timestamp: Date;
  time?: number;
  secondsFromStart?: number;
  duration?: number;
  endTime?: number;
  processingTime?: number;
  functionCall?: any;
  emotionAnalysis?: any;
  cost?: any;
  source?: string;
  metadata?: any;
  modelInfo?: any;
  status: string;
  error?: string;
  previousMessageId?: string;
  nextMessageId?: string;
  conversationTurn?: number;
  qualityMetrics?: any;
  isDeleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ConversationDbService {
  private readonly logger = new Logger(ConversationDbService.name);

  constructor(@Inject('userService') private readonly userServiceClient: ClientProxy) {}

  /**
   * Start a new conversation in the database
   */
  async startConversation(startConversationDto: StartConversationDto): Promise<ConversationEntity> {
    this.logger.log(`🚀 [CONVERSATION DB] Starting conversation:`, {
      type: startConversationDto.type,
      assistantId: startConversationDto.assistantId,
      organizationId: startConversationDto.organizationId,
    });

    try {
      const response = await firstValueFrom(this.userServiceClient.send('conversation:start', { startConversationDto }));

      this.logger.log(`🔍 [CONVERSATION DB] Raw response from User Service:`, response);

      if (!response?.success) {
        const errorMessage =
          response?.userMessage || response?.developerMessage || response?.message || response?.error || 'Unknown error occurred';
        throw new Error(`Failed to start conversation: ${errorMessage}`);
      }

      this.logger.log(`✅ [CONVERSATION DB] Conversation started successfully:`, {
        conversationId: response.data._id,
        type: response.data.type,
        status: response.data.status,
      });

      return response.data;
    } catch (error) {
      this.logger.error(`❌ [CONVERSATION DB] Error starting conversation:`, error);
      this.logger.error(`❌ [CONVERSATION DB] Error details:`, {
        message: error.message,
        stack: error.stack,
        startConversationDto,
      });
      throw error;
    }
  }

  /**
   * Send a message in a conversation
   */
  async sendMessage(sendMessageDto: SendMessageDto): Promise<MessageEntity> {
    this.logger.log(`🚀 [CONVERSATION DB] Sending message:`, {
      conversationId: sendMessageDto.conversationId,
      role: sendMessageDto.role,
      contentLength: sendMessageDto.content.length,
    });

    try {
      const response = await firstValueFrom(this.userServiceClient.send('conversation:send-message', { sendMessageDto }));

      if (!response.success) {
        throw new Error(`Failed to send message: ${response.message}`);
      }

      this.logger.log(`✅ [CONVERSATION DB] Message sent successfully:`, {
        messageId: response.data._id,
        conversationId: response.data.conversationId,
        role: response.data.role,
      });

      return response.data;
    } catch (error) {
      this.logger.error(`❌ [CONVERSATION DB] Error sending message:`, error);
      throw error;
    }
  }

  /**
   * End a conversation
   */
  async endConversation(endConversationDto: EndConversationDto): Promise<ConversationEntity> {
    this.logger.log(`🚀 [CONVERSATION DB] Ending conversation:`, {
      conversationId: endConversationDto.conversationId,
      reason: endConversationDto.endedReason,
    });

    try {
      const response = await firstValueFrom(this.userServiceClient.send('conversation:end', { endConversationDto }));

      if (!response.success) {
        // Preserve 404 status code if conversation not found
        const error = new Error(`Failed to end conversation: ${response.message}`);
        (error as any).statusCode = response.statusCode || 400;
        (error as any).isNotFound = response.statusCode === 404;
        throw error;
      }

      this.logger.log(`✅ [CONVERSATION DB] Conversation ended successfully:`, {
        conversationId: response.data._id,
        status: response.data.status,
        duration: response.data.duration,
      });

      return response.data;
    } catch (error) {
      this.logger.error(`❌ [CONVERSATION DB] Error ending conversation:`, error);
      throw error;
    }
  }

  /**
   * Get conversation by ID
   */
  async getConversation(conversationId: string): Promise<ConversationEntity> {
    this.logger.log(`🚀 [CONVERSATION DB] Getting conversation: ${conversationId}`);

    try {
      const response = await firstValueFrom(this.userServiceClient.send('conversation:get', { conversationId }));

      if (!response.success) {
        throw new Error(`Failed to get conversation: ${response.message}`);
      }

      this.logger.log(`✅ [CONVERSATION DB] Conversation retrieved successfully:`, {
        conversationId: response.data._id,
        type: response.data.type,
        status: response.data.status,
      });

      return response.data;
    } catch (error) {
      this.logger.error(`❌ [CONVERSATION DB] Error getting conversation:`, error);
      throw error;
    }
  }

  /**
   * Get messages for a conversation with pagination
   */
  async getConversationMessages(conversationId: string, page: number = 1, limit: number = 20): Promise<MessageEntity[]> {
    this.logger.log(`🚀 [CONVERSATION DB] Getting messages for conversation: ${conversationId} (page: ${page}, limit: ${limit})`);

    try {
      const response = await firstValueFrom(
        this.userServiceClient.send('conversation:get-messages', {
          conversationId,
          page,
          limit,
        }),
      );

      if (!response?.success) {
        const err =
          response?.userMessage || response?.developerMessage || response?.message || response?.error || 'Unknown error';
        throw new Error(`Failed to get messages: ${err}`);
      }

      this.logger.log(`✅ [CONVERSATION DB] Messages retrieved successfully:`, {
        conversationId,
        messageCount: response.data.length,
        page,
        limit,
      });

      return response.data;
    } catch (error) {
      this.logger.error(`❌ [CONVERSATION DB] Error getting messages:`, error);
      throw error;
    }
  }

  /**
   * Get conversations for an organization
   */
  async getConversations(
    organizationId: string,
    page: number = 1,
    limit: number = 50,
  ): Promise<{ conversations: ConversationEntity[]; total: number }> {
    this.logger.log(`🚀 [CONVERSATION DB] Getting conversations for organization: ${organizationId}`);

    try {
      const response = await firstValueFrom(
        this.userServiceClient.send('conversation:get-list', {
          organizationId,
          page,
          limit,
        }),
      );

      if (!response?.success) {
        const err =
          response?.userMessage || response?.developerMessage || response?.message || response?.error || 'Unknown error';
        throw new Error(`Failed to get conversations: ${err}`);
      }

      this.logger.log(`✅ [CONVERSATION DB] Conversations retrieved successfully:`, {
        organizationId,
        count: response.data.conversations.length,
        total: response.data.total,
      });

      return response.data;
    } catch (error) {
      this.logger.error(`❌ [CONVERSATION DB] Error getting conversations:`, error);
      throw error;
    }
  }

  /**
   * Get conversations by type
   */
  async getConversationsByType(
    organizationId: string,
    type: 'chat' | 'phoneCall' | 'webCall' | 'sms',
    page: number = 1,
    limit: number = 50,
    includeCosts: boolean = false,
  ): Promise<{ conversations: ConversationEntity[]; total: number }> {
    this.logger.log(`🚀 [CONVERSATION DB] Getting ${type} conversations for organization: ${organizationId} (includeCosts: ${includeCosts})`);

    try {
      const response = await firstValueFrom(
        this.userServiceClient.send('conversation:get-by-type', {
          organizationId,
          type,
          page,
          limit,
          includeCosts, // Pass flag to use aggregation with costs
        }),
      );

      if (!response?.success) {
        const err =
          response?.userMessage || response?.developerMessage || response?.message || response?.error || 'Unknown error';
        throw new Error(`Failed to get ${type} conversations: ${err}`);
      }

      this.logger.log(`✅ [CONVERSATION DB] ${type} conversations retrieved successfully:`, {
        organizationId,
        type,
        count: response.data.conversations.length,
        total: response.data.total,
      });

      return response.data;
    } catch (error) {
      this.logger.error(`❌ [CONVERSATION DB] Error getting ${type} conversations:`, error);
      throw error;
    }
  }
}
