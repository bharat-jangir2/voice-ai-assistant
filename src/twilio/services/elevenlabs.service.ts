import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ElevenLabsClient } from 'elevenlabs';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import * as path from 'path';
import * as fs from 'fs';

@Injectable()
export class ElevenLabsService {
  private readonly logger = new Logger(ElevenLabsService.name);
  private readonly client: ElevenLabsClient;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('ELEVENLABS_API_KEY');
    if (!apiKey) {
      throw new Error('ELEVENLABS_API_KEY is not defined');
    }
    this.client = new ElevenLabsClient({ apiKey });
  }

  // Converts text to speech using ElevenLabs API and returns a mu-law Buffer ready for Twilio.
  async createAudioFileFromText(text: string): Promise<Buffer> {
    const voiceId = this.configService.get<string>('ELEVENLABS_VOICE_ID');
    if (!voiceId) {
      throw new Error('ELEVENLABS_VOICE_ID is not defined');
    }
    const modelId = this.configService.get<string>('ELEVENLABS_MODEL_ID');
    if (!modelId) {
      throw new Error('ELEVENLABS_MODEL_ID is not defined');
    }
    const outputFormat = 'ulaw_8000';
    try {
      const muLawStream: Readable = await this.client.textToSpeech.convert(voiceId, {
        model_id: modelId,
        text,
        output_format: outputFormat || 'ulaw_8000',
      });
      const chunks: Buffer[] = [];
      for await (const chunk of muLawStream) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      this.logger.error('Error creating mu-law buffer from text:', error);
      throw error;
    }
  }

  // Helper function to convert mu-law buffer to WAV buffer
  private writeMuLawToWavBuffer(muLawBuffer: Buffer, sampleRate = 8000): Buffer {
    const numChannels = 1;
    const bitsPerSample = 8;
    const formatCode = 7; // ITU G.711 µ-law
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const byteRate = sampleRate * blockAlign;
    const dataSize = muLawBuffer.length;
    const numberOfSamples = dataSize / blockAlign;
    const headerSize = 56; // Standard WAV header size for mu-law with fact chunk
    const fileSize = headerSize + dataSize - 8; // RIFF size field excludes 'RIFF' ID and size field itself

    const buffer = Buffer.alloc(headerSize + dataSize);

    // RIFF chunk descriptor
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(fileSize, 4);
    buffer.write('WAVE', 8);

    // 'fmt ' sub-chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Subchunk1Size for PCM (even for mu-law, generally 16, 18, or 20 for non-PCM)
    buffer.writeUInt16LE(formatCode, 20); // Audio format (7 for mu-law)
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    // No extra format bytes for mu-law with Subchunk1Size = 16

    // 'fact' sub-chunk (important for compressed formats like mu-law)
    buffer.write('fact', 36);
    buffer.writeUInt32LE(4, 40); // Subchunk2Size (size of fact chunk data = 4 bytes for numberOfSamples)
    buffer.writeUInt32LE(numberOfSamples, 44); // Number of samples

    // 'data' sub-chunk
    buffer.write('data', 48);
    buffer.writeUInt32LE(dataSize, 52); // Subchunk3Size (size of actual audio data)

    muLawBuffer.copy(buffer, headerSize);

    return buffer;
  }

  async transcribe(audioBuffer: Buffer): Promise<string> {
    try {
      this.logger.log(`🎤 ElevenLabs STT: Received ${audioBuffer.length} bytes of audio`);

      const wavBuffer = this.writeMuLawToWavBuffer(audioBuffer);
      this.logger.log(`🎤 ElevenLabs STT: Created WAV buffer: ${wavBuffer.length} bytes`);

      // Use dynamic import for File in Node.js environment
      const { File } = await import('buffer');

      // Create File object directly from buffer (no temp file needed)
      // Cast to any to avoid type mismatch between Node.js File and DOM File
      const file = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' }) as any;

      this.logger.log(`📤 Calling ElevenLabs STT API with ${wavBuffer.length} bytes...`);

      const transcriptionResult = await this.client.speechToText.convert({
        file: file,
        model_id: 'scribe_v1',
        language_code: 'en',
      });

      const text = transcriptionResult?.text?.trim() || '';

      if (text) {
        this.logger.log(`✅ ElevenLabs STT: Transcription: "${text}"`);
      } else {
        this.logger.warn(`⚠️ ElevenLabs STT: Empty transcription received`);
      }

      return text;
    } catch (error) {
      this.logger.error(`❌ Error transcribing audio with ElevenLabs SDK: ${error.message}`);
      return '';
    }
  }
}
