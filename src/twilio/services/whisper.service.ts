import { Injectable, Logger } from '@nestjs/common';
import { OpenAI } from 'openai';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class WhisperService {
  private readonly logger = new Logger(WhisperService.name);
  private readonly openai: OpenAI;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not defined');
    }
    this.openai = new OpenAI({ apiKey });
  }

  async transcribe(audioBuffer: Buffer): Promise<string> {
    try {
      const wavBuffer = this.writeMuLawWavFileToBuffer(audioBuffer);
      const tempFileName = `caller_voice_audio_${Date.now()}.wav`;

      // Dynamically import toFile from openai/uploads
      const { toFile } = await import('openai/uploads');
      const fileLike = await toFile(wavBuffer, tempFileName, { type: 'audio/wav' });

      const transcription = await this.openai.audio.transcriptions.create({
        file: fileLike,
        model: 'whisper-1',
        language: 'en',
      });

      return transcription.text;
    } catch (error) {
      if (error.response) {
        this.logger.error('Whisper API error:', error.response.data);
      } else {
        this.logger.error('Error transcribing audio with Whisper:', error);
      }
      throw new Error(`Whisper transcription failed: ${error.message}`);
    }
  }

  private writeMuLawWavFileToBuffer(muLawBuffer: Buffer, sampleRate = 8000): Buffer {
    const numChannels = 1;
    const bitsPerSample = 8;
    const formatCode = 7;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const byteRate = sampleRate * blockAlign;
    const dataSize = muLawBuffer.length;
    const numberOfSamples = dataSize / blockAlign;
    const headerSize = 56;
    const fileSize = headerSize + dataSize - 8;
    const buffer = Buffer.alloc(headerSize + dataSize);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(fileSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(formatCode, 20);
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('fact', 36);
    buffer.writeUInt32LE(4, 40);
    buffer.writeUInt32LE(numberOfSamples, 44);
    buffer.write('data', 48);
    buffer.writeUInt32LE(dataSize, 52);
    muLawBuffer.copy(buffer, headerSize);
    return buffer;
  }
}
