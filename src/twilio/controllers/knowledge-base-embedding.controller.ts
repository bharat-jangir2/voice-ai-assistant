import { Controller, Logger, HttpStatus } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { KnowledgeBaseEmbeddingService, KnowledgeBaseFileData } from '../services/knowledge-base-embedding.service';
import { EmbeddingRetryService } from '../services/embedding-retry.service';

@Controller()
export class KnowledgeBaseEmbeddingController {
  private readonly logger = new Logger(KnowledgeBaseEmbeddingController.name);

  constructor(
    private readonly knowledgeBaseEmbeddingService: KnowledgeBaseEmbeddingService,
    private readonly embeddingRetryService: EmbeddingRetryService,
  ) {}

  /**
   * Handle file upload from knowledge-base service
   * This method processes the file and creates embeddings in Qdrant
   */
  @MessagePattern('processKnowledgeBaseFile')
  async processKnowledgeBaseFile(@Payload() payload: any) {
    try {
      this.logger.log(`Received file processing request: ${payload.fileName} (ID: ${payload.id})`);

      // Validate required fields
      if (!payload.id) {
        throw new Error('File ID is required');
      }
      if (!payload.organizationId) {
        throw new Error('Organization ID is required');
      }
      if (!payload.fileBuffer) {
        throw new Error('File buffer is required');
      }

      // Convert base64 buffer back to Buffer if needed
      let fileBuffer: Buffer;
      if (typeof payload.fileBuffer === 'string') {
        fileBuffer = Buffer.from(payload.fileBuffer, 'base64');
      } else {
        fileBuffer = payload.fileBuffer;
      }

      // Prepare file data for processing
      const fileData: KnowledgeBaseFileData = {
        id: payload.id,
        organizationId: payload.organizationId,
        userId: payload.userId,
        fileName: payload.fileName,
        fileType: payload.fileType,
        fileSize: payload.fileSize,
        fileUrl: payload.fileUrl,
        fileBuffer: fileBuffer,
        isActive: payload.isActive !== undefined ? payload.isActive : true,
      };

      // Process file and create embeddings with retry logic
      await this.embeddingRetryService.processFileWithIntelligentRetry(fileData);

      this.logger.log(`Successfully processed file: ${payload.fileName} (ID: ${payload.id})`);

      return {
        statusCode: HttpStatus.OK,
        userMessage: 'File processed and embeddings created successfully',
        userMessageCode: 'KNOWLEDGE_BASE_EMBEDDING_SUCCESS',
        developerMessage: 'File processed and embeddings stored in vector database',
        data: {
          result: {
            fileId: payload.id,
            organizationId: payload.organizationId,
            fileName: payload.fileName,
            processed: true,
            processedAt: new Date().toISOString(),
          },
        },
      };
    } catch (error) {
      this.logger.error(`Failed to process knowledge base file:`, error);

      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        userMessage: 'Failed to process file for embeddings',
        userMessageCode: 'KNOWLEDGE_BASE_EMBEDDING_ERROR',
        developerMessage: `File processing failed: ${error.message}`,
        data: {
          result: {
            fileId: payload.id,
            organizationId: payload.organizationId,
            fileName: payload.fileName,
            processed: false,
            error: error.message,
            processedAt: new Date().toISOString(),
          },
        },
      };
    }
  }

  /**
   * Handle file deletion from knowledge-base service
   * This method removes embeddings from Qdrant
   */
  @MessagePattern('deleteKnowledgeBaseFileEmbeddings')
  async deleteKnowledgeBaseFileEmbeddings(@Payload() payload: any) {
    try {
      this.logger.log(`Received file deletion request: ${payload.fileId} from org ${payload.organizationId}`);

      // Validate required fields
      if (!payload.fileId) {
        throw new Error('File ID is required');
      }
      if (!payload.organizationId) {
        throw new Error('Organization ID is required');
      }

      // Delete embeddings from Qdrant with retry logic
      await this.embeddingRetryService.deleteFileEmbeddingsWithRetry(payload.fileId, payload.organizationId);

      this.logger.log(`Successfully deleted embeddings for file: ${payload.fileId}`);

      return {
        statusCode: HttpStatus.OK,
        userMessage: 'File embeddings deleted successfully',
        userMessageCode: 'KNOWLEDGE_BASE_EMBEDDING_DELETE_SUCCESS',
        developerMessage: 'File embeddings removed from vector database',
        data: {
          result: {
            fileId: payload.fileId,
            organizationId: payload.organizationId,
            deleted: true,
            deletedAt: new Date().toISOString(),
          },
        },
      };
    } catch (error) {
      this.logger.error(`Failed to delete knowledge base file embeddings:`, error);

      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        userMessage: 'Failed to delete file embeddings',
        userMessageCode: 'KNOWLEDGE_BASE_EMBEDDING_DELETE_ERROR',
        developerMessage: `File embedding deletion failed: ${error.message}`,
        data: {
          result: {
            fileId: payload.fileId,
            organizationId: payload.organizationId,
            deleted: false,
            error: error.message,
            deletedAt: new Date().toISOString(),
          },
        },
      };
    }
  }

  /**
   * Search knowledge base for relevant content
   */
  @MessagePattern('searchKnowledgeBase')
  async searchKnowledgeBase(@Payload() payload: any) {
    try {
      this.logger.log(`Received knowledge base search request: "${payload.query}" for org ${payload.organizationId}`);

      // Validate required fields
      if (!payload.query) {
        throw new Error('Search query is required');
      }
      if (!payload.organizationId) {
        throw new Error('Organization ID is required');
      }

      const limit = payload.limit || 5;

      // Search knowledge base
      const results = await this.knowledgeBaseEmbeddingService.searchKnowledgeBase(payload.query, payload.organizationId, limit);

      this.logger.log(`Found ${results.length} relevant results for query: "${payload.query}"`);

      return {
        statusCode: HttpStatus.OK,
        userMessage: 'Knowledge base search completed successfully',
        userMessageCode: 'KNOWLEDGE_BASE_SEARCH_SUCCESS',
        developerMessage: 'Knowledge base search completed successfully',
        data: {
          result: {
            query: payload.query,
            organizationId: payload.organizationId,
            results: results,
            totalResults: results.length,
            searchedAt: new Date().toISOString(),
          },
        },
      };
    } catch (error) {
      this.logger.error(`Failed to search knowledge base:`, error);

      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        userMessage: 'Failed to search knowledge base',
        userMessageCode: 'KNOWLEDGE_BASE_SEARCH_ERROR',
        developerMessage: `Knowledge base search failed: ${error.message}`,
        data: {
          result: {
            query: payload.query,
            organizationId: payload.organizationId,
            results: [],
            totalResults: 0,
            error: error.message,
            searchedAt: new Date().toISOString(),
          },
        },
      };
    }
  }

  /**
   * Debug knowledge base collection
   */
  @MessagePattern('debugKnowledgeBaseCollection')
  async debugCollection(@Payload() payload: any) {
    try {
      const { organizationId, fileId } = payload;

      if (!organizationId) {
        throw new Error('Organization ID is required');
      }

      // Call the debug method from the search service
      await this.knowledgeBaseEmbeddingService.debugCollection(organizationId, fileId);

      return {
        statusCode: HttpStatus.OK,
        userMessage: 'Debug information logged',
        userMessageCode: 'KNOWLEDGE_BASE_DEBUG_SUCCESS',
        developerMessage: 'Check logs for debug information',
        data: {
          result: {
            organizationId,
            fileId: fileId || 'all',
            debugged: true,
            timestamp: new Date().toISOString(),
          },
        },
      };
    } catch (error) {
      this.logger.error(`Failed to debug collection:`, error);

      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        userMessage: 'Failed to debug collection',
        userMessageCode: 'KNOWLEDGE_BASE_DEBUG_ERROR',
        developerMessage: `Debug failed: ${error.message}`,
        data: {
          result: {
            organizationId: payload.organizationId,
            debugged: false,
            error: error.message,
            timestamp: new Date().toISOString(),
          },
        },
      };
    }
  }

  /**
   * Health check for knowledge base embedding service
   */
  @MessagePattern('knowledgeBaseEmbeddingHealth')
  async healthCheck() {
    return {
      statusCode: HttpStatus.OK,
      userMessage: 'Knowledge base embedding service is healthy',
      userMessageCode: 'KNOWLEDGE_BASE_EMBEDDING_HEALTH_OK',
      developerMessage: 'Knowledge base embedding service is running normally',
      data: {
        result: {
          service: 'knowledge-base-embedding',
          status: 'healthy',
          timestamp: new Date().toISOString(),
        },
      },
    };
  }
}
