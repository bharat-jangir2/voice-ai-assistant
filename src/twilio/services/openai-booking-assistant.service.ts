import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { OpenAI } from 'openai';

@Injectable()
export class OpenAIBookingAssistantService {
  private readonly openai: OpenAI;
  private readonly logger = new Logger(OpenAIBookingAssistantService.name, { timestamp: true });
  private assistantId: string;
  private vectorStoreId: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not defined');
    }
    this.openai = new OpenAI({ apiKey });
  }

  private async initializeAssistant() {
    // Determine which assistant to use based on configuration
    const assistantType = this.configService.get<string>('ASSISTANT_TYPE') || 'hospital';
    this.logger.debug(`Initializing assistant with type: ${assistantType}`);

    // Load the assistant configuration
    const assistantConfig = await this.loadAssistantConfig(assistantType);

    // Initialize the assistant and vector store
    await this.createNewAssistant(assistantType, assistantConfig);
    await this.createVectorStore(assistantType, assistantConfig);

    // Only update the assistant with vector store if both exist
    if (this.assistantId && this.vectorStoreId) {
      await this.updateAssistantWithVectorStore(this.assistantId, this.vectorStoreId);
    }
  }

  private async loadAssistantConfig(type: string): Promise<any> {
    try {
      const configPath = `src/twilio/assistant/${type}/prompt.json`;
      this.logger.debug(`Loading assistant config from: ${configPath}`);

      // Ensure the directory exists before trying to read from it
      const dirPath = `src/twilio/assistant/${type}`;
      if (!fs.existsSync(dirPath)) {
        this.logger.warn(`Assistant config directory not found: ${dirPath}. Creating it.`);
        fs.mkdirSync(dirPath, { recursive: true });
      }

      // Check if prompt.json exists, if not, create a default one
      if (!fs.existsSync(configPath)) {
        this.logger.warn(`prompt.json not found for ${type}. Creating a default one.`);
        const defaultConfig = {
          name: `${type.charAt(0).toUpperCase() + type.slice(1)} Assistant`,
          instructions:
            'You are a helpful assistant that provides accurate information based on the provided documents. If the answer is not in the documents, say so.',
          model: 'gpt-4-turbo-preview', // or a model you prefer
        };
        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
        return defaultConfig;
      }

      const configData = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      this.logger.error(`Failed to load or create assistant config for type: ${type}`, error);
      // Return default configuration if file operations fail
      return {
        name: 'Default Assistant',
        instructions: 'You are a helpful assistant that provides accurate information.',
        model: 'gpt-4-turbo-preview',
      };
    }
  }

  private async createNewAssistant(assistantType: string, config: any) {
    try {
      // Check if we have a stored assistant ID in the config
      if (config.assistantId) {
        this.assistantId = config.assistantId;
        this.logger.debug(`Using existing assistant with ID from config: ${this.assistantId}`);

        // Get assistant details to log the model
        try {
          const assistant = await this.openai.beta.assistants.retrieve(this.assistantId);
          this.logger.debug(`Assistant ${this.assistantId} is using model: ${assistant.model}`);
          // Verify if the assistant has file_search tool and is linked to the expected vector store
          const hasFileSearchTool = assistant.tools.some((tool) => tool.type === 'file_search');
          if (
            hasFileSearchTool &&
            config.vectorStoreId &&
            assistant.tool_resources?.file_search?.vector_store_ids?.includes(config.vectorStoreId)
          ) {
            this.logger.debug(
              `Assistant ${this.assistantId} is correctly configured with file search and vector store ${config.vectorStoreId}.`,
            );
          } else if (hasFileSearchTool && config.vectorStoreId) {
            this.logger.warn(
              `Assistant ${this.assistantId} has file search but might not be linked to vector store ${config.vectorStoreId} or vector store ID is missing in prompt.json. Will attempt to update.`,
            );
            // We will attempt to link it later in initializeAssistant
          } else if (!hasFileSearchTool) {
            this.logger.warn(`Assistant ${this.assistantId} does not have file_search tool. Will attempt to add it.`);
            // We might need to update it. The updateAssistantWithVectorStore will add/update tool_resources.
          }
          return;
        } catch (error) {
          this.logger.warn(
            `Could not retrieve assistant with ID ${config.assistantId}. It may have been deleted or is invalid. Error: ${error.message}. Creating a new one.`,
          );
          // Fall through to create a new assistant
        }
      }

      const modelToUse = config.model || 'gpt-4-turbo-preview';
      this.logger.log(`Creating assistant "${config.name}" with model: ${modelToUse}`);

      // Create new assistant
      const assistant = await this.openai.beta.assistants.create({
        name: config.name,
        instructions: config.instructions,
        model: modelToUse,
        tools: [{ type: 'file_search' }], // Ensure file_search tool is added
      });

      this.assistantId = assistant.id;
      this.logger.log(`Created new assistant with ID: ${this.assistantId}`);
      this.logger.log(`New assistant is using model: ${assistant.model}`);

      // Update the config file with the new assistant ID
      await this.updateConfigWithAssistantId(assistantType, this.assistantId);
    } catch (error) {
      this.logger.error('Failed to initialize assistant', error);
      throw new Error(`Assistant initialization error: ${error.message}`);
    }
  }

  async createVectorStore(assistantType: string, config: any) {
    try {
      if (config.vectorStoreId) {
        this.vectorStoreId = config.vectorStoreId;
        this.logger.debug(`Using existing vector store with ID from config: ${this.vectorStoreId}`);
        try {
          await this.openai.vectorStores.retrieve(this.vectorStoreId);
          this.logger.debug(`Verified vector store ${this.vectorStoreId} exists.`);
          // Optionally, resync files if needed or check status
          return;
        } catch (error) {
          this.logger.warn(
            `Could not retrieve vector store with ID ${config.vectorStoreId} from config. It may have been deleted. Error: ${error.message}. Creating a new one.`,
          );
          // Proceed to create a new one
        }
      }

      // Fallback check for environment variable if not in config (though config should be primary)
      const envVectorStoreId = this.configService.get<string>('OPENAI_VECTOR_STORE_ID');
      if (envVectorStoreId && (!config.vectorStoreId || config.vectorStoreId !== envVectorStoreId)) {
        this.logger.log(`Found vector store ID in env: ${envVectorStoreId}. Checking if it's usable.`);
        try {
          await this.openai.vectorStores.retrieve(envVectorStoreId);
          this.vectorStoreId = envVectorStoreId;
          this.logger.log(
            `Using existing vector store with ID from env: ${this.vectorStoreId}. Consider saving this to prompt.json.`,
          );
          // Potentially update config.vectorStoreId here if you want env to override and persist
          // await this.updateConfigWithVectorStoreId(assistantType, this.vectorStoreId);
          return;
        } catch (error) {
          this.logger.warn(
            `Vector store ID ${envVectorStoreId} from env is not valid. Error: ${error.message}. Will create a new one.`,
          );
        }
      }

      this.logger.log(`Creating new vector store for ${assistantType}`);
      const vectorStore = await this.openai.vectorStores.create({
        name: `${config.name || assistantType} Knowledge Base`, // Use assistant name for store
      });
      this.vectorStoreId = vectorStore.id;
      this.logger.log(`Created new vector store with ID: ${this.vectorStoreId}`);
      await this.updateConfigWithVectorStoreId(assistantType, this.vectorStoreId);

      const knowledgeFilePath = `src/twilio/assistant/${assistantType}/data.json`;
      if (!fs.existsSync(knowledgeFilePath)) {
        this.logger.warn(
          `Knowledge data file not found: ${knowledgeFilePath}. Vector store ${this.vectorStoreId} will be empty initially.`,
        );
        return;
      }

      this.logger.log(`Uploading knowledge file ${knowledgeFilePath} to vector store ${this.vectorStoreId}.`);
      const fileStream = fs.createReadStream(knowledgeFilePath);

      // Using uploadAndPoll for simplicity. For large files, consider handling batches.
      const fileBatch = await this.openai.vectorStores.fileBatches.uploadAndPoll(this.vectorStoreId, { files: [fileStream] });

      this.logger.log(`File batch status: ${fileBatch.status}. Files in batch: ${fileBatch.file_counts.total}`);
      if (fileBatch.status === 'completed') {
        this.logger.log(`All files successfully processed for vector store ${this.vectorStoreId}.`);
      } else {
        this.logger.error(
          `File batch processing did not complete successfully for vector store ${this.vectorStoreId}. Status: ${fileBatch.status}. Review details on OpenAI dashboard.`,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to create or update vector store for ${assistantType}`, error);
      throw new Error(`Vector store creation/update error: ${error.message}`);
    }
  }

  private async updateConfigWithAssistantId(assistantType: string, assistantId: string) {
    try {
      const configPath = `src/twilio/assistant/${assistantType}/prompt.json`;
      const configData = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configData);
      config.assistantId = assistantId;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      this.logger.log(`Updated ${configPath} with assistant ID: ${assistantId}`);
    } catch (error) {
      this.logger.error(`Failed to update config file with assistant ID: ${error.message}`);
    }
  }

  private async updateConfigWithVectorStoreId(assistantType: string, vectorStoreId: string) {
    try {
      const configPath = `src/twilio/assistant/${assistantType}/prompt.json`;
      const configData = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configData);
      config.vectorStoreId = vectorStoreId;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      this.logger.log(`Updated ${configPath} with vector store ID: ${vectorStoreId}`);
    } catch (error) {
      this.logger.error(`Failed to update config file with vector store ID: ${error.message}`);
    }
  }

  async updateAssistantWithVectorStore(assistantId: string, vectorStoreId: string) {
    if (!assistantId || !vectorStoreId) {
      this.logger.warn('Cannot update assistant: Assistant ID or Vector Store ID is missing.');
      return;
    }
    try {
      this.logger.debug(`Updating assistant ${assistantId} to use vector store ${vectorStoreId} for file search.`);
      await this.openai.beta.assistants.update(assistantId, {
        tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
      });
      this.logger.debug(`Successfully updated assistant ${assistantId} with vector store ${vectorStoreId}.`);
    } catch (error) {
      this.logger.error(
        `Failed to update assistant ${assistantId} with vector store ${vectorStoreId}: ${error.message}`,
        error.stack,
      );
      // Potentially re-throw if this is critical and unrecoverable
    }
  }

  async getAnswer(question: string, threadIdInput?: string): Promise<string> {
    let currentThreadId = threadIdInput;
    try {
      this.logger.log(`getAnswer called with question: "${question}", threadIdInput: ${threadIdInput}`);
      if (!this.assistantId) {
        this.logger.error('Assistant ID not initialized. Cannot process request.');
        throw new Error('Assistant not initialized. Ensure OpenAIAssistantService.onModuleInit has completed.');
      }

      if (!currentThreadId) {
        const thread = await this.openai.beta.threads.create();
        currentThreadId = thread.id;
        this.logger.log(`No threadId provided, created new thread: ${currentThreadId}`);
      } else {
        this.logger.log(`Using existing thread: ${currentThreadId}`);
      }

      await this.openai.beta.threads.messages.create(currentThreadId, {
        role: 'user',
        content: question,
      });
      this.logger.log(`Message added to thread ${currentThreadId}.`);

      const run = await this.openai.beta.threads.runs.create(currentThreadId, {
        assistant_id: this.assistantId,
      });
      this.logger.log(`Run ${run.id} created for thread ${currentThreadId}.`);

      await this.pollRun(currentThreadId, run.id);

      const messages = await this.openai.beta.threads.messages.list(currentThreadId, { limit: 10, order: 'desc' });
      const assistantMessage = messages.data.find((msg) => msg.run_id === run.id && msg.role === 'assistant');

      if (!assistantMessage) {
        this.logger.error(`No assistant message found for run ${run.id} in thread ${currentThreadId}.`);
        const runDetails = await this.openai.beta.threads.runs.retrieve(currentThreadId, run.id);
        if (runDetails.last_error) {
          this.logger.error(
            `Run ${run.id} failed with error: ${runDetails.last_error.message} (Code: ${runDetails.last_error.code})`,
          );
          throw new Error(`Assistant run failed: ${runDetails.last_error.message}`);
        } else if (runDetails.status !== 'completed') {
          this.logger.error(`Run ${run.id} status: ${runDetails.status}. Incomplete or other issue.`);
          throw new Error(`Assistant run did not complete successfully. Status: ${runDetails.status}`);
        }
        throw new Error('No response from assistant after successful run.');
      }

      const responseText = this.extractTextFromMessage(assistantMessage);
      this.logger.log(`Response from assistant for thread ${currentThreadId}: "${responseText}"`);
      return responseText;
    } catch (error) {
      this.logger.error(`Error in getAnswer (thread: ${currentThreadId}): ${error.message}`, error.stack);
      const errorMessage =
        error.message.includes('Assistant run failed') || error.message.includes('Run failed')
          ? `Sorry, I encountered an issue: ${error.message}`
          : 'Sorry, I had trouble processing your request right now.';
      return errorMessage;
    }
  }

  async createNewThread(): Promise<string> {
    try {
      const thread = await this.openai.beta.threads.create();
      this.logger.log(`Created new thread with ID: ${thread.id}`);
      return thread.id;
    } catch (error) {
      this.logger.error('Error creating new thread', error);
      throw new Error(`Failed to create thread: ${error.message}`);
    }
  }

  // getAnswerWithThread is essentially the same as getAnswer if threadId is provided.
  // Consolidating into getAnswer which can handle both new and existing threads.
  // If distinct logic is ever needed, getAnswerWithThread can be reinstated.
  // For now, getAnswer(question, threadId) serves the purpose.

  private async pollRun(threadId: string, runId: string): Promise<void> {
    this.logger.log(`Polling run ${runId} in thread ${threadId}...`);
    const pollIntervalMs = 1000; // Increased poll interval
    const maxPollDurationMs = 60000; // Max time to wait (e.g., 60 seconds)
    let elapsedTimeMs = 0;
    let run = await this.openai.beta.threads.runs.retrieve(threadId, runId);

    while (['in_progress', 'queued', 'requires_action'].includes(run.status) && elapsedTimeMs < maxPollDurationMs) {
      this.logger.log(`Run ${runId} status: ${run.status}. Elapsed: ${Math.round(elapsedTimeMs / 1000)}s.`);

      if (run.status === 'requires_action') {
        this.logger.log(
          `Run ${runId} requires action. Tool calls: ${JSON.stringify(run.required_action?.submit_tool_outputs?.tool_calls)}`,
        );
        // IMPORTANT: This basic RAG setup with 'file_search' typically does NOT require submitting tool outputs from our end.
        // The 'file_search' tool is handled by the Assistant internally.
        // If you add other tools (e.g., function calling), you'd handle them here.
        // For now, if it's just file_search, it should auto-complete or fail.
        // If it gets stuck in 'requires_action' with file_search, there might be an issue with the Assistant setup or OpenAI's side.
        // We will log and wait, assuming OpenAI will resolve it or timeout.
        this.logger.warn(
          `Run ${runId} is in 'requires_action'. For 'file_search', this should resolve automatically. If it persists, check Assistant config.`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      run = await this.openai.beta.threads.runs.retrieve(threadId, runId);
      elapsedTimeMs += pollIntervalMs;
    }

    this.logger.log(
      `Polling finished for run ${runId}. Final status: ${run.status}. Total time: ${Math.round(elapsedTimeMs / 1000)}s.`,
    );

    if (run.status === 'failed') {
      const errorDetails = run.last_error ? `${run.last_error.message} (Code: ${run.last_error.code})` : 'Unknown error';
      this.logger.error(`Run ${runId} failed: ${errorDetails}`);
      throw new Error(`Run failed: ${errorDetails}`);
    } else if (run.status === 'cancelled') {
      this.logger.warn(`Run ${runId} was cancelled.`);
      throw new Error('Run was cancelled');
    } else if (run.status !== 'completed') {
      this.logger.warn(`Run ${runId} ended with status: ${run.status}. This might indicate an issue or timeout.`);
      throw new Error(`Run ${runId} did not complete successfully. Final Status: ${run.status}`);
    }
    this.logger.log(`Run ${runId} completed successfully.`);
  }

  private extractTextFromMessage(message: any): string {
    if (!message || !message.content || !Array.isArray(message.content) || message.content.length === 0) {
      this.logger.warn('Attempted to extract text from empty, null, or non-array message content.');
      return "I'm sorry, I couldn't formulate a response from the assistant's message structure.";
    }

    const textParts = message.content
      .filter((part: any) => part.type === 'text' && part.text && typeof part.text.value === 'string')
      .map((part: any) => part.text.value);

    if (textParts.length === 0) {
      this.logger.warn('No text parts found in message content. Full message content:', JSON.stringify(message.content));
      return "I'm sorry, the assistant's response did not contain readable text.";
    }
    return textParts.join('');
  }

  getAssistantId(): string {
    if (!this.assistantId) {
      this.logger.error('OpenAIAssistantService: Assistant ID requested before initialization.');
      throw new Error('Assistant ID not initialized. Ensure OpenAIAssistantService.onModuleInit has completed.');
    }
    return this.assistantId;
  }

  getVectorStoreId(): string {
    if (!this.vectorStoreId) {
      this.logger.error('OpenAIAssistantService: Vector Store ID requested before initialization.');
      throw new Error('Vector Store ID not initialized.');
    }
    return this.vectorStoreId;
  }
}
