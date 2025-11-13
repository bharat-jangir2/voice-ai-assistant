import { Injectable, Logger } from '@nestjs/common';

export interface VADResult {
  isSpeech: boolean;
  confidence: number;
  shouldFinalize: boolean;
  amplitude: number;
  features?: AudioFeatures;
}

export interface AudioFeatures {
  energy: number;
  spectralCentroid: number;
  zeroCrossingRate: number;
  spectralRolloff: number;
  mfcc?: number[]; // Mel-frequency cepstral coefficients (for future ML model)
}

@Injectable()
export class VoiceActivityDetectorService {
  private readonly logger = new Logger(VoiceActivityDetectorService.name);

  // VAD thresholds - tuned for natural conversation
  private readonly SPEECH_THRESHOLD = 0.7;
  private readonly SILENCE_CONFIDENCE = 0.85;
  private readonly FINALIZE_CONFIDENCE = 0.9; // High confidence that speech has ended

  /**
   * Analyze audio chunk to detect speech activity
   */
  async analyzeAudioChunk(audioBuffer: Buffer, format: 'pcm16' | 'mulaw'): Promise<VADResult> {
    try {
      const features = this.extractAudioFeatures(audioBuffer, format);
      const speechProbability = await this.calculateSpeechProbability(features);
      const amplitude = this.calculateAmplitude(audioBuffer, format);

      // Determine if this is speech
      const isSpeech = speechProbability > this.SPEECH_THRESHOLD && amplitude > 300;

      // Check if speech has ended (high confidence of silence after speech)
      const shouldFinalize = this.checkSpeechEnd(features, speechProbability, amplitude);

      return {
        isSpeech,
        confidence: speechProbability,
        shouldFinalize,
        amplitude,
        features,
      };
    } catch (error) {
      this.logger.error(`Error analyzing audio chunk: ${error.message}`);
      // Fallback to amplitude-based detection
      const amplitude = this.calculateAmplitude(audioBuffer, format);
      return {
        isSpeech: amplitude > 250,
        confidence: amplitude > 250 ? 0.6 : 0.3,
        shouldFinalize: false,
        amplitude,
      };
    }
  }

  /**
   * Extract audio features for VAD analysis
   */
  private extractAudioFeatures(audioBuffer: Buffer, format: 'pcm16' | 'mulaw'): AudioFeatures {
    // Convert to PCM16 samples for analysis
    const samples = this.convertToSamples(audioBuffer, format);

    // Calculate features
    const energy = this.calculateEnergy(samples);
    const spectralCentroid = this.calculateSpectralCentroid(samples);
    const zeroCrossingRate = this.calculateZeroCrossingRate(samples);
    const spectralRolloff = this.calculateSpectralRolloff(samples);

    return {
      energy,
      spectralCentroid,
      zeroCrossingRate,
      spectralRolloff,
    };
  }

  /**
   * Convert audio buffer to normalized sample array
   */
  private convertToSamples(audioBuffer: Buffer, format: 'pcm16' | 'mulaw'): Float32Array {
    if (format === 'pcm16') {
      const samples = new Float32Array(audioBuffer.length / 2);
      for (let i = 0; i < samples.length; i++) {
        const sample = audioBuffer.readInt16LE(i * 2);
        samples[i] = sample / 32768.0; // Normalize to [-1, 1]
      }
      return samples;
    } else {
      // Mu-law decoding
      const samples = new Float32Array(audioBuffer.length);
      for (let i = 0; i < audioBuffer.length; i++) {
        const muLaw = audioBuffer[i];
        const decoded = this.muLawDecode(muLaw);
        samples[i] = decoded / 32768.0; // Normalize to [-1, 1]
      }
      return samples;
    }
  }

  /**
   * Decode mu-law sample
   */
  private muLawDecode(muLaw: number): number {
    const muLawValue = muLaw ^ 0xff; // Invert all bits
    const sign = muLawValue & 0x80 ? -1 : 1;
    const exponent = (muLawValue & 0x70) >> 4;
    const mantissa = muLawValue & 0x0f;
    let pcm = mantissa * 2 + 33;
    pcm = (pcm << exponent) - 33;
    return sign * pcm;
  }

  /**
   * Calculate energy (RMS) of audio signal
   */
  private calculateEnergy(samples: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Calculate spectral centroid (brightness of sound)
   * Speech typically has higher spectral centroid than silence
   */
  private calculateSpectralCentroid(samples: Float32Array): number {
    // Simplified spectral centroid calculation
    // For full implementation, would use FFT
    let weightedSum = 0;
    let magnitudeSum = 0;

    // Simple approximation using frequency domain characteristics
    for (let i = 0; i < samples.length - 1; i++) {
      const diff = Math.abs(samples[i + 1] - samples[i]);
      weightedSum += i * diff;
      magnitudeSum += diff;
    }

    return magnitudeSum > 0 ? weightedSum / magnitudeSum / samples.length : 0;
  }

  /**
   * Calculate zero-crossing rate
   * Speech has higher ZCR than silence
   */
  private calculateZeroCrossingRate(samples: Float32Array): number {
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i - 1] >= 0 && samples[i] < 0) || (samples[i - 1] < 0 && samples[i] >= 0)) {
        crossings++;
      }
    }
    return crossings / samples.length;
  }

  /**
   * Calculate spectral rolloff (frequency below which 85% of energy is contained)
   * Speech has different rolloff characteristics than silence
   */
  private calculateSpectralRolloff(samples: Float32Array): number {
    // Simplified rolloff calculation
    const energy = this.calculateEnergy(samples);
    const threshold = energy * 0.85;

    let cumulativeEnergy = 0;
    for (let i = 0; i < samples.length; i++) {
      cumulativeEnergy += Math.abs(samples[i]);
      if (cumulativeEnergy >= threshold) {
        return i / samples.length;
      }
    }
    return 1.0;
  }

  /**
   * Calculate speech probability from features
   * Simple implementation - can be replaced with ML model later
   */
  private async calculateSpeechProbability(features: AudioFeatures): Promise<number> {
    // Normalize features to [0, 1] range
    const energyNorm = Math.min(1, features.energy * 10); // Energy typically 0-0.1
    const spectralNorm = Math.min(1, features.spectralCentroid * 2); // Spectral centroid 0-0.5
    const zcrNorm = Math.min(1, features.zeroCrossingRate * 10); // ZCR typically 0-0.1
    const rolloffNorm = features.spectralRolloff; // Already 0-1

    // Weighted combination (tuned for speech detection)
    // Speech typically has: moderate-high energy, moderate spectral centroid, moderate ZCR
    const speechScore =
      energyNorm * 0.4 + // Energy is most important
      spectralNorm * 0.3 + // Spectral centroid indicates frequency content
      zcrNorm * 0.2 + // ZCR helps distinguish speech from noise
      rolloffNorm * 0.1; // Rolloff provides additional context

    // Apply sigmoid-like function for smoother probability
    const probability = 1 / (1 + Math.exp(-5 * (speechScore - 0.5)));

    return Math.max(0, Math.min(1, probability)); // Clamp to [0, 1]
  }

  /**
   * Check if speech has ended (high confidence of silence after speech)
   */
  private checkSpeechEnd(features: AudioFeatures, speechProbability: number, amplitude: number): boolean {
    // Speech has ended if:
    // 1. Low speech probability (confidence of silence)
    // 2. Low energy
    // 3. Low amplitude
    const isSilent = speechProbability < 1 - this.SILENCE_CONFIDENCE;
    const hasLowEnergy = features.energy < 0.01;
    const hasLowAmplitude = amplitude < 100;

    return isSilent && hasLowEnergy && hasLowAmplitude;
  }

  /**
   * Calculate amplitude for interrupt detection (backward compatibility)
   */
  private calculateAmplitude(audioBuffer: Buffer, format: 'pcm16' | 'mulaw'): number {
    let sum = 0;
    let count = 0;

    if (format === 'pcm16') {
      // PCM16: 16-bit signed integers (little-endian)
      for (let i = 0; i < audioBuffer.length - 1; i += 2) {
        const sample = audioBuffer.readInt16LE(i);
        sum += Math.abs(sample);
        count++;
      }
    } else {
      // Mu-law: 8-bit encoded, decode to get amplitude
      for (let i = 0; i < audioBuffer.length; i++) {
        const muLaw = audioBuffer[i];
        // Simple approximation: check distance from mu-law silence (0x7f)
        const amplitude = Math.abs(muLaw - 0x7f) * 256; // Scale up for comparison
        sum += amplitude;
        count++;
      }
    }

    return count > 0 ? sum / count : 0;
  }
}
