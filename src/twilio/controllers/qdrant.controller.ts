import { Body, Controller, Delete, Get, HttpException, HttpStatus, Logger, Param, Post } from '@nestjs/common';
import { QAData, QdrantApiResponse, QdrantDocument, UploadContentDto } from '../interfaces/qdrant.interfaces';
import { EmbeddingService } from '../services/embedding.service';
import { QdrantDBService } from '../services/qdrant-db.services';

@Controller('qdrant')
export class QdrantController {
  private readonly logger = new Logger(QdrantController.name);

  constructor(
    private readonly qdrantDBService: QdrantDBService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  // Upload QA pairs to vector database with parallel processing
  @Post('upload')
  async uploadContent(@Body() uploadContentDto: UploadContentDto): Promise<QdrantApiResponse> {
    try {
      this.logger.verbose(`
        Uploading content to collection: ${uploadContentDto.collectionName}
        Using embedding method: ${this.embeddingService.getEmbeddingMethod()}
        Vector size: ${this.embeddingService.getVectorSize()}
        `);

      // Validate input
      if (!uploadContentDto.collectionName || !uploadContentDto.data) {
        throw new Error('Collection name and data are required');
      }

      if (!Array.isArray(uploadContentDto.data)) {
        throw new Error('Data must be an array');
      }

      // Ensure collection exists BEFORE parallel processing to avoid race conditions
      await this.qdrantDBService.createCollectionIfNotExists(uploadContentDto.collectionName);

      // Process each QA pair
      const results = await Promise.all(
        uploadContentDto.data.map(async (qa: QAData, index: number) => {
          try {
            // Create a combined text for better context
            const content = `Question: ${qa.question}\nAnswer: ${qa.answer}`;

            // Generate embedding for the content using embedding service directly
            const embedding = await this.embeddingService.generateEmbedding(content);

            // Create document for Qdrant
            const document: QdrantDocument = {
              id: `qa_${Date.now()}_${index}`,
              content: content,
              embedding: embedding,
              metadata: {
                question: qa.question,
                answer: qa.answer,
                timestamp: new Date().toISOString(),
              },
            };

            // Add to collection
            await this.qdrantDBService.addToExistingCollection(uploadContentDto.collectionName, document);

            return {
              status: 'success',
              question: qa.question,
            };
          } catch (error) {
            this.logger.error(`Error processing QA pair ${index}:`, error);
            return {
              status: 'error',
              question: qa.question,
              error: error.message,
            };
          }
        }),
      );

      return {
        status: 'success',
        message: `Successfully processed ${results.length} QA pairs`,
        results: results,
      };
    } catch (error) {
      this.logger.error('Error uploading content:', error);
      throw error;
    }
  }

  // Retrieve all documents and metadata from a vector collection
  @Get('collection/:collectionName/content')
  async getCollectionContentByParam(@Param('collectionName') collectionName: string): Promise<QdrantApiResponse> {
    try {
      this.logger.log(`Fetching content from collection via URL param: ${collectionName}`);

      // Validate input
      if (!collectionName) {
        throw new Error('Collection name is required');
      }

      // Get collection content
      const collectionContent = await this.qdrantDBService.getCollectionContent(collectionName);

      return {
        status: 'success',
        message: `Retrieved content from collection: ${collectionName}`,
        data: collectionContent,
      };
    } catch (error) {
      this.logger.error(`Error fetching collection content: ${error.message}`);
      if (error.message.includes('does not exist')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // List all vector collections with their metadata and point counts
  @Get('collections')
  async getCollections(): Promise<QdrantApiResponse> {
    try {
      this.logger.log('Fetching list of all collections');

      const collections = await this.qdrantDBService.getCollectionList();

      return {
        status: 'success',
        message: `Found ${collections.length} collections`,
        data: collections,
      };
    } catch (error) {
      this.logger.error(`Error fetching collections list: ${error.message}`);
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // Get detailed configuration and statistics of a vector collection
  @Get('collection/:collectionName')
  async getCollectionInfo(@Param('collectionName') collectionName: string): Promise<QdrantApiResponse> {
    try {
      // Get Qdrant URL from environment variable
      const qdrantUrl = process.env.QDRANT_DB_URL;
      if (!qdrantUrl) {
        throw new Error('QDRANT_DB_URL environment variable is not set');
      }
      // Fetch collection info from Qdrant
      const collectionResponse = await fetch(`${qdrantUrl}/collections/${collectionName}`);
      if (!collectionResponse.ok) {
        return {
          status: 'error',
          message: `Collection ${collectionName} does not exist`,
          data: { exists: false },
        };
      }
      const collectionInfo = await collectionResponse.json();
      return {
        status: 'success',
        message: `Collection ${collectionName} info retrieved`,
        data: collectionInfo,
      };
    } catch (error) {
      this.logger.error(`Error getting collection info for ${collectionName}:`, error);
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // Permanently delete a vector collection and all its data
  @Delete('collection/:collectionName')
  async deleteCollectionByParam(@Param('collectionName') collectionName: string): Promise<QdrantApiResponse> {
    try {
      this.logger.log(`Deleting collection via URL param: ${collectionName}`);

      // Validate input
      if (!collectionName) {
        throw new Error('Collection name is required');
      }

      // Delete collection
      await this.qdrantDBService.deleteCollection(collectionName);

      return {
        status: 'success',
        message: `Successfully deleted collection: ${collectionName}`,
      };
    } catch (error) {
      this.logger.error(`Error deleting collection: ${error.message}`);
      if (error.message.includes('does not exist')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
