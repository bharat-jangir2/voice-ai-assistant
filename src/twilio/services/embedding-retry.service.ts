import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeBaseEmbeddingService, KnowledgeBaseFileData } from './knowledge-base-embedding.service';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

@Injectable()
export class EmbeddingRetryService {
  private readonly logger = new Logger(EmbeddingRetryService.name);
  private readonly defaultRetryConfig: RetryConfig = {
    maxRetries: 3,
    baseDelayMs: 1000, // 1 second
    maxDelayMs: 10000, // 10 seconds
    backoffMultiplier: 2,
  };

  constructor(private readonly knowledgeBaseEmbeddingService: KnowledgeBaseEmbeddingService) {}

  /**
   * Process file with retry logic
   */
  async processFileWithRetry(fileData: KnowledgeBaseFileData, retryConfig?: Partial<RetryConfig>): Promise<void> {
    const config = { ...this.defaultRetryConfig, ...retryConfig };
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      try {
        this.logger.log(`Processing file ${fileData.fileName} (attempt ${attempt}/${config.maxRetries})`);

        await this.knowledgeBaseEmbeddingService.processAndStoreFile(fileData);

        this.logger.log(`Successfully processed file ${fileData.fileName} on attempt ${attempt}`);
        return; // Success, exit retry loop
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(`Attempt ${attempt} failed for file ${fileData.fileName}: ${error.message}`);

        // If this is the last attempt, don't wait
        if (attempt === config.maxRetries) {
          break;
        }

        // Calculate delay with exponential backoff
        const delay = this.calculateDelay(attempt, config);
        this.logger.log(`Waiting ${delay}ms before retry ${attempt + 1} for file ${fileData.fileName}`);

        await this.sleep(delay);
      }
    }

    // All retries failed
    this.logger.error(`Failed to process file ${fileData.fileName} after ${config.maxRetries} attempts`);
    throw lastError || new Error('Unknown error occurred during file processing');
  }

  /**
   * Delete file embeddings with retry logic
   */
  async deleteFileEmbeddingsWithRetry(fileId: string, organizationId: string, retryConfig?: Partial<RetryConfig>): Promise<void> {
    const config = { ...this.defaultRetryConfig, ...retryConfig };
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      try {
        this.logger.log(`Deleting embeddings for file ${fileId} (attempt ${attempt}/${config.maxRetries})`);

        await this.knowledgeBaseEmbeddingService.deleteFileEmbeddings(fileId, organizationId);

        this.logger.log(`Successfully deleted embeddings for file ${fileId} on attempt ${attempt}`);
        return; // Success, exit retry loop
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(`Attempt ${attempt} failed to delete embeddings for file ${fileId}: ${error.message}`);

        // If this is the last attempt, don't wait
        if (attempt === config.maxRetries) {
          break;
        }

        // Calculate delay with exponential backoff
        const delay = this.calculateDelay(attempt, config);
        this.logger.log(`Waiting ${delay}ms before retry ${attempt + 1} for file ${fileId}`);

        await this.sleep(delay);
      }
    }

    // All retries failed
    this.logger.error(`Failed to delete embeddings for file ${fileId} after ${config.maxRetries} attempts`);
    throw lastError || new Error('Unknown error occurred during embedding deletion');
  }

  /**
   * Calculate delay with exponential backoff
   */
  private calculateDelay(attempt: number, config: RetryConfig): number {
    const delay = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
    return Math.min(delay, config.maxDelayMs);
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: Error): boolean {
    // Define which errors should trigger a retry
    const retryableErrorPatterns = [
      /timeout/i,
      /network/i,
      /connection/i,
      /temporary/i,
      /unavailable/i,
      /rate limit/i,
      /throttle/i,
    ];

    return retryableErrorPatterns.some((pattern) => pattern.test(error.message));
  }

  /**
   * Process file with intelligent retry (only retry on retryable errors)
   */
  async processFileWithIntelligentRetry(fileData: KnowledgeBaseFileData, retryConfig?: Partial<RetryConfig>): Promise<void> {
    const config = { ...this.defaultRetryConfig, ...retryConfig };
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      try {
        this.logger.log(`Processing file ${fileData.fileName} (attempt ${attempt}/${config.maxRetries})`);

        await this.knowledgeBaseEmbeddingService.processAndStoreFile(fileData);

        this.logger.log(`Successfully processed file ${fileData.fileName} on attempt ${attempt}`);
        return; // Success, exit retry loop
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(`Attempt ${attempt} failed for file ${fileData.fileName}: ${error.message}`);

        // Check if error is retryable
        if (!this.isRetryableError(lastError)) {
          this.logger.error(`Non-retryable error for file ${fileData.fileName}: ${lastError.message}`);
          throw lastError; // Don't retry non-retryable errors
        }

        // If this is the last attempt, don't wait
        if (attempt === config.maxRetries) {
          break;
        }

        // Calculate delay with exponential backoff
        const delay = this.calculateDelay(attempt, config);
        this.logger.log(`Waiting ${delay}ms before retry ${attempt + 1} for file ${fileData.fileName}`);

        await this.sleep(delay);
      }
    }

    // All retries failed
    this.logger.error(`Failed to process file ${fileData.fileName} after ${config.maxRetries} attempts`);
    throw lastError || new Error('Unknown error occurred during file processing');
  }
}
