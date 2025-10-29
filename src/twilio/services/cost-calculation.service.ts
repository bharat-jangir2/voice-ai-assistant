import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Cost Calculation Service
 *
 * Calculates dynamic costs for AI messages based on:
 * 1. Model Cost: Based on actual token usage (prompt + completion tokens)
 * 2. Platform Cost: Platform overhead/markup
 *
 * All pricing is configurable via environment variables.
 * See environment variable documentation below for details.
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CostBreakdown {
  modelCost: {
    amount: number;
    currency: string;
    breakdown: {
      promptCost: number;
      completionCost: number;
    };
  };
  platformCost: {
    amount: number;
    currency: string;
    markupPercentage?: number;
  };
  totalCost: {
    amount: number;
    currency: string;
  };
  tokens: TokenUsage;
}

export interface ModelPricing {
  model: string;
  provider: string;
  inputPricePer1kTokens: number; // Price per 1,000 input tokens
  outputPricePer1kTokens: number; // Price per 1,000 output tokens
}

@Injectable()
export class CostCalculationService {
  private readonly logger = new Logger(CostCalculationService.name);
  private readonly modelPricing: Record<string, ModelPricing>;
  private readonly platformConfig: {
    markupPercentage: number;
    fixedFeePerRequest: number;
    currency: string;
  };

  constructor(private readonly configService: ConfigService) {
    // Load platform configuration from environment
    this.platformConfig = {
      markupPercentage: parseFloat(this.configService.get<string>('PLATFORM_MARKUP_PERCENTAGE', '10')),
      fixedFeePerRequest: parseFloat(this.configService.get<string>('PLATFORM_FIXED_FEE_USD', '0.0001')),
      currency: this.configService.get<string>('COST_CURRENCY', 'USD'),
    };

    // Load model pricing from environment or use defaults
    this.modelPricing = this.loadModelPricing();
  }

  /**
   * Load model pricing from environment variables
   * Supports:
   * 1. MODEL_PRICING_FILE_PATH - Path to JSON file (recommended)
   * 2. MODEL_PRICING_JSON - JSON string in env var
   * 3. Individual model variables (MODEL_PRICING_<MODEL>_INPUT/OUTPUT)
   */
  private loadModelPricing(): Record<string, ModelPricing> {
    // Try to load from file path first (most convenient for separate JSON file)
    const pricingFilePath = this.configService.get<string>('MODEL_PRICING_FILE_PATH');
    if (pricingFilePath) {
      try {
        const filePath = path.isAbsolute(pricingFilePath) ? pricingFilePath : path.join(process.cwd(), pricingFilePath);

        if (fs.existsSync(filePath)) {
          const fileContent = fs.readFileSync(filePath, 'utf-8');
          const parsed = JSON.parse(fileContent);
          this.logger.log(`Loaded model pricing from file: ${filePath}`);
          return parsed;
        } else {
          this.logger.warn(`Model pricing file not found: ${filePath}, using defaults`);
        }
      } catch (error) {
        this.logger.warn(`Failed to load model pricing from file: ${error.message}, using defaults`);
      }
    }

    // Try to load from JSON string in env var
    const pricingJson = this.configService.get<string>('MODEL_PRICING_JSON');
    if (pricingJson) {
      try {
        const parsed = JSON.parse(pricingJson);
        this.logger.log(`Loaded model pricing from MODEL_PRICING_JSON`);
        return parsed;
      } catch (error) {
        this.logger.warn(`Failed to parse MODEL_PRICING_JSON, using defaults: ${error.message}`);
      }
    }

    // Fallback to default pricing (can be overridden by individual model env vars)
    const defaultPricing: Record<string, ModelPricing> = {
      // OpenAI Models
      'gpt-4-turbo': {
        model: 'gpt-4-turbo',
        provider: 'openai',
        inputPricePer1kTokens: 0.01,
        outputPricePer1kTokens: 0.03,
      },
      'gpt-4': {
        model: 'gpt-4',
        provider: 'openai',
        inputPricePer1kTokens: 0.03,
        outputPricePer1kTokens: 0.06,
      },
      'gpt-4o': {
        model: 'gpt-4o',
        provider: 'openai',
        inputPricePer1kTokens: 0.005,
        outputPricePer1kTokens: 0.015,
      },
      'gpt-4o-mini': {
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputPricePer1kTokens: 0.00015,
        outputPricePer1kTokens: 0.0006,
      },
      'gpt-3.5-turbo': {
        model: 'gpt-3.5-turbo',
        provider: 'openai',
        inputPricePer1kTokens: 0.0005,
        outputPricePer1kTokens: 0.0015,
      },
      'gpt-3.5-turbo-16k': {
        model: 'gpt-3.5-turbo-16k',
        provider: 'openai',
        inputPricePer1kTokens: 0.003,
        outputPricePer1kTokens: 0.004,
      },
      'gpt-3.5-turbo-instruct': {
        model: 'gpt-3.5-turbo-instruct',
        provider: 'openai',
        inputPricePer1kTokens: 0.0015,
        outputPricePer1kTokens: 0.002,
      },
      'gpt-3.5': {
        model: 'gpt-3.5',
        provider: 'openai',
        inputPricePer1kTokens: 0.002,
        outputPricePer1kTokens: 0.002,
      },
      'gpt-3': {
        model: 'gpt-3',
        provider: 'openai',
        inputPricePer1kTokens: 0.002,
        outputPricePer1kTokens: 0.002,
      },
      'gpt-2': {
        model: 'gpt-2',
        provider: 'openai',
        inputPricePer1kTokens: 0.0001,
        outputPricePer1kTokens: 0.0001,
      },
      'gpt-4-turbo-16k': {
        model: 'gpt-4-turbo-16k',
        provider: 'openai',
        inputPricePer1kTokens: 0.01,
        outputPricePer1kTokens: 0.03,
      },
      'gpt-4-turbo-32k': {
        model: 'gpt-4-turbo-32k',
        provider: 'openai',
        inputPricePer1kTokens: 0.01,
        outputPricePer1kTokens: 0.03,
      },
      // Azure OpenAI Models (same pricing as OpenAI, but identified separately)
      'azure-gpt-4-turbo': {
        model: 'azure-gpt-4-turbo',
        provider: 'azure-openai',
        inputPricePer1kTokens: 0.01,
        outputPricePer1kTokens: 0.03,
      },
      'azure-gpt-4': {
        model: 'azure-gpt-4',
        provider: 'azure-openai',
        inputPricePer1kTokens: 0.03,
        outputPricePer1kTokens: 0.06,
      },
      'azure-gpt-3.5-turbo': {
        model: 'azure-gpt-3.5-turbo',
        provider: 'azure-openai',
        inputPricePer1kTokens: 0.0005,
        outputPricePer1kTokens: 0.0015,
      },

      // Google Gemini Models
      'gemini-pro': {
        model: 'gemini-pro',
        provider: 'google',
        inputPricePer1kTokens: 0.0005,
        outputPricePer1kTokens: 0.0015,
      },
      'gemini-1.5-pro': {
        model: 'gemini-1.5-pro',
        provider: 'google',
        inputPricePer1kTokens: 0.00125,
        outputPricePer1kTokens: 0.005,
      },
      'gemini-1.5-flash': {
        model: 'gemini-1.5-flash',
        provider: 'google',
        inputPricePer1kTokens: 0.000075,
        outputPricePer1kTokens: 0.0003,
      },
      'gemini-2.5-flash': {
        model: 'gemini-2.5-flash',
        provider: 'google',
        inputPricePer1kTokens: 0.000075,
        outputPricePer1kTokens: 0.0003,
      },
      'gemini-1': {
        model: 'gemini-1',
        provider: 'google',
        inputPricePer1kTokens: 0.0005,
        outputPricePer1kTokens: 0.0015,
      },
      'gemini-2.0-flash-exp': {
        model: 'gemini-2.0-flash-exp',
        provider: 'google',
        inputPricePer1kTokens: 0.000075,
        outputPricePer1kTokens: 0.0003,
      },
      'gemini-pro-vision': {
        model: 'gemini-pro-vision',
        provider: 'google',
        inputPricePer1kTokens: 0.0005,
        outputPricePer1kTokens: 0.0015,
      },
      'gemini-ultra': {
        model: 'gemini-ultra',
        provider: 'google',
        inputPricePer1kTokens: 0.00125,
        outputPricePer1kTokens: 0.005,
      },

      // Anthropic Claude Models
      'claude-1': {
        model: 'claude-1',
        provider: 'anthropic',
        inputPricePer1kTokens: 0.008,
        outputPricePer1kTokens: 0.024,
      },
      'claude-2': {
        model: 'claude-2',
        provider: 'anthropic',
        inputPricePer1kTokens: 0.008,
        outputPricePer1kTokens: 0.024,
      },
      'claude-instant-1': {
        model: 'claude-instant-1',
        provider: 'anthropic',
        inputPricePer1kTokens: 0.0008,
        outputPricePer1kTokens: 0.0024,
      },
      'claude-instant-2': {
        model: 'claude-instant-2',
        provider: 'anthropic',
        inputPricePer1kTokens: 0.0008,
        outputPricePer1kTokens: 0.0024,
      },
      'claude-3-opus': {
        model: 'claude-3-opus',
        provider: 'anthropic',
        inputPricePer1kTokens: 0.015,
        outputPricePer1kTokens: 0.075,
      },
      'claude-3-sonnet': {
        model: 'claude-3-sonnet',
        provider: 'anthropic',
        inputPricePer1kTokens: 0.003,
        outputPricePer1kTokens: 0.015,
      },
      'claude-3-haiku': {
        model: 'claude-3-haiku',
        provider: 'anthropic',
        inputPricePer1kTokens: 0.00025,
        outputPricePer1kTokens: 0.00125,
      },
      'claude-3-5-sonnet': {
        model: 'claude-3-5-sonnet',
        provider: 'anthropic',
        inputPricePer1kTokens: 0.003,
        outputPricePer1kTokens: 0.015,
      },
      'claude-3-5-haiku': {
        model: 'claude-3-5-haiku',
        provider: 'anthropic',
        inputPricePer1kTokens: 0.00025,
        outputPricePer1kTokens: 0.00125,
      },

      // Groq Models (approximate pricing)
      'llama-3-70b': {
        model: 'llama-3-70b',
        provider: 'groq',
        inputPricePer1kTokens: 0.0007,
        outputPricePer1kTokens: 0.0008,
      },
      'llama2-70b-4096': {
        model: 'llama2-70b-4096',
        provider: 'groq',
        inputPricePer1kTokens: 0.0007,
        outputPricePer1kTokens: 0.0008,
      },
      'mixtral-8x7b': {
        model: 'mixtral-8x7b',
        provider: 'groq',
        inputPricePer1kTokens: 0.00027,
        outputPricePer1kTokens: 0.00027,
      },
      'mixtral-8x7b-32768': {
        model: 'mixtral-8x7b-32768',
        provider: 'groq',
        inputPricePer1kTokens: 0.00027,
        outputPricePer1kTokens: 0.00027,
      },

      // Mistral Models
      'mistral-7b': {
        model: 'mistral-7b',
        provider: 'mistral',
        inputPricePer1kTokens: 0.0002,
        outputPricePer1kTokens: 0.0002,
      },
      'mistral-8x7b': {
        model: 'mistral-8x7b',
        provider: 'mistral',
        inputPricePer1kTokens: 0.00027,
        outputPricePer1kTokens: 0.00027,
      },
      'mistral-large': {
        model: 'mistral-large',
        provider: 'mistral',
        inputPricePer1kTokens: 0.002,
        outputPricePer1kTokens: 0.006,
      },
      'mistral-small': {
        model: 'mistral-small',
        provider: 'mistral',
        inputPricePer1kTokens: 0.0001,
        outputPricePer1kTokens: 0.0001,
      },

      // Perplexity Models
      'perplexity-standard': {
        model: 'perplexity-standard',
        provider: 'perplexity',
        inputPricePer1kTokens: 0.0005,
        outputPricePer1kTokens: 0.0015,
      },
      'perplexity-plus': {
        model: 'perplexity-plus',
        provider: 'perplexity',
        inputPricePer1kTokens: 0.001,
        outputPricePer1kTokens: 0.002,
      },

      // Cerebras Models
      'cerebras-gpt-6.7b': {
        model: 'cerebras-gpt-6.7b',
        provider: 'cerebras',
        inputPricePer1kTokens: 0.0001,
        outputPricePer1kTokens: 0.0001,
      },
      'cerebras-gpt-13b': {
        model: 'cerebras-gpt-13b',
        provider: 'cerebras',
        inputPricePer1kTokens: 0.00015,
        outputPricePer1kTokens: 0.00015,
      },

      // DeepSeek Models
      'deepseek-coder': {
        model: 'deepseek-coder',
        provider: 'deepseek',
        inputPricePer1kTokens: 0.0002,
        outputPricePer1kTokens: 0.0002,
      },
      'deepseek-chat': {
        model: 'deepseek-chat',
        provider: 'deepseek',
        inputPricePer1kTokens: 0.00018,
        outputPricePer1kTokens: 0.00018,
      },

      // XAI (Grok) Models
      'grok-1': {
        model: 'grok-1',
        provider: 'xai',
        inputPricePer1kTokens: 0.001,
        outputPricePer1kTokens: 0.003,
      },
      'grok-1.5': {
        model: 'grok-1.5',
        provider: 'xai',
        inputPricePer1kTokens: 0.001,
        outputPricePer1kTokens: 0.003,
      },

      // Together AI Models (approximate pricing)
      'meta-llama/Llama-2-70b-chat-hf': {
        model: 'meta-llama/Llama-2-70b-chat-hf',
        provider: 'together-ai',
        inputPricePer1kTokens: 0.0007,
        outputPricePer1kTokens: 0.0007,
      },
      'codellama/CodeLlama-34b-Instruct-hf': {
        model: 'codellama/CodeLlama-34b-Instruct-hf',
        provider: 'together-ai',
        inputPricePer1kTokens: 0.0007,
        outputPricePer1kTokens: 0.0007,
      },

      // Anyscale Models (approximate pricing)
      'meta-llama/Llama-2-7b-chat-hf': {
        model: 'meta-llama/Llama-2-7b-chat-hf',
        provider: 'anyscale',
        inputPricePer1kTokens: 0.00015,
        outputPricePer1kTokens: 0.00015,
      },
      'meta-llama/Llama-2-13b-chat-hf': {
        model: 'meta-llama/Llama-2-13b-chat-hf',
        provider: 'anyscale',
        inputPricePer1kTokens: 0.00018,
        outputPricePer1kTokens: 0.00018,
      },

      // OpenRouter Models
      'openai/gpt-4': {
        model: 'openai/gpt-4',
        provider: 'openrouter',
        inputPricePer1kTokens: 0.03,
        outputPricePer1kTokens: 0.06,
      },
      'anthropic/claude-3-sonnet': {
        model: 'anthropic/claude-3-sonnet',
        provider: 'openrouter',
        inputPricePer1kTokens: 0.003,
        outputPricePer1kTokens: 0.015,
      },

      // DeepInfra Models
      'mistralai/Mistral-7B-Instruct-v0.1': {
        model: 'mistralai/Mistral-7B-Instruct-v0.1',
        provider: 'deepinfra',
        inputPricePer1kTokens: 0.0002,
        outputPricePer1kTokens: 0.0002,
      },

      // Inflection AI Models
      pi: {
        model: 'pi',
        provider: 'inflection-ai',
        inputPricePer1kTokens: 0.00025,
        outputPricePer1kTokens: 0.00025,
      },
      'pi-pro': {
        model: 'pi-pro',
        provider: 'inflection-ai',
        inputPricePer1kTokens: 0.00035,
        outputPricePer1kTokens: 0.00035,
      },

      // Custom Models
      'custom-model-1': {
        model: 'custom-model-1',
        provider: 'custom',
        inputPricePer1kTokens: 0.0002,
        outputPricePer1kTokens: 0.0002,
      },
    };

    // Override with individual model environment variables if set
    // Format: MODEL_PRICING_<MODEL_NAME>_INPUT and MODEL_PRICING_<MODEL_NAME>_OUTPUT
    // Example: MODEL_PRICING_GPT_4_TURBO_INPUT=0.01
    Object.keys(defaultPricing).forEach((modelKey) => {
      const envKey = modelKey.toUpperCase().replace(/-/g, '_').replace(/[./]/g, '_');
      const inputPrice = this.configService.get<string>(`MODEL_PRICING_${envKey}_INPUT`);
      const outputPrice = this.configService.get<string>(`MODEL_PRICING_${envKey}_OUTPUT`);

      if (inputPrice) {
        defaultPricing[modelKey].inputPricePer1kTokens = parseFloat(inputPrice);
      }
      if (outputPrice) {
        defaultPricing[modelKey].outputPricePer1kTokens = parseFloat(outputPrice);
      }
    });

    this.logger.log(`Loaded pricing for ${Object.keys(defaultPricing).length} models`);
    return defaultPricing;
  }

  /**
   * Calculate total cost for an AI message
   *
   * @param model - Model name (e.g., 'gpt-4-turbo', 'gemini-pro')
   * @param tokens - Token usage breakdown
   * @param provider - Optional provider name for better model detection
   * @returns Complete cost breakdown
   */
  calculateCost(model: string, tokens: TokenUsage, provider?: string): CostBreakdown {
    if (!model) {
      this.logger.warn(`Model name is empty, using default pricing`);
      return this.calculateCostWithDefaults('gpt-3.5-turbo', tokens, provider);
    }

    // Normalize model name
    const normalizedModel = this.normalizeModelName(model);

    // Try to get pricing with provider hint
    const pricing = this.getModelPricing(normalizedModel, provider);

    if (!pricing) {
      this.logger.warn(
        `No pricing found for model: ${model} (normalized: ${normalizedModel})${provider ? `, provider: ${provider}` : ''}, using provider-based default`,
      );
      return this.calculateCostWithDefaults(normalizedModel, tokens, provider);
    }

    // Calculate model cost (input + output)
    const promptCost = (tokens.promptTokens / 1000) * pricing.inputPricePer1kTokens;
    const completionCost = (tokens.completionTokens / 1000) * pricing.outputPricePer1kTokens;
    const modelCostAmount = promptCost + completionCost;

    // Calculate platform cost (markup + fixed fee)
    const platformCostAmount =
      modelCostAmount * (this.platformConfig.markupPercentage / 100) + this.platformConfig.fixedFeePerRequest;

    // Total cost
    const totalCostAmount = modelCostAmount + platformCostAmount;

    return {
      modelCost: {
        amount: this.roundToDecimal(modelCostAmount, 6),
        currency: this.platformConfig.currency,
        breakdown: {
          promptCost: this.roundToDecimal(promptCost, 6),
          completionCost: this.roundToDecimal(completionCost, 6),
        },
      },
      platformCost: {
        amount: this.roundToDecimal(platformCostAmount, 6),
        currency: this.platformConfig.currency,
        markupPercentage: this.platformConfig.markupPercentage,
      },
      totalCost: {
        amount: this.roundToDecimal(totalCostAmount, 6),
        currency: this.platformConfig.currency,
      },
      tokens,
    };
  }

  /**
   * Normalize model name for consistent matching
   */
  private normalizeModelName(model: string): string {
    if (!model) return model;

    // Convert to lowercase
    let normalized = model.toLowerCase().trim();

    // Handle Azure OpenAI models (remove deployment prefix)
    if (normalized.startsWith('azure-') || normalized.includes('/deployments/')) {
      normalized = normalized.replace(/^azure-/, '').replace(/.*\/deployments\//, '');
    }

    // Remove common prefixes
    normalized = normalized.replace(/^model[:]\s*/i, '');

    // Handle version suffixes (e.g., "gpt-4-turbo-preview" -> "gpt-4-turbo")
    normalized = normalized.replace(/-(preview|beta|alpha|v\d+)$/i, '');

    return normalized;
  }

  /**
   * Get pricing for a specific model with provider hint
   */
  private getModelPricing(model: string, provider?: string): ModelPricing | null {
    const normalizedModel = this.normalizeModelName(model);

    // Try exact match first
    if (this.modelPricing[normalizedModel]) {
      return this.modelPricing[normalizedModel];
    }

    // Try with provider filter if provider is known
    if (provider) {
      const providerLower = provider.toLowerCase();
      const providerModels = Object.values(this.modelPricing).filter((p) => p.provider === providerLower);

      // Try exact match within provider models
      const exactMatch = providerModels.find((p) => p.model === normalizedModel);
      if (exactMatch) {
        return exactMatch;
      }

      // Try partial match within provider models
      const partialMatch = providerModels.find((p) => normalizedModel.includes(p.model) || p.model.includes(normalizedModel));
      if (partialMatch) {
        this.logger.debug(`Found partial match for ${model} -> ${partialMatch.model} (provider: ${provider})`);
        return partialMatch;
      }
    }

    // Try partial match across all models (e.g., 'gpt-4' matches 'gpt-4-turbo')
    const matchingKey = Object.keys(this.modelPricing).find(
      (key) => normalizedModel.includes(key) || key.includes(normalizedModel),
    );

    if (matchingKey) {
      this.logger.debug(`Found partial match for ${model} -> ${matchingKey}`);
      return this.modelPricing[matchingKey];
    }

    return null;
  }

  /**
   * Get provider-based default pricing
   */
  private getProviderDefaultPricing(provider?: string): ModelPricing | null {
    if (!provider) return null;

    const providerLower = provider.toLowerCase();
    const providerDefaults: Record<string, string> = {
      openai: 'gpt-3.5-turbo',
      'azure-openai': 'gpt-3.5-turbo',
      google: 'gemini-pro',
      gemini: 'gemini-pro',
      anthropic: 'claude-3-haiku',
      claude: 'claude-3-haiku',
      groq: 'llama-3-70b',
      mistral: 'mistral-7b',
      perplexity: 'perplexity-standard',
      cerebras: 'cerebras-gpt-6.7b',
      deepseek: 'deepseek-chat',
      xai: 'grok-1',
      'together-ai': 'meta-llama/Llama-2-70b-chat-hf',
      anyscale: 'meta-llama/Llama-2-7b-chat-hf',
      openrouter: 'openai/gpt-4',
      deepinfra: 'mistralai/Mistral-7B-Instruct-v0.1',
      'inflection-ai': 'pi',
      custom: 'custom-model-1',
    };

    const defaultModel = providerDefaults[providerLower];
    if (defaultModel && this.modelPricing[defaultModel]) {
      return this.modelPricing[defaultModel];
    }

    return null;
  }

  /**
   * Calculate cost with default pricing (fallback)
   */
  private calculateCostWithDefaults(model: string, tokens: TokenUsage, provider?: string): CostBreakdown {
    // Try provider-specific default first
    let defaultPricing = this.getProviderDefaultPricing(provider);

    // Fallback to GPT-3.5 Turbo if no provider default found
    if (!defaultPricing) {
      defaultPricing = this.modelPricing['gpt-3.5-turbo'];
      this.logger.warn(
        `Using GPT-3.5 Turbo default pricing for model: ${model}${provider ? ` (provider: ${provider})` : ''}. ` +
          `Consider adding pricing for this model via MODEL_PRICING_JSON or individual env vars.`,
      );
    } else {
      this.logger.log(`Using provider default pricing (${defaultPricing.model}) for model: ${model} (provider: ${provider})`);
    }

    const promptCost = (tokens.promptTokens / 1000) * defaultPricing.inputPricePer1kTokens;
    const completionCost = (tokens.completionTokens / 1000) * defaultPricing.outputPricePer1kTokens;
    const modelCostAmount = promptCost + completionCost;

    const platformCostAmount =
      modelCostAmount * (this.platformConfig.markupPercentage / 100) + this.platformConfig.fixedFeePerRequest;

    return {
      modelCost: {
        amount: this.roundToDecimal(modelCostAmount, 6),
        currency: this.platformConfig.currency,
        breakdown: {
          promptCost: this.roundToDecimal(promptCost, 6),
          completionCost: this.roundToDecimal(completionCost, 6),
        },
      },
      platformCost: {
        amount: this.roundToDecimal(platformCostAmount, 6),
        currency: this.platformConfig.currency,
        markupPercentage: this.platformConfig.markupPercentage,
      },
      totalCost: {
        amount: this.roundToDecimal(modelCostAmount + platformCostAmount, 6),
        currency: this.platformConfig.currency,
      },
      tokens,
    };
  }

  /**
   * Round to specific decimal places
   */
  private roundToDecimal(value: number, decimals: number): number {
    return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
  }

  /**
   * Extract token usage from AI provider response
   * Different providers return token usage in different formats
   */
  extractTokenUsage(response: any, provider: string): TokenUsage {
    let promptTokens = 0;
    let completionTokens = 0;

    switch (provider.toLowerCase()) {
      case 'openai':
        // OpenAI format: response.usage.prompt_tokens, response.usage.completion_tokens
        promptTokens = response.usage?.prompt_tokens || response.usage?.promptTokens || 0;
        completionTokens = response.usage?.completion_tokens || response.usage?.completionTokens || 0;
        break;

      case 'google':
      case 'gemini':
        // Google format: response.usageMetadata.promptTokenCount, response.usageMetadata.candidatesTokenCount
        promptTokens = response.usageMetadata?.promptTokenCount || response.usage?.promptTokens || 0;
        completionTokens = response.usageMetadata?.candidatesTokenCount || response.usage?.completionTokens || 0;
        break;

      case 'anthropic':
      case 'claude':
        // Anthropic format: response.usage.input_tokens, response.usage.output_tokens
        promptTokens = response.usage?.input_tokens || response.usage?.inputTokens || 0;
        completionTokens = response.usage?.output_tokens || response.usage?.outputTokens || 0;
        break;

      default:
        this.logger.warn(`Unknown provider: ${provider}, unable to extract token usage`);
    }

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  /**
   * Format cost for display
   */
  formatCost(costBreakdown: CostBreakdown): string {
    return `
Model Cost: $${costBreakdown.modelCost.amount.toFixed(6)}
  - Prompt: $${costBreakdown.modelCost.breakdown.promptCost.toFixed(6)} (${costBreakdown.tokens.promptTokens} tokens)
  - Completion: $${costBreakdown.modelCost.breakdown.completionCost.toFixed(6)} (${costBreakdown.tokens.completionTokens} tokens)
Platform Cost: $${costBreakdown.platformCost.amount.toFixed(6)} (${costBreakdown.platformCost.markupPercentage}% markup)
Total Cost: $${costBreakdown.totalCost.amount.toFixed(6)}
    `.trim();
  }

  /**
   * Calculate cost for knowledge base operations
   * Includes: embedding generation, search operations, and optional AI refinement
   */
  calculateKnowledgeBaseCost(options: {
    queryEmbeddingCost?: number; // Cost for generating query embedding
    searchOperations?: number; // Number of search operations
    fallbackAICost?: number; // Cost if AI was used to refine response
    fallbackAITokens?: TokenUsage; // Token usage if AI was used
  }): {
    embeddingCost: number;
    searchCost: number;
    aiCost: number;
    totalCost: number;
  } {
    // Embedding generation cost (if using OpenAI embeddings)
    // Default: $0.00001 per query embedding (configurable via KB_EMBEDDING_COST_USD)
    const defaultEmbeddingCost = parseFloat(this.configService.get<string>('KB_EMBEDDING_COST_USD', '0.00001'));
    const embeddingCost = options.queryEmbeddingCost ?? defaultEmbeddingCost;

    // Search cost (Qdrant operations - minimal infrastructure cost)
    // Default: $0.000001 per search operation (configurable via KB_SEARCH_COST_PER_OPERATION_USD)
    const searchOperations = options.searchOperations || 1;
    const searchCostPerOperation = parseFloat(this.configService.get<string>('KB_SEARCH_COST_PER_OPERATION_USD', '0.000001'));
    const searchCost = searchOperations * searchCostPerOperation;

    // AI refinement cost (if fallback AI was used)
    let aiCost = 0;
    if (options.fallbackAICost) {
      aiCost = options.fallbackAICost;
    } else if (options.fallbackAITokens) {
      // Calculate AI cost from tokens if provided
      const aiCostBreakdown = this.calculateCost('gpt-3.5-turbo', options.fallbackAITokens);
      aiCost = aiCostBreakdown.totalCost.amount;
    }

    const totalCost = embeddingCost + searchCost + aiCost;

    return {
      embeddingCost: this.roundToDecimal(embeddingCost, 6),
      searchCost: this.roundToDecimal(searchCost, 6),
      aiCost: this.roundToDecimal(aiCost, 6),
      totalCost: this.roundToDecimal(totalCost, 6),
    };
  }

  /**
   * Create cost breakdown for knowledge base response
   */
  createKnowledgeBaseCostBreakdown(options: {
    queryEmbeddingCost?: number;
    searchOperations?: number;
    fallbackAICost?: number;
    fallbackAITokens?: TokenUsage;
  }): {
    amount: number;
    currency: string;
    service: string;
    breakdown: {
      embeddingCost: number;
      searchCost: number;
      aiCost: number;
    };
  } {
    const kbCost = this.calculateKnowledgeBaseCost(options);

    return {
      amount: kbCost.totalCost,
      currency: 'USD',
      service: 'knowledge-base',
      breakdown: {
        embeddingCost: kbCost.embeddingCost,
        searchCost: kbCost.searchCost,
        aiCost: kbCost.aiCost,
      },
    };
  }
}
