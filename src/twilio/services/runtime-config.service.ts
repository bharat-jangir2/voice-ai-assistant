import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface RuntimeAssistantConfig {
  organizationId: string;
  assistantId: string;
  name: string;
  description: string;
  
  // AI Configuration
  aiConfig: {
    provider: 'openai' | 'google' | 'anthropic';
    model: string;
    temperature: number;
    maxTokens: number;
    systemPrompt: string;
    firstMessage?: string;
    firstMessageMode?: 'assistant-speaks-first' | 'user-speaks-first';
  };

  // Voice Configuration
  voiceConfig: {
    provider: 'elevenlabs' | 'google' | 'openai';
    voiceId: string;
    voiceName: string;
    stability?: number;
    clarity?: number;
    style?: number;
  };

  // Phone Configuration
  phoneNumbers: string[];

  // Function Calling
  functions: Array<{
    name: string;
    description: string;
    parameters: any;
    endpoint: string;
    enabled: boolean;
  }>;

  // Knowledge Base
  knowledgeBaseIds: string[];

  // Advanced Features
  features: {
    recordingEnabled: boolean;
    transcriptionEnabled: boolean;
    realTimeTranscription: boolean;
    interruptDetection: boolean;
    backgroundSound: boolean;
    silenceTimeout: number;
    maxDuration: number;
    endCallPhrases: string[];
    transferPhoneNumber?: string;
  };

  // Analytics & Monitoring
  analytics: {
    trackConversations: boolean;
    trackCosts: boolean;
    trackPerformance: boolean;
    webhookUrl?: string;
    emailNotifications: boolean;
  };

  // Organization Credentials
  credentials: {
    openaiApiKey?: string;
    googleApiKey?: string;
    anthropicApiKey?: string;
    elevenlabsApiKey?: string;
    twilioAccountSid?: string;
    twilioAuthToken?: string;
    twilioPhoneNumber?: string;
  };

  isActive: boolean;
  metadata: Record<string, any>;
}

@Injectable()
export class RuntimeConfigService {
  private readonly logger = new Logger(RuntimeConfigService.name);
  private currentConfig: RuntimeAssistantConfig | null = null;
  private configCache = new Map<string, RuntimeAssistantConfig>();

  constructor(private readonly configService: ConfigService) {}

  /**
   * Set runtime configuration for current session
   */
  setRuntimeConfig(config: RuntimeAssistantConfig): void {
    this.logger.log(`🔧 [RUNTIME CONFIG] Setting configuration for assistant: ${config.name}`);
    
    // Update environment variables with organization credentials
    this.updateEnvironmentVariables(config.credentials);
    
    // Cache the configuration
    this.configCache.set(config.assistantId, config);
    this.currentConfig = config;
    
    this.logger.log(`✅ [RUNTIME CONFIG] Configuration set successfully`);
  }

  /**
   * Get current runtime configuration
   */
  getCurrentConfig(): RuntimeAssistantConfig | null {
    return this.currentConfig;
  }

  /**
   * Get cached configuration by assistant ID
   */
  getCachedConfig(assistantId: string): RuntimeAssistantConfig | undefined {
    return this.configCache.get(assistantId);
  }

  /**
   * Get assistant type from current configuration
   */
  getAssistantType(): string {
    if (this.currentConfig) {
      return this.currentConfig.name.toLowerCase().replace(/\s+/g, '-');
    }
    return 'general';
  }

  /**
   * Get AI provider from current configuration
   */
  getAIProvider(): string {
    if (this.currentConfig) {
      return this.currentConfig.aiConfig.provider;
    }
    return this.configService.get('AI_PROVIDER', 'google');
  }

  /**
   * Get voice provider from current configuration
   */
  getVoiceProvider(): string {
    if (this.currentConfig) {
      return this.currentConfig.voiceConfig.provider;
    }
    return 'google';
  }

  /**
   * Get system prompt from current configuration
   */
  getSystemPrompt(): string {
    if (this.currentConfig) {
      return this.currentConfig.aiConfig.systemPrompt;
    }
    return 'You are a helpful assistant.';
  }

  /**
   * Get first message from current configuration
   */
  getFirstMessage(): string {
    if (this.currentConfig && this.currentConfig.aiConfig.firstMessage) {
      return this.currentConfig.aiConfig.firstMessage;
    }
    return 'Hello! How can I help you today?';
  }

  /**
   * Get first message mode from current configuration
   */
  getFirstMessageMode(): 'assistant-speaks-first' | 'user-speaks-first' {
    if (this.currentConfig) {
      return this.currentConfig.aiConfig.firstMessageMode || 'assistant-speaks-first';
    }
    return 'assistant-speaks-first';
  }

  /**
   * Get voice configuration
   */
  getVoiceConfig(): any {
    if (this.currentConfig) {
      return this.currentConfig.voiceConfig;
    }
    return {
      provider: 'google',
      voiceId: 'en-US-Neural2-J',
      voiceName: 'Google US English',
      stability: 0.5,
      clarity: 0.5,
      style: 0.5,
    };
  }

  /**
   * Get features configuration
   */
  getFeaturesConfig(): any {
    if (this.currentConfig) {
      return this.currentConfig.features;
    }
    return {
      recordingEnabled: true,
      transcriptionEnabled: true,
      realTimeTranscription: true,
      interruptDetection: true,
      backgroundSound: false,
      silenceTimeout: 5000,
      maxDuration: 300000,
      endCallPhrases: ['goodbye', 'bye', 'end call'],
    };
  }

  /**
   * Check if feature is enabled
   */
  isFeatureEnabled(feature: keyof RuntimeAssistantConfig['features']): boolean {
    const features = this.getFeaturesConfig();
    return features[feature] || false;
  }

  /**
   * Get analytics configuration
   */
  getAnalyticsConfig(): any {
    if (this.currentConfig) {
      return this.currentConfig.analytics;
    }
    return {
      trackConversations: true,
      trackCosts: true,
      trackPerformance: true,
      emailNotifications: false,
    };
  }

  /**
   * Get organization credentials
   */
  getCredentials(): any {
    if (this.currentConfig) {
      return this.currentConfig.credentials;
    }
    return {
      openaiApiKey: this.configService.get('OPENAI_API_KEY'),
      googleApiKey: this.configService.get('GOOGLE_API_KEY'),
      anthropicApiKey: this.configService.get('ANTHROPIC_API_KEY'),
      elevenlabsApiKey: this.configService.get('ELEVENLABS_API_KEY'),
      twilioAccountSid: this.configService.get('TWILIO_ACCOUNT_SID'),
      twilioAuthToken: this.configService.get('TWILIO_AUTH_TOKEN'),
      twilioPhoneNumber: this.configService.get('TWILIO_PHONE_NUMBER'),
    };
  }

  /**
   * Get API key for specific provider
   */
  getAPIKey(provider: 'openai' | 'google' | 'anthropic' | 'elevenlabs' | 'twilio'): string | undefined {
    const credentials = this.getCredentials();
    
    switch (provider) {
      case 'openai':
        return credentials.openaiApiKey;
      case 'google':
        return credentials.googleApiKey;
      case 'anthropic':
        return credentials.anthropicApiKey;
      case 'elevenlabs':
        return credentials.elevenlabsApiKey;
      case 'twilio':
        return credentials.twilioAccountSid;
      default:
        return undefined;
    }
  }

  /**
   * Update environment variables with organization credentials
   */
  private updateEnvironmentVariables(credentials: RuntimeAssistantConfig['credentials']): void {
    if (credentials.openaiApiKey) {
      process.env.OPENAI_API_KEY = credentials.openaiApiKey;
    }
    if (credentials.googleApiKey) {
      process.env.GOOGLE_API_KEY = credentials.googleApiKey;
    }
    if (credentials.anthropicApiKey) {
      process.env.ANTHROPIC_API_KEY = credentials.anthropicApiKey;
    }
    if (credentials.elevenlabsApiKey) {
      process.env.ELEVENLABS_API_KEY = credentials.elevenlabsApiKey;
    }
    if (credentials.twilioAccountSid) {
      process.env.TWILIO_ACCOUNT_SID = credentials.twilioAccountSid;
    }
    if (credentials.twilioAuthToken) {
      process.env.TWILIO_AUTH_TOKEN = credentials.twilioAuthToken;
    }
    if (credentials.twilioPhoneNumber) {
      process.env.TWILIO_PHONE_NUMBER = credentials.twilioPhoneNumber;
    }
    
    this.logger.log(`🔧 [RUNTIME CONFIG] Environment variables updated with organization credentials`);
  }

  /**
   * Clear current configuration
   */
  clearCurrentConfig(): void {
    this.currentConfig = null;
    this.logger.log(`🧹 [RUNTIME CONFIG] Current configuration cleared`);
  }

  /**
   * Clear all cached configurations
   */
  clearCache(): void {
    this.configCache.clear();
    this.currentConfig = null;
    this.logger.log(`🧹 [RUNTIME CONFIG] All configurations cleared`);
  }

  /**
   * Get configuration summary for logging
   */
  getConfigSummary(): any {
    if (!this.currentConfig) {
      return { status: 'No configuration set' };
    }

    return {
      assistantId: this.currentConfig.assistantId,
      name: this.currentConfig.name,
      organizationId: this.currentConfig.organizationId,
      aiProvider: this.currentConfig.aiConfig.provider,
      voiceProvider: this.currentConfig.voiceConfig.provider,
      features: Object.keys(this.currentConfig.features).filter(
        key => this.currentConfig!.features[key as keyof typeof this.currentConfig.features]
      ),
      isActive: this.currentConfig.isActive,
    };
  }
}
