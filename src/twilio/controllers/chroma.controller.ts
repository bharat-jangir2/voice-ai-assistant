import { Controller, Post, Body, Get, Logger, HttpException, HttpStatus, Delete, Param } from '@nestjs/common';
import { ChromaDBService } from '../services/chroma-db.services';
import { EmbeddingService } from '../services/embedding.service';
import { QAData, UploadContentDto, GetCollectionDto, ChromaApiResponse, ChromaDocument } from '../interfaces/chroma.interfaces';

@Controller('chroma')
export class ChromaController {
  private readonly logger = new Logger(ChromaController.name);

  constructor(
    private readonly chromaDBService: ChromaDBService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  // Uploads QA pairs to ChromaDB collection with embeddings and metadata
  @Post('upload')
  async uploadContent(@Body() uploadContentDto: UploadContentDto): Promise<ChromaApiResponse> {
    try {
      this.logger.log(`Uploading content to collection: ${uploadContentDto.collectionName}`);

      // Validate input
      if (!uploadContentDto.collectionName || !uploadContentDto.data) {
        throw new Error('Collection name and data are required');
      }

      if (!Array.isArray(uploadContentDto.data)) {
        throw new Error('Data must be an array');
      }

      // Process each QA pair
      const results = await Promise.all(
        uploadContentDto.data.map(async (qa: QAData, index: number) => {
          try {
            // Create a combined text for better context
            const content = `Question: ${qa.question}\nAnswer: ${qa.answer}`;

            // Generate embedding for the content using embedding service directly
            const embedding = await this.embeddingService.generateEmbedding(content);

            // Create document for ChromaDB
            const document: ChromaDocument = {
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
            await this.chromaDBService.addToCollection(uploadContentDto.collectionName, document);

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

  // Retrieves all content from a specified ChromaDB collection
  @Post('collection')
  async getCollectionContent(@Body() getCollectionDto: GetCollectionDto): Promise<ChromaApiResponse> {
    try {
      this.logger.log(`Fetching content from collection: ${getCollectionDto.collectionName}`);

      // Validate input
      if (!getCollectionDto.collectionName) {
        throw new Error('Collection name is required');
      }

      // Get collection content
      const collectionContent = await this.chromaDBService.getCollectionContent(getCollectionDto.collectionName);

      return {
        status: 'success',
        message: `Retrieved content from collection: ${getCollectionDto.collectionName}`,
        data: collectionContent,
      };
    } catch (error) {
      this.logger.error(`Error fetching collection content: ${error.message}`);
      throw error;
    }
  }

  // Lists all available ChromaDB collections
  @Get('collections')
  async getCollections(): Promise<ChromaApiResponse> {
    try {
      this.logger.log('Fetching list of all collections');

      const collections = await this.chromaDBService.getCollectionList();

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

  // Deletes a ChromaDB collection by name from URL parameter
  @Delete('collection/:collectionName')
  async deleteCollectionByParam(@Param('collectionName') collectionName: string): Promise<ChromaApiResponse> {
    try {
      this.logger.log(`Deleting collection via URL param: ${collectionName}`);

      // Validate input
      if (!collectionName) {
        throw new Error('Collection name is required');
      }

      // Delete collection
      await this.chromaDBService.deleteCollection(collectionName);

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
