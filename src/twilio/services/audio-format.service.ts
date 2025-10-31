import { Injectable, Logger } from '@nestjs/common';

/**
 * Audio Format Conversion Service
 *
 * Handles conversion between different audio formats and sample rates.
 * Allows frontend to send audio in any format - backend will convert to required format.
 *
 * Supported formats:
 * - PCM16 (16-bit signed integer) - any sample rate
 * - Mu-law (8-bit) - 8kHz
 *
 * Conversion targets:
 * - For STT: Mu-law 8kHz (ElevenLabs) or WAV (Google Cloud)
 * - For frontend: PCM16 16kHz (best browser compatibility)
 */
@Injectable()
export class AudioFormatService {
  private readonly logger = new Logger(AudioFormatService.name);

  // Mu-law encoding lookup table (reverse of decode table)
  private readonly muLawEncodeTable: Uint8Array = new Uint8Array(65536);

  constructor() {
    // Build mu-law encode table
    this.buildMuLawEncodeTable();
  }

  /**
   * Detects audio format from buffer
   * Attempts to detect if audio is PCM16 or mu-law based on characteristics
   */
  detectAudioFormat(buffer: Buffer): {
    format: 'pcm16' | 'mulaw' | 'unknown';
    sampleRate: number;
    channels: number;
  } {
    // Heuristic detection:
    // Mu-law: typically smaller bytes, values usually in 0-255 range
    // PCM16: larger values, signed integers

    // Check first 100 bytes for range
    let pcm16Likely = 0;
    let mulawLikely = 0;

    for (let i = 0; i < Math.min(100, buffer.length); i += 2) {
      if (buffer.length - i >= 2) {
        const byte1 = buffer[i];
        const byte2 = buffer[i + 1];
        const sample16 = (byte2 << 8) | byte1; // Little-endian

        // Mu-law bytes are typically 0-255
        if (byte1 >= 0 && byte1 <= 255 && (byte1 === 0xff || byte1 === 0x00 || (byte1 > 0x7f && byte1 < 0x80))) {
          mulawLikely++;
        }

        // PCM16 samples can be large signed integers
        const signedSample = sample16 > 32767 ? sample16 - 65536 : sample16;
        if (Math.abs(signedSample) > 100) {
          pcm16Likely++;
        }
      }
    }

    // Default assumptions (can be enhanced with metadata)
    // If we can't reliably detect, assume PCM16 at 16kHz (most common from web audio)
    if (pcm16Likely > mulawLikely || pcm16Likely === mulawLikely) {
      return {
        format: 'pcm16',
        sampleRate: 16000, // Most common from Web Audio API
        channels: 1,
      };
    } else {
      return {
        format: 'mulaw',
        sampleRate: 8000, // Mu-law is typically 8kHz
        channels: 1,
      };
    }
  }

  /**
   * Converts PCM16 audio to mu-law at 8kHz
   */
  convertPCM16ToMuLaw(pcm16Buffer: Buffer, sourceSampleRate: number, targetSampleRate: number = 8000): Buffer {
    // First, convert to Int16Array
    const samples = new Int16Array(pcm16Buffer.length / 2);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = pcm16Buffer.readInt16LE(i * 2);
    }

    // Downsample if needed
    let processedSamples = samples;
    if (sourceSampleRate !== targetSampleRate) {
      processedSamples = this.downsampleAudio(samples, sourceSampleRate, targetSampleRate);
    }

    // Convert to mu-law
    const muLawBuffer = new Uint8Array(processedSamples.length);
    for (let i = 0; i < processedSamples.length; i++) {
      muLawBuffer[i] = this.pcm16ToMuLaw(processedSamples[i]);
    }

    return Buffer.from(muLawBuffer);
  }

  /**
   * Converts mu-law audio to PCM16 at target sample rate
   */
  convertMuLawToPCM16(muLawBuffer: Buffer, sourceSampleRate: number, targetSampleRate: number = 16000): Buffer {
    // First decode mu-law to PCM16
    const pcmSamples = this.decodeMuLaw(muLawBuffer);

    // Upsample if needed
    let processedSamples = pcmSamples;
    if (sourceSampleRate !== targetSampleRate) {
      processedSamples = this.upsampleAudio(pcmSamples, sourceSampleRate, targetSampleRate);
    }

    // Convert to Buffer (little-endian 16-bit)
    const pcm16Buffer = Buffer.alloc(processedSamples.length * 2);
    for (let i = 0; i < processedSamples.length; i++) {
      pcm16Buffer.writeInt16LE(processedSamples[i], i * 2);
    }

    return pcm16Buffer;
  }

  /**
   * Normalizes incoming audio to mu-law 8kHz format (required for STT)
   * Accepts any format and converts to the required format
   */
  normalizeForSTT(audioBuffer: Buffer, metadata?: { format?: string; sampleRate?: number }): Buffer {
    const detected = this.detectAudioFormat(audioBuffer);
    const format = metadata?.format || detected.format;
    const sampleRate = metadata?.sampleRate || detected.sampleRate;

    this.logger.debug(
      `🔧 Normalizing audio for STT: detected=${detected.format}@${detected.sampleRate}Hz, metadata=${format}@${sampleRate}Hz`,
    );

    if (format === 'mulaw') {
      // Already mu-law, but might need resampling
      if (sampleRate !== 8000) {
        // Convert to PCM, resample, then back to mu-law
        const pcm = this.decodeMuLaw(audioBuffer);
        const resampled = this.upsampleAudio(pcm, sampleRate, 8000);
        const muLaw = new Uint8Array(resampled.length);
        for (let i = 0; i < resampled.length; i++) {
          muLaw[i] = this.pcm16ToMuLaw(resampled[i]);
        }
        return Buffer.from(muLaw);
      }
      return audioBuffer; // Already correct format
    } else {
      // PCM16 - convert to mu-law 8kHz
      return this.convertPCM16ToMuLaw(audioBuffer, sampleRate, 8000);
    }
  }

  /**
   * Normalizes outgoing audio for frontend playback
   * Converts TTS output (mu-law 8kHz) to PCM16 16kHz for better browser compatibility
   * Applies volume normalization to prevent clipping and distortion
   */
  normalizeForPlayback(audioBuffer: Buffer, targetSampleRate: number = 16000, volumeGain: number = 0.75): Buffer {
    // TTS outputs mu-law 8kHz, convert to PCM16 16kHz for frontend
    const pcm16Buffer = this.convertMuLawToPCM16(audioBuffer, 8000, targetSampleRate);

    // Apply volume normalization to prevent clipping
    const normalizedBuffer = this.applyVolumeNormalization(pcm16Buffer, volumeGain);

    return normalizedBuffer;
  }

  /**
   * Applies volume normalization to prevent clipping and distortion
   * Reduces gain and normalizes peak amplitude to safe levels
   */
  private applyVolumeNormalization(pcm16Buffer: Buffer, gain: number = 0.75): Buffer {
    // Convert buffer to Int16Array for processing
    const samples = new Int16Array(pcm16Buffer.length / 2);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = pcm16Buffer.readInt16LE(i * 2);
    }

    // Find peak amplitude to detect clipping risk
    let maxAmplitude = 0;
    for (let i = 0; i < samples.length; i++) {
      maxAmplitude = Math.max(maxAmplitude, Math.abs(samples[i]));
    }

    // Target peak amplitude (80% of max to prevent clipping, then apply gain reduction)
    const targetPeak = Math.floor(32767 * 0.8 * gain); // 80% of max with gain reduction
    let scaleFactor = gain; // Default: apply gain reduction to all audio

    // If audio is too loud, scale it down further to prevent clipping
    if (maxAmplitude > 0) {
      const currentPeak = maxAmplitude;
      const scaleToTarget = targetPeak / currentPeak;
      // Use the smaller scale factor (more reduction) to ensure we stay within limits
      scaleFactor = Math.min(scaleFactor, scaleToTarget);

      this.logger.debug(
        `🔊 Audio normalization: maxAmplitude=${maxAmplitude}, targetPeak=${targetPeak}, scaleFactor=${scaleFactor.toFixed(3)}, gain=${gain}`,
      );
    }

    // Apply scaling to all samples
    const normalizedSamples = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const scaled = Math.round(samples[i] * scaleFactor);
      // Clamp to prevent any overflow
      normalizedSamples[i] = Math.max(-32768, Math.min(32767, scaled));
    }

    // Convert back to Buffer
    const normalizedBuffer = Buffer.alloc(normalizedSamples.length * 2);
    for (let i = 0; i < normalizedSamples.length; i++) {
      normalizedBuffer.writeInt16LE(normalizedSamples[i], i * 2);
    }

    return normalizedBuffer;
  }

  /**
   * Decodes mu-law to PCM16
   */
  private decodeMuLaw(muLawBuffer: Buffer): Int16Array {
    // Mu-law decode table (standard ITU-T G.711)
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

  /**
   * Encodes PCM16 sample to mu-law
   */
  private pcm16ToMuLaw(sample: number): number {
    // Clamp to valid range
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;

    // Get sign bit
    const sign = sample < 0 ? 0x80 : 0x00;
    if (sample < 0) sample = -sample;

    // Bias
    sample += 33;

    // Find exponent (power of 2)
    let exponent = 7;
    let expMask = 0x4000;
    while (exponent > 0 && (sample & expMask) === 0) {
      exponent--;
      expMask >>= 1;
    }

    // Mantissa is top 4 bits of sample
    const mantissa = (sample >> (exponent + 3)) & 0x0f;

    // Combine sign, exponent, and mantissa, then invert
    return ~(sign | (exponent << 4) | mantissa) & 0xff;
  }

  /**
   * Downsamples audio using linear interpolation
   */
  private downsampleAudio(samples: Int16Array, sourceRate: number, targetRate: number): Int16Array {
    if (sourceRate === targetRate) return samples;

    const ratio = sourceRate / targetRate;
    const targetLength = Math.floor(samples.length / ratio);
    const downsampled = new Int16Array(targetLength);

    for (let i = 0; i < targetLength; i++) {
      const srcIndex = i * ratio;
      const index = Math.floor(srcIndex);
      const fraction = srcIndex - index;

      if (index + 1 < samples.length) {
        // Linear interpolation
        downsampled[i] = Math.round(samples[index] * (1 - fraction) + samples[index + 1] * fraction);
      } else {
        downsampled[i] = samples[index];
      }
    }

    return downsampled;
  }

  /**
   * Upsamples audio using linear interpolation
   */
  private upsampleAudio(samples: Int16Array, sourceRate: number, targetRate: number): Int16Array {
    if (sourceRate === targetRate) return samples;

    const ratio = targetRate / sourceRate;
    const targetLength = Math.floor(samples.length * ratio);
    const upsampled = new Int16Array(targetLength);

    for (let i = 0; i < targetLength; i++) {
      const srcIndex = i / ratio;
      const index = Math.floor(srcIndex);
      const fraction = srcIndex - index;

      if (index + 1 < samples.length) {
        // Linear interpolation
        upsampled[i] = Math.round(samples[index] * (1 - fraction) + samples[index + 1] * fraction);
      } else {
        upsampled[i] = samples[index];
      }
    }

    return upsampled;
  }

  /**
   * Build mu-law encode lookup table for faster encoding
   */
  private buildMuLawEncodeTable(): void {
    // Pre-compute mu-law encoding for all 16-bit PCM values
    for (let i = 0; i < 65536; i++) {
      let sample = i > 32767 ? i - 65536 : i;
      this.muLawEncodeTable[i] = this.pcm16ToMuLaw(sample);
    }
  }
}
