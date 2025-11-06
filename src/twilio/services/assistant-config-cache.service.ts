import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Inject } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

interface CachedAssistantConfig {
  config: any;
  timestamp: number;
  expiresAt: number;
}

@Injectable()
export class AssistantConfigCacheService implements OnModuleInit {
  private readonly logger = new Logger(AssistantConfigCacheService.name);
  private cache: Map<string, CachedAssistantConfig> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes default TTL
  private readonly MAX_CACHE_SIZE = 1000; // Maximum number of cached entries

  constructor(@Inject('userService') private readonly userServiceClient: ClientProxy) {}

  onModuleInit() {
    this.logger.log('Assistant config cache service initialized');
    this.logger.log(`Cache TTL: ${this.CACHE_TTL_MS / 1000}s, Max size: ${this.MAX_CACHE_SIZE}`);
  }

  /**
   * Generate cache key from assistantId, organizationId, and userId
   */
  private getCacheKey(assistantId: string, organizationId: string, userId: string): string {
    return `${assistantId}:${organizationId}:${userId}`;
  }

  /**
   * Get assistant configuration from cache or fetch from database
   */
  async getAssistantConfiguration(
    assistantId: string,
    organizationId: string,
    userId: string,
    forceRefresh: boolean = false,
  ): Promise<any> {
    const cacheKey = this.getCacheKey(assistantId, organizationId, userId);

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        // Check if cache is still valid
        if (Date.now() < cached.expiresAt) {
          this.logger.debug(
            `✅ [CACHE HIT] Assistant config for ${assistantId} (org: ${organizationId}, user: ${userId})`,
          );
          return cached.config;
        } else {
          // Cache expired, remove it
          this.cache.delete(cacheKey);
          this.logger.debug(`⏰ [CACHE EXPIRED] Assistant config for ${assistantId}`);
        }
      }
    }

    // Cache miss or expired - fetch from database
    this.logger.debug(
      `🔍 [CACHE MISS] Fetching assistant config for ${assistantId} (org: ${organizationId}, user: ${userId})`,
    );

    try {
      const resp: any = await firstValueFrom(
        this.userServiceClient.send('getAssistantById', {
          requestedUser: { _id: userId },
          assistantId,
          organizationId,
        }),
      );

      const config = resp?.data?.result || { modelConfig: {} };

      // Store in cache
      this.setCache(cacheKey, config);

      return config;
    } catch (error) {
      this.logger.error(`❌ Error fetching assistant configuration: ${(error as any)?.message}`);
      throw error;
    }
  }

  /**
   * Store assistant configuration in cache
   */
  private setCache(cacheKey: string, config: any, ttlMs?: number): void {
    // Clean up if cache is getting too large
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      this.cleanupOldestEntries();
    }

    const now = Date.now();
    const expiresAt = now + (ttlMs || this.CACHE_TTL_MS);

    this.cache.set(cacheKey, {
      config,
      timestamp: now,
      expiresAt,
    });

    this.logger.debug(`💾 [CACHE SET] Assistant config cached with key: ${cacheKey}`);
  }

  /**
   * Invalidate cache for a specific assistant
   */
  invalidateAssistant(assistantId: string, organizationId?: string, userId?: string): void {
    if (organizationId && userId) {
      // Invalidate specific key
      const cacheKey = this.getCacheKey(assistantId, organizationId, userId);
      this.cache.delete(cacheKey);
      this.logger.log(`🗑️ [CACHE INVALIDATED] Assistant config for ${assistantId} (org: ${organizationId}, user: ${userId})`);
    } else {
      // Invalidate all entries for this assistantId
      let invalidatedCount = 0;
      for (const [key, _] of this.cache.entries()) {
        if (key.startsWith(`${assistantId}:`)) {
          this.cache.delete(key);
          invalidatedCount++;
        }
      }
      this.logger.log(`🗑️ [CACHE INVALIDATED] ${invalidatedCount} entries for assistant ${assistantId}`);
    }
  }

  /**
   * Clear all cache entries
   */
  clearAll(): void {
    const count = this.cache.size;
    this.cache.clear();
    this.logger.log(`🗑️ [CACHE CLEARED] All ${count} entries removed`);
  }

  /**
   * Clean up oldest cache entries when cache is full
   */
  private cleanupOldestEntries(): void {
    const entries = Array.from(this.cache.entries());
    // Sort by timestamp (oldest first)
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    // Remove oldest 10% of entries
    const removeCount = Math.max(1, Math.floor(this.cache.size * 0.1));
    for (let i = 0; i < removeCount; i++) {
      this.cache.delete(entries[i][0]);
    }

    this.logger.debug(`🧹 [CACHE CLEANUP] Removed ${removeCount} oldest entries`);
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    size: number;
    maxSize: number;
    hitRate?: number;
  } {
    return {
      size: this.cache.size,
      maxSize: this.MAX_CACHE_SIZE,
    };
  }
}

