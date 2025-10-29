import { Controller, Get, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantApiResponse } from '../interfaces/qdrant.interfaces';
import { EmbeddingService } from '../services/embedding.service';

@Controller('embedding')
export class EmbeddingController {
  private readonly logger = new Logger(EmbeddingController.name);

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly configService: ConfigService,
  ) {}

  // Test embedding service configuration and generate sample vector
  @Get('test-embedding-method')
  async testEmbeddingMethod(): Promise<QdrantApiResponse> {
    try {
      const method = this.configService.get('EMBEDDING_METHOD');

      // Test embedding generation
      const testText = 'Hello world';
      const embedding = await this.embeddingService.generateEmbedding(testText);

      return {
        status: 'success',
        message: 'Embedding method test completed.',
        data: {
          method: method,
          testText: testText,
          embeddingLength: embedding.length,
          firstFewValues: embedding.slice(0, 5),
        },
      };
    } catch (error) {
      this.logger.error(`Error testing embedding method:`, error);
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
