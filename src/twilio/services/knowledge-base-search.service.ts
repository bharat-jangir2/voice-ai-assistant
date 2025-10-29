import { Injectable, Logger } from '@nestjs/common';
import { QdrantDBService } from './qdrant-db.services';
import { EmbeddingService } from './embedding.service';
import { RedisService } from './redis.service';
import { SemanticSearchService, SemanticQuery, SemanticSearchResult } from './semantic-search.service';

export interface KnowledgeBaseSearchResult {
  content: string;
  score: number;
  fileId: string;
  fileName: string;
  chunkIndex: number;
  totalChunks: number;
}

export interface KnowledgeBaseSearchConfig {
  similarityThreshold: number; // 0.7 = 70% similarity
  maxResultsPerFile: number; // 3 results per file
  maxTotalResults: number; // 10 total results
  cacheTtlSeconds: number; // 300 seconds = 5 minutes
}

@Injectable()
export class KnowledgeBaseSearchService {
  private readonly logger = new Logger(KnowledgeBaseSearchService.name);
  private readonly defaultConfig: KnowledgeBaseSearchConfig = {
    similarityThreshold: 0.25, // 25% similarity threshold (very low for better matching)
    maxResultsPerFile: 5, // Max 5 results per file
    maxTotalResults: 15, // Max 15 total results
    cacheTtlSeconds: 300, // 5 minutes cache
  };

  constructor(
    private readonly qdrantDBService: QdrantDBService,
    private readonly embeddingService: EmbeddingService,
    private readonly redisService: RedisService,
    private readonly semanticSearchService: SemanticSearchService,
  ) {}

  private get redisClient() {
    return (this.redisService as any).redisClient;
  }

  private get qdrantUrl(): string {
    return (this.qdrantDBService as any).qdrantUrl || 'http://localhost:6333';
  }

  /**
   * Search knowledge base files for relevant content with semantic understanding
   */
  async searchKnowledgeBase(
    query: string,
    fileIds: string[],
    organizationId: string,
    config?: Partial<KnowledgeBaseSearchConfig>,
  ): Promise<KnowledgeBaseSearchResult[]> {
    const searchConfig = { ...this.defaultConfig, ...config };

    try {
      this.logger.log(`🔍 Semantic search for query: "${query}" across ${fileIds.length} files`);

      // Check cache first
      const cacheKey = this.generateCacheKey(query, fileIds, organizationId);
      const cachedResults = await this.getCachedResults(cacheKey);
      if (cachedResults) {
        this.logger.log(`📚 Cache hit for query: "${query}"`);
        return cachedResults;
      }

      // Enhance query with semantic understanding
      const semanticQuery = await this.semanticSearchService.enhanceQuery(query);
      this.logger.log(
        `🧠 Semantic analysis - Intent: ${semanticQuery.intent}, Entities: [${semanticQuery.entities.join(', ')}], Context: ${semanticQuery.context}`,
      );

      // Search with original query and expanded queries
      const searchQueries = [query, ...semanticQuery.expandedQueries.slice(0, 3)]; // Limit expanded queries
      const allResults: KnowledgeBaseSearchResult[] = [];

      for (const searchQuery of searchQueries) {
        const searchPromises = fileIds.map((fileId) => this.searchFile(fileId, organizationId, searchQuery, searchConfig));
        const fileResults = await Promise.allSettled(searchPromises);

        fileResults.forEach((result, index) => {
          if (result.status === 'fulfilled' && result.value.length > 0) {
            // Enhance results with semantic scoring
            const enhancedResults = result.value.map((res) => this.enhanceWithSemanticScoring(res, semanticQuery));
            allResults.push(...enhancedResults);
          } else if (result.status === 'rejected') {
            this.logger.warn(`Failed to search file ${fileIds[index]}: ${result.reason}`);
          }
        });
      }

      // Remove duplicates and apply semantic ranking
      const uniqueResults = this.deduplicateAndRankResults(allResults, semanticQuery);

      // Sort by combined score (semantic + similarity) and limit results
      const sortedResults = uniqueResults
        .sort((a, b) => {
          const scoreA = (a.score + (a as any).semanticScore) / 2;
          const scoreB = (b.score + (b as any).semanticScore) / 2;
          return scoreB - scoreA;
        })
        .slice(0, searchConfig.maxTotalResults);

      // Cache the results
      await this.cacheResults(cacheKey, sortedResults, searchConfig.cacheTtlSeconds);

      this.logger.log(`📚 Found ${sortedResults.length} semantically relevant results for query: "${query}"`);
      return sortedResults;
    } catch (error) {
      this.logger.error(`Failed to search knowledge base: ${error.message}`);
      return []; // Return empty array on error to allow normal AI flow
    }
  }

  /**
   * Search a single file's collection
   */
  private async searchFile(
    fileId: string,
    organizationId: string,
    query: string,
    config: KnowledgeBaseSearchConfig,
  ): Promise<KnowledgeBaseSearchResult[]> {
    try {
      const collectionName = `org_${organizationId}_embeddings`;

      // Generate query embedding
      const queryEmbedding = await this.embeddingService.generateEmbedding(query);

      // Search in Qdrant with higher limit to filter later
      const searchUrl = `${this.qdrantUrl}/collections/${collectionName}/points/search`;
      this.logger.debug(`Searching Qdrant: ${searchUrl}`);
      this.logger.debug(`File ID filter: ${fileId}`);

      const searchResponse = await fetch(searchUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          vector: queryEmbedding,
          limit: config.maxResultsPerFile * 2, // Get more results to filter
          with_payload: true,
          filter: {
            must: [
              {
                key: 'metadata.fileId',
                match: { value: fileId },
              },
            ],
          },
        }),
      });

      if (!searchResponse.ok) {
        const errorText = await searchResponse.text();
        this.logger.error(`❌ Qdrant search failed for file ${fileId}: ${searchResponse.statusText}, Response: ${errorText}`);
        return [];
      }

      const searchResult = await searchResponse.json();
      const results: any[] = searchResult.result || [];

      this.logger.debug(`Qdrant search response for file ${fileId}: ${JSON.stringify(searchResult)}`);

      this.logger.debug(`Raw Qdrant results for file ${fileId}: ${results.length} results`);
      results.forEach((result, index) => {
        this.logger.debug(`Result ${index}: score=${result.score}, content="${result.payload?.content?.substring(0, 100)}..."`);
      });

      // Log all results regardless of threshold for debugging
      this.logger.log(`🔍 All Qdrant results for file ${fileId}:`);
      results.forEach((result, index) => {
        this.logger.log(
          `  ${index + 1}. Score: ${result.score.toFixed(3)}, Content: "${result.payload?.content?.substring(0, 50)}..."`,
        );
      });

      // Filter by similarity threshold and format results
      const filteredResults = results
        .filter((result) => result.score >= config.similarityThreshold)
        .slice(0, config.maxResultsPerFile)
        .map((result) => ({
          content: result.payload.content || '',
          score: result.score,
          fileId: result.payload.metadata?.fileId || fileId,
          fileName: result.payload.metadata?.fileName || 'unknown',
          chunkIndex: result.payload.metadata?.chunkIndex || 0,
          totalChunks: result.payload.metadata?.totalChunks || 1,
        }));

      this.logger.debug(
        `Filtered results for file ${fileId}: ${filteredResults.length} results (threshold: ${config.similarityThreshold})`,
      );
      return filteredResults;
    } catch (error) {
      this.logger.warn(`Error searching file ${fileId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Format knowledge base results for AI context
   */
  formatKnowledgeBaseContext(results: KnowledgeBaseSearchResult[]): string {
    if (results.length === 0) {
      return '';
    }

    // Group results by file for better organization
    const groupedResults = results.reduce(
      (acc, result) => {
        if (!acc[result.fileName]) {
          acc[result.fileName] = [];
        }
        acc[result.fileName].push(result);
        return acc;
      },
      {} as Record<string, KnowledgeBaseSearchResult[]>,
    );

    let context = 'Relevant information from knowledge base:\n\n';

    Object.entries(groupedResults).forEach(([fileName, fileResults]) => {
      context += `From "${fileName}":\n`;
      fileResults.forEach((result, index) => {
        context += `${index + 1}. ${result.content}\n`;
      });
      context += '\n';
    });

    return context.trim();
  }

  /**
   * Generate cache key for search results
   */
  private generateCacheKey(query: string, fileIds: string[], organizationId: string): string {
    const sortedFileIds = [...fileIds].sort().join(',');
    const queryHash = this.hashString(query.toLowerCase().trim());
    return `kb_search:${organizationId}:${queryHash}:${sortedFileIds}`;
  }

  /**
   * Get cached search results
   */
  private async getCachedResults(cacheKey: string): Promise<KnowledgeBaseSearchResult[] | null> {
    try {
      if (!this.redisClient || !(this.redisService as any).isConnected) {
        this.logger.debug('Redis not connected, skipping cache lookup');
        return null;
      }
      const cached = await this.redisClient.get(cacheKey);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      this.logger.warn(`Failed to get cached results: ${error.message}`);
      return null;
    }
  }

  /**
   * Cache search results
   */
  private async cacheResults(cacheKey: string, results: KnowledgeBaseSearchResult[], ttlSeconds: number): Promise<void> {
    try {
      if (!this.redisClient || !(this.redisService as any).isConnected) {
        this.logger.debug('Redis not connected, skipping cache storage');
        return;
      }
      await this.redisClient.setEx(cacheKey, ttlSeconds, JSON.stringify(results));
      this.logger.debug(`Cached ${results.length} results for key: ${cacheKey}`);
    } catch (error) {
      this.logger.warn(`Failed to cache results: ${error.message}`);
    }
  }

  /**
   * Simple string hash function
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Clear cache for specific assistant/organization
   */
  async clearCache(organizationId: string, fileIds?: string[]): Promise<void> {
    try {
      if (fileIds) {
        // Clear cache for specific files
        const patterns = fileIds.map((fileId) => `kb_search:${organizationId}:*:${fileId}`);
        for (const pattern of patterns) {
          const keys = await this.redisClient.keys(pattern);
          if (keys.length > 0) {
            await this.redisClient.del(keys);
          }
        }
      } else {
        // Clear all cache for organization
        const pattern = `kb_search:${organizationId}:*`;
        const keys = await this.redisClient.keys(pattern);
        if (keys.length > 0) {
          await this.redisClient.del(keys);
        }
      }

      this.logger.log(`Cleared knowledge base cache for organization: ${organizationId}`);
    } catch (error) {
      this.logger.error(`Failed to clear cache: ${error.message}`);
    }
  }

  /**
   * Enhance search result with semantic scoring
   */
  private enhanceWithSemanticScoring(result: KnowledgeBaseSearchResult, semanticQuery: SemanticQuery): KnowledgeBaseSearchResult {
    const matchedTerms = this.semanticSearchService.extractMatchedTerms(semanticQuery.originalQuery, result.content);
    const semanticScore = this.semanticSearchService.calculateSemanticRelevance(
      semanticQuery.originalQuery,
      result.content,
      matchedTerms,
    );

    return {
      ...result,
      semanticScore,
      matchedTerms,
      context: semanticQuery.context,
    } as any;
  }

  /**
   * Remove duplicates and apply semantic ranking
   */
  private deduplicateAndRankResults(
    results: KnowledgeBaseSearchResult[],
    semanticQuery: SemanticQuery,
  ): KnowledgeBaseSearchResult[] {
    const uniqueResults = new Map<string, KnowledgeBaseSearchResult>();

    results.forEach((result) => {
      const key = `${result.fileId}_${result.chunkIndex}`;
      const existing = uniqueResults.get(key);

      if (!existing) {
        uniqueResults.set(key, result);
      } else {
        // Keep the result with higher combined score
        const currentScore = (result.score + (result as any).semanticScore) / 2;
        const existingScore = (existing.score + (existing as any).semanticScore) / 2;

        if (currentScore > existingScore) {
          uniqueResults.set(key, result);
        }
      }
    });

    return Array.from(uniqueResults.values());
  }

  /**
   * Debug method to check what's in the Qdrant collection
   */
  async debugCollection(organizationId: string, fileId?: string): Promise<void> {
    try {
      const collectionName = `org_${organizationId}_embeddings`;
      const url = `${this.qdrantUrl}/collections/${collectionName}/points/scroll`;

      this.logger.log(`🔍 Debug: Checking collection ${collectionName}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          limit: 100,
          with_payload: true,
          with_vector: false,
          filter: fileId
            ? {
                must: [
                  {
                    key: 'fileId',
                    match: { value: fileId },
                  },
                ],
              }
            : undefined,
        }),
      });

      if (!response.ok) {
        this.logger.error(`Failed to debug collection: ${response.statusText}`);
        return;
      }

      const result = await response.json();
      const points = result.result?.points || [];

      this.logger.log(`🔍 Found ${points.length} points in collection`);

      points.forEach((point: any, index: number) => {
        this.logger.log(`Point ${index}:`);
        this.logger.log(`  ID: ${point.id}`);
        this.logger.log(`  File ID: ${point.payload?.metadata?.fileId}`);
        this.logger.log(`  File Name: ${point.payload?.metadata?.fileName}`);
        this.logger.log(`  Content: "${point.payload?.content?.substring(0, 100)}..."`);
      });
    } catch (error) {
      this.logger.error(`Failed to debug collection: ${error.message}`);
    }
  }

  /**
   * Get search statistics
   */
  async getSearchStats(organizationId: string): Promise<{
    totalSearches: number;
    cacheHitRate: number;
    averageResults: number;
  }> {
    try {
      // This would require additional Redis keys to track statistics
      // For now, return basic stats
      return {
        totalSearches: 0,
        cacheHitRate: 0,
        averageResults: 0,
      };
    } catch (error) {
      this.logger.error(`Failed to get search stats: ${error.message}`);
      return {
        totalSearches: 0,
        cacheHitRate: 0,
        averageResults: 0,
      };
    }
  }
}
