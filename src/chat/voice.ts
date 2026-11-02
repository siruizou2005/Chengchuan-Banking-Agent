// PCM capture avoids browser-specific MediaRecorder codecs (including Safari).
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const frames = Math.floor(samples.length * 16000 / sampleRate), bytes = new ArrayBuffer(44 + frames * 2), view = new DataView(bytes);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) { const start = Math.floor(i * sampleRate / 16000), end = Math.max(start + 1, Math.floor((i + 1) * sampleRate / 16000)); let sum = 0; for (let j = start; j < end; j++) sum += samples[j] || 0; const value = Math.max(-1, Math.min(1, sum / (end - start))); view.setInt16(44 + i * 2, value * (value < 0 ? 32768 : 32767), true); }
  return new Blob([bytes], { type: 'audio/wav' });
}
export type Recording = { stop: () => Promise<Blob>; cancel: () => void };
export async function startRecording(onSeconds: (seconds: number) => void, onLimit: () => void, onLevel?: (level: number) => void): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('此浏览器无法使用麦克风，请使用文字输入。');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
  let context: AudioContext;
  try { context = new AudioContext(); await context.resume(); } catch (e) { stream.getTracks().forEach(t => t.stop()); throw e; }
  const source = context.createMediaStreamSource(stream), processor = context.createScriptProcessor(4096, 1, 1), mute = context.createGain(); mute.gain.value = 0;
  const chunks: Float32Array[] = []; let length = 0, ended = false;
  processor.onaudioprocess = e => { if (ended) return; const remaining = Math.max(0, 60 * context.sampleRate - length); const chunk = e.inputBuffer.getChannelData(0).slice(0, remaining); chunks.push(chunk); length += chunk.length; if (onLevel) { let sum = 0; for (const v of chunk) sum += v * v; onLevel(Math.min(1, Math.sqrt(sum / (chunk.length || 1)) * 8)); } };
  source.connect(processor); processor.connect(mute); mute.connect(context.destination);
  const start = Date.now(), timer = setInterval(() => { const seconds = Math.min(60, Math.floor((Date.now() - start) / 1000)); onSeconds(seconds); if (seconds >= 60) { clearInterval(timer); onLimit(); } }, 250);
  function cleanup() { ended = true; clearInterval(timer); source.disconnect(); processor.disconnect(); mute.disconnect(); stream.getTracks().forEach(t => t.stop()); void context.close(); }
  return { async stop() { if (ended) throw new Error('录音已停止'); cleanup(); const samples = new Float32Array(length); let offset = 0; for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; } return encodeWav(samples, context.sampleRate); }, cancel() { if (!ended) cleanup(); chunks.length = 0; } };
}
export async function transcribe(audio: Blob, signal: AbortSignal): Promise<string> {
  let response: Response;
  try { response = await fetch('/api/voice/transcribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal }); }
  catch (failure) { if (signal.aborted) throw failure; throw new Error('语音识别失败'); }
  const data = await response.json().catch(() => undefined);
  if (!response.ok || data === undefined) throw new Error(data?.error?.message || '语音识别失败');
  return data.text;
}
