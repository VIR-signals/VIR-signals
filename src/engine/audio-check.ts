// Audio container checks: magic sniffing, the hard size limit, and the soft
// duration advisory. WAV duration is exact from the RIFF chunks; MP3 duration
// is estimated from the first frame header under a constant bitrate
// assumption, which only feeds the advisory warning.
import { AUDIO_SOFT_SECONDS, PROGRESS_SOFT_SECONDS } from './paths';

export type AudioFormat = 'wav' | 'mp3' | 'unknown';

export function detectFormat(buf: Buffer): AudioFormat {
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return 'wav';
  }
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') {
    return 'mp3';
  }
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    return 'mp3';
  }
  return 'unknown';
}

// Exact WAV duration from the chunk chain: fmt byteRate over the data size.
export function wavDurationSeconds(buf: Buffer): number | undefined {
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && size >= 16 && offset + 8 + 16 <= buf.length) {
      byteRate = buf.readUInt32LE(offset + 16);
    }
    if (id === 'data') {
      dataSize = Math.min(size, buf.length - offset - 8);
    }
    offset += 8 + size + (size & 1);
  }
  if (byteRate <= 0 || dataSize <= 0) {
    return undefined;
  }
  return dataSize / byteRate;
}

const V1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const V2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

// MP3 duration estimate under a constant bitrate assumption.
export function mp3DurationSeconds(buf: Buffer): number | undefined {
  let start = 0;
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    const size =
      ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size;
  }
  for (let i = start; i + 4 <= buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) {
      continue;
    }
    const versionBits = (buf[i + 1] >> 3) & 0x03;
    const bitrateIndex = (buf[i + 2] >> 4) & 0x0f;
    if (versionBits === 1 || bitrateIndex === 0 || bitrateIndex === 15) {
      continue;
    }
    const table = versionBits === 3 ? V1_L3_KBPS : V2_L3_KBPS;
    const kbps = table[bitrateIndex];
    if (kbps <= 0) {
      continue;
    }
    return ((buf.length - i) * 8) / (kbps * 1000);
  }
  return undefined;
}

export function durationSeconds(buf: Buffer, format: AudioFormat): number | undefined {
  if (format === 'wav') {
    return wavDurationSeconds(buf);
  }
  if (format === 'mp3') {
    return mp3DurationSeconds(buf);
  }
  return undefined;
}

export function softLimitForSlot(slot: string): number {
  return slot === 'progress' ? PROGRESS_SOFT_SECONDS : AUDIO_SOFT_SECONDS;
}
