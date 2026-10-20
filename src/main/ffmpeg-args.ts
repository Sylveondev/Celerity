// Builds ffmpeg command lines for video export (raw RGBA frames on stdin, optional WAV soundtrack).
export interface VideoOptions { file: string; width: number; height: number; fps: number; format: string; quality: number; loop?: number; audio?: string }

export function ffmpegArgs(o: VideoOptions): string[] {
  const w = Math.max(2, Math.round(o.width)), h = Math.max(2, Math.round(o.height));
  const audio = o.audio && o.format !== 'gif' ? o.audio : null;
  const input = [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(o.fps), '-i', '-',
    ...(audio ? ['-i', audio, '-map', '0:v', '-map', '1:a'] : []),
  ];
  const crf = Math.round(35 - (Math.max(0, Math.min(100, o.quality)) / 100) * 25); // 35..10
  switch (o.format) {
    case 'mov':
      return [...input, '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0', ...(audio ? ['-c:a', 'pcm_s16le'] : []), o.file];
    case 'webm':
      return [...input, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', String(Math.min(63, crf + 8)), '-row-mt', '1', ...(audio ? ['-c:a', 'libopus', '-b:a', '160k'] : []), o.file];
    case 'gif':
      return [...input, '-vf', 'split[s0][s1];[s0]palettegen=reserve_transparent=1:stats_mode=full[p];[s1][p]paletteuse=dither=sierra2_4a:alpha_threshold=128', '-loop', String(o.loop ?? 0), o.file];
    case 'mp4':
    default:
      return [...input, '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(crf), '-preset', 'medium', ...(audio ? ['-c:a', 'aac', '-b:a', '192k'] : []), '-movflags', '+faststart', o.file];
  }
}
