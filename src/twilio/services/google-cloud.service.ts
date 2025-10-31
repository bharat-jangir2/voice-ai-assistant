import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SpeechClient } from '@google-cloud/speech';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Service for Google Cloud Speech-to-Text and Text-to-Speech operations
 * Supports both transcription and text-to-speech conversion
 */
@Injectable()
export class GoogleCloudService {
  private readonly logger = new Logger(GoogleCloudService.name);
  private speechClient: SpeechClient;
  private textToSpeechClient: TextToSpeechClient;
  private readonly STT_PROVIDER: string;
  private readonly TTS_PROVIDER: string;

  constructor(private readonly configService: ConfigService) {
    // Determine which service to use (default to Google Cloud)
    this.STT_PROVIDER = this.configService.get('STT_PROVIDER') || 'google-cloud';
    this.TTS_PROVIDER = this.configService.get('TTS_PROVIDER') || 'google-cloud';

    if (this.STT_PROVIDER === 'google-cloud' || this.TTS_PROVIDER === 'google-cloud') {
      this.initializeGoogleCloudClients();
    }
    this.logger.log(
      `Google Cloud service initialized. Using ${this.STT_PROVIDER} for speech-to-text and ${this.TTS_PROVIDER} for text-to-speech`,
    );
  }

  // Initializes Google Cloud Speech and Text-to-Speech clients with credentials
  private initializeGoogleCloudClients(): void {
    try {
      const credentialsPath = this.configService.get<string>('GOOGLE_CLOUD_CREDENTIALS_PATH');
      const projectId = this.configService.get<string>('GOOGLE_CLOUD_PROJECT_ID');

      if (!credentialsPath || !projectId) {
        throw new Error('GOOGLE_CLOUD_CREDENTIALS_PATH and GOOGLE_CLOUD_PROJECT_ID are required for Google Cloud services');
      }

      // Resolve the credentials path relative to project root
      let resolvedCredentialsPath: string;
      if (path.isAbsolute(credentialsPath)) {
        resolvedCredentialsPath = credentialsPath;
      } else {
        // If relative path, resolve from project root (not dist directory)
        const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
        resolvedCredentialsPath = path.resolve(projectRoot, credentialsPath);
      }

      // Check if credentials file exists
      if (!fs.existsSync(resolvedCredentialsPath)) {
        throw new Error(`Google Cloud credentials file not found at: ${resolvedCredentialsPath}`);
      }

      // Initialize Speech-to-Text client
      this.speechClient = new SpeechClient({
        keyFilename: resolvedCredentialsPath,
        projectId: projectId,
      });

      // Initialize Text-to-Speech client
      this.textToSpeechClient = new TextToSpeechClient({
        keyFilename: resolvedCredentialsPath,
        projectId: projectId,
      });

      this.logger.log('Google Cloud clients initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Google Cloud clients:', error);
      throw new Error(`Google Cloud initialization failed: ${error.message}`);
    }
  }

  // Add this method to GoogleCloudService
  private applyFadeInForGoogleCloud(audioBuffer: Buffer): Buffer {
    const CHUNK_SIZE = 320; // 20ms chunks at 8000Hz
    const FADE_CHUNKS = 3; // 160ms fade-in
    const processedBuffer = Buffer.alloc(audioBuffer.length);

    for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
      const chunkIndex = i / CHUNK_SIZE;
      const chunk = audioBuffer.slice(i, i + CHUNK_SIZE);

      if (chunkIndex < FADE_CHUNKS) {
        // Apply fade-in to first 8 chunks (160ms)
        const fadeFactor = Math.min(1.0, (chunkIndex + 1) / FADE_CHUNKS);

        for (let k = 0; k < chunk.length; k++) {
          const sample = chunk[k];
          if (sample !== 0x7f) {
            // Not silence
            const pcmValue = sample - 0x7f;
            const fadedValue = Math.round(pcmValue * fadeFactor);
            processedBuffer[i + k] = Math.max(0, Math.min(255, fadedValue + 0x7f));
          } else {
            processedBuffer[i + k] = sample; // Keep silence as-is
          }
        }
      } else {
        // Copy remaining chunks without modification
        chunk.copy(processedBuffer, i);
      }
    }

    return processedBuffer;
  }

  // Add audio analysis method for debugging
  private analyzeAudioBuffer(audioBuffer: Buffer): void {
    let silenceCount = 0;
    let maxAmplitude = 0;

    for (let i = 0; i < audioBuffer.length; i++) {
      if (audioBuffer[i] === 0x7f) {
        silenceCount++;
      } else {
        const amplitude = Math.abs(audioBuffer[i] - 0x7f);
        maxAmplitude = Math.max(maxAmplitude, amplitude);
      }
    }

    const silencePercentage = (silenceCount / audioBuffer.length) * 100;
    this.logger.debug(
      `Google Cloud Audio Analysis: ${audioBuffer.length} bytes, ${silenceCount} silence samples (${silencePercentage.toFixed(1)}%), max amplitude: ${maxAmplitude}`,
    );
  }

  // Converts text to speech using Google Cloud TTS and returns mu-law audio buffer
  async createAudioFileFromText(text: string, voiceName?: string): Promise<Buffer> {
    try {
      // Allow TTS even if not primary TTS provider (for fallback scenarios)
      if (!this.textToSpeechClient) {
        // Try to initialize if not already initialized (for fallback)
        try {
          this.initializeGoogleCloudClients();
        } catch (e) {
          throw new Error(`Google Cloud service is disabled: ${e.message}`);
        }
      }

      const defaultVoice = this.configService.get('GOOGLE_TTS_VOICE') || 'en-US-Neural2-A';
      const selectedVoice = voiceName || defaultVoice;

      const request = {
        input: { text: text },
        voice: {
          languageCode: 'en-US',
          name: selectedVoice,
          ssmlGender: 'FEMALE' as const, // This should be dynamic based on voice
        },
        audioConfig: {
          audioEncoding: 'MULAW' as const,
          sampleRateHertz: 8000,
          effectsProfileId: ['telephony-class-application'],
        },
      };

      const [response] = await this.textToSpeechClient.synthesizeSpeech(request);

      if (!response.audioContent) {
        throw new Error('No audio content received from Google Cloud Text-to-Speech');
      }

      // Convert to Buffer - handle both string and Uint8Array types
      let audioBuffer: Buffer;
      if (typeof response.audioContent === 'string') {
        audioBuffer = Buffer.from(response.audioContent, 'base64');
      } else if (response.audioContent instanceof Uint8Array) {
        audioBuffer = Buffer.from(response.audioContent);
      } else {
        throw new Error('Unexpected audio content type from Google Cloud Text-to-Speech');
      }

      // Apply Google Cloud specific processing to prevent clicks/pops
      const processedAudioBuffer = this.applyFadeInForGoogleCloud(audioBuffer);

      this.analyzeAudioBuffer(processedAudioBuffer);

      return processedAudioBuffer;
    } catch (error) {
      this.logger.error('Error converting text to speech with Google Cloud:', error);
      throw new Error(`Google Cloud text-to-speech failed: ${error.message}`);
    }
  }

  // Converts speech to text using Google Cloud STT with phone call optimization
  async transcribe(audioBuffer: Buffer, languageCode: string = 'en-US'): Promise<string> {
    try {
      // Allow transcription even if not primary STT provider (for fallback scenarios)
      if (!this.speechClient) {
        // Try to initialize if not already initialized (for fallback)
        try {
          this.initializeGoogleCloudClients();
        } catch (e) {
          throw new Error(`Google Cloud service is disabled: ${e.message}`);
        }
      }

      // Convert mu-law to WAV for better compatibility
      const wavBuffer = this.convertMuLawToWav(audioBuffer);

      const audio = {
        content: wavBuffer.toString('base64'),
      };

      const config = {
        encoding: 'LINEAR16' as const,
        sampleRateHertz: 8000,
        languageCode: languageCode,
        model: 'phone_call', // Optimized for phone calls
        useEnhanced: true, // Use enhanced models for better accuracy
        enableAutomaticPunctuation: true,
        enableWordTimeOffsets: false,
        enableWordConfidence: false,
        speechContexts: [
          { phrases: ['booking', 'appointment', 'schedule', 'reschedule', 'cancel', 'confirm', 'yes', 'no'] },
          { phrases: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] },
        ],
      };

      const request = {
        audio: audio,
        config: config,
      };

      const [response] = await this.speechClient.recognize(request);

      if (!response.results || response.results.length === 0) {
        this.logger.warn('No transcription results received from Google Cloud');
        return '';
      }

      // Combine all transcriptions
      const transcription = response.results
        .map((result) => result.alternatives?.[0]?.transcript)
        .filter((text) => text)
        .join(' ');

      return transcription;
    } catch (error) {
      this.logger.error('Error transcribing audio with Google Cloud:', error);
      throw new Error(`Google Cloud transcription failed: ${error.message}`);
    }
  }

  // Converts mu-law audio to WAV format for better Google Cloud STT compatibility
  private convertMuLawToWav(muLawBuffer: Buffer, sampleRate: number = 8000): Buffer {
    const numChannels = 1;
    const bitsPerSample = 16; // WAV uses 16-bit PCM
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const byteRate = sampleRate * blockAlign;

    // Convert mu-law to PCM
    const pcmData = this.muLawToPcm(muLawBuffer);
    const dataSize = pcmData.length * 2; // 16-bit = 2 bytes per sample

    const headerSize = 44; // Standard WAV header size
    const fileSize = headerSize + dataSize - 8; // RIFF size field excludes 'RIFF' ID and size field itself

    const buffer = Buffer.alloc(headerSize + dataSize);

    // RIFF chunk descriptor
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(fileSize, 4);
    buffer.write('WAVE', 8);

    // 'fmt ' sub-chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Subchunk1Size for PCM
    buffer.writeUInt16LE(1, 20); // Audio format (1 for PCM)
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);

    // 'data' sub-chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // Write PCM data
    for (let i = 0; i < pcmData.length; i++) {
      buffer.writeInt16LE(pcmData[i], headerSize + i * 2);
    }

    return buffer;
  }

  // Converts mu-law encoded audio to PCM using lookup table
  private muLawToPcm(muLawBuffer: Buffer): Int16Array {
    const muLawTable = [
      -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956, -23932, -22908, -21884, -20860, -19836, -18812, -17788,
      -16764, -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412, -11900, -11388, -10876, -10364, -9852, -9340, -8828,
      -8316, -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140, -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
      -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004, -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980, -1884,
      -1820, -1756, -1692, -1628, -1564, -1500, -1436, -1372, -1308, -1244, -1180, -1116, -1052, -988, -924, -876, -844, -812,
      -780, -748, -716, -684, -652, -620, -588, -556, -524, -492, -460, -428, -396, -372, -356, -340, -324, -308, -292, -276,
      -260, -244, -228, -212, -196, -180, -164, -148, -132, -120, -112, -104, -96, -88, -80, -72, -64, -56, -48, -40, -32, -24,
      -16, -8, 0, 32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956, 23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
      15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412, 11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316, 7932, 7676,
      7420, 7164, 6908, 6652, 6396, 6140, 5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092, 3900, 3772, 3644, 3516, 3388, 3260,
      3132, 3004, 2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980, 1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436, 1372, 1308,
      1244, 1180, 1116, 1052, 988, 924, 876, 844, 812, 780, 748, 716, 684, 652, 620, 588, 556, 524, 492, 460, 428, 396, 372, 356,
      340, 324, 308, 292, 276, 260, 244, 228, 212, 196, 180, 164, 148, 132, 120, 112, 104, 96, 88, 80, 72, 64, 56, 48, 40, 32, 24,
      16, 8, 0,
    ];

    const pcmData = new Int16Array(muLawBuffer.length);
    for (let i = 0; i < muLawBuffer.length; i++) {
      pcmData[i] = muLawTable[muLawBuffer[i]];
    }
    return pcmData;
  }
}
