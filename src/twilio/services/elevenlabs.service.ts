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
    const outputFormat = 'ulaw_8000'
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
      const wavBuffer = this.writeMuLawToWavBuffer(audioBuffer);

      // Construct the main parameter object for the SDK's convert method
      const params = {
        file: new Blob([wavBuffer], { type: 'audio/wav' }), // Create a Blob
        model_id: 'scribe_v1',
        // Optional parameters from the API documentation:
        language_code: 'en',
        tag_audio_events: false,
        // diarize: true,
      };

      const transcriptionResult = await this.client.speechToText.convert(params);

      if (transcriptionResult && typeof transcriptionResult.text === 'string') {
        return transcriptionResult.text;
      } else {
        this.logger.error('ElevenLabs SDK STT response did not contain text or was not as expected:', transcriptionResult);
        throw new Error('ElevenLabs transcription failed: Invalid response structure from SDK.');
      }
    } catch (error) {
      let errorMessage = error.message;
      // Check if it's an error from the ElevenLabs SDK (they might have custom error types or properties)
      // For now, a generic check for status and body which are common in SDK-wrapped API errors.
      if (error.status && error.body && error.body.detail) {
        // Heuristic check for ElevenLabs like API error
        errorMessage = `ElevenLabs API Error (${error.status}): ${error.message}. Detail: ${error.body.detail}`;
      } else if (error.status && error.message) {
        errorMessage = `ElevenLabs API Error (${error.status}): ${error.message}`;
      }
      this.logger.error(`Error transcribing audio with ElevenLabs SDK: ${errorMessage}`, error.stack);
      throw new Error(`ElevenLabs transcription failed: ${errorMessage}`);
    }
  }
}
