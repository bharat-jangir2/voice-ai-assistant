import { MULAW_DECODE_TABLE } from './twilio.constants';

export function decodeMuLaw(muLawBuffer: Buffer): Int16Array {
  const muLawArray = new Uint8Array(muLawBuffer);
  const pcmArray = new Int16Array(muLawArray.length);
  for (let i = 0; i < muLawArray.length; i++) {
    pcmArray[i] = MULAW_DECODE_TABLE[muLawArray[i]];
  }
  return pcmArray;
}

export function getAverageAmplitude(pcmArray: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcmArray.length; i++) {
    sum += Math.abs(pcmArray[i]);
  }
  return sum / pcmArray.length;
}
