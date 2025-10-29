import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ElevenLabsService } from './elevenlabs.service';
import { GoogleCloudService } from './google-cloud.service';

/**
 * Unified speech service that can switch between different providers
 * Supports ElevenLabs and Google Cloud for both text-to-speech and speech-to-text
 */
@Injectable()
export class SpeechService {
  private readonly logger = new Logger(SpeechService.name);
  private readonly useGoogleCloud: boolean;
  private readonly STT_PROVIDER: string;
  private readonly TTS_PROVIDER: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly elevenLabsService: ElevenLabsService,
    private readonly googleCloudService: GoogleCloudService,
  ) {
    // Determine which service to use (default to ElevenLabs)
    this.STT_PROVIDER = this.configService.get('STT_PROVIDER') || 'google-cloud';
    this.TTS_PROVIDER = this.configService.get('TTS_PROVIDER') || 'google-cloud';
    this.logger.debug(
      `Speech service initialized. Using: ${this.TTS_PROVIDER} for text-to-speech and ${this.STT_PROVIDER} for speech-to-text`,
    );
  }

  // Converts speech to text using specified provider with fallback support
  async transcribe(audioBuffer: Buffer, STTProvider: string, languageCode: string = 'en-US'): Promise<string> {
    try {
      if (this.STT_PROVIDER === 'google-cloud') {
        const transcription = await this.googleCloudService.transcribe(audioBuffer, languageCode);
        return transcription;
      } else if (this.STT_PROVIDER === 'elevenlabs') {
        const transcription = await this.elevenLabsService.transcribe(audioBuffer);
        return transcription;
      } else {
        const transcription = await this.googleCloudService.transcribe(audioBuffer, languageCode);
        return transcription;
      }
    } catch (error) {
      this.logger.error(`Speech-to-text failed with ${this.useGoogleCloud ? 'Google Cloud' : 'ElevenLabs'}:`, error);

      // Fallback to the other service if available
      try {
        if (this.useGoogleCloud) {
          this.logger.warn('Falling back to ElevenLabs for speech-to-text');
          return await this.elevenLabsService.transcribe(audioBuffer);
        } else {
          this.logger.warn('Falling back to Google Cloud for speech-to-text');
          return await this.googleCloudService.transcribe(audioBuffer, languageCode);
        }
      } catch (fallbackError) {
        this.logger.error('Both speech-to-text services failed:', fallbackError);
        throw new Error(`Speech-to-text failed with all available services: ${error.message}`);
      }
    }
  }

  // Converts text to speech using configured service with fallback support
  async createAudioFileFromText(text: string, voiceName?: string): Promise<Buffer> {
    try {
      if (this.TTS_PROVIDER === 'google-cloud') {
        return await this.googleCloudService.createAudioFileFromText(text, voiceName);
      } else if (this.TTS_PROVIDER === 'elevenlabs') {
        return await this.elevenLabsService.createAudioFileFromText(text);
      } else {
        return await this.googleCloudService.createAudioFileFromText(text, voiceName);
      }
    } catch (error) {
      this.logger.error(`Text-to-speech failed with ${this.TTS_PROVIDER}:`, error);
      throw new Error(`Text-to-speech failed with ${this.TTS_PROVIDER}: ${error.message}`);
    }
  }

  // Get the current speech-to-text provider
  getSTTProvider(): string {
    return this.STT_PROVIDER;
  }

  // Get the current text-to-speech provider
  getTTSProvider(): string {
    return this.TTS_PROVIDER;
  }
}
